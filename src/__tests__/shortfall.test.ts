import { describe, expect, it, vi } from 'vitest';
import { asDiscoveryFunnel } from '../discovery/funnel.js';
import {
  attachSuggestedTags,
  discoveryShortfallTarget,
  expandWithTagsLabel,
  qualifyingFinished,
  shortfallChips,
  shortfallHeadline,
  shortfallSheet,
  takeContinueTags,
} from '../discovery/shortfall.js';
import type { DiscoveryFunnel } from '../discovery/types.js';

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
  extraPass: 'page',
  hashtagYield: [
    { tag: '#booktok', creators: 20, withEmail: 8, stale: 0, flag: 'strong' },
    { tag: '#deepstash', creators: 2, withEmail: 0, stale: 0, flag: 'low' },
  ],
  suggestedTags: ['#authortok', '#readingcommunity'],
  suggestedSource: 'niche',
};

describe('discovery shortfall sheet', () => {
  it('explains the ExampleApp drop-off and the page that already ran', () => {
    const sheet = shortfallSheet({
      funnel: exampleapp,
      minCreators: 30,
      resultLimit: 10,
      niche: 'books',
    });
    expect(sheet).toMatchObject({
      why: '115 videos, 95 unique creators, 22 in the follower band, 10 with a public email, 9 already in the CRM, 1 new. 10 creators, short of 30.',
      passNote: 'Extra pass: one more page.',
      triedTags: ['#booktok', '#deepstash'],
      suggestedTags: ['#authortok', '#readingcommunity'],
      expandLabel: 'Expand search',
      relaxLabel: 'Include creators without a public email',
      canExpand: true,
      canRelaxEmail: true,
      target: 30,
      finished: 10,
      fresh: 1,
      existing: 9,
      expandedTags: [],
    });
    expect(shortfallHeadline(sheet!)).toEqual({
      title: 'Found 10 / 30 creators',
      detail: '1 new · 9 in CRM',
    });
    expect(
      shortfallChips(sheet!.triedTags, sheet!.expandedTags, exampleapp.hashtagYield ?? []),
    ).toEqual([
      { tag: '#booktok', expanded: false, yieldFlag: 'strong' },
      { tag: '#deepstash', expanded: false, yieldFlag: 'low' },
    ]);
  });

  it('hides the sheet once the finished count meets the target', () => {
    expect(
      shortfallSheet({
        funnel: { ...exampleapp, finished: 30, saved: 21 },
        minCreators: 30,
      }),
    ).toBeNull();
    expect(shortfallSheet({ funnel: exampleapp, minCreators: null, resultLimit: null })).toBeNull();
    expect(discoveryShortfallTarget(null, 40)).toBe(40);
    expect(qualifyingFinished({ ...exampleapp, finished: undefined })).toBe(10);
  });

  it('offers the next untried tags after a fallback or a previous expand', () => {
    const fallback = shortfallSheet({
      funnel: {
        ...exampleapp,
        extraPass: 'fallback',
        fallbackTags: ['#authortok', '#readingcommunity'],
        suggestedTags: ['#studygram'],
      },
      minCreators: 30,
    });
    expect(fallback?.canExpand).toBe(true);
    expect(fallback?.suggestedTags).toEqual(['#studygram']);
    expect(fallback?.passNote).toBe('Extra pass: related tags #authortok and #readingcommunity.');
    expect(fallback?.triedTags).toEqual(['#booktok', '#deepstash', '#authortok', '#readingcommunity']);
    expect(fallback?.expandedTags).toEqual(['#authortok', '#readingcommunity']);
    expect(shortfallChips(fallback!.triedTags, fallback!.expandedTags)).toEqual([
      { tag: '#booktok', expanded: false, yieldFlag: null },
      { tag: '#deepstash', expanded: false, yieldFlag: null },
      { tag: '#authortok', expanded: true, yieldFlag: null },
      { tag: '#readingcommunity', expanded: true, yieldFlag: null },
    ]);

    const spent = shortfallSheet({
      funnel: { ...exampleapp, continueUsed: 'expand', extraPass: 'page', fallbackTags: ['#authortok'] },
      minCreators: 30,
      niche: 'books',
      appName: 'ExampleApp',
    });
    expect(spent?.canExpand).toBe(true);
    expect(spent?.suggestedTags).toEqual(['#readingcommunity']);
    expect(spent?.passNote).toBe('Extra pass: one more page. Continued once with #authortok.');
  });

  it('offers relax only when the email rule dropped in-range creators', () => {
    expect(
      shortfallSheet({
        funnel: { ...exampleapp, continueUsed: 'relax' },
        minCreators: 30,
      })?.canRelaxEmail,
    ).toBe(false);
    expect(
      shortfallSheet({
        funnel: { ...exampleapp, requirePublicEmail: false },
        minCreators: 30,
      })?.canRelaxEmail,
    ).toBe(false);
    expect(
      shortfallSheet({
        funnel: { ...exampleapp, afterFollowers: 10, withEmail: 10 },
        minCreators: 30,
      })?.canRelaxEmail,
    ).toBe(false);
  });

  it('uses the result limit when minimum creators is unset', () => {
    const sheet = shortfallSheet({
      funnel: { ...exampleapp, finished: 4, minCreators: undefined } as DiscoveryFunnel,
      resultLimit: 15,
      niche: 'books',
    });
    expect(sheet?.target).toBe(15);
    expect(sheet?.why.endsWith('short of 15.')).toBe(true);
    expect(shortfallHeadline({ finished: 4, target: 15, fresh: 4, existing: 0 })).toEqual({
      title: 'Found 4 / 15 creators',
      detail: '4 new',
    });
  });

  it('names one suggested tag, and never repeats a tag already tried', () => {
    expect(expandWithTagsLabel(['#studytok'])).toBe('Expand with #studytok');
    expect(takeContinueTags(['#booktok', '#authortok', '#readingcommunity', '#extra'], ['#booktok'])).toEqual([
      '#authortok',
      '#readingcommunity',
    ]);
    const sheet = shortfallSheet({
      funnel: { ...exampleapp, suggestedTags: undefined },
      minCreators: 30,
      niche: 'booktok',
      searchedTags: ['#booktok'],
    });
    expect(sheet?.suggestedTags.every((tag) => tag !== '#booktok')).toBe(true);
    expect(sheet?.suggestedTags.length).toBeLessThanOrEqual(2);
    expect(sheet?.canExpand).toBe(true);
  });

  it('says when nothing extra ran, without inventing a CRM count', () => {
    const sheet = shortfallSheet({
      funnel: {
        ...exampleapp,
        extraPass: undefined,
        existing: undefined,
        suggestedTags: ['#authortok'],
      },
      minCreators: 30,
    });
    expect(sheet?.passNote).toBe('No extra pass ran.');
    expect(sheet?.why).not.toContain('already in the CRM');
    expect(sheet?.why).toContain('1 new');
  });

  it('stores suggested tags for a short run and skips them once fallback ran', async () => {
    const suggest = vi.fn(async () => ({ tags: ['#authortok', '#booktok'], source: 'ai' as const }));
    const attached = await attachSuggestedTags(exampleapp, {
      niche: 'books',
      current: ['#booktok', '#deepstash'],
      minCreators: 30,
      suggest,
    });
    expect(attached.suggestedTags).toEqual(['#authortok', '#readingcommunity']);

    const fresh = await attachSuggestedTags(
      { ...exampleapp, suggestedTags: undefined },
      { niche: 'books', current: ['#booktok'], minCreators: 30, suggest },
    );
    expect(suggest).not.toHaveBeenCalled();
    expect(fresh.suggestedTags).toEqual(['#bookrecommendations', '#bookstagram']);
    expect(fresh.suggestedSource).toBe('niche');
    expect(fresh.suggestedTags?.some((tag) => tag.includes('contentcreator'))).toBe(false);

    const odd = await attachSuggestedTags(
      { ...exampleapp, suggestedTags: undefined },
      { niche: 'widgets', current: ['#widgets'], minCreators: 30, suggest },
    );
    expect(odd.suggestedTags).toEqual(['#authortok']);
    expect(odd.suggestedSource).toBe('ai');

    const done = await attachSuggestedTags(
      { ...exampleapp, suggestedTags: undefined, extraPass: 'fallback', fallbackTags: ['#authortok'] },
      { niche: 'books', current: ['#booktok'], minCreators: 30, suggest },
    );
    expect(done.suggestedTags).toEqual(['#bookrecommendations', '#bookstagram']);
    expect(done.expansionPlan?.some((tier) => tier.tier === 1)).toBe(true);
  });

  it('reads continue fields back off a stored funnel', () => {
    const funnel = asDiscoveryFunnel({
      ...exampleapp,
      triedTags: ['#booktok', 'deepstash'],
      continueUsed: 'relax',
      emailRelaxed: true,
      suggestedSource: 'niche',
    });
    expect(funnel?.triedTags).toEqual(['#booktok', '#deepstash']);
    expect(funnel?.suggestedTags).toEqual(['#authortok', '#readingcommunity']);
    expect(funnel?.continueUsed).toBe('relax');
    expect(funnel?.emailRelaxed).toBe(true);
    expect(funnel?.extraPass).toBe('page');
    expect(funnel?.batchAccepted).toBeUndefined();

    const stale = asDiscoveryFunnel({
      ...exampleapp,
      suggestedTags: ['#contentcreator', '#creatorcommunity', '#bookstagram'],
    });
    expect(stale?.suggestedTags).toEqual(['#bookstagram']);
    expect(JSON.stringify(stale)).not.toMatch(/contentcreator|creatorcommunity/);

    const accepted = asDiscoveryFunnel({
      ...exampleapp,
      batchAccepted: true,
      batchLinkedIds: ['not-a-uuid', '11111111-1111-4111-8111-111111111111'],
    });
    expect(accepted?.batchAccepted).toBe(true);
    expect(accepted?.batchLinkedIds).toEqual(['11111111-1111-4111-8111-111111111111']);
  });
});
