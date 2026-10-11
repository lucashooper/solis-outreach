/**
 * Shared Apify account pool.
 * Every actor start, dataset read, run poll, limits check, and abort goes
 * through this module so a run stays on the token that started it.
 * Token values stay inside this file. Callers only see account indexes and
 * labels such as "Apify account 1/2".
 */
import {
  discoveryRunBudgetUsd,
  fetchApifyMonthlyCredit,
  roundUsd,
  type ApifyMonthlyCredit,
} from './budget.js';

/** Shown when every configured account is out of monthly credit. */
export const ALL_ACCOUNTS_EXHAUSTED_MESSAGE =
  'All connected Apify accounts are out of credit.';

/** clockworks/tiktok-scraper rejects maxTotalChargeUsd under this. */
export const TIKTOK_CHARGE_FLOOR_USD = 0.5;

/**
 * Leave a little unused credit so a limits reading that is a few cents
 * behind the live balance does not start a call Apify will refuse.
 */
export const CREDIT_SAFETY_MARGIN_USD = 0.05;

export const LIMITS_CACHE_MS = 60_000;

const ACCOUNT_LABEL_RE = /^Apify account (\d+)\/(\d+)$/;

export interface ApifyAccountRef {
  /** 1-based position in the configured list. */
  index: number;
  /** "Apify account 1/2". Never the token. */
  label: string;
  total: number;
}

export interface ApifyRoundSpend {
  accountIndex: number;
  accountLabel: string;
  chargeUsd: number;
  runId?: string;
  /** network, hashtag, profile, or expand. */
  kind?: string;
}

export interface ApifyAccountSpend {
  index: number;
  label: string;
  spentUsd: number;
}

export interface ApifyCreditSummary {
  remainingUsd: number;
  maxUsd: number;
  usedUsd: number;
  accountCount: number;
  accounts: Array<{
    index: number;
    label: string;
    remainingUsd: number;
    maxUsd: number;
    usedUsd: number;
  }>;
}

interface AccountSecret extends ApifyAccountRef {
  token: string;
}

interface CreditCacheEntry {
  at: number;
  credit: ApifyMonthlyCredit;
}

const creditCache = new Map<string, CreditCacheEntry>();

/** Drop cached limits. Tests use this so accounts do not leak between cases. */
export function clearApifyCreditCache(): void {
  creditCache.clear();
}

/**
 * Bracket access on purpose. Netlify's bundler inlines `process.env.NAME`
 * from the build shell, which would freeze an empty token into the function.
 */
function readEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function apifyAccountLabel(index: number, total: number): string {
  return `Apify account ${index}/${total}`;
}

export function isApifyAccountLabel(value: string): boolean {
  return ACCOUNT_LABEL_RE.test(value.trim());
}

/** Remove token values and query secrets from text that might be logged or returned. */
export function scrubApifySecrets(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed.length < 6) continue;
    out = out.split(trimmed).join('[redacted]');
  }
  return out.replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]');
}

/**
 * Tokens in order: APIFY_TOKEN, APIFY_TOKEN_FALLBACK, then APIFY_TOKENS.
 * Duplicates and blanks are dropped. The values themselves are not returned.
 */
export function apifyAccountRefs(env: NodeJS.ProcessEnv = process.env): ApifyAccountRef[] {
  return loadAccounts(env).map(({ token: _token, ...ref }) => ref);
}

export function apifyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadAccounts(env).length > 0;
}

function loadAccounts(env: NodeJS.ProcessEnv, explicit?: readonly string[]): AccountSecret[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    const token = (value ?? '').trim();
    if (!token || seen.has(token)) return;
    seen.add(token);
    ordered.push(token);
  };
  if (explicit) {
    for (const token of explicit) add(token);
  } else {
    add(readEnv('APIFY_TOKEN', env));
    add(readEnv('APIFY_TOKEN_FALLBACK', env));
    for (const part of readEnv('APIFY_TOKENS', env).split(',')) add(part);
  }
  const total = ordered.length;
  return ordered.map((token, offset) => {
    const index = offset + 1;
    return { token, index, total, label: apifyAccountLabel(index, total) };
  });
}

export class ApifyAccountLimitedError extends Error {
  readonly accountLimited = true;
  constructor(message: string) {
    super(message);
    this.name = 'ApifyAccountLimitedError';
  }
}

