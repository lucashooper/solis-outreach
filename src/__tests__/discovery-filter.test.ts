import { describe, expect, it } from 'vitest';
import { filterDiscoveryCandidates } from '../discovery/discoveryJobs.js';
import type { CreatorCandidate } from '../discovery/types.js';

function candidate(
  handle: string,
  followers: number,
  platform: 'tiktok' | 'instagram' = 'tiktok',
): CreatorCandidate {
  return {
    handle,
    platform,
    bio: '',
    email: null,
    follower_count: followers,
    engagement_rate: null,
    profile_url: `https://example.com/${handle}`,
    niches: ['fitness'],
  };
}

describe('filterDiscoveryCandidates', () => {
  it('dedupes by platform and handle and applies the follower window', () => {
    const rows = filterDiscoveryCandidates(
      [
        candidate('ada', 1000),
        candidate('Ada', 8000),
        candidate('bea', 200),
        candidate('cio', 50000),
        candidate('dee', 12000, 'instagram'),
      ],
      { followerMin: 5000, followerMax: 20000, limit: 10 },
    );
    expect(rows.map((row) => `${row.platform}:${row.handle}:${row.follower_count}`)).toEqual([
      'instagram:dee:12000',
      'tiktok:Ada:8000',
    ]);
  });

  it('does not invent rows when the source list is empty', () => {
    expect(
      filterDiscoveryCandidates([], { followerMin: null, followerMax: null, limit: 10 }),
    ).toEqual([]);
  });
});