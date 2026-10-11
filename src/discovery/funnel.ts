import { isApifyAccountLabel } from './apifyPool.js';
import { hasUsablePublicEmail } from './email.js';
import { asHashtagYield } from './hashtagYield.js';
import type { ExpansionRoundLog, ExpansionTier } from './expansionTiers.js';
import { withoutDeniedTags } from './expansionTiers.js';
import { normaliseHashtags } from './hashtags.js';
import {
  FOLLOWERS_RESULT_USD,
  FOLLOWERS_START_USD,
  NETWORK_SEEDS_PER_BATCH,
  discoveryRunBudgetUsd,
  plannedNetworkSpendUsd,
} from './budget.js';

export { FOLLOWERS_RESULT_USD, FOLLOWERS_START_USD };
import {
  asNetworkFunnelStats,
  FOLLOWING_PER_PROFILE,
  networkFunnelMessage,
  type DiscoverySource,
} from './network.js';
import { asDiscoveryStage } from './progress.js';
import { asDiscoveryReason } from './runOutcome.js';
import { asSkippedTags, cooldownMessage } from './tagCooldown.js';
import type { DiscoveryFunnel } from './types.js';

/** Hard ceiling on videos requested from Apify, across every hashtag and query. */
export const DISCOVERY_RAW_CAP = 300;

/** When a public email is required, sample more videos, then stop. */
export const EMAIL_VIDEO_CAP = 100;

/** Profile lookups after the follower filter. One video each, not every author. */
export const PROFILE_ENRICH_CAP = 25;

/**
 * Video rows already include authorMeta.signature, so a second profile
 * scrape adds about zero emails. Off unless DISCOVERY_PROFILE_ENRICH=1.
 */
export function profileEnrichEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.DISCOVERY_PROFILE_ENRICH ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** clockworks/tiktok-scraper free-tier price. */
export const TIKTOK_RESULT_USD = 0.0037;
export const TIKTOK_START_USD = 0.001;

/** Saved creators a search may ask for. The Apify charge cap still applies. */
export const RESULT_LIMIT_MAX = 100;

export function savedResultLimit(limit: number | null | undefined): number {
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 1) return 10;
  return Math.min(Math.round(value), RESULT_LIMIT_MAX);
}

/**
 * Videos requested in total.
 * Require-public-email searches sample 5× the saved limit, capped at 100,
 * so more bios are seen before the small profile lookup. Other searches stay at 3×.
 */
export function rawVideoBudget(
  limit: number | null | undefined,
  requirePublicEmail = false,
): number {
  const saved = savedResultLimit(limit);
  if (requirePublicEmail) return Math.min(EMAIL_VIDEO_CAP, saved * 5);
  return Math.min(DISCOVERY_RAW_CAP, saved * 3);
}

function hashtagRunUsd(
  limit: number | null | undefined,
  requirePublicEmail = false,
): { items: number; usd: number } {
  const items = rawVideoBudget(limit, requirePublicEmail);
  return { items, usd: items * TIKTOK_RESULT_USD + TIKTOK_START_USD };
}

function networkRunUsd(_limit: number | null | undefined): { seeds: number; items: number; usd: number } {
  const usd = plannedNetworkSpendUsd(discoveryRunBudgetUsd());
  const items = Math.max(0, Math.round((usd - FOLLOWERS_START_USD) / FOLLOWERS_RESULT_USD));
  return { seeds: NETWORK_SEEDS_PER_BATCH, items, usd };
}

/**
 * Free-tier estimate for one run.
 * Network and Both price the following-list step, which is what a new run starts with.
 * Hashtags are priced at $0.0037 per video plus $0.001 to start.
 */
export function estimatedDiscoveryUsd(
  limit: number | null | undefined,
  requirePublicEmail = false,
  source: DiscoverySource = 'both',
): number {
  if (source === 'hashtags') return hashtagRunUsd(limit, requirePublicEmail).usd;
  return networkRunUsd(limit).usd;
}

export function discoveryCostHint(
  limit: number | null | undefined,
  requirePublicEmail = false,
  source: DiscoverySource = 'both',
): string {
  const saved = savedResultLimit(limit);
  return `~$${estimatedDiscoveryUsd(saved, requirePublicEmail, source).toFixed(2)} · limit ${saved}`;
}

