import { describe, expect, it } from 'vitest';
import { buildExpansionTiers } from '../discovery/expansionTiers.js';
import {
  chooseExpansionTags,
  ineligibleTagSet,
  NO_ELIGIBLE_TAGS_NOTE,
  planEligibleSuggestions,
  suggestionsForFunnel,
} from '../discovery/eligibleTags.js';
import { attachSuggestedTags, shortfallSheet } from '../discovery/shortfall.js';
import type { DiscoveryFunnel } from '../discovery/types.js';
import type { TagStat } from '../discovery/tagMemory.js';

const now = Date.parse('2026-10-09T12:00:00.000Z');

const exampleapp: DiscoveryFunnel = {
  rawItems: 115,
  uniqueCreators: 95,
  afterFollowers: 22,
  afterDedupe: 13,
  withEmail: 10,
  existing: 9,
  saved: 1,
  finished: 10,
  followerMin: 5000,
  followerMax: 50000,
  apifyRunIds: ['run-book'],
  requirePublicEmail: true,
  hashtagYield: [
    { tag: '#booktok', creators: 20, withEmail: 8, stale: 0, flag: 'strong' },
    { tag: '#deepstash', creators: 2, withEmail: 0, stale: 0, flag: 'low' },
  ],
  suggestedTags: ['#authortok', '#readingcommunity'],
  suggestedSource: 'niche',
};

function cooled(tag: string): { tag: string; scrapedAt: string } {
  return { tag, scrapedAt: new Date(now).toISOString() };
}

