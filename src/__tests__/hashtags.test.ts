import { describe, expect, it } from 'vitest';
import {
  apifyActorBody,
  apifyRunControls,
  buildApifyActorInput,
  buildProfileEnrichInput,
  buildTopUpActorInput,
  cappedResultLimit,
  controlsForActorInput,
  formatApifyError,
  nicheSearchTerms,
  perTermResultCount,
} from '../discovery/apify.js';
import {
  campaignSearchTerms,
  normaliseHashtag,
  normaliseHashtags,
  normaliseNiche,
  partitionListInput,
  suggestBusinessHashtags,
} from '../discovery/hashtags.js';
import type { Campaign } from '../discovery/types.js';

function campaign(partial: Partial<Campaign>): Campaign {
  return {
    id: 'c1',
    name: 'Test',
    niches: ['fitness'],
    platforms: ['tiktok'],
    follower_min: 5000,
    follower_max: 35000,
    engagement_rate_min: 4,
    result_limit: 10,
    auto_outreach: false,
    require_public_email: false,
    status: 'draft',
    app_name: 'Astra',
    value_prop: null,
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

describe('hashtag normalisation', () => {
  it('adds a single leading hash and lower-cases the tag', () => {
    expect(normaliseHashtag('booktok')).toBe('#booktok');
    expect(normaliseHashtag('#BookTok')).toBe('#booktok');
    expect(normaliseHashtag('##deepstash')).toBe('#deepstash');
    expect(normaliseHashtag('  study tok ')).toBe('#studytok');
    expect(normaliseHashtag('###')).toBe('');
  });

  it('dedupes a list', () => {
    expect(normaliseHashtags(['#booktok', 'booktok', '#StudyTok'])).toEqual([
      '#booktok',
      '#studytok',
    ]);
  });

  it('splits a comma-separated paste into separate tags', () => {
    const { parts, rest } = partitionListInput('deepstash, booktok, studytok', true);
    expect(rest).toBe('');
    expect(normaliseHashtags(parts)).toEqual(['#deepstash', '#booktok', '#studytok']);
  });

  it('keeps the unfinished fragment until Enter, Add, or blur', () => {
    expect(partitionListInput('deepstash, book', false)).toEqual({
      parts: ['deepstash'],
      rest: 'book',
    });
    expect(partitionListInput('deepstash, booktok,', false).parts).toEqual([
      'deepstash',
      'booktok',
    ]);
  });

  it('normalises niches the same way, without a hash', () => {
    const { parts } = partitionListInput('Fitness, food\ntech', true);
    expect(parts.map(normaliseNiche)).toEqual(['fitness', 'food', 'tech']);
  });
});

describe('Apify hashtag targeting', () => {
  it('uses one niche hashtag instead of expanding into extra queries', () => {
    const input = buildApifyActorInput(campaign({ result_limit: 5 }), 'tiktok');
    expect(input.hashtags).toEqual(['fitness', 'fitnesstok']);
    expect(input.searchQueries).toEqual(['fitness']);
    expect(input.resultsPerPage).toBe(5);
    expect(input.resultsLimit).toBe(5);
    expect(input.scrapeAdditionalAuthorMeta).toBe(false);
  });

  it('sends explicit hashtags ahead of broad niche tags', () => {
    const input = buildApifyActorInput(
      campaign({
        niches: ['books'],
        hashtags: ['#booktok', '#studytok', '#deepstash'],
      }),
      'tiktok',
    );
    expect(input.hashtags).toEqual(['booktok', 'studytok']);
    expect(input.searchQueries).toEqual(['booktok']);
    expect(input.resultsPerPage).toBe(10);
  });

  it('splits a 3× raw budget across terms and keeps a single term at 3×', () => {
    expect(perTermResultCount(5, 3)).toBe(5);
    const input = buildApifyActorInput(
      campaign({ result_limit: 5, niches: [], hashtags: ['#booktok'] }),
      'instagram',
    );
    expect(input.resultsLimit).toBe(15);
    expect(input.savedResultLimit).toBe(5);
  });

  it('names Apify limit, auth, timeout, and cost-cap failures', () => {
    expect(formatApifyError(401, '{"error":"unauthorized"}')).toMatch(/rejected the token/);
    expect(formatApifyError(403, 'usage hard limit exceeded')).toMatch(/out of credit/);
    expect(formatApifyError(402, 'maxTotalChargeUsd reached')).toMatch(/cost cap/);
    expect(formatApifyError(500, 'actor TIMED-OUT')).toMatch(/timed out/);
  });

  it('uses the first explicit tag as the Instagram hashtag search', () => {
    const input = buildApifyActorInput(
      campaign({ niches: ['books'], hashtags: ['#booktok'] }),
      'instagram',
    );
    expect(input.search).toBe('booktok');
    expect(input.searchType).toBe('hashtag');
  });

  it('does not invent generic hashtags when tags are present and niches are empty', () => {
    const derived = nicheSearchTerms([]);
    const terms = campaignSearchTerms({ niches: [], hashtags: ['#booktok'] }, derived);
    expect(terms.hashtags).toEqual(['booktok']);
    expect(terms.hashtags).not.toContain('creator');
  });

  it('caps the actor run and estimates a much smaller charge', () => {
    const beforeItems = 8 * 50;
    const before = estimateUsd({ items: beforeItems, profiles: true, memoryMb: 4096, seconds: 120 });
    const controls = apifyRunControls(5);
    const after = estimateUsd({
      items: controls.maxItems,
      profiles: false,
      memoryMb: controls.memory,
      seconds: 60,
    });
    expect(controls.memory).toBe(1024);
    expect(controls.maxItems).toBe(15);
    expect(controls.maxTotalChargeUsd).toBe(0.5);
    expect(before).toBeGreaterThan(1);
    expect(after).toBeLessThan(0.05);
  });

  it('raises the saved limit to 100 and the charge cap only as far as the pull needs', () => {
    expect(cappedResultLimit(80)).toBe(80);
    expect(cappedResultLimit(150)).toBe(100);
    expect(apifyRunControls(80).maxTotalChargeUsd).toBeGreaterThan(0.5);
    expect(apifyRunControls(80).maxTotalChargeUsd).toBeLessThanOrEqual(1);
    expect(apifyRunControls(5).memory).toBe(1024);
    expect(apifyRunControls(100).timeoutSecs).toBe(90);
  });

  it('widens the video pool when a public email is required', () => {
    const input = buildApifyActorInput(
      campaign({
        result_limit: 20,
        require_public_email: true,
        niches: [],
        hashtags: ['#booktok'],
      }),
      'tiktok',
    );
    expect(input.resultsPerPage).toBe(50);
    expect(input.requirePublicEmail).toBe(true);
    expect(controlsForActorInput(input).maxItems).toBe(100);
    expect(apifyActorBody(input).requirePublicEmail).toBeUndefined();
  });

  it('suggests book hashtags without forcing them into every niche', () => {
    expect(suggestBusinessHashtags('books')).toEqual([
      '#booktok',
      '#bookstagram',
      '#bookrecommendations',
      '#readingcommunity',
      '#authortok',
    ]);
    expect(suggestBusinessHashtags('booktok')).not.toContain('#booktok');
    expect(suggestBusinessHashtags('fitness')).toEqual([]);
  });

  it('looks up at most 25 profiles and does not send the internal flag', () => {
    const handles = Array.from({ length: 40 }, (_, index) => `reader${index}`);
    const input = buildProfileEnrichInput('tiktok', handles);
    expect(Array.isArray(input?.profiles) && input.profiles).toHaveLength(25);
    expect(input?.resultsPerPage).toBe(1);
    expect(input?.scrapeAdditionalAuthorMeta).toBeUndefined();
    expect(apifyActorBody(input ?? {}).profileEnrich).toBeUndefined();
    expect(controlsForActorInput(input ?? {}).maxItems).toBe(25);
    expect(controlsForActorInput(input ?? {}).maxTotalChargeUsd).toBe(0.5);
  });

  it('tries one unused hashtag, then stops', () => {
    const input = buildTopUpActorInput(
      campaign({
        niches: [],
        hashtags: ['#booktok', '#studytok', '#deepstash'],
        result_limit: 40,
      }),
      'tiktok',
    );
    expect(input?.kind).toBe('hashtag');
    expect(input?.input.hashtags).toEqual(['deepstash']);
    expect(input?.input.searchQueries).toEqual([]);
    expect(input?.input.resultsPerPage).toBe(15);
    expect(input?.input.scrapeAdditionalAuthorMeta).toBe(false);
  });
});

/** $2.50 / 1,000 results and $0.30 per compute unit-hour. Profiles double the result charge. */
function estimateUsd(input: {
  items: number;
  profiles: boolean;
  memoryMb: number;
  seconds: number;
}): number {
  const results = input.items * 0.0025 * (input.profiles ? 2 : 1);
  const compute = (input.memoryMb / 1024) * (input.seconds / 3600) * 0.3;
  return results + compute;
}
