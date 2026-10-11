import { describe, expect, it } from 'vitest';
import {
  creatorProfileUrl,
  isStoredAvatarUrl,
  platformLabel,
  usableAvatarUrl,
} from '../creators/profile.ts';
import {
  extractTikTokAvatar,
  signedUrlExpired,
  tiktokProfileUrl,
} from '../../netlify/lib/profileAvatar.mjs';

describe('creator profile urls', () => {
  it('keeps a stored TikTok or Instagram profile url', () => {
    expect(
      creatorProfileUrl({
        platform: 'tiktok',
        handle: 'ada',
        profile_url: 'https://www.tiktok.com/@ada',
      }),
    ).toBe('https://www.tiktok.com/@ada');
  });

  it('builds a canonical url from the handle', () => {
    expect(creatorProfileUrl({ platform: 'instagram', handle: '@ada.reads' })).toBe(
      'https://www.instagram.com/ada.reads/',
    );
    expect(creatorProfileUrl({ platform: 'tiktok', handle: 'ada' })).toBe(
      'https://www.tiktok.com/@ada',
    );
  });

  it('labels the two platforms', () => {
    expect(platformLabel('tiktok')).toBe('TikTok');
    expect(platformLabel('instagram')).toBe('Instagram');
  });
});

describe('avatar urls', () => {
  it('drops a signed url whose x-expires is in the past', () => {
    const past = 'https://p16-common-sign.tiktokcdn.com/a.jpeg?x-expires=100';
    expect(usableAvatarUrl(past, 200_000)).toBeNull();
    expect(signedUrlExpired(past, 200_000)).toBe(true);
    expect(usableAvatarUrl(past, 50_000)).toBe(past);
  });

  it('keeps a stored public object', () => {
    const stored =
      'https://example.supabase.co/storage/v1/object/public/creator-avatars/id.jpg';
    expect(isStoredAvatarUrl(stored)).toBe(true);
    expect(usableAvatarUrl(stored)).toBe(stored);
  });

  it('reads the larger TikTok avatar from the profile page', () => {
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"user":{"avatarThumb":"https://p16.tiktokcdn.com/t.jpg","avatarLarger":"https://p16.tiktokcdn.com/a.jpg"}}}}}</script>`;
    expect(extractTikTokAvatar(html)).toBe('https://p16.tiktokcdn.com/a.jpg');
    expect(extractTikTokAvatar('<html></html>')).toBeNull();
    expect(tiktokProfileUrl('@ada.reads')).toBe('https://www.tiktok.com/@ada.reads');
    expect(tiktokProfileUrl('bad handle')).toBeNull();
  });
});
