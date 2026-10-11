import { describe, expect, it, vi } from 'vitest';
import {
  controlsForActorInput,
  networkChargeError,
  startApifyActorRun,
} from '../discovery/apify.js';
import { discoveryFunnelMessage } from '../discovery/funnel.js';
import {
  buildFollowersActorInput,
  filterNetworkBatch,
  mapFollowingRow,
  matchesRelevance,
  networkFunnelMessage,
  rankNetworkSeeds,
  relevanceKeywords,
  requestedSeedCount,
} from '../discovery/network.js';
import { classifyFunnelReason, discoveryOutcomeCopy, reasonFromError } from '../discovery/runOutcome.js';
import { applyTagCooldown, cooldownMessage } from '../discovery/tagCooldown.js';
import type { DiscoveryFunnel } from '../discovery/types.js';

const DAY = 24 * 60 * 60 * 1000;

function followingRow(overrides: {
  handle: string;
  nick?: string;
  fans: number;
  signature?: string;
  bioLink?: string;
  seed?: string;
  privateAccount?: boolean;
  connectionType?: string;
  avatar?: string;
}) {
  return {
    connectionType: overrides.connectionType ?? 'following',
    connectedTo: { name: overrides.seed ?? 'bookseed' },
    authorMeta: {
      name: overrides.handle,
      nickName: overrides.nick ?? overrides.handle,
      fans: overrides.fans,
      signature: overrides.signature ?? '',
      bioLink: overrides.bioLink ? { link: overrides.bioLink } : null,
      privateAccount: overrides.privateAccount === true,
      verified: false,
      avatar: overrides.avatar ?? 'https://cdn.example/a.jpg',
    },
  };
}

describe('following-row mapping', () => {
  it('maps a nested following row onto the hashtag creator shape', () => {
    const mapped = mapFollowingRow(
      followingRow({
        handle: 'pageandpine',
        nick: 'Page & Pine',
        fans: 18400,
        signature: 'bookish reads · collabs page@example.com',
        bioLink: 'https://pageandpine.example',
        seed: 'midlistreads',
        avatar: 'https://cdn.example/pine.jpg',
      }),
    );
    expect(mapped?.privateAccount).toBe(false);
    expect(mapped?.seed).toBe('midlistreads');
    expect(mapped?.candidate).toMatchObject({
      handle: 'pageandpine',
      display_name: 'Page & Pine',
      platform: 'tiktok',
      follower_count: 18400,
      email: 'page@example.com',
      bio: 'bookish reads · collabs page@example.com',
      avatar_url: 'https://cdn.example/pine.jpg',
      profile_url: 'https://www.tiktok.com/@pageandpine',
      top_videos: [],
      discovery_source: 'network',
      discovery_seed: 'midlistreads',
    });
  });

  it('drops private accounts, follower rows, and the seed itself', () => {
    expect(mapFollowingRow(followingRow({ handle: 'hidden', fans: 12000, connectionType: 'follower' }))).toBeNull();
    const batch = filterNetworkBatch({
      seeds: ['bookseed'],
      followerMin: 10000,
      followerMax: 21000,
      requireEmail: false,
      keywords: relevanceKeywords('books', ['#booktok']),
      rows: [
        followingRow({ handle: 'bookseed', fans: 40000, signature: 'booktok' }),
        followingRow({ handle: 'quietreader', fans: 15000, signature: 'private reader', privateAccount: true }),
        followingRow({ handle: 'novelnotes', nick: 'Novel Notes', fans: 16000, signature: 'literary fiction reader' }),
      ],
    });
    expect(batch.creators.map((row) => row.handle)).toEqual(['novelnotes']);
    expect(batch.stats.rows).toBe(3);
    expect(batch.stats.seedsHidden).toBe(0);
  });
});

