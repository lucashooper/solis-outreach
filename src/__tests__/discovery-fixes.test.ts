import { describe, expect, it } from 'vitest';
import { buildApifyActorInput } from '../discovery/apify.js';
import { networkPhaseBudgetUsd, planNetworkBatch } from '../discovery/budget.js';
import { actualRunChargeUsd } from '../discovery/charge.js';
import { extractEmailsFromPage, isJunkEmail } from '../discovery/bioLinkEmail.js';
import { keywordNicheScore, scoreNicheBatch } from '../discovery/nicheScore.js';
import { mergeCandidate, passesEngagementMinimum, qualifyCandidates } from '../discovery/qualify.js';
import { selectCampaignHashtags } from '../discovery/tagCooldown.js';
import type { Campaign, CreatorCandidate } from '../discovery/types.js';

const campaign = (patch: Partial<Campaign> = {}): Campaign => ({
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Books',
  niches: ['books'],
  hashtags: ['#booktok', '#books', '#bookworm', '#booklover'],
  platforms: ['tiktok'],
  follower_min: 10000,
  follower_max: 21000,
  engagement_rate_min: 3,
  result_limit: 20,
  require_public_email: true,
  auto_outreach: false,
  status: 'draft',
  app_name: 'ExampleApp',
  value_prop: 'reading',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...patch,
});

function creator(patch: Partial<CreatorCandidate>): CreatorCandidate {
  return {
    handle: 'reader',
    platform: 'tiktok',
    bio: '',
    email: null,
    follower_count: 15000,
    engagement_rate: null,
    profile_url: 'https://www.tiktok.com/@reader',
    niches: ['books'],
    discovery_source: 'network',
    discovery_seed: 'anasbookclub_',
    ...patch,
  };
}

describe('actual Apify charge', () => {
  it('prefers usageTotalUsd over the start cap', () => {
    expect(actualRunChargeUsd({ usageTotalUsd: 0.565 }, 0.991)).toBeCloseTo(0.565, 3);
  });

  it('multiplies charged events when the total is missing', () => {
    expect(
      actualRunChargeUsd(
        {
          chargedEventCounts: { result: 564, start: 1 },
          pricingPerEvent: { result: 0.001, start: 0.001 },
        },
        0.991,
      ),
    ).toBeCloseTo(0.565, 3);
  });
});

describe('network creators with no engagement rate', () => {
  it('treats a missing rate as unknown, and keeps the email when merging', () => {
    expect(passesEngagementMinimum(null, 3)).toBe(true);
    expect(passesEngagementMinimum(1, 3)).toBe(false);
    const merged = mergeCandidate(
      creator({ handle: 'reader', follower_count: 12000, email: null, bio: 'booktok' }),
      creator({
        handle: 'reader',
        follower_count: 18000,
        email: 'hi@reads.test',
        email_source: 'bio',
        bio: '',
      }),
    );
    expect(merged.follower_count).toBe(18000);
    expect(merged.email).toBe('hi@reads.test');
    expect(merged.bio).toBe('booktok');
  });

  it('saves an in-range emailed network creator the keyword filter used to drop only for engagement', async () => {
    const result = await qualifyCandidates(
      [
        creator({
          handle: 'kept',
          email: 'kept@reads.test',
          email_source: 'bio',
          bio: 'currently reading',
          engagement_rate: null,
        }),
        creator({
          handle: 'makeup',
          email: 'm@beauty.test',
          bio: 'makeup grwm',
          engagement_rate: null,
        }),
      ],
      {
        followerMin: 10000,
        followerMax: 21000,
        engagementMin: 3,
        keywords: ['reading', 'booktok', 'books'],
        categories: ['books'],
        chat: async () => {
          throw new Error('groq down');
        },
      },
    );
    expect(result.kept.map((row) => row.handle)).toEqual(['kept']);
    expect(result.withEmail).toBe(1);
    expect(result.nicheSource).toBe('keywords');
    expect(result.inRange).toHaveLength(2);
  });
});

