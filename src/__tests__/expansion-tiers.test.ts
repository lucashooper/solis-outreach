import { describe, expect, it } from 'vitest';
import { asDiscoveryFunnel } from '../discovery/funnel.js';
import {
  buildExpansionTiers,
  expansionResultMessage,
  parseCustomHashtags,
  planNextRound,
  shouldChainRound,
  withoutDeniedTags,
  EXPANSION_ROUNDS_PER_CLICK,
} from '../discovery/expansionTiers.js';
import { shortfallSheet } from '../discovery/shortfall.js';
import type { DiscoveryFunnel } from '../discovery/types.js';

const exampleapp: DiscoveryFunnel = {
  rawItems: 115,
  uniqueCreators: 111,
  afterFollowers: 36,
  afterDedupe: 17,
  withEmail: 17,
  existing: 10,
  saved: 7,
  finished: 17,
  followerMin: 5000,
  followerMax: 50000,
  apifyRunIds: ['d4685ba1'],
  requirePublicEmail: true,
  triedTags: ['#booktok', '#books', '#reading'],
  hashtagYield: [
    { tag: '#booktok', creators: 28, withEmail: 14, stale: 0, flag: 'strong' },
    { tag: '#books', creators: 6, withEmail: 4, stale: 0, flag: 'strong' },
    { tag: '#reading', creators: 5, withEmail: 2, stale: 0, flag: 'thin' },
  ],
  suggestedTags: ['#contentcreator', '#creatorcommunity'],
  suggestedSource: 'ai',
};

describe('expansion tiers', () => {
  it('builds ExampleApp tiers and drops the generic denylist', () => {
    const tiers = buildExpansionTiers({
      appName: 'ExampleApp',
      niche: 'book summaries',
      pitch: 'scans a physical book and gives you the key ideas',
      history: [
        { tag: '#readingcommunity', runs: 2, creators: 12, withEmail: 8 },
        { tag: '#contentcreator', runs: 1, creators: 4, withEmail: 2 },
        { tag: '#deepstash', runs: 3, creators: 0, withEmail: 0 },
      ],
      packTags: ['#bookstagram', '#booktok', '#fyp'],
      modelTags: ['#creatorcommunity', '#booktokbooks'],
    });
    const close = tiers.find((tier) => tier.tier === 1)?.tags ?? [];
    const adjacent = tiers.find((tier) => tier.tier === 2)?.tags ?? [];
    const broad = tiers.find((tier) => tier.tier === 3)?.tags ?? [];
    expect(close.slice(0, 3)).toEqual(['#readingcommunity', '#bookstagram', '#booktok']);
    expect(close).toContain('#bookrecommendations');
    expect(close).toContain('#booktokbooks');
    expect(adjacent.slice(0, 3)).toEqual(['#nonfictionbooks', '#selfimprovementbooks', '#bookreview']);
    expect(broad).toEqual(['#productivity', '#personalgrowth', '#learning', '#studytok']);
    expect(JSON.stringify(tiers)).not.toMatch(/contentcreator|creatorcommunity|fyp/);
  });

  it('tracks tried tags and moves to the next tier after a dry round', () => {
    const tiers = buildExpansionTiers({
      appName: 'ExampleApp',
      niche: 'reading',
      pitch: 'book summaries',
    });
    const tried = ['#booktok', '#books', '#reading'];
    const first = planNextRound({ tiers, tried });
    expect(first.tier).toBe(1);
    expect(first.tags).toEqual(['#bookrecommendations', '#bookstagram']);
    expect(first.tags.every((tag) => !tried.includes(tag))).toBe(true);

    const second = planNextRound({
      tiers,
      tried: [...tried, ...first.tags],
      afterTier: first.tier,
    });
    expect(second.tier).toBe(2);
    expect(second.tags).toEqual(['#nonfictionbooks', '#selfimprovementbooks']);
    expect(second.tags).not.toEqual(first.tags);

    const later = planNextRound({ tiers, tried: [...tried, ...first.tags] });
    expect(later.tier).toBe(1);
    expect(later.tags).toEqual(['#booktokbooks', '#readingcommunity']);
  });

  it('caps a click at three rounds, stops on a find, and stops at the minimum', () => {
    expect(EXPANSION_ROUNDS_PER_CLICK).toBe(3);
    expect(shouldChainRound({ added: 0, roundsUsed: 1, finished: 17, target: 30, exhausted: false })).toBe(true);
    expect(shouldChainRound({ added: 0, roundsUsed: 3, finished: 17, target: 30, exhausted: false })).toBe(false);
    expect(shouldChainRound({ added: 4, roundsUsed: 1, finished: 21, target: 30, exhausted: false })).toBe(false);
    expect(shouldChainRound({ added: 0, roundsUsed: 1, finished: 30, target: 30, exhausted: false })).toBe(false);
    expect(
      shouldChainRound({ added: 2, roundsUsed: 1, finished: 19, target: 30, exhausted: false, custom: true }),
    ).toBe(true);
    expect(
      shouldChainRound({ added: 2, roundsUsed: 1, finished: 19, target: 30, exhausted: true, custom: true }),
    ).toBe(false);
  });

  it('parses custom hashtags and rejects the denylist', () => {
    expect(parseCustomHashtags('BookTok, #bookstagram, booktok')).toEqual({
      tags: ['#booktok', '#bookstagram'],
      error: null,
    });
    expect(parseCustomHashtags('  #CurrentlyReading, book review ')).toEqual({
      tags: ['#currentlyreading', '#bookreview'],
      error: null,
    });
    expect(parseCustomHashtags('#fyp, #contentcreator').error).toMatch(/too broad/);
    expect(parseCustomHashtags('').error).toMatch(/Enter one/);
    expect(parseCustomHashtags('#one, #two, #three, #four, #five, #six').error).toMatch(/at most 5/);
    expect(withoutDeniedTags(['#contentcreator', '#BookTok', '#creatorcommunity'])).toEqual(['#booktok']);
  });

  it('never shows denylisted tags stored on an old ExampleApp funnel', () => {
    const funnel = asDiscoveryFunnel(exampleapp);
    expect(funnel?.suggestedTags ?? []).not.toEqual(
      expect.arrayContaining(['#contentcreator', '#creatorcommunity']),
    );
    const sheet = shortfallSheet({
      funnel: exampleapp,
      minCreators: 30,
      appName: 'ExampleApp',
      niche: 'book summaries',
      pitch: 'key ideas from a physical book',
    });
    expect(sheet?.canExpand).toBe(true);
    expect(sheet?.suggestedTags).toEqual(['#bookrecommendations', '#bookstagram']);
    expect(sheet?.suggestedTags.join(' ')).not.toMatch(/contentcreator|creatorcommunity/);
    expect(sheet?.nextTier).toBe(1);
    expect(
      expansionResultMessage(
        [
          { tags: ['#bookrecommendations', '#bookstagram'], added: 0, tier: 1 },
          { tags: ['#nonfictionbooks', '#selfimprovementbooks'], added: 0, tier: 2 },
        ],
        { exhausted: false },
      ),
    ).toMatch(/2 Apify rounds/);
  });
});