describe('relevance filter', () => {
  const keywords = relevanceKeywords('book club', ['#booktok', '#the']);

  it('matches book words and short keywords only on a boundary', () => {
    expect(keywords).toEqual(
      expect.arrayContaining(['book', 'club', 'booktok', 'read', 'lit', 'novel', 'reader']),
    );
    expect(matchesRelevance('weekend in politics', keywords)).toBe(false);
    expect(matchesRelevance('spread the word', keywords)).toBe(false);
    expect(matchesRelevance('literary fiction and novels', keywords)).toBe(true);
    expect(matchesRelevance('booktok currently reading', keywords)).toBe(true);
    expect(matchesRelevance('skincare and brunch', keywords)).toBe(false);
  });

  it('keeps in-range relevant emails and dedupes against the CRM and the batch', () => {
    const batch = filterNetworkBatch({
      seeds: ['seedone', 'seedtwo'],
      followerMin: 10000,
      followerMax: 21000,
      requireEmail: true,
      keywords,
      knownKeys: new Set(['tiktok:alreadyhere']),
      niches: ['books'],
      rows: [
        followingRow({
          handle: 'pageandpine',
          nick: 'Page',
          fans: 12000,
          signature: 'booktok · hi page@example.com',
          seed: 'seedone',
        }),
        followingRow({
          handle: 'pageandpine',
          fans: 18000,
          signature: 'books page@example.com',
          seed: 'seedtwo',
        }),
        followingRow({
          handle: 'alreadyhere',
          fans: 15000,
          signature: 'reader already@example.com',
          seed: 'seedone',
        }),
        followingRow({
          handle: 'brunchclub',
          fans: 14000,
          signature: 'lifestyle brunch@example.com',
          seed: 'seedtwo',
        }),
        followingRow({
          handle: 'tinybooks',
          fans: 800,
          signature: 'books tiny@example.com',
          seed: 'seedone',
        }),
        followingRow({ handle: 'nolist', fans: 1, seed: 'seedhidden', signature: 'books' }),
      ],
    });
    expect(batch.creators.map((row) => row.handle)).toEqual(['pageandpine']);
    expect(batch.creators[0]?.follower_count).toBe(18000);
    expect(batch.creators[0]?.niches).toEqual(['books']);
    expect(batch.existing.map((row) => row.handle)).toEqual(['alreadyhere']);
    expect(batch.stats).toMatchObject({
      seedsRequested: 2,
      seedsReturned: 2,
      seedsHidden: 0,
      rows: 6,
      inRange: 3,
      withEmail: 3,
      relevant: 2,
      existing: 1,
      fresh: 1,
    });
    expect(networkFunnelMessage(batch.stats)).toBe(
      'Creator network: 6 rows from 2 seeds (2 lists, 0 hidden) → 3 in range → 3 with a public email → 2 relevant → 1 new. 1 already in the CRM.',
    );
  });
});

describe('network seeds', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const keywords = relevanceKeywords('books', []);

  it('asks for twice the productive seeds and skips a seed used in the last 14 days', () => {
    expect(requestedSeedCount(10)).toBe(6);
    expect(requestedSeedCount(5)).toBe(4);
    expect(requestedSeedCount(50)).toBe(14);
    const usedAt = new Map([['cooled', now - 2 * DAY]]);
    const handles = rankNetworkSeeds({
      now,
      keywords,
      limit: requestedSeedCount(10),
      usedAt,
      creators: [
        { handle: 'cooled', platform: 'tiktok', follower_count: 140000, bio: 'booktok reader', niches: ['books'] },
        { handle: 'celebrity', platform: 'tiktok', follower_count: 2_000_000, bio: 'books', niches: ['books'] },
        { handle: 'tiny', platform: 'tiktok', follower_count: 400, bio: 'books', niches: ['books'] },
        { handle: 'chef', platform: 'tiktok', follower_count: 40000, bio: 'recipes only', niches: ['food'] },
        { handle: 'igonly', platform: 'instagram', follower_count: 40000, bio: 'booktok', niches: ['books'] },
        { handle: 'ready', platform: 'tiktok', follower_count: 22000, bio: 'currently reading', niches: ['books'] },
        { handle: '@Bigger', platform: 'tiktok', follower_count: 80000, bio: 'book reviews', niches: ['books'] },
      ],
    });
    expect(handles).toEqual(['Bigger', 'ready']);
  });

  it('sets maxItems to seeds times the default depth and strips the internal flag', () => {
    const input = buildFollowersActorInput(['@Ada', 'ada', 'Bea']);
    expect(input).toMatchObject({
      profiles: ['Ada', 'Bea'],
      maxFollowersPerProfile: 0,
      maxFollowingPerProfile: 180,
      networkScrape: true,
    });
    const controls = controlsForActorInput(input ?? {});
    expect(controls.maxItems).toBe(360);
    expect(controls.maxTotalChargeUsd).toBeGreaterThanOrEqual(0.02);
    expect(controls.maxTotalChargeUsd).toBeLessThan(1);
  });

  it('retries a rejected followers charge cap once, then explains the failure', async () => {
    const charges: number[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/users/me/limits')) {
        return new Response(
          JSON.stringify({
            data: { current: { monthlyUsageUsd: 0 }, limits: { maxMonthlyUsageUsd: 20 } },
          }),
          { status: 200 },
        );
      }
      const charge = Number(new URL(url).searchParams.get('maxTotalChargeUsd'));
      charges.push(charge);
      return new Response(
        JSON.stringify({ error: { message: 'maxTotalChargeUsd must be at least 0.5' } }),
        { status: 400 },
      );
    });
    await expect(
      startApifyActorRun('clockworks/tiktok-followers-scraper', buildFollowersActorInput(['seed']) ?? {}, {
        token: 'test-token',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/creator-network cost cap/);
    expect(charges).toEqual([
      controlsForActorInput(buildFollowersActorInput(['seed']) ?? {}).maxTotalChargeUsd,
      0.5,
    ]);
    expect(reasonFromError(networkChargeError('maxTotalChargeUsd rejected'))).toBe('network_charge_rejected');
    expect(discoveryOutcomeCopy('network_charge_rejected')?.title).toMatch(/cost cap/);
  });
});

