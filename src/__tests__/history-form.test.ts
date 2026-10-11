import { describe, expect, it } from 'vitest';
import {
  coerceStoredSearch,
  storedSearchSummary,
  toDiscoverForm,
} from '../discovery/historyForm.js';

describe('coerceStoredSearch', () => {
  it('reads campaign columns, including hashtags and the public-email flag', () => {
    const stored = coerceStoredSearch({
      niches: ['booktok', 'reading'],
      hashtags: ['booktok', '#Books'],
      platforms: ['tiktok', 'instagram'],
      followerMin: 10000,
      followerMax: 500000,
      resultLimit: 20,
      minCreators: 8,
      requirePublicEmail: true,
    });
    expect(stored.niche).toBe('booktok, reading');
    expect(stored.hashtags).toEqual(['#booktok', '#books']);
    expect(toDiscoverForm(stored)).toMatchObject({
      platform: 'both',
      followerMin: '10000',
      followerMax: '500000',
      resultLimit: '20',
      minCreators: '8',
      requirePublicEmail: true,
      includeExisting: false,
    });
  });

  it('falls back to the funnel when the row left follower bounds empty', () => {
    const stored = coerceStoredSearch({
      niche: 'fitness',
      platforms: ['TikTok'],
      followerMin: null,
      followerMax: null,
      requirePublicEmail: null,
      funnel: { followerMin: 5000, followerMax: 50000, requirePublicEmail: false },
    });
    const form = toDiscoverForm(stored);
    expect(form.platform).toBe('tiktok');
    expect(form.followerMin).toBe('5000');
    expect(form.followerMax).toBe('50000');
    expect(form.requirePublicEmail).toBe(false);
    expect(form.resultLimit).toBe('10');
    expect(form.minCreators).toBe('');
  });

  it('summarises the filters without dumping JSON', () => {
    const summary = storedSearchSummary(
      coerceStoredSearch({
        niche: 'booktok',
        hashtags: ['#booktok'],
        platforms: ['tiktok'],
        followerMin: 5000,
        followerMax: 50000,
        resultLimit: 20,
        minCreators: null,
        requirePublicEmail: true,
        includeExisting: true,
      }),
    );
    expect(summary).toBe(
      'booktok · #booktok · TikTok · 5,000–50,000 followers · Limit 20 · Public email required · No minimum creators · Includes creators already in the CRM',
    );
    expect(summary).not.toContain('{');
  });
});
