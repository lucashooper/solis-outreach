import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DiscoveryStoppedError } from '../discovery/apify.js';
import { hasUsablePublicEmail } from '../discovery/email.js';
import { passesEngagementMinimum } from '../discovery/qualify.js';
import { wantsPublicEmail } from '../discovery/funnel.js';
import { apifyConfigured } from '../discovery/apifyPool.js';
import { savingStageLabel } from '../discovery/progress.js';
import { asDiscoverySource } from '../discovery/network.js';
import { runDiscovery } from '../discovery/runDiscovery.js';
import {
  blankFunnel,
  campaignHasSearchTerms,
  classifyFunnelReason,
  discoveryJobNiche,
  discoveryOutcomeCopy,
  EARLY_EXIT_REASONS,
  jobIsLive,
  logDiscovery,
  reasonFromError,
  SEARCH_STALE_MS,
  type DiscoveryReasonCode,
} from '../discovery/runOutcome.js';
import { readAppBranding, resolveOutreachBranding } from './branding.js';
import type {
  Campaign,
  CreatorCandidate,
  DiscoveryFunnel,
  DiscoveryProviderName,
  TopVideo,
} from '../discovery/types.js';
import {
  buildBestCreatorsDiscordPayload,
  notifyDiscord,
  sendCreatorOutreach,
} from './outreach.js';
import { creatorsFoundPayload, loadDiscordSettings } from './discordNotify.js';
import { resolveOutreachRouting, shouldSendOnDiscovery } from './statusRouting.js';
import { lookupSuppression } from '../outreach/suppression.js';
import { asTemplateId, insertSendRow } from './sendRecord.js';

/** Gap between demo inserts so the campaign list can paint each card. */
const DEMO_STREAM_GAP_MS = 360;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookupStoreUrl(
  sb: SupabaseClient,
  appId: string | null | undefined,
): Promise<string> {
  if (!appId) return '';
  const { data } = await sb.from('apps').select('store_url').eq('id', appId).maybeSingle();
  return typeof data?.store_url === 'string' ? data.store_url.trim() : '';
}

export interface RunCampaignOptions {
  campaignId: string;
  provider: DiscoveryProviderName;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  /** Pre-built client (tests). */
  supabase?: SupabaseClient;
  discordWebhookUrl?: string;
  appName?: string;
  valueProp?: string;
  resendApiKey?: string;
  resendFrom?: string;
  /** Skip actual Resend HTTP (still queues + logs). */
  dryRunOutreach?: boolean;
  /**
   * Ignored. Discovery sends only when the campaign has Auto-email on and a template.
   * Kept so older callers cannot turn a search into a send.
   */
  forceAutoOutreach?: boolean;
  /** Drop candidates without email before upsert (autopilot). */
  filterRequireEmail?: boolean;
  /** Keep creators this app already stores. One search only. */
  includeExisting?: boolean;
  /** Drop candidates below campaign.engagement_rate_min when set (autopilot). */
  filterEngagementMin?: boolean;
  generateHook?: (prompt: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Send even if this email or handle was already contacted. Never bypasses Do not contact. */
  overrideSuppression?: boolean;
  /**
   * One extra Apify pass of up to 2 related tags when the search is under the result limit.
   * Not stored on the campaign. Written onto the discovery job as ai_fallback.
   */
  aiFallback?: boolean;
  /** Search the creator network only. Not saved onto the campaign. */
  discoverySource?: 'network';
  /** Network expansion from the shortfall card never sends email. */
  skipOutreach?: boolean;
}

export interface RunCampaignResult {
  campaignId: string;
  provider: DiscoveryProviderName;
  found: number;
  /** In-range creators already in the CRM. They are not saved onto this campaign again. */
  existing: number;
  withEmail: number;
  queued: number;
  sent: number;
  pendingReview: number;
  upserted: number;
  discoveryRunId: string | null;
  status: string;
  funnel: DiscoveryFunnel | null;
  /** Why the search ended. `ok` when creators were saved or nothing was wrong. */
  reason?: DiscoveryReasonCode;
  error?: string | null;
  outcomeTitle?: string | null;
  outcomeAction?: string | null;
  discoveryJobId?: string | null;
  /** True when this call joined a search that was already running. */
  alreadyRunning?: boolean;
  ok?: boolean;
}

function creatorAiVariables(
  candidate: CreatorCandidate,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...existing,
    niches: candidate.niches,
    ...(candidate.display_name ? { display_name: candidate.display_name } : {}),
    ...(candidate.niche_score != null ? { niche_score: candidate.niche_score } : {}),
    ...(candidate.niche_reason ? { niche_reason: candidate.niche_reason } : {}),
    ...(candidate.niche_band ? { niche_band: candidate.niche_band } : {}),
    ...(candidate.email_source ? { email_source: candidate.email_source } : {}),
    ...(candidate.email_source_url ? { email_source_url: candidate.email_source_url } : {}),
    ...(candidate.discovery_source
      ? {
          discovery: {
            source: candidate.discovery_source,
            ...(candidate.discovery_seed ? { seed: candidate.discovery_seed } : {}),
          },
        }
      : {}),
  };
}