/** Longer price breakdown for the cost tooltip. */
export function discoveryCostTooltip(
  limit: number | null | undefined,
  requirePublicEmail = false,
  source: DiscoverySource = 'both',
): string {
  const saved = savedResultLimit(limit);
  const network = networkRunUsd(saved);
  const hashtag = hashtagRunUsd(saved, requirePublicEmail);
  const networkLine =
    `Creator network: up to ${NETWORK_SEEDS_PER_BATCH} seeds × ${FOLLOWING_PER_PROFILE} followed accounts ` +
    `at $${FOLLOWERS_RESULT_USD.toFixed(3)} each + $${FOLLOWERS_START_USD.toFixed(3)} to start, ` +
    `capped at $${discoveryRunBudgetUsd().toFixed(2)} per run (≈ $${network.usd.toFixed(2)} for the first batch).`;
  const hashtagLine =
    `Hashtags: about ${hashtag.items} videos × $${TIKTOK_RESULT_USD.toFixed(4)} + $${TIKTOK_START_USD.toFixed(3)} to start ` +
    `(≈ $${hashtag.usd.toFixed(3)}). The TikTok video actor rejects a cost cap under $0.50.`;
  if (source === 'hashtags') return hashtagLine;
  if (source === 'network') return networkLine;
  return `${networkLine} Hashtags run only if that is short of the target. ${hashtagLine}`;
}

/**
 * clockworks/tiktok-scraper rejects maxTotalChargeUsd under $0.50.
 * Larger pulls get a little headroom and stop at $1 for a single hashtag actor call.
 */
export function apifyChargeCapUsd(
  limit: number | null | undefined,
  requirePublicEmail = false,
): number {
  const estimate = rawVideoBudget(limit, requirePublicEmail) * TIKTOK_RESULT_USD + 0.05;
  const cents = Math.round(estimate * 100);
  const stepped = (Math.ceil(cents / 5) * 5) / 100;
  return Math.min(1, Math.max(0.5, stepped));
}

/**
 * Followers-scraper is $0.001 per result. Send a cap near the estimate.
 * If the actor rejects anything under $0.50, the start call retries at $0.50.
 */
export function followersChargeCapUsd(maxItems: number): number {
  const items = Math.max(1, Math.round(maxItems) || 1);
  const estimate = items * FOLLOWERS_RESULT_USD + FOLLOWERS_START_USD;
  const headroom = Math.ceil(estimate * 1.5 * 100) / 100;
  return Math.min(5, Math.max(0.02, headroom));
}

export const SCALE_ADVICE =
  'Widen followers (for example 5K–200K), add more niche tags, keep Require public email on, and raise the limit to 40–80.';

/**
 * Shown when the follower window is narrower than 3×.
 * A 10k–26k search is about 2.6× and misses most of the mid-size pool.
 */
export function narrowRangeHint(min: number | null | undefined, max: number | null | undefined): string | null {
  const low = Number(min);
  const high = Number(max);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) return null;
  if (high / low >= 3) return null;
  return 'This range is narrow. Widening it (for example 5k–50k) will find many more creators.';
}

export function formatFollowerCount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'any';
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) {
    const millions = rounded / 1_000_000;
    const text = Number.isInteger(millions) ? String(millions) : millions.toFixed(1);
    return `${text}M`;
  }
  if (rounded >= 1000) return `${Math.round(rounded / 1000)}K`;
  return String(rounded);
}

export function discoveryFunnelMessage(funnel: DiscoveryFunnel): string {
  const extras: string[] = [];
  if (funnel.runBudgetNote) extras.push(funnel.runBudgetNote.replace(/\.$/, ''));
  if (funnel.categoryRotation) extras.push(funnel.categoryRotation.replace(/\.$/, ''));
  if (funnel.skippedTags?.length) extras.push(cooldownMessage(funnel.skippedTags));
  if (funnel.network && (funnel.network.rows > 0 || funnel.network.note || funnel.network.seedsRequested > 0)) {
    extras.push(networkFunnelMessage(funnel.network));
  }
  const body = hashtagFunnelMessage(funnel);
  if (extras.length === 0) return body;
  if (funnel.rawItems === 0) return extras.join(' ');
  return `${extras.join(' ')} ${body}`;
}

