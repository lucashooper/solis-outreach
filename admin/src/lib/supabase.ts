import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  emptyVideoHookProvenance,
  readVideoHookProvenance,
  type VideoHookProvenance,
} from '../../../src/templates/videoHook.ts';
import { asDiscoveryFunnel, savedResultLimit } from '../../../src/discovery/funnel.ts';
import { jobIsLive } from '../../../src/discovery/runOutcome.ts';
import { aggregateHashtagHistory, type HashtagHistoryRow } from '../../../src/discovery/hashtagAdvice.ts';
import { coerceStoredSearch } from '../../../src/discovery/historyForm.ts';
import { normaliseHashtags } from '../../../src/discovery/hashtags.ts';
import { asHashtagYield, type HashtagYield } from '../../../src/discovery/hashtagYield.ts';
import {
  rankTemplatePerformance,
  type PerformanceSend,
  type TemplatePerformanceRow,
  type TemplateRange,
} from '../../../src/metrics/templatePerformance.ts';
import type { DiscoveryFunnel } from '../../../src/discovery/types.ts';
import { planManualReplyToggle, leadEmailKey } from '../../../netlify/lib/replySync.mjs';
import { isUnsentCreator, UNSENT_STATUSES } from '../../../src/crm/unsent.ts';
import { loadSettings, hasSupabaseConfig, expressApiUrl } from './settings';
import {
  summariseReplyMetrics,
  type MetricsBlast,
} from './replyMetrics';
import type {
  Campaign,
  CampaignFormData,
  CampaignPreset,
  Creator,
  DiscoveryRun,
  OutreachLog,
  OutreachStatus,
  SolisApp,
  StatusCounts,
} from './types';

let client: SupabaseClient | null = null;
let clientKey = '';

export function getSupabase(): SupabaseClient | null {
  const settings = loadSettings();
  if (!hasSupabaseConfig(settings)) {
    client = null;
    clientKey = '';
    return null;
  }

  const key = `${settings.supabaseUrl}|${settings.supabaseAnonKey}`;
  if (!client || clientKey !== key) {
    // The client uses this page's origin for the session and any auth return.
    client = createClient(settings.supabaseUrl.trim(), settings.supabaseAnonKey.trim());
    clientKey = key;
  }
  return client;
}

export function resetSupabaseClient(): void {
  client = null;
  clientKey = '';
}

/**
 * Same-origin Netlify functions in production (audience blasts).
 * Local dev uses the Express URL. Discover and Gmail sync use expressApiUrl().
 */
function apiBase(): string {
  if (import.meta.env.PROD) return '';
  return expressApiUrl();
}

/**
 * Prefer browser Supabase (anon/authenticated RLS) for audience CRUD on Netlify.
 * Local `npm run dev` keeps the Express path when apiBase points at :3001.
 */
function preferDirectSupabase(): boolean {
  if (import.meta.env.PROD) return true;
  const base = apiBase();
  return !base;
}


