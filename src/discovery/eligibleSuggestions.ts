import type { SupabaseClient } from '@supabase/supabase-js';
import { activeCategoryIds, isCategoryId, type CategoryId } from './categories.js';
import {
  suggestionsForFunnel,
  type EligibleSuggestions,
} from './eligibleTags.js';
import { asDiscoveryFunnel } from './funnel.js';
import {
  loadCampaignTriedTags,
  loadRecentTagScrapes,
  loadTagStats,
} from './networkStore.js';
import type { DiscoveryFunnel } from './types.js';

export interface EligibleSuggestionRead {
  statusCode: number;
  body: {
    ok: boolean;
    eligibleSuggestions: string[];
    networkOnly: boolean;
    note: string;
    error?: string;
  };
}

function categoriesFrom(funnel: DiscoveryFunnel | null, fallback: readonly CategoryId[]): CategoryId[] {
  const stored = (funnel?.activeCategories ?? []).filter(isCategoryId);
  return stored.length > 0 ? stored : [...fallback];
}

/**
 * Suggestions computed from cooldown, suppression, and this campaign.
 * The stored funnel list is not reused.
 */
export async function readEligibleSuggestions(
  sb: SupabaseClient,
  input: {
    appId?: string | null;
    campaignId?: string | null;
    campaignHashtags?: readonly string[];
    appName?: string | null;
    niche?: string | null;
    pitch?: string | null;
    funnel?: DiscoveryFunnel | null;
    now?: number;
  },
): Promise<EligibleSuggestions> {
  const appId = input.appId?.trim() || '';
  const now = input.now ?? Date.now();
  const [scrapes, stats, campaignScraped] = await Promise.all([
    appId ? loadRecentTagScrapes(sb, appId, now) : Promise.resolve([]),
    appId ? loadTagStats(sb, appId) : Promise.resolve([]),
    input.campaignId ? loadCampaignTriedTags(sb, input.campaignId, now) : Promise.resolve([]),
  ]);
  const funnel = input.funnel ?? null;
  const tried = [
    ...(funnel?.triedTags ?? []),
    ...(funnel?.fallbackTags ?? []),
    ...(funnel?.hashtagYield ?? []).map((row) => row.tag),
    ...campaignScraped,
  ];
  const categories = categoriesFrom(
    funnel,
    activeCategoryIds({
      appName: input.appName,
      valueProp: input.pitch,
      niches: input.niche ? [input.niche] : [],
      hashtags: input.campaignHashtags,
    }),
  );
  return suggestionsForFunnel({
    appName: input.appName,
    niche: input.niche,
    pitch: input.pitch,
    categories,
    expansionPlan: funnel?.expansionPlan,
    scrapes,
    stats,
    campaignHashtags: input.campaignHashtags,
    campaignScraped: [...campaignScraped, ...tried],
    tried,
    now,
  });
}

export async function stampFunnelSuggestions(
  sb: SupabaseClient,
  input: {
    appId?: string | null;
    campaignId?: string | null;
    campaignHashtags?: readonly string[];
    appName?: string | null;
    niche?: string | null;
    pitch?: string | null;
    funnel: DiscoveryFunnel | null;
  },
): Promise<DiscoveryFunnel | null> {
  if (!input.funnel) return null;
  const fresh = await readEligibleSuggestions(sb, input);
  const next: DiscoveryFunnel = {
    ...input.funnel,
    suggestedTags: fresh.tags,
    eligibleSuggestions: fresh.tags,
    expansionExhausted: fresh.networkOnly,
  };
  if (fresh.networkOnly) {
    next.networkOnly = true;
    next.suggestionNote = fresh.note;
  } else {
    delete next.networkOnly;
    delete next.suggestionNote;
  }
  if (fresh.rotation) next.categoryRotation = fresh.rotation;
  return next;
}

export async function readCampaignEligibleSuggestions(
  sb: SupabaseClient,
  campaignId: string,
): Promise<EligibleSuggestionRead> {
  const { data: campaign, error } = await sb
    .from('campaigns')
    .select('id, app_id, app_name, value_prop, niches, hashtags')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) return { statusCode: 500, body: { ok: false, eligibleSuggestions: [], networkOnly: false, note: '', error: error.message } };
  if (!campaign) {
    return { statusCode: 404, body: { ok: false, eligibleSuggestions: [], networkOnly: false, note: '', error: 'Campaign not found.' } };
  }
  const { data: run, error: runErr } = await sb
    .from('discovery_runs')
    .select('funnel')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runErr) {
    return { statusCode: 500, body: { ok: false, eligibleSuggestions: [], networkOnly: false, note: '', error: runErr.message } };
  }
  const row = campaign as {
    app_id?: string | null;
    app_name?: string | null;
    value_prop?: string | null;
    niches?: string[] | null;
    hashtags?: string[] | null;
  };
  const fresh = await readEligibleSuggestions(sb, {
    appId: typeof row.app_id === 'string' ? row.app_id : null,
    campaignId,
    campaignHashtags: row.hashtags ?? [],
    appName: row.app_name,
    niche: (row.niches ?? []).join(' '),
    pitch: row.value_prop,
    funnel: asDiscoveryFunnel(run?.funnel),
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      eligibleSuggestions: fresh.tags,
      networkOnly: fresh.networkOnly,
      note: fresh.note,
    },
  };
}