function hashtagFunnelMessage(funnel: DiscoveryFunnel): string {
  const range = `${formatFollowerCount(funnel.followerMin)}–${formatFollowerCount(funnel.followerMax)}`;
  const videos = funnel.rawItems === 1 ? 'video' : 'videos';
  const creators = funnel.uniqueCreators === 1 ? 'creator' : 'creators';
  const head = `Apify returned ${funnel.rawItems} ${videos} → ${funnel.uniqueCreators} ${creators}`;
  if (funnel.rawItems === 0) {
    return 'Apify returned 0 videos. Try another niche or hashtag.';
  }
  if (funnel.afterFollowers === 0) {
    return `${head} → 0 within ${range} followers. ${SCALE_ADVICE}`;
  }
  const mid = `${head} → ${funnel.afterFollowers} within ${range} followers`;
  if (funnel.afterDedupe === 0) {
    const existing =
      typeof funnel.existing === 'number' ? funnel.existing : funnel.afterFollowers;
    const already = existing === 1 ? '1 already in the CRM' : `${existing} already in the CRM`;
    return `${mid} → 0 new. ${already}.`;
  }
  const stages = emailStageClause(funnel);
  if (stages) {
    const advice = funnel.withEmail === 0 && funnel.saved === 0 ? ` ${SCALE_ADVICE}` : '';
    return withExistingCount(`${mid} → ${stages} → ${funnel.saved} saved.${advice}`, funnel);
  }
  if (funnel.withEmail === 0) {
    const blocked =
      funnel.saved === 0 &&
      funnel.afterDedupe > 0 &&
      funnel.requirePublicEmail !== false;
    if (blocked) {
      return withExistingCount(`${mid} → 0 with a public email. ${SCALE_ADVICE}`, funnel);
    }
    return withExistingCount(`${mid} → 0 with a public email.`, funnel);
  }
  if (funnel.saved > 0 && funnel.saved < 3) {
    return withExistingCount(`${mid} → ${funnel.saved} saved. ${SCALE_ADVICE}`, funnel);
  }
  if (funnel.saved === 0) {
    return withExistingCount(`${mid} → 0 saved.`, funnel);
  }
  return withExistingCount(`${mid} → ${funnel.saved} saved.`, funnel);
}

function withExistingCount(message: string, funnel: DiscoveryFunnel): string {
  if (typeof funnel.existing !== 'number' || funnel.existing <= 0) return message;
  if (message.includes('already in the CRM')) return message;
  const already =
    funnel.existing === 1 ? '1 already in the CRM' : `${funnel.existing} already in the CRM`;
  if (message.endsWith('.')) return `${message.slice(0, -1)}. ${already}.`;
  return `${message} ${already}.`;
}

/** Short counts for the campaign banner: matched, new, and already in the CRM. */
export function discoveryResultNote(funnel: DiscoveryFunnel): string {
  const matched =
    funnel.requirePublicEmail === true ? funnel.withEmail : funnel.afterFollowers;
  const fresh = funnel.saved;
  const existing = typeof funnel.existing === 'number' ? funnel.existing : 0;
  const matchedText = matched === 1 ? '1 matched the filters' : `${matched} matched the filters`;
  const freshText = fresh === 1 ? '1 new' : `${fresh} new`;
  const existingText =
    existing === 1 ? '1 already in the CRM' : `${existing} already in the CRM`;
  return `${matchedText}. ${freshText}. ${existingText}.`;
}

function emailStageClause(funnel: DiscoveryFunnel): string | null {
  if (typeof funnel.afterBioExtract !== 'number' && typeof funnel.afterProfileEnrich !== 'number') {
    return null;
  }
  const bios = funnel.afterBioExtract ?? 0;
  const enriched = funnel.afterProfileEnrich ?? funnel.withEmail;
  return `${bios} from bios → ${enriched} after profile lookup → ${funnel.withEmail} with a public email`;
}

