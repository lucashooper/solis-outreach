import type { SupabaseClient } from '@supabase/supabase-js';
import { creatorsTowardTarget } from './campaignBatch.js';
import { discoverDemo } from './demo.js';
import { runApifyDiscovery } from './apify.js';
import {
  logDiscoveryFunnel,
  savedResultLimit,
  selectCreatorsToSave,
  wantsPublicEmail,
} from './funnel.js';
import { asDiscoverySource, relevanceCategoryIds } from './network.js';
import {
  loadRecentTagScrapes,
  loadTagStats,
  prepareDiscoveryInputs,
  recordNetworkSeedResults,
  recordNetworkSeeds,
  recordTagScrapes,
} from './networkStore.js';
import { attachSuggestedTags } from './shortfall.js';
import type { HashtagYield } from './hashtagYield.js';
import {
  classifyDiscoveryMatches,
  creatorMatchKey,
  discoveryQueryKey,
  loadKnownCreatorKeys,
  lookupKnownCreatorIds,
  readDiscoveryCache,
  writeDiscoveryCache,
} from './queryCache.js';
import type {
  Campaign,
  CreatorCandidate,
  DiscoveryFunnel,
  DiscoveryProviderName,
  DiscoveryRunResult,
} from './types.js';
import { enrichCreatorEmail, hasUsablePublicEmail } from './email.js';
import { loadNicheScoreCache, saveNicheScoreCache } from './nicheCache.js';
import {
  blankFunnel,
  cacheCoversRequest,
  classifyFunnelReason,
  logDiscovery,
} from './runOutcome.js';

/**
 * Run discovery for a campaign with the chosen provider.
 * Always attempts bio email extraction / enrichment stub on each candidate.
 * When the campaign requires a public email, creators without one are left out.
 * Otherwise they stay in the list.
 */