describe('niche scores', () => {
  it('keeps a keyword hit, reviews an empty in-niche bio, and drops an off-niche bio', () => {
    expect(keywordNicheScore({ handle: 'a', bio: 'booktok reader' }, ['booktok']).band).toBe('relevant');
    expect(
      keywordNicheScore(
        { handle: 'b', bio: '', seedInNiche: true },
        ['booktok'],
      ).band,
    ).toBe('review');
    expect(keywordNicheScore({ handle: 'c', bio: 'makeup grwm' }, ['booktok']).band).toBe('drop');
  });

  it('parses a Groq batch and does not rescore a cached handle', async () => {
    const cache = new Map();
    const first = await scoreNicheBatch(
      [{ handle: 'ada', bio: 'books' }],
      {
        categories: ['books'],
        keywords: ['books'],
        cache,
        chat: async () =>
          JSON.stringify({ creators: [{ handle: 'ada', score: 0.91, reason: 'Reads on camera.' }] }),
      },
    );
    expect(first.get('ada')).toMatchObject({ score: 0.91, band: 'relevant', source: 'ai' });
    let calls = 0;
    const second = await scoreNicheBatch([{ handle: 'ada', bio: 'books' }], {
      categories: ['books'],
      keywords: ['books'],
      cache,
      chat: async () => {
        calls += 1;
        return '{"creators":[]}';
      },
    });
    expect(calls).toBe(0);
    expect(second.get('ada')?.reason).toBe('Reads on camera.');
  });
});

describe('bio link emails', () => {
  it('reads mailto and obfuscated addresses and drops junk', () => {
    const found = extractEmailsFromPage(`
      <a href="mailto:hello@reads.test">mail</a>
      <p>ada [at] reads [dot] test</p>
      <p>noreply@reads.test</p>
      <p>support@linktr.ee</p>
      <img src="banner@2x.png">
    `);
    expect(found).toEqual(expect.arrayContaining(['hello@reads.test', 'ada@reads.test']));
    expect(found).not.toContain('noreply@reads.test');
    expect(found).not.toContain('support@linktr.ee');
    expect(isJunkEmail('user@sentry.io')).toBe(true);
    expect(isJunkEmail('hello@reads.test')).toBe(false);
  });
});

describe('campaign hashtags and budget', () => {
  it('scrapes explicit tags even when another campaign scraped them today', () => {
    const now = Date.parse('2026-10-09T12:00:00.000Z');
    const picked = selectCampaignHashtags({
      explicit: ['booktok', 'books', 'bookworm'],
      planned: ['booktok', 'books', 'bookworm'],
      appHistory: [{ tag: 'booktok', scrapedAt: new Date(now).toISOString() }],
      campaignRecent: ['books'],
      now,
    });
    expect(picked.tags).toEqual(expect.arrayContaining(['#booktok', '#bookworm']));
    expect(picked.tags).not.toContain('#books');
  });

  it('sends every explicit hashtag in one actor call', () => {
    const input = buildApifyActorInput(campaign(), 'tiktok', {
      keepExplicitHashtags: true,
      hashtagBudgetUsd: 0.8,
    });
    expect(input.hashtags).toEqual(['booktok', 'books', 'bookworm', 'booklover']);
    expect(Number(input.resultsPerPage)).toBeGreaterThanOrEqual(1);
  });

  it('reserves enough for a hashtag call when the source is both', () => {
    expect(networkPhaseBudgetUsd(2, 'both')).toBeCloseTo(1.2, 3);
    expect(networkPhaseBudgetUsd(1, 'both')).toBeCloseTo(0.5, 3);
    expect(networkPhaseBudgetUsd(2, 'network')).toBe(2);
  });

  it('does not leave a single seed for its own run', () => {
    const batch = planNetworkBatch({ seeds: ['one', 'two', 'three'], budgetUsd: 0.4, followingPerProfile: 100 });
    expect(batch?.seeds.length).toBeGreaterThan(1);
  });
});