/** 0 or a thin result is worth explaining. Email stages stay visible too. */
export function showFunnelExplanation(funnel: DiscoveryFunnel): boolean {
  if (funnel.network || (funnel.skippedTags?.length ?? 0) > 0) return true;
  if (typeof funnel.afterBioExtract === 'number' || typeof funnel.afterProfileEnrich === 'number') {
    return true;
  }
  return funnel.saved < 3 || funnel.withEmail === 0 || funnel.afterFollowers === 0;
}

export function suggestWidenRange(funnel: DiscoveryFunnel): boolean {
  return funnel.afterFollowers === 0 || funnel.afterFollowers * 4 < funnel.uniqueCreators;
}

export function suggestIncludeExisting(funnel: DiscoveryFunnel): boolean {
  return funnel.afterFollowers > 0 && funnel.afterDedupe === 0;
}

/** The email rule emptied an otherwise in-range list. */
export function suggestTurnOffEmail(funnel: DiscoveryFunnel): boolean {
  return (
    funnel.requirePublicEmail !== false &&
    funnel.afterFollowers > 0 &&
    funnel.afterDedupe > 0 &&
    funnel.withEmail === 0 &&
    funnel.saved === 0
  );
}

export function wantsPublicEmail(value: boolean | null | undefined): boolean {
  return value !== false;
}

/**
 * When a public email is required, drop blank and placeholder addresses.
 * Otherwise keep in-range creators and put real addresses first, so a short
 * limit still prefers them. Already-in-CRM rows use the same rule.
 */
export function selectCreatorsToSave<T extends { email?: string | null }>(
  rows: T[],
  requirePublicEmail: boolean,
  limit: number,
): T[] {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 10;
  const eligible = requirePublicEmail
    ? rows.filter((row) => hasUsablePublicEmail(row.email))
    : rows;
  const ranked = [...eligible].sort(
    (a, b) => Number(hasUsablePublicEmail(b.email)) - Number(hasUsablePublicEmail(a.email)),
  );
  return ranked.slice(0, cap);
}

/** Halve the minimum (never below 1,000) and double the maximum (never above 1,000,000). */
export function widenedFollowerRange(
  min: number | null,
  max: number | null,
): { min: number; max: number } {
  const baseMin = min != null && Number.isFinite(min) ? min : 1000;
  const baseMax = max != null && Number.isFinite(max) ? max : Math.max(baseMin * 2, 10_000);
  const nextMin = Math.max(1000, Math.floor(baseMin / 2));
  const nextMax = Math.min(1_000_000, Math.max(nextMin, baseMax * 2));
  return { min: nextMin, max: nextMax };
}

function asTierIndex(value: unknown): 1 | 2 | 3 | null {
  const tier = Number(value);
  return tier === 1 || tier === 2 || tier === 3 ? tier : null;
}

function asExpansionState(row: Record<string, unknown>): Partial<DiscoveryFunnel> {
  const expansionTier = asTierIndex(row.expansionTier);
  const rounds = Number(row.expansionRounds);
  const baseline = Number(row.expansionBaseline);
  const expansionPlan = Array.isArray(row.expansionPlan)
    ? row.expansionPlan.flatMap((item): ExpansionTier[] => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const tier = asTierIndex(record.tier);
        if (!tier || !Array.isArray(record.tags)) return [];
        const tags = withoutDeniedTags(record.tags.map((tag) => String(tag)));
        return tags.length > 0 ? [{ tier, tags }] : [];
      })
    : [];
  const expansionLog = Array.isArray(row.expansionLog)
    ? row.expansionLog.flatMap((item): ExpansionRoundLog[] => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        if (!Array.isArray(record.tags)) return [];
        const tags = withoutDeniedTags(record.tags.map((tag) => String(tag)));
        const added = Number(record.added);
        if (tags.length === 0 || !Number.isFinite(added)) return [];
        const tier = asTierIndex(record.tier);
        return [{ tags, added: Math.max(0, Math.round(added)), ...(tier ? { tier } : {}) }];
      })
    : [];
  const expansionCustom = Array.isArray(row.expansionCustom)
    ? withoutDeniedTags(row.expansionCustom.map((tag) => String(tag))).slice(0, 5)
    : [];
  return {
    ...(expansionTier ? { expansionTier } : {}),
    ...(Number.isFinite(rounds) && rounds >= 1 && rounds <= 3
      ? { expansionRounds: Math.round(rounds) }
      : {}),
    ...(row.expansionExhausted === true ? { expansionExhausted: true } : {}),
    ...(row.expansionCascade === true ? { expansionCascade: true } : {}),
    ...(Number.isFinite(baseline) && baseline >= 0 ? { expansionBaseline: Math.round(baseline) } : {}),
    ...(expansionCustom.length > 0 ? { expansionCustom } : {}),
    ...(expansionPlan.length > 0 ? { expansionPlan } : {}),
    ...(expansionLog.length > 0 ? { expansionLog } : {}),
  };
}

