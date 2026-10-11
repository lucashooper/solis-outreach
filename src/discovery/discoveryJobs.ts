/**
 * Async Apify discovery for the admin.
 * Start returns as soon as the actor run exists so a Netlify function
 * stays inside its timeout. The client polls until the dataset is ready.
 * Candidates are only those returned by Apify — nothing is fabricated.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  actorForPlatform,
  buildApifyActorInput,
  buildProfileEnrichInput,
  buildFallbackActorInput,
  buildTopUpActorInput,
  fetchApifyDatasetItems,
  followersActorId,
  formatApifyRunStatus,
  controlsForActorInput,
  getApifyActorRun,
  handlesMissingEmail,
  rawItemTarget,
  startApifyActorRun,
} from './apify.js';
import {
  discoveryRunBudgetUsd,
  fitsRunBudget,
  monthlyLimitMessage,
  networkPhaseBudgetUsd,
  planNetworkBatch,
  roundUsd,
} from './budget.js';
import { actualRunChargeUsd } from './charge.js';
import {
  ALL_ACCOUNTS_EXHAUSTED_MESSAGE,
  apifyConfigured,
  createApifyPool,
  summariseAccountSpend,
  type ApifyPool,
  type ApifyRoundSpend,
  resolveRunBudget,
} from './apifyPool.js';
import { ensureRuntimeSecrets } from '../config/runtimeSecrets.js';
import { isCategoryId } from './categories.js';
import { mapApifyDatasetItems, mergeProfileEmails } from './apifyParsers.js';
import { enrichCreatorEmail, hasUsablePublicEmail } from './email.js';
import { mergeCandidate, qualifyCandidates } from './qualify.js';
import {
  buildExpansionTiers,
  expansionResultMessage,
  expansionRoundLabel,
  EXPANSION_ROUNDS_PER_CLICK,
  parseCustomHashtags,
  planNextRound,
  shouldChainRound,
  type ExpansionTierIndex,
} from './expansionTiers.js';
import { suggestFallbackHashtags } from './fallbackTags.js';
import { normaliseHashtags } from './hashtags.js';
import { sampleCountsForTags, scoreHashtagYield, type HashtagYield } from './hashtagYield.js';
import {
  asDiscoveryFunnel,
  discoveryFunnelMessage,
  logDiscoveryFunnel,
  profileEnrichEnabled,
  RESULT_LIMIT_MAX,
  savedResultLimit,
  selectCreatorsToSave,
  showFunnelExplanation,
  wantsPublicEmail,
} from './funnel.js';
import {
  asDiscoverySource,
  buildFollowersActorInput,
  emptyNetworkStats,
  filterNetworkBatch,
  mergeNetworkStats,
  planFollowUpNetworkBatch,
  relevanceKeywords,
  type DiscoverySource,
  type NetworkFunnelStats,
} from './network.js';
import {
  loadRecentTagScrapes,
  loadTagStats,
  prepareDiscoveryInputs,
  recordNetworkSeedResults,
  recordNetworkSeeds,
  recordTagRounds,
  recordTagScrapes,
} from './networkStore.js';
import { creatorsTowardTarget } from './campaignBatch.js';
import { selectExpansionTags } from './tagMemory.js';
import { chooseExpansionTags, NO_ELIGIBLE_TAGS_NOTE } from './eligibleTags.js';
import { stampFunnelSuggestions } from './eligibleSuggestions.js';
import type { SkippedTag } from './tagCooldown.js';
import { attachSuggestedTags, takeContinueTags } from './shortfall.js';
import {
  blankFunnel,
  cacheCoversRequest,
  classifyFunnelReason,
  discoveryOutcomeCopy,
  logDiscovery,
} from './runOutcome.js';
import {
  classifyDiscoveryMatches,
  discoveryQueryKey,
  lookupKnownCreatorIds,
  readDiscoveryCache,
  writeDiscoveryCache,
} from './queryCache.js';
import type { Campaign, CreatorCandidate, DiscoveryFunnel } from './types.js';
import type { Platform } from '../types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

export const DISCOVERY_UNCONFIGURED =
  'Discovery is not configured on this deployment. Add APIFY_TOKEN to the server environment. No sample creators are shown.';

export interface DiscoveryHit {
  handle: string;
  platform: Platform;
  bio: string;
  email: string | null;
  follower_count: number;
  engagement_rate: number | null;
  profile_url: string;
  avatar_url: string | null;
  display_name?: string | null;
  discovery_source?: 'network' | 'hashtag';
  discovery_seed?: string | null;
  /** True when this handle was already stored for the app. */
  existing?: boolean;
  creatorId?: string;
}

export interface DiscoveryJobResult {
  statusCode: number;
  body: Record<string, unknown>;
}

interface StoredRun {
  platform: Platform;
  actorId: string;
  runId: string;
  datasetId: string | null;
  status: string;
  statusMessage?: string | null;
  topUp?: boolean;
  profileEnrich?: boolean;
  /** Hashtags this run actually sent to Apify. */
  tags?: string[];
  /** The one extra related-tag search. A failure here does not fail the job. */
  fallback?: boolean;
  fallbackSource?: 'ai' | 'niche';
  /** Started from the shortfall sheet. Not the automatic page or AI fallback. */
  userContinue?: boolean;
  /** Following-list run. A failure here can fall through to hashtags. */
  network?: boolean;
  seeds?: string[];
  /** maxTotalChargeUsd authorised for this call. */
  chargeUsd?: number;
  /** 1-based Apify account that started this run. Later reads must use it. */
  accountIndex?: number;
  /** "Apify account 1/2". Never a token. */
  accountLabel?: string;
  maxItems?: number;
  /** Following-list yield has been written to discovery_network_seeds. */
  seedsRecorded?: boolean;
  /** Hashtag yield has been written to discovery_tag_stats. */
  statsRecorded?: boolean;
  itemCount?: number;
  /** Qualifying creators before this fallback run. Used to see if the round added anyone. */
  baselineSaved?: number;
  expansionTier?: ExpansionTierIndex;
}

function createJobPool(
  options?: { token?: string; fetchImpl?: typeof fetch },
  state?: { exhausted?: number[]; runs?: StoredRun[] },
): ApifyPool {
  return createApifyPool({
    tokens: options?.token != null ? [options.token] : undefined,
    fetchImpl: options?.fetchImpl,
    exhausted: state?.exhausted,
    bindings: (state?.runs ?? [])
      .filter((run) => run.accountIndex && run.accountIndex >= 1)
      .map((run) => ({
        runId: run.runId,
        datasetId: run.datasetId,
        accountIndex: run.accountIndex as number,
      })),
  });
}

function accountOnRun(started: {
  accountIndex: number;
  accountLabel: string;
  chargeUsd: number;
}): Pick<StoredRun, 'accountIndex' | 'accountLabel' | 'chargeUsd'> {
  return {
    accountIndex: started.accountIndex,
    accountLabel: started.accountLabel,
    chargeUsd: started.chargeUsd,
  };
}

function roundKind(run: StoredRun): string {
  if (run.network) return 'network';
  if (run.profileEnrich) return 'profile';
  if (run.fallback || run.userContinue) return 'expand';
  return 'hashtag';
}

function accountFunnelFields(pool: ApifyPool, runs: StoredRun[]): Partial<DiscoveryFunnel> {
  const rounds: ApifyRoundSpend[] = [];
  for (const run of runs) {
    if (!run.accountIndex || !run.accountLabel) continue;
    rounds.push({
      accountIndex: run.accountIndex,
      accountLabel: run.accountLabel,
      chargeUsd: Number(run.chargeUsd) || 0,
      runId: run.runId,
      kind: roundKind(run),
    });
  }
  const spent = summariseAccountSpend(rounds);
  const exhausted = pool.exhaustedIndexes();
  return {
    ...(rounds.length > 0 ? { apifyRounds: rounds, apifyAccounts: spent } : {}),
    ...(exhausted.length > 0 ? { apifyExhausted: exhausted } : {}),
  };
}

function creditNote(message: string): string {
  return monthlyLimitMessage(message) ? ALL_ACCOUNTS_EXHAUSTED_MESSAGE : message;
}

function tagsFromActorInput(input: Record<string, unknown>): string[] {
  if (Array.isArray(input.hashtags)) return normaliseHashtags(input.hashtags.map((tag) => String(tag)));
  if (typeof input.search === 'string') return normaliseHashtags([input.search]);
  return [];
}

function queriedTags(runs: StoredRun[]): string[] {
  return normaliseHashtags(
    runs
      .filter((run) => !run.profileEnrich && (!run.fallback || run.status === 'SUCCEEDED'))
      .flatMap((run) => run.tags ?? []),
  );
}

function asMinCreators(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return savedResultLimit(n);
}

/**
 * Bracket access on purpose. Netlify's function bundler replaces
 * `process.env.APIFY_TOKEN` with the value from the build shell. A deploy
 * whose shell does not have the token would freeze an empty string into the
 * zip, so the live function keeps saying it is unconfigured even after the
 * site variable exists. A computed key is read from the function runtime.
 */
export function readServerEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function discoveryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return apifyConfigured(env);
}

export function filterDiscoveryCandidates(
  candidates: CreatorCandidate[],
  opts: {
    followerMin: number | null;
    followerMax: number | null;
    limit: number;
  },
): CreatorCandidate[] {
  const dedup = new Map<string, CreatorCandidate>();
  for (const candidate of candidates) {
    const handle = candidate.handle?.trim();
    if (!handle) continue;
    const key = `${candidate.platform}:${handle.toLowerCase()}`;
    const prev = dedup.get(key);
    const next = { ...candidate, handle };
    dedup.set(key, prev ? mergeCandidate(prev, next) : next);
  }

  let list = [...dedup.values()];
  if (opts.followerMin != null) {
    list = list.filter((c) => (c.follower_count ?? 0) >= opts.followerMin!);
  }
  if (opts.followerMax != null) {
    list = list.filter((c) => (c.follower_count ?? 0) <= opts.followerMax!);
  }
  list.sort((a, b) => (b.follower_count ?? 0) - (a.follower_count ?? 0));
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 20;
  return list.slice(0, limit);
}

function candidateHasPublicEmail(candidate: CreatorCandidate): boolean {
  return hasUsablePublicEmail(
    enrichCreatorEmail({
      bio: candidate.bio,
      handle: candidate.handle,
      existingEmail: candidate.email,
    }),
  );
}

