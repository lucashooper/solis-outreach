import type { Platform } from '../types.js';
import { fitsRunBudget, monthlyLimitMessage, networkPhaseBudgetUsd, roundUsd } from './budget.js';
import { actualRunChargeUsd, usageFromApifyRun, type ApifyRunUsage } from './charge.js';
import {
  ALL_ACCOUNTS_EXHAUSTED_MESSAGE,
  ApifyAccountLimitedError,
  createApifyPool,
  isApifyCreditError,
  scrubApifySecrets,
  summariseAccountSpend,
  TIKTOK_CHARGE_FLOOR_USD,
  type ApifyPool,
  type ApifyRoundSpend,
  resolveRunBudget,
} from './apifyPool.js';
import { mapApifyDatasetItems, mergeProfileEmails } from './apifyParsers.js';
import { fetchBioLinkEmails } from './bioLinkEmail.js';
import { hasUsablePublicEmail } from './email.js';
import type { NicheScore } from './nicheScore.js';
import { creatorMatchKey } from './queryCache.js';
import { hashtagStageLabel, networkStageLabel, savingStageLabel } from './progress.js';
import { mergeCandidate, passesEngagementMinimum, qualifyCandidates } from './qualify.js';
import {
  buildExpansionTiers,
  EXPANSION_ROUNDS_PER_CLICK,
  shouldChainRound,
} from './expansionTiers.js';
import { FALLBACK_VIDEO_CAP, suggestFallbackHashtags } from './fallbackTags.js';
import {
  apifyChargeCapUsd,
  followersChargeCapUsd,
  PROFILE_ENRICH_CAP,
  profileEnrichEnabled,
  rawVideoBudget,
  savedResultLimit,
  selectCreatorsToSave,
  TIKTOK_RESULT_USD,
  wantsPublicEmail,
} from './funnel.js';
import { campaignSearchTerms, normaliseHashtags } from './hashtags.js';
import { sampleCountsForTags, scoreHashtagYield, type HashtagYield } from './hashtagYield.js';
import {
  buildFollowersActorInput,
  emptyNetworkStats,
  filterNetworkBatch,
  FOLLOWERS_ACTOR_DEFAULT,
  mergeNetworkStats,
  planFollowUpNetworkBatch,
  relevanceCategoryIds,
  relevanceKeywords,
  type DiscoverySource,
  type NetworkFunnelStats,
} from './network.js';
import { selectExpansionTags } from './tagMemory.js';
import { chooseExpansionTags } from './eligibleTags.js';
import type { SkippedTag } from './tagCooldown.js';
import { logDiscovery } from './runOutcome.js';
import type { Campaign, CreatorCandidate, DiscoveryFunnel, DiscoveryRunResult } from './types.js';

export type PartialDiscoveryHandler = (candidates: CreatorCandidate[]) => void | Promise<void>;
export type YieldHandler = (rows: HashtagYield[]) => void | Promise<void>;

export interface ApifyClientOptions {
  token?: string;
  /** Override TikTok actor id (username/actor or username~actor). */
  tiktokActorId?: string;
  /** Override Instagram actor id. */
  instagramActorId?: string;
  /** Override the TikTok following-list actor. */
  followersActorId?: string;
  /** network, hashtags, or both. Unset keeps the hashtag search used by older callers. */
  discoverySource?: DiscoverySource;
  /** CRM handles to mine. Empty means there is nothing to mine. */
  networkSeeds?: string[];
  /** platform:handle keys already stored for this app. */
  knownCreatorKeys?: ReadonlySet<string>;
  /** When true, known CRM handles do not count toward the target and are not emitted. */
  excludeKnownFromGoal?: boolean;
  /** Hashtags after the 10-day cooldown. Empty skips the hashtag actor. */
  hashtagTags?: string[];
  skippedTags?: SkippedTag[];
  /** Tags an expand round must not search: cooldown, suppression, campaign hashtags. */
  blockedExpansionTags?: string[];
  /** Niche keywords for the following-list relevance check. */
  relevanceTerms?: string[];
  /** @deprecated Prefer tiktokActorId / instagramActorId / env per-platform. */
  actorId?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Shared account pool. Dataset reads stay on the account that started the run. */
  pool?: ApifyPool;
  /** Max wait for actor run (ms). Default 180s. */
  timeoutMs?: number;
  /** Poll interval (ms). Default 2500. */
  pollIntervalMs?: number;
  /** Called with newly qualified creators while an actor dataset is still growing. */
  onPartial?: PartialDiscoveryHandler;
  /** Yield scored from creators already collected. No extra Apify call. */
  onYield?: YieldHandler;
  /**
   * When true, a short search may run one extra Apify pass of up to 2 related tags.
   * Minimum creators does not add its own page while this is on.
   */
  aiFallback?: boolean;
  /**
   * platform:handle keys already in the CRM. Filled during streaming, before profile lookup,
   * so those profiles are not scraped again.
   */
  skipProfileHandles?: ReadonlySet<string>;
  /** Set when the user stops the search. In-flight actor runs are aborted. */
  shouldStop?: () => Promise<boolean>;
  /** Qualifying yield from the last time each seed was mined. */
  seedYield?: ReadonlyMap<string, number>;
  /** Live funnel snapshot. Called after each actor run. */
  onProgress?: (patch: Partial<DiscoveryFunnel>) => void | Promise<void>;
  /** Scores already stored for these handles. Re-seen accounts are not sent to Groq again. */
  nicheCache?: Map<string, NicheScore>;
}

/** The search was stopped from the campaign page. Saved creators stay saved. */
export class DiscoveryStoppedError extends Error {
  constructor() {
    super('Search stopped.');
    this.name = 'DiscoveryStoppedError';
  }
}

const APIFY_BASE = 'https://api.apify.com/v2';

