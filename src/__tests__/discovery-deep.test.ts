import { describe, expect, it } from 'vitest';
import { planNetworkBatch } from '../discovery/budget.js';
import { clearApifyCreditCache, resolveRunBudget } from '../discovery/apifyPool.js';
import { activeCategoryIds, categoryOfTag } from '../discovery/categories.js';
import { narrowRangeHint } from '../discovery/funnel.js';
import {
  filterNetworkBatch,
  planFollowUpNetworkBatch,
  rankNetworkSeeds,
  relevanceKeywords,
  matchesRelevance,
} from '../discovery/network.js';
import {
  applyTagRound,
  emptyTagStat,
  planCategoryRotation,
  preferredSeedTags,
  rankTagsByMemory,
  yieldPer100,
} from '../discovery/tagMemory.js';

const DAY = 24 * 60 * 60 * 1000;

describe('network batches', () => {
  it('prefers depth over a wide shallow batch inside a $1 budget', () => {
    const seeds = Array.from({ length: 40 }, (_, index) => `seed${index}`);
    const batch = planNetworkBatch({ seeds, budgetUsd: 1 });
    expect(batch?.seeds).toHaveLength(6);
    expect(batch?.maxFollowingPerProfile).toBeGreaterThanOrEqual(150);
    expect(batch?.maxFollowingPerProfile).toBeLessThanOrEqual(180);
    expect(batch?.maxItems).toBe((batch?.seeds.length ?? 0) * (batch?.maxFollowingPerProfile ?? 0));
    expect(batch?.maxTotalChargeUsd).toBeLessThanOrEqual(1);
    expect(batch?.maxTotalChargeUsd).toBeCloseTo(0.997, 3);
  });

  it('uses about 150 following accounts when the budget can pay for them', () => {
    const batch = planNetworkBatch({
      seeds: Array.from({ length: 15 }, (_, index) => `seed${index}`),
      budgetUsd: 2,
    });
    expect(batch?.seeds).toHaveLength(15);
    expect(batch?.maxFollowingPerProfile).toBeGreaterThanOrEqual(130);
    expect(batch?.maxFollowingPerProfile).toBeLessThanOrEqual(180);
    expect(batch?.maxTotalChargeUsd).toBeLessThanOrEqual(2);
  });

  it('gives high-yield seeds a deeper read and absorbs a one-seed tail', () => {
    const deep = planNetworkBatch({
      seeds: Array.from({ length: 15 }, (_, index) => `seed${index}`),
      budgetUsd: 2,
      yieldBySeed: new Map([['seed0', 4]]),
    });
    expect(deep?.maxFollowingPerProfile).toBe(200);
    expect(deep?.seeds.length).toBeLessThanOrEqual(9);
    const tail = planNetworkBatch({
      seeds: ['a', 'b', 'c'],
      budgetUsd: 1,
      followingPerProfile: 80,
    });
    expect(tail?.seeds).toEqual(['a', 'b', 'c']);
    expect(tail?.maxFollowingPerProfile).toBeGreaterThanOrEqual(30);
  });

  it('keeps going to the next batch until the budget is spent, then hops once', () => {
    const seeds = Array.from({ length: 30 }, (_, index) => `seed${index}`);
    const first = planFollowUpNetworkBatch({
      queue: seeds,
      hopped: false,
      fresh: 0,
      goal: 25,
      spentUsd: 0,
      budgetUsd: 4,
      hopCandidates: [],
      used: new Set(),
      hidden: new Set(),
    });
    expect(first?.batch.seeds).toHaveLength(15);
    expect(first?.hopped).toBe(false);
    expect(first?.queueAfter).toHaveLength(15);

    const second = planFollowUpNetworkBatch({
      queue: first?.queueAfter ?? [],
      hopped: false,
      fresh: 4,
      goal: 25,
      spentUsd: first?.batch.maxTotalChargeUsd ?? 0,
      budgetUsd: 4,
      hopCandidates: [{ handle: 'freshreader', followerCount: 18000 }],
      used: new Set((first?.batch.seeds ?? []).map((seed) => seed.toLowerCase())),
      hidden: new Set(),
    });
    expect(second?.hopped).toBe(false);
    expect(second?.batch.maxTotalChargeUsd).toBeLessThanOrEqual(
      4 - (first?.batch.maxTotalChargeUsd ?? 0) + 0.001,
    );
    expect(second?.batch.seeds.length).toBeGreaterThan(0);
    expect(second?.batch.seeds.length).toBeLessThan(15);

    const blocked = planFollowUpNetworkBatch({
      queue: second?.queueAfter ?? [],
      hopped: false,
      fresh: 4,
      goal: 25,
      spentUsd: 2,
      budgetUsd: 2,
      hopCandidates: [{ handle: 'freshreader', followerCount: 18000 }],
      used: new Set(),
      hidden: new Set(),
    });
    expect(blocked).toBeNull();

    const hop = planFollowUpNetworkBatch({
      queue: [],
      hopped: false,
      fresh: 4,
      goal: 25,
      spentUsd: 0.2,
      budgetUsd: 1,
      hopCandidates: [
        { handle: 'freshreader', followerCount: 18000 },
        { handle: 'hiddenone', followerCount: 20000 },
        { handle: 'tiny', followerCount: 400 },
      ],
      used: new Set(['seed0']),
      hidden: new Set(['hiddenone']),
    });
    expect(hop?.hopped).toBe(true);
    expect(hop?.batch.seeds).toEqual(['freshreader']);
  });

  it('never re-requests a hidden seed inside 60 days and prefers yield then range', () => {
    const now = Date.parse('2026-10-08T12:00:00.000Z');
    const keywords = relevanceKeywords('books', ['#booktok']);
    const handles = rankNetworkSeeds({
      now,
      keywords,
      followerMin: 10_000,
      followerMax: 26_000,
      limit: 5,
      usedAt: new Map([['cooled', now - 2 * DAY]]),
      hiddenAt: new Map([['hiddenlist', now - 10 * DAY]]),
      creators: [
        {
          handle: 'hiddenlist',
          platform: 'tiktok',
          follower_count: 18000,
          bio: 'booktok',
          qualifyingCount: 20,
        },
        {
          handle: 'cooled',
          platform: 'tiktok',
          follower_count: 18000,
          bio: 'booktok',
        },
        {
          handle: 'far',
          platform: 'tiktok',
          follower_count: 140000,
          bio: 'booktok reader',
          qualifyingCount: 1,
        },
        {
          handle: 'close',
          platform: 'tiktok',
          follower_count: 16000,
          bio: 'currently reading',
          qualifyingCount: 4,
          lastResultCount: 80,
        },
        {
          handle: 'snowball',
          platform: 'tiktok',
          follower_count: 22000,
          bio: 'skincare only',
          networkDiscovered: true,
        },
        {
          handle: 'oldhidden',
          platform: 'tiktok',
          follower_count: 15000,
          bio: 'booktok',
        },
      ],
    });
    expect(handles[0]).toBe('close');
    expect(handles).not.toContain('hiddenlist');
    expect(handles).not.toContain('cooled');
    expect(handles).toContain('snowball');
    expect(handles).toContain('far');
  });
});