export function asDiscoveryFunnel(value: unknown): DiscoveryFunnel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.rawItems !== 'number' || typeof row.uniqueCreators !== 'number') return null;
  const bound = (key: string): number | null => {
    if (row[key] == null || row[key] === '') return null;
    const n = Number(row[key]);
    return Number.isFinite(n) ? n : null;
  };
  const hashtagYield = asHashtagYield(row.hashtagYield);
  const fallbackTags = Array.isArray(row.fallbackTags)
    ? normaliseHashtags(row.fallbackTags.map((tag) => String(tag)))
    : [];
  return {
    rawItems: row.rawItems,
    uniqueCreators: row.uniqueCreators,
    afterFollowers: Number(row.afterFollowers) || 0,
    afterDedupe: Number(row.afterDedupe) || 0,
    withEmail: Number(row.withEmail) || 0,
    saved: Number(row.saved) || 0,
    ...(typeof row.afterBioExtract === 'number' ? { afterBioExtract: row.afterBioExtract } : {}),
    ...(typeof row.afterProfileEnrich === 'number'
      ? { afterProfileEnrich: row.afterProfileEnrich }
      : {}),
    followerMin: bound('followerMin'),
    followerMax: bound('followerMax'),
    apifyRunIds: Array.isArray(row.apifyRunIds) ? row.apifyRunIds.map((id) => String(id)) : [],
    ...(typeof row.requirePublicEmail === 'boolean'
      ? { requirePublicEmail: row.requirePublicEmail }
      : {}),
    ...(typeof row.existing === 'number' ? { existing: row.existing } : {}),
    ...(Array.isArray(row.existingCreatorIds)
      ? {
          existingCreatorIds: row.existingCreatorIds
            .map((id) => String(id))
            .filter((id) => id.length > 0),
        }
      : {}),
    ...(hashtagYield ? { hashtagYield } : {}),
    ...(fallbackTags.length > 0 ? { fallbackTags } : {}),
    ...(row.fallbackSource === 'ai' || row.fallbackSource === 'niche'
      ? { fallbackSource: row.fallbackSource }
      : {}),
    ...(row.extraPass === 'fallback' || row.extraPass === 'page'
      ? { extraPass: row.extraPass }
      : {}),
    ...(typeof row.finished === 'number' && Number.isFinite(row.finished)
      ? { finished: row.finished }
      : {}),
    ...(Array.isArray(row.triedTags)
      ? (() => {
          const triedTags = normaliseHashtags(row.triedTags.map((tag) => String(tag)));
          return triedTags.length > 0 ? { triedTags } : {};
        })()
      : {}),
    ...(Array.isArray(row.suggestedTags)
      ? (() => {
          const suggestedTags = withoutDeniedTags(row.suggestedTags.map((tag) => String(tag))).slice(0, 2);
          const expansionPool = Array.isArray(row.expansionPool)
            ? withoutDeniedTags(row.expansionPool.map((tag) => String(tag))).slice(0, 8)
            : [];
          return suggestedTags.length > 0
            ? {
                suggestedTags,
                ...(expansionPool.length > 0 ? { expansionPool } : {}),
                ...(row.suggestedSource === 'ai' || row.suggestedSource === 'niche'
                  ? { suggestedSource: row.suggestedSource }
                  : {}),
              }
            : expansionPool.length > 0
              ? { expansionPool }
              : {};
        })()
      : {}),
    ...(Array.isArray(row.eligibleSuggestions)
      ? (() => {
          const eligibleSuggestions = withoutDeniedTags(
            row.eligibleSuggestions.map((tag) => String(tag)),
          ).slice(0, 3);
          return { eligibleSuggestions };
        })()
      : {}),
    ...(typeof row.suggestionNote === 'string' && row.suggestionNote.trim()
      ? { suggestionNote: row.suggestionNote.trim() }
      : {}),
    ...(row.networkOnly === true ? { networkOnly: true } : {}),
    ...asExpansionState(row),
    ...(row.continueUsed === 'expand' || row.continueUsed === 'relax'
      ? { continueUsed: row.continueUsed }
      : {}),
    ...(row.emailRelaxed === true ? { emailRelaxed: true } : {}),
    ...(row.batchAccepted === true ? { batchAccepted: true } : {}),
    ...(Array.isArray(row.batchLinkedIds)
      ? (() => {
          const batchLinkedIds = row.batchLinkedIds
            .map((id) => String(id).trim())
            .filter((id) =>
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
            );
          return batchLinkedIds.length > 0 ? { batchLinkedIds } : {};
        })()
      : {}),
    ...(asDiscoveryReason(row.reason) ? { reason: asDiscoveryReason(row.reason)! } : {}),
    ...(row.cached === true ? { cached: true } : {}),
    ...(row.discoverySource === 'network' ||
    row.discoverySource === 'hashtags' ||
    row.discoverySource === 'both'
      ? { discoverySource: row.discoverySource }
      : {}),
    ...(() => {
      const network = asNetworkFunnelStats(row.network);
      return network ? { network } : {};
    })(),
    ...(() => {
      const skippedTags = asSkippedTags(row.skippedTags);
      return skippedTags ? { skippedTags } : {};
    })(),
    ...(() => {
      const budget = Number(row.runBudgetUsd);
      const spent = Number(row.runSpentUsd);
      const queue = Array.isArray(row.networkQueue)
        ? row.networkQueue.map((seed) => String(seed).replace(/^@/, '').trim()).filter(Boolean)
        : [];
      const terms = Array.isArray(row.relevanceTerms)
        ? row.relevanceTerms.map((term) => String(term)).filter(Boolean)
        : [];
      const categories = Array.isArray(row.activeCategories)
        ? row.activeCategories.map((id) => String(id)).filter(Boolean)
        : [];
      return {
        ...(Number.isFinite(budget) && budget >= 0 ? { runBudgetUsd: budget } : {}),
        ...(Number.isFinite(spent) && spent >= 0 ? { runSpentUsd: spent } : {}),
        ...(typeof row.runBudgetNote === 'string' && row.runBudgetNote.trim()
          ? { runBudgetNote: row.runBudgetNote.trim() }
          : {}),
        ...(queue.length > 0 ? { networkQueue: queue } : {}),
        ...(row.networkHopped === true ? { networkHopped: true } : {}),
        ...(terms.length > 0 ? { relevanceTerms: terms } : {}),
        ...(categories.length > 0 ? { activeCategories: categories } : {}),
        ...(typeof row.categoryRotation === 'string' && row.categoryRotation.trim()
          ? { categoryRotation: row.categoryRotation.trim() }
          : {}),
        ...asApifyAccountUse(row),
      };
    })(),
    ...(() => {
      const stage = asDiscoveryStage(row.stage);
      const count = (key: string) => {
        const n = Number(row[key]);
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
      };
      const bioLinksChecked = count('bioLinksChecked');
      const emailsFromBioLinks = count('emailsFromBioLinks');
      const nicheRelevant = count('nicheRelevant');
      const nicheReview = count('nicheReview');
      const nicheDropped = count('nicheDropped');
      return {
        ...(stage ? { stage } : {}),
        ...(bioLinksChecked != null ? { bioLinksChecked } : {}),
        ...(emailsFromBioLinks != null ? { emailsFromBioLinks } : {}),
        ...(nicheRelevant != null ? { nicheRelevant } : {}),
        ...(nicheReview != null ? { nicheReview } : {}),
        ...(nicheDropped != null ? { nicheDropped } : {}),
        ...(row.nicheSource === 'ai' || row.nicheSource === 'keywords'
          ? { nicheSource: row.nicheSource }
          : {}),
      };
    })(),
  };
}