function encodeActorId(actorId: string): string {
  // Apify accepts username~actor-name in the path
  const normalised = actorId.trim().replace(/\//g, '~');
  return encodeURIComponent(normalised);
}

function resolvePlatforms(campaign: Campaign): Platform[] {
  const raw = (campaign.platforms ?? []).map((p) => p.toLowerCase().trim());
  if (raw.length === 0 || raw.includes('both')) {
    return ['tiktok', 'instagram'];
  }
  const out: Platform[] = [];
  if (raw.includes('tiktok')) out.push('tiktok');
  if (raw.includes('instagram')) out.push('instagram');
  return out.length ? out : ['tiktok'];
}

export function actorForPlatform(
  platform: Platform,
  options: ApifyClientOptions,
): string {
  if (platform === 'tiktok') {
    return (
      options.tiktokActorId ??
      process.env.APIFY_TIKTOK_ACTOR ??
      options.actorId ??
      process.env.APIFY_ACTOR_ID ??
      'clockworks/tiktok-scraper'
    );
  }
  return (
    options.instagramActorId ??
    process.env.APIFY_INSTAGRAM_ACTOR ??
    options.actorId ??
    process.env.APIFY_ACTOR_ID ??
    'apify/instagram-scraper'
  );
}

/** Expand niche keywords into TikTok-friendly hashtags + search queries. */
export function nicheSearchTerms(niches: string[]): {
  hashtags: string[];
  searchQueries: string[];
} {
  const cleaned = niches
    .map((n) => n.replace(/^#/, '').trim())
    .filter(Boolean);
  const hashtags: string[] = [];
  const searchQueries: string[] = [];
  for (const n of cleaned) {
    const compact = n.toLowerCase().replace(/\s+/g, '');
    const words = n.toLowerCase();
    for (const tag of [compact, `${compact}tok`, `${compact}creator`, `${compact}tips`]) {
      if (tag && !hashtags.includes(tag)) hashtags.push(tag);
    }
    for (const q of [
      words,
      `${words} creator`,
      `${words} influencer`,
      `${words} content creator`,
    ]) {
      if (q && !searchQueries.includes(q)) searchQueries.push(q);
    }
  }
  if (!hashtags.length) hashtags.push('creator', 'creatoradvice', 'ugc');
  if (!searchQueries.length) {
    searchQueries.push('content creator', 'ugc creator', 'influencer collab');
  }
  return { hashtags: hashtags.slice(0, 12), searchQueries: searchQueries.slice(0, 8) };
}

/** Hard cap so a campaign cannot ask the actor for a large pool. */
export function cappedResultLimit(limit: number | null | undefined): number {
  return savedResultLimit(limit);
}

/** One extra page when a search is short of Minimum creators. Not a loop. */
export const TOP_UP_PAGE = 15;

export function buildTopUpActorInput(
  campaign: Campaign,
  platform: Platform,
): { kind: 'hashtag' | 'query'; input: Record<string, unknown> } | null {
  const niches = (campaign.niches ?? []).map((n) => n.replace(/^#/, '').trim()).filter(Boolean);
  const full = campaignSearchTerms(campaign, nicheSearchTerms(niches));
  const used = cappedSearchTerms(full);
  const extraTag = full.hashtags.find((tag) => !used.hashtags.includes(tag));
  const base = used.hashtags[0] || used.searchQueries[0] || full.hashtags[0];
  const extraQuery =
    full.searchQueries.find((query) => !used.searchQueries.includes(query) && query !== extraTag) ||
    (base ? `${base} tips` : '');
  const query =
    extraQuery && !used.searchQueries.includes(extraQuery) && extraQuery !== extraTag
      ? extraQuery
      : '';

  const page = TOP_UP_PAGE;
  const shared = {
    resultsPerPage: page,
    maxProfilesPerQuery: page,
    resultsLimit: page,
    searchLimit: page,
    savedResultLimit: 5,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadAvatars: false,
    shouldDownloadSlideshowImages: false,
    scrapeAdditionalAuthorMeta: false,
    proxyConfiguration: { useApifyProxy: true },
  };

  if (platform === 'tiktok') {
    if (extraTag) {
      return {
        kind: 'hashtag',
        input: { ...shared, hashtags: [extraTag], searchQueries: [] },
      };
    }
    if (!query) return null;
    return {
      kind: 'query',
      input: { ...shared, hashtags: [], searchQueries: [query] },
    };
  }

  const search = extraTag || query;
  if (!search) return null;
  return {
    kind: extraTag ? 'hashtag' : 'query',
    input: {
      search,
      searchType: 'hashtag',
      searchLimit: page,
      resultsLimit: page,
      savedResultLimit: 5,
      resultsType: 'posts',
      enhanceUserSearchWithFacebookPage: false,
    },
  };
}

/**
 * One extra hashtag run when AI fallback is on and the first search is short.
 * At most two TikTok tags, or one Instagram tag, and a small video page.
 */
export function buildFallbackActorInput(
  platform: Platform,
  tags: string[],
): Record<string, unknown> | null {
  const clean: string[] = [];
  for (const tag of tags) {
    const name = tag.replace(/^#+/, '').trim().toLowerCase();
    if (!name || clean.includes(name)) continue;
    clean.push(name);
    if (clean.length >= 2) break;
  }
  if (clean.length === 0) return null;
  const page = FALLBACK_VIDEO_CAP;
  if (platform === 'tiktok') {
    return {
      hashtags: clean,
      searchQueries: [],
      resultsPerPage: page,
      maxProfilesPerQuery: page,
      resultsLimit: page,
      savedResultLimit: 5,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadAvatars: false,
      shouldDownloadSlideshowImages: false,
      scrapeAdditionalAuthorMeta: false,
      expandRound: true,
      proxyConfiguration: { useApifyProxy: true },
    };
  }
  return {
    search: clean[0],
    expandRound: true,
    searchType: 'hashtag',
    searchLimit: page,
    resultsLimit: page,
    savedResultLimit: 5,
    resultsType: 'posts',
    enhanceUserSearchWithFacebookPage: false,
  };
}

function tagsFromActorInput(input: Record<string, unknown>): string[] {
  if (Array.isArray(input.hashtags)) {
    return normaliseHashtags(input.hashtags.map((tag) => String(tag)));
  }
  if (typeof input.search === 'string') return normaliseHashtags([input.search]);
  return [];
}

/**
 * At most two hashtags and a single search query.
 * Extra niche variants used to multiply resultsPerPage.
 */
/** How many videos per hashtag still fit the dollars left for this call. */
export function pageSizedForBudget(perTerm: number, tagCount: number, budgetUsd?: number): number {
  const wanted = Math.max(1, Math.floor(perTerm) || 1);
  if (budgetUsd == null || !(budgetUsd > 0)) return wanted;
  const tags = Math.max(1, Math.floor(tagCount) || 1);
  const affordable = Math.floor(Math.max(0, budgetUsd - 0.05) / TIKTOK_RESULT_USD);
  if (affordable < 1) return 1;
  return Math.max(1, Math.min(wanted, Math.floor(affordable / tags)));
}

export function cappedSearchTerms(
  terms: {
    hashtags: string[];
    searchQueries: string[];
  },
  maxHashtags = 2,
): { hashtags: string[]; searchQueries: string[] } {
  const hashtags: string[] = [];
  for (const tag of terms.hashtags) {
    const clean = tag.replace(/^#+/, '').trim().toLowerCase();
    if (clean && !hashtags.includes(clean)) hashtags.push(clean);
  }
  const tags = hashtags.slice(0, Math.max(1, maxHashtags));
  const searchQueries: string[] = [];
  for (const query of [tags[0], ...terms.searchQueries]) {
    const clean = String(query ?? '').trim().toLowerCase();
    if (!clean || searchQueries.includes(clean)) continue;
    searchQueries.push(clean);
    if (searchQueries.length >= 1) break;
  }
  return { hashtags: tags, searchQueries };
}

/**
 * Videos to request in total. Many rows are the same creator or outside the
 * follower window. A normal search asks for 3× the saved limit (max 300).
 * Require-public-email searches ask for 5× (max 100) so more bios are sampled
 * before the small in-range profile lookup.
 */
export function rawItemTarget(
  limit: number | null | undefined,
  requirePublicEmail = false,
): number {
  return rawVideoBudget(limit, requirePublicEmail);
}

/** Split the raw budget across hashtags and queries so three terms do not triple the bill. */
export function perTermResultCount(
  limit: number | null | undefined,
  termCount: number,
  requirePublicEmail = false,
): number {
  const terms = Math.max(1, Math.floor(termCount) || 1);
  return Math.max(1, Math.ceil(rawItemTarget(limit, requirePublicEmail) / terms));
}

/** 1024 MB is the lowest memory these browser actors reliably start with. */
export function apifyRunControls(
  limit: number,
  requirePublicEmail = false,
): {
  memory: number;
  timeoutSecs: number;
  maxItems: number;
  maxTotalChargeUsd: number;
} {
  const maxItems = rawItemTarget(limit, requirePublicEmail);
  return {
    memory: 1024,
    timeoutSecs: 90,
    maxItems,
    maxTotalChargeUsd: apifyChargeCapUsd(limit, requirePublicEmail),
  };
}

/** savedResultLimit is for our cost cap. It is not an actor field. */
export function apifyActorBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      key === 'savedResultLimit' ||
      key === 'requirePublicEmail' ||
      key === 'profileEnrich' ||
      key === 'networkScrape' ||
      key === 'expandRound' ||
      key === 'chargeCapUsd'
    ) {
      continue;
    }
    body[key] = value;
  }
  return body;
}

export function followersActorId(options: ApifyClientOptions = {}): string {
  return (
    options.followersActorId ??
    process.env.APIFY_FOLLOWERS_ACTOR ??
    FOLLOWERS_ACTOR_DEFAULT
  );
}

/** True when Apify refused the run because maxTotalChargeUsd was below the actor floor. */
export function isChargeFloorError(message: string): boolean {
  return /max-total-charge|maxTotalChargeUsd/i.test(message) && !/hard limit|monthly usage/i.test(message);
}

export function networkChargeError(message: string): string {
  if (isChargeFloorError(message)) {
    return 'Apify rejected the creator-network cost cap. The followers actor needs a higher maximum charge than this run can set, so no following lists were read.';
  }
  return message;
}

export function controlsForActorInput(input: Record<string, unknown>): {
  memory: number;
  timeoutSecs: number;
  maxItems: number;
  maxTotalChargeUsd: number;
} {
  const controls = controlsForActorInputRaw(input);
  const cap = Number(input.chargeCapUsd);
  if (!Number.isFinite(cap) || cap <= 0) return controls;
  return { ...controls, maxTotalChargeUsd: Math.min(controls.maxTotalChargeUsd, cap) };
}

function controlsForActorInputRaw(input: Record<string, unknown>): {
  memory: number;
  timeoutSecs: number;
  maxItems: number;
  maxTotalChargeUsd: number;
} {
  if (input.networkScrape === true) {
    const profiles = Array.isArray(input.profiles) ? input.profiles.length : 1;
    const per = Number(input.maxFollowingPerProfile) || 30;
    const maxItems = Math.max(1, profiles) * Math.max(1, per);
    return {
      memory: 1024,
      timeoutSecs: 120,
      maxItems,
      maxTotalChargeUsd: followersChargeCapUsd(maxItems),
    };
  }
  if (input.expandRound === true) {
    const tags = Array.isArray(input.hashtags)
      ? input.hashtags.length
      : typeof input.search === 'string'
        ? 1
        : 1;
    const per = Number(input.resultsPerPage) || FALLBACK_VIDEO_CAP;
    const maxItems = Math.max(1, tags) * Math.max(1, per);
    const estimate = maxItems * TIKTOK_RESULT_USD + 0.05;
    const cents = Math.round(estimate * 100);
    const stepped = (Math.ceil(cents / 5) * 5) / 100;
    return {
      memory: 1024,
      timeoutSecs: 120,
      maxItems,
      maxTotalChargeUsd: Math.min(1, Math.max(0.5, stepped)),
    };
  }
  if (input.profileEnrich === true) {
    const profiles = Array.isArray(input.profiles) ? input.profiles.length : 0;
    const urls = Array.isArray(input.directUrls) ? input.directUrls.length : 0;
    const items = Math.max(1, Math.min(PROFILE_ENRICH_CAP, profiles || urls || 1));
    return {
      memory: 1024,
      timeoutSecs: 90,
      maxItems: items,
      maxTotalChargeUsd: 0.5,
    };
  }
  const saved = Number(input.savedResultLimit);
  const limit = Number.isFinite(saved) && saved > 0 ? saved : Number(input.resultsLimit) || 10;
  return apifyRunControls(limit, input.requirePublicEmail === true);
}

export function buildApifyActorInput(
  campaign: Campaign,
  platform: Platform,
  options?: { hashtagBudgetUsd?: number; keepExplicitHashtags?: boolean },
): Record<string, unknown> {
  const niches = (campaign.niches ?? []).map((n) => n.replace(/^#/, '').trim()).filter(Boolean);
  const terms = campaignSearchTerms(campaign, nicheSearchTerms(niches));
  const maxHashtags = options?.keepExplicitHashtags ? 12 : 2;
  const { hashtags, searchQueries } = cappedSearchTerms(terms, maxHashtags);
  const requireEmail = wantsPublicEmail(campaign.require_public_email);
  const termCount = platform === 'tiktok' ? hashtags.length + searchQueries.length : 1;
  const perTerm = pageSizedForBudget(
    perTermResultCount(campaign.result_limit, termCount, requireEmail),
    hashtags.length || 1,
    options?.hashtagBudgetUsd,
  );

  if (platform === 'tiktok') {
    return {
      hashtags,
      searchQueries,
      resultsPerPage: perTerm,
      maxProfilesPerQuery: perTerm,
      resultsLimit: perTerm,
      savedResultLimit: campaign.result_limit,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadAvatars: false,
      shouldDownloadSlideshowImages: false,
      // Full profile lookup runs later, and only for in-range creators missing an email.
      scrapeAdditionalAuthorMeta: false,
      requirePublicEmail: requireEmail,
      proxyConfiguration: { useApifyProxy: true },
      ...(options?.hashtagBudgetUsd && options.hashtagBudgetUsd > 0
        ? { chargeCapUsd: options.hashtagBudgetUsd }
        : {}),
    };
  }

  return {
    search: hashtags[0] || (niches.length ? niches[0] : 'influencer'),
    searchType: 'hashtag',
    searchLimit: perTerm,
    resultsLimit: perTerm,
    savedResultLimit: campaign.result_limit,
    resultsType: 'posts',
    requirePublicEmail: requireEmail,
    enhanceUserSearchWithFacebookPage: false,
  };
}

/**
 * One cheap profile pass for creators already inside the follower window.
 * One video per profile so the actor returns the profile bio. Capped so this
 * stays around a few cents, under the $0.50 Apify minimum charge ceiling.
 */
export function buildProfileEnrichInput(
  platform: Platform,
  handles: string[],
): Record<string, unknown> | null {
  const clean: string[] = [];
  for (const handle of handles) {
    const name = handle.replace(/^@/, '').trim();
    if (!name || clean.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    clean.push(name);
    if (clean.length >= PROFILE_ENRICH_CAP) break;
  }
  if (!clean.length) return null;
  if (platform === 'tiktok') {
    return {
      profiles: clean,
      resultsPerPage: 1,
      profileScrapeSections: ['videos'],
      profileSorting: 'latest',
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadAvatars: false,
      shouldDownloadSlideshowImages: false,
      scrapeRelatedVideos: false,
      commentsPerPost: 0,
      profileEnrich: true,
    };
  }
  return {
    directUrls: clean.map((name) => `https://www.instagram.com/${encodeURIComponent(name)}/`),
    resultsType: 'details',
    resultsLimit: clean.length,
    profileEnrich: true,
  };
}

export function handlesMissingEmail(
  candidates: CreatorCandidate[],
  cap = PROFILE_ENRICH_CAP,
): CreatorCandidate[] {
  const seen = new Set<string>();
  const missing: CreatorCandidate[] = [];
  for (const candidate of candidates) {
    if (hasUsablePublicEmail(candidate.email) || !candidate.handle?.trim()) continue;
    const key = `${candidate.platform}:${candidate.handle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(candidate);
    if (missing.length >= cap) break;
  }
  return missing;
}

/** Look up profiles only for the capped in-range set that still has no email. */
export async function enrichMissingProfileEmails(
  candidates: CreatorCandidate[],
  options: ApifyClientOptions,
): Promise<{ candidates: CreatorCandidate[]; runIds: string[]; rounds: ApifyRoundSpend[] }> {
  const skip = options.skipProfileHandles;
  const pool = skip
    ? candidates.filter((row) => !skip.has(creatorMatchKey(row.platform, row.handle)))
    : candidates;
  const groups = new Map<Platform, CreatorCandidate[]>();
  for (const row of handlesMissingEmail(pool)) {
    const list = groups.get(row.platform) ?? [];
    list.push(row);
    groups.set(row.platform, list);
  }
  let next = candidates;
  const runIds: string[] = [];
  const rounds: ApifyRoundSpend[] = [];
  for (const [platform, rows] of groups) {
    const input = buildProfileEnrichInput(
      platform,
      rows.map((row) => row.handle),
    );
    const actorId = actorForPlatform(platform, options);
    if (!input || !actorId.trim()) continue;
    try {
      const loaded = await runApifyActorAndGetItems(actorId, input, options);
      if (loaded.runId) runIds.push(loaded.runId);
      rounds.push({
        accountIndex: loaded.accountIndex,
        accountLabel: loaded.accountLabel,
        chargeUsd: loaded.chargeUsd,
        ...(loaded.runId ? { runId: loaded.runId } : {}),
        kind: 'profile',
      });
      next = mergeProfileEmails(next, loaded.items, platform);
    } catch (err) {
      console.warn(
        '[discovery] profile enrich skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { candidates: next, runIds, rounds };
}

export function formatApifyError(status: number, body: string): string {
  const text = body || '';
  if (status === 401 || /invalid api token|unauthori[sz]ed|authentication token is not valid/i.test(text)) {
    return 'Apify rejected the token. Check APIFY_TOKEN on the server.';
  }
  if (/max-total-charge|maxTotalChargeUsd/i.test(text)) {
    return 'Apify stopped this search because it hit the cost cap.';
  }
  if (
    /usage hard limit|hard limit exceeded|platform-feature-disabled|monthly usage|insufficient credit|monthly limit|all connected apify accounts are out of credit/i.test(
      text,
    )
  ) {
    return ALL_ACCOUNTS_EXHAUSTED_MESSAGE;
  }
  if (/timed?-out|timeout/i.test(text)) {
    return 'Apify timed out before the search finished. Try again in a moment.';
  }
  return `Apify actor start failed (${status}): ${text.slice(0, 300) || 'the actor did not start'}`;
}

export function formatApifyRunStatus(status: string, statusMessage?: string | null): string {
  const detail = (statusMessage || '').replace(/\s+/g, ' ').trim();
  if (status === 'TIMED-OUT' || /timed?-out|timeout/i.test(detail)) {
    return 'Apify timed out before the search finished. Try again in a moment.';
  }
  if (detail) {
    const classified = formatApifyError(0, detail);
    if (!classified.startsWith('Apify actor start failed')) return classified;
    return `Apify ended the search (${status}): ${detail.slice(0, 240)}`;
  }
  return `Apify ended the search as ${status}. No creators were added.`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export interface ApifyCallOptions {
  /** Single-account override for tests. Production callers use `pool` or the environment list. */
  token?: string;
  pool?: ApifyPool;
  fetchImpl?: typeof fetch;
  /** 1-based account that started this run. Dataset and poll reads must pass it. */
  accountIndex?: number;
}

export interface StartedApifyRun {
  runId: string;
  datasetId: string | null;
  status: string;
  accountIndex: number;
  accountLabel: string;
  chargeUsd: number;
}

function poolForCall(
  options: ApifyCallOptions,
  binding?: { runId?: string; datasetId?: string | null },
): ApifyPool {
  const pool =
    options.pool ??
    createApifyPool({
      tokens: options.token != null ? [options.token] : undefined,
      fetchImpl: options.fetchImpl,
      bindings:
        options.accountIndex && (binding?.runId || binding?.datasetId)
          ? [
              {
                runId: binding?.runId ?? '',
                datasetId: binding?.datasetId,
                accountIndex: options.accountIndex,
              },
            ]
          : [],
    });
  if (options.accountIndex && binding?.runId) {
    pool.remember(binding.runId, binding.datasetId ?? null, options.accountIndex);
  } else if (options.accountIndex && binding?.datasetId) {
    pool.remember('', binding.datasetId, options.accountIndex);
  }
  return pool;
}

function tokenForRead(
  pool: ApifyPool,
  kind: 'run' | 'dataset',
  id: string,
  accountIndex?: number,
): string {
  const bound =
    accountIndex ??
    (kind === 'run' ? pool.accountIndexForRun(id) : pool.accountIndexForDataset(id));
  // Older runs predate failover and were started on the primary account.
  const index = bound ?? 1;
  return pool.tokenForAccount(index);
}

async function postActorRun(
  actorId: string,
  input: Record<string, unknown>,
  token: string,
  chargeUsd: number,
  fetchImpl: typeof fetch,
): Promise<{ runId: string; datasetId: string | null; status: string }> {
  const encoded = encodeActorId(actorId);
  const controls = controlsForActorInput(input);
  const startUrl =
    `${APIFY_BASE}/acts/${encoded}/runs?token=${encodeURIComponent(token)}` +
    `&memory=${controls.memory}&timeout=${controls.timeoutSecs}` +
    `&maxItems=${controls.maxItems}&maxTotalChargeUsd=${chargeUsd}`;
  const startRes = await fetchImpl(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(apifyActorBody(input)),
  });
  if (!startRes.ok) {
    const body = await startRes.text().catch(() => '');
    const safe = scrubApifySecrets(body, [token]);
    if (isApifyCreditError(startRes.status, body)) {
      throw new ApifyAccountLimitedError(formatApifyError(startRes.status, safe));
    }
    if (input.networkScrape === true && isChargeFloorError(body)) {
      throw new Error(`maxTotalChargeUsd rejected: ${safe.slice(0, 240)}`);
    }
    throw new Error(formatApifyError(startRes.status, safe));
  }
  const startJson = (await startRes.json()) as {
    data?: { id?: string; defaultDatasetId?: string; status?: string };
  };
  const runId = startJson.data?.id ?? '';
  if (!runId) throw new Error('Apify actor start did not return a run id');
  return {
    runId,
    datasetId: startJson.data?.defaultDatasetId ?? null,
    status: startJson.data?.status ?? 'RUNNING',
  };
}

/** Start an actor run and return immediately. Polling stays with the caller. */
export async function startApifyActorRun(
  actorId: string,
  input: Record<string, unknown>,
  options: ApifyCallOptions,
): Promise<StartedApifyRun> {
  const pool = poolForCall(options);
  const fetchImpl = options.fetchImpl ?? pool.fetchImpl;
  const controls = controlsForActorInput(input);
  const planned = controls.maxTotalChargeUsd;
  const minCharge =
    input.networkScrape === true ? Math.min(planned, 0.02) : TIKTOK_CHARGE_FLOOR_USD;

  const place = async (chargeUsd: number, floor: number) => {
    const funded = await pool.runWithFailover({
      plannedChargeUsd: chargeUsd,
      minChargeUsd: floor,
      execute: async (ctx) => postActorRun(actorId, input, ctx.token, ctx.chargeUsd, fetchImpl),
    });
    pool.remember(funded.result.runId, funded.result.datasetId, funded.accountIndex);
    return {
      ...funded.result,
      accountIndex: funded.accountIndex,
      accountLabel: funded.accountLabel,
      chargeUsd: funded.chargeUsd,
    };
  };

  try {
    return await place(planned, minCharge);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Followers-scraper may share the video actor's $0.50 floor. Retry once there.
    if (
      input.networkScrape === true &&
      isChargeFloorError(message) &&
      planned < TIKTOK_CHARGE_FLOOR_USD
    ) {
      try {
        return await place(TIKTOK_CHARGE_FLOOR_USD, TIKTOK_CHARGE_FLOOR_USD);
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(networkChargeError(scrubApifySecrets(retryMessage, [])));
      }
    }
    if (input.networkScrape === true && isChargeFloorError(message)) {
      throw new Error(networkChargeError(message));
    }
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function getApifyActorRun(
  runId: string,
  options: ApifyCallOptions,
): Promise<{
  status: string;
  datasetId: string | null;
  statusMessage: string | null;
  usage: ApifyRunUsage;
}> {
  const pool = poolForCall(options, { runId });
  const fetchFn = options.fetchImpl ?? pool.fetchImpl;
  const token = tokenForRead(pool, 'run', runId, options.accountIndex);
  const pollUrl = `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`;
  const pollRes = await fetchFn(pollUrl);
  if (!pollRes.ok) {
    const body = await pollRes.text().catch(() => '');
    throw new Error(
      `Apify run poll failed (${pollRes.status}): ${scrubApifySecrets(body, [token]).slice(0, 300) || pollRes.statusText}`,
    );
  }
  const pollJson = (await pollRes.json()) as {
    data?: Record<string, unknown>;
  };
  const data = pollJson.data ?? {};
  const datasetId = typeof data.defaultDatasetId === 'string' ? data.defaultDatasetId : null;
  const accountIndex = options.accountIndex ?? pool.accountIndexForRun(runId) ?? 1;
  if (datasetId) pool.remember(runId, datasetId, accountIndex);
  return {
    status: typeof data.status === 'string' ? data.status : 'RUNNING',
    datasetId,
    statusMessage: typeof data.statusMessage === 'string' ? data.statusMessage : null,
    usage: usageFromApifyRun(data),
  };
}

export async function fetchApifyDatasetItems(
  datasetId: string,
  options: ApifyCallOptions & { limit?: number },
): Promise<unknown[]> {
  const pool = poolForCall(options, { datasetId });
  const fetchFn = options.fetchImpl ?? pool.fetchImpl;
  const token = tokenForRead(pool, 'dataset', datasetId, options.accountIndex);
  const limit = options.limit ?? 80;
  const itemsUrl =
    `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items` +
    `?token=${encodeURIComponent(token)}&clean=true&format=json&limit=${limit}`;
  const itemsRes = await fetchFn(itemsUrl);
  if (!itemsRes.ok) {
    const body = await itemsRes.text().catch(() => '');
    throw new Error(
      `Apify dataset fetch failed (${itemsRes.status}): ${scrubApifySecrets(body, [token]).slice(0, 500) || itemsRes.statusText}`,
    );
  }
  const raw: unknown = await itemsRes.json();
  return Array.isArray(raw) ? raw : [];
}

/** Stop a run with the same account that started it. */
export async function abortApifyActorRun(runId: string, options: ApifyCallOptions): Promise<void> {
  const pool = poolForCall(options, { runId });
  const fetchFn = options.fetchImpl ?? pool.fetchImpl;
  const token = tokenForRead(pool, 'run', runId, options.accountIndex);
  const abortUrl = `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}/abort?token=${encodeURIComponent(token)}`;
  const abortRes = await fetchFn(abortUrl, { method: 'POST' });
  if (!abortRes.ok) {
    const body = await abortRes.text().catch(() => '');
    throw new Error(
      `Apify abort failed (${abortRes.status}): ${scrubApifySecrets(body, [token]).slice(0, 300) || abortRes.statusText}`,
    );
  }
}

/**
 * Start an Apify actor run, poll until finished, return dataset items.
 * Polls and the dataset read use the account that accepted the start.
 */
export async function runApifyActorAndGetItems(
  actorId: string,
  input: Record<string, unknown>,
  options: ApifyCallOptions & {
    timeoutMs?: number;
    pollIntervalMs?: number;
    /** Fired with the dataset so far whenever it grows, including before the run finishes. */
    onItems?: (items: unknown[]) => void | Promise<void>;
    /** Heartbeat while the actor is still running, including when the dataset has not grown. */
    onTick?: (info: { itemCount: number }) => void | Promise<void>;
    shouldStop?: () => Promise<boolean>;
  },
): Promise<{
  items: unknown[];
  runId: string | null;
  datasetId: string | null;
  accountIndex: number;
  accountLabel: string;
  chargeUsd: number;
}> {
  const pool = poolForCall(options);
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_500;
  const controls = controlsForActorInput(input);
  const started = await startApifyActorRun(actorId, input, {
    pool,
    fetchImpl: options.fetchImpl,
  });
  const runId = started.runId;
  let datasetId = started.datasetId;
  let status = started.status;
  const readOptions: ApifyCallOptions = {
    pool,
    fetchImpl: options.fetchImpl,
    accountIndex: started.accountIndex,
  };

  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
  let previewCount = -1;
  let usage: ApifyRunUsage = {};

  const publishDataset = async () => {
    if (!datasetId || !options.onItems) return;
    try {
      const preview = await fetchApifyDatasetItems(datasetId, {
        ...readOptions,
        limit: controls.maxItems,
      });
      if (preview.length === previewCount) return;
      previewCount = preview.length;
      await options.onItems(preview);
    } catch {
      /* The dataset can 404 until the actor writes its first row. */
    }
  };

  let lastTick = 0;
  const tick = async (force: boolean) => {
    if (!options.onTick) return;
    const now = Date.now();
    if (!force && now - lastTick < 4_000) return;
    lastTick = now;
    await options.onTick({ itemCount: Math.max(0, previewCount) });
  };

  await publishDataset();
  await tick(true);

  while (!terminal.has(status)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Apify timed out before the search finished (run ${runId}). Try again in a moment.`,
      );
    }
    await sleep(pollIntervalMs);
    if (await options.shouldStop?.()) {
      await abortApifyActorRun(runId, readOptions).catch(() => undefined);
      throw new DiscoveryStoppedError();
    }
    const latest = await getApifyActorRun(runId, readOptions);
    status = latest.status;
    usage = latest.usage;
    if (latest.datasetId) datasetId = latest.datasetId;
    const before = previewCount;
    await publishDataset();
    await tick(previewCount !== before);
    if (terminal.has(status) && status !== 'SUCCEEDED') {
      if (status === 'ABORTED' && (await options.shouldStop?.())) throw new DiscoveryStoppedError();
      throw new Error(`${formatApifyRunStatus(status, latest.statusMessage)} (run ${runId})`);
    }
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`${formatApifyRunStatus(status)} (run ${runId})`);
  }

  if (!datasetId) {
    return {
      items: [],
      runId,
      datasetId: null,
      accountIndex: started.accountIndex,
      accountLabel: started.accountLabel,
      chargeUsd: started.chargeUsd,
    };
  }

  const items = await fetchApifyDatasetItems(datasetId, {
    ...readOptions,
    limit: controls.maxItems,
  });
  const chargeUsd = actualRunChargeUsd(usage, started.chargeUsd);
  pool.reconcileSpend(started.accountIndex, started.chargeUsd, chargeUsd);
  return {
    items,
    runId,
    datasetId,
    accountIndex: started.accountIndex,
    accountLabel: started.accountLabel,
    chargeUsd,
  };
}

/**
 * Apify discovery: run platform actors, parse → CreatorCandidate[], cap at result_limit.
 */
export async function runApifyDiscovery(
  campaign: Campaign,
  options: ApifyClientOptions = {},
): Promise<DiscoveryRunResult> {
  const pool =
    options.pool ??
    createApifyPool({
      tokens: options.token != null ? [options.token] : undefined,
      fetchImpl: options.fetchImpl,
    });

  if (!pool.configured) {
    throw new Error(
      'Apify discovery requires APIFY_TOKEN. Set it in the server environment (.env / .env.local.secrets), not localStorage.',
    );
  }
  const accountRounds: ApifyRoundSpend[] = [];
  const noteAccount = (
    row: { runId: string | null; accountIndex: number; accountLabel: string; chargeUsd: number },
    kind: string,
  ) => {
    accountRounds.push({
      accountIndex: row.accountIndex,
      accountLabel: row.accountLabel,
      chargeUsd: row.chargeUsd,
      ...(row.runId ? { runId: row.runId } : {}),
      kind,
    });
  };

  const platforms = resolvePlatforms(campaign);
  const limit = campaign.result_limit ?? 10;
  const niches = campaign.niches ?? [];
  const allCandidates: CreatorCandidate[] = [];
  const queriedTags: string[] = [];
  const aiFallback = options.aiFallback === true;
  const rememberTags = (input: Record<string, unknown>) => {
    for (const tag of tagsFromActorInput(input)) {
      if (!queriedTags.includes(tag)) queriedTags.push(tag);
    }
  };
  const query: Record<string, unknown> = {
    platforms,
    niches,
    hashtags: campaign.hashtags ?? [],
    limit,
    actors: {} as Record<string, string>,
    inputs: {} as Record<string, unknown>,
  };
  const rawRuns: unknown[] = [];
  const emitted = new Set<string>();
  const yieldPool: CreatorCandidate[] = [];
  const samples: Record<string, number> = {};
  const noteSamples = (input: Record<string, unknown>, itemCount: number) => {
    for (const [tag, count] of Object.entries(sampleCountsForTags(tagsFromActorInput(input), itemCount))) {
      samples[tag] = (samples[tag] ?? 0) + count;
    }
  };
  const requireEmail = wantsPublicEmail(campaign.require_public_email);
  const publishYield = async (rows: CreatorCandidate[]) => {
    if (!options.onYield || queriedTags.length === 0) return;
    const scored = scoreHashtagYield(queriedTags, rows, requireEmail, samples);
    if (scored.length === 0) return;
    try {
      await options.onYield(scored);
    } catch (err) {
      console.warn(
        '[discovery] hashtag yield update skipped:',
        err instanceof Error ? err.message : err,
      );
    }
  };
  const relevanceContext = {
    appName: campaign.app_name,
    valueProp: campaign.value_prop,
  };
  const scoreKeywords =
    options.relevanceTerms ??
    relevanceKeywords((campaign.niches ?? []).join(' '), campaign.hashtags ?? [], relevanceContext);
  const scoreCategories = relevanceCategoryIds(
    (campaign.niches ?? []).join(' '),
    campaign.hashtags ?? [],
    relevanceContext,
  );
  const nicheCache = options.nicheCache ?? new Map<string, NicheScore>();
  const bioHits = new Map<string, { email: string; url: string }>();
  const bioMisses = new Set<string>();
  const bioLinkLookup = async (urls: readonly string[]) => {
    const pending = [...new Set(urls)].filter((url) => !bioHits.has(url) && !bioMisses.has(url));
    if (pending.length > 0) {
      const found = await fetchBioLinkEmails(pending, { fetchImpl: options.fetchImpl });
      for (const url of pending) {
        const hit = found.get(url);
        if (hit) bioHits.set(url, hit);
        else bioMisses.add(url);
      }
    }
    const out = new Map<string, { email: string; url: string }>();
    for (const url of urls) {
      const hit = bioHits.get(url);
      if (hit) out.set(url, hit);
    }
    return out;
  };
  const keptKeys = new Set<string>();
  const qualifyCtx = {
    followerMin: campaign.follower_min,
    followerMax: campaign.follower_max,
    engagementMin: campaign.engagement_rate_min,
    keywords: scoreKeywords,
    categories: scoreCategories,
    cache: nicheCache,
    fetchImpl: options.fetchImpl,
    bioLinkLookup,
    onStage: async (label: string) => {
      await options.onProgress?.({
        stage: {
          phase: label.startsWith('Checking bio') ? 'bio_links' : 'scoring',
          label,
          checked: keptKeys.size,
          found: keptKeys.size,
        },
      });
    },
  };
  const inCampaignRange = (candidate: CreatorCandidate): boolean => {
    if (!candidate.handle?.trim()) return false;
    if (campaign.follower_min != null && candidate.follower_count < campaign.follower_min) {
      return false;
    }
    if (campaign.follower_max != null && candidate.follower_count > campaign.follower_max) {
      return false;
    }
    return passesEngagementMinimum(candidate.engagement_rate, campaign.engagement_rate_min);
  };
  const rememberKept = async (rows: CreatorCandidate[]): Promise<CreatorCandidate[]> => {
    const ranged = rows.filter((candidate) => {
      if (!inCampaignRange(candidate)) return false;
      if (!options.excludeKnownFromGoal || !options.knownCreatorKeys) return true;
      return !options.knownCreatorKeys.has(creatorMatchKey(candidate.platform, candidate.handle));
    });
    if (ranged.length === 0) return [];
    const qualified = await qualifyCandidates(ranged, qualifyCtx);
    const fresh: CreatorCandidate[] = [];
    for (const row of qualified.kept) {
      const key = `${row.platform}:${row.handle.toLowerCase()}`;
      if (keptKeys.has(key)) continue;
      if (requireEmail && !hasUsablePublicEmail(row.email)) continue;
      keptKeys.add(key);
      fresh.push(row);
    }
    return fresh;
  };
  const goalMet = () => keptKeys.size >= networkGoal;
  const emitPartial = async (rows: CreatorCandidate[]) => {
    const fresh = await rememberKept(rows);
    if (!options.onPartial || fresh.length === 0) return;
    const delta: CreatorCandidate[] = [];
    for (const candidate of fresh) {
      const key = `${candidate.platform}:${candidate.handle.toLowerCase()}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      delta.push(candidate);
    }
    if (delta.length === 0) return;
    yieldPool.push(...delta);
    try {
      await options.onPartial(delta);
    } catch (err) {
      console.warn(
        '[discovery] partial save skipped:',
        err instanceof Error ? err.message : err,
      );
    }
    await publishYield(yieldPool);
  };

  const budget = await resolveRunBudget({
    pool,
    fetchImpl: options.fetchImpl,
  });
  let spentUsd = 0;
  let runBudgetNote = budget.note;
  const allowCharge = (charge: number): boolean =>
    budget.budgetUsd > 0 && fitsRunBudget(spentUsd, charge, budget.budgetUsd);
  let networkStats: NetworkFunnelStats | null = null;
  const source = options.discoverySource;
  await options.onProgress?.({
    stage: {
      phase: source === 'hashtags' ? 'hashtags' : 'network',
      label: source === 'hashtags' ? 'Scanning hashtags…' : 'Picking seed creators…',
      checked: 0,
      found: 0,
    },
  });
  const networkGoal = Math.max(
    1,
    Number(campaign.min_creators) > 0 ? Number(campaign.min_creators) : limit,
  );
  const searchCampaign: Campaign =
    options.hashtagTags != null ? { ...campaign, hashtags: options.hashtagTags } : campaign;
  let skipHashtags = options.hashtagTags != null && options.hashtagTags.length === 0;
  let resumeNetwork: (() => Promise<void>) | null = null;

  if (source === 'network' || source === 'both') {
    const seeds = options.networkSeeds ?? [];
    if (!platforms.includes('tiktok')) {
      networkStats = emptyNetworkStats(
        source === 'network'
          ? 'Creator network is for TikTok.'
          : 'Creator network is for TikTok. Searched hashtags instead.',
      );
      if (source === 'network') skipHashtags = true;
    } else if (seeds.length === 0) {
      networkStats = emptyNetworkStats(
        source === 'network'
          ? 'No creator-network seeds in the CRM for this app yet.'
          : 'No creator-network seeds in the CRM for this app yet. Searched hashtags instead.',
      );
      if (source === 'network') skipHashtags = true;
    } else if (budget.budgetUsd <= 0) {
      networkStats = emptyNetworkStats(budget.note || ALL_ACCOUNTS_EXHAUSTED_MESSAGE, seeds);
      if (source === 'network') skipHashtags = true;
    } else {
      const networkActor = followersActorId(options);
      const keywords =
        options.relevanceTerms ??
        relevanceKeywords((campaign.niches ?? []).join(' '), campaign.hashtags ?? [], {
          appName: campaign.app_name,
          valueProp: campaign.value_prop,
        });
      const categories = relevanceCategoryIds(
        (campaign.niches ?? []).join(' '),
        campaign.hashtags ?? [],
        { appName: campaign.app_name, valueProp: campaign.value_prop },
      );
      const parts: NetworkFunnelStats[] = [];
      let queue = [...seeds];
      let hopped = false;
      const used = new Set(seeds.map((seed) => seed.replace(/^@/, '').trim().toLowerCase()));
      const hidden = new Set<string>();
      let fresh = 0;
      const hopCandidates: { handle: string; followerCount: number }[] = [];
      const yieldBySeed = options.seedYield;
      const pullNetwork = async (ceiling: number) => {
      while (networkActor.trim()) {
        if (await options.shouldStop?.()) throw new DiscoveryStoppedError();
        const follow = planFollowUpNetworkBatch({
          queue,
          hopped,
          fresh,
          goal: networkGoal,
          spentUsd,
          budgetUsd: ceiling,
          hopCandidates,
          used,
          hidden,
          yieldBySeed,
        });
        if (!follow) {
          if (parts.length === 0 && spentUsd > 0) {
            runBudgetNote = runBudgetNote || `Run budget of $${budget.budgetUsd.toFixed(2)} is used.`;
          }
          break;
        }
        const networkInput = buildFollowersActorInput(
          follow.batch.seeds,
          follow.batch.maxFollowingPerProfile,
        );
        if (!networkInput) break;
        networkInput.chargeCapUsd = follow.batch.maxTotalChargeUsd;
        const batchSeeds = follow.batch.seeds;
        try {
          const { items, runId, datasetId, accountIndex, accountLabel, chargeUsd } =
            await runApifyActorAndGetItems(
            networkActor,
            networkInput,
            {
              pool,
              fetchImpl: options.fetchImpl,
              timeoutMs: options.timeoutMs,
              pollIntervalMs: options.pollIntervalMs,
              shouldStop: options.shouldStop,
              onTick: async ({ itemCount }) => {
                await options.onProgress?.({
                  stage: {
                    phase: 'network',
                    label: networkStageLabel({
                      seeds: batchSeeds.length,
                      checked: itemCount,
                      found: keptKeys.size,
                    }),
                    checked: itemCount,
                    found: keptKeys.size,
                  },
                });
              },
              onItems: async (preview) => {
                const filtered = filterNetworkBatch({
                  rows: preview,
                  seeds: batchSeeds,
                  followerMin: campaign.follower_min,
                  followerMax: campaign.follower_max,
                  requireEmail: false,
                  keywords,
                  knownKeys: options.knownCreatorKeys,
                  niches,
                  categories,
                  includeInRange: true,
                });
                const pool = filtered.inRangeCreators ?? [...filtered.creators, ...filtered.existing];
                await emitPartial(pool);
              },
            },
          );
          spentUsd += chargeUsd;
          noteAccount({ runId, accountIndex, accountLabel, chargeUsd }, 'network');
          const filtered = filterNetworkBatch({
            rows: items,
            seeds: batchSeeds,
            followerMin: campaign.follower_min,
            followerMax: campaign.follower_max,
            requireEmail: false,
            keywords,
            knownKeys: options.knownCreatorKeys,
            niches,
            categories,
            includeInRange: true,
          });
          parts.push(filtered.stats);
          fresh += filtered.stats.fresh;
          queue = follow.queueAfter;
          hopped = follow.hopped;
          for (const seed of batchSeeds) used.add(seed.toLowerCase());
          for (const seed of filtered.stats.hiddenSeeds) hidden.add(seed.toLowerCase());
          for (const row of filtered.creators) {
            hopCandidates.push({ handle: row.handle, followerCount: row.follower_count });
          }
          const found = filtered.inRangeCreators ?? [...filtered.creators, ...filtered.existing];
          allCandidates.push(...found);
          await emitPartial(found);
          await options.onProgress?.({
            stage: {
              phase: 'network',
              label: networkStageLabel({
                seeds: batchSeeds.length,
                checked: items.length,
                found: keptKeys.size,
              }),
              checked: items.length,
              found: keptKeys.size,
            },
            runSpentUsd: spentUsd,
            runBudgetUsd: budget.budgetUsd,
            rawItems: items.length,
          });
          rawRuns.push({
            platform: 'tiktok',
            actorId: networkActor,
            runId,
            datasetId,
            itemCount: items.length,
            network: true,
          });
          (query.actors as Record<string, string>).network = networkActor;
          (query.inputs as Record<string, unknown>).network = networkInput;
          if (goalMet()) break;
        } catch (err) {
          if (err instanceof DiscoveryStoppedError) throw err;
          const message = err instanceof Error ? err.message : 'Creator network did not start.';
          const note = monthlyLimitMessage(message) ? ALL_ACCOUNTS_EXHAUSTED_MESSAGE : message;
          if (parts.length === 0) networkStats = emptyNetworkStats(note, batchSeeds);
          else parts.push(emptyNetworkStats(note, batchSeeds));
          if (source === 'network' && parts.length === 0) throw err;
          break;
        }
      }
      };
      const firstCeiling =
        source === 'both' ? networkPhaseBudgetUsd(budget.budgetUsd, 'both') : budget.budgetUsd;
      await pullNetwork(firstCeiling);
      if (source === 'both') {
        resumeNetwork = async () => {
          await pullNetwork(budget.budgetUsd);
        };
      }
      if (parts.length > 0) {
        networkStats = mergeNetworkStats(parts);
        if (runBudgetNote && !networkStats.note) networkStats = { ...networkStats, note: runBudgetNote };
      }
      if (source === 'network' || goalMet()) skipHashtags = true;
    }
  }

  if (!skipHashtags) for (const platform of platforms) {
    if (goalMet()) break;
    if (await options.shouldStop?.()) throw new DiscoveryStoppedError();
    const actorId = actorForPlatform(platform, options);
    if (!actorId.trim()) {
      throw new Error(
        `Apify discovery requires an actor id for ${platform} (APIFY_TIKTOK_ACTOR / APIFY_INSTAGRAM_ACTOR).`,
      );
    }
    const hashtagBudgetUsd = roundUsd(Math.max(0, budget.budgetUsd - spentUsd));
    const input = buildApifyActorInput(searchCampaign, platform, {
      keepExplicitHashtags: true,
      hashtagBudgetUsd,
    });
    const charge = Math.min(controlsForActorInput(input).maxTotalChargeUsd, hashtagBudgetUsd);
    if (!allowCharge(charge)) {
      runBudgetNote = `Run budget of $${budget.budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`;
      continue;
    }
    rememberTags(input);
    (query.actors as Record<string, string>)[platform] = actorId;
    (query.inputs as Record<string, unknown>)[platform] = input;

    const hashtagTags = Array.isArray(input.hashtags) ? input.hashtags.map((tag) => String(tag)) : [];
    await options.onProgress?.({
      stage: {
        phase: 'hashtags',
        label: hashtagStageLabel(hashtagTags),
        checked: 0,
        found: keptKeys.size,
        tags: hashtagTags,
      },
      runSpentUsd: spentUsd,
      runBudgetUsd: budget.budgetUsd,
    });
    const { items, runId, datasetId, accountIndex, accountLabel, chargeUsd } = await runApifyActorAndGetItems(actorId, input, {
      pool,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      shouldStop: options.shouldStop,
      onTick: async ({ itemCount }) => {
        await options.onProgress?.({
          stage: {
            phase: 'hashtags',
            label: hashtagStageLabel(hashtagTags),
            checked: itemCount,
            found: keptKeys.size,
            tags: hashtagTags,
          },
        });
      },
      onItems: async (preview) => {
        await emitPartial(mapApifyDatasetItems(preview, platform, niches));
      },
    });

    spentUsd += chargeUsd;
    noteAccount({ runId, accountIndex, accountLabel, chargeUsd }, 'hashtag');
    rawRuns.push({ platform, actorId, runId, datasetId, itemCount: items.length });
    noteSamples(input, items.length);
    logDiscovery('apify', {
      platform,
      run: runId,
      items: items.length,
      actor: actorId,
    });
    const mapped = mapApifyDatasetItems(items, platform, niches);
    await emitPartial(mapped);
    allCandidates.push(...mapped);
    await options.onProgress?.({
      stage: {
        phase: 'hashtags',
        label: hashtagStageLabel(hashtagTags),
        checked: items.length,
        found: keptKeys.size,
        tags: hashtagTags,
      },
      runSpentUsd: spentUsd,
      runBudgetUsd: budget.budgetUsd,
    });
  }

  if (resumeNetwork && !goalMet()) {
    await resumeNetwork();
  }

  const narrow = (rows: CreatorCandidate[]) => {
    const dedup = new Map<string, CreatorCandidate>();
    for (const c of rows) {
      const key = `${c.platform}:${c.handle.toLowerCase()}`;
      const prev = dedup.get(key);
      dedup.set(key, prev ? mergeCandidate(prev, c) : c);
    }
    let list = [...dedup.values()];
    const uniqueCreators = list.length;
    if (campaign.follower_min != null) {
      list = list.filter((c) => c.follower_count >= campaign.follower_min!);
    }
    if (campaign.follower_max != null) {
      list = list.filter((c) => c.follower_count <= campaign.follower_max!);
    }
    const afterFollowers = list.length;
    list = list.filter((c) => passesEngagementMinimum(c.engagement_rate, campaign.engagement_rate_min));
    list.sort((a, b) => {
      const email = Number(Boolean(b.email?.trim())) - Number(Boolean(a.email?.trim()));
      if (email !== 0) return email;
      const eng = (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0);
      if (eng !== 0) return eng;
      return (b.follower_count ?? 0) - (a.follower_count ?? 0);
    });
    return { list, uniqueCreators, afterFollowers };
  };

  let narrowed = narrow(allCandidates);
  const minCreators = Number(campaign.min_creators);
  const qualifyingCount = (rows: CreatorCandidate[]) =>
    selectCreatorsToSave(rows, requireEmail, Math.max(rows.length, 1)).length;
  let extraPass: 'page' | 'fallback' | undefined;
  let fallbackTags: string[] | undefined;
  let fallbackSource: 'ai' | 'niche' | undefined;
  let fallbackRounds = 0;
  let categoryRotation: string | undefined;
  await publishYield(narrowed.list);
  if (
    !aiFallback &&
    Number.isFinite(minCreators) &&
    minCreators > 0 &&
    qualifyingCount(narrowed.list) < minCreators &&
    platforms[0]
  ) {
    const top = buildTopUpActorInput(campaign, platforms[0]);
    const actorId = actorForPlatform(platforms[0], options);
    const topCharge = top ? controlsForActorInput(top.input).maxTotalChargeUsd : 0;
    if (top && actorId.trim() && !allowCharge(topCharge)) {
      runBudgetNote = `Run budget of $${budget.budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`;
    } else if (top && actorId.trim()) {
      spentUsd += topCharge;
      try {
        const topPlatform = platforms[0];
        const { items, runId, datasetId, accountIndex, accountLabel, chargeUsd } = await runApifyActorAndGetItems(actorId, top.input, {
          pool,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          pollIntervalMs: options.pollIntervalMs,
          onTick: async ({ itemCount }) => {
            const tags = Array.isArray(top.input.hashtags)
              ? top.input.hashtags.map((tag) => String(tag))
              : [];
            await options.onProgress?.({
              stage: {
                phase: 'hashtags',
                label: hashtagStageLabel(tags),
                checked: itemCount,
                found: keptKeys.size,
                ...(tags.length > 0 ? { tags } : {}),
              },
            });
          },
          onItems: options.onPartial
            ? async (preview) => {
                await emitPartial(mapApifyDatasetItems(preview, topPlatform, niches));
              }
            : undefined,
        });
        spentUsd += chargeUsd - topCharge;
        noteAccount({ runId, accountIndex, accountLabel, chargeUsd }, 'hashtag');
        rawRuns.push({
          platform: topPlatform,
          actorId,
          runId,
          datasetId,
          itemCount: items.length,
          topUp: top.kind,
        });
        const mapped = mapApifyDatasetItems(items, topPlatform, niches);
        await emitPartial(mapped);
        allCandidates.push(...mapped);
        narrowed = narrow(allCandidates);
        rememberTags(top.input);
        noteSamples(top.input, items.length);
        extraPass = 'page';
        await publishYield(narrowed.list);
      } catch (err) {
        if (err instanceof DiscoveryStoppedError) throw err;
        console.warn(
          '[discovery] minimum-creators top-up skipped:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  let { list: candidates, uniqueCreators, afterFollowers } = narrowed;
  await options.onProgress?.({
    stage: {
      phase: 'scoring',
      label: 'Checking niche fit and bio links…',
      checked: candidates.length,
      found: keptKeys.size,
    },
    runSpentUsd: spentUsd,
    runBudgetUsd: budget.budgetUsd,
  });
  let qualified = await qualifyCandidates(candidates, qualifyCtx);
  candidates = qualified.kept;
  let afterBioExtract = qualified.afterBioExtract;
  let profileLookupRan = false;
  if (
    profileEnrichEnabled() &&
    requireEmail &&
    candidates.some((c) => !hasUsablePublicEmail(c.email))
  ) {
    profileLookupRan = true;
    const enriched = await enrichMissingProfileEmails(candidates, {
      ...options,
      pool,
    });
    candidates = enriched.candidates;
    for (const round of enriched.rounds) {
      accountRounds.push(round);
      spentUsd += round.chargeUsd;
    }
    for (const runId of enriched.runIds) {
      rawRuns.push({ profileEnrich: true, runId, itemCount: 0 });
    }
  }
  let afterProfileEnrich = candidates.filter((c) => hasUsablePublicEmail(c.email)).length;

  const expansionGoal =
    Number.isFinite(minCreators) && minCreators > 0 ? minCreators : limit;
  if (aiFallback && qualifyingCount(candidates) < expansionGoal && platforms[0]) {
    const nicheLabel = niches.map((niche) => niche.trim()).filter(Boolean).join(' ') || 'creator';
    const suggestion = await suggestFallbackHashtags({
      niche: nicheLabel,
      current: queriedTags,
      pitch: campaign.value_prop,
      appName: campaign.app_name,
    });
    const expansionBlocked = options.blockedExpansionTags ?? [];
    const tiers = buildExpansionTiers({
      appName: campaign.app_name,
      niche: nicheLabel,
      pitch: campaign.value_prop,
      modelTags: suggestion.tags,
      blocked: expansionBlocked,
    });
    let jumpTier: number | null = null;
    let previousTags = queriedTags.slice();
    let previousFlags = scoreHashtagYield(queriedTags, candidates, requireEmail, samples).map((row) => row.flag);
    const expansionCategories = relevanceCategoryIds(nicheLabel, campaign.hashtags ?? [], {
      appName: campaign.app_name,
      valueProp: campaign.value_prop,
    });
    while (fallbackRounds < EXPANSION_ROUNDS_PER_CLICK && qualifyingCount(candidates) < expansionGoal) {
      const selected = selectExpansionTags({
        tiers,
        tried: queriedTags,
        afterTier: jumpTier,
        previousTags,
        previousFlags,
        blocked: expansionBlocked,
        categories: expansionCategories,
      });
      const choice = chooseExpansionTags({
        requested: selected.tags,
        tiers,
        categories: expansionCategories,
        campaignHashtags: campaign.hashtags ?? [],
        tried: queriedTags,
        extraBlocked: expansionBlocked,
      });
      const next = {
        tags: choice.tags,
        tier: selected.tier,
        rotation: choice.rotation ?? selected.rotation,
      };
      if (next.rotation) categoryRotation = next.rotation;
      const fallbackInput = buildFallbackActorInput(platforms[0], next.tags);
      const actorId = actorForPlatform(platforms[0], options);
      if (!fallbackInput || !actorId.trim() || next.tags.length === 0) break;
      const roundCharge = controlsForActorInput(fallbackInput).maxTotalChargeUsd;
      if (!allowCharge(roundCharge)) {
        runBudgetNote = `Run budget of $${budget.budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`;
        break;
      }
      spentUsd += roundCharge;
      const before = qualifyingCount(candidates);
      try {
        const fallbackPlatform = platforms[0];
        const { items, runId, datasetId, accountIndex, accountLabel, chargeUsd } = await runApifyActorAndGetItems(
          actorId,
          fallbackInput,
          {
            pool,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
            pollIntervalMs: options.pollIntervalMs,
            onTick: async ({ itemCount }) => {
              await options.onProgress?.({
                stage: {
                  phase: 'hashtags',
                  label: hashtagStageLabel(next.tags),
                  checked: itemCount,
                  found: keptKeys.size,
                  tags: next.tags,
                },
              });
            },
            onItems: options.onPartial
              ? async (preview) => {
                  await emitPartial(mapApifyDatasetItems(preview, fallbackPlatform, niches));
                }
              : undefined,
          },
        );
        spentUsd += chargeUsd - roundCharge;
        noteAccount({ runId, accountIndex, accountLabel, chargeUsd }, 'expand');
        rawRuns.push({
          platform: fallbackPlatform,
          actorId,
          runId,
          datasetId,
          itemCount: items.length,
          fallback: true,
        });
        const mapped = mapApifyDatasetItems(items, fallbackPlatform, niches);
        await emitPartial(mapped);
        allCandidates.push(...mapped);
        const again = narrow(allCandidates);
        const scored = await qualifyCandidates(again.list, qualifyCtx);
        qualified = scored;
        candidates = scored.kept;
        afterBioExtract = scored.afterBioExtract;
        uniqueCreators = again.uniqueCreators;
        afterFollowers = again.afterFollowers;
        afterProfileEnrich = candidates.filter((c) => hasUsablePublicEmail(c.email)).length;
        rememberTags(fallbackInput);
        noteSamples(fallbackInput, items.length);
        extraPass = 'fallback';
        fallbackTags = tagsFromActorInput(fallbackInput);
        fallbackSource = suggestion.tags.length > 0 ? suggestion.source : 'niche';
        fallbackRounds += 1;
        const added = qualifyingCount(candidates) - before;
        const roundYield = scoreHashtagYield(
          next.tags,
          candidates,
          requireEmail,
          sampleCountsForTags(next.tags, items.length),
        );
        previousTags = next.tags;
        previousFlags = roundYield.map((row) => row.flag);
        const weakRound =
          roundYield.length > 0 &&
          roundYield.every((row) => row.flag === 'thin' || row.flag === 'low');
        const later = chooseExpansionTags({
          tiers,
          categories: expansionCategories,
          campaignHashtags: campaign.hashtags ?? [],
          tried: queriedTags,
          extraBlocked: expansionBlocked,
        });
        if (!shouldChainRound({
          added,
          roundsUsed: fallbackRounds,
          finished: qualifyingCount(candidates),
          target: expansionGoal,
          exhausted: later.tags.length === 0,
        }) && !(weakRound && qualifyingCount(candidates) < expansionGoal)) {
          break;
        }
        if (added <= 0 && next.tier) jumpTier = next.tier;
      } catch (err) {
        if (err instanceof DiscoveryStoppedError) throw err;
        console.warn(
          '[discovery] fallback search skipped:',
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }
  }

  const hashtagYield = scoreHashtagYield(queriedTags, candidates, requireEmail, samples);
  await publishYield(candidates);

  const rawItems = rawRuns.reduce<number>((sum, run) => {
    const count = (run as { itemCount?: number }).itemCount;
    return sum + (typeof count === 'number' ? count : 0);
  }, 0);
  const apifyRunIds = rawRuns
    .map((run) => String((run as { runId?: string | null }).runId || ''))
    .filter(Boolean);
  const funnel: DiscoveryFunnel = {
    rawItems,
    uniqueCreators,
    afterFollowers,
    afterDedupe: candidates.length,
    afterBioExtract,
    ...(profileLookupRan ? { afterProfileEnrich } : {}),
    withEmail: afterProfileEnrich,
    bioLinksChecked: qualified.bioLinksChecked,
    emailsFromBioLinks: qualified.emailsFromBioLinks,
    nicheRelevant: qualified.nicheRelevant,
    nicheReview: qualified.nicheReview,
    nicheDropped: qualified.nicheDropped,
    nicheSource: qualified.nicheSource,
    saved: selectCreatorsToSave(candidates, requireEmail, limit).length,
    followerMin: campaign.follower_min,
    followerMax: campaign.follower_max,
    apifyRunIds,
    requirePublicEmail: requireEmail,
    ...(hashtagYield.length > 0 ? { hashtagYield } : {}),
    ...(queriedTags.length > 0 ? { triedTags: [...queriedTags] } : {}),
    ...(fallbackRounds > 0 ? { expansionRounds: fallbackRounds } : {}),
    ...(fallbackTags && fallbackTags.length > 0 ? { fallbackTags, fallbackSource } : {}),
    ...(extraPass ? { extraPass } : {}),
    ...(source ? { discoverySource: source } : {}),
    ...(networkStats ? { network: networkStats } : {}),
    ...(options.skippedTags && options.skippedTags.length > 0
      ? { skippedTags: options.skippedTags }
      : {}),
    runBudgetUsd: budget.budgetUsd,
    runSpentUsd: spentUsd,
    ...(accountRounds.length > 0
      ? { apifyRounds: accountRounds, apifyAccounts: summariseAccountSpend(accountRounds) }
      : {}),
    ...(pool.exhaustedIndexes().length > 0 ? { apifyExhausted: pool.exhaustedIndexes() } : {}),
    ...(runBudgetNote ? { runBudgetNote } : {}),
    ...(categoryRotation ? { categoryRotation } : {}),
    stage: {
      phase: 'saving',
      label: savingStageLabel(selectCreatorsToSave(candidates, requireEmail, limit).length),
      checked: rawItems,
      found: selectCreatorsToSave(candidates, requireEmail, limit).length,
    },
  };

  return {
    candidates,
    provider: 'apify',
    query,
    raw: { runs: rawRuns },
    funnel,
  };
}