describe('relevance categories', () => {
  it('opens every ExampleApp category and counts them on the funnel', () => {
    expect(activeCategoryIds({ appName: 'ExampleApp', niches: ['books'], hashtags: ['#booktok'] })).toEqual(
      expect.arrayContaining(['books', 'study', 'productivity', 'desk']),
    );
    const keywords = relevanceKeywords('books', ['#booktok'], { appName: 'ExampleApp' });
    expect(matchesRelevance('studyblr student revising for an exam', keywords)).toBe(true);
    expect(matchesRelevance('notion planner and daily routine', keywords)).toBe(true);
    expect(matchesRelevance('weekend in politics', keywords)).toBe(false);

    const batch = filterNetworkBatch({
      seeds: ['seed'],
      followerMin: 10000,
      followerMax: 26000,
      requireEmail: true,
      keywords,
      categories: activeCategoryIds({ appName: 'ExampleApp', hashtags: ['#booktok'] }),
      rows: [
        {
          connectionType: 'following',
          connectedTo: { name: 'seed' },
          authorMeta: {
            name: 'studynotes',
            fans: 18000,
            signature: 'studyblr uni exams hello@study.test',
          },
        },
        {
          connectionType: 'following',
          connectedTo: { name: 'seed' },
          authorMeta: {
            name: 'bookish',
            fans: 15000,
            signature: 'booktok reads hi@books.test',
          },
        },
      ],
    });
    expect(batch.creators.map((row) => row.handle).sort()).toEqual(['bookish', 'studynotes']);
    expect(batch.stats.categoryCounts?.study).toBeGreaterThan(0);
    expect(batch.stats.categoryCounts?.books).toBeGreaterThan(0);
    expect(batch.stats.seedResults?.[0]).toMatchObject({ handle: 'seed', hidden: false });
  });
});

