/** clockworks/tiktok-followers-scraper. $0.001 per result plus $0.001 to start. */
export const FOLLOWERS_RESULT_USD = 0.001;
export const FOLLOWERS_START_USD = 0.001;

/**
 * Following accounts read from each seed when the budget allows it.
 * Book creators follow hundreds of peers, so a 30–120 sample misses the list.
 */
export const NETWORK_FOLLOWING_PER_PROFILE = 180;

/** High past yield gets a deeper read, up to this many following accounts. */
export const NETWORK_FOLLOWING_DEEP = 200;

/** Prefer at least this depth before we add more seeds. */
export const NETWORK_DEPTH_FLOOR = 150;

/** Seeds sent in one followers-scraper call. */
export const NETWORK_SEEDS_PER_BATCH = 15;

/** When source is both, the first network pass may use this share. The rest is kept for hashtags. */
export const NETWORK_BUDGET_SHARE = 0.6;

/** Keep each seed at least this deep before we drop seeds to fit the budget. */
const MIN_FOLLOWING = 30;

/** A leftover of this many seeds joins the current call instead of starting its own run. */
const TAIL_ABSORB = 2;

const DEFAULT_RUN_BUDGET_USD = 2;

export function roundUsd(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Per-run Apify ceiling. DISCOVERY_RUN_BUDGET_USD overrides the $2 default.
 * The search stops early once it has saved the target, so the cap is a ceiling,
 * not a spend target.
 */
export function discoveryRunBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DISCOVERY_RUN_BUDGET_USD);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RUN_BUDGET_USD;
  return roundUsd(raw);
}

/**
 * Dollars the first following-list pass may spend.
 * When the source is both, that pass stops around 60% so the user's hashtags
 * still have a budget. Leftover after hashtags can go back to the network.
 */
export function networkPhaseBudgetUsd(
  totalUsd: number,
  source: 'network' | 'hashtags' | 'both',
): number {
  if (!(totalUsd > 0)) return 0;
  if (source !== 'both') return roundUsd(totalUsd);
  const share = roundUsd(totalUsd * (1 - NETWORK_BUDGET_SHARE));
  const reserve = totalUsd + 0.0005 >= 0.5 ? Math.max(share, 0.5) : share;
  return roundUsd(Math.max(0, totalUsd - Math.min(totalUsd, reserve)));
}

export interface NetworkBatchPlan {
  seeds: string[];
  maxFollowingPerProfile: number;
  maxItems: number;
  maxTotalChargeUsd: number;
}

