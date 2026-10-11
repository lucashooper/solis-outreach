import { creatorsTowardTarget } from './campaignBatch.js';
import { normaliseHashtags } from './hashtags.js';
import type { DiscoveryFunnel, DiscoveryReasonCode } from './types.js';

export type { DiscoveryReasonCode };

const REASON_CODES = new Set<DiscoveryReasonCode>([
  'ok',
  'apify_not_configured',
  'apify_budget_exceeded',
  'no_search_terms',
  'already_running',
  'actor_failed',
  'zero_raw_items',
  'all_filtered_by_followers',
  'all_filtered_by_email',
  'all_in_crm',
  'tags_on_cooldown',
  'network_charge_rejected',
]);

/** These never started a useful Apify search. The job is failed, with a reason. */
export const EARLY_EXIT_REASONS = new Set<DiscoveryReasonCode>([
  'apify_not_configured',
  'apify_budget_exceeded',
  'no_search_terms',
  'already_running',
  'actor_failed',
]);

export function asDiscoveryReason(value: unknown): DiscoveryReasonCode | null {
  return typeof value === 'string' && REASON_CODES.has(value as DiscoveryReasonCode)
    ? (value as DiscoveryReasonCode)
    : null;
}

export function blankFunnel(
  partial: Partial<DiscoveryFunnel> & { reason?: DiscoveryReasonCode } = {},
): DiscoveryFunnel {
  return {
    rawItems: 0,
    uniqueCreators: 0,
    afterFollowers: 0,
    afterDedupe: 0,
    withEmail: 0,
    saved: 0,
    followerMin: partial.followerMin ?? null,
    followerMax: partial.followerMax ?? null,
    apifyRunIds: [],
    ...partial,
  };
}

/**
 * A cached list is finished only when the creators that count already meet the target.
 * CRM matches count only when Include CRM creators is on. A short list must call Apify.
 */
export function cacheCoversRequest(input: {
  freshSaved: number;
  existing?: number;
  includeExisting?: boolean;
  minCreators: number | null;
  aiFallback: boolean;
  resultLimit: number;
}): boolean {
  const counted = creatorsTowardTarget(
    input.freshSaved,
    input.existing ?? 0,
    input.includeExisting === true,
  );
  const minimum = input.minCreators;
  const limit = Number.isFinite(input.resultLimit) && input.resultLimit > 0 ? input.resultLimit : 10;
  const target = minimum != null && minimum >= 1 ? minimum : limit;
  return counted >= target;
}