describe('tag memory', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');

  it('ranks by new creators per 100 videos and suppresses two dry rounds', () => {
    const strong = applyTagRound(emptyTagStat('#studytok'), {
      tag: '#studytok',
      videos: 100,
      inRange: 12,
      withEmail: 8,
      newSaved: 8,
    }, now);
    const dry = applyTagRound(
      applyTagRound(emptyTagStat('#booktok'), {
        tag: '#booktok',
        videos: 25,
        inRange: 0,
        withEmail: 0,
        newSaved: 0,
      }, now),
      { tag: '#booktok', videos: 30, inRange: 0, withEmail: 0, newSaved: 0 },
      now,
    );
    expect(yieldPer100(strong)).toBe(8);
    expect(dry.dryRounds).toBe(2);
    expect(Date.parse(dry.suppressedUntil ?? '') - now).toBe(30 * DAY);
    const once = applyTagRound(emptyTagStat('#books'), {
      tag: '#books',
      videos: 40,
      inRange: 0,
      withEmail: 0,
      newSaved: 0,
    }, now);
    expect(once.dryRounds).toBe(1);
    expect(once.suppressedUntil).toBeNull();
    const ranked = rankTagsByMemory(['#booktok', '#reading', '#studytok'], [strong, dry]);
    expect(ranked[0]).toBe('#studytok');
    expect(ranked[ranked.length - 1]).toBe('#booktok');
    expect(preferredSeedTags({
      categories: ['study', 'books'],
      stats: [dry],
      blocked: ['#studytok'],
      now,
    })).not.toContain('#booktok');
  });

  it('rotates off a thin book round onto the next category', () => {
    const rotation = planCategoryRotation({
      previousTags: ['#booktok', '#reading'],
      previousFlags: ['thin', 'insufficient'],
      tried: ['#booktok', '#books', '#reading'],
      categories: activeCategoryIds({ appName: 'ExampleApp' }),
      now,
    });
    expect(categoryOfTag('#booktok')).toBe('books');
    expect(rotation?.category).toBe('study');
    expect(rotation?.tags).toEqual(['#studytok', '#studyblr']);
    expect(rotation?.message).toBe('Book tags were thin, switched to study: #studytok, #studyblr');
    expect(planCategoryRotation({
      previousTags: ['#booktok'],
      previousFlags: ['strong'],
      categories: activeCategoryIds({ appName: 'ExampleApp' }),
    })).toBeNull();
  });
});

describe('budget and range', () => {
  it('keeps the chosen run budget when one account is short of it', async () => {
    clearApifyCreditCache();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          data: { current: { monthlyUsageUsd: 9.8 }, limits: { maxMonthlyUsageUsd: 10 } },
        }),
        { status: 200 },
      );
    const kept = await resolveRunBudget({
      token: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: { DISCOVERY_RUN_BUDGET_USD: '1' },
    });
    expect(kept.shrunk).toBe(false);
    expect(kept.budgetUsd).toBe(1);
    expect(kept.note).toBeUndefined();

    clearApifyCreditCache();
    const empty = await resolveRunBudget({
      token: 'token',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            data: { current: { monthlyUsageUsd: 10 }, limits: { maxMonthlyUsageUsd: 10 } },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
      env: {},
    });
    expect(empty.budgetUsd).toBe(0);
    expect(empty.note).toBe('All connected Apify accounts are out of credit.');
  });

  it('hints when the follower window is narrower than 3×', () => {
    expect(narrowRangeHint(10_000, 26_000)).toMatch(/5k–50k/);
    expect(narrowRangeHint(5_000, 50_000)).toBeNull();
    expect(narrowRangeHint(0, 50_000)).toBeNull();
  });
});
