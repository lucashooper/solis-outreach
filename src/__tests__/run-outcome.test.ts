import { describe, expect, it } from 'vitest';
import {
  aggregateHashtagHistory,
  isWeakHashtag,
  sortHashtagsByYield,
  suggestHashtags,
  weakHashtagTooltip,
  withoutWeakHashtags,
} from '../discovery/hashtagAdvice.js';
import {
  cacheCoversRequest,
  campaignHasSearchTerms,
  classifyFunnelReason,
  discoveryJobNiche,
  discoveryOutcomeCopy,
  formatDiscoveryLog,
  reasonFromError,
  jobIsLive,
  searchHasFinished,
  searchStillRunning,
} from '../discovery/runOutcome.js';
import {
  bioLinkStageLabel,
  hashtagStageLabel,
  networkStageLabel,
  savingStageLabel,
  scoringStageLabel,
} from '../discovery/progress.js';
import type { DiscoveryFunnel } from '../discovery/types.js';
import { isGenericValueProp, resolveOutreachBranding } from '../pipeline/branding.js';

function funnel(partial: Partial<DiscoveryFunnel>): DiscoveryFunnel {
  return {
    rawItems: 0,
    uniqueCreators: 0,
    afterFollowers: 0,
    afterDedupe: 0,
    withEmail: 0,
    saved: 0,
    followerMin: 10000,
    followerMax: 116000,
    apifyRunIds: [],
    ...partial,
  };
}

describe('cacheCoversRequest', () => {
  it('does not reuse a short cache when the campaign still needs creators', () => {
    expect(
      cacheCoversRequest({
        freshSaved: 0,
        minCreators: 30,
        aiFallback: false,
        resultLimit: 60,
      }),
    ).toBe(false);
  });

  it('reuses a cache that already met the minimum', () => {
    expect(
      cacheCoversRequest({
        freshSaved: 30,
        minCreators: 30,
        aiFallback: false,
        resultLimit: 60,
      }),
    ).toBe(true);
  });

  it('does not let AI fallback stop on a short cache', () => {
    expect(
      cacheCoversRequest({
        freshSaved: 4,
        minCreators: null,
        aiFallback: true,
        resultLimit: 10,
      }),
    ).toBe(false);
  });

  it('does not treat a short cache as finished when there is no minimum', () => {
    expect(
      cacheCoversRequest({
        freshSaved: 2,
        existing: 10,
        includeExisting: false,
        minCreators: null,
        aiFallback: false,
        resultLimit: 10,
      }),
    ).toBe(false);
  });

  it('lets CRM creators fill the cache only when Include CRM creators is on', () => {
    expect(
      cacheCoversRequest({
        freshSaved: 2,
        existing: 8,
        includeExisting: true,
        minCreators: null,
        aiFallback: false,
        resultLimit: 10,
      }),
    ).toBe(true);
  });
});

describe('discovery job labels', () => {
  it('does not store the campaign name as the niche', () => {
    expect(
      discoveryJobNiche({
        niches: [],
        hashtags: ['#booktok', '#deepstash', '#books'],
      }),
    ).toBe('#booktok #deepstash #books');
    expect(discoveryJobNiche({ niches: ['reading'], hashtags: ['#booktok'] })).toBe('reading');
  });

  it('treats hashtags as search terms when niches are empty', () => {
    expect(campaignHasSearchTerms({ niches: [], hashtags: ['#booktok'] })).toBe(true);
    expect(campaignHasSearchTerms({ niches: [], hashtags: [] })).toBe(false);
  });
});

