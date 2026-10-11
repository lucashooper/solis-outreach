import { afterEach, describe, expect, it } from 'vitest';
import { buildApifyActorInput } from '../discovery/apify.js';
import {
  abortApifyActorRun,
  fetchApifyDatasetItems,
  startApifyActorRun,
} from '../discovery/apify.js';
import {
  ALL_ACCOUNTS_EXHAUSTED_MESSAGE,
  apifyAccountRefs,
  clearApifyCreditCache,
  createApifyPool,
  resolveRunBudget,
  scrubApifySecrets,
} from '../discovery/apifyPool.js';
import type { Campaign } from '../discovery/types.js';

const TOKEN_A = 'token-account-a-secret';
const TOKEN_B = 'token-account-b-secret';

function limits(used: number, max: number): Response {
  return new Response(
    JSON.stringify({
      data: { current: { monthlyUsageUsd: used }, limits: { maxMonthlyUsageUsd: max } },
    }),
    { status: 200 },
  );
}

function creditBody(): string {
  return JSON.stringify({
    error: { type: 'platform-feature-disabled', message: 'Monthly usage hard limit exceeded' },
  });
}

function actorInput(): Record<string, unknown> {
  return buildApifyActorInput(
    {
      niches: ['books'],
      hashtags: ['#booktok'],
      platforms: ['tiktok'],
      result_limit: 10,
      follower_min: null,
      follower_max: null,
      engagement_rate_min: null,
      require_public_email: true,
    } as Campaign,
    'tiktok',
  );
}

afterEach(() => {
  clearApifyCreditCache();
});

describe('apify account pool', () => {
  it('orders the primary token, the fallback, then any extras without duplicates', () => {
    const refs = apifyAccountRefs({
      APIFY_TOKEN: TOKEN_A,
      APIFY_TOKEN_FALLBACK: TOKEN_B,
      APIFY_TOKENS: `${TOKEN_A}, token-account-c-secret`,
    });
    expect(refs.map((row) => row.label)).toEqual([
      'Apify account 1/3',
      'Apify account 2/3',
      'Apify account 3/3',
    ]);
    expect(JSON.stringify(refs)).not.toContain(TOKEN_A);
  });

  it('retries the same actor start on the next account after a credit error', async () => {
    const posts: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/users/me/limits')) {
        return limits(1, 20);
      }
      if (init?.method === 'POST' && url.includes('/acts/')) {
        posts.push(url);
        if (url.includes(encodeURIComponent(TOKEN_A))) {
          return new Response(creditBody(), { status: 402 });
        }
        return new Response(
          JSON.stringify({ data: { id: 'run-b', defaultDatasetId: 'ds-b', status: 'RUNNING' } }),
          { status: 201 },
        );
      }
      return new Response('no', { status: 404 });
    };
    const pool = createApifyPool({
      tokens: [TOKEN_A, TOKEN_B],
      fetchImpl: fetchImpl as typeof fetch,
    });
    const started = await startApifyActorRun('clockworks/tiktok-scraper', actorInput(), { pool });
    expect(started).toMatchObject({
      runId: 'run-b',
      accountIndex: 2,
      accountLabel: 'Apify account 2/2',
    });
    expect(posts.some((url) => url.includes(encodeURIComponent(TOKEN_A)))).toBe(true);
    expect(posts.some((url) => url.includes(encodeURIComponent(TOKEN_B)))).toBe(true);
    expect(pool.exhaustedIndexes()).toEqual([1]);

    posts.length = 0;
    await startApifyActorRun('clockworks/tiktok-scraper', actorInput(), { pool });
    expect(posts.every((url) => url.includes(encodeURIComponent(TOKEN_B)))).toBe(true);
    expect(posts.some((url) => url.includes(encodeURIComponent(TOKEN_A)))).toBe(false);
  });

  it('skips an account whose remaining credit is below the call minimum', async () => {
    const actorPosts: string[] = [];
    const limitTokens: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/users/me/limits')) {
        limitTokens.push(new URL(url).searchParams.get('token') ?? '');
        const token = new URL(url).searchParams.get('token');
        return token === TOKEN_A ? limits(9.9, 10) : limits(0, 8);
      }
      if (init?.method === 'POST' && url.includes('/acts/')) {
        actorPosts.push(url);
        return new Response(
          JSON.stringify({ data: { id: 'run-next', defaultDatasetId: 'ds-next', status: 'RUNNING' } }),
          { status: 201 },
        );
      }
      return new Response('no', { status: 404 });
    };
    const started = await startApifyActorRun('clockworks/tiktok-scraper', actorInput(), {
      pool: createApifyPool({ tokens: [TOKEN_A, TOKEN_B], fetchImpl: fetchImpl as typeof fetch }),
    });
    expect(limitTokens).toContain(TOKEN_A);
    expect(actorPosts).toHaveLength(1);
    expect(actorPosts[0]).toContain(encodeURIComponent(TOKEN_B));
    expect(actorPosts[0]).not.toContain(encodeURIComponent(TOKEN_A));
    expect(started.accountLabel).toBe('Apify account 2/2');
  });

  it('reads the dataset and aborts with the account that started the run', async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/users/me/limits')) return limits(0, 20);
      if (init?.method === 'POST' && url.includes('/acts/')) {
        return new Response(
          JSON.stringify({ data: { id: 'run-a', defaultDatasetId: 'ds-a', status: 'SUCCEEDED' } }),
          { status: 201 },
        );
      }
      if (url.includes('/datasets/ds-a/items')) return new Response('[]', { status: 200 });
      if (url.includes('/abort')) return new Response('{}', { status: 200 });
      return new Response('no', { status: 404 });
    };
    const pool = createApifyPool({
      tokens: [TOKEN_A, TOKEN_B],
      fetchImpl: fetchImpl as typeof fetch,
    });
    const started = await startApifyActorRun('clockworks/tiktok-scraper', actorInput(), { pool });
    const later = createApifyPool({
      tokens: [TOKEN_A, TOKEN_B],
      fetchImpl: fetchImpl as typeof fetch,
      bindings: [
        { runId: started.runId, datasetId: started.datasetId, accountIndex: started.accountIndex },
      ],
    });
    await fetchApifyDatasetItems('ds-a', { pool: later, accountIndex: started.accountIndex });
    await abortApifyActorRun('run-a', { pool: later, accountIndex: started.accountIndex });
    const dataset = seen.find((line) => line.includes('/datasets/ds-a/items'));
    const abort = seen.find((line) => line.includes('/abort'));
    expect(dataset).toContain(encodeURIComponent(TOKEN_A));
    expect(dataset).not.toContain(encodeURIComponent(TOKEN_B));
    expect(abort).toContain(encodeURIComponent(TOKEN_A));
    expect(abort).not.toContain(encodeURIComponent(TOKEN_B));
  });

  it('moves the next call to another account after the cached credit is spent', async () => {
    const actorPosts: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/users/me/limits')) {
        const token = new URL(url).searchParams.get('token');
        return token === TOKEN_A ? limits(9.4, 10) : limits(0, 8);
      }
      if (init?.method === 'POST' && url.includes('/acts/')) {
        actorPosts.push(url);
        return new Response(
          JSON.stringify({ data: { id: `run-${actorPosts.length}`, defaultDatasetId: 'ds', status: 'RUNNING' } }),
          { status: 201 },
        );
      }
      return new Response('no', { status: 404 });
    };
    const pool = createApifyPool({
      tokens: [TOKEN_A, TOKEN_B],
      fetchImpl: fetchImpl as typeof fetch,
    });
    const first = await startApifyActorRun('clockworks/tiktok-scraper', actorInput(), { pool });
    const second = await startApifyActorRun('clockworks/tiktok-scraper', actorInput(), { pool });
    expect(first.accountIndex).toBe(1);
    expect(second.accountIndex).toBe(2);
    expect(actorPosts[0]).toContain(encodeURIComponent(TOKEN_A));
    expect(actorPosts[1]).toContain(encodeURIComponent(TOKEN_B));
  });

  it('says every account is out of credit only after all of them fail', async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/users/me/limits')) return limits(0, 10);
      if (init?.method === 'POST') return new Response(creditBody(), { status: 403 });
      return new Response('no', { status: 404 });
    };
    await expect(
      startApifyActorRun('clockworks/tiktok-scraper', actorInput(), {
        pool: createApifyPool({ tokens: [TOKEN_A, TOKEN_B], fetchImpl: fetchImpl as typeof fetch }),
      }),
    ).rejects.toThrow(ALL_ACCOUNTS_EXHAUSTED_MESSAGE);
  });

  it('keeps the full job budget unless every account is empty', async () => {
    const kept = await resolveRunBudget({
      env: { DISCOVERY_RUN_BUDGET_USD: '1' },
      fetchImpl: (async (input: RequestInfo | URL) => {
        const token = new URL(String(input)).searchParams.get('token');
        return token === TOKEN_A ? limits(10, 10) : limits(1, 6);
      }) as typeof fetch,
      pool: createApifyPool({
        tokens: [TOKEN_A, TOKEN_B],
        fetchImpl: (async (input: RequestInfo | URL) => {
          const token = new URL(String(input)).searchParams.get('token');
          return token === TOKEN_A ? limits(10, 10) : limits(1, 6);
        }) as typeof fetch,
      }),
    });
    expect(kept.shrunk).toBe(false);
    expect(kept.budgetUsd).toBe(1);
    expect(kept.note).toBeUndefined();

    const empty = await resolveRunBudget({
      env: { DISCOVERY_RUN_BUDGET_USD: '1' },
      pool: createApifyPool({
        tokens: [TOKEN_A],
        fetchImpl: (async () => limits(10, 10)) as typeof fetch,
      }),
    });
    expect(empty.budgetUsd).toBe(0);
    expect(empty.note).toBe(ALL_ACCOUNTS_EXHAUSTED_MESSAGE);
  });

  it('caches limits for about a minute and never returns a token', async () => {
    let calls = 0;
    const pool = createApifyPool({
      tokens: [TOKEN_A, TOKEN_B],
      fetchImpl: (async () => {
        calls += 1;
        return limits(0, 4);
      }) as typeof fetch,
    });
    const first = await pool.creditSummary();
    const second = await pool.creditSummary();
    expect(calls).toBe(2);
    expect(first?.remainingUsd).toBe(8);
    expect(second?.accountCount).toBe(2);
    expect(JSON.stringify(first)).not.toContain(TOKEN_A);
    expect(JSON.stringify(second)).not.toContain(TOKEN_B);
    expect(scrubApifySecrets(`failed token=${TOKEN_A}`, [TOKEN_A])).not.toContain(TOKEN_A);
  });
});
