import type { SupabaseClient } from '@supabase/supabase-js';
import { cappedSearchTerms, nicheSearchTerms } from './apify.js';
import { campaignSearchTerms, normaliseHashtags } from './hashtags.js';
import {
  asDiscoverySource,
  HIDDEN_RECHECK_DAYS,
  rankNetworkSeeds,
  relevanceCategoryIds,
  relevanceKeywords,
  SEED_COOLDOWN_DAYS,
  SEED_FOLLOWER_MAX,
  SEED_FOLLOWER_MIN,
  seedUseKey,
  type DiscoverySource,
  type SeedCreator,
  type SeedResult,
} from './network.js';
import { selectCampaignHashtags, type SkippedTag, type TagScrape } from './tagCooldown.js';
import {
  applyTagRound,
  emptyTagStat,
  isSuppressed,
  preferredSeedTags,
  type TagRound,
  type TagStat,
} from './tagMemory.js';
import type { Campaign } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PreparedDiscovery {
  source: DiscoverySource;
  seeds: string[];
  skipped: SkippedTag[];
  /** Hashtags still worth sending. Empty when every planned tag is on cooldown. */
  hashtagTags: string[];
  keywords: string[];
  activeCategories: string[];
  tagStats: TagStat[];
  /** Qualifying yield from the last time each seed was mined. */
  seedYield: Record<string, number>;
}

