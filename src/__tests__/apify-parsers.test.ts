import { describe, expect, it } from 'vitest';
import {
  aggregateTikTokCandidates,
  mapApifyDatasetItems,
  parseApifyItem,
  parseTopVideo,
} from '../discovery/apifyParsers.js';

const tiktokVideoSample = {
  text: 'Morning HIIT · collabs: amy@fitwithamy.demo #fitness',
  webVideoUrl: 'https://www.tiktok.com/@fitwithamy/video/111',
  playCount: 120000,
  diggCount: 8000,
  commentCount: 200,
  authorMeta: {
    name: 'fitwithamy',
    fans: 85000,
    signature: 'HIIT coach · collabs: amy@fitwithamy.demo',
    avatar: 'https://cdn.example/avatar-amy.jpg',
  },
  videoMeta: { coverUrl: 'https://cdn.example/cover-111.jpg' },
};

const tiktokVideoSample2 = {
  text: 'Zone 2 tips',
  webVideoUrl: 'https://www.tiktok.com/@fitwithamy/video/222',
  playCount: 50000,
  authorMeta: {
    name: 'fitwithamy',
    fans: 85000,
    signature: 'HIIT coach · collabs: amy@fitwithamy.demo',
    avatar: 'https://cdn.example/avatar-amy.jpg',
  },
  videoMeta: { coverUrl: 'https://cdn.example/cover-222.jpg' },
};

const tiktokVideoSample3 = {
  text: 'Meal prep Sunday',
  webVideoUrl: 'https://www.tiktok.com/@fitwithamy/video/333',
  playCount: 90000,
  authorMeta: {
    name: 'fitwithamy',
    fans: 85000,
    signature: 'HIIT coach',
  },
  videoMeta: { coverUrl: 'https://cdn.example/cover-333.jpg' },
};

const igProfileSample = {
  username: 'glowbyjess',
  biography: 'Skincare reviews · jess@glowbyjess.demo',
  followersCount: 95000,
  url: 'https://www.instagram.com/glowbyjess/',
  profilePicUrl: 'https://cdn.example/jess.jpg',
  latestPosts: [
    {
      url: 'https://www.instagram.com/p/AAA/',
      displayUrl: 'https://cdn.example/post1.jpg',
      caption: 'SPF routine',
      videoViewCount: 40000,
      likesCount: 2100,
    },
    {
      url: 'https://www.instagram.com/p/BBB/',
      displayUrl: 'https://cdn.example/post2.jpg',
      caption: 'Retinol night',
      videoViewCount: 22000,
    },
    {
      url: 'https://www.instagram.com/p/CCC/',
      displayUrl: 'https://cdn.example/post3.jpg',
      caption: 'Clean beauty haul',
      videoViewCount: 15000,
    },
  ],
};

describe('parseApifyItem — TikTok shapes', () => {
  it('maps authorMeta + extracts email from bio/signature', () => {
    const c = parseApifyItem(tiktokVideoSample, 'tiktok');
    expect(c).not.toBeNull();
    expect(c!.handle).toBe('fitwithamy');
    expect(c!.platform).toBe('tiktok');
    expect(c!.email).toBe('amy@fitwithamy.demo');
    expect(c!.follower_count).toBe(85000);
    expect(c!.avatar_url).toBe('https://cdn.example/avatar-amy.jpg');
    expect(c!.top_videos?.length).toBeGreaterThanOrEqual(1);
    expect(c!.top_videos![0]!.video_url).toContain('/video/111');
    expect(c!.top_videos![0]!.play_count).toBe(120000);
    expect(c!.top_videos![0]!.thumbnail_url).toContain('cover-111');
    expect(c!.top_videos![0]!.scraped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps a scraped_at already on the video and stamps one when it is missing', () => {
    const kept = parseApifyItem(
      {
        ...tiktokVideoSample,
        scraped_at: '2026-01-02T03:04:05.000Z',
      },
      'tiktok',
    );
    expect(kept?.top_videos?.[0]?.scraped_at).toBe('2026-01-02T03:04:05.000Z');
    const stamped = parseTopVideo({
      text: 'Hello there friends',
      webVideoUrl: 'https://www.tiktok.com/@fitwithamy/video/444',
    });
    expect(stamped?.scraped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('aggregateTikTokCandidates', () => {
  it('groups videos by author and keeps top 3 by play_count', () => {
    const candidates = aggregateTikTokCandidates(
      [tiktokVideoSample, tiktokVideoSample2, tiktokVideoSample3],
      ['fitness'],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.handle).toBe('fitwithamy');
    expect(candidates[0]!.email).toBe('amy@fitwithamy.demo');
    expect(candidates[0]!.top_videos).toHaveLength(3);
    expect(candidates[0]!.top_videos![0]!.play_count).toBe(120000);
    expect(candidates[0]!.top_videos![1]!.play_count).toBe(90000);
    expect(candidates[0]!.top_videos![2]!.play_count).toBe(50000);
    expect(candidates[0]!.niches).toContain('fitness');
  });
});

describe('parseApifyItem — Instagram shapes', () => {
  it('maps profile + latestPosts into top_videos and email from bio', () => {
    const c = parseApifyItem(igProfileSample, 'instagram');
    expect(c).not.toBeNull();
    expect(c!.handle).toBe('glowbyjess');
    expect(c!.platform).toBe('instagram');
    expect(c!.email).toBe('jess@glowbyjess.demo');
    expect(c!.follower_count).toBe(95000);
    expect(c!.avatar_url).toContain('jess.jpg');
    expect(c!.top_videos).toHaveLength(3);
    expect(c!.top_videos![0]!.play_count ?? c!.top_videos![0]!.view_count).toBe(40000);
    expect(c!.top_videos![0]!.caption).toContain('SPF');
  });

  it('prefers a larger TikTok avatar and an Instagram HD picture object', () => {
    const tiktok = parseApifyItem(
      {
        authorMeta: {
          name: 'claykate',
          avatarThumb: 'https://cdn.example/thumb.jpg',
          avatarLarger: 'https://cdn.example/large.jpg',
        },
      },
      'tiktok',
    );
    expect(tiktok?.avatar_url).toBe('https://cdn.example/large.jpg');
    const instagram = parseApifyItem(
      {
        username: 'kate',
        hd_profile_pic_url_info: { url: 'https://cdn.example/hd.jpg' },
        profile_pic_url: 'https://cdn.example/small.jpg',
      },
      'instagram',
    );
    expect(instagram?.avatar_url).toBe('https://cdn.example/hd.jpg');
  });
});

describe('mapApifyDatasetItems', () => {
  it('maps IG list without aggregation when not video-centric', () => {
    const list = mapApifyDatasetItems([igProfileSample], 'instagram', ['beauty']);
    expect(list).toHaveLength(1);
    expect(list[0]!.niches).toContain('beauty');
  });
});