function suppressed(tag: string): TagStat {
  return {
    tag,
    category: 'books',
    runs: 2,
    videosSampled: 40,
    inRange: 0,
    withEmail: 0,
    newSaved: 0,
    dryRounds: 2,
    lastScrapedAt: new Date(now).toISOString(),
    suppressedUntil: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

const reading = {
  appName: 'ExampleApp',
  niche: 'books',
  pitch: 'book summaries for readers',
  categories: ['books', 'study', 'productivity', 'self-improvement', 'desk'] as const,
  now,
};

describe('eligible tag suggestions', () => {
  it('drops cooldown, suppression, campaign scrapes, and campaign hashtags', () => {
    const blocked = ineligibleTagSet({
      scrapes: [cooled('#authortok')],
      stats: [suppressed('#readingcommunity')],
      campaignScraped: ['#bookstagram'],
      campaignHashtags: ['#bookrecommendations'],
      now,
    });
    expect([...blocked]).toEqual(
      expect.arrayContaining(['#authortok', '#readingcommunity', '#bookstagram', '#bookrecommendations']),
    );

    const next = suggestionsForFunnel({
      ...reading,
      scrapes: [cooled('#authortok'), cooled('#readingcommunity')],
      campaignHashtags: ['#booktok'],
      campaignScraped: ['#booktok'],
      tried: ['#booktok'],
      expansionPlan: [
        { tier: 1, tags: ['#authortok', '#readingcommunity', '#bookrecommendations'] },
      ],
    });
    expect(next.tags).not.toEqual(expect.arrayContaining(['#authortok', '#readingcommunity', '#booktok']));
    expect(next.tags).toEqual(['#bookrecommendations', '#bookstagram']);
    expect(next.networkOnly).toBe(false);
    expect(next.tags.length).toBeLessThanOrEqual(3);
  });

  it('fills the next category when the book lists are used up', () => {
    const bookTags = [
      '#bookrecommendations',
      '#bookstagram',
      '#booktokbooks',
      '#readingcommunity',
      '#authortok',
      '#nonfictionbooks',
      '#selfimprovementbooks',
      '#bookreview',
      '#currentlyreading',
      '#booklover',
      '#productivity',
      '#personalgrowth',
      '#learning',
      '#studytok',
      '#nonfictionreads',
      '#tbrpile',
      '#readinghabits',
      '#bookrecs',
      '#whattoreadnext',
    ];
    const next = planEligibleSuggestions({
      ...reading,
      scrapes: bookTags.map((tag) => cooled(tag)),
      categories: ['books', 'study', 'productivity', 'self-improvement', 'desk'],
    });
    expect(next.tags).toEqual(['#studyblr', '#studywithme']);
    expect(next.tags).not.toContain('#studytok');
    expect(next.rotation).toMatch(/switched to study/i);
    expect(next.tags).not.toEqual(expect.arrayContaining(bookTags));
  });

  it('says when nothing is left and offers the creator network', () => {
    const everything = suggestionsForFunnel({
      ...reading,
      categories: ['books', 'study', 'productivity', 'self-improvement', 'desk'],
      extraBlocked: [
        '#studytok',
        '#studyblr',
        '#studywithme',
        '#studytips',
        '#studymotivation',
        '#productivitytips',
        '#productivityhacks',
        '#notiontemplates',
        '#planwithme',
        '#dailyroutine',
        '#selfimprovement',
        '#selfgrowth',
        '#habits',
        '#discipline',
        '#desksetup',
        '#studyaesthetic',
        '#deskaesthetic',
      ],
      scrapes: [
        cooled('#bookrecommendations'),
        cooled('#bookstagram'),
        cooled('#booktokbooks'),
        cooled('#readingcommunity'),
        cooled('#authortok'),
        cooled('#nonfictionbooks'),
        cooled('#nonfictionreads'),
        cooled('#tbrpile'),
        cooled('#readinghabits'),
        cooled('#bookrecs'),
        cooled('#whattoreadnext'),
        cooled('#selfimprovementbooks'),
        cooled('#bookreview'),
        cooled('#currentlyreading'),
        cooled('#booklover'),
        cooled('#productivity'),
        cooled('#personalgrowth'),
        cooled('#learning'),
        cooled('#studytok'),
      ],
    });
    expect(everything.tags).toEqual([]);
    expect(everything.networkOnly).toBe(true);
    expect(everything.note).toBe(NO_ELIGIBLE_TAGS_NOTE);
  });

  it('substitutes the next eligible tag in the same round when a requested tag is on cooldown', () => {
    const tiers = buildExpansionTiers({
      appName: 'ExampleApp',
      niche: 'books',
      pitch: 'reading',
    });
    const round = chooseExpansionTags({
      requested: ['#authortok', '#readingcommunity'],
      tiers,
      categories: [...reading.categories],
      scrapes: [cooled('#authortok'), cooled('#readingcommunity')],
      now,
    });
    expect(round.skipped.map((row) => row.tag)).toEqual(['#authortok', '#readingcommunity']);
    expect(round.tags.length).toBeGreaterThan(0);
    expect(round.tags).not.toEqual(expect.arrayContaining(['#authortok', '#readingcommunity']));
    expect(round.tags).toEqual(['#bookrecommendations', '#bookstagram']);
    expect(round.networkOnly).toBe(false);
    expect(round.nextSuggestions).not.toEqual(expect.arrayContaining(round.tags));
    expect(round.nextSuggestions.length).toBeGreaterThan(0);
  });

  it('keeps an eligible requested tag and only replaces the one that would be skipped', () => {
    const tiers = buildExpansionTiers({ appName: 'ExampleApp', niche: 'books', pitch: 'reading' });
    const round = chooseExpansionTags({
      requested: ['#bookrecommendations', '#authortok'],
      tiers,
      scrapes: [cooled('#authortok')],
      now,
    });
    expect(round.tags[0]).toBe('#bookrecommendations');
    expect(round.tags).not.toContain('#authortok');
    expect(round.tags).toContain('#bookstagram');
  });

  it('does not store a cooled suggestion on a short run', async () => {
    const attached = await attachSuggestedTags(exampleapp, {
      niche: 'books',
      appName: 'ExampleApp',
      pitch: 'book summaries',
      current: ['#booktok', '#deepstash'],
      minCreators: 30,
      scrapes: [cooled('#authortok'), cooled('#readingcommunity')],
      campaignHashtags: ['#booktok'],
    });
    expect(attached.suggestedTags).not.toEqual(expect.arrayContaining(['#authortok', '#readingcommunity', '#booktok']));
    expect(attached.eligibleSuggestions).toEqual(attached.suggestedTags);
    expect(attached.suggestedTags?.length).toBeGreaterThan(0);
    expect(attached.networkOnly).toBeUndefined();
  });

  it('prefers the read-time list over tags stored on the original run', () => {
    const sheet = shortfallSheet({
      funnel: {
        ...exampleapp,
        eligibleSuggestions: ['#studytok', '#studyblr'],
      },
      minCreators: 30,
      niche: 'books',
      appName: 'ExampleApp',
    });
    expect(sheet?.suggestedTags).toEqual(['#studytok', '#studyblr']);
    expect(sheet?.canExpand).toBe(true);
    expect(sheet?.networkOnly).toBe(false);

    const empty = shortfallSheet({
      funnel: {
        ...exampleapp,
        eligibleSuggestions: [],
        networkOnly: true,
        suggestionNote: NO_ELIGIBLE_TAGS_NOTE,
      },
      minCreators: 30,
    });
    expect(empty?.suggestedTags).toEqual([]);
    expect(empty?.networkOnly).toBe(true);
    expect(empty?.suggestionNote).toBe(NO_ELIGIBLE_TAGS_NOTE);
    expect(empty?.canExpand).toBe(false);
  });
});