async function openCampaignSearchJob(
  sb: SupabaseClient,
  campaign: Campaign & { app_id?: string | null },
  appId: string | null,
  aiFallback: boolean,
  includeExisting: boolean,
): Promise<string | null> {
  const niche = discoveryJobNiche(campaign);
  const row: Record<string, unknown> = {
    app_id: appId,
    campaign_id: campaign.id,
    niche,
    platforms: campaign.platforms ?? [],
    follower_min: campaign.follower_min,
    follower_max: campaign.follower_max,
    result_limit: campaign.result_limit > 0 ? campaign.result_limit : 10,
    hashtags: campaign.hashtags ?? [],
    include_existing: includeExisting,
    require_public_email: wantsPublicEmail(campaign.require_public_email),
    min_creators: campaign.min_creators ?? null,
    ai_fallback: aiFallback,
    status: 'running',
    runs: [],
  };
  let inserted = await sb.from('discovery_jobs').insert(row).select('id').maybeSingle();
  if (inserted.error && /campaign_id/i.test(inserted.error.message)) {
    const { campaign_id: _ignored, ...withoutCampaign } = row;
    inserted = await sb.from('discovery_jobs').insert(withoutCampaign).select('id').maybeSingle();
  }
  if (inserted.error || !inserted.data?.id) {
    console.warn(
      '[discovery] could not record the search job',
      inserted.error?.message ?? 'no id',
    );
    return null;
  }
  return String(inserted.data.id);
}

async function touchSearchJob(
  sb: SupabaseClient,
  jobId: string | null,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!jobId) return;
  const { error } = await sb.from('discovery_jobs').update(patch).eq('id', jobId);
  if (error) console.warn('[discovery] could not update the search job', error.message);
}

/**
 * Mark running jobs with no write for 10 minutes as failed, and return a job
 * that is still live. A stale row must not lock the campaign.
 */
export async function releaseStaleCampaignSearch(
  sb: SupabaseClient,
  campaignId: string,
  now = Date.now(),
): Promise<string | null> {
  const { data, error } = await sb
    .from('discovery_jobs')
    .select('id, status, updated_at, created_at')
    .eq('campaign_id', campaignId)
    .in('status', ['running', 'stopping'])
    .order('created_at', { ascending: true })
    .limit(8);
  if (error || !data) return null;
  let liveId: string | null = null;
  for (const row of data) {
    const id = String(row.id ?? '');
    if (!id) continue;
    const updated = String(row.updated_at ?? row.created_at ?? '');
    if (jobIsLive(String(row.status ?? ''), updated, now)) {
      if (!liveId) liveId = id;
      continue;
    }
    const staleFor = Number.isFinite(Date.parse(updated)) ? now - Date.parse(updated) : SEARCH_STALE_MS;
    await sb
      .from('discovery_jobs')
      .update({
        status: 'failed',
        error: 'This search stopped updating and was marked as failed.',
      })
      .eq('id', id)
      .in('status', ['running', 'stopping']);
    logDiscovery('stale', { campaign: campaignId, job: id, ms: staleFor });
  }
  if (!liveId) {
    await sb.from('campaigns').update({ status: 'ready' }).eq('id', campaignId).eq('status', 'searching');
  }
  return liveId;
}

function idleResult(
  campaignId: string,
  provider: DiscoveryProviderName,
  status: string,
  reason: DiscoveryReasonCode,
  jobId: string | null,
  funnel: DiscoveryFunnel,
): RunCampaignResult {
  const copy = discoveryOutcomeCopy(reason, funnel);
  return {
    campaignId,
    provider,
    found: 0,
    existing: funnel.existing ?? 0,
    withEmail: 0,
    queued: 0,
    sent: 0,
    pendingReview: 0,
    upserted: 0,
    discoveryRunId: null,
    status,
    funnel,
    reason,
    error: copy?.title ?? null,
    outcomeTitle: copy?.title ?? null,
    outcomeAction: copy?.action ?? null,
    discoveryJobId: jobId,
    alreadyRunning: reason === 'already_running',
    ok: reason !== 'already_running' ? false : true,
  };
}

function requireEnv(name: string, fallback?: string): string {
  const v = fallback ?? process.env[name] ?? '';
  if (!v.trim()) throw new Error(`Missing required env: ${name}`);
  return v.trim();
}

/** Subject and body saved on the campaign, filled from the linked template when a side is blank. */
async function outreachTemplateFromCampaign(
  sb: SupabaseClient,
  campaign: {
    email_subject?: string | null;
    email_body?: string | null;
    template_id?: string | null;
  },
): Promise<{ templateSubject?: string; templateBody?: string }> {
  let subject = String(campaign.email_subject || '').trim();
  let body = String(campaign.email_body || '').trim();
  const templateId = String(campaign.template_id || '').trim();
  if (templateId && (!subject || !body)) {
    const { data } = await sb
      .from('email_templates')
      .select('subject, body')
      .eq('id', templateId)
      .maybeSingle();
    if (!subject && data?.subject) subject = String(data.subject).trim();
    if (!body && data?.body) body = String(data.body).trim();
  }
  return {
    ...(subject ? { templateSubject: subject } : {}),
    ...(body ? { templateBody: body } : {}),
  };
}