describe('classifyFunnelReason', () => {
  it('names an empty Apify response and a CRM-only cache', () => {
    expect(classifyFunnelReason(funnel({ rawItems: 0, apifyRunIds: [] }))).toBe('zero_raw_items');
    expect(
      classifyFunnelReason(
        funnel({
          cached: true,
          uniqueCreators: 28,
          afterFollowers: 28,
          afterDedupe: 0,
          existing: 15,
          withEmail: 15,
          saved: 0,
        }),
      ),
    ).toBe('all_in_crm');
    expect(
      classifyFunnelReason(
        funnel({
          rawItems: 40,
          uniqueCreators: 12,
          afterFollowers: 0,
        }),
      ),
    ).toBe('all_filtered_by_followers');
    expect(
      classifyFunnelReason(
        funnel({
          rawItems: 40,
          uniqueCreators: 12,
          afterFollowers: 12,
          afterDedupe: 12,
          withEmail: 0,
          saved: 0,
          requirePublicEmail: true,
        }),
      ),
    ).toBe('all_filtered_by_email');
  });

  it('keeps an early-exit reason', () => {
    expect(classifyFunnelReason(funnel({ reason: 'apify_budget_exceeded', rawItems: 10 }))).toBe(
      'apify_budget_exceeded',
    );
  });
});

describe('discoveryOutcomeCopy', () => {
  it('uses a short title and one action', () => {
    expect(discoveryOutcomeCopy('apify_budget_exceeded')?.title).toBe(
      'All connected Apify accounts are out of credit.',
    );
    expect(discoveryOutcomeCopy('zero_raw_items')?.title).toBe(
      '0 videos returned for these hashtags.',
    );
    expect(discoveryOutcomeCopy('all_in_crm', funnel({ existing: 22 }))?.title).toBe(
      'All 22 matches are already in the CRM.',
    );
    expect(discoveryOutcomeCopy('ok')).toBeNull();
  });
});

describe('reasonFromError', () => {
  it('maps token and credit failures', () => {
    expect(reasonFromError('Apify discovery requires APIFY_TOKEN.')).toBe('apify_not_configured');
    expect(reasonFromError('Apify has reached its monthly limit.')).toBe('apify_budget_exceeded');
    expect(reasonFromError('actor exploded')).toBe('actor_failed');
  });
});

describe('searchHasFinished', () => {
  it('clears Running once the campaign leaves searching or a new run is stored', () => {
    expect(
      searchHasFinished({
        jobStatus: 'running',
        campaignStatus: 'searching',
        runCount: 0,
        runsWhenStarted: 0,
      }),
    ).toBe(false);
    expect(
      searchHasFinished({
        jobStatus: 'succeeded',
        campaignStatus: 'searching',
        runCount: 0,
        runsWhenStarted: 0,
      }),
    ).toBe(true);
    expect(
      searchHasFinished({
        jobStatus: 'succeeded',
        campaignStatus: 'searching',
        runCount: 1,
        runsWhenStarted: 0,
      }),
    ).toBe(true);
    expect(
      searchHasFinished({
        jobStatus: 'running',
        campaignStatus: 'ready',
        runCount: 1,
        runsWhenStarted: 0,
      }),
    ).toBe(true);
  });
});

describe('searchStillRunning', () => {
  it('blocks a second click only while the campaign is still searching', () => {
    const now = Date.parse('2026-10-08T11:10:00.000Z');
    expect(searchStillRunning('searching', '2026-10-08T11:09:30.000Z', now)).toBe(true);
    expect(searchStillRunning('ready', '2026-10-08T11:09:30.000Z', now)).toBe(false);
    expect(searchStillRunning('searching', '2026-10-08T10:59:00.000Z', now)).toBe(false);
    expect(searchStillRunning('searching', '2026-10-08T10:00:00.000Z', now)).toBe(false);
  });
});

describe('jobIsLive', () => {
  it('treats a running job with no update for 10 minutes as finished', () => {
    const now = Date.parse('2026-10-08T11:10:00.000Z');
    expect(jobIsLive('running', '2026-10-08T11:09:30.000Z', now)).toBe(true);
    expect(jobIsLive('stopping', '2026-10-08T11:05:00.000Z', now)).toBe(true);
    expect(jobIsLive('running', '2026-10-08T10:59:00.000Z', now)).toBe(false);
    expect(jobIsLive('succeeded', '2026-10-08T11:09:30.000Z', now)).toBe(false);
    expect(jobIsLive('running', null, now)).toBe(false);
  });
});