export class ApifyCreditExhaustedError extends Error {
  readonly allAccountsExhausted = true;
  constructor(message = ALL_ACCOUNTS_EXHAUSTED_MESSAGE) {
    super(message);
    this.name = 'ApifyCreditExhaustedError';
  }
}

export function isAccountLimitedError(err: unknown): boolean {
  return (
    err instanceof ApifyAccountLimitedError ||
    (err instanceof Error && (err as { accountLimited?: boolean }).accountLimited === true)
  );
}

export function isAllAccountsExhaustedError(err: unknown): boolean {
  if (err instanceof ApifyCreditExhaustedError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.trim() === ALL_ACCOUNTS_EXHAUSTED_MESSAGE;
}

/**
 * 402/403 from Apify when the account cannot spend: platform feature disabled,
 * monthly usage limit, or insufficient credit. A maxTotalChargeUsd floor
 * rejection is a different failure and must not switch accounts.
 */
export function isApifyCreditError(status: number, body: string): boolean {
  if (status !== 402 && status !== 403) return false;
  if (/max-total-charge|maxTotalChargeUsd/i.test(body) && !/hard limit|monthly usage/i.test(body)) {
    return false;
  }
  return /platform-feature-disabled|monthly usage|usage hard limit|hard limit exceeded|insufficient credit|monthly limit|not enough credit|exceeded the (maximum|monthly) usage/i.test(
    body,
  );
}

export function creditNeededUsd(chargeUsd: number): number {
  return roundUsd(Math.max(0, chargeUsd) + CREDIT_SAFETY_MARGIN_USD);
}

export interface ApifyRunBinding {
  runId: string;
  datasetId?: string | null;
  accountIndex: number;
}

export interface ApifyPool {
  readonly configured: boolean;
  readonly accounts: readonly ApifyAccountRef[];
  readonly fetchImpl: typeof fetch;
  exhaustedIndexes(): number[];
  markExhausted(index: number): void;
  remember(runId: string, datasetId: string | null, accountIndex: number): void;
  accountIndexForRun(runId: string): number | undefined;
  accountIndexForDataset(datasetId: string): number | undefined;
  creditSummary(): Promise<ApifyCreditSummary | null>;
  /**
   * Run `execute` on the first account that can fund `plannedChargeUsd`.
   * A 402/403 credit error marks that account exhausted for this pool and
   * retries the same call on the next account. When no account can cover the
   * full cap, the call is retried once on the next account that can cover
   * `minChargeUsd`, with the cap lowered to that account's remaining credit.
   */
  runWithFailover<T>(input: {
    plannedChargeUsd: number;
    minChargeUsd: number;
    execute: (ctx: {
      token: string;
      index: number;
      label: string;
      chargeUsd: number;
    }) => Promise<T>;
  }): Promise<{ result: T; accountIndex: number; accountLabel: string; chargeUsd: number }>;
  /** Token for a run or dataset. Same account that started it. */
  tokenForAccount(index: number): string;
  /**
   * The start call reserves the cap. Once Apify reports the real charge,
   * put the difference back so the next call sees the leftover credit.
   */
  reconcileSpend(index: number, plannedUsd: number, actualUsd: number): void;
}

export function createApifyPool(input?: {
  env?: NodeJS.ProcessEnv;
  /** When set, these tokens replace the environment list. Used by tests. */
  tokens?: readonly string[];
  fetchImpl?: typeof fetch;
  exhausted?: readonly number[];
  bindings?: readonly ApifyRunBinding[];
  now?: () => number;
  cacheMs?: number;
}): ApifyPool {
  const env = input?.env ?? process.env;
  const accounts = loadAccounts(env, input?.tokens);
  const fetchImpl = input?.fetchImpl ?? fetch;
  const now = input?.now ?? Date.now;
  const cacheMs = input?.cacheMs ?? LIMITS_CACHE_MS;
  const exhausted = new Set<number>(
    (input?.exhausted ?? []).filter((index) => Number.isInteger(index) && index >= 1),
  );
  const runAccounts = new Map<string, number>();
  const datasetAccounts = new Map<string, number>();
  for (const binding of input?.bindings ?? []) {
    if (!Number.isInteger(binding.accountIndex) || binding.accountIndex < 1) continue;
    if (binding.runId) runAccounts.set(binding.runId, binding.accountIndex);
    if (binding.datasetId) datasetAccounts.set(binding.datasetId, binding.accountIndex);
  }
  const tokens = accounts.map((account) => account.token);

  const refs: ApifyAccountRef[] = accounts.map(({ token: _token, ...ref }) => ref);

  function accountByIndex(index: number): AccountSecret {
    const account = accounts.find((row) => row.index === index);
    if (!account) {
      throw new Error('That Apify account is not connected.');
    }
    return account;
  }

  async function readCredit(account: AccountSecret): Promise<ApifyMonthlyCredit | null> {
    const hit = creditCache.get(account.token);
    const at = now();
    if (hit && at - hit.at < cacheMs) return hit.credit;
    const credit = await fetchApifyMonthlyCredit(account.token, fetchImpl);
    if (!credit) return null;
    creditCache.set(account.token, { at, credit });
    return credit;
  }

  function noteEmpty(account: AccountSecret, previous: ApifyMonthlyCredit | null) {
    const maxUsd = previous?.maxUsd ?? 0;
    creditCache.set(account.token, {
      at: now(),
      credit: { usedUsd: maxUsd, maxUsd, remainingUsd: 0 },
    });
  }

  /** Keep the 60s reading honest after a start, so the next call does not reuse credit already spent. */
  function noteSpend(account: AccountSecret, chargeUsd: number) {
    const hit = creditCache.get(account.token);
    if (!hit) return;
    const spent = roundUsd(Math.max(0, chargeUsd));
    creditCache.set(account.token, {
      at: hit.at,
      credit: {
        usedUsd: roundUsd(hit.credit.usedUsd + spent),
        maxUsd: hit.credit.maxUsd,
        remainingUsd: Math.max(0, roundUsd(hit.credit.remainingUsd - spent)),
      },
    });
  }

  async function tryAccount<T>(
    account: AccountSecret,
    chargeUsd: number,
    execute: (ctx: {
      token: string;
      index: number;
      label: string;
      chargeUsd: number;
    }) => Promise<T>,
  ): Promise<{ result: T; accountIndex: number; accountLabel: string; chargeUsd: number } | 'credit'> {
    try {
      const result = await execute({
        token: account.token,
        index: account.index,
        label: account.label,
        chargeUsd,
      });
      noteSpend(account, chargeUsd);
      return {
        result,
        accountIndex: account.index,
        accountLabel: account.label,
        chargeUsd,
      };
    } catch (err) {
      if (!isAccountLimitedError(err)) {
        if (err instanceof Error) {
          err.message = scrubApifySecrets(err.message, tokens);
        }
        throw err;
      }
      exhausted.add(account.index);
      const cached = creditCache.get(account.token)?.credit ?? null;
      noteEmpty(account, cached);
      return 'credit';
    }
  }

  return {
    configured: accounts.length > 0,
    accounts: refs,
    fetchImpl,
    exhaustedIndexes() {
      return [...exhausted].sort((a, b) => a - b);
    },
    markExhausted(index: number) {
      exhausted.add(index);
    },
    remember(runId: string, datasetId: string | null, accountIndex: number) {
      if (runId) runAccounts.set(runId, accountIndex);
      if (datasetId) datasetAccounts.set(datasetId, accountIndex);
    },
    accountIndexForRun(runId: string) {
      return runAccounts.get(runId);
    },
    accountIndexForDataset(datasetId: string) {
      return datasetAccounts.get(datasetId);
    },
    tokenForAccount(index: number) {
      return accountByIndex(index).token;
    },
    reconcileSpend(index: number, plannedUsd: number, actualUsd: number) {
      const account = accounts.find((row) => row.index === index);
      if (!account) return;
      noteSpend(account, roundUsd(actualUsd - plannedUsd));
    },
    async creditSummary() {
      const rows: ApifyCreditSummary['accounts'] = [];
      for (const account of accounts) {
        const credit = await readCredit(account);
        if (!credit) continue;
        rows.push({
          index: account.index,
          label: account.label,
          remainingUsd: credit.remainingUsd,
          maxUsd: credit.maxUsd,
          usedUsd: credit.usedUsd,
        });
      }
      if (rows.length === 0) return null;
      return {
        remainingUsd: roundUsd(rows.reduce((sum, row) => sum + row.remainingUsd, 0)),
        maxUsd: roundUsd(rows.reduce((sum, row) => sum + row.maxUsd, 0)),
        usedUsd: roundUsd(rows.reduce((sum, row) => sum + row.usedUsd, 0)),
        accountCount: accounts.length,
        accounts: rows,
      };
    },
    async runWithFailover(args) {
      if (accounts.length === 0) {
        throw new Error(
          'Apify discovery requires APIFY_TOKEN. Set it in the server environment (.env / .env.local.secrets), not localStorage.',
        );
      }
      const planned = roundUsd(Math.max(0, args.plannedChargeUsd));
      const minimum = roundUsd(Math.max(0, args.minChargeUsd));
      const needed = creditNeededUsd(planned);
      const low: { account: AccountSecret; remaining: number }[] = [];

      for (const account of accounts) {
        if (exhausted.has(account.index)) continue;
        const credit = await readCredit(account);
        if (credit && credit.remainingUsd + 0.0005 < needed) {
          low.push({ account, remaining: credit.remainingUsd });
          continue;
        }
        const outcome = await tryAccount(account, planned, args.execute);
        if (outcome === 'credit') continue;
        return outcome;
      }

      for (const row of low) {
        if (exhausted.has(row.account.index)) continue;
        const affordable = roundUsd(row.remaining - CREDIT_SAFETY_MARGIN_USD);
        if (!(affordable + 0.0005 >= minimum)) continue;
        const charge = roundUsd(Math.min(planned, affordable));
        const outcome = await tryAccount(row.account, charge, args.execute);
        if (outcome === 'credit') continue;
        return outcome;
      }

      throw new ApifyCreditExhaustedError();
    },
  };
}

export function summariseAccountSpend(rounds: readonly ApifyRoundSpend[]): ApifyAccountSpend[] {
  const map = new Map<number, ApifyAccountSpend>();
  for (const round of rounds) {
    if (!Number.isInteger(round.accountIndex) || round.accountIndex < 1) continue;
    if (!isApifyAccountLabel(round.accountLabel)) continue;
    const current = map.get(round.accountIndex) ?? {
      index: round.accountIndex,
      label: round.accountLabel,
      spentUsd: 0,
    };
    current.spentUsd = roundUsd(current.spentUsd + (Number(round.chargeUsd) || 0));
    map.set(round.accountIndex, current);
  }
  return [...map.values()].sort((a, b) => a.index - b.index);
}

export interface ResolvedRunBudget {
  budgetUsd: number;
  plannedUsd: number;
  remainingUsd: number | null;
  /** Kept for older callers. The job budget is no longer reduced to one account. */
  shrunk: boolean;
  note?: string;
}

/**
 * The job budget stays at DISCOVERY_RUN_BUDGET_USD. It is not cut down to the
 * credit left on one account. The budget is zero only when every connected
 * account has no monthly credit left.
 */
export async function resolveRunBudget(input: {
  token?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  pool?: ApifyPool;
}): Promise<ResolvedRunBudget> {
  const planned = discoveryRunBudgetUsd(input.env);
  const pool =
    input.pool ??
    createApifyPool({
      env: input.env,
      tokens: input.token != null ? [input.token] : undefined,
      fetchImpl: input.fetchImpl,
    });
  if (!pool.configured) {
    return { budgetUsd: planned, plannedUsd: planned, remainingUsd: null, shrunk: false };
  }
  const summary = await pool.creditSummary();
  const known = summary?.accounts ?? [];
  const allEmpty =
    known.length > 0 && known.every((row) => row.remainingUsd <= 0) && known.length === pool.accounts.length;
  if (allEmpty) {
    return {
      budgetUsd: 0,
      plannedUsd: planned,
      remainingUsd: summary?.remainingUsd ?? 0,
      shrunk: false,
      note: ALL_ACCOUNTS_EXHAUSTED_MESSAGE,
    };
  }
  return {
    budgetUsd: planned,
    plannedUsd: planned,
    remainingUsd: summary?.remainingUsd ?? null,
    shrunk: false,
  };
}