export async function runDiscovery(
  campaign: Campaign,
  provider: DiscoveryProviderName,
  cache?: {
    sb: SupabaseClient;
    appId?: string | null;
    includeExisting?: boolean;
    /** Qualified creators as the dataset grows. Already omits known handles when requested. */
    onPartial?: (rows: CreatorCandidate[]) => void | Promise<void>;
    /** One extra related-tag Apify pass when the first search is under the result limit. */
    aiFallback?: boolean;
    /** Hashtag yield from creators already collected. */
    onYield?: (rows: HashtagYield[]) => void | Promise<void>;
    /** Live stage line while Apify runs are still in flight. */
    onProgress?: (patch: Partial<DiscoveryFunnel>) => void | Promise<void>;
    /** Polled between actor calls. True stops the search. */
    shouldStop?: () => Promise<boolean>;
  },
): Promise<DiscoveryRunResult> {
  let result: DiscoveryRunResult;
  let fromCache = false;
  /** Handles this run inserted while streaming. The final lookup must not treat them as pre-existing. */
  const insertedThisRun = new Set<string>();
  /** Known handles seen while streaming, so profile lookup does not scrape them again. */
  const skipProfileHandles = new Set<string>();
  const queryKey = discoveryQueryKey({
    niche: (campaign.niches ?? []).join(','),
    hashtags: campaign.hashtags,
    platforms: campaign.platforms,
    followerMin: campaign.follower_min,
    followerMax: campaign.follower_max,
    limit: campaign.result_limit,
    requirePublicEmail: wantsPublicEmail(campaign.require_public_email),
    source: asDiscoverySource(campaign.discovery_source) ?? 'both',
  });

  if (provider === 'demo') {
    const candidates = discoverDemo(campaign);
    result = {
      candidates,
      provider: 'demo',
      query: {
        niches: campaign.niches,
        hashtags: campaign.hashtags ?? [],
        platforms: campaign.platforms,
        follower_min: campaign.follower_min,
        follower_max: campaign.follower_max,
        engagement_rate_min: campaign.engagement_rate_min,
        result_limit: campaign.result_limit,
      },
      raw: { source: 'demo-pool' },
    };
  } else if (provider === 'apify') {
    const cached = cache ? await readDiscoveryCache(cache.sb, queryKey) : null;
    let cachedResult: DiscoveryRunResult | null = null;
    if (cached && cache) {
      const knownNow = await lookupKnownCreatorIds(cache.sb, cache.appId, cached);
      const splitNow = classifyDiscoveryMatches(cached, knownNow);
      const requireEmailNow = wantsPublicEmail(campaign.require_public_email);
      const limitNow = savedResultLimit(campaign.result_limit);
      const freshSaved = selectCreatorsToSave(splitNow.fresh, requireEmailNow, limitNow).length;
      const minimum =
        campaign.min_creators != null && Number(campaign.min_creators) >= 1
          ? Number(campaign.min_creators)
          : null;
      const reuseCache = cacheCoversRequest({
        freshSaved,
        existing: splitNow.existing.length,
        includeExisting: cache.includeExisting === true,
        minCreators: minimum,
        aiFallback: cache.aiFallback === true,
        resultLimit: limitNow,
      });
      logDiscovery('cache', {
        hit: true,
        covers: reuseCache,
        fresh: freshSaved,
        existing: splitNow.existing.length,
        min: minimum,
        key: queryKey,
      });
      if (reuseCache) {
        fromCache = true;
        cachedResult = {
          candidates: cached,
          provider: 'apify',
          query: { cached: true, queryKey },
          raw: { source: 'cache' },
          funnel: blankFunnel({
            rawItems: 0,
            uniqueCreators: cached.length,
            afterFollowers: cached.length,
            followerMin: campaign.follower_min,
            followerMax: campaign.follower_max,
            requirePublicEmail: requireEmailNow,
            cached: true,
          }),
        };
      }
    } else if (cache) {
      logDiscovery('cache', { hit: false, key: queryKey });
    }
    if (cachedResult) {
      result = cachedResult;
    } else {
      const emitPartial = async (delta: CreatorCandidate[]) => {
        if (!cache) return;
        const known = await lookupKnownCreatorIds(cache.sb, cache.appId, delta);
        const split = classifyDiscoveryMatches(delta, known, insertedThisRun);
        for (const row of split.existing) {
          skipProfileHandles.add(creatorMatchKey(row.platform, row.handle));
        }
        for (const row of split.fresh) {
          insertedThisRun.add(creatorMatchKey(row.platform, row.handle));
        }
        const rows = [...split.fresh, ...split.existing].map((candidate) => ({
          ...candidate,
          alreadyInCrm: Boolean(candidate.creatorId) && !insertedThisRun.has(creatorMatchKey(candidate.platform, candidate.handle)),
          email: enrichCreatorEmail({
            bio: candidate.bio,
            handle: candidate.handle,
            existingEmail: candidate.email,
          }),
        }));
        if (rows.length > 0) await cache.onPartial?.(rows);
      };
      const source = asDiscoverySource(campaign.discovery_source) ?? 'both';
      const prepared = cache
        ? await prepareDiscoveryInputs(cache.sb, {
            appId: cache.appId,
            campaign,
            source,
            campaignId: campaign.id,
          })
        : null;
      const categories =
        prepared?.activeCategories ??
        relevanceCategoryIds((campaign.niches ?? []).join(' '), campaign.hashtags ?? [], {
          appName: campaign.app_name,
          valueProp: campaign.value_prop,
        });
      const nicheCache = cache
        ? await loadNicheScoreCache(cache.sb, 'tiktok', categories)
        : undefined;
      const includeCrm = cache?.includeExisting === true;
      const knownCreatorKeys =
        cache && !includeCrm ? await loadKnownCreatorKeys(cache.sb, cache.appId) : undefined;
      result = await runApifyDiscovery(campaign, {
        skipProfileHandles,
        onPartial: cache?.onPartial ? emitPartial : undefined,
        aiFallback: cache?.aiFallback === true,
        onYield: cache?.onYield,
        onProgress: cache?.onProgress,
        shouldStop: cache?.shouldStop,
        knownCreatorKeys,
        excludeKnownFromGoal: !includeCrm,
        discoverySource: source,
        networkSeeds: prepared?.seeds ?? [],
        hashtagTags: prepared?.hashtagTags,
        skippedTags: prepared?.skipped,
        blockedExpansionTags: [
          ...(campaign.hashtags ?? []),
          ...(prepared?.skipped ?? []).map((row) => row.tag),
          ...(prepared?.tagStats ?? []).filter((stat) => stat.suppressedUntil && Date.parse(stat.suppressedUntil) > Date.now()).map((stat) => stat.tag),
        ],
        relevanceTerms: prepared?.keywords,
        seedYield: prepared ? new Map(Object.entries(prepared.seedYield ?? {})) : undefined,
        nicheCache,
      });
      if (cache && nicheCache) {
        await saveNicheScoreCache(cache.sb, nicheCache, 'tiktok', categories);
      }
      if (cache?.appId && result.funnel?.network?.seedResults?.length) {
        await recordNetworkSeedResults(cache.sb, cache.appId, result.funnel.network.seedResults);
      } else if (cache?.appId && result.funnel?.network?.seeds.length && !result.funnel.network.note) {
        await recordNetworkSeeds(cache.sb, cache.appId, result.funnel.network.seeds);
      }
      if (cache?.appId && result.funnel?.triedTags?.length) {
        await recordTagScrapes(cache.sb, cache.appId, result.funnel.triedTags);
      }
    }
  } else {
    const _exhaustive: never = provider;
    throw new Error(`Unknown discovery provider: ${String(_exhaustive)}`);
  }

  const beforeOmit = result.candidates;
  let fresh: CreatorCandidate[] = beforeOmit;
  let existing: Array<CreatorCandidate & { creatorId: string }> = [];
  if (cache) {
    const known = await lookupKnownCreatorIds(cache.sb, cache.appId, beforeOmit);
    const split = classifyDiscoveryMatches(beforeOmit, known, insertedThisRun);
    fresh = split.fresh;
    existing = split.existing;
  }
  const decorate = <T extends CreatorCandidate>(row: T): T => ({
    ...row,
    email: enrichCreatorEmail({
      bio: row.bio,
      handle: row.handle,
      existingEmail: row.email,
    }),
  });
  fresh = fresh.map((row) => decorate({ ...row, alreadyInCrm: false }));
  existing = existing.map((row) => decorate({ ...row, alreadyInCrm: true, creatorId: row.creatorId }));
  const rank = (a: CreatorCandidate, b: CreatorCandidate) => {
    const email = Number(hasUsablePublicEmail(b.email)) - Number(hasUsablePublicEmail(a.email));
    if (email !== 0) return email;
    const eng = (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0);
    if (eng !== 0) return eng;
    return (b.follower_count ?? 0) - (a.follower_count ?? 0);
  };
  fresh.sort(rank);
  existing.sort(rank);
  const limit = campaign.result_limit > 0 ? campaign.result_limit : 10;
  const requireEmail = wantsPublicEmail(campaign.require_public_email);
  const visibleExisting = requireEmail
    ? existing.filter((row) => hasUsablePublicEmail(row.email))
    : existing;
  const matched = [...fresh, ...existing];
  const withEmail = matched.filter((c) => hasUsablePublicEmail(c.email)).length;
  const saved = selectCreatorsToSave(fresh, requireEmail, limit);
  const includeCrm = cache?.includeExisting === true;
  const freshQualifying = selectCreatorsToSave(fresh, requireEmail, Math.max(fresh.length, 1)).length;
  const finished = creatorsTowardTarget(freshQualifying, visibleExisting.length, includeCrm);

  if (result.funnel) {
    result.funnel = {
      ...result.funnel,
      afterDedupe: fresh.length,
      existing: visibleExisting.length,
      existingCreatorIds: visibleExisting.map((row) => row.creatorId),
      withEmail,
      saved: saved.length,
      finished,
      followerMin: campaign.follower_min,
      followerMax: campaign.follower_max,
      requirePublicEmail: requireEmail,
    };
    const currentTags = [
      ...(campaign.hashtags ?? []),
      ...(result.funnel.fallbackTags ?? []),
      ...(result.funnel.hashtagYield ?? []).map((row) => row.tag),
    ];
    const suggestionAppId = cache?.appId?.trim() || '';
    const [suggestionScrapes, suggestionStats] = suggestionAppId
      ? await Promise.all([
          loadRecentTagScrapes(cache!.sb, suggestionAppId),
          loadTagStats(cache!.sb, suggestionAppId),
        ])
      : [[], []];
    result.funnel = await attachSuggestedTags(result.funnel, {
      niche: (campaign.niches ?? []).join(' '),
      current: currentTags,
      minCreators: campaign.min_creators,
      resultLimit: campaign.result_limit,
      pitch: campaign.value_prop,
      appName: campaign.app_name,
      scrapes: suggestionScrapes,
      stats: suggestionStats,
      campaignHashtags: campaign.hashtags ?? [],
      blockedTags: [
        ...(campaign.hashtags ?? []),
        ...suggestionScrapes.map((row) => row.tag),
      ],
    });
    result.funnel = {
      ...result.funnel,
      reason: classifyFunnelReason(result.funnel),
    };
    logDiscoveryFunnel(result.funnel);
  }
  result.existingMatches = visibleExisting;

  if (cache && !fromCache && beforeOmit.length > 0) {
    await writeDiscoveryCache(cache.sb, {
      queryKey,
      appId: cache.appId,
      results: beforeOmit,
    });
  }

  result.candidates = saved;
  return result;
}