function dedupeHandles(seeds: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const handle = seed.replace(/^@/, '').trim();
    const key = handle.toLowerCase();
    if (!handle || seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

/**
 * One followers-scraper call that stays inside the remaining dollars.
 * Prefers depth (about 180, or 200 when a seed has qualified people before)
 * over stuffing the call with seeds. A leftover of one or two seeds joins
 * this call instead of starting a run of its own.
 */
export function planNetworkBatch(input: {
  seeds: readonly string[];
  budgetUsd: number;
  seedsPerBatch?: number;
  followingPerProfile?: number;
  /** Qualifying creators returned the last time this seed was mined. */
  yieldBySeed?: ReadonlyMap<string, number>;
}): NetworkBatchPlan | null {
  const pool = dedupeHandles(input.seeds);
  const budget = input.budgetUsd;
  if (pool.length === 0 || !(budget >= FOLLOWERS_START_USD + FOLLOWERS_RESULT_USD)) return null;
  const affordable = Math.floor((budget - FOLLOWERS_START_USD) / FOLLOWERS_RESULT_USD);
  if (affordable < 1) return null;

  const capSeeds = Math.max(1, Math.floor(input.seedsPerBatch ?? NETWORK_SEEDS_PER_BATCH) || 1);
  const explicitDepth = input.followingPerProfile;
  const yieldOf = (handle: string) => input.yieldBySeed?.get(handle.toLowerCase()) ?? 0;
  const highYield = explicitDepth == null && pool.some((seed) => yieldOf(seed) >= 1);
  const targetFollowing = Math.max(
    1,
    Math.floor(
      explicitDepth ?? (highYield ? NETWORK_FOLLOWING_DEEP : NETWORK_FOLLOWING_PER_PROFILE),
    ) || 1,
  );

  let seedCount = Math.min(capSeeds, pool.length);
  if (explicitDepth == null && affordable >= Math.min(NETWORK_DEPTH_FLOOR, targetFollowing)) {
    const depthFloor = Math.min(NETWORK_DEPTH_FLOOR, targetFollowing);
    seedCount = Math.max(1, Math.min(seedCount, Math.floor(affordable / depthFloor)));
  }
  if (highYield) {
    const deepCount = Math.max(1, Math.min(seedCount, Math.floor(affordable / NETWORK_FOLLOWING_DEEP)));
    const highInBatch = pool.slice(0, deepCount).some((seed) => yieldOf(seed) >= 1);
    if (highInBatch) seedCount = deepCount;
  }
  let following = Math.min(targetFollowing, Math.floor(affordable / Math.max(1, seedCount)));
  if (following < MIN_FOLLOWING) {
    following = Math.min(targetFollowing, affordable);
    seedCount = Math.max(
      1,
      Math.min(pool.length, capSeeds, Math.floor(affordable / Math.max(1, following))),
    );
    following = Math.max(1, Math.min(targetFollowing, Math.floor(affordable / seedCount)));
  }

  const leftover = pool.length - seedCount;
  if (leftover > 0 && leftover <= TAIL_ABSORB) {
    const depth = Math.floor(affordable / pool.length);
    if (depth >= MIN_FOLLOWING) {
      seedCount = pool.length;
      following = Math.min(targetFollowing, depth);
    }
  }

  if (seedCount < 1 || following < 1) return null;
  const maxItems = seedCount * following;
  const charge = Math.min(budget, roundUsd(maxItems * FOLLOWERS_RESULT_USD + FOLLOWERS_START_USD));
  return {
    seeds: pool.slice(0, seedCount),
    maxFollowingPerProfile: following,
    maxItems,
    maxTotalChargeUsd: charge,
  };
}

/** What one full network batch costs under the run budget. Used by the cost hint. */
export function plannedNetworkSpendUsd(budgetUsd = discoveryRunBudgetUsd()): number {
  const seeds = Array.from({ length: NETWORK_SEEDS_PER_BATCH }, (_, index) => `seed${index}`);
  return planNetworkBatch({ seeds, budgetUsd })?.maxTotalChargeUsd ?? 0;
}

export function fitsRunBudget(spentUsd: number, chargeUsd: number, budgetUsd: number): boolean {
  if (!(chargeUsd > 0) || !(budgetUsd > 0)) return false;
  return spentUsd + chargeUsd <= budgetUsd + 0.0005;
}

export interface ApifyMonthlyCredit {
  usedUsd: number;
  maxUsd: number;
  remainingUsd: number;
}

/** GET /v2/users/me/limits. Null when the token or the payload cannot be read. */
export async function fetchApifyMonthlyCredit(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApifyMonthlyCredit | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  try {
    const res = await fetchImpl(
      `https://api.apify.com/v2/users/me/limits?token=${encodeURIComponent(trimmed)}`,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { current?: { monthlyUsageUsd?: unknown }; limits?: { maxMonthlyUsageUsd?: unknown } };
    };
    const used = Number(json?.data?.current?.monthlyUsageUsd);
    const max = Number(json?.data?.limits?.maxMonthlyUsageUsd);
    if (!Number.isFinite(used) || !Number.isFinite(max)) return null;
    return { usedUsd: used, maxUsd: max, remainingUsd: Math.max(0, roundUsd(max - used)) };
  } catch {
    return null;
  }
}

export function monthlyLimitMessage(text: string): boolean {
  return /monthly limit reached|usage hard limit|hard limit exceeded|monthly usage limit|platform-feature-disabled|insufficient credit|all connected apify accounts are out of credit/i.test(
    text,
  );
}