describe('tag cooldown', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');

  it('skips a tag scraped for this app in the last 10 days', () => {
    const cooled = applyTagCooldown(
      ['#booktok', '#authortok'],
      [{ tag: 'booktok', scrapedAt: new Date(now - 2 * DAY).toISOString() }],
      { now },
    );
    expect(cooled.tags).toEqual(['#authortok']);
    expect(cooled.skipped).toEqual([{ tag: '#booktok', daysAgo: 2 }]);
    expect(cooldownMessage(cooled.skipped)).toBe('Skipped #booktok, searched 2 days ago');
  });

  it('keeps a tag the user typed as a custom tag', () => {
    const kept = applyTagCooldown(
      ['#booktok'],
      [{ tag: '#booktok', scrapedAt: new Date(now - DAY).toISOString() }],
      { now, allow: ['booktok'] },
    );
    expect(kept.tags).toEqual(['#booktok']);
    expect(kept.skipped).toEqual([]);
  });
});

describe('funnel reasons', () => {
  const base: DiscoveryFunnel = {
    rawItems: 0,
    uniqueCreators: 0,
    afterFollowers: 0,
    afterDedupe: 0,
    withEmail: 0,
    saved: 0,
    followerMin: 10000,
    followerMax: 21000,
    apifyRunIds: [],
  };

  it('says which tags were skipped and classifies an all-cooldown search', () => {
    const funnel: DiscoveryFunnel = {
      ...base,
      skippedTags: [{ tag: '#booktok', daysAgo: 2 }],
    };
    expect(discoveryFunnelMessage(funnel)).toBe('Skipped #booktok, searched 2 days ago');
    expect(classifyFunnelReason(funnel)).toBe('tags_on_cooldown');
    expect(discoveryOutcomeCopy('tags_on_cooldown')?.title).toMatch(/10 days/);
  });

  it('leads with the creator-network counts when following lists ran', () => {
    const funnel: DiscoveryFunnel = {
      ...base,
      network: {
        seedsRequested: 6,
        seedsReturned: 3,
        seedsHidden: 3,
        seeds: ['a', 'b', 'c', 'd', 'e', 'f'],
        hiddenSeeds: ['d', 'e', 'f'],
        rows: 90,
        inRange: 22,
        withEmail: 9,
        relevant: 14,
        existing: 6,
        fresh: 3,
      },
    };
    expect(discoveryFunnelMessage(funnel)).toBe(
      'Creator network: 90 rows from 6 seeds (3 lists, 3 hidden) → 22 in range → 9 with a public email → 14 relevant → 3 new. 6 already in the CRM.',
    );
    expect(classifyFunnelReason({ ...funnel, saved: 3, afterFollowers: 3, afterDedupe: 3 })).toBe('ok');
  });
});