function plannedTags(campaign: Pick<Campaign, 'niches' | 'hashtags'>): string[] {
  const niches = (campaign.niches ?? []).map((niche) => niche.replace(/^#/, '').trim()).filter(Boolean);
  const terms = cappedSearchTerms(campaignSearchTerms(campaign, nicheSearchTerms(niches)));
  return normaliseHashtags(terms.hashtags);
}

function asSeedCreator(row: Record<string, unknown>): SeedCreator | null {
  const handle = String(row.handle ?? '').replace(/^@/, '').trim();
  if (!handle) return null;
  const vars =
    row.ai_variables && typeof row.ai_variables === 'object'
      ? (row.ai_variables as Record<string, unknown>)
      : {};
  const niches = Array.isArray(vars.niches) ? vars.niches.map((niche) => String(niche)) : [];
  const display =
    typeof vars.display_name === 'string' && vars.display_name.trim()
      ? vars.display_name.trim()
      : null;
  const discovery =
    vars.discovery && typeof vars.discovery === 'object'
      ? (vars.discovery as Record<string, unknown>)
      : null;
  const fans = Number(row.follower_count);
  return {
    handle,
    platform: String(row.platform ?? 'tiktok'),
    follower_count: Number.isFinite(fans) ? fans : null,
    bio: typeof row.bio === 'string' ? row.bio : null,
    display_name: display,
    niches,
    networkDiscovered: discovery?.source === 'network',
  };
}

export async function loadSeedCreators(
  sb: SupabaseClient,
  appId: string,
): Promise<SeedCreator[]> {
  const { data, error } = await sb
    .from('creators')
    .select('handle, platform, follower_count, bio, ai_variables')
    .eq('app_id', appId)
    .eq('platform', 'tiktok')
    .gte('follower_count', SEED_FOLLOWER_MIN)
    .lte('follower_count', SEED_FOLLOWER_MAX)
    .order('follower_count', { ascending: false })
    .limit(1000);
  if (error) {
    console.warn('[discovery] could not read network seeds:', error.message);
    return [];
  }
  return (data ?? []).flatMap((row) => {
    const creator = asSeedCreator(row as Record<string, unknown>);
    return creator ? [creator] : [];
  });
}

export interface SeedHistory {
  usedAt: Map<string, number>;
  hiddenAt: Map<string, number>;
  yieldByHandle: Map<string, { lastResultCount: number; qualifying: number }>;
}

export async function loadSeedHistory(
  sb: SupabaseClient,
  appId: string,
  now = Date.now(),
): Promise<SeedHistory> {
  const usedAt = new Map<string, number>();
  const hiddenAt = new Map<string, number>();
  const yieldByHandle = new Map<string, { lastResultCount: number; qualifying: number }>();
  const { data, error } = await sb
    .from('discovery_network_seeds')
    .select('handle, used_at, hidden, hidden_at, last_result_count, qualifying_count')
    .eq('app_id', appId);
  if (error) {
    console.warn('[discovery] could not read seed history:', error.message);
    return { usedAt, hiddenAt, yieldByHandle };
  }
  for (const row of data ?? []) {
    const handle = seedUseKey(String(row.handle ?? ''));
    if (!handle) continue;
    const used = Date.parse(String(row.used_at ?? ''));
    if (Number.isFinite(used) && now - used < SEED_COOLDOWN_DAYS * DAY_MS) {
      const prev = usedAt.get(handle);
      if (prev == null || used > prev) usedAt.set(handle, used);
    }
    const hiddenStamp = Date.parse(String(row.hidden_at ?? row.used_at ?? ''));
    if (row.hidden === true && Number.isFinite(hiddenStamp) && now - hiddenStamp < HIDDEN_RECHECK_DAYS * DAY_MS) {
      hiddenAt.set(handle, hiddenStamp);
    }
    const lastResultCount = Number(row.last_result_count);
    const qualifying = Number(row.qualifying_count);
    if (Number.isFinite(lastResultCount) || Number.isFinite(qualifying)) {
      yieldByHandle.set(handle, {
        lastResultCount: Number.isFinite(lastResultCount) ? lastResultCount : 0,
        qualifying: Number.isFinite(qualifying) ? qualifying : 0,
      });
    }
  }
  return { usedAt, hiddenAt, yieldByHandle };
}

export async function loadRecentSeedUses(
  sb: SupabaseClient,
  appId: string,
  now = Date.now(),
): Promise<Map<string, number>> {
  const history = await loadSeedHistory(sb, appId, now);
  return history.usedAt;
}

export async function recordNetworkSeeds(
  sb: SupabaseClient,
  appId: string,
  handles: readonly string[],
  now = Date.now(),
): Promise<void> {
  const used_at = new Date(now).toISOString();
  const rows = handles
    .map((handle) => handle.replace(/^@/, '').trim())
    .filter(Boolean)
    .map((handle) => ({ app_id: appId, platform: 'tiktok', handle, used_at }));
  if (rows.length === 0) return;
  const { error } = await sb.from('discovery_network_seeds').upsert(rows, {
    onConflict: 'app_id,platform,handle',
  });
  if (error) console.warn('[discovery] could not record seeds:', error.message);
}

/** Store yield and the hidden flag after a following-list batch. */
export async function recordNetworkSeedResults(
  sb: SupabaseClient,
  appId: string,
  results: readonly SeedResult[],
  now = Date.now(),
): Promise<void> {
  const used_at = new Date(now).toISOString();
  const rows = results
    .map((result) => {
      const handle = result.handle.replace(/^@/, '').trim();
      if (!handle) return null;
      return {
        app_id: appId,
        platform: 'tiktok',
        handle,
        used_at,
        hidden: result.hidden,
        hidden_at: result.hidden ? used_at : null,
        last_result_count: result.rows,
        qualifying_count: result.qualifying,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);
  if (rows.length === 0) return;
  const { error } = await sb.from('discovery_network_seeds').upsert(rows, {
    onConflict: 'app_id,platform,handle',
  });
  if (error) console.warn('[discovery] could not record seed results:', error.message);
}

function asTagStat(row: Record<string, unknown>): TagStat | null {
  const tag = normaliseHashtags([String(row.tag ?? '')])[0];
  if (!tag) return null;
  const count = (key: string) => {
    const n = Number(row[key]);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  return {
    tag,
    category: typeof row.category === 'string' && row.category.trim() ? row.category.trim() : null,
    runs: count('runs'),
    videosSampled: count('videos_sampled'),
    inRange: count('in_range'),
    withEmail: count('with_email'),
    newSaved: count('new_saved'),
    dryRounds: count('dry_rounds'),
    lastScrapedAt: typeof row.last_scraped_at === 'string' ? row.last_scraped_at : null,
    suppressedUntil: typeof row.suppressed_until === 'string' ? row.suppressed_until : null,
  };
}

export async function loadTagStats(sb: SupabaseClient, appId: string): Promise<TagStat[]> {
  const { data, error } = await sb
    .from('discovery_tag_stats')
    .select(
      'tag, category, runs, videos_sampled, in_range, with_email, new_saved, dry_rounds, last_scraped_at, suppressed_until',
    )
    .eq('app_id', appId);
  if (error) {
    console.warn('[discovery] could not read hashtag stats:', error.message);
    return [];
  }
  return (data ?? []).flatMap((row) => {
    const stat = asTagStat(row as Record<string, unknown>);
    return stat ? [stat] : [];
  });
}

/** Update tag memory after a hashtag round. Suppression is applied here. */
export async function recordTagRounds(
  sb: SupabaseClient,
  appId: string,
  rounds: readonly TagRound[],
  now = Date.now(),
): Promise<void> {
  const incoming = rounds.filter((round) => normaliseHashtags([round.tag]).length > 0);
  if (incoming.length === 0) return;
  const existing = await loadTagStats(sb, appId);
  const byTag = new Map(existing.map((stat) => [stat.tag, stat]));
  const rows = incoming.map((round) => {
    const tag = normaliseHashtags([round.tag])[0]!;
    const next = applyTagRound(byTag.get(tag) ?? emptyTagStat(tag, round.category ?? null), round, now);
    return {
      app_id: appId,
      tag: next.tag,
      category: next.category,
      runs: next.runs,
      videos_sampled: next.videosSampled,
      in_range: next.inRange,
      with_email: next.withEmail,
      new_saved: next.newSaved,
      dry_rounds: next.dryRounds,
      last_scraped_at: next.lastScrapedAt,
      suppressed_until: next.suppressedUntil,
    };
  });
  const { error } = await sb.from('discovery_tag_stats').upsert(rows, { onConflict: 'app_id,tag' });
  if (error) console.warn('[discovery] could not record hashtag stats:', error.message);
}

export async function loadRecentTagScrapes(
  sb: SupabaseClient,
  appId: string,
  now = Date.now(),
): Promise<TagScrape[]> {
  const since = new Date(now - 10 * DAY_MS).toISOString();
  const { data, error } = await sb
    .from('discovery_tag_scrapes')
    .select('tag, scraped_at')
    .eq('app_id', appId)
    .gte('scraped_at', since);
  if (error) {
    console.warn('[discovery] could not read hashtag history:', error.message);
    return [];
  }
  return (data ?? []).flatMap((row) => {
    const tag = String(row.tag ?? '');
    const scrapedAt = String(row.scraped_at ?? '');
    return tag && scrapedAt ? [{ tag, scrapedAt }] : [];
  });
}

export async function recordTagScrapes(
  sb: SupabaseClient,
  appId: string,
  tags: readonly string[],
  now = Date.now(),
): Promise<void> {
  const scraped_at = new Date(now).toISOString();
  const rows = normaliseHashtags(tags).map((tag) => ({
    app_id: appId,
    tag,
    scraped_at,
  }));
  if (rows.length === 0) return;
  const { error } = await sb.from('discovery_tag_scrapes').upsert(rows, {
    onConflict: 'app_id,tag',
  });
  if (error) console.warn('[discovery] could not record hashtags:', error.message);
}

/**
 * Seeds and the hashtags still allowed for this app.
 * Custom tags in `allowTags` skip the 10-day cooldown.
 */
export async function prepareDiscoveryInputs(
  sb: SupabaseClient,
  input: {
    appId?: string | null;
    campaign: Pick<
      Campaign,
      | 'niches'
      | 'hashtags'
      | 'platforms'
      | 'result_limit'
      | 'min_creators'
      | 'discovery_source'
      | 'app_name'
      | 'value_prop'
      | 'follower_min'
      | 'follower_max'
    >;
    source?: DiscoverySource | null;
    allowTags?: readonly string[];
    /** When set, a tag this campaign already scraped stays on cooldown. Other campaigns do not. */
    campaignId?: string | null;
    now?: number;
  },
): Promise<PreparedDiscovery> {
  const source =
    input.source ??
    asDiscoverySource(input.campaign.discovery_source) ??
    'both';
  const niche = (input.campaign.niches ?? []).join(' ');
  const hashtags = input.campaign.hashtags ?? [];
  const appContext = {
    appName: input.campaign.app_name,
    valueProp: input.campaign.value_prop,
  };
  const activeCategories = relevanceCategoryIds(niche, hashtags, appContext);
  const keywords = relevanceKeywords(niche, hashtags, appContext);
  const planned = plannedTags(input.campaign);
  const appId = input.appId?.trim() || '';
  let seeds: string[] = [];
  let history: TagScrape[] = [];
  let tagStats: TagStat[] = [];
  const seedYield: Record<string, number> = {};
  let campaignRecent: string[] = [];
  const wantsNetwork =
    (source === 'network' || source === 'both') &&
    (input.campaign.platforms ?? []).some((platform) => platform.toLowerCase() === 'tiktok');
  if (appId) {
    const [scrapes, stats] = await Promise.all([
      loadRecentTagScrapes(sb, appId, input.now),
      loadTagStats(sb, appId),
    ]);
    history = scrapes;
    tagStats = stats;
    if (wantsNetwork) {
      const [creators, seedHistory] = await Promise.all([
        loadSeedCreators(sb, appId),
        loadSeedHistory(sb, appId, input.now),
      ]);
      const withYield = creators.map((creator) => {
        const yieldRow = seedHistory.yieldByHandle.get(creator.handle.replace(/^@/, '').trim().toLowerCase());
        return yieldRow
          ? {
              ...creator,
              lastResultCount: yieldRow.lastResultCount,
              qualifyingCount: yieldRow.qualifying,
            }
          : creator;
      });
      for (const [handle, yieldRow] of seedHistory.yieldByHandle) {
        if (yieldRow.qualifying > 0) seedYield[handle] = yieldRow.qualifying;
      }
      seeds = rankNetworkSeeds({
        creators: withYield,
        usedAt: seedHistory.usedAt,
        hiddenAt: seedHistory.hiddenAt,
        now: input.now,
        keywords,
        followerMin: input.campaign.follower_min,
        followerMax: input.campaign.follower_max,
        limit: 500,
      });
    }
  }
  const campaignId = input.campaignId?.trim() || '';
  if (campaignId) {
    campaignRecent = await loadCampaignTriedTags(sb, campaignId, input.now);
  }
  const explicit = normaliseHashtags([
    ...(input.campaign.hashtags ?? []),
    ...(input.allowTags ?? []),
  ]);
  const cooled = selectCampaignHashtags({
    explicit,
    planned,
    appHistory: history,
    campaignRecent,
    now: input.now,
  });
  let hashtagTags = cooled.tags;
  if (hashtagTags.length === 0) {
    const blocked = [
      ...history.map((row) => row.tag),
      ...tagStats.filter((stat) => isSuppressed(stat, input.now)).map((stat) => stat.tag),
    ];
    hashtagTags = preferredSeedTags({
      categories: activeCategories,
      stats: tagStats,
      blocked,
      now: input.now,
      limit: 2,
    });
  }
  return {
    source,
    seeds,
    skipped: cooled.skipped,
    hashtagTags,
    keywords,
    activeCategories,
    tagStats,
    seedYield,
  };
}

/** Tags this campaign already sent to Apify inside the cooldown window. */
export async function loadCampaignTriedTags(
  sb: SupabaseClient,
  campaignId: string,
  now = Date.now(),
): Promise<string[]> {
  const since = new Date(now - 10 * DAY_MS).toISOString();
  const { data, error } = await sb
    .from('discovery_jobs')
    .select('funnel, created_at')
    .eq('campaign_id', campaignId)
    .gte('created_at', since);
  if (error) {
    if (!/campaign_id/i.test(error.message)) {
      console.warn('[discovery] could not read this campaign’s hashtags:', error.message);
    }
    return [];
  }
  const tags: string[] = [];
  for (const row of data ?? []) {
    const funnel = row.funnel;
    if (!funnel || typeof funnel !== 'object') continue;
    const tried = (funnel as { triedTags?: unknown }).triedTags;
    if (!Array.isArray(tried)) continue;
    tags.push(...tried.map((tag) => String(tag)));
  }
  return normaliseHashtags(tags);
}