/**
 * Orchestrate: discover → upsert creators → optional auto-outreach → Discord.
 */
export async function runCampaign(
  options: RunCampaignOptions,
): Promise<RunCampaignResult> {
  const sb =
    options.supabase ??
    createClient(
      requireEnv('SUPABASE_URL', options.supabaseUrl),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY', options.serviceRoleKey),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

  const { data: campaignRow, error: campErr } = await sb
    .from('campaigns')
    .select('*')
    .eq('id', options.campaignId)
    .single();

  if (campErr || !campaignRow) {
    throw new Error(
      `Campaign not found: ${options.campaignId}${campErr ? ` (${campErr.message})` : ''}`,
    );
  }

  const campaign = (
    options.discoverySource
      ? { ...(campaignRow as Campaign), discovery_source: options.discoverySource }
      : (campaignRow as Campaign)
  );
  const campaignAppId =
    typeof (campaignRow as { app_id?: string | null }).app_id === 'string'
      ? (campaignRow as { app_id: string }).app_id
      : null;

  const startedAt = Date.now();
  if (options.provider === 'apify') {
    const runningId = await releaseStaleCampaignSearch(sb, campaign.id);
    if (runningId) {
      const funnel = blankFunnel({ reason: 'already_running' });
      logDiscovery('already_running', { campaign: campaign.id, job: runningId });
      return idleResult(campaign.id, options.provider, campaign.status, 'already_running', runningId, funnel);
    }
  }

  await sb
    .from('campaigns')
    .update({ status: 'searching' })
    .eq('id', campaign.id);

  const campaignTemplate = await outreachTemplateFromCampaign(sb, campaign);
  const outreachTemplateId = asTemplateId(campaign.template_id);
  const hasTemplate = Boolean(
    campaignTemplate.templateSubject && campaignTemplate.templateBody,
  );
  const autoOutreachEarly = options.skipOutreach
    ? false
    : shouldSendOnDiscovery({
        autoOutreach: Boolean(campaign.auto_outreach),
        hasTemplate,
      });
  if (options.forceAutoOutreach && !autoOutreachEarly) {
    console.log(
      '[runCampaign] skipped forced outreach. Auto-email is off or the campaign has no template.',
    );
  }

  const saveLimit = campaign.result_limit > 0 ? campaign.result_limit : 10;
  const minEng =
    campaign.engagement_rate_min != null ? Number(campaign.engagement_rate_min) : null;
  const dropWithoutEmail =
    Boolean(options.filterRequireEmail) || wantsPublicEmail(campaign.require_public_email);
  const streamed = new Set<string>();
  const insertedDuringStream = new Map<string, string>();
  let streamedCount = 0;

  const acceptPartial = (candidate: CreatorCandidate): boolean => {
    if (streamedCount >= saveLimit) return false;
    const key = `${candidate.platform}:${candidate.handle.toLowerCase()}`;
    if (streamed.has(key)) return false;
    if (dropWithoutEmail && !hasUsablePublicEmail(candidate.email)) return false;
    if (
      options.filterEngagementMin &&
      !passesEngagementMinimum(candidate.engagement_rate, minEng)
    ) {
      return false;
    }
    return true;
  };

  const aiFallback = options.aiFallback === true;
  const includeCrm = campaign.include_crm_creators === true;
  const searchJobId =
    options.provider === 'apify'
      ? await openCampaignSearchJob(sb, campaign, campaignAppId, aiFallback, includeCrm)
      : null;
  logDiscovery('start', {
    job: searchJobId,
    campaign: campaign.id,
    provider: options.provider,
    min: campaign.min_creators ?? null,
    limit: campaign.result_limit,
    requireEmail: wantsPublicEmail(campaign.require_public_email),
  });

  if (searchJobId) {
    const oldest = await releaseStaleCampaignSearch(sb, campaign.id);
    if (oldest && oldest !== searchJobId) {
      const funnel = blankFunnel({ reason: 'already_running' });
      await touchSearchJob(sb, searchJobId, {
        status: 'failed',
        error: discoveryOutcomeCopy('already_running', funnel)?.title ?? 'Already running',
        funnel,
      });
      await sb.from('campaigns').update({ status: 'searching' }).eq('id', campaign.id);
      logDiscovery('already_running', {
        campaign: campaign.id,
        job: oldest,
        duplicate: searchJobId,
        ms: Date.now() - startedAt,
      });
      return idleResult(campaign.id, options.provider, 'searching', 'already_running', oldest, funnel);
    }
  }

  const openingSource = asDiscoverySource(campaign.discovery_source) ?? 'both';
  await touchSearchJob(sb, searchJobId, {
    funnel: blankFunnel({
      followerMin: campaign.follower_min,
      followerMax: campaign.follower_max,
      requirePublicEmail: wantsPublicEmail(campaign.require_public_email),
      stage: {
        phase: openingSource === 'hashtags' ? 'hashtags' : 'network',
        label: openingSource === 'hashtags' ? 'Scanning hashtags…' : 'Picking seed creators…',
        checked: 0,
        found: 0,
      },
    }),
  });

  const stopEarly = async (
    reason: DiscoveryReasonCode,
    message: string,
  ): Promise<RunCampaignResult> => {
    const funnel = blankFunnel({
      reason,
      followerMin: campaign.follower_min,
      followerMax: campaign.follower_max,
      requirePublicEmail: wantsPublicEmail(campaign.require_public_email),
    });
    const copy = discoveryOutcomeCopy(reason, funnel);
    const error = copy?.title ?? message;
    await touchSearchJob(sb, searchJobId, { status: 'failed', error, funnel, runs: [] });
    const { error: logError } = await sb.from('discovery_runs').insert({
      campaign_id: campaign.id,
      provider: options.provider,
      query: { failed: true, reason },
      results_count: 0,
      raw: null,
      error,
      funnel,
    });
    if (logError) console.warn('[discovery] could not store the failed run', logError.message);
    await sb.from('campaigns').update({ status: 'ready' }).eq('id', campaign.id);
    logDiscovery('done', {
      job: searchJobId,
      campaign: campaign.id,
      status: 'failed',
      reason,
      ms: Date.now() - startedAt,
    });
    return idleResult(campaign.id, options.provider, 'ready', reason, searchJobId, funnel);
  };

  if (options.provider === 'apify' && !campaignHasSearchTerms(campaign)) {
    return stopEarly('no_search_terms', 'No hashtags or niches to search.');
  }
  if (options.provider === 'apify' && !apifyConfigured()) {
    return stopEarly('apify_not_configured', 'Apify is not configured.');
  }

  let liveFunnel: DiscoveryFunnel = blankFunnel({
    followerMin: campaign.follower_min,
    followerMax: campaign.follower_max,
    requirePublicEmail: wantsPublicEmail(campaign.require_public_email),
    stage: {
      phase: openingSource === 'hashtags' ? 'hashtags' : 'network',
      label: openingSource === 'hashtags' ? 'Scanning hashtags…' : 'Picking seed creators…',
      checked: 0,
      found: 0,
    },
  });
  const publishLive = async (patch: Partial<DiscoveryFunnel>) => {
    liveFunnel = {
      ...liveFunnel,
      ...patch,
      stage: patch.stage ?? liveFunnel.stage,
    };
    await touchSearchJob(sb, searchJobId, { funnel: liveFunnel });
  };

  let discovery;
  try {
    discovery = await runDiscovery(campaign, options.provider, {
      sb,
      appId: campaignAppId,
      includeExisting: includeCrm,
      aiFallback,
      onYield: async (rows) => {
        await publishLive({ hashtagYield: [...rows] });
      },
      onProgress: publishLive,
      shouldStop: async () => {
        if (!searchJobId) return false;
        const { data } = await sb
          .from('discovery_jobs')
          .select('status')
          .eq('id', searchJobId)
          .maybeSingle();
        const status = String(data?.status ?? '');
        return status === 'stopping' || status === 'stopped';
      },
      onPartial: async (rows) => {
        for (const candidate of rows) {
          if (candidate.alreadyInCrm) continue;
          if (!acceptPartial(candidate)) continue;
          const key = `${candidate.platform}:${candidate.handle.toLowerCase()}`;
          streamed.add(key);
          const initialStatus = resolveOutreachRouting({
            autoOutreach: autoOutreachEarly,
            hasEmail: Boolean(candidate.email?.trim()),
          });
          const row = await upsertCandidate(
            sb,
            campaign.id,
            candidate,
            initialStatus,
            campaignAppId,
          );
          if (row) {
            streamedCount += 1;
            if (row.inserted) insertedDuringStream.set(key, row.id);
          }
        }
        if (streamedCount > 0) {
          await publishLive({
            stage: {
              phase: liveFunnel.stage?.phase ?? 'saving',
              label: liveFunnel.stage?.label || savingStageLabel(streamedCount),
              checked: liveFunnel.stage?.checked ?? streamedCount,
              found: streamedCount,
              ...(liveFunnel.stage?.tags ? { tags: liveFunnel.stage.tags } : {}),
            },
          });
        }
      },
    });
  } catch (err) {
    if (err instanceof DiscoveryStoppedError) {
      liveFunnel = {
        ...liveFunnel,
        stage: {
          phase: 'done',
          label: 'Search stopped',
          checked: liveFunnel.stage?.checked ?? 0,
          found: streamedCount,
        },
        saved: streamedCount,
      };
      await touchSearchJob(sb, searchJobId, {
        status: 'stopped',
        funnel: liveFunnel,
        error: null,
      });
      await sb.from('campaigns').update({ status: 'ready' }).eq('id', campaign.id);
      logDiscovery('done', {
        job: searchJobId,
        campaign: campaign.id,
        status: 'stopped',
        saved: streamedCount,
        ms: Date.now() - startedAt,
      });
      return {
        campaignId: campaign.id,
        provider: options.provider,
        found: streamedCount,
        existing: 0,
        withEmail: streamedCount,
        queued: 0,
        sent: 0,
        pendingReview: 0,
        upserted: streamedCount,
        discoveryRunId: null,
        status: 'ready',
        funnel: liveFunnel,
        reason: 'ok',
        error: null,
        outcomeTitle: 'Search stopped.',
        outcomeAction: 'Creators found before the stop are saved.',
        discoveryJobId: searchJobId,
        alreadyRunning: false,
        ok: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    const reason = reasonFromError(message);
    logDiscovery('error', {
      job: searchJobId,
      campaign: campaign.id,
      reason,
      message: message.slice(0, 180),
      ms: Date.now() - startedAt,
    });
    return stopEarly(reason, message);
  }

  let funnel: DiscoveryFunnel | null = discovery.funnel ?? null;
  let reason: DiscoveryReasonCode = 'ok';
  if (options.provider === 'apify') {
    funnel = discovery.funnel
      ? { ...discovery.funnel, reason: discovery.funnel.reason ?? classifyFunnelReason(discovery.funnel) }
      : blankFunnel({
          reason: 'actor_failed',
          followerMin: campaign.follower_min,
          followerMax: campaign.follower_max,
        });
    reason = funnel.reason ?? classifyFunnelReason(funnel);
    funnel.reason = reason;
    const early = EARLY_EXIT_REASONS.has(reason);
    const copy = discoveryOutcomeCopy(reason, funnel);
    const runRows = funnel.apifyRunIds.filter(Boolean).map((runId) => ({ runId }));
    await touchSearchJob(sb, searchJobId, {
      status: early ? 'failed' : 'succeeded',
      funnel,
      error: early ? copy?.title ?? 'Search failed.' : null,
      runs: runRows,
    });
    await sb
      .from('campaigns')
      .update({ status: early ? 'ready' : autoOutreachEarly ? 'outreaching' : 'ready' })
      .eq('id', campaign.id);
    logDiscovery('done', {
      job: searchJobId,
      campaign: campaign.id,
      status: early ? 'failed' : 'succeeded',
      reason,
      raw: funnel.rawItems,
      saved: funnel.saved,
      existing: funnel.existing ?? 0,
      runs: funnel.apifyRunIds.filter(Boolean).join(',') || 'none',
      ms: Date.now() - startedAt,
    });
    discovery.funnel = funnel;
    if (early) {
      await sb.from('campaigns').update({ status: 'ready' }).eq('id', campaign.id);
      return idleResult(campaign.id, options.provider, 'ready', reason, searchJobId, funnel);
    }
  }

  if (dropWithoutEmail || options.filterEngagementMin) {
    const minEng =
      campaign.engagement_rate_min != null
        ? Number(campaign.engagement_rate_min)
        : null;
    discovery.candidates = discovery.candidates.filter((c) => {
      if (dropWithoutEmail && !hasUsablePublicEmail(c.email)) return false;
      if (
        options.filterEngagementMin &&
        !passesEngagementMinimum(c.engagement_rate, minEng)
      ) {
        return false;
      }
      return true;
    });
    if (discovery.funnel) {
      const next = { ...discovery.funnel, saved: discovery.candidates.length };
      next.reason = classifyFunnelReason({ ...next, reason: undefined });
      discovery.funnel = next;
      await touchSearchJob(sb, searchJobId, { funnel: next });
    }
  }

  const { data: runRow, error: runErr } = await sb
    .from('discovery_runs')
    .insert({
      campaign_id: campaign.id,
      provider: options.provider,
      query: discovery.query,
      results_count: discovery.candidates.length,
      raw: discovery.raw ?? null,
      funnel: discovery.funnel ?? null,
    })
    .select('id')
    .single();

  if (runErr) {
    throw new Error(`Failed to log discovery_run: ${runErr.message}`);
  }

  // Clear "searching" before Discord and any send loop, so the campaign page
  // can drop "Running…" as soon as the run row exists.
  await sb
    .from('campaigns')
    .update({ status: autoOutreachEarly ? 'outreaching' : 'ready' })
    .eq('id', campaign.id);

  let upserted = 0;
  const upsertedCreators: Array<{
    id: string;
    handle: string;
    bio: string | null;
    email: string | null;
    ai_variables: Record<string, unknown>;
    outreach_status: string;
    do_not_contact?: boolean;
    top_videos?: Array<{ caption?: string | null }>;
  }> = [];

  for (const candidate of discovery.candidates) {
    const key = `${candidate.platform}:${candidate.handle.toLowerCase()}`;
    const alreadyStreamed = streamed.has(key);
    const initialStatus = resolveOutreachRouting({
      autoOutreach: autoOutreachEarly,
      hasEmail: Boolean(candidate.email?.trim()),
    });
    const row = await upsertCandidate(
      sb,
      campaign.id,
      candidate,
      initialStatus,
      campaignAppId,
    );
    if (row) {
      upserted += 1;
      upsertedCreators.push(row);
      streamed.add(key);
    }
    if (!alreadyStreamed && options.provider === 'demo') {
      await sleep(DEMO_STREAM_GAP_MS);
    }
  }

  const kept = new Set(
    discovery.candidates.map((candidate) => `${candidate.platform}:${candidate.handle.toLowerCase()}`),
  );
  for (const [key, id] of insertedDuringStream) {
    if (kept.has(key)) continue;
    const { error: dropError } = await sb.from('creators').delete().eq('id', id);
    if (dropError) {
      console.warn('[runCampaign] could not drop an extra partial creator', dropError.message);
    }
  }

  const withEmail = upsertedCreators.filter((c) => c.email).length;
  let queued = 0;
  let sent = 0;
  const pendingReview = upsertedCreators.filter(
    (c) => c.outreach_status === 'pending_review',
  ).length;

  const appBranding = await readAppBranding(sb, campaignAppId);
  const resolvedBranding = resolveOutreachBranding({
    appName: appBranding.name,
    appValueProp: appBranding.valueProp,
    campaignAppName: options.appName ?? campaign.app_name,
    campaignValueProp: options.valueProp ?? campaign.value_prop,
    fallbackAppName: process.env.APP_NAME,
    fallbackValueProp: process.env.APP_VALUE_PROP,
  });
  const appName = resolvedBranding.appName;
  const valueProp = resolvedBranding.valueProp;

  const autoOutreach = autoOutreachEarly;
  const storeUrl = await lookupStoreUrl(sb, campaignAppId);

  if (autoOutreach) {
    await sb
      .from('campaigns')
      .update({ status: 'outreaching' })
      .eq('id', campaign.id);

    for (const creator of upsertedCreators) {
      if (!creator.email) continue;

      const gate = await lookupSuppression(sb, {
        email: creator.email,
        handle: creator.handle,
        doNotContact: creator.do_not_contact === true,
        override: options.overrideSuppression === true,
      });
      if (gate.skip) {
        await insertSendRow(sb, 'outreach_logs', {
          creator_id: creator.id,
          message_body: gate.reason,
          sequence_step: 1,
          sent_at: null,
          provider: 'skipped',
          outcome: 'skipped',
          webhook_events: [],
          ...(outreachTemplateId ? { template_id: outreachTemplateId } : {}),
        });
        continue;
      }

      // Already set to queued via upsert; count it
      queued += 1;

      const result = await sendCreatorOutreach(
        creator,
        { appName, valueProp, storeUrl },
        {
          resendApiKey: options.dryRunOutreach
            ? ''
            : options.resendApiKey ?? process.env.RESEND_API_KEY,
          resendFrom: options.resendFrom ?? process.env.RESEND_FROM_EMAIL,
          generateHook: options.generateHook,
          fetchImpl: options.fetchImpl,
          ...campaignTemplate,
        },
      );

      const aiVars = {
        ...(creator.ai_variables ?? {}),
        hook: result.hook || undefined,
        niches: (creator.ai_variables as { niches?: string[] })?.niches,
      };

      if (result.ok) {
        await sb
          .from('creators')
          .update({
            outreach_status: 'sent',
            ai_variables: aiVars,
          })
          .eq('id', creator.id);

        await insertSendRow(sb, 'outreach_logs', {
          creator_id: creator.id,
          message_body: result.emailBody,
          subject: result.subject,
          sequence_step: 1,
          sent_at: new Date().toISOString(),
          provider: result.skipped ? 'resend-dry-run' : 'resend',
          provider_message_id: result.providerMessageId,
          webhook_events: [],
          ...(outreachTemplateId ? { template_id: outreachTemplateId } : {}),
        });
        sent += 1;
      } else if (!result.skipped) {
        await sb
          .from('creators')
          .update({
            ai_variables: {
              ...aiVars,
              last_outreach_error: result.error,
            },
          })
          .eq('id', creator.id);
      }
    }
  }

  const finalStatus = autoOutreach ? 'done' : 'ready';
  await sb
    .from('campaigns')
    .update({ status: finalStatus })
    .eq('id', campaign.id);

  const settings = await loadDiscordSettings(sb);
  const discordUrl =
    settings.webhookUrl ||
    options.discordWebhookUrl ||
    process.env.DISCORD_WEBHOOK_URL ||
    '';
  const readyOrPending = autoOutreach ? queued : pendingReview;

  if (discordUrl && settings.notifyCreators) {
    try {
      await notifyDiscord(
        discordUrl,
        creatorsFoundPayload({
          campaignName: campaign.name,
          found: discovery.candidates.length,
          autoOutreach,
          readyOrPendingCount: readyOrPending,
        }),
        options.fetchImpl,
      );
    } catch (err) {
      console.warn(
        '[runCampaign] Discord notify failed:',
        err instanceof Error ? err.message : err,
      );
    }

    // Rich embeds for top creators with email (live discovery highlights)
    const topForDiscord = discovery.candidates
      .filter((c) => c.email?.trim())
      .slice(0, 10);
    if (topForDiscord.length > 0) {
      try {
        const payload = buildBestCreatorsDiscordPayload({
          campaignName: campaign.name,
          creators: topForDiscord.map((c) => ({
            handle: c.handle,
            platform: c.platform,
            profile_url: c.profile_url,
            avatar_url: c.avatar_url,
            follower_count: c.follower_count,
            engagement_rate: c.engagement_rate,
            email: c.email,
            top_videos: c.top_videos,
          })),
        });
        await notifyDiscord(discordUrl, payload, options.fetchImpl);
      } catch (err) {
        console.warn(
          '[runCampaign] Discord best-creators embeds failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const finalFunnel = discovery.funnel ?? funnel;
  const finalReason = finalFunnel?.reason ?? reason;
  const outcome = discoveryOutcomeCopy(finalReason, finalFunnel);
  return {
    campaignId: campaign.id,
    provider: options.provider,
    found: discovery.candidates.length,
    existing: discovery.existingMatches?.length ?? discovery.funnel?.existing ?? 0,
    withEmail,
    queued,
    sent,
    pendingReview,
    upserted,
    discoveryRunId: runRow?.id ?? null,
    status: finalStatus,
    funnel: finalFunnel,
    reason: finalReason,
    error: null,
    outcomeTitle: outcome?.title ?? null,
    outcomeAction: outcome?.action ?? null,
    discoveryJobId: searchJobId,
    alreadyRunning: false,
    ok: true,
  };
}

async function upsertCandidate(
  sb: SupabaseClient,
  campaignId: string,
  candidate: CreatorCandidate,
  outreachStatus: string,
  appId: string | null,
): Promise<{
  id: string;
  handle: string;
  bio: string | null;
  email: string | null;
  ai_variables: Record<string, unknown>;
  outreach_status: string;
  top_videos?: Array<{ caption?: string | null }>;
  inserted: boolean;
} | null> {
  const topVideos: TopVideo[] = candidate.top_videos ?? [];
  const payload = {
    handle: candidate.handle,
    platform: candidate.platform,
    bio: candidate.bio,
    email: candidate.email,
    follower_count: candidate.follower_count,
    engagement_rate: candidate.engagement_rate,
    profile_url: candidate.profile_url,
    avatar_url: candidate.avatar_url ?? null,
    top_videos: topVideos,
    campaign_id: campaignId,
    ai_variables: creatorAiVariables(candidate),
    outreach_status: outreachStatus,
    ...(appId ? { app_id: appId } : {}),
  };

  let existingQuery = sb
    .from('creators')
    .select('id, outreach_status, ai_variables')
    .eq('platform', candidate.platform)
    .eq('handle', candidate.handle);
  if (appId) existingQuery = existingQuery.eq('app_id', appId);
  const { data: existing } = await existingQuery.maybeSingle();

  if (existing) {
    const existingStatus = String(existing.outreach_status ?? 'pending');
    // Do not regress sent/replied/archived on re-discovery
    const preserveStatus = ['sent', 'replied', 'archived', 'queued'].includes(
      existingStatus,
    );
    const { data, error } = await sb
      .from('creators')
      .update({
        bio: payload.bio,
        email: payload.email ?? undefined,
        follower_count: payload.follower_count,
        engagement_rate: payload.engagement_rate,
        profile_url: payload.profile_url,
        avatar_url: payload.avatar_url,
        top_videos: payload.top_videos,
        campaign_id: campaignId,
        outreach_status: preserveStatus ? existingStatus : outreachStatus,
        ai_variables: creatorAiVariables(
          candidate,
          (existing.ai_variables as Record<string, unknown>) ?? {},
        ),
      })
      .eq('id', existing.id)
      .select('id, handle, bio, email, ai_variables, outreach_status')
      .single();
    if (error) {
      console.warn('[upsertCandidate] update failed:', error.message);
      return null;
    }
    return {
      ...(data as {
        id: string;
        handle: string;
        bio: string | null;
        email: string | null;
        ai_variables: Record<string, unknown>;
        outreach_status: string;
      }),
      top_videos: topVideos,
      inserted: false,
    };
  }

  const { data, error } = await sb
    .from('creators')
    .insert(payload)
    .select('id, handle, bio, email, ai_variables, outreach_status')
    .single();

  if (error) {
    console.warn('[upsertCandidate] insert failed:', error.message);
    return null;
  }
  return {
    ...(data as {
      id: string;
      handle: string;
      bio: string | null;
      email: string | null;
      ai_variables: Record<string, unknown>;
      outreach_status: string;
    }),
    top_videos: topVideos,
    inserted: true,
  };
}

/**
 * Approve a creator from the CRM: personalise + queue/send via Resend.
 */
export async function approveAndPitchCreator(options: {
  creatorId: string;
  supabase?: SupabaseClient;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  resendApiKey?: string;
  resendFrom?: string;
  generateHook?: (prompt: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  dryRun?: boolean;
  overrideSuppression?: boolean;
  subject?: string;
  body?: string;
  templateId?: string | null;
}): Promise<{
  ok: boolean;
  status: string;
  hook: string;
  error?: string;
}> {
  const sb =
    options.supabase ??
    createClient(
      requireEnv('SUPABASE_URL', options.supabaseUrl),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY', options.serviceRoleKey),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

  const { data: creator, error } = await sb
    .from('creators')
    .select('*')
    .eq('id', options.creatorId)
    .single();

  if (error || !creator) {
    throw new Error(`Creator not found: ${options.creatorId}`);
  }

  if (!creator.email?.trim()) {
    return {
      ok: false,
      status: creator.outreach_status,
      hook: '',
      error: 'Creator has no email — cannot pitch',
    };
  }

  const templateIdFromRequest = asTemplateId(options.templateId);
  const gate = await lookupSuppression(sb, {
    email: creator.email,
    handle: creator.handle,
    doNotContact: creator.do_not_contact === true,
    override: options.overrideSuppression === true,
  });
  if (gate.skip) {
    await insertSendRow(sb, 'outreach_logs', {
      creator_id: creator.id,
      message_body: gate.reason,
      sequence_step: 1,
      sent_at: null,
      provider: 'skipped',
      outcome: 'skipped',
      webhook_events: [],
      ...(templateIdFromRequest ? { template_id: templateIdFromRequest } : {}),
    });
    return {
      ok: false,
      status: creator.outreach_status,
      hook: '',
      error: gate.reason ?? 'Send skipped',
    };
  }

  const creatorAppId = typeof creator.app_id === 'string' ? creator.app_id : null;
  const appBranding = await readAppBranding(sb, creatorAppId);
  const storeUrl = await lookupStoreUrl(sb, creatorAppId);

  let campaignTemplate: { templateSubject?: string; templateBody?: string } = {};
  let campaignAppName: string | null = null;
  let campaignValueProp: string | null = null;
  let templateId = templateIdFromRequest;
  if (creator.campaign_id) {
    const { data: campaign } = await sb
      .from('campaigns')
      .select('app_name, value_prop, email_subject, email_body, template_id')
      .eq('id', creator.campaign_id)
      .maybeSingle();
    campaignAppName = campaign?.app_name ? String(campaign.app_name) : null;
    campaignValueProp = campaign?.value_prop ? String(campaign.value_prop) : null;
    if (campaign) campaignTemplate = await outreachTemplateFromCampaign(sb, campaign);
    if (!templateId && campaign) templateId = asTemplateId(campaign.template_id);
  }
  const resolved = resolveOutreachBranding({
    appName: appBranding.name,
    appValueProp: appBranding.valueProp,
    campaignAppName,
    campaignValueProp,
    fallbackAppName: process.env.APP_NAME,
    fallbackValueProp: process.env.APP_VALUE_PROP,
  });
  const appName = resolved.appName;
  const valueProp = resolved.valueProp;

  await sb
    .from('creators')
    .update({ outreach_status: 'queued' })
    .eq('id', creator.id);

  const result = await sendCreatorOutreach(
    {
      id: creator.id,
      handle: creator.handle,
      bio: creator.bio,
      email: creator.email,
      platform: creator.platform,
      top_videos: Array.isArray(creator.top_videos) ? creator.top_videos : [],
      ai_variables: (creator.ai_variables ?? {}) as Record<string, unknown>,
    },
    { appName, valueProp, storeUrl },
    {
      resendApiKey: options.dryRun
        ? ''
        : options.resendApiKey ?? process.env.RESEND_API_KEY,
      resendFrom: options.resendFrom ?? process.env.RESEND_FROM_EMAIL,
      generateHook: options.generateHook,
      fetchImpl: options.fetchImpl,
      ...campaignTemplate,
      renderedSubject: options.subject,
      renderedBody: options.body,
    },
  );

  const aiVars = {
    ...((creator.ai_variables as Record<string, unknown>) ?? {}),
    hook: result.hook || undefined,
  };

  if (result.ok) {
    await sb
      .from('creators')
      .update({ outreach_status: 'sent', ai_variables: aiVars })
      .eq('id', creator.id);

    await insertSendRow(sb, 'outreach_logs', {
      creator_id: creator.id,
      message_body: result.emailBody,
      subject: result.subject,
      sequence_step: 1,
      sent_at: new Date().toISOString(),
      provider: result.skipped ? 'resend-dry-run' : 'resend',
      provider_message_id: result.providerMessageId,
      webhook_events: [],
      ...(templateId ? { template_id: templateId } : {}),
    });

    return { ok: true, status: 'sent', hook: result.hook };
  }

  await sb
    .from('creators')
    .update({
      ai_variables: { ...aiVars, last_outreach_error: result.error },
    })
    .eq('id', creator.id);

  return {
    ok: false,
    status: 'queued',
    hook: result.hook,
    error: result.error,
  };
}