export async function fetchCreators(filters: {
  status?: OutreachStatus | '' | 'unsent';
  platform?: string;
  search?: string;
  campaignId?: string;
  appId?: string | null;
  handles?: string[];
}): Promise<Creator[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  let query = sb.from('creators').select('*').order('created_at', { ascending: false });

  if (filters.appId) {
    query = query.eq('app_id', filters.appId);
  }
  if (filters.status === 'unsent') {
    query = query.in('outreach_status', [...UNSENT_STATUSES]).not('email', 'is', null);
  } else if (filters.status) {
    query = query.eq('outreach_status', filters.status);
  }
  if (filters.platform) {
    query = query.eq('platform', filters.platform);
  }
  if (filters.campaignId) {
    query = query.eq('campaign_id', filters.campaignId);
  }
  if (filters.handles && filters.handles.length > 0) {
    query = query.in('handle', filters.handles);
  }
  if (filters.search?.trim()) {
    const q = filters.search.trim();
    query = query.or(`handle.ilike.%${q}%,email.ilike.%${q}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Creator[];
  if (filters.status === 'unsent') return rows.filter((row) => isUnsentCreator(row));
  return rows;
}

export async function fetchCreatorsByIds(ids: string[]): Promise<Creator[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const { data, error } = await sb.from('creators').select('*').in('id', unique);
  if (error) throw error;
  return (data ?? []) as Creator[];
}

export async function fetchCreator(id: string): Promise<Creator | null> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  const { data, error } = await sb.from('creators').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Creator | null;
}

export async function upsertCreator(
  payload: Partial<Creator> & { handle: string; platform: string },
  id?: string,
): Promise<Creator> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  if (id) {
    const { data, error } = await sb
      .from('creators')
      .update(payload)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as Creator;
  }

  const { data, error } = await sb.from('creators').insert(payload).select().single();
  if (error) throw error;
  return data as Creator;
}

export async function updateCreatorStatus(
  id: string,
  outreach_status: OutreachStatus,
): Promise<Creator> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  const { data, error } = await sb
    .from('creators')
    .update({ outreach_status })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as Creator;
}

export async function fetchOutreachLogs(creatorId: string): Promise<OutreachLog[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  const { data, error } = await sb
    .from('outreach_logs')
    .select('*')
    .eq('creator_id', creatorId)
    .order('sequence_step', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OutreachLog[];
}

async function loadBlastMetricRows(
  sb: SupabaseClient,
  appId?: string | null,
): Promise<MetricsBlast[]> {
  let withReplyQuery = sb.from('blast_sends').select('status, email, replied_at');
  if (appId) withReplyQuery = withReplyQuery.eq('app_id', appId);
  const withReply = await withReplyQuery;
  if (!withReply.error) return (withReply.data ?? []) as MetricsBlast[];
  let plainQuery = sb.from('blast_sends').select('status');
  if (appId) plainQuery = plainQuery.eq('app_id', appId);
  const plain = await plainQuery;
  if (plain.error) {
    console.warn('[analytics] blast_sends:', plain.error.message);
    return [];
  }
  return (plain.data ?? []) as MetricsBlast[];
}

export async function fetchStatusCounts(appId?: string | null): Promise<StatusCounts> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  let creatorsQuery = sb.from('creators').select('outreach_status, email');
  if (appId) creatorsQuery = creatorsQuery.eq('app_id', appId);
  const [{ data, error }, blastRows] = await Promise.all([
    creatorsQuery,
    loadBlastMetricRows(sb, appId),
  ]);
  if (error) throw error;

  return summariseReplyMetrics({
    creators: (data ?? []) as Array<{ outreach_status: string; email?: string | null }>,
    blastRows,
  }).counts;
}

export async function fetchCampaigns(appId?: string | null): Promise<Campaign[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  let query = sb.from('campaigns').select('*').order('created_at', { ascending: false });
  if (appId) query = query.eq('app_id', appId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Campaign[];
}

export interface DiscoverHistoryItem {
  id: string;
  kind: 'campaign' | 'search';
  name: string;
  niche: string;
  hashtags: string[];
  platforms: string[];
  follower_min: number | null;
  follower_max: number | null;
  result_limit: number | null;
  min_creators: number | null;
  require_public_email: boolean;
  include_existing: boolean;
  found: number;
  status: string;
  created_at: string;
  funnel: DiscoveryFunnel | null;
  error: string | null;
}

/** Past discovery campaigns and searches for this app, including rows saved before app scoping. */
export async function fetchDiscoverHistory(appId: string): Promise<DiscoverHistoryItem[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const scope = `app_id.eq.${appId},app_id.is.null`;
  const [{ data: campaigns, error }, jobsResult] = await Promise.all([
    sb
      .from('campaigns')
      .select(
        'id, name, niches, hashtags, platforms, follower_min, follower_max, result_limit, min_creators, require_public_email, status, created_at, campaign_type',
      )
      .or(scope)
      .order('created_at', { ascending: false })
      .limit(40),
    sb
      .from('discovery_jobs')
      .select(
        'id, niche, platforms, hashtags, follower_min, follower_max, result_limit, min_creators, require_public_email, include_existing, status, results, created_at, funnel, error',
      )
      .or(scope)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  if (error) throw new Error(error.message);
  const discovery = (campaigns ?? []).filter(
    (row) => row.campaign_type !== 'direct_blast',
  ) as Array<{
    id: string;
    name: string;
    niches: string[] | null;
    hashtags: string[] | null;
    platforms: string[] | null;
    follower_min: number | null;
    follower_max: number | null;
    result_limit: number | null;
    min_creators: number | null;
    require_public_email: boolean | null;
    status: string;
    created_at: string;
  }>;
  const ids = discovery.map((row) => row.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    const { data: creators, error: creatorError } = await sb
      .from('creators')
      .select('campaign_id')
      .in('campaign_id', ids);
    if (creatorError) throw new Error(creatorError.message);
    for (const row of creators ?? []) {
      const id = row.campaign_id as string;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const latestFunnel = new Map<string, DiscoveryFunnel | null>();
  if (ids.length) {
    const { data: runRows } = await sb
      .from('discovery_runs')
      .select('campaign_id, funnel, created_at')
      .in('campaign_id', ids)
      .order('created_at', { ascending: false });
    for (const row of runRows ?? []) {
      const campaignId = row.campaign_id as string;
      if (!latestFunnel.has(campaignId)) {
        latestFunnel.set(campaignId, asDiscoveryFunnel(row.funnel));
      }
    }
  }
  const fromCampaigns: DiscoverHistoryItem[] = discovery.map((row) => {
    const funnel = latestFunnel.get(row.id) ?? null;
    const stored = coerceStoredSearch({
      niches: row.niches,
      hashtags: row.hashtags,
      platforms: row.platforms,
      followerMin: row.follower_min,
      followerMax: row.follower_max,
      resultLimit: row.result_limit,
      minCreators: row.min_creators,
      requirePublicEmail: row.require_public_email,
      funnel,
    });
    return {
      id: row.id,
      kind: 'campaign' as const,
      name: row.name,
      niche: stored.niche,
      hashtags: stored.hashtags,
      platforms: stored.platforms,
      follower_min: stored.followerMin,
      follower_max: stored.followerMax,
      result_limit: stored.resultLimit,
      min_creators: stored.minCreators,
      require_public_email: stored.requirePublicEmail,
      include_existing: stored.includeExisting,
      found: counts.get(row.id) ?? 0,
      status: row.status,
      created_at: row.created_at,
      funnel,
      error: null,
    };
  });
  const jobs = jobsResult.error ? [] : (jobsResult.data ?? []);
  const fromJobs: DiscoverHistoryItem[] = jobs.map((row) => {
    const funnel = asDiscoveryFunnel(row.funnel);
    const stored = coerceStoredSearch({
      niche: typeof row.niche === 'string' ? row.niche : '',
      hashtags: Array.isArray(row.hashtags) ? row.hashtags.map((tag) => String(tag)) : [],
      platforms: Array.isArray(row.platforms) ? row.platforms.map((platform) => String(platform)) : [],
      followerMin: row.follower_min,
      followerMax: row.follower_max,
      resultLimit: row.result_limit,
      minCreators: row.min_creators,
      requirePublicEmail:
        typeof row.require_public_email === 'boolean' ? row.require_public_email : null,
      includeExisting: row.include_existing === true,
      funnel,
    });
    return {
      id: row.id as string,
      kind: 'search' as const,
      name: stored.niche || 'Search',
      niche: stored.niche,
      hashtags: stored.hashtags,
      platforms: stored.platforms,
      follower_min: stored.followerMin,
      follower_max: stored.followerMax,
      result_limit: stored.resultLimit,
      min_creators: stored.minCreators,
      require_public_email: stored.requirePublicEmail,
      include_existing: stored.includeExisting,
      found: Array.isArray(row.results) ? row.results.length : 0,
      status: String(row.status || ''),
      created_at: String(row.created_at),
      funnel,
      error: typeof row.error === 'string' ? row.error : null,
    };
  });
  return [...fromCampaigns, ...fromJobs].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
}

export async function fetchStoredSearch(id: string): Promise<DiscoveryHit[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { data, error } = await sb
    .from('discovery_jobs')
    .select('results')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (Array.isArray(data?.results) ? data.results : []) as DiscoveryHit[];
}

export async function fetchCampaign(id: string): Promise<Campaign | null> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  const { data, error } = await sb.from('campaigns').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Campaign | null;
}

function buildCampaignInsertPayload(
  form: CampaignFormData,
  appId?: string | null,
): Record<string, unknown> {
  const campaignType = form.campaign_type || 'discovery';
  const appName =
    form.app_name.trim() ||
    (import.meta.env.VITE_APP_NAME || '').trim() ||
    'Solis';
  const valueProp =
    form.value_prop.trim() ||
    (import.meta.env.VITE_APP_VALUE_PROP || '').trim() ||
    'helps creators monetise short-form content without ads';

  if (campaignType === 'direct_blast') {
    const audienceGroupId = (form.audience_group_id || '').trim();
    if (!audienceGroupId) {
      throw new Error('audience_group_id is required for direct_blast');
    }
    const emailSubject = form.email_subject ?? '';
    const emailBody = form.email_body ?? '';
    if (!emailSubject.trim()) {
      throw new Error('email_subject is required for direct_blast');
    }
    if (!emailBody.trim()) {
      throw new Error('email_body is required for direct_blast');
    }
    return {
      name: form.name.trim(),
      niches: [],
      platforms: [],
      follower_min: null,
      follower_max: null,
      engagement_rate_min: null,
      result_limit: 1,
      auto_outreach: false,
      is_autopilot_enabled: false,
      schedule_cron: '0 10 * * *',
      status: 'draft',
      app_name: appName,
      value_prop: valueProp,
      campaign_type: 'direct_blast',
      audience_group_id: audienceGroupId,
      email_subject: emailSubject,
      email_body: emailBody,
      template_id: form.template_id || null,
      ...(appId ? { app_id: appId } : {}),
    };
  }

  const platforms = (form.platforms ?? [])
    .map((p) => String(p).trim().toLowerCase())
    .filter(Boolean);
  if (platforms.length === 0) {
    throw new Error('Select at least one platform (tiktok / instagram)');
  }
  const allowed = new Set(['tiktok', 'instagram']);
  if (platforms.some((p) => !allowed.has(p))) {
    throw new Error('platforms must be tiktok and/or instagram');
  }

  const followerMin = form.follower_min ? Number(form.follower_min) : null;
  const followerMax = form.follower_max ? Number(form.follower_max) : null;
  const engagementRateMin =
    form.engagement_rate_min !== '' && form.engagement_rate_min != null
      ? Number(form.engagement_rate_min)
      : null;
  const resultLimit = form.result_limit ? Number(form.result_limit) : 10;

  return {
    name: form.name.trim(),
    niches: form.niches,
    hashtags: normaliseHashtags(form.hashtags ?? []),
    platforms,
    campaign_type: 'discovery',
    follower_min: Number.isFinite(followerMin as number) ? followerMin : null,
    follower_max: Number.isFinite(followerMax as number) ? followerMax : null,
    engagement_rate_min: Number.isFinite(engagementRateMin as number)
      ? engagementRateMin
      : null,
    result_limit: savedResultLimit(resultLimit),
    min_creators:
      form.min_creators && Number(form.min_creators) >= 1
        ? savedResultLimit(Number(form.min_creators))
        : null,
    require_public_email: form.require_public_email !== false,
    include_crm_creators: form.include_crm_creators === true,
    auto_outreach: Boolean(form.auto_outreach),
    is_autopilot_enabled: form.is_autopilot_enabled,
    schedule_cron: form.schedule_cron?.trim() || '0 10 * * *',
    status: 'draft',
    app_name: appName,
    value_prop: valueProp,
    email_subject: form.email_subject?.trim() ? form.email_subject : null,
    email_body: form.email_body?.trim() ? form.email_body : null,
    template_id: form.template_id || null,
    discovery_source: form.discovery_source ?? 'both',
    ...(appId ? { app_id: appId } : {}),
  };
}

export async function createCampaign(
  form: CampaignFormData,
  appId?: string | null,
): Promise<Campaign> {
  const payload = buildCampaignInsertPayload(form, appId);

  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const { data, error } = await sb.from('campaigns').insert(payload).select().single();
    if (error) throw new Error(error.message);
    return data as Campaign;
  }

  const base = apiBase();
  const res = await fetch(`${base}/api/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & Partial<Campaign>;

  if (!res.ok) {
    throw new Error(
      typeof body.error === 'string' && body.error.trim()
        ? body.error
        : `API error ${res.status}`,
    );
  }
  if (!body.id) {
    throw new Error(
      typeof body.error === 'string' ? body.error : 'API did not return created campaign',
    );
  }
  return body as Campaign;
}

export async function fetchDiscoveryRuns(campaignId: string): Promise<DiscoveryRun[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  const { data, error } = await sb
    .from('discovery_runs')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as DiscoveryRun[];
}

export async function runCampaignDiscovery(
  campaignId: string,
  provider: 'demo' | 'apify',
  opts?: { forceOutreach?: boolean; includeExisting?: boolean; aiFallback?: boolean; source?: 'network' },
): Promise<Record<string, unknown>> {
  const base = expressApiUrl();
  if (!base) {
    throw new Error(
      'Discovery runs need the Express API. Set VITE_EXPRESS_API_URL to the Railway URL.',
    );
  }
  const res = await fetch(`${base}/api/campaigns/${campaignId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      forceOutreach: Boolean(opts?.forceOutreach),
      includeExisting: Boolean(opts?.includeExisting),
      aiFallback: opts?.aiFallback === true,
      ...(opts?.source === 'network' ? { source: 'network' } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : `API error ${res.status}`,
    );
  }
  return body;
}

export async function continueCampaignDiscovery(
  campaignId: string,
  input: { action: 'expand' | 'relax' | 'custom'; tags?: string[]; addToCampaign?: boolean },
): Promise<{ message: string; added: number; rounds: number; funnel: DiscoveryFunnel | null }> {
  const base = expressApiUrl();
  if (!base) {
    throw new Error(
      'Discovery runs need the Express API. Set VITE_EXPRESS_API_URL to the Railway URL.',
    );
  }
  const res = await fetch(`${base}/api/campaigns/${campaignId}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: input.action,
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.addToCampaign ? { addToCampaign: true } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new Error(typeof body.error === 'string' ? body.error : `API error ${res.status}`);
  }
  return {
    message: typeof body.message === 'string' ? body.message : 'Continued this batch.',
    added: Number(body.added) || 0,
    rounds: Number(body.rounds) || 0,
    funnel: asDiscoveryFunnel(body.funnel),
  };
}

/** Tags the next expand will actually search. Computed on the server at read time. */
export async function fetchEligibleSuggestions(
  campaignId: string,
): Promise<{ tags: string[]; networkOnly: boolean; note: string }> {
  const base = expressApiUrl();
  if (!base) return { tags: [], networkOnly: false, note: '' };
  const res = await fetch(`${base}/api/campaigns/${campaignId}/eligible-suggestions`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new Error(typeof body.error === 'string' ? body.error : `API error ${res.status}`);
  }
  const tags = Array.isArray(body.eligibleSuggestions)
    ? body.eligibleSuggestions.map((tag) => String(tag)).slice(0, 3)
    : [];
  return {
    tags,
    networkOnly: body.networkOnly === true,
    note: typeof body.note === 'string' ? body.note : '',
  };
}

/** Link this run's CRM matches onto the campaign. Does not send email. */
export async function acceptCampaignBatch(
  campaignId: string,
  input?: { undo?: boolean; runId?: string },
): Promise<{ message: string; linked: number; creatorIds: string[] }> {
  const base = expressApiUrl();
  if (!base) {
    throw new Error(
      'Discovery runs need the Express API. Set VITE_EXPRESS_API_URL to the Railway URL.',
    );
  }
  const res = await fetch(`${base}/api/campaigns/${campaignId}/accept-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(input?.undo ? { undo: true } : {}),
      ...(input?.runId ? { runId: input.runId } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new Error(typeof body.error === 'string' ? body.error : `API error ${res.status}`);
  }
  return {
    message: typeof body.message === 'string' ? body.message : 'Kept this batch.',
    linked: Number(body.linked) || 0,
    creatorIds: Array.isArray(body.creatorIds) ? body.creatorIds.map((id) => String(id)) : [],
  };
}

export async function fetchCampaignLinkedCreatorIds(campaignId: string): Promise<string[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from('campaign_creator_links')
    .select('creator_id')
    .eq('campaign_id', campaignId);
  if (error || !data) return [];
  return data
    .map((row) => String((row as { creator_id?: string }).creator_id ?? ''))
    .filter(Boolean);
}

/** Past hashtag yield for this app. No Apify calls. */
export async function fetchHashtagHistory(appId: string): Promise<HashtagHistoryRow[]> {
  const sb = getSupabase();
  if (!sb || !appId) return [];
  const { data, error } = await sb
    .from('discovery_jobs')
    .select('funnel')
    .eq('app_id', appId)
    .order('created_at', { ascending: false })
    .limit(80);
  if (error || !data) return [];
  return aggregateHashtagHistory(
    data.map((row) => asDiscoveryFunnel((row as { funnel?: unknown }).funnel)?.hashtagYield),
  );
}

/** Hashtag yield and the live stage written onto this campaign's discovery job. */
export async function fetchCampaignSearchYield(campaignId: string): Promise<{
  jobId: string | null;
  rows: HashtagYield[];
  fallbackTags: string[];
  fallbackSource: 'ai' | 'niche' | null;
  status: string | null;
  stageLabel: string | null;
  phase: string | null;
  checked: number;
  found: number;
  updatedAt: string | null;
  createdAt: string | null;
}> {
  const empty = {
    jobId: null as string | null,
    rows: [] as HashtagYield[],
    fallbackTags: [] as string[],
    fallbackSource: null,
    status: null as string | null,
    stageLabel: null as string | null,
    phase: null as string | null,
    checked: 0,
    found: 0,
    updatedAt: null as string | null,
    createdAt: null as string | null,
  };
  const sb = getSupabase();
  if (!sb) return empty;
  const { data, error } = await sb
    .from('discovery_jobs')
    .select('id, funnel, status, updated_at, created_at')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error || !data || data.length === 0) return empty;
  const rows = data as Array<{
    id?: string;
    funnel?: unknown;
    status?: string | null;
    updated_at?: string | null;
    created_at?: string | null;
  }>;
  const row =
    rows.find((item) => jobIsLive(item.status, item.updated_at ?? item.created_at)) ?? rows[0];
  if (!row) return empty;
  const funnel = asDiscoveryFunnel(row.funnel);
  return {
    jobId: row.id ? String(row.id) : null,
    rows: funnel?.hashtagYield ?? [],
    fallbackTags: funnel?.fallbackTags ?? [],
    fallbackSource: funnel?.fallbackSource ?? null,
    status: typeof row.status === 'string' ? row.status : null,
    stageLabel: funnel?.stage?.label ?? null,
    phase: funnel?.stage?.phase ?? null,
    checked: funnel?.stage?.checked ?? funnel?.rawItems ?? 0,
    found: funnel?.stage?.found ?? funnel?.saved ?? 0,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
  };
}

/** Ask the running search to stop. Creators already saved stay on the campaign. */
export async function stopCampaignDiscovery(campaignId: string): Promise<void> {
  const base = expressApiUrl();
  if (!base) throw new Error('Discovery runs need the Express API.');
  const res = await fetch(`${base}/api/campaigns/${campaignId}/stop`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
}

export async function fetchApiHealth(): Promise<{
  ok: boolean;
  apifyConfigured?: boolean;
}> {
  const base = expressApiUrl();
  if (!base) {
    return { ok: preferDirectSupabase(), apifyConfigured: false };
  }
  try {
    const res = await fetch(`${base}/api/health`);
    if (!res.ok) return { ok: false };
    return (await res.json()) as { ok: boolean; apifyConfigured?: boolean };
  } catch {
    return { ok: false };
  }
}

export async function pingDiscordWebhook(webhookUrl: string): Promise<void> {
  const settings = loadSettings();
  const res = await fetch(webhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `✅ Test ping from **${settings.appName || 'Creator Outreach Admin'}** — Discord webhook is working.`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord ping failed (${res.status}): ${text || res.statusText}`);
  }
}


export interface VideoHookResult {
  id: string;
  text: string;
  source: 'video' | 'bio' | 'generic';
  basis: string;
  cached: boolean;
  edited: boolean;
  provenance: VideoHookProvenance;
}

/** Ask the Express server for cached or newly written opening lines. Does not send. */
export async function ensureVideoHooks(ids: string[], forceId?: string): Promise<VideoHookResult[]> {
  const base = expressApiUrl();
  if (!base) throw new Error('The Express API is not configured.');
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const hooks: VideoHookResult[] = [];
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    const res = await fetch(`${base}/api/creators/video-hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: chunk,
        ...(forceId && chunk.includes(forceId) ? { forceId } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      hooks?: Array<Partial<VideoHookResult> & { id?: string; text?: string; source?: string }>;
    };
    if (!res.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : `API error ${res.status}`);
    }
    for (const row of body.hooks ?? []) {
      if (row.source !== 'video' && row.source !== 'bio' && row.source !== 'generic') continue;
      if (!row.id || typeof row.text !== 'string') continue;
      hooks.push({
        id: row.id,
        text: row.text,
        source: row.source,
        basis: typeof row.basis === 'string' ? row.basis : '',
        cached: row.cached === true,
        edited: row.edited === true,
        provenance: readVideoHookProvenance(row.provenance) ?? emptyVideoHookProvenance(),
      });
    }
  }
  return hooks;
}

/** Keep an edited opening line on the creator so the next preview does not overwrite it. */
export async function saveCreatorVideoHook(
  creatorId: string,
  text: string,
  source: 'video' | 'bio' | 'generic',
): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { data: existing, error: readErr } = await sb
    .from('creators')
    .select('ai_variables')
    .eq('id', creatorId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  const prev = (existing?.ai_variables as Record<string, unknown>) ?? {};
  const { error } = await sb
    .from('creators')
    .update({
      ai_variables: {
        ...prev,
        video_hook: text,
        video_hook_source: source,
        video_hook_edited: true,
      },
    })
    .eq('id', creatorId);
  if (error) throw new Error(error.message);
}

export async function approveCreator(
  creatorId: string,
  options?: { subject?: string; body?: string; override?: boolean; templateId?: string | null },
): Promise<Record<string, unknown>> {
  const base = expressApiUrl();
  if (!base) {
    throw new Error(
      'Approve & Pitch needs the Express API. Set VITE_EXPRESS_API_URL to the Railway URL.',
    );
  }
  const res = await fetch(`${base}/api/creators/${creatorId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: options?.subject,
      body: options?.body,
      override: options?.override === true,
      templateId: options?.templateId ?? null,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof body.error === 'string' ? body.error : `API error ${res.status}`,
    );
  }
  return body;
}

export async function patchCreator(
  creatorId: string,
  payload: { hook?: string; outreach_status?: OutreachStatus },
): Promise<Creator> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const updates: Record<string, unknown> = {};
    if (payload.outreach_status) updates.outreach_status = payload.outreach_status;
    if (typeof payload.hook === 'string') {
      const { data: existing, error: readErr } = await sb
        .from('creators')
        .select('ai_variables')
        .eq('id', creatorId)
        .maybeSingle();
      if (readErr) throw new Error(readErr.message);
      const prev = (existing?.ai_variables as Record<string, unknown>) ?? {};
      updates.ai_variables = { ...prev, hook: payload.hook };
    }
    if (Object.keys(updates).length === 0) {
      throw new Error('No valid fields to update (hook / outreach_status)');
    }
    const { data, error } = await sb
      .from('creators')
      .update(updates)
      .eq('id', creatorId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as Creator;
  }

  const base = apiBase();
  const res = await fetch(`${base}/api/creators/${creatorId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    creator?: Creator;
  };
  if (!res.ok) {
    throw new Error(body.error || `API error ${res.status}`);
  }
  if (body.creator) return body.creator;
  throw new Error('API did not return updated creator');
}

/** Remove a CRM creator. Logs cascade; linked replies keep their row with creator_id cleared. */
export async function deleteCreator(creatorId: string): Promise<void> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const { error } = await sb.from('creators').delete().eq('id', creatorId);
    if (error) throw new Error(error.message);
    return;
  }

  const base = apiBase();
  const res = await fetch(`${base}/api/creators/${creatorId}`, { method: 'DELETE' });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `API error ${res.status}`);
  }
}

/**
 * Mark or clear REPLIED on a CRM lead. Writes Supabase directly (production
 * and local) so this does not depend on the Express server.
 * Previous status is kept in ai_variables.status_before_reply for undo.
 */
export async function setCreatorReplied(
  creator: Creator,
  replied: boolean,
): Promise<Creator> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const plan = planManualReplyToggle(creator, replied);
  if (!plan.changed) return creator;
  const { data, error } = await sb
    .from('creators')
    .update({
      outreach_status: plan.outreach_status,
      ai_variables: plan.ai_variables,
    })
    .eq('id', creator.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Creator;
}

export interface MailboxReply {
  email: string;
  replied_at: string;
}

/** Distinct blast recipients with a recorded inbound reply. Empty if the column is not migrated yet. */
export async function fetchMailboxReplies(appId?: string | null): Promise<MailboxReply[]> {
  const sb = getSupabase();
  if (!sb) return [];
  let query = sb
    .from('blast_sends')
    .select('email, replied_at')
    .not('replied_at', 'is', null);
  if (appId) query = query.eq('app_id', appId);
  const { data, error } = await query;
  if (error) return [];
  const byEmail = new Map<string, MailboxReply>();
  for (const row of data ?? []) {
    const email = String(row.email || '').trim();
    const repliedAt = row.replied_at ? String(row.replied_at) : '';
    if (!email || !repliedAt) continue;
    const key = email.toLowerCase();
    const prev = byEmail.get(key);
    if (!prev || repliedAt > prev.replied_at) {
      byEmail.set(key, { email, replied_at: repliedAt });
    }
  }
  return [...byEmail.values()];
}

export async function clearMailboxReply(
  email: string,
  appId?: string | null,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  let query = sb.from('blast_sends').select('id, email').ilike('email', email);
  if (appId) query = query.eq('app_id', appId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const ids = (data ?? [])
    .filter((row) => String(row.email || '').toLowerCase() === email.toLowerCase())
    .map((row) => row.id as string);
  if (ids.length === 0) return;
  const { error: updateError } = await sb
    .from('blast_sends')
    .update({ replied_at: null })
    .in('id', ids);
  if (updateError) throw new Error(updateError.message);
}

export interface EmailReply {
  id: string;
  gmail_message_id: string;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  body?: string | null;
  body_text: string | null;
  received_at: string | null;
  creator_id: string | null;
  audience_member_id: string | null;
  campaign_id: string | null;
  app_id: string | null;
  created_at: string;
}

export interface GmailConnection {
  configured: boolean;
  email: string;
  missing: string[];
  lastSynced: string | null;
}

/** Gmail connection from the Express API. The browser never reads the refresh token. */
export async function fetchGmailConnection(): Promise<GmailConnection> {
  const base = expressApiUrl();
  if (!base) {
    throw new Error('Gmail status needs the Express API. Set VITE_EXPRESS_API_URL to the Railway URL.');
  }
  const res = await fetch(`${base}/api/integrations/gmail`);
  const body = (await res.json().catch(() => ({}))) as Partial<GmailConnection> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || 'Could not read Gmail status');
  }
  return {
    configured: Boolean(body.configured),
    email: body.email || 'studioowner@gmail.com',
    missing: Array.isArray(body.missing) ? body.missing : [],
    lastSynced: typeof body.lastSynced === 'string' && body.lastSynced ? body.lastSynced : null,
  };
}

export interface CreatorBlastSend {
  id: string;
  email: string;
  status: string;
  sent_at: string | null;
  replied_at: string | null;
  provider_message_id: string | null;
  subject: string | null;
  body: string | null;
  app_name: string | null;
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function emailsMatch(stored: string, creatorEmail: string): boolean {
  if (sameEmail(stored, creatorEmail)) return true;
  const left = leadEmailKey(stored);
  const right = leadEmailKey(creatorEmail);
  return Boolean(left && right && left === right);
}

function replyLookupPatterns(email: string): string[] {
  const patterns = new Set<string>();
  const exact = email.trim();
  if (exact) patterns.add(exact);
  const key = leadEmailKey(exact);
  if (key) patterns.add(key);
  const at = key.lastIndexOf('@');
  if (at > 0) {
    const local = key.slice(0, at).replace(/[%_]/g, '');
    const domain = key.slice(at + 1);
    if (local && (domain === 'gmail.com' || domain === 'googlemail.com')) {
      patterns.add(`${local}+%@${domain}`);
    }
  }
  return [...patterns];
}

function missingCorrespondenceTable(message: string): boolean {
  return /email_replies|blast_sends|replied_at|schema cache/i.test(message);
}

/**
 * Inbox replies linked to this creator, plus blast sends to the same address.
 * Missing reply tables return empty lists so the profile still loads.
 */
export async function fetchCreatorCorrespondence(
  creatorId: string,
  email: string | null,
): Promise<{ replies: EmailReply[]; blasts: CreatorBlastSend[] }> {
  const sb = getSupabase();
  if (!sb) return { replies: [], blasts: [] };

  const replies = new Map<string, EmailReply>();
  const byCreator = await sb.from('email_replies').select('*').eq('creator_id', creatorId);
  if (byCreator.error) {
    if (!missingCorrespondenceTable(byCreator.error.message)) throw new Error(byCreator.error.message);
  } else {
    for (const row of (byCreator.data ?? []) as EmailReply[]) replies.set(row.id, row);
  }

  const address = email?.trim() ?? '';
  if (address.includes('@')) {
    const patterns = replyLookupPatterns(address);
    const found = await Promise.all(
      patterns.map((pattern) => sb.from('email_replies').select('*').ilike('from_email', pattern)),
    );
    for (const byEmail of found) {
      if (byEmail.error) {
        if (!missingCorrespondenceTable(byEmail.error.message)) throw new Error(byEmail.error.message);
        continue;
      }
      for (const row of (byEmail.data ?? []) as EmailReply[]) {
        if (row.creator_id && row.creator_id !== creatorId && !emailsMatch(row.from_email, address)) {
          continue;
        }
        if (!emailsMatch(row.from_email, address) && row.creator_id !== creatorId) continue;
        replies.set(row.id, row);
      }
    }
  }

  return { replies: [...replies.values()], blasts: await loadBlastsForEmail(sb, address) };
}

async function loadBlastsForEmail(
  sb: SupabaseClient,
  email: string,
): Promise<CreatorBlastSend[]> {
  if (!email.includes('@')) return [];
  const withReply = await sb
    .from('blast_sends')
    .select('id, email, status, sent_at, replied_at, campaign_id, provider_message_id')
    .ilike('email', email);
  const plain =
    withReply.error && /replied_at/i.test(withReply.error.message)
      ? await sb
          .from('blast_sends')
          .select('id, email, status, sent_at, campaign_id, provider_message_id')
          .ilike('email', email)
      : withReply;
  if (plain.error) {
    if (missingCorrespondenceTable(plain.error.message)) return [];
    throw new Error(plain.error.message);
  }

  const rows = ((plain.data ?? []) as Array<{
    id: string;
    email?: string | null;
    status?: string | null;
    sent_at?: string | null;
    replied_at?: string | null;
    campaign_id?: string | null;
    provider_message_id?: string | null;
  }>).filter((row) => sameEmail(String(row.email ?? ''), email));
  const campaignIds = [
    ...new Set(rows.map((row) => row.campaign_id).filter((id): id is string => Boolean(id))),
  ];
  const campaigns = new Map<
    string,
    { email_subject: string | null; email_body: string | null; app_name: string | null }
  >();
  if (campaignIds.length) {
    const { data, error } = await sb
      .from('campaigns')
      .select('id, email_subject, email_body, app_name')
      .in('id', campaignIds);
    if (!error) {
      for (const row of data ?? []) {
        campaigns.set(String(row.id), {
          email_subject: row.email_subject ? String(row.email_subject) : null,
          email_body: row.email_body ? String(row.email_body) : null,
          app_name: row.app_name ? String(row.app_name) : null,
        });
      }
    }
  }

  return rows.map((row) => {
    const campaign = row.campaign_id ? campaigns.get(String(row.campaign_id)) : undefined;
    return {
      id: String(row.id),
      email: String(row.email ?? ''),
      status: String(row.status ?? ''),
      sent_at: row.sent_at ? String(row.sent_at) : null,
      replied_at: row.replied_at ? String(row.replied_at) : null,
      provider_message_id: row.provider_message_id ? String(row.provider_message_id) : null,
      subject: campaign?.email_subject ?? null,
      body: campaign?.email_body ?? null,
      app_name: campaign?.app_name ?? null,
    };
  });
}

export async function fetchEmailReplies(filters: {
  appId?: string | null;
  campaignId?: string | null;
}): Promise<EmailReply[]> {
  const base = expressApiUrl();
  if (base) {
    const params = new URLSearchParams();
    if (filters.campaignId) params.set('campaignId', filters.campaignId);
    else if (filters.appId) params.set('appId', filters.appId);
    const qs = params.toString();
    const res = await fetch(`${base}/api/replies${qs ? `?${qs}` : ''}`);
    const body = (await res.json().catch(() => ({}))) as {
      replies?: EmailReply[];
      error?: string;
    };
    if (!res.ok) {
      if (body.error && /email_replies|schema cache/i.test(body.error)) return [];
      throw new Error(body.error || `Could not load replies (${res.status})`);
    }
    return body.replies ?? [];
  }

  const sb = getSupabase();
  if (!sb) return [];
  let query = sb.from('email_replies').select('*').order('received_at', { ascending: false }).limit(100);
  if (filters.campaignId) query = query.eq('campaign_id', filters.campaignId);
  else if (filters.appId) query = query.or(`app_id.eq.${filters.appId},app_id.is.null`);
  const { data, error } = await query;
  if (error) {
    if (/email_replies|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as EmailReply[];
}

export interface GmailSyncResult {
  ok: true;
  scanned: number;
  alreadySeen: number;
  markedCreators: number;
  markedBlasts: number;
  unmatched: number;
  skippedAutomated: number;
}

/** Poll the outreach mailbox on the Express API. Fails with the server error text. */
export async function syncGmailReplies(accessToken: string): Promise<GmailSyncResult> {
  const base = expressApiUrl();
  if (!base) {
    throw new Error(
      'Reply sync needs the Express API. Set VITE_EXPRESS_API_URL to the Railway URL.',
    );
  }
  const res = await fetch(`${base}/api/gmail/sync-replies`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const body = (await res.json().catch(() => ({}))) as Partial<GmailSyncResult> & {
    error?: string;
  };
  if (!res.ok || body.ok !== true) {
    throw new Error(
      body.error || `Gmail sync failed (${res.status})`,
    );
  }
  return body as GmailSyncResult;
}


export type CampaignPatchPayload = {
  is_autopilot_enabled?: boolean;
  schedule_cron?: string;
  auto_outreach?: boolean;
  name?: string;
  status?: string;
  niches?: string[];
  hashtags?: string[];
  platforms?: string[];
  follower_min?: number | null;
  require_public_email?: boolean;
  include_crm_creators?: boolean;
  follower_max?: number | null;
  engagement_rate_min?: number | null;
  result_limit?: number;
  min_creators?: number | null;
  app_name?: string;
  value_prop?: string;
  email_subject?: string;
  email_body?: string;
  template_id?: string | null;
  discovery_source?: 'network' | 'hashtags' | 'both';
};

export async function patchCampaign(
  campaignId: string,
  payload: CampaignPatchPayload,
): Promise<Campaign> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const { data, error } = await sb
      .from('campaigns')
      .update(payload)
      .eq('id', campaignId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as Campaign;
  }

  const base = apiBase();
  const res = await fetch(`${base}/api/campaigns/${campaignId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    campaign?: Campaign;
  };
  if (!res.ok) {
    throw new Error(body.error || `API error ${res.status}`);
  }
  if (body.campaign) return body.campaign;

  const sb = getSupabase();
  if (!sb) throw new Error(body.error || 'Failed to patch campaign');
  const { data, error } = await sb
    .from('campaigns')
    .update(payload)
    .eq('id', campaignId)
    .select()
    .single();
  if (error) throw error;
  return data as Campaign;
}

export async function runCampaignAutopilot(
  campaignId: string,
): Promise<Record<string, unknown>> {
  const base = expressApiUrl();
  if (!base) {
    throw new Error(
      'Autopilot needs the Express API. Set VITE_EXPRESS_API_URL to the Railway URL.',
    );
  }
  const res = await fetch(`${base}/api/campaigns/${campaignId}/autopilot/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof body.error === 'string' ? body.error : `API error ${res.status}`,
    );
  }
  return body;
}


export async function deleteCampaign(campaignId: string): Promise<void> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const { error } = await sb.from('campaigns').delete().eq('id', campaignId);
    if (error) throw new Error(error.message);
    return;
  }

  const base = apiBase();
  const res = await fetch(`${base}/api/campaigns/${campaignId}`, {
    method: 'DELETE',
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `API error ${res.status}`);
  }
}

export async function duplicateCampaign(source: Campaign): Promise<Campaign> {
  const form: CampaignFormData = {
    name: `${source.name} (copy)`,
    niches: [...(source.niches ?? [])],
    hashtags: [...(source.hashtags ?? [])],
    platforms: [...(source.platforms ?? [])],
    follower_min: source.follower_min != null ? String(source.follower_min) : '',
    follower_max: source.follower_max != null ? String(source.follower_max) : '',
    engagement_rate_min:
      source.engagement_rate_min != null ? String(source.engagement_rate_min) : '',
    result_limit: String(source.result_limit || 10),
    auto_outreach: source.auto_outreach,
    include_crm_creators: source.include_crm_creators === true,
    is_autopilot_enabled: false,
    schedule_cron: source.schedule_cron || '0 10 * * *',
    app_name: source.app_name || '',
    value_prop: source.value_prop || '',
  };
  return createCampaign(form, source.app_id);
}

export async function fetchCampaignPresets(appId: string): Promise<CampaignPreset[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { data, error } = await sb
    .from('campaign_presets')
    .select('*')
    .eq('app_id', appId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as CampaignPreset[];
}

export async function createCampaignPreset(
  form: CampaignFormData,
  appId: string,
): Promise<CampaignPreset> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const name = form.name.trim();
  if (!name) throw new Error('Name the preset before saving.');
  const followerMin = form.follower_min ? Number(form.follower_min) : null;
  const followerMax = form.follower_max ? Number(form.follower_max) : null;
  const engagement =
    form.engagement_rate_min !== '' && form.engagement_rate_min != null
      ? Number(form.engagement_rate_min)
      : null;
  const resultLimit = form.result_limit ? Number(form.result_limit) : 10;
  const platforms = (form.platforms ?? [])
    .map((platform) => platform.trim().toLowerCase())
    .filter((platform) => platform === 'tiktok' || platform === 'instagram');
  const row = {
    app_id: appId,
    name,
    niches: form.niches,
    hashtags: normaliseHashtags(form.hashtags ?? []),
    platforms,
    follower_min: Number.isFinite(followerMin as number) ? followerMin : null,
    follower_max: Number.isFinite(followerMax as number) ? followerMax : null,
    engagement_rate_min: Number.isFinite(engagement as number) ? engagement : null,
    result_limit: savedResultLimit(resultLimit),
    is_autopilot_enabled: Boolean(form.is_autopilot_enabled),
    include_crm_creators: form.include_crm_creators === true,
  };
  let { data, error } = await sb.from('campaign_presets').insert(row).select().single();
  if (error && /include_crm_creators/i.test(error.message)) {
    const { include_crm_creators: _ignored, ...without } = row;
    void _ignored;
    const retry = await sb.from('campaign_presets').insert(without).select().single();
    data = retry.data;
    error = retry.error;
  }
  if (error) throw new Error(error.message);
  return data as CampaignPreset;
}

export async function deleteCampaignPreset(presetId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { error } = await sb.from('campaign_presets').delete().eq('id', presetId);
  if (error) throw new Error(error.message);
}

export interface DiscoveryPreset {
  id: string;
  app_id: string;
  name: string;
  niche: string;
  platform: 'tiktok' | 'instagram' | 'both';
  follower_min: number | null;
  follower_max: number | null;
  result_limit: number;
  min_creators?: number | null;
  require_public_email?: boolean;
  include_existing?: boolean;
  created_at: string;
}

export async function fetchDiscoveryPresets(appId: string): Promise<DiscoveryPreset[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { data, error } = await sb
    .from('discovery_presets')
    .select('*')
    .eq('app_id', appId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as DiscoveryPreset[];
}

export async function createDiscoveryPreset(input: {
  appId: string;
  name: string;
  niche: string;
  platform: DiscoveryPreset['platform'];
  followerMin: number | null;
  followerMax: number | null;
  resultLimit: number;
  minCreators?: number | null;
  requirePublicEmail?: boolean;
  includeExisting?: boolean;
}): Promise<DiscoveryPreset> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const name = input.name.trim();
  if (!name) throw new Error('Name the preset before saving.');
  const row = {
    app_id: input.appId,
    name,
    niche: input.niche.trim(),
    platform: input.platform,
    follower_min: input.followerMin,
    follower_max: input.followerMax,
    result_limit: savedResultLimit(input.resultLimit),
    min_creators:
      input.minCreators != null && input.minCreators >= 1
        ? savedResultLimit(input.minCreators)
        : null,
    require_public_email: input.requirePublicEmail !== false,
    include_existing: input.includeExisting === true,
  };
  let { data, error } = await sb.from('discovery_presets').insert(row).select().single();
  if (error && /include_existing/i.test(error.message)) {
    const { include_existing: _ignored, ...without } = row;
    void _ignored;
    const retry = await sb.from('discovery_presets').insert(without).select().single();
    data = retry.data;
    error = retry.error;
  }
  if (error) throw new Error(error.message);
  return data as DiscoveryPreset;
}

export async function renameDiscoveryPreset(presetId: string, name: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const next = name.trim();
  if (!next) throw new Error('Name the preset before saving.');
  const { error } = await sb.from('discovery_presets').update({ name: next }).eq('id', presetId);
  if (error) throw new Error(error.message);
}

export async function deleteDiscoveryPreset(presetId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { error } = await sb.from('discovery_presets').delete().eq('id', presetId);
  if (error) throw new Error(error.message);
}

export interface DiscordIntegration {
  configured: boolean;
  maskedUrl: string;
  usingEnv: boolean;
  notifyReplies: boolean;
  notifyCreators: boolean;
  notifySent: boolean;
}

async function sessionBearer(): Promise<string> {
  const sb = getSupabase();
  if (!sb) return '';
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? '';
}

function discordApiBase(): string {
  const base = expressApiUrl();
  if (!base) {
    throw new Error('Discord settings need the outreach API.');
  }
  return base;
}

export async function fetchDiscordIntegration(): Promise<DiscordIntegration> {
  const res = await fetch(`${discordApiBase()}/api/integrations/discord`);
  const body = (await res.json().catch(() => ({}))) as Partial<DiscordIntegration> & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || 'Could not read Discord settings');
  return {
    configured: Boolean(body.configured),
    maskedUrl: body.maskedUrl || '',
    usingEnv: Boolean(body.usingEnv),
    notifyReplies: body.notifyReplies !== false,
    notifyCreators: Boolean(body.notifyCreators),
    notifySent: Boolean(body.notifySent),
  };
}

export async function saveDiscordIntegration(input: {
  webhookUrl?: string;
  notifyReplies: boolean;
  notifyCreators: boolean;
  notifySent: boolean;
}): Promise<DiscordIntegration> {
  const token = await sessionBearer();
  const res = await fetch(`${discordApiBase()}/api/integrations/discord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<DiscordIntegration> & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || 'Could not save Discord settings');
  return {
    configured: Boolean(body.configured),
    maskedUrl: body.maskedUrl || '',
    usingEnv: Boolean(body.usingEnv),
    notifyReplies: body.notifyReplies !== false,
    notifyCreators: Boolean(body.notifyCreators),
    notifySent: Boolean(body.notifySent),
  };
}

export async function testDiscordIntegration(webhookUrl?: string): Promise<void> {
  const token = await sessionBearer();
  const res = await fetch(`${discordApiBase()}/api/integrations/discord/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ webhookUrl: webhookUrl?.trim() || '' }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || 'Discord test failed');
}

export interface AnalyticsSummary {
  totalSent: number;
  openRate: number | null;
  openRateLabel: string;
  openRateNote?: string;
  replyRate: number;
  replied: number;
  topPerformingCampaign: { id: string; name: string; sent: number } | null;
  blastSent?: number;
  blastFailed?: number;
  blastOpened?: number;
}

async function fetchAnalyticsFromSupabase(appId?: string | null): Promise<AnalyticsSummary> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  let creatorsQuery = sb.from('creators').select('id, email, outreach_status, campaign_id');
  let campaignsQuery = sb.from('campaigns').select('id, name');
  if (appId) {
    creatorsQuery = creatorsQuery.eq('app_id', appId);
    campaignsQuery = campaignsQuery.eq('app_id', appId);
  }

  const [
    { data: creators, error: cErr },
    { data: campaigns, error: campErr },
    blastRows,
  ] = await Promise.all([
    creatorsQuery,
    campaignsQuery,
    loadBlastMetricRows(sb, appId),
  ]);
  if (cErr) throw new Error(cErr.message);
  if (campErr) throw new Error(campErr.message);

  const creatorIds = (creators ?? []).map((c) => c.id as string);
  let logs: Array<{ sent_at?: string | null }> = [];
  if (creatorIds.length) {
    const { data: logRows, error: lErr } = await sb
      .from('outreach_logs')
      .select('id, creator_id, sent_at, provider')
      .in('creator_id', creatorIds);
    if (lErr) throw new Error(lErr.message);
    logs = (logRows ?? []) as Array<{ sent_at?: string | null }>;
  }

  const summary = summariseReplyMetrics({
    creators: (creators ?? []) as Array<{
      outreach_status: string;
      email?: string | null;
      campaign_id?: string | null;
    }>,
    logs,
    blastRows,
  });
  const sentStatuses = new Set(['sent', 'replied']);
  const sentCreators = (creators ?? []).filter((c) =>
    sentStatuses.has(String(c.outreach_status)),
  );
  const { totalSent, replyRate, replied } = summary;

  const sentByCampaign = new Map<string, number>();
  for (const c of sentCreators) {
    const cid = c.campaign_id as string | null;
    if (!cid) continue;
    sentByCampaign.set(cid, (sentByCampaign.get(cid) ?? 0) + 1);
  }
  let topCampaign: { id: string; name: string; sent: number } | null = null;
  const nameById = new Map(
    (campaigns ?? []).map((c) => [c.id as string, String(c.name)]),
  );
  for (const [id, sent] of sentByCampaign) {
    if (!topCampaign || sent > topCampaign.sent) {
      topCampaign = {
        id,
        name: nameById.get(id) ?? 'Unknown',
        sent,
      };
    }
  }

  return {
    totalSent,
    openRate: null,
    openRateLabel: '\u2014',
    openRateNote: 'Open tracking requires Resend webhooks (not wired)',
    replyRate,
    replied,
    topPerformingCampaign: topCampaign,
    blastSent: summary.blastSent,
    blastFailed: summary.blastFailed,
    blastOpened: summary.blastOpened,
  };
}

export async function fetchAnalytics(appId?: string | null): Promise<AnalyticsSummary> {
  if (preferDirectSupabase()) {
    return fetchAnalyticsFromSupabase(appId);
  }

  const base = apiBase();
  const query = appId ? `?appId=${encodeURIComponent(appId)}` : '';
  const res = await fetch(`${base}/api/analytics${query}`);
  const body = (await res.json().catch(() => ({}))) as AnalyticsSummary & {
    error?: string;
    ok?: boolean;
  };
  if (!res.ok) {
    throw new Error(body.error || `API error ${res.status}`);
  }
  return {
    totalSent: body.totalSent ?? 0,
    openRate: body.openRate ?? null,
    openRateLabel: body.openRateLabel ?? '\u2014',
    openRateNote: body.openRateNote,
    replyRate: body.replyRate ?? 0,
    replied: body.replied ?? 0,
    topPerformingCampaign: body.topPerformingCampaign ?? null,
    blastSent: body.blastSent ?? 0,
    blastFailed: body.blastFailed ?? 0,
    blastOpened: body.blastOpened ?? 0,
  };
}

export type { TemplatePerformanceRow, TemplateRange };

export async function fetchTemplatePerformance(
  appId: string,
  range: TemplateRange,
): Promise<TemplatePerformanceRow[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  const [templatesRes, creatorsRes] = await Promise.all([
    sb.from('email_templates').select('id, name').or(`app_id.eq.${appId},app_id.is.null`),
    sb.from('creators').select('id, outreach_status').eq('app_id', appId),
  ]);
  if (templatesRes.error) throw new Error(templatesRes.error.message);
  if (creatorsRes.error) throw new Error(creatorsRes.error.message);

  const creators = creatorsRes.data ?? [];
  const creatorIds = creators.map((row) => String(row.id));
  const logs: Array<{
    id: string;
    template_id?: string | null;
    sent_at?: string | null;
    creator_id?: string | null;
    outcome?: string | null;
    provider?: string | null;
  }> = [];
  for (let i = 0; i < creatorIds.length; i += 80) {
    const slice = creatorIds.slice(i, i + 80);
    const withTemplate = await sb
      .from('outreach_logs')
      .select('id, template_id, sent_at, creator_id, outcome, provider')
      .in('creator_id', slice);
    if (withTemplate.error && /template_id/i.test(withTemplate.error.message)) {
      const plain = await sb
        .from('outreach_logs')
        .select('id, sent_at, creator_id, outcome, provider')
        .in('creator_id', slice);
      if (plain.error) throw new Error(plain.error.message);
      logs.push(...((plain.data ?? []) as typeof logs));
    } else if (withTemplate.error) {
      throw new Error(withTemplate.error.message);
    } else {
      logs.push(...((withTemplate.data ?? []) as typeof logs));
    }
  }

  const blastRows: Array<{
    id: string;
    template_id?: string | null;
    status?: string | null;
    replied_at?: string | null;
    sent_at?: string | null;
  }> = [];
  const withTemplate = await sb
    .from('blast_sends')
    .select('id, template_id, status, replied_at, sent_at')
    .eq('app_id', appId);
  if (withTemplate.error && /template_id/i.test(withTemplate.error.message)) {
    const withReplies = await sb
      .from('blast_sends')
      .select('id, status, replied_at, sent_at')
      .eq('app_id', appId);
    if (withReplies.error && /replied_at/i.test(withReplies.error.message)) {
      const plain = await sb.from('blast_sends').select('id, status, sent_at').eq('app_id', appId);
      if (plain.error) throw new Error(plain.error.message);
      blastRows.push(...((plain.data ?? []) as typeof blastRows));
    } else if (withReplies.error) {
      throw new Error(withReplies.error.message);
    } else {
      blastRows.push(...((withReplies.data ?? []) as typeof blastRows));
    }
  } else if (withTemplate.error && /replied_at/i.test(withTemplate.error.message)) {
    const plain = await sb
      .from('blast_sends')
      .select('id, template_id, status, sent_at')
      .eq('app_id', appId);
    if (plain.error) throw new Error(plain.error.message);
    blastRows.push(...((plain.data ?? []) as typeof blastRows));
  } else if (withTemplate.error) {
    throw new Error(withTemplate.error.message);
  } else {
    blastRows.push(...((withTemplate.data ?? []) as typeof blastRows));
  }

  const replies: Array<{ id: string; creator_id: string | null; received_at: string | null }> = [];
  for (let i = 0; i < creatorIds.length; i += 80) {
    const slice = creatorIds.slice(i, i + 80);
    const { data, error } = await sb
      .from('email_replies')
      .select('id, creator_id, received_at')
      .in('creator_id', slice);
    if (error) {
      if (/email_replies|schema cache/i.test(error.message)) break;
      throw new Error(error.message);
    }
    replies.push(...((data ?? []) as typeof replies));
  }

  const sends: PerformanceSend[] = [
    ...logs.map((log) => ({
      id: String(log.id),
      templateId: log.template_id ?? null,
      sentAt: log.sent_at ?? null,
      creatorId: log.creator_id ?? null,
      skipped: log.outcome === 'skipped' || log.provider === 'skipped',
    })),
    ...blastRows.map((row) => {
      const status = String(row.status ?? '').toLowerCase();
      const replied = Boolean(row.replied_at);
      const delivered = status === 'sent' || status === 'opened' || replied;
      return {
        id: String(row.id),
        templateId: row.template_id ?? null,
        sentAt: row.sent_at ?? row.replied_at ?? null,
        replied,
        skipped: !delivered,
      };
    }),
  ];

  return rankTemplatePerformance({
    templates: (templatesRes.data ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
    })),
    sends,
    replies: replies.map((row) => ({
      id: row.id,
      creatorId: row.creator_id,
      receivedAt: row.received_at,
    })),
    creators: creators.map((row) => ({
      id: String(row.id),
      replied: row.outreach_status === 'replied',
    })),
    range,
  });
}

const EMAIL_TEMPLATE_LS_KEY = 'solis-email-template';

export async function fetchEmailTemplate(): Promise<{
  source: string;
  template: string;
}> {
  if (!preferDirectSupabase()) {
    const base = apiBase();
    try {
      const res = await fetch(`${base}/api/email-template`);
      if (res.ok) {
        const body = (await res.json()) as { source: string; template: string };
        if (body.template) {
          try {
            localStorage.setItem(EMAIL_TEMPLATE_LS_KEY, body.template);
          } catch {
            /* ignore */
          }
          return body;
        }
      }
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    const local = localStorage.getItem(EMAIL_TEMPLATE_LS_KEY);
    if (local?.trim()) return { source: 'localStorage', template: local };
  } catch {
    /* ignore */
  }
  return {
    source: 'builtin',
    template: `Hi {{creator_handle}},\n\n{{hook}}\n\nI'm reaching out from {{app_name}}.`,
  };
}

export async function saveEmailTemplate(template: string): Promise<void> {
  try {
    localStorage.setItem(EMAIL_TEMPLATE_LS_KEY, template);
  } catch {
    /* ignore */
  }
  if (preferDirectSupabase()) {
    // Netlify: persist in localStorage only (no Express file write).
    return;
  }
  const base = apiBase();
  const res = await fetch(`${base}/api/email-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `API error ${res.status}`);
  }
}

export interface EmailTemplate {
  id: string;
  app_id: string | null;
  name: string;
  subject: string;
  body: string;
  created_at: string;
  updated_at: string;
}

/** Templates for this app, plus shared templates (app_id is null). */
export async function fetchEmailTemplates(appId?: string | null): Promise<EmailTemplate[]> {
  const sb = getSupabase();
  if (!sb) return [];
  let query = sb.from('email_templates').select('*').order('updated_at', { ascending: false });
  if (appId) query = query.or(`app_id.eq.${appId},app_id.is.null`);
  const { data, error } = await query;
  if (error) {
    if (/email_templates|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as EmailTemplate[];
}

export async function createEmailTemplate(input: {
  name: string;
  subject: string;
  body: string;
  appId?: string | null;
}): Promise<EmailTemplate> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const name = input.name.trim();
  if (!name) throw new Error('Name the template before saving.');
  const { data, error } = await sb
    .from('email_templates')
    .insert({
      name,
      subject: input.subject,
      body: input.body,
      ...(input.appId ? { app_id: input.appId } : {}),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as EmailTemplate;
}

export async function updateEmailTemplate(
  id: string,
  input: { name: string; subject: string; body: string },
): Promise<EmailTemplate> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const name = input.name.trim();
  if (!name) throw new Error('Name the template before saving.');
  const { data, error } = await sb
    .from('email_templates')
    .update({
      name,
      subject: input.subject,
      body: input.body,
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as EmailTemplate;
}

export async function deleteEmailTemplate(id: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { error } = await sb.from('email_templates').delete().eq('id', id);
  if (error) throw new Error(error.message);
}


// ---------------------------------------------------------------------------
// Audiences + Direct Blast
// ---------------------------------------------------------------------------

export interface AudienceGroup {
  id: string;
  name: string;
  app_id?: string | null;
  source?: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

export interface AudienceMember {
  id: string;
  group_id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

export interface BlastSend {
  id: string;
  campaign_id: string;
  member_id: string | null;
  email: string;
  status: 'sent' | 'failed' | 'opened' | string;
  error: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
  opened_at?: string | null;
  created_at: string;
}

function parseMembersPayload(payload: {
  emails?: string[];
  members?: Array<{ email: string; display_name?: string }>;
  text?: string;
}): Array<{ email: string; display_name: string | null }> {
  const out: Array<{ email: string; display_name: string | null }> = [];
  const seen = new Set<string>();
  const push = (emailRaw: string, displayName?: string | null) => {
    const email = emailRaw.trim().toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) return;
    seen.add(email);
    out.push({ email, display_name: displayName?.trim() || null });
  };
  for (const m of payload.members ?? []) {
    push(m.email, m.display_name);
  }
  for (const e of payload.emails ?? []) {
    push(e);
  }
  if (payload.text) {
    for (const line of payload.text.split(/[\n,;]+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const angle = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
      if (angle) {
        push(angle[2]!, angle[1]!);
        continue;
      }
      if (trimmed.includes(',') && trimmed.includes('@')) {
        const parts = trimmed.split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
        const emailPart = parts.find((p) => p.includes('@')) ?? parts[0]!;
        const namePart = parts.find((p) => p !== emailPart && !p.includes('@'));
        push(emailPart, namePart ?? null);
        continue;
      }
      push(trimmed);
    }
  }
  return out;
}

export async function fetchAudiences(appId?: string | null): Promise<AudienceGroup[]> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    let groupsQuery = sb
      .from('audience_groups')
      .select('*')
      .order('created_at', { ascending: false });
    if (appId && /^[0-9a-f-]{36}$/i.test(appId)) {
      // Include groups saved before app scoping (null app_id) so they are not hidden.
      groupsQuery = groupsQuery.or(`app_id.eq.${appId},app_id.is.null`);
    }
    const { data: groups, error } = await groupsQuery;
    if (error) throw error;
    const ids = (groups ?? []).map((g) => g.id as string);
    const counts = new Map<string, number>();
    if (ids.length) {
      const { data: members, error: mErr } = await sb
        .from('audience_members')
        .select('group_id')
        .in('group_id', ids);
      if (mErr) throw mErr;
      for (const m of members ?? []) {
        const gid = m.group_id as string;
        counts.set(gid, (counts.get(gid) ?? 0) + 1);
      }
    }
    return (groups ?? []).map((g) => ({
      ...(g as AudienceGroup),
      member_count: counts.get(g.id as string) ?? 0,
    }));
  }

  const query = appId ? `?appId=${encodeURIComponent(appId)}` : '';
  const res = await fetch(`${apiBase()}/api/audiences${query}`);
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    audiences?: AudienceGroup[];
  };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
  return body.audiences ?? [];
}

export async function fetchAudience(
  id: string,
): Promise<AudienceGroup & { members: AudienceMember[] }> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const { data: group, error } = await sb
      .from('audience_groups')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!group) throw new Error('Audience not found');
    const { data: members, error: mErr } = await sb
      .from('audience_members')
      .select('*')
      .eq('group_id', id)
      .order('created_at', { ascending: false });
    if (mErr) throw mErr;
    return {
      ...(group as AudienceGroup),
      members: (members ?? []) as AudienceMember[],
    };
  }

  const res = await fetch(`${apiBase()}/api/audiences/${id}`);
  const body = (await res.json().catch(() => ({}))) as AudienceGroup & {
    members?: AudienceMember[];
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
  return { ...body, members: body.members ?? [] };
}

export async function createAudience(
  name: string,
  appId?: string | null,
  source?: string | null,
): Promise<AudienceGroup> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name is required');
    const { data, error } = await sb
      .from('audience_groups')
      .insert({
        name: trimmed,
        ...(appId ? { app_id: appId } : {}),
        ...(source ? { source } : {}),
      })
      .select()
      .single();
    if (error) throw error;
    return data as AudienceGroup;
  }

  const res = await fetch(`${apiBase()}/api/audiences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      ...(appId ? { app_id: appId } : {}),
      ...(source ? { source } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as AudienceGroup & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
  return body;
}

export async function deleteAudience(id: string): Promise<void> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const { error } = await sb.from('audience_groups').delete().eq('id', id);
    if (error) throw error;
    return;
  }

  const res = await fetch(`${apiBase()}/api/audiences/${id}`, {
    method: 'DELETE',
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
}

export async function addAudienceMembers(
  groupId: string,
  payload: {
    emails?: string[];
    members?: Array<{ email: string; display_name?: string }>;
    text?: string;
  },
): Promise<{ added: number; members: AudienceMember[] }> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const parsed = parseMembersPayload(payload);
    if (parsed.length === 0) {
      throw new Error(
        'Provide emails: string[] or members: {email, display_name?}[] (comma/newline ok)',
      );
    }
    const rows = parsed.map((m) => ({
      group_id: groupId,
      email: m.email,
      display_name: m.display_name,
    }));
    const { data, error } = await sb
      .from('audience_members')
      .upsert(rows, { onConflict: 'group_id,email', ignoreDuplicates: false })
      .select();
    if (error) throw error;
    return { added: data?.length ?? 0, members: (data ?? []) as AudienceMember[] };
  }

  const res = await fetch(`${apiBase()}/api/audiences/${groupId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    added?: number;
    members?: AudienceMember[];
  };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
  return { added: body.added ?? 0, members: body.members ?? [] };
}

export async function deleteAudienceMember(
  groupId: string,
  memberId: string,
): Promise<void> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const { error } = await sb
      .from('audience_members')
      .delete()
      .eq('id', memberId)
      .eq('group_id', groupId);
    if (error) throw error;
    return;
  }

  const res = await fetch(
    `${apiBase()}/api/audiences/${groupId}/members/${memberId}`,
    { method: 'DELETE' },
  );
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
}

export async function sendBlastTest(
  campaignId: string,
  to: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase()}/api/blasts/${campaignId}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
  return body;
}

export async function launchBlast(
  campaignId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase()}/api/blasts/${campaignId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
  return body;
}

/** Send one recipient (Netlify free-tier safe). Client orchestrates the loop. */
export async function sendBlastOne(
  campaignId: string,
  opts: {
    memberId: string;
    isFirst?: boolean;
    isLast?: boolean;
    override?: boolean;
  },
): Promise<{
  ok: boolean;
  status: string;
  email: string;
  display_name: string | null;
  subject?: string;
  body?: string;
  dryRun?: boolean;
  error?: string | null;
  send?: BlastSend;
}> {
  const res = await fetch(`${apiBase()}/api/blasts/${campaignId}/send-one`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      memberId: opts.memberId,
      isFirst: Boolean(opts.isFirst),
      isLast: Boolean(opts.isLast),
      override: Boolean(opts.override),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    ok?: boolean;
    status?: string;
    email?: string;
    display_name?: string | null;
    subject?: string;
    body?: string;
    dryRun?: boolean;
    send?: BlastSend;
  };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
  return {
    ok: Boolean(body.ok),
    status: body.status ?? (body.ok ? 'sent' : 'failed'),
    email: body.email ?? '',
    display_name: body.display_name ?? null,
    subject: body.subject,
    body: body.body,
    dryRun: body.dryRun,
    error: body.error,
    send: body.send,
  };
}

export async function fetchBlastSends(campaignId: string): Promise<{
  counts: { sent: number; failed: number; opened: number };
  sends: BlastSend[];
}> {
  if (preferDirectSupabase()) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const { data, error } = await sb
      .from('blast_sends')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const rows = (data ?? []) as BlastSend[];
    const counts = { sent: 0, failed: 0, opened: 0 };
    for (const r of rows) {
      const s = String(r.status);
      if (s === 'sent') counts.sent += 1;
      else if (s === 'failed') counts.failed += 1;
      else if (s === 'opened') counts.opened += 1;
    }
    return { counts, sends: rows };
  }

  const res = await fetch(`${apiBase()}/api/blasts/${campaignId}/sends`);
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    counts?: { sent: number; failed: number; opened: number };
    sends?: BlastSend[];
  };
  if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
  return {
    counts: body.counts ?? { sent: 0, failed: 0, opened: 0 },
    sends: body.sends ?? [],
  };
}

async function readApi(
  path: string,
  init?: RequestInit,
  base = apiBase(),
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      throw new Error(
        'This action needs the API. Locally, start it with npm run server. On Netlify it runs as a function and does not call localhost.',
      );
    }
    throw err instanceof Error ? err : new Error(message);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error('The API did not return JSON.');
    }
  }
  if (!res.ok || body.ok === false) {
    throw new Error(
      typeof body.error === 'string' && body.error.trim()
        ? body.error
        : `API error ${res.status}`,
    );
  }
  return body;
}

export interface StoreAppResult {
  trackId: string | null;
  name: string;
  developer: string | null;
  bundleId: string | null;
  genre: string | null;
  iconUrl: string | null;
  storeUrl: string | null;
}

export async function searchStoreApps(query: string): Promise<StoreAppResult[]> {
  const body = await readApi(`/api/app-store?q=${encodeURIComponent(query)}`);
  return (Array.isArray(body.results) ? body.results : []) as StoreAppResult[];
}

export async function fetchApps(): Promise<SolisApp[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const ordered = () => sb.from('apps').select('*').order('created_at', { ascending: true });
  let { data, error } = await ordered().is('archived_at', null);
  if (error && /archived_at/i.test(error.message)) {
    const retry = await ordered();
    data = retry.data;
    error = retry.error;
  }
  if (error) throw new Error(error.message);
  return ((data ?? []) as SolisApp[]).filter((app) => !app.archived_at);
}

export async function countAppRecords(appId: string): Promise<{ campaigns: number; creators: number }> {
  const sb = getSupabase();
  if (!sb) return { campaigns: 1, creators: 0 };
  const [campaigns, creators] = await Promise.all([
    sb.from('campaigns').select('id', { count: 'exact', head: true }).eq('app_id', appId),
    sb.from('creators').select('id', { count: 'exact', head: true }).eq('app_id', appId),
  ]);
  if (campaigns.error || creators.error) return { campaigns: 1, creators: 0 };
  return { campaigns: campaigns.count ?? 0, creators: creators.count ?? 0 };
}

export async function setAppArchived(id: string, archived: boolean): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { error } = await sb
    .from('apps')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteApp(id: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { error } = await sb.from('apps').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function createApp(input: {
  name: string;
  developer: string | null;
  bundleId: string | null;
  trackId: string | null;
  iconUrl: string | null;
  storeUrl: string | null;
}): Promise<SolisApp> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  if (input.trackId) {
    const { data: existing, error: readError } = await sb
      .from('apps')
      .select('*')
      .eq('track_id', input.trackId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (existing) return existing as SolisApp;
  }
  const { data, error } = await sb
    .from('apps')
    .insert({
      name: input.name,
      developer: input.developer,
      bundle_id: input.bundleId,
      track_id: input.trackId,
      icon_url: input.iconUrl,
      store_url: input.storeUrl,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as SolisApp;
}

export async function updateApp(
  id: string,
  patch: {
    name: string;
    store_url: string | null;
    value_prop: string | null;
    icon_url: string | null;
  },
): Promise<SolisApp> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const updates: Record<string, string | null> = {
    name: patch.name,
    store_url: patch.store_url,
    icon_url: patch.icon_url,
    value_prop: patch.value_prop,
  };
  let { data, error } = await sb.from('apps').update(updates).eq('id', id).select('*').single();
  if (error && /value_prop/i.test(error.message)) {
    const { value_prop: _ignored, ...withoutPitch } = updates;
    const retry = await sb.from('apps').update(withoutPitch).eq('id', id).select('*').single();
    data = retry.data;
    error = retry.error;
  }
  if (error) throw new Error(error.message);
  const saved = data as SolisApp;
  const renamed = await sb.from('campaigns').update({ app_name: saved.name }).eq('app_id', id);
  if (renamed.error) {
    console.warn('Could not refresh campaign app names', renamed.error.message);
  }
  return saved;
}

export interface DiscoveryHit {
  handle: string;
  platform: 'tiktok' | 'instagram';
  bio: string;
  email: string | null;
  follower_count: number;
  engagement_rate: number | null;
  profile_url: string;
  avatar_url: string | null;
  display_name?: string | null;
  discovery_source?: 'network' | 'hashtag';
  discovery_seed?: string | null;
  existing?: boolean;
  creatorId?: string;
}

export async function fetchDiscoveryAvailability(): Promise<{
  configured: boolean;
  message: string | null;
}> {
  const body = await readApi(
    `/api/discovery/jobs?fresh=${Date.now()}`,
    { cache: 'no-store' },
    expressApiUrl() || apiBase(),
  );
  return {
    configured: Boolean(body.configured),
    message: typeof body.message === 'string' ? body.message : null,
  };
}

export async function startDiscoverySearch(input: {
  appId: string;
  niche: string;
  platforms: string[];
  followerMin: number | null;
  followerMax: number | null;
  resultLimit?: number;
  hashtags?: string[];
  includeExisting?: boolean;
  requirePublicEmail?: boolean;
  minCreators?: number | null;
  aiFallback?: boolean;
  discoverySource?: 'network' | 'hashtags' | 'both';
}): Promise<string> {
  const body = await readApi(
    '/api/discovery/jobs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: input.appId,
        niche: input.niche,
        platforms: input.platforms,
        followerMin: input.followerMin,
        followerMax: input.followerMax,
        resultLimit: input.resultLimit ?? 10,
        hashtags: input.hashtags ?? [],
        includeExisting: Boolean(input.includeExisting),
        requirePublicEmail: input.requirePublicEmail !== false,
        minCreators: input.minCreators ?? null,
        aiFallback: input.aiFallback === true,
        discoverySource: input.discoverySource ?? 'both',
      }),
    },
    expressApiUrl() || apiBase(),
  );
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  if (!jobId) throw new Error('The search did not return an id.');
  return jobId;
}

export async function pollDiscoverySearch(jobId: string): Promise<{
  status: 'running' | 'succeeded' | 'failed';
  message: string | null;
  error: string | null;
  candidates: DiscoveryHit[];
  funnel: DiscoveryFunnel | null;
  hashtagYield: HashtagYield[];
  fallbackTags: string[];
  fallbackSource: 'ai' | 'niche' | null;
}> {
  const body = await readApi(
    `/api/discovery/jobs/${jobId}`,
    undefined,
    expressApiUrl() || apiBase(),
  );
  const status = body.status === 'succeeded' || body.status === 'failed' ? body.status : 'running';
  const funnel = asDiscoveryFunnel(body.funnel);
  const fallbackSource =
    body.fallbackSource === 'ai' || body.fallbackSource === 'niche'
      ? body.fallbackSource
      : funnel?.fallbackSource ?? null;
  return {
    status,
    message: typeof body.message === 'string' ? body.message : null,
    error: typeof body.error === 'string' ? body.error : null,
    candidates: (Array.isArray(body.candidates) ? body.candidates : []) as DiscoveryHit[],
    funnel,
    hashtagYield: asHashtagYield(body.hashtagYield) ?? funnel?.hashtagYield ?? [],
    fallbackTags: Array.isArray(body.fallbackTags)
      ? body.fallbackTags.map((tag) => String(tag))
      : (funnel?.fallbackTags ?? []),
    fallbackSource,
  };
}

export async function continueDiscoverySearch(
  jobId: string,
  input: { action: 'expand' | 'relax' | 'custom'; tags?: string[] },
): Promise<{
  status: 'running' | 'succeeded' | 'failed';
  message: string | null;
  candidates: DiscoveryHit[];
  funnel: DiscoveryFunnel | null;
}> {
  const body = await readApi(
    `/api/discovery/jobs/${jobId}/continue`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: input.action,
        ...(input.tags?.length ? { tags: input.tags } : {}),
      }),
    },
    expressApiUrl() || apiBase(),
  );
  const status = body.status === 'succeeded' || body.status === 'failed' ? body.status : 'running';
  return {
    status,
    message: typeof body.message === 'string' ? body.message : null,
    candidates: (Array.isArray(body.candidates) ? body.candidates : []) as DiscoveryHit[],
    funnel: asDiscoveryFunnel(body.funnel),
  };
}

export async function addDiscoveredCreators(
  appId: string,
  niche: string,
  hits: DiscoveryHit[],
): Promise<{ added: number; skipped: number }> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  if (hits.length === 0) return { added: 0, skipped: 0 };
  const rows = hits.map((hit) => ({
    app_id: appId,
    handle: hit.handle.replace(/^@/, ''),
    platform: hit.platform,
    bio: hit.bio || null,
    email: hit.email || null,
    follower_count: hit.follower_count,
    engagement_rate: hit.engagement_rate,
    profile_url: hit.profile_url || null,
    avatar_url: hit.avatar_url,
    outreach_status: 'pending_review',
    ai_variables: {
      niches: niche ? [niche] : [],
      ...(hit.display_name ? { display_name: hit.display_name } : {}),
      ...(hit.discovery_source
        ? {
            discovery: {
              source: hit.discovery_source,
              ...(hit.discovery_seed ? { seed: hit.discovery_seed } : {}),
            },
          }
        : {}),
    },
  }));
  const { data, error } = await sb
    .from('creators')
    .upsert(rows, { onConflict: 'app_id,platform,handle', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(error.message);
  const added = data?.length ?? 0;
  return { added, skipped: rows.length - added };
}

export async function lookupCreatorsByHandle(
  appId: string,
  hits: Array<{ handle: string; platform: string }>,
): Promise<
  Array<{
    id: string;
    handle: string;
    platform: string;
    email: string | null;
    do_not_contact: boolean;
  }>
> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const handles = [...new Set(hits.map((hit) => hit.handle.replace(/^@/, '')))];
  if (handles.length === 0) return [];
  const { data, error } = await sb
    .from('creators')
    .select('id, handle, platform, email, do_not_contact')
    .eq('app_id', appId)
    .in('handle', handles);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    handle: string;
    platform: string;
    email: string | null;
    do_not_contact: boolean;
  }>;
}

/** Do-not-contact and prior-send flags for a Discover selection. Keyed by platform:handle. */
export async function lookupContactFlags(
  appId: string,
  hits: Array<{ handle: string; platform: string; email: string | null }>,
): Promise<Record<string, { doNotContact: boolean; alreadyContacted: boolean }>> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const flags: Record<string, { doNotContact: boolean; alreadyContacted: boolean }> = {};
  const keyFor = (platform: string, handle: string) =>
    `${platform}:${handle.replace(/^@/, '').toLowerCase()}`;
  for (const hit of hits) flags[keyFor(hit.platform, hit.handle)] = {
    doNotContact: false,
    alreadyContacted: false,
  };
  if (hits.length === 0) return flags;

  const handles = [...new Set(hits.map((hit) => hit.handle.replace(/^@/, '')).filter(Boolean))];
  const emails = [
    ...new Set(
      hits
        .map((hit) => String(hit.email ?? '').trim().toLowerCase())
        .filter((email) => email.includes('@')),
    ),
  ];

  const creators: Array<{
    id: string;
    handle: string;
    platform: string;
    email: string | null;
    do_not_contact: boolean | null;
  }> = [];
  if (handles.length) {
    const { data, error } = await sb
      .from('creators')
      .select('id, handle, platform, email, do_not_contact')
      .eq('app_id', appId)
      .in('handle', handles);
    if (error) throw new Error(error.message);
    creators.push(...((data ?? []) as typeof creators));
  }

  const emailFilter = emails.map((email) => `email.ilike.${email}`).join(',');
  const emailBlocked = new Set<string>();
  if (emailFilter) {
    const { data, error } = await sb
      .from('creators')
      .select('email, do_not_contact')
      .or(emailFilter);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      if (row.do_not_contact && row.email) emailBlocked.add(String(row.email).toLowerCase());
    }
  }

  const contactedEmails = new Set<string>();
  if (emailFilter) {
    const { data, error } = await sb
      .from('blast_sends')
      .select('email, status')
      .or(emailFilter);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const status = String(row.status ?? '').toLowerCase();
      if (row.email && (status === 'sent' || status === 'opened')) {
        contactedEmails.add(String(row.email).toLowerCase());
      }
    }
  }

  const contactedCreators = new Set<string>();
  const creatorIds = [...new Set(creators.map((row) => row.id))];
  if (creatorIds.length) {
    const { data, error } = await sb
      .from('outreach_logs')
      .select('creator_id, sent_at, outcome')
      .in('creator_id', creatorIds)
      .not('sent_at', 'is', null);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      if (row.outcome === 'skipped' || !row.sent_at || !row.creator_id) continue;
      contactedCreators.add(String(row.creator_id));
    }
  }

  for (const hit of hits) {
    const key = keyFor(hit.platform, hit.handle);
    const email = String(hit.email ?? '').trim().toLowerCase();
    const match = creators.find(
      (row) =>
        row.platform === hit.platform &&
        row.handle.replace(/^@/, '').toLowerCase() === hit.handle.replace(/^@/, '').toLowerCase(),
    );
    flags[key] = {
      doNotContact:
        match?.do_not_contact === true || (email.includes('@') && emailBlocked.has(email)),
      alreadyContacted:
        (email.includes('@') && contactedEmails.has(email)) ||
        (match ? contactedCreators.has(match.id) : false),
    };
  }
  return flags;
}

export async function setDoNotContact(creatorId: string, blocked: boolean): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { error } = await sb.from('creators').update({ do_not_contact: blocked }).eq('id', creatorId);
  if (error) throw new Error(error.message);
}

export async function fetchLatestSends(
  creatorIds: string[],
): Promise<Record<string, string>> {
  const sb = getSupabase();
  if (!sb || creatorIds.length === 0) return {};
  const { data, error } = await sb
    .from('outreach_logs')
    .select('creator_id, sent_at, outcome')
    .in('creator_id', creatorIds)
    .not('sent_at', 'is', null);
  if (error) throw new Error(error.message);
  const latest: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.outcome === 'skipped' || !row.sent_at) continue;
    const prev = latest[row.creator_id];
    if (!prev || Date.parse(row.sent_at) > Date.parse(prev)) latest[row.creator_id] = row.sent_at;
  }
  return latest;
}

export async function sendFollowUp(input: {
  creatorId: string;
  days: 3 | 4;
  template?: string;
  subject?: string;
}): Promise<{ threaded: boolean; dryRun: boolean }> {
  const body = await readApi('/api/follow-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return {
    threaded: Boolean(body.threaded),
    dryRun: Boolean(body.dryRun),
  };
}

export async function sendTemplateTest(input: {
  to: string;
  subject: string;
  template: string;
  appName?: string;
}): Promise<void> {
  await readApi('/api/email/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