function toHit(candidate: CreatorCandidate): DiscoveryHit {
  const email = enrichCreatorEmail({
    bio: candidate.bio,
    handle: candidate.handle,
    existingEmail: candidate.email,
  });
  return {
    handle: candidate.handle,
    platform: candidate.platform,
    bio: (candidate.bio || '').slice(0, 280),
    email,
    follower_count: candidate.follower_count ?? 0,
    engagement_rate: candidate.engagement_rate,
    profile_url: candidate.profile_url,
    avatar_url: candidate.avatar_url ?? null,
    ...(candidate.display_name ? { display_name: candidate.display_name } : {}),
    ...(candidate.discovery_source ? { discovery_source: candidate.discovery_source } : {}),
    ...(candidate.discovery_seed ? { discovery_seed: candidate.discovery_seed } : {}),
    ...(candidate.alreadyInCrm && candidate.creatorId
      ? { existing: true, creatorId: candidate.creatorId }
      : {}),
  };
}

/** New creators, capped, plus every in-range creator already in the CRM. */
async function partitionDiscoveryHits(
  sb: SupabaseClient,
  appId: string | null | undefined,
  inRange: CreatorCandidate[],
  requireEmail: boolean,
  resultLimit: number,
): Promise<{
  fresh: CreatorCandidate[];
  existing: Array<CreatorCandidate & { creatorId: string }>;
  hits: DiscoveryHit[];
}> {
  const known = await lookupKnownCreatorIds(sb, appId, inRange);
  const split = classifyDiscoveryMatches(inRange, known);
  const existing = split.existing.map((row) => ({ ...row, alreadyInCrm: true as const }));
  const freshHits = selectCreatorsToSave(split.fresh.map(toHit), requireEmail, resultLimit);
  const existingHits = existing
    .map(toHit)
    .filter((hit) => !requireEmail || hasUsablePublicEmail(hit.email));
  const shownExisting = existing.filter((row) =>
    existingHits.some((hit) => hit.creatorId === row.creatorId),
  );
  return { fresh: split.fresh, existing: shownExisting, hits: [...freshHits, ...existingHits] };
}

function asPlatforms(value: unknown): Platform[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: Platform[] = [];
  for (const item of value) {
    const p = String(item).trim().toLowerCase();
    if (p !== 'tiktok' && p !== 'instagram') return null;
    if (!out.includes(p)) out.push(p);
  }
  return out.length ? out : null;
}

function asBound(value: unknown): number | null | 'invalid' {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 50_000_000) return 'invalid';
  return Math.round(n);
}