function asApifyAccountUse(row: Record<string, unknown>): {
  apifyAccounts?: DiscoveryFunnel['apifyAccounts'];
  apifyRounds?: DiscoveryFunnel['apifyRounds'];
  apifyExhausted?: number[];
} {
  const rounds = Array.isArray(row.apifyRounds)
    ? row.apifyRounds.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const round = item as Record<string, unknown>;
        const accountIndex = Number(round.accountIndex);
        const accountLabel = typeof round.accountLabel === 'string' ? round.accountLabel.trim() : '';
        const chargeUsd = Number(round.chargeUsd);
        if (!Number.isInteger(accountIndex) || accountIndex < 1) return [];
        if (!isApifyAccountLabel(accountLabel)) return [];
        if (!Number.isFinite(chargeUsd) || chargeUsd < 0) return [];
        const kind = typeof round.kind === 'string' ? round.kind.trim() : '';
        const runId = typeof round.runId === 'string' ? round.runId.trim() : '';
        return [
          {
            accountIndex,
            accountLabel,
            chargeUsd,
            ...(runId ? { runId } : {}),
            ...(kind === 'network' || kind === 'hashtag' || kind === 'profile' || kind === 'expand'
              ? { kind }
              : {}),
          },
        ];
      })
    : [];
  const accounts = Array.isArray(row.apifyAccounts)
    ? row.apifyAccounts.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const account = item as Record<string, unknown>;
        const index = Number(account.index);
        const label = typeof account.label === 'string' ? account.label.trim() : '';
        const spentUsd = Number(account.spentUsd);
        if (!Number.isInteger(index) || index < 1 || !isApifyAccountLabel(label)) return [];
        if (!Number.isFinite(spentUsd) || spentUsd < 0) return [];
        return [{ index, label, spentUsd }];
      })
    : [];
  const exhausted = Array.isArray(row.apifyExhausted)
    ? row.apifyExhausted
        .map((index) => Number(index))
        .filter((index) => Number.isInteger(index) && index >= 1)
    : [];
  return {
    ...(accounts.length > 0 ? { apifyAccounts: accounts } : {}),
    ...(rounds.length > 0 ? { apifyRounds: rounds } : {}),
    ...(exhausted.length > 0 ? { apifyExhausted: exhausted } : {}),
  };
}

