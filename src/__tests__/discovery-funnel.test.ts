import { describe, expect, it } from 'vitest';
import {
  apifyChargeCapUsd,
  discoveryCostHint,
  discoveryFunnelMessage,
  discoveryResultNote,
  estimatedDiscoveryUsd,
  savedResultLimit,
  selectCreatorsToSave,
  showFunnelExplanation,
  suggestIncludeExisting,
  suggestTurnOffEmail,
  suggestWidenRange,
  minimumCreatorsShortfall,
  widenedFollowerRange,
} from '../discovery/funnel.js';
import { shouldStoreDiscoveryCache } from '../discovery/queryCache.js';
import type { DiscoveryFunnel } from '../discovery/types.js';

const userRun: DiscoveryFunnel = {
  rawItems: 60,
  uniqueCreators: 54,
  afterFollowers: 3,
  afterDedupe: 3,
  withEmail: 0,
  saved: 0,
  followerMin: 10000,
  followerMax: 76000,
  apifyRunIds: ['zZgcVWwXjxLzwqyqK'],
};

describe('discovery funnel', () => {
  it('explains the 6 Oct search in one sentence', () => {
    expect(discoveryFunnelMessage(userRun)).toBe(
      'Apify returned 60 videos → 54 creators → 3 within 10K–76K followers → 0 with a public email. Widen followers (for example 5K–200K), add more niche tags, keep Require public email on, and raise the limit to 40–80.',
    );
    expect(showFunnelExplanation(userRun)).toBe(true);
    expect(suggestWidenRange(userRun)).toBe(true);
    expect(suggestIncludeExisting(userRun)).toBe(false);
  });

  it('points at the follower window when nobody is in range', () => {
    const funnel: DiscoveryFunnel = {
      ...userRun,
      rawItems: 42,
      uniqueCreators: 18,
      afterFollowers: 0,
      afterDedupe: 0,
      followerMin: 5000,
      followerMax: 50000,
    };
    expect(discoveryFunnelMessage(funnel)).toBe(
      'Apify returned 42 videos → 18 creators → 0 within 5K–50K followers. Widen followers (for example 5K–200K), add more niche tags, keep Require public email on, and raise the limit to 40–80.',
    );
  });

  it('points at dedupe when every match is already saved', () => {
    const funnel: DiscoveryFunnel = {
      ...userRun,
      afterFollowers: 4,
      afterDedupe: 0,
      uniqueCreators: 4,
    };
    expect(suggestIncludeExisting(funnel)).toBe(true);
    expect(discoveryFunnelMessage(funnel)).toBe(
      'Apify returned 60 videos → 4 creators → 4 within 10K–76K followers → 0 new. 4 already in the CRM.',
    );
    expect(
      discoveryResultNote({ ...funnel, existing: 7, afterFollowers: 17, saved: 10, afterDedupe: 10 }),
    ).toBe('17 matched the filters. 10 new. 7 already in the CRM.');
  });

  it('widens 10K–76K to 5K–152K', () => {
    expect(widenedFollowerRange(10000, 76000)).toEqual({ min: 5000, max: 152000 });
  });

  it('drops creators without a usable public email when one is required', () => {
    const rows = [
      { handle: 'bea', email: null },
      { handle: 'ada', email: 'ada@example.com' },
      { handle: 'cy', email: '  ' },
      { handle: 'dee', email: 'n/a' },
    ];
    expect(selectCreatorsToSave(rows, true, 5).map((row) => row.handle)).toEqual(['ada']);
    expect(selectCreatorsToSave(rows, true, 1).map((row) => row.handle)).toEqual(['ada']);
    expect(selectCreatorsToSave(rows, false, 5).map((row) => row.handle)).toEqual([
      'ada',
      'bea',
      'cy',
      'dee',
    ]);
    expect(
      discoveryResultNote({
        ...userRun,
        requirePublicEmail: true,
        afterFollowers: 8,
        withEmail: 3,
        saved: 2,
        existing: 1,
      }),
    ).toBe('3 matched the filters. 2 new. 1 already in the CRM.');
    expect(suggestTurnOffEmail(userRun)).toBe(true);
    expect(suggestTurnOffEmail({ ...userRun, saved: 6, withEmail: 0 })).toBe(false);
  });

  it('shows bio and profile stages when a search looked up profiles', () => {
    const funnel: DiscoveryFunnel = {
      ...userRun,
      rawItems: 90,
      uniqueCreators: 40,
      afterFollowers: 8,
      afterDedupe: 8,
      afterBioExtract: 1,
      afterProfileEnrich: 4,
      withEmail: 4,
      saved: 8,
      followerMin: 5000,
      followerMax: 200000,
      requirePublicEmail: true,
    };
    expect(discoveryFunnelMessage(funnel)).toBe(
      'Apify returned 90 videos → 40 creators → 8 within 5K–200K followers → 1 from bios → 4 after profile lookup → 4 with a public email → 8 saved.',
    );
    expect(showFunnelExplanation(funnel)).toBe(true);
  });

  it('never caches an empty result', () => {
    expect(shouldStoreDiscoveryCache([])).toBe(false);
    expect(shouldStoreDiscoveryCache([{ handle: 'ada' }])).toBe(true);
  });

  it('says when a search stopped short of the minimum', () => {
    expect(
      minimumCreatorsShortfall({ minimum: 10, finished: 4, extraPass: true }),
    ).toBe('Stopped after one extra pass. 4 creators, short of 10.');
    expect(minimumCreatorsShortfall({ minimum: 10, finished: 1, extraPass: false })).toBe(
      '1 creator, short of 10.',
    );
    expect(minimumCreatorsShortfall({ minimum: 4, finished: 4, extraPass: true })).toBeNull();
    expect(minimumCreatorsShortfall({ minimum: null, finished: 1 })).toBeNull();
  });

  it('prices a following-list run from the free-tier followers actor', () => {
    expect(savedResultLimit(150)).toBe(100);
    // Both and network price one $2 batch. Depth comes before a wider seed list.
    expect(estimatedDiscoveryUsd(5)).toBeCloseTo(1.996, 3);
    expect(estimatedDiscoveryUsd(10)).toBeCloseTo(1.996, 3);
    expect(estimatedDiscoveryUsd(50)).toBeCloseTo(1.996, 3);
    expect(discoveryCostHint(5)).toBe('~$2.00 · limit 5');
    expect(discoveryCostHint(10)).toBe('~$2.00 · limit 10');
    expect(discoveryCostHint(50)).toBe('~$2.00 · limit 50');
    expect(estimatedDiscoveryUsd(5, false, 'hashtags')).toBeCloseTo(0.0565, 5);
    expect(discoveryCostHint(10, false, 'hashtags')).toBe('~$0.11 · limit 10');
    expect(discoveryCostHint(50, false, 'hashtags')).toBe('~$0.56 · limit 50');
    expect(apifyChargeCapUsd(5)).toBe(0.5);
    expect(apifyChargeCapUsd(100)).toBeLessThanOrEqual(1);
  });
});