describe('discovery stage labels', () => {
  it('names the live steps in plain language', () => {
    expect(networkStageLabel({ seeds: 15, checked: 1240, found: 4 })).toBe(
      'Reading following lists of 15 creators · 1,240 profiles checked · 4 found',
    );
    expect(hashtagStageLabel(['bookworm', 'booklover'])).toBe('Scanning #bookworm, #booklover…');
    expect(scoringStageLabel()).toBe('Scoring niche fit with AI…');
    expect(bioLinkStageLabel()).toBe('Checking bio links for emails…');
    expect(savingStageLabel(12)).toBe('Saving 12 new creators');
  });
});

describe('formatDiscoveryLog', () => {
  it('keeps one line and drops secret-like keys', () => {
    const line = formatDiscoveryLog('done', {
      job: '49884bda-13c1-44cc-ab8d-368adbae7dad',
      campaign: '4080b8d6-12bc-4790-b10b-b99c2984abbd',
      raw: 0,
      token: 'secret-token',
      email: 'person@example.com',
    });
    expect(line.startsWith('[discovery] stage=done ')).toBe(true);
    expect(line).toContain('job=49884bda-13c1-44cc-ab8d-368adbae7dad');
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('person@example.com');
    expect(line.includes('\n')).toBe(false);
  });
});

describe('hashtag advice', () => {
  const history = aggregateHashtagHistory([
    [
      { tag: '#booktok', creators: 10, withEmail: 6 },
      { tag: '#deepstash', creators: 0, withEmail: 0 },
    ],
    [
      { tag: '#booktok', creators: 12, withEmail: 7 },
      { tag: '#deepstash', creators: 0, withEmail: 0 },
    ],
    [{ tag: '#deepstash', creators: 0, withEmail: 0 }],
  ]);

  it('marks a tag that returned nobody across several runs', () => {
    const deepstash = history.find((row) => row.tag === '#deepstash');
    const booktok = history.find((row) => row.tag === '#booktok');
    expect(deepstash).toMatchObject({ runs: 3, creators: 0, withEmail: 0 });
    expect(booktok).toMatchObject({ runs: 2, creators: 22, withEmail: 13 });
    expect(isWeakHashtag(deepstash)).toBe(true);
    expect(isWeakHashtag(booktok)).toBe(false);
    expect(weakHashtagTooltip(deepstash!)).toBe('0 creators across 3 runs');
  });

  it('suggests strong tags, drops weak ones, and sorts by yield', () => {
    expect(suggestHashtags({ history, current: ['#deepstash'], niches: ['books'] })).toContain(
      '#booktok',
    );
    expect(suggestHashtags({ history, current: ['#deepstash'], niches: [] })).not.toContain(
      '#deepstash',
    );
    expect(withoutWeakHashtags(['#booktok', '#deepstash'], history)).toEqual(['#booktok']);
    expect(sortHashtagsByYield(['#deepstash', '#books', '#booktok'], history).slice(0, 2)).toEqual([
      '#booktok',
      '#deepstash',
    ]);
  });
});

describe('resolveOutreachBranding', () => {
  it('uses the linked app name instead of a stale Solis snapshot', () => {
    expect(isGenericValueProp('helps creators and brands work together through Solis Labs')).toBe(
      true,
    );
    expect(
      resolveOutreachBranding({
        appName: 'ExampleApp',
        appValueProp: 'scans a physical book and gives you the key ideas in seconds',
        campaignAppName: 'Solis',
        campaignValueProp: 'helps creators and brands work together through Solis Labs',
      }),
    ).toEqual({
      appName: 'ExampleApp',
      valueProp: 'scans a physical book and gives you the key ideas in seconds',
    });
  });

  it('keeps a campaign value prop the user wrote when the app has none', () => {
    expect(
      resolveOutreachBranding({
        appName: 'ExampleApp',
        campaignAppName: 'Solis',
        campaignValueProp: 'a reading app for busy people',
      }).valueProp,
    ).toBe('a reading app for busy people');
  });
});