/**
 * Shown when a finished search is still under Minimum creators.
 * The extra pass is the one top-up page, or the one AI fallback run.
 */
export function minimumCreatorsShortfall(input: {
  minimum: number | null | undefined;
  finished: number | null | undefined;
  extraPass?: boolean;
}): string | null {
  if (input.minimum == null || input.finished == null) return null;
  const minimum = Math.round(Number(input.minimum));
  const finished = Math.round(Number(input.finished));
  if (!Number.isFinite(minimum) || minimum < 1) return null;
  if (!Number.isFinite(finished) || finished >= minimum) return null;
  const count = finished === 1 ? '1 creator' : `${finished} creators`;
  if (input.extraPass) {
    return `Stopped after one extra pass. ${count}, short of ${minimum}.`;
  }
  return `${count}, short of ${minimum}.`;
}

export function logDiscoveryFunnel(funnel: DiscoveryFunnel): void {
  const ids = funnel.apifyRunIds.filter(Boolean).join(',') || 'none';
  console.log(
    `[discovery] stage=funnel reason=${funnel.reason ?? 'ok'} cached=${funnel.cached === true} apify=${ids} raw=${funnel.rawItems} unique=${funnel.uniqueCreators} followers=${funnel.afterFollowers} deduped=${funnel.afterDedupe} existing=${funnel.existing ?? '-'} bios=${funnel.afterBioExtract ?? '-'} profiles=${funnel.afterProfileEnrich ?? '-'} email=${funnel.withEmail} saved=${funnel.saved}`,
  );
}