export async function startDiscoveryJob(
  sb: SupabaseClient,
  body: unknown,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<DiscoveryJobResult> {
  await ensureRuntimeSecrets();
  const pool = createJobPool(options);
  if (!pool.configured) {
    return { statusCode: 503, body: { ok: false, configured: false, error: DISCOVERY_UNCONFIGURED } };
  }

  const input = (body ?? {}) as Record<string, unknown>;
  const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
  if (!UUID_RE.test(appId)) {
    return { statusCode: 400, body: { ok: false, error: 'Choose an app before searching.' } };
  }
  const niche = typeof input.niche === 'string' ? input.niche.trim() : '';
  if (!niche || niche.length > 80) {
    return { statusCode: 400, body: { ok: false, error: 'Enter a niche of up to 80 characters.' } };
  }
  const platforms = asPlatforms(input.platforms);
  if (!platforms) {
    return {
      statusCode: 400,
      body: { ok: false, error: 'Choose TikTok, Instagram, or both.' },
    };
  }
  const followerMin = asBound(input.followerMin);
  const followerMax = asBound(input.followerMax);
  if (followerMin === 'invalid' || followerMax === 'invalid') {
    return { statusCode: 400, body: { ok: false, error: 'Follower range must be a positive number.' } };
  }
  if (followerMin != null && followerMax != null && followerMin > followerMax) {
    return {
      statusCode: 400,
      body: { ok: false, error: 'Minimum followers cannot be higher than the maximum.' },
    };
  }
  const requestedLimit = Number(input.resultLimit ?? 10);
  const resultLimit = savedResultLimit(requestedLimit);
  const minCreators = asMinCreators(input.minCreators);
  const hashtags = Array.isArray(input.hashtags)
    ? input.hashtags.map((tag) => String(tag)).filter(Boolean).slice(0, 12)
    : [];
  const includeExisting = input.includeExisting === true;
  const aiFallback = input.aiFallback === true;
  const requireEmail = wantsPublicEmail(
    typeof input.requirePublicEmail === 'boolean' ? input.requirePublicEmail : true,
  );

  const source = asDiscoverySource(input.discoverySource) ?? 'both';
  const { data: appRow } = await sb.from('apps').select('name, value_prop').eq('id', appId).maybeSingle();
  const synthetic = {
    niches: [niche],
    hashtags,
    platforms,
    result_limit: resultLimit,
    follower_min: followerMin,
    follower_max: followerMax,
    engagement_rate_min: null,
    require_public_email: requireEmail,
    discovery_source: source,
    app_name: typeof appRow?.name === 'string' ? appRow.name : null,
    value_prop: typeof appRow?.value_prop === 'string' ? appRow.value_prop : null,
  } as Campaign;

  const queryKey = discoveryQueryKey({
    niche,
    hashtags,
    platforms,
    followerMin,
    followerMax,
    limit: resultLimit,
    requirePublicEmail: requireEmail,
    source,
  });
  const cached = await readDiscoveryCache(sb, queryKey);
  if (cached) {
    const partitioned = await partitionDiscoveryHits(sb, appId, cached, requireEmail, resultLimit);
    const hits = partitioned.hits;
    const freshSaved = hits.filter((hit) => !hit.existing).length;
    const cacheCoversMinimum = cacheCoversRequest({
      freshSaved,
      existing: partitioned.existing.length,
      includeExisting,
      minCreators,
      aiFallback,
      resultLimit,
    });
    logDiscovery('cache', {
      hit: true,
      covers: cacheCoversMinimum,
      fresh: freshSaved,
      existing: partitioned.existing.length,
      min: minCreators,
    });
    if (!cacheCoversMinimum) {
      /* A short cached list should not block a new Apify search. */
    } else {
      const funnel = blankFunnel({
        rawItems: 0,
        uniqueCreators: cached.length,
        afterFollowers: cached.length,
        afterDedupe: partitioned.fresh.length,
        withEmail: hits.filter((hit) => Boolean(hit.email)).length,
        saved: freshSaved,
        existing: partitioned.existing.length,
        existingCreatorIds: partitioned.existing.map((row) => row.creatorId),
        finished: creatorsTowardTarget(freshSaved, partitioned.existing.length, includeExisting),
        followerMin,
        followerMax,
        requirePublicEmail: requireEmail,
        cached: true,
      });
      funnel.reason = classifyFunnelReason(funnel);
      const copy = discoveryOutcomeCopy(funnel.reason, funnel);
      const { data, error } = await sb
        .from('discovery_jobs')
        .insert({
          app_id: appId,
          niche,
          platforms,
          follower_min: followerMin,
          follower_max: followerMax,
          result_limit: resultLimit,
          hashtags,
          include_existing: includeExisting,
          require_public_email: requireEmail,
          min_creators: minCreators,
          ai_fallback: aiFallback,
          discovery_source: source,
          status: 'succeeded',
          runs: [],
          results: hits,
          funnel,
          error: null,
        })
        .select('id')
        .single();
      if (error || !data) {
        return {
          statusCode: 500,
          body: { ok: false, error: error?.message || 'Could not record the cached search.' },
        };
      }
      logDiscovery('done', {
        job: data.id,
        status: 'succeeded',
        reason: funnel.reason,
        cached: true,
        saved: freshSaved,
        existing: partitioned.existing.length,
      });
      return {
        statusCode: 202,
        body: {
          ok: true,
          jobId: data.id,
          status: 'succeeded',
          cached: true,
          candidates: hits,
          funnel,
          reason: funnel.reason,
          message: copy?.title ?? 'Using a search from the last 24 hours.',
        },
      };
    }
  }

  const runs: StoredRun[] = [];
  const prepared = await prepareDiscoveryInputs(sb, {
    appId,
    campaign: synthetic,
    source,
  });
  const budget = await resolveRunBudget({ pool, fetchImpl: options?.fetchImpl });
  let networkNote: NetworkFunnelStats | null = null;
  let networkQueue = [...prepared.seeds];
  let runBudgetNote = budget.note;
  logDiscovery('start', {
    niche,
    platforms: platforms.join(','),
    min: minCreators,
    limit: resultLimit,
    requireEmail,
    source,
    seeds: prepared.seeds.length,
    budget: budget.budgetUsd,
  });
  const tiktok = platforms.includes('tiktok');
  if ((source === 'network' || source === 'both') && tiktok) {
    if (budget.budgetUsd <= 0) {
      networkNote = emptyNetworkStats(budget.note || ALL_ACCOUNTS_EXHAUSTED_MESSAGE);
    } else if (prepared.seeds.length === 0) {
      networkNote = emptyNetworkStats(
        'No creator-network seeds in the CRM for this app yet. Searched hashtags instead.',
      );
    } else {
      const networkBudget =
        source === 'both' ? networkPhaseBudgetUsd(budget.budgetUsd, 'both') : budget.budgetUsd;
      const batch = planNetworkBatch({
        seeds: prepared.seeds,
        budgetUsd: networkBudget,
        yieldBySeed: new Map(
          Object.entries(prepared.seedYield ?? {}).map(([handle, count]) => [handle.toLowerCase(), count]),
        ),
      });
      const networkInput = batch
        ? buildFollowersActorInput(batch.seeds, batch.maxFollowingPerProfile)
        : null;
      const networkActor = followersActorId();
      if (networkInput && batch) {
        networkInput.chargeCapUsd = batch.maxTotalChargeUsd;
        try {
          const started = await startApifyActorRun(networkActor, networkInput, { pool });
          const taken = new Set(batch.seeds.map((seed) => seed.toLowerCase()));
          networkQueue = prepared.seeds.filter((seed) => !taken.has(seed.toLowerCase()));
          runs.push({
            platform: 'tiktok',
            actorId: networkActor,
            runId: started.runId,
            datasetId: started.datasetId,
            status: started.status,
            network: true,
            seeds: batch.seeds,
            maxItems: batch.maxItems,
            ...accountOnRun(started),
          });
          await recordNetworkSeeds(sb, appId, batch.seeds);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Creator network did not start.';
          const note = creditNote(message);
          networkNote = emptyNetworkStats(note, batch.seeds);
          if (source === 'network') {
            return { statusCode: 502, body: { ok: false, error: note } };
          }
        }
      }
    }
  }
  const networkStarted = runs.some((run) => run.network);
  const startHashtagsNow = !networkStarted;
  if (startHashtagsNow) {
    if (prepared.hashtagTags.length === 0) {
      const reason = prepared.skipped.length > 0 ? 'tags_on_cooldown' : 'no_search_terms';
      const funnel = blankFunnel({
        reason,
        followerMin,
        followerMax,
        requirePublicEmail: requireEmail,
        discoverySource: source,
        ...(prepared.skipped.length > 0 ? { skippedTags: prepared.skipped } : {}),
        ...(networkNote ? { network: networkNote } : {}),
      });
      const copy = discoveryOutcomeCopy(reason, funnel);
      const { data, error } = await sb
        .from('discovery_jobs')
        .insert({
          app_id: appId,
          niche,
          platforms,
          follower_min: followerMin,
          follower_max: followerMax,
          result_limit: resultLimit,
          hashtags,
          include_existing: includeExisting,
          require_public_email: requireEmail,
          min_creators: minCreators,
          ai_fallback: aiFallback,
          discovery_source: source,
          status: 'succeeded',
          runs: [],
          results: [],
          funnel,
          error: null,
        })
        .select('id')
        .single();
      if (error || !data) {
        return {
          statusCode: 500,
          body: { ok: false, error: error?.message || 'Could not record the search.' },
        };
      }
      return {
        statusCode: 202,
        body: {
          ok: true,
          jobId: data.id,
          status: 'succeeded',
          candidates: [],
          funnel,
          reason,
          message: copy?.title ?? discoveryFunnelMessage(funnel),
        },
      };
    }
    try {
      const tagged = { ...synthetic, hashtags: prepared.hashtagTags } as Campaign;
      for (const platform of platforms) {
        const actorId = actorForPlatform(platform, {});
        const spent = runs.reduce((sum, run) => sum + (run.chargeUsd ?? 0), 0);
        const remaining = roundUsd(Math.max(0, budget.budgetUsd - spent));
        const actorInput = buildApifyActorInput(tagged, platform, {
          keepExplicitHashtags: true,
          hashtagBudgetUsd: remaining,
        });
        const charge = Math.min(controlsForActorInput(actorInput).maxTotalChargeUsd, remaining);
        if (!fitsRunBudget(spent, charge, budget.budgetUsd)) {
          runBudgetNote = `Run budget of $${budget.budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`;
          break;
        }
        const started = await startApifyActorRun(actorId, actorInput, { pool });
        const tags = tagsFromActorInput(actorInput);
        runs.push({
          platform,
          actorId,
          runId: started.runId,
          datasetId: started.datasetId,
          status: started.status,
          tags,
          ...accountOnRun(started),
        });
        await recordTagScrapes(sb, appId, tags);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Apify did not start the search.';
      return { statusCode: 502, body: { ok: false, error: message } };
    }
  }

  const { data, error } = await sb
    .from('discovery_jobs')
    .insert({
      app_id: appId,
      niche,
      platforms,
      follower_min: followerMin,
      follower_max: followerMax,
      result_limit: resultLimit,
      hashtags,
      include_existing: includeExisting,
      require_public_email: requireEmail,
          min_creators: minCreators,
          ai_fallback: aiFallback,
          discovery_source: source,
          status: 'running',
          runs,
          funnel: {
            rawItems: 0,
            uniqueCreators: 0,
            afterFollowers: 0,
            afterDedupe: 0,
            withEmail: 0,
            saved: 0,
            followerMin,
            followerMax,
            apifyRunIds: [],
            requirePublicEmail: requireEmail,
            discoverySource: source,
            runBudgetUsd: budget.budgetUsd,
            runSpentUsd: runs.reduce((sum, run) => sum + (run.chargeUsd ?? 0), 0),
            ...accountFunnelFields(pool, runs),
            ...(runBudgetNote ? { runBudgetNote } : {}),
            ...(networkQueue.length > 0 ? { networkQueue } : {}),
            relevanceTerms: prepared.keywords,
            activeCategories: prepared.activeCategories,
            ...(prepared.skipped.length > 0 ? { skippedTags: prepared.skipped } : {}),
            ...(networkNote ? { network: networkNote } : {}),
          },
        })
    .select('id')
    .single();

  if (error || !data) {
    return {
      statusCode: 500,
      body: { ok: false, error: error?.message || 'Could not record the discovery search.' },
    };
  }

  return {
    statusCode: 202,
    body: {
      ok: true,
      jobId: data.id,
      status: 'running',
      message: networkStarted ? 'Reading following lists…' : 'Querying Apify hashtags…',
    },
  };
}

/** Creators already in the dataset while the actor is still running. */
async function loadRunningCandidates(
  sb: SupabaseClient,
  job: {
    niche?: string | null;
    follower_min?: number | null;
    follower_max?: number | null;
    result_limit?: number | null;
    require_public_email?: boolean | null;
    include_existing?: boolean | null;
    app_id?: string | null;
  },
  runs: StoredRun[],
  pool: ApifyPool,
): Promise<{ hits: DiscoveryHit[]; hashtagYield: HashtagYield[] }> {
  let collected: CreatorCandidate[] = [];
  const requireEmail = wantsPublicEmail(job.require_public_email !== false);
  const fetchLimit = rawItemTarget(Number(job.result_limit) || 10, requireEmail);
  for (const run of runs) {
    if (!run.datasetId) continue;
    try {
      const items = await fetchApifyDatasetItems(run.datasetId, {
        pool,
        accountIndex: run.accountIndex,
        limit: fetchLimit,
      });
      if (run.profileEnrich) {
        collected = mergeProfileEmails(collected, items, run.platform);
      } else if (run.network) {
        const filtered = filterNetworkBatch({
          rows: items,
          seeds: run.seeds ?? [],
          followerMin: job.follower_min != null ? Number(job.follower_min) : null,
          followerMax: job.follower_max != null ? Number(job.follower_max) : null,
          requireEmail: false,
          keywords: relevanceKeywords(String(job.niche || ''), []),
          niches: [String(job.niche || '')],
          includeInRange: true,
        });
        collected.push(...(filtered.inRangeCreators ?? [...filtered.creators, ...filtered.existing]));
      } else {
        collected.push(...mapApifyDatasetItems(items, run.platform, [String(job.niche || '')]));
      }
    } catch {
      /* Dataset is not readable until the actor writes a row. */
    }
  }
  if (collected.length === 0) return { hits: [], hashtagYield: [] };
  const followerMin = job.follower_min != null ? Number(job.follower_min) : null;
  const followerMax = job.follower_max != null ? Number(job.follower_max) : null;
  const qualified = await qualifyCandidates(collected, {
    followerMin,
    followerMax,
    keywords: relevanceKeywords(String(job.niche || ''), []),
    categories: [],
  });
  collected = qualified.kept;
  const inRange = filterDiscoveryCandidates(collected, {
    followerMin,
    followerMax,
    limit: Math.max(collected.length, 1),
  });
  const partitioned = await partitionDiscoveryHits(
    sb,
    job.app_id ?? null,
    inRange,
    requireEmail,
    savedResultLimit(Number(job.result_limit) || 10),
  );
  return {
    hits: partitioned.hits,
    hashtagYield: scoreHashtagYield(queriedTags(runs), inRange, requireEmail),
  };
}

async function beginHashtagPhase(input: {
  sb: SupabaseClient;
  appId: string;
  niche: string;
  hashtags: string[];
  platforms: Platform[];
  resultLimit: number;
  requireEmail: boolean;
  pool: ApifyPool;
  allowTags?: string[];
  budgetUsd?: number;
  spentUsd?: number;
}): Promise<{ runs: StoredRun[]; skipped: SkippedTag[]; note?: string }> {
  const prepared = await prepareDiscoveryInputs(input.sb, {
    appId: input.appId,
    campaign: {
      niches: [input.niche],
      hashtags: input.hashtags,
      platforms: input.platforms,
      result_limit: input.resultLimit,
      require_public_email: input.requireEmail,
    } as Campaign,
    source: 'hashtags',
    allowTags: input.allowTags,
  });
  const runs: StoredRun[] = [];
  if (prepared.hashtagTags.length === 0) return { runs, skipped: prepared.skipped };
  let spent = input.spentUsd ?? 0;
  const budgetUsd = input.budgetUsd;
  const tagged = {
    niches: [input.niche],
    hashtags: prepared.hashtagTags,
    platforms: input.platforms,
    result_limit: input.resultLimit,
    require_public_email: input.requireEmail,
    follower_min: null,
    follower_max: null,
    engagement_rate_min: null,
  } as Campaign;
  for (const platform of input.platforms) {
    const actorId = actorForPlatform(platform, {});
    const remaining = budgetUsd == null ? undefined : roundUsd(Math.max(0, budgetUsd - spent));
    const actorInput = buildApifyActorInput(tagged, platform, {
      keepExplicitHashtags: true,
      ...(remaining != null ? { hashtagBudgetUsd: remaining } : {}),
    });
    const charge = Math.min(
      controlsForActorInput(actorInput).maxTotalChargeUsd,
      remaining ?? controlsForActorInput(actorInput).maxTotalChargeUsd,
    );
    if (budgetUsd != null && !fitsRunBudget(spent, charge, budgetUsd)) {
      return {
        runs,
        skipped: prepared.skipped,
        note: `Run budget of $${budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`,
      };
    }
    const started = await startApifyActorRun(actorId, actorInput, { pool: input.pool });
    const tags = tagsFromActorInput(actorInput);
    runs.push({
      platform,
      actorId,
      runId: started.runId,
      datasetId: started.datasetId,
      status: started.status,
      tags,
      ...accountOnRun(started),
    });
    spent += started.chargeUsd;
    await recordTagScrapes(input.sb, input.appId, tags);
  }
  return { runs, skipped: prepared.skipped };
}

export async function pollDiscoveryJob(
  sb: SupabaseClient,
  jobId: string,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<DiscoveryJobResult> {
  await ensureRuntimeSecrets();
  if (!UUID_RE.test(jobId)) {
    return { statusCode: 400, body: { ok: false, error: 'That search id is not valid.' } };
  }
  if (!createJobPool(options).configured) {
    return { statusCode: 503, body: { ok: false, configured: false, error: DISCOVERY_UNCONFIGURED } };
  }

  const { data: job, error } = await sb
    .from('discovery_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error) return { statusCode: 500, body: { ok: false, error: error.message } };
  if (!job) return { statusCode: 404, body: { ok: false, error: 'Search not found.' } };

  if (job.status === 'succeeded') {
    const stored = asDiscoveryFunnel(job.funnel);
    const funnel = await stampFunnelSuggestions(sb, {
      appId: typeof job.app_id === 'string' ? job.app_id : null,
      campaignId: typeof job.campaign_id === 'string' ? job.campaign_id : null,
      campaignHashtags: Array.isArray(job.hashtags) ? (job.hashtags as string[]) : [],
      niche: typeof job.niche === 'string' ? job.niche : '',
      funnel: stored,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        status: 'succeeded',
        candidates: Array.isArray(job.results) ? job.results : [],
        funnel,
        eligibleSuggestions: funnel?.eligibleSuggestions ?? [],
        networkOnly: funnel?.networkOnly === true,
        note: funnel?.suggestionNote ?? '',
        message: funnel && showFunnelExplanation(funnel) ? discoveryFunnelMessage(funnel) : null,
      },
    };
  }
  if (job.status === 'failed') {
    return {
      statusCode: 200,
      body: {
        ok: true,
        status: 'failed',
        error: job.error || 'The search failed.',
        candidates: [],
      },
    };
  }

  const runs = (Array.isArray(job.runs) ? job.runs : []) as StoredRun[];
  const pool = createJobPool(options, {
    exhausted: asDiscoveryFunnel(job.funnel)?.apifyExhausted,
    runs,
  });
  try {
    for (const run of runs) {
      if (TERMINAL.has(run.status)) continue;
      const latest = await getApifyActorRun(run.runId, {
        pool,
        accountIndex: run.accountIndex,
      });
      run.status = latest.status;
      run.statusMessage = latest.statusMessage;
      if (latest.datasetId) run.datasetId = latest.datasetId;
      if (TERMINAL.has(latest.status)) {
        const planned = Number(run.chargeUsd) || 0;
        const actual = actualRunChargeUsd(latest.usage, planned);
        if (run.accountIndex && planned !== actual) {
          pool.reconcileSpend(run.accountIndex, planned, actual);
        }
        run.chargeUsd = actual;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not check the Apify run.';
    return { statusCode: 502, body: { ok: false, status: 'running', error: message } };
  }

  const stillRunning = runs.some((run) => !TERMINAL.has(run.status));
  if (stillRunning) {
    const partial = await loadRunningCandidates(sb, job, runs, pool);
    const candidates = partial.hits;
    await sb
      .from('discovery_jobs')
      .update({
        runs,
        ...(candidates.length > 0 ? { results: candidates } : {}),
      })
      .eq('id', jobId);
    const enriching = runs.some((run) => run.status === 'RUNNING' && run.profileEnrich);
    const networking = runs.some((run) => run.status === 'RUNNING' && run.network);
    const scraping = runs.some((run) => run.status === 'RUNNING' && !run.profileEnrich && !run.network);
    const stored = Array.isArray(job.results) ? (job.results as DiscoveryHit[]) : [];
    return {
      statusCode: 200,
      body: {
        ok: true,
        status: 'running',
        partial: true,
        message: (() => {
          const continuing = runs.find((run) => run.userContinue && !TERMINAL.has(run.status));
          if (continuing?.tags?.length) {
            const rounds = asDiscoveryFunnel(job.funnel)?.expansionRounds;
            const suffix = rounds ? ` · ${expansionRoundLabel(rounds)}` : '';
            return `Searching ${continuing.tags.join(', ')}…${suffix}`;
          }
          if (enriching) return 'Looking up public emails…';
          if (networking) return 'Reading following lists…';
          if (scraping) return 'Scraping creator profiles…';
          return 'Querying Apify hashtags…';
        })(),
        candidates: candidates.length > 0 ? candidates : stored,
        hashtagYield: partial.hashtagYield,
      },
    };
  }

  const jobSource: DiscoverySource = asDiscoverySource(job.discovery_source) ?? 'hashtags';
  const networkFailed = runs.find((run) => run.network && run.status !== 'SUCCEEDED');
  const hashtagStarted = runs.some((run) => !run.network && !run.profileEnrich);
  if (networkFailed && !hashtagStarted && jobSource !== 'network') {
    try {
      const phase = await beginHashtagPhase({
        sb,
        appId: String(job.app_id || ''),
        niche: String(job.niche || ''),
        hashtags: Array.isArray(job.hashtags) ? (job.hashtags as string[]) : [],
        platforms: (Array.isArray(job.platforms) ? job.platforms : ['tiktok']) as Platform[],
        resultLimit: savedResultLimit(Number(job.result_limit) || 10),
        requireEmail: wantsPublicEmail(job.require_public_email !== false),
        pool,
        budgetUsd: asDiscoveryFunnel(job.funnel)?.runBudgetUsd,
        spentUsd: runs.reduce((sum, run) => sum + (Number(run.chargeUsd) || 0), 0),
      });
      if (phase.runs.length > 0) {
        runs.push(...phase.runs);
        await sb.from('discovery_jobs').update({ status: 'running', runs }).eq('id', jobId);
        return {
          statusCode: 200,
          body: {
            ok: true,
            status: 'running',
            partial: true,
            message: 'Creator network did not finish. Searching hashtags…',
            candidates: Array.isArray(job.results) ? job.results : [],
          },
        };
      }
    } catch (err) {
      console.warn(
        '[discovery] hashtag fallback skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (networkFailed && !hashtagStarted && jobSource === 'network') {
    const message = formatApifyRunStatus(networkFailed.status, networkFailed.statusMessage);
    await sb.from('discovery_jobs').update({ status: 'failed', runs, error: message }).eq('id', jobId);
    return {
      statusCode: 200,
      body: { ok: true, status: 'failed', error: message, candidates: [] },
    };
  }

  const failed = runs.find(
    (run) =>
      !run.topUp && !run.profileEnrich && !run.fallback && !run.network && run.status !== 'SUCCEEDED',
  );
  if (failed) {
    const message = formatApifyRunStatus(failed.status, failed.statusMessage);
    await sb
      .from('discovery_jobs')
      .update({ status: 'failed', runs, error: message })
      .eq('id', jobId);
    return {
      statusCode: 200,
      body: { ok: true, status: 'failed', error: message, candidates: [] },
    };
  }

  try {
    let collected: CreatorCandidate[] = [];
    let rawItems = 0;
    const storedFunnel = asDiscoveryFunnel(job.funnel);
    const networkParts: NetworkFunnelStats[] = [];
    let networkStats: NetworkFunnelStats | null = storedFunnel?.network ?? null;
    const samples: Record<string, number> = {};
    const networkKeywords = storedFunnel?.relevanceTerms?.length
      ? storedFunnel.relevanceTerms
      : relevanceKeywords(
          String(job.niche || ''),
          Array.isArray(job.hashtags) ? (job.hashtags as string[]) : [],
        );
    const networkCategories = (storedFunnel?.activeCategories ?? []).filter(isCategoryId);
    const requireEmail = wantsPublicEmail(job.require_public_email !== false);
    const fetchLimit = rawItemTarget(Number(job.result_limit) || 10, requireEmail);
    const jobPlatforms = (Array.isArray(job.platforms) ? job.platforms : ['tiktok']) as Platform[];
    for (const run of runs) {
      if (run.profileEnrich) continue;
      if (run.network && run.status !== 'SUCCEEDED') continue;
      if ((run.topUp || run.fallback) && run.status !== 'SUCCEEDED') continue;
      if (!run.datasetId) continue;
      const items = await fetchApifyDatasetItems(run.datasetId, {
        pool,
        accountIndex: run.accountIndex,
        limit: run.network
          ? Math.max(fetchLimit, run.maxItems ?? (run.seeds?.length ?? 1) * 120)
          : fetchLimit,
      });
      if (run.network) {
        const filtered = filterNetworkBatch({
          rows: items,
          seeds: run.seeds ?? [],
          followerMin: job.follower_min != null ? Number(job.follower_min) : null,
          followerMax: job.follower_max != null ? Number(job.follower_max) : null,
          requireEmail: false,
          keywords: networkKeywords,
          niches: [String(job.niche || '')],
          categories: networkCategories,
          includeInRange: true,
        });
        networkParts.push(filtered.stats);
        run.itemCount = items.length;
        if (!run.seedsRecorded && job.app_id && filtered.stats.seedResults?.length) {
          await recordNetworkSeedResults(sb, String(job.app_id), filtered.stats.seedResults);
          run.seedsRecorded = true;
        }
        collected.push(...(filtered.inRangeCreators ?? [...filtered.creators, ...filtered.existing]));
        continue;
      }
      run.itemCount = items.length;
      rawItems += items.length;
      for (const [tag, count] of Object.entries(sampleCountsForTags(run.tags ?? [], items.length))) {
        samples[tag] = (samples[tag] ?? 0) + count;
      }
      collected.push(
        ...mapApifyDatasetItems(items, run.platform, [String(job.niche || '')]),
      );
    }
    if (networkParts.length > 0) networkStats = mergeNetworkStats(networkParts);
    const followerMin = job.follower_min != null ? Number(job.follower_min) : null;
    const followerMax = job.follower_max != null ? Number(job.follower_max) : null;
    const qualified = await qualifyCandidates(collected, {
      followerMin,
      followerMax,
      keywords: networkKeywords,
      categories: networkCategories,
    });
    collected = qualified.kept;
    const biosInRange = filterDiscoveryCandidates(collected, {
      followerMin,
      followerMax,
      limit: Math.max(collected.length, 1),
    });
    const afterBioExtract = biosInRange.filter((c) => candidateHasPublicEmail(c)).length;
    for (const run of runs) {
      if (!run.profileEnrich || run.status !== 'SUCCEEDED' || !run.datasetId) continue;
      const items = await fetchApifyDatasetItems(run.datasetId, {
        pool,
        accountIndex: run.accountIndex,
        limit: 30,
      });
      collected = mergeProfileEmails(collected, items, run.platform);
    }
    const inRange = filterDiscoveryCandidates(collected, {
      followerMin,
      followerMax,
      limit: Math.max(collected.length, 1),
    });
    const afterProfileEnrich = inRange.filter((c) => candidateHasPublicEmail(c)).length;
    const hashtagYield = scoreHashtagYield(queriedTags(runs), inRange, requireEmail, samples);
    const resultLimit = savedResultLimit(Number(job.result_limit) || 10);
    const partitioned = await partitionDiscoveryHits(
      sb,
      job.app_id as string | null,
      inRange,
      requireEmail,
      resultLimit,
    );
    const fresh = partitioned.fresh;
    const filtered = partitioned.hits;
    const freshSaved = filtered.filter((hit) => !hit.existing);
    const includeCrm = job.include_existing === true;
    const shownHits = filtered;
    const finishedNow = creatorsTowardTarget(freshSaved.length, partitioned.existing.length, includeCrm);
    const hashtags = Array.isArray(job.hashtags) ? (job.hashtags as string[]) : [];
    const minCreators = asMinCreators(job.min_creators);
    const aiFallback = job.ai_fallback === true;
    const previousFunnel = asDiscoveryFunnel(job.funnel);
    const userContinued =
      previousFunnel?.continueUsed === 'expand' || runs.some((run) => run.userContinue);
    const hashtagRuns = runs.some((run) => !run.network && !run.profileEnrich);
    const networkGoal = minCreators ?? resultLimit;
    const spentNow = runs.reduce((sum, run) => sum + (Number(run.chargeUsd) || 0), 0);
    const budgetUsd = storedFunnel?.runBudgetUsd ?? discoveryRunBudgetUsd();
    let budgetHoldNote: string | undefined;
    const networkQualifying = creatorsTowardTarget(
      freshSaved.filter((hit) => hit.discovery_source === 'network').length,
      partitioned.existing.filter((row) => row.discovery_source === 'network').length,
      includeCrm,
    );
    if (
      !userContinued &&
      (jobSource === 'network' || jobSource === 'both') &&
      runs.some((run) => run.network && run.status === 'SUCCEEDED') &&
      !hashtagRuns &&
      networkQualifying < networkGoal
    ) {
      const used = new Set(
        runs.flatMap((run) => run.seeds ?? []).map((seed) => seed.replace(/^@/, '').trim().toLowerCase()),
      );
      const hidden = new Set((networkStats?.hiddenSeeds ?? []).map((seed) => seed.toLowerCase()));
      const follow = planFollowUpNetworkBatch({
        queue: storedFunnel?.networkQueue ?? [],
        hopped: storedFunnel?.networkHopped === true,
        fresh: networkQualifying,
        goal: networkGoal,
        spentUsd: spentNow,
        budgetUsd,
        hopCandidates: collected
          .filter((row) => row.discovery_source === 'network' && !row.alreadyInCrm)
          .map((row) => ({ handle: row.handle, followerCount: row.follower_count })),
        used,
        hidden,
      });
      if (follow) {
        const actorInput = buildFollowersActorInput(
          follow.batch.seeds,
          follow.batch.maxFollowingPerProfile,
        );
        if (actorInput) {
          actorInput.chargeCapUsd = follow.batch.maxTotalChargeUsd;
          try {
            const networkActor = followersActorId();
            const started = await startApifyActorRun(networkActor, actorInput, { pool });
            runs.push({
              platform: 'tiktok',
              actorId: networkActor,
              runId: started.runId,
              datasetId: started.datasetId,
              status: started.status,
              network: true,
              seeds: follow.batch.seeds,
              maxItems: follow.batch.maxItems,
              ...accountOnRun(started),
            });
            await recordNetworkSeeds(sb, String(job.app_id || ''), follow.batch.seeds);
            const nextFunnel: DiscoveryFunnel = {
              ...(storedFunnel ?? {
                rawItems: 0,
                uniqueCreators: 0,
                afterFollowers: 0,
                afterDedupe: 0,
                withEmail: 0,
                saved: 0,
                followerMin,
                followerMax,
                apifyRunIds: [],
              }),
              networkQueue: follow.queueAfter,
              networkHopped: follow.hopped,
              runBudgetUsd: budgetUsd,
              runSpentUsd: spentNow + started.chargeUsd,
              ...accountFunnelFields(pool, runs),
              ...(networkStats ? { network: networkStats } : {}),
            };
            await sb
              .from('discovery_jobs')
              .update({ status: 'running', runs, results: shownHits, funnel: nextFunnel })
              .eq('id', jobId);
            return {
              statusCode: 200,
              body: {
                ok: true,
                status: 'running',
                partial: true,
                message: follow.hopped && (storedFunnel?.networkHopped !== true)
                  ? 'Reading a second hop of following lists…'
                  : 'Reading the next batch of following lists…',
                candidates: shownHits,
              },
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Creator network did not start.';
            if (monthlyLimitMessage(message)) {
              networkStats = {
                ...(networkStats ?? emptyNetworkStats(ALL_ACCOUNTS_EXHAUSTED_MESSAGE)),
                note: ALL_ACCOUNTS_EXHAUSTED_MESSAGE,
              };
            }
            console.warn('[discovery] next network batch skipped:', message);
          }
        }
      } else if (spentNow + 0.002 >= budgetUsd) {
        networkStats = networkStats
          ? {
              ...networkStats,
              note: networkStats.note || `Run budget of $${budgetUsd.toFixed(2)} is used.`,
            }
          : networkStats;
      }
    }
    if (
      !userContinued &&
      jobSource === 'both' &&
      runs.some((run) => run.network && run.status === 'SUCCEEDED') &&
      !hashtagRuns &&
      finishedNow < networkGoal
    ) {
      try {
        const phase = await beginHashtagPhase({
          sb,
          appId: String(job.app_id || ''),
          niche: String(job.niche || ''),
          hashtags,
          platforms: jobPlatforms,
          resultLimit,
          requireEmail,
          pool,
          budgetUsd,
          spentUsd: spentNow,
        });
        if (phase.note) {
          networkStats = networkStats
            ? { ...networkStats, note: networkStats.note || phase.note }
            : networkStats;
        }
        if (phase.runs.length > 0) {
          runs.push(...phase.runs);
          await sb
            .from('discovery_jobs')
            .update({ status: 'running', runs, results: shownHits })
            .eq('id', jobId);
          return {
            statusCode: 200,
            body: {
              ok: true,
              status: 'running',
              partial: true,
              message: 'Creator network was short of the target. Searching hashtags…',
              candidates: shownHits,
              hashtagYield,
            },
          };
        }
      } catch (err) {
        console.warn(
          '[discovery] hashtag follow-up skipped:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (
      !userContinued &&
      !aiFallback &&
      minCreators != null &&
      finishedNow < minCreators &&
      !runs.some((run) => run.topUp)
    ) {
      const rawPlatform = Array.isArray(job.platforms) ? String(job.platforms[0] || '') : '';
      const platform: Platform = rawPlatform === 'instagram' ? 'instagram' : 'tiktok';
      const top = buildTopUpActorInput(
        {
          niches: [String(job.niche || '')],
          hashtags,
          result_limit: resultLimit,
          platforms: [platform],
        } as Campaign,
        platform,
      );
      const topCharge = top ? controlsForActorInput(top.input).maxTotalChargeUsd : 0;
      if (top && fitsRunBudget(spentNow, topCharge, budgetUsd)) {
        try {
          const actorId = actorForPlatform(platform, {});
          const started = await startApifyActorRun(actorId, top.input, { pool });
          runs.push({
            platform,
            actorId,
            runId: started.runId,
            datasetId: started.datasetId,
            status: started.status,
            topUp: true,
            tags: tagsFromActorInput(top.input),
            ...accountOnRun(started),
          });
          await sb
            .from('discovery_jobs')
            .update({ status: 'running', runs, results: shownHits })
            .eq('id', jobId);
          return {
            statusCode: 200,
            body: {
              ok: true,
              status: 'running',
              partial: true,
              message: 'Trying one more page to reach the minimum…',
              candidates: shownHits,
              hashtagYield,
            },
          };
        } catch (err) {
          console.warn(
            '[discovery] minimum-creators top-up skipped:',
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    if (profileEnrichEnabled() && requireEmail && !runs.some((run) => run.profileEnrich)) {
      const byPlatform = new Map<Platform, string[]>();
      for (const row of handlesMissingEmail(fresh)) {
        const list = byPlatform.get(row.platform) ?? [];
        list.push(row.handle);
        byPlatform.set(row.platform, list);
      }
      let startedProfile = false;
      for (const [platform, profileHandles] of byPlatform) {
        const input = buildProfileEnrichInput(platform, profileHandles);
        if (!input) continue;
        try {
          const actorId = actorForPlatform(platform, {});
          const started = await startApifyActorRun(actorId, input, { pool });
          runs.push({
            platform,
            actorId,
            runId: started.runId,
            datasetId: started.datasetId,
            status: started.status,
            profileEnrich: true,
            ...accountOnRun(started),
          });
          startedProfile = true;
        } catch (err) {
          console.warn(
            '[discovery] profile enrich skipped:',
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (startedProfile) {
        await sb
          .from('discovery_jobs')
          .update({ status: 'running', runs, results: shownHits })
          .eq('id', jobId);
        return {
          statusCode: 200,
          body: {
            ok: true,
            status: 'running',
            partial: true,
            message: 'Looking up public emails…',
            candidates: shownHits,
            hashtagYield,
          },
        };
      }
    }
    const fallbackTarget = minCreators ?? resultLimit;
    const nicheLabel = String(job.niche || '');
    const cascadeBox: { settle: Partial<DiscoveryFunnel> | null } = { settle: null };
    if (previousFunnel?.expansionCascade) {
      const chained = await chainExpansionRound({
        sb,
        jobId,
        appId: typeof job.app_id === 'string' ? job.app_id : null,
        niche: nicheLabel,
        platforms: job.platforms,
        runs,
        pool,
        funnel: previousFunnel,
        finishedNow,
        target: fallbackTarget,
        candidates: shownHits,
        hashtagYield,
        onSettle: (partial) => {
          cascadeBox.settle = partial;
        },
      });
      if (chained) return chained;
    }
    const cascadeSettle = cascadeBox.settle;
    const autoRuns = runs.filter(
      (run) => run.fallback && !run.userContinue && run.status === 'SUCCEEDED',
    );
    if (
      !userContinued &&
      aiFallback &&
      finishedNow < fallbackTarget &&
      autoRuns.length < EXPANSION_ROUNDS_PER_CLICK &&
      !runs.some((run) => run.fallback && !TERMINAL.has(run.status))
    ) {
      const last = autoRuns[autoRuns.length - 1];
      const lastAdded = last ? finishedNow - (last.baselineSaved ?? finishedNow) : 1;
      if (!last || lastAdded <= 0) {
        const rawPlatform = Array.isArray(job.platforms) ? String(job.platforms[0] || '') : '';
        const platform: Platform = rawPlatform === 'instagram' ? 'instagram' : 'tiktok';
        const tried = queriedTags(runs);
        const suggestion = await suggestFallbackHashtags({
          niche: nicheLabel,
          current: tried,
        });
        const tiers = buildExpansionTiers({
          niche: nicheLabel,
          modelTags: suggestion.tags,
        });
        const previousTags = last?.tags?.length ? last.tags : tried;
        const wanted = new Set(normaliseHashtags(previousTags));
        const previousFlags = hashtagYield
          .filter((row) => wanted.has(normaliseHashtags([row.tag])[0] ?? row.tag))
          .map((row) => row.flag);
        const tagStats = job.app_id ? await loadTagStats(sb, String(job.app_id)) : [];
        const cooling = job.app_id ? await loadRecentTagScrapes(sb, String(job.app_id)) : [];
        const picked = selectExpansionTags({
          tiers,
          tried,
          afterTier: last && lastAdded <= 0 ? (last.expansionTier ?? null) : null,
          previousTags,
          previousFlags,
          blocked: cooling.map((row) => row.tag),
          stats: tagStats,
          categories: networkCategories.length > 0 ? networkCategories : undefined,
        });
        const choice = chooseExpansionTags({
          requested: picked.tags,
          tiers,
          categories: networkCategories.length > 0 ? networkCategories : undefined,
          stats: tagStats,
          scrapes: cooling,
          campaignHashtags: hashtags,
          tried,
        });
        const next = {
          tags: choice.tags,
          tier: picked.tier,
          rotation: choice.rotation ?? picked.rotation,
        };
        const input = buildFallbackActorInput(platform, next.tags);
        const roundCharge = input ? controlsForActorInput(input).maxTotalChargeUsd : 0;
        if (input && next.tags.length > 0 && !fitsRunBudget(spentNow, roundCharge, budgetUsd)) {
          budgetHoldNote = `Run budget of $${budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`;
        } else if (input && next.tags.length > 0) {
          try {
            const actorId = actorForPlatform(platform, {});
            const started = await startApifyActorRun(actorId, input, { pool });
            const tags = tagsFromActorInput(input);
            runs.push({
              platform,
              actorId,
              runId: started.runId,
              datasetId: started.datasetId,
              status: started.status,
              fallback: true,
              fallbackSource: suggestion.source,
              tags,
              baselineSaved: finishedNow,
              ...accountOnRun(started),
              ...(next.tier ? { expansionTier: next.tier } : {}),
            });
            const runningFunnel: DiscoveryFunnel = {
              ...(storedFunnel ?? {
                rawItems: 0,
                uniqueCreators: 0,
                afterFollowers: 0,
                afterDedupe: 0,
                withEmail: 0,
                saved: 0,
                followerMin,
                followerMax,
                apifyRunIds: [],
              }),
              runBudgetUsd: budgetUsd,
              runSpentUsd: spentNow + started.chargeUsd,
              ...accountFunnelFields(pool, runs),
              ...(next.rotation ? { categoryRotation: next.rotation } : {}),
            };
            await sb
              .from('discovery_jobs')
              .update({ status: 'running', runs, results: shownHits, funnel: runningFunnel })
              .eq('id', jobId);
            return {
              statusCode: 200,
              body: {
                ok: true,
                status: 'running',
                partial: true,
                message: `Searching ${tags.join(', ')}… · ${expansionRoundLabel(autoRuns.length + 1)}`,
                candidates: shownHits,
                hashtagYield,
                fallbackTags: tags,
                fallbackSource: suggestion.source,
              },
            };
          } catch (err) {
            console.warn(
              '[discovery] fallback search skipped:',
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
    }
    const fallbackRun = runs.find(
      (run) => run.fallback && run.status === 'SUCCEEDED' && (run.tags?.length ?? 0) > 0,
    );
    const automaticFallback = runs.some(
      (run) => run.fallback && !run.userContinue && run.status === 'SUCCEEDED',
    );
    const pagePass = runs.some((run) => run.topUp && run.status === 'SUCCEEDED');
    const extraPass =
      previousFunnel?.extraPass ??
      (automaticFallback ? 'fallback' : pagePass ? 'page' : undefined);
    const triedTags = queriedTags(runs);
    if (networkStats && networkStats.rows > 0) {
      networkStats = {
        ...networkStats,
        fresh: partitioned.fresh.filter((row) => row.discovery_source === 'network').length,
        existing: partitioned.existing.filter((row) => row.discovery_source === 'network').length,
      };
    }
    const profileLookupRan = runs.some((run) => run.profileEnrich);
    let funnel: DiscoveryFunnel = {
      rawItems,
      uniqueCreators: qualified.unique.length,
      afterFollowers: qualified.inRange.length,
      bioLinksChecked: qualified.bioLinksChecked,
      emailsFromBioLinks: qualified.emailsFromBioLinks,
      nicheRelevant: qualified.nicheRelevant,
      nicheReview: qualified.nicheReview,
      nicheDropped: qualified.nicheDropped,
      nicheSource: qualified.nicheSource,
      afterDedupe: fresh.length,
      existing: partitioned.existing.length,
      existingCreatorIds: partitioned.existing.map((row) => row.creatorId),
      afterBioExtract,
      ...(profileLookupRan ? { afterProfileEnrich } : {}),
      withEmail: afterProfileEnrich,
      discoverySource: jobSource,
      ...(networkStats ? { network: networkStats } : {}),
      ...(previousFunnel?.skippedTags?.length ? { skippedTags: previousFunnel.skippedTags } : {}),
      saved: freshSaved.length,
      finished: finishedNow,
      followerMin,
      followerMax,
      apifyRunIds: runs.map((run) => run.runId).filter(Boolean),
      requirePublicEmail: requireEmail,
      hashtagYield,
      ...(triedTags.length > 0 ? { triedTags } : {}),
      ...(fallbackRun?.tags?.length
        ? { fallbackTags: fallbackRun.tags, fallbackSource: fallbackRun.fallbackSource }
        : {}),
      ...(extraPass ? { extraPass } : {}),
      ...(previousFunnel?.continueUsed ? { continueUsed: previousFunnel.continueUsed } : {}),
      ...(previousFunnel?.emailRelaxed ? { emailRelaxed: true } : {}),
      ...(cascadeSettle ?? {}),
      expansionCascade: false,
      ...(previousFunnel?.suggestedTags?.length && !(cascadeSettle && cascadeSettle.suggestedTags)
        ? {
            suggestedTags: previousFunnel.suggestedTags,
            ...(previousFunnel.suggestedSource
              ? { suggestedSource: previousFunnel.suggestedSource }
              : {}),
          }
        : {}),
      ...(storedFunnel?.runBudgetUsd != null ? { runBudgetUsd: storedFunnel.runBudgetUsd } : {}),
      runSpentUsd: spentNow,
      ...accountFunnelFields(pool, runs),
      ...(storedFunnel?.runBudgetNote || budgetHoldNote
        ? { runBudgetNote: storedFunnel?.runBudgetNote || budgetHoldNote }
        : {}),
      ...(networkStats?.note && /budget|monthly limit/i.test(networkStats.note)
        ? { runBudgetNote: storedFunnel?.runBudgetNote || networkStats.note }
        : {}),
      ...(storedFunnel?.relevanceTerms ? { relevanceTerms: storedFunnel.relevanceTerms } : {}),
      ...(networkCategories.length > 0 ? { activeCategories: networkCategories } : {}),
      ...(storedFunnel?.categoryRotation ? { categoryRotation: storedFunnel.categoryRotation } : {}),
    };
    if (job.app_id) {
      const rounds = runs.flatMap((run) => {
        if (run.network || run.profileEnrich || run.statsRecorded || run.status !== 'SUCCEEDED') return [];
        if (!run.tags?.length) return [];
        run.statsRecorded = true;
        const sampled = sampleCountsForTags(run.tags, run.itemCount ?? 0);
        return scoreHashtagYield(run.tags, inRange, requireEmail, sampled).map((row) => ({
          tag: row.tag,
          videos: row.sampled ?? sampled[row.tag] ?? 0,
          inRange: row.creators,
          withEmail: row.withEmail,
          newSaved: requireEmail ? row.withEmail : row.creators,
        }));
      });
      if (rounds.length > 0) await recordTagRounds(sb, String(job.app_id), rounds);
    }
    const suggestionStats = job.app_id ? await loadTagStats(sb, String(job.app_id)) : [];
    const suggestionCooling = job.app_id ? await loadRecentTagScrapes(sb, String(job.app_id)) : [];
    funnel = await attachSuggestedTags(funnel, {
      niche: String(job.niche || ''),
      current: triedTags,
      minCreators,
      resultLimit,
      stats: suggestionStats,
      scrapes: suggestionCooling,
      campaignHashtags: hashtags,
      blockedTags: [
        ...suggestionCooling.map((row) => row.tag),
        ...suggestionStats.filter((stat) => stat.suppressedUntil && Date.parse(stat.suppressedUntil) > Date.now()).map((stat) => stat.tag),
        ...hashtags,
      ],
      categories: networkCategories,
    });
    logDiscoveryFunnel(funnel);
    const queryKey = discoveryQueryKey({
      niche: String(job.niche || ''),
      hashtags,
      platforms: Array.isArray(job.platforms) ? (job.platforms as string[]) : [],
      followerMin,
      followerMax,
      limit: resultLimit,
      requirePublicEmail: requireEmail,
      source: jobSource,
    });
    if (inRange.length > 0) {
      await writeDiscoveryCache(sb, {
        queryKey,
        appId: (job.app_id as string | null) ?? null,
        results: inRange.map(toHit),
      });
    }

    await sb
      .from('discovery_jobs')
      .update({ status: 'succeeded', runs, results: shownHits, funnel, error: null })
      .eq('id', jobId);

    return {
      statusCode: 200,
      body: {
        ok: true,
        status: 'succeeded',
        candidates: shownHits,
        funnel,
        message:
          funnel.expansionLog && funnel.expansionLog.length > 0
            ? expansionResultMessage(funnel.expansionLog, {
                exhausted: funnel.expansionExhausted === true,
                metTarget: fallbackTarget > 0 && (funnel.finished ?? 0) >= fallbackTarget,
              })
            : showFunnelExplanation(funnel)
              ? discoveryFunnelMessage(funnel)
              : null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not read Apify results.';
    return { statusCode: 502, body: { ok: false, status: 'running', error: message } };
  }
}

function asStoredHits(value: unknown): DiscoveryHit[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => row && typeof row === 'object' && typeof (row as DiscoveryHit).handle === 'string') as DiscoveryHit[];
}

function mergeStoredHits(current: DiscoveryHit[], incoming: DiscoveryHit[]): DiscoveryHit[] {
  const byKey = new Map(current.map((hit) => [`${hit.platform}:${hit.handle.toLowerCase()}`, hit]));
  for (const hit of incoming) {
    const key = `${hit.platform}:${hit.handle.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, hit);
  }
  return [...byKey.values()];
}

async function chainExpansionRound(input: {
  sb: SupabaseClient;
  jobId: string;
  appId?: string | null;
  niche: string;
  platforms: unknown;
  runs: StoredRun[];
  pool: ApifyPool;
  funnel: DiscoveryFunnel;
  finishedNow: number;
  target: number;
  candidates: DiscoveryHit[];
  hashtagYield: HashtagYield[];
  onSettle: (partial: Partial<DiscoveryFunnel>) => void;
}): Promise<DiscoveryJobResult | null> {
  const latest = [...input.runs].reverse().find((run) => run.userContinue);
  const baseline = input.funnel.expansionBaseline ?? input.finishedNow;
  const added = Math.max(0, input.finishedNow - baseline);
  const rounds = input.funnel.expansionRounds ?? 1;
  const tried = queriedTags(input.runs).concat(input.funnel.triedTags ?? []);
  const custom = input.funnel.expansionCustom ?? [];
  const tiers = buildExpansionTiers({
    niche: input.niche,
    modelTags: [
      ...(input.funnel.expansionPlan ?? []).flatMap((tier) => tier.tags),
      ...(input.funnel.suggestedTags ?? []),
    ],
  });
  const customLeft = custom.length > 0 ? takeContinueTags(custom, tried) : [];
  const jump = added <= 0 ? (latest?.expansionTier ?? input.funnel.expansionTier ?? null) : null;
  const previousTags = latest?.tags ?? [];
  const wanted = new Set(normaliseHashtags(previousTags));
  const previousFlags = input.hashtagYield
    .filter((row) => wanted.has(normaliseHashtags([row.tag])[0] ?? row.tag))
    .map((row) => row.flag);
  const categories = (input.funnel.activeCategories ?? []).filter(isCategoryId);
  const picked =
    custom.length > 0
      ? { tags: customLeft, tier: null as ExpansionTierIndex | null, rotation: null as string | null }
      : selectExpansionTags({
          tiers,
          tried,
          afterTier: jump,
          previousTags,
          previousFlags,
          categories: categories.length > 0 ? categories : undefined,
        });
  let next = { tags: picked.tags, tier: picked.tier, rotation: picked.rotation };
  let freshSuggestions: string[] | null = null;
  if (custom.length === 0 && input.appId) {
    const [scrapes, stats] = await Promise.all([
      loadRecentTagScrapes(input.sb, input.appId),
      loadTagStats(input.sb, input.appId),
    ]);
    const choice = chooseExpansionTags({
      requested: picked.tags,
      tiers,
      categories: categories.length > 0 ? categories : undefined,
      stats,
      scrapes,
      campaignScraped: tried,
      tried,
    });
    next = {
      tags: choice.tags,
      tier: choice.tags.map((tag) => tiers.find((row) => row.tags.includes(tag))?.tier ?? null).find((value) => value != null) ?? picked.tier,
      rotation: choice.rotation ?? picked.rotation,
    };
    freshSuggestions = choice.nextSuggestions;
  }
  const log = [
    ...(input.funnel.expansionLog ?? []),
    ...(latest?.tags?.length
      ? [{ tags: latest.tags, added, ...(latest.expansionTier ? { tier: latest.expansionTier } : {}) }]
      : []),
  ];
  const weakRound =
    custom.length === 0 &&
    previousFlags.length > 0 &&
    previousFlags.every((flag) => flag === 'thin' || flag === 'low');
  const chain =
    latest?.status === 'SUCCEEDED' &&
    next.tags.length > 0 &&
    (shouldChainRound({
      added,
      roundsUsed: rounds,
      finished: input.finishedNow,
      target: input.target,
      exhausted: next.tags.length === 0,
      custom: custom.length > 0,
    }) ||
      (weakRound &&
        rounds < EXPANSION_ROUNDS_PER_CLICK &&
        input.finishedNow < input.target));
  if (!chain || next.tags.length === 0) {
    const upcoming = planNextRound({ tiers, tried });
    const settledTags = freshSuggestions ?? upcoming.tags;
    input.onSettle({
      expansionCascade: false,
      expansionRounds: rounds,
      expansionLog: log,
      expansionPlan: tiers,
      expansionExhausted: settledTags.length === 0,
      suggestedTags: settledTags,
      eligibleSuggestions: settledTags,
      ...(input.funnel.expansionTier ? { expansionTier: input.funnel.expansionTier } : {}),
    });
    return null;
  }
  const rawPlatform = Array.isArray(input.platforms) ? String(input.platforms[0] || '') : '';
  const platform: Platform = rawPlatform === 'instagram' ? 'instagram' : 'tiktok';
  const actorInput = buildFallbackActorInput(platform, next.tags);
  if (!actorInput) {
    input.onSettle({ expansionCascade: false, expansionLog: log, expansionExhausted: true, expansionPlan: tiers });
    return null;
  }
  const budgetUsd = input.funnel.runBudgetUsd ?? discoveryRunBudgetUsd();
  const spentUsd = input.funnel.runSpentUsd ?? 0;
  const roundCharge = controlsForActorInput(actorInput).maxTotalChargeUsd;
  if (!fitsRunBudget(spentUsd, roundCharge, budgetUsd)) {
    input.onSettle({
      expansionCascade: false,
      expansionLog: log,
      expansionPlan: tiers,
      runBudgetNote: `Run budget of $${budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`,
      ...(next.rotation ? { categoryRotation: next.rotation } : {}),
    });
    return null;
  }
  try {
    const actorId = actorForPlatform(platform, {});
    const started = await startApifyActorRun(actorId, actorInput, { pool: input.pool });
    const tags = tagsFromActorInput(actorInput);
    input.runs.push({
      platform,
      actorId,
      runId: started.runId,
      datasetId: started.datasetId,
      status: started.status,
      fallback: true,
      userContinue: true,
      fallbackSource: input.funnel.suggestedSource === 'ai' ? 'ai' : 'niche',
      tags,
      baselineSaved: input.finishedNow,
      ...accountOnRun(started),
      ...(next.tier ? { expansionTier: next.tier } : {}),
    });
    const nextFunnel: DiscoveryFunnel = {
      ...input.funnel,
      continueUsed: 'expand',
      fallbackTags: tags,
      expansionCascade: true,
      expansionRounds: rounds + 1,
      expansionBaseline: input.finishedNow,
      expansionLog: log,
      expansionPlan: tiers,
      runBudgetUsd: budgetUsd,
      runSpentUsd: spentUsd + started.chargeUsd,
      ...accountFunnelFields(input.pool, input.runs),
      ...(next.tier ? { expansionTier: next.tier } : {}),
      ...(next.rotation ? { categoryRotation: next.rotation } : {}),
      ...(freshSuggestions
        ? { suggestedTags: freshSuggestions, eligibleSuggestions: freshSuggestions }
        : {}),
    };
    await input.sb
      .from('discovery_jobs')
      .update({ status: 'running', runs: input.runs, funnel: nextFunnel, results: input.candidates })
      .eq('id', input.jobId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        status: 'running',
        partial: true,
        message: `Searching ${tags.join(', ')}… · ${expansionRoundLabel(rounds + 1)}`,
        candidates: input.candidates,
        hashtagYield: input.hashtagYield,
        rounds: rounds + 1,
      },
    };
  } catch (err) {
    console.warn('[discovery] expansion round skipped:', err instanceof Error ? err.message : err);
    input.onSettle({ expansionCascade: false, expansionLog: log, expansionPlan: tiers });
    return null;
  }
}

/**
 * One user continue after a short search.
 * Expand searches the next untried tags. A round that adds nobody starts the
 * next tier, up to three Apify rounds in that click. Relax keeps in-range
 * creators from this batch without a public email. Nothing is emailed.
 */
export async function continueDiscoveryJob(
  sb: SupabaseClient,
  jobId: string,
  body: unknown,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<DiscoveryJobResult> {
  await ensureRuntimeSecrets();
  if (!UUID_RE.test(jobId)) {
    return { statusCode: 400, body: { ok: false, error: 'That search id is not valid.' } };
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const action =
    input.action === 'expand' || input.action === 'relax' || input.action === 'custom'
      ? input.action
      : null;
  if (!action) {
    return { statusCode: 400, body: { ok: false, error: 'Choose expand, custom, or relax.' } };
  }

  if (!createJobPool(options).configured) {
    return { statusCode: 503, body: { ok: false, configured: false, error: DISCOVERY_UNCONFIGURED } };
  }

  const { data: job, error } = await sb.from('discovery_jobs').select('*').eq('id', jobId).maybeSingle();
  if (error) return { statusCode: 500, body: { ok: false, error: error.message } };
  if (!job) return { statusCode: 404, body: { ok: false, error: 'Search not found.' } };
  if (job.status === 'running') {
    return { statusCode: 409, body: { ok: false, error: 'This search is still running.' } };
  }
  if (job.status !== 'succeeded') {
    return { statusCode: 409, body: { ok: false, error: 'Continue is only available after a finished search.' } };
  }

  const runs = (Array.isArray(job.runs) ? job.runs : []) as StoredRun[];
  const funnel = asDiscoveryFunnel(job.funnel);
  const hashtags = Array.isArray(job.hashtags) ? (job.hashtags as string[]) : [];
  const tried = queriedTags(runs).concat(funnel?.triedTags ?? [], funnel?.fallbackTags ?? []);

  if (action === 'expand' || action === 'custom') {
    const provided = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : [];
    const custom = action === 'custom' ? parseCustomHashtags(provided.join(', ')) : null;
    if (custom?.error) return { statusCode: 400, body: { ok: false, error: custom.error } };
    let tags = custom ? takeContinueTags(custom.tags, tried) : [];
    let expansionChoice: ReturnType<typeof chooseExpansionTags> | null = null;
    if (!custom && typeof job.app_id === 'string') {
      const [history, stats] = await Promise.all([
        loadRecentTagScrapes(sb, job.app_id),
        loadTagStats(sb, job.app_id),
      ]);
      expansionChoice = chooseExpansionTags({
        requested: provided.length > 0 ? provided : (funnel?.suggestedTags ?? []),
        tiers: buildExpansionTiers({
          niche: String(job.niche || ''),
          modelTags: [
            ...(funnel?.expansionPlan ?? []).flatMap((tier) => tier.tags),
            ...(funnel?.suggestedTags ?? []),
          ],
          blocked: [
            ...history.map((row) => row.tag),
            ...hashtags,
            ...tried,
          ],
        }),
        categories: (funnel?.activeCategories ?? []).filter(isCategoryId),
        stats,
        scrapes: history,
        campaignHashtags: hashtags,
        campaignScraped: tried,
        tried,
      });
      if (expansionChoice.tags.length === 0) {
        const nextFunnel: DiscoveryFunnel = {
          ...(funnel ?? {
            rawItems: 0,
            uniqueCreators: 0,
            afterFollowers: 0,
            afterDedupe: 0,
            withEmail: 0,
            saved: 0,
            followerMin: null,
            followerMax: null,
            apifyRunIds: [],
          }),
          skippedTags: expansionChoice.skipped,
          suggestedTags: [],
          eligibleSuggestions: [],
          networkOnly: true,
          suggestionNote: expansionChoice.note || NO_ELIGIBLE_TAGS_NOTE,
          expansionExhausted: true,
          ...(expansionChoice.skipped.length > 0 ? { reason: 'tags_on_cooldown' as const } : {}),
        };
        await sb.from('discovery_jobs').update({ funnel: nextFunnel }).eq('id', jobId);
        return {
          statusCode: 200,
          body: {
            ok: true,
            status: 'succeeded',
            networkOnly: true,
            eligibleSuggestions: [],
            note: nextFunnel.suggestionNote,
            message: nextFunnel.suggestionNote || NO_ELIGIBLE_TAGS_NOTE,
            candidates: Array.isArray(job.results) ? job.results : [],
            funnel: nextFunnel,
          },
        };
      }
      tags = expansionChoice.tags;
    } else if (!custom) {
      tags = takeContinueTags(provided.length > 0 ? provided : (funnel?.suggestedTags ?? []), tried);
    }
    let source: 'ai' | 'niche' = funnel?.suggestedSource === 'ai' ? 'ai' : 'niche';
    let tiers = buildExpansionTiers({
      niche: String(job.niche || ''),
      modelTags: [
        ...(funnel?.expansionPlan ?? []).flatMap((tier) => tier.tags),
        ...(funnel?.suggestedTags ?? []),
      ],
    });
    let tier: ExpansionTierIndex | null =
      tags
        .map((tag) => tiers.find((row) => row.tags.includes(tag))?.tier ?? null)
        .find((value) => value != null) ?? null;
    if (tags.length === 0 && !custom) {
      const suggestion = await suggestFallbackHashtags({
        niche: String(job.niche || ''),
        current: tried,
      });
      tiers = buildExpansionTiers({
        niche: String(job.niche || ''),
        modelTags: [...tiers.flatMap((row) => row.tags), ...suggestion.tags],
      });
      const next = planNextRound({ tiers, tried });
      tags = next.tags;
      tier = next.tier;
      source = suggestion.tags.length > 0 ? suggestion.source : source;
    }
    if (tags.length === 0) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: custom
            ? 'Those hashtags were already tried.'
            : 'Related tags are used up. Type your own hashtags to search again.',
        },
      };
    }
    const rawPlatform = Array.isArray(job.platforms) ? String(job.platforms[0] || '') : '';
    const platform: Platform = rawPlatform === 'instagram' ? 'instagram' : 'tiktok';
    const actorInput = buildFallbackActorInput(platform, tags);
    if (!actorInput) {
      return { statusCode: 400, body: { ok: false, error: 'No related tags left to try.' } };
    }
    const budgetUsd = funnel?.runBudgetUsd ?? discoveryRunBudgetUsd();
    const spentUsd =
      funnel?.runSpentUsd ?? runs.reduce((sum, run) => sum + (Number(run.chargeUsd) || 0), 0);
    const roundCharge = controlsForActorInput(actorInput).maxTotalChargeUsd;
    if (!fitsRunBudget(spentUsd, roundCharge, budgetUsd)) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: `Run budget of $${budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`,
        },
      };
    }
    try {
      const actorId = actorForPlatform(platform, {});
      const pool = createJobPool(options, {
        exhausted: funnel?.apifyExhausted,
        runs,
      });
      const started = await startApifyActorRun(actorId, actorInput, { pool });
      const searched = tagsFromActorInput(actorInput);
      const includeCrm = job.include_existing === true;
      const baseline =
        funnel?.finished ??
        creatorsTowardTarget(funnel?.saved ?? 0, funnel?.existing ?? 0, includeCrm);
      runs.push({
        platform,
        actorId,
        runId: started.runId,
        datasetId: started.datasetId,
        status: started.status,
        fallback: true,
        userContinue: true,
        fallbackSource: source,
        tags: searched,
        baselineSaved: baseline,
        ...accountOnRun(started),
        ...(tier ? { expansionTier: tier } : {}),
      });
      if (typeof job.app_id === 'string') await recordTagScrapes(sb, job.app_id, searched);
      const baseFunnel: DiscoveryFunnel = {
        ...(funnel ?? {
          rawItems: 0,
          uniqueCreators: 0,
          afterFollowers: 0,
          afterDedupe: 0,
          withEmail: 0,
          saved: 0,
          followerMin: job.follower_min != null ? Number(job.follower_min) : null,
          followerMax: job.follower_max != null ? Number(job.follower_max) : null,
          apifyRunIds: [],
        }),
      };
      delete baseFunnel.expansionCustom;
      const nextFunnel: DiscoveryFunnel = {
        ...baseFunnel,
        continueUsed: 'expand',
        fallbackTags: searched,
        fallbackSource: source,
        expansionCascade: true,
        expansionRounds: 1,
        expansionBaseline: baseline,
        expansionLog: [],
        expansionPlan: tiers,
        runBudgetUsd: budgetUsd,
        runSpentUsd: spentUsd + started.chargeUsd,
        ...accountFunnelFields(pool, runs),
        ...(tier ? { expansionTier: tier } : {}),
        ...(custom ? { expansionCustom: custom.tags } : {}),
        ...(expansionChoice
          ? {
              suggestedTags: expansionChoice.nextSuggestions,
              eligibleSuggestions: expansionChoice.nextSuggestions,
              ...(expansionChoice.skipped.length > 0 ? { skippedTags: expansionChoice.skipped } : {}),
              ...(expansionChoice.rotation ? { categoryRotation: expansionChoice.rotation } : {}),
            }
          : {}),
      };
      await sb
        .from('discovery_jobs')
        .update({ status: 'running', runs, funnel: nextFunnel, error: null })
        .eq('id', jobId);
      return {
        statusCode: 202,
        body: {
          ok: true,
          status: 'running',
          action,
          tags: searched,
          rounds: 1,
          message: `Searching ${searched.join(', ')}… · ${expansionRoundLabel(1)}. Up to ${EXPANSION_ROUNDS_PER_CLICK} rounds if nobody new is found. Nothing is emailed.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Apify did not start the extra search.';
      return { statusCode: 502, body: { ok: false, error: message } };
    }
  }

  if (job.require_public_email === false || funnel?.requirePublicEmail === false) {
    return {
      statusCode: 400,
      body: { ok: false, error: 'Require public email is already off for this search.' },
    };
  }
  if (funnel?.continueUsed === 'relax' || funnel?.emailRelaxed === true) {
    return {
      statusCode: 409,
      body: { ok: false, error: 'Public email was already relaxed for this batch.' },
    };
  }

  const followerMin = job.follower_min != null ? Number(job.follower_min) : null;
  const followerMax = job.follower_max != null ? Number(job.follower_max) : null;
  const resultLimit = savedResultLimit(Number(job.result_limit) || 10);
  const queryKey = discoveryQueryKey({
    niche: String(job.niche || ''),
    hashtags,
    platforms: Array.isArray(job.platforms) ? (job.platforms as string[]) : [],
    followerMin,
    followerMax,
    limit: resultLimit,
    requirePublicEmail: true,
    source: asDiscoverySource(job.discovery_source) ?? 'hashtags',
  });
  const cached = await readDiscoveryCache(sb, queryKey);
  if (!cached || cached.length === 0) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error:
          'This search did not keep creators without a public email, so there is nothing further to add without another Apify run.',
      },
    };
  }
  const partitioned = await partitionDiscoveryHits(
    sb,
    job.app_id as string | null,
    cached,
    false,
    RESULT_LIMIT_MAX,
  );
  const hits = mergeStoredHits(asStoredHits(job.results), partitioned.hits);
  const includeCrm = job.include_existing === true;
  const saved = hits.filter((hit) => !hit.existing).length;
  const existing = hits.filter((hit) => hit.existing).length;
  const nextFunnel: DiscoveryFunnel = {
    ...(funnel ?? {
      rawItems: cached.length,
      uniqueCreators: cached.length,
      afterFollowers: cached.length,
      afterDedupe: partitioned.fresh.length,
      withEmail: 0,
      saved: 0,
      followerMin,
      followerMax,
      apifyRunIds: [],
      requirePublicEmail: true,
    }),
    saved,
    existing,
    finished: creatorsTowardTarget(saved, existing, includeCrm),
    continueUsed: 'relax',
    emailRelaxed: true,
    requirePublicEmail: true,
  };
  const { error: updateError } = await sb
    .from('discovery_jobs')
    .update({ results: hits, funnel: nextFunnel, error: null })
    .eq('id', jobId);
  if (updateError) return { statusCode: 500, body: { ok: false, error: updateError.message } };
  const added = Math.max(0, hits.length - asStoredHits(job.results).length);
  const message =
    added === 0
      ? 'No further creators without a public email were kept from this batch. Require public email stays on.'
      : added === 1
        ? 'Kept 1 more creator from this batch without requiring a public email. Require public email stays on.'
        : `Kept ${added} more creators from this batch without requiring a public email. Require public email stays on.`;
  return {
    statusCode: 200,
    body: {
      ok: true,
      status: 'succeeded',
      action: 'relax',
      candidates: hits,
      funnel: nextFunnel,
      message,
    },
  };
}