/** Niche label stored on the job. Never the campaign title — that is not a search term. */
export function discoveryJobNiche(input: {
  niches?: readonly string[] | null;
  hashtags?: readonly string[] | null;
}): string {
  const niches = (input.niches ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
  if (niches.length > 0) return niches.join(', ').slice(0, 80);
  const tags = normaliseHashtags(input.hashtags ?? []).slice(0, 4);
  if (tags.length > 0) return tags.join(' ').slice(0, 80);
  return 'hashtags';
}

export function campaignHasSearchTerms(input: {
  niches?: readonly string[] | null;
  hashtags?: readonly string[] | null;
}): boolean {
  const niches = (input.niches ?? []).some((item) => item.trim().length > 0);
  return niches || normaliseHashtags(input.hashtags ?? []).length > 0;
}

/** Map an Apify or guard error onto a reason. Unknown actor failures stay actor_failed. */
export function reasonFromError(message: string): DiscoveryReasonCode {
  const text = message.trim();
  if (/APIFY_TOKEN|not configured/i.test(text)) return 'apify_not_configured';
  if (
    /monthly limit|usage hard limit|hard limit exceeded|credit limit|insufficient credit|out of credit|max-total-charge|maxTotalChargeUsd/i.test(
      text,
    )
  ) {
    return 'apify_budget_exceeded';
  }
  if (/creator-network cost cap|followers actor needs a higher maximum/i.test(text)) {
    return 'network_charge_rejected';
  }
  if (/no hashtag|no search term|nothing to search/i.test(text)) return 'no_search_terms';
  if (/already running/i.test(text)) return 'already_running';
  return 'actor_failed';
}

/**
 * Reason for a search that actually returned. Early-exit reasons already on the
 * funnel are kept. A reused cache is classified from the creator counts.
 */
export function classifyFunnelReason(funnel: DiscoveryFunnel): DiscoveryReasonCode {
  if (funnel.reason && funnel.reason !== 'ok') return funnel.reason;
  if (funnel.cached) {
    if (funnel.saved === 0 && funnel.afterDedupe === 0 && (funnel.existing ?? 0) > 0) {
      return 'all_in_crm';
    }
    if (
      funnel.requirePublicEmail !== false &&
      funnel.saved === 0 &&
      funnel.withEmail === 0 &&
      funnel.afterFollowers > 0
    ) {
      return 'all_filtered_by_email';
    }
    return 'ok';
  }
  if (
    (funnel.skippedTags?.length ?? 0) > 0 &&
    funnel.rawItems === 0 &&
    (funnel.network?.rows ?? 0) === 0 &&
    funnel.saved === 0
  ) {
    return 'tags_on_cooldown';
  }
  if (funnel.rawItems === 0 && !funnel.network) return 'zero_raw_items';
  if (funnel.rawItems === 0 && funnel.network?.note && funnel.network.rows === 0) return 'ok';
  if (funnel.rawItems === 0 && funnel.network && funnel.network.fresh === 0 && funnel.saved === 0) {
    return funnel.network.inRange === 0 ? 'all_filtered_by_followers' : 'ok';
  }
  if (funnel.afterFollowers === 0) return 'all_filtered_by_followers';
  if (funnel.afterDedupe === 0 && (funnel.existing ?? 0) > 0) return 'all_in_crm';
  if (
    funnel.requirePublicEmail !== false &&
    funnel.withEmail === 0 &&
    funnel.afterFollowers > 0 &&
    funnel.saved === 0
  ) {
    return 'all_filtered_by_email';
  }
  return 'ok';
}

export function discoveryOutcomeCopy(
  reason: DiscoveryReasonCode,
  funnel?: Pick<
    DiscoveryFunnel,
    'existing' | 'afterFollowers' | 'uniqueCreators' | 'skippedTags' | 'network'
  > | null,
): { title: string; action: string } | null {
  switch (reason) {
    case 'ok':
      return null;
    case 'apify_not_configured':
      return {
        title: "Search didn't run: Apify is not configured.",
        action: 'Add APIFY_TOKEN on the server.',
      };
    case 'apify_budget_exceeded':
      return {
        title: 'All connected Apify accounts are out of credit.',
        action: 'Wait for a limit to reset, or connect another Apify account.',
      };
    case 'no_search_terms':
      return {
        title: "Search didn't run: there are no hashtags or niches to query.",
        action: 'Add at least one hashtag.',
      };
    case 'already_running':
      return {
        title: 'A search is already running for this campaign.',
        action: 'Wait for it to finish before starting another.',
      };
    case 'actor_failed':
      return {
        title: 'Search failed before Apify returned videos.',
        action: 'Try again in a moment.',
      };
    case 'zero_raw_items':
      return {
        title: '0 videos returned for these hashtags.',
        action: 'Move a stronger tag into the first two, or try a different tag.',
      };
    case 'all_filtered_by_followers':
      return {
        title: 'Every creator was outside the follower range.',
        action: 'Widen the follower range.',
      };
    case 'all_filtered_by_email':
      return {
        title: 'Everyone in range was dropped because they have no public email.',
        action: 'Turn off Require public email for this batch, or try other tags.',
      };
    case 'tags_on_cooldown':
      return {
        title: 'Those hashtags were scraped in the last 10 days.',
        action: 'Type a hashtag on the shortfall card to search it anyway, or wait until the pause ends.',
      };
    case 'network_charge_rejected':
      return {
        title: "Creator network didn't run: Apify rejected the cost cap.",
        action: 'The followers actor needs a higher maximum charge. Try Hashtags, or wait for the Apify limit to reset.',
      };
    case 'all_in_crm': {
      const count = Math.max(0, funnel?.existing ?? funnel?.afterFollowers ?? 0);
      const title =
        count === 1
          ? 'All 1 match is already in the CRM.'
          : `All ${count} matches are already in the CRM.`;
      return {
        title,
        action: 'Include creators already in the CRM, or search tags that have not been tried.',
      };
    }
    default:
      return null;
  }
}

/** One log line. Values are flattened; callers must not pass secrets or full emails. */
export function formatDiscoveryLog(
  stage: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): string {
  const parts = [`stage=${stage.replace(/\s+/g, '_')}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    const text = String(value).replace(/\s+/g, ' ').slice(0, 180);
    if (/token|secret|authorization|email/i.test(key)) continue;
    parts.push(`${key}=${text}`);
  }
  return `[discovery] ${parts.join(' ')}`;
}

export function logDiscovery(
  stage: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  console.log(formatDiscoveryLog(stage, fields));
}

/**
 * The Find button can clear once the server has left "searching",
 * or once a finished job has written a new discovery run.
 * A job that is still running does not clear, even if creators are already on screen.
 */
export function searchHasFinished(input: {
  jobStatus?: string | null;
  campaignStatus?: string | null;
  runCount: number;
  runsWhenStarted: number;
}): boolean {
  if (input.campaignStatus && input.campaignStatus !== 'searching') return true;
  if (input.jobStatus === 'failed' || input.jobStatus === 'succeeded' || input.jobStatus === 'stopped') {
    return true;
  }
  return false;
}

/** A running job with no write for this long is treated as failed. */
export const SEARCH_STALE_MS = 10 * 60 * 1000;

/**
 * True while a discovery job is still in flight.
 * `stopping` stays live so the page can show the search until it actually ends.
 * A missing timestamp, or one older than 10 minutes, is not live.
 */
export function jobIsLive(
  status: string | null | undefined,
  updatedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (status !== 'running' && status !== 'stopping') return false;
  const updated = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(updated)) return false;
  return now - updated < SEARCH_STALE_MS;
}

/** True while a campaign was marked searching and that stamp is still fresh. */
export function searchStillRunning(
  status: string | null | undefined,
  updatedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (status !== 'searching') return false;
  return jobIsLive('running', updatedAt, now);
}
