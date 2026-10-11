/**
 * Parsers for Apify actor dataset items → CreatorCandidate.
 *
 * Assumed field shapes (tolerate missing):
 *
 * clockworks/tiktok-scraper (often one row per video):
 *   authorMeta.name | authorMeta.nickName, authorMeta.fans, authorMeta.signature,
 *   authorMeta.avatar | authorMeta.avatarLarger, authorMeta.profileUrl,
 *   text | desc, webVideoUrl | videoUrl, playCount | play_count,
 *   diggCount, commentCount, shareCount,
 *   videoMeta.coverUrl | covers.default | cover
 *
 * Flat / normalised shapes also accepted: handle, username, bio, followers, email, …
 *
 * apify/instagram-scraper (profile-centric):
 *   username, biography | bio, followersCount | followers,
 *   url | profileUrl, profilePicUrl | profilePicUrlHD,
 *   latestPosts[] | latestPosts / posts with
 *     url, displayUrl | display_url, caption | text,
 *     videoViewCount | videoPlayCount | playCount, likesCount
 *
 * Email: use item.email when present, else extractEmailFromBio(bio).
 */
import { visibleEngagement } from './engagement.js';
import type { Platform } from '../types.js';
import { extractEmailFromBio } from './email.js';
import type { CreatorCandidate, TopVideo } from './types.js';

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function bioLinkText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const record = asRecord(value);
  if (!record) return '';
  return asString(record.link, record.url, record.href);
}

function asString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function asNumber(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function isoStamp(...vals: unknown[]): string | null {
  const value = asString(...vals);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  if (Number.isNaN(Date.parse(value))) return null;
  return value;
}

function asNullableNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null || v === '') continue;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function defaultProfileUrl(platform: Platform, handle: string): string {
  return platform === 'tiktok'
    ? `https://www.tiktok.com/@${handle}`
    : `https://www.instagram.com/${handle}/`;
}

function engagementFromCounts(
  followers: number,
  likes: number,
  comments: number,
  shares = 0,
): number | null {
  if (followers <= 0) return null;
  const rate = ((likes + comments + shares) / followers) * 100;
  if (!Number.isFinite(rate)) return null;
  return Math.round(rate * 100) / 100;
}

export function parseTopVideo(raw: unknown): TopVideo | null {
  const row = asRecord(raw);
  if (!row) return null;

  const videoMeta = asRecord(row.videoMeta) ?? asRecord(row.video_meta) ?? {};
  const covers = asRecord(row.covers) ?? {};

  const video_url = asString(
    row.video_url,
    row.webVideoUrl,
    row.videoUrl,
    row.url,
    row.link,
  );
  const thumbnail_url = asString(
    row.thumbnail_url,
    row.thumbnailUrl,
    row.displayUrl,
    row.display_url,
    videoMeta.coverUrl,
    videoMeta.cover,
    covers.default,
    covers.origin,
    row.cover,
    row.coverUrl,
  );
  const play_count = asNumber(
    row.play_count,
    row.playCount,
    row.videoViewCount,
    row.videoPlayCount,
    row.views,
    row.viewCount,
  );
  const view_count = asNumber(
    row.view_count,
    row.viewCount,
    row.videoViewCount,
    play_count,
  );
  const caption = asString(row.caption, row.text, row.desc, row.title);

  if (!video_url && !thumbnail_url) return null;

  return {
    video_url: video_url || thumbnail_url,
    thumbnail_url: thumbnail_url || null,
    view_count: view_count || null,
    play_count: play_count || view_count || null,
    caption: caption || null,
    scraped_at: isoStamp(row.scraped_at, row.scrapedAt) ?? new Date().toISOString(),
  };
}

function topVideosFromList(list: unknown, limit = 3): TopVideo[] {
  if (!Array.isArray(list)) return [];
  const parsed = list
    .map(parseTopVideo)
    .filter((v): v is TopVideo => v !== null);
  parsed.sort(
    (a, b) => (b.play_count ?? b.view_count ?? 0) - (a.play_count ?? a.view_count ?? 0),
  );
  return parsed.slice(0, limit);
}

/**
 * Parse a single flat / profile-shaped Apify item into a candidate.
 * Returns null when handle cannot be resolved.
 */
export function parseApifyItem(
  item: unknown,
  forcedPlatform?: Platform,
): CreatorCandidate | null {
  const row = asRecord(item);
  if (!row) return null;

  const authorMeta =
    asRecord(row.authorMeta) ??
    asRecord(row.author_meta) ??
    asRecord(row.author) ??
    {};

  const handle = asString(
    row.handle,
    row.username,
    row.userName,
    row.uniqueId,
    authorMeta.name,
    authorMeta.uniqueId,
    authorMeta.nickName,
  ).replace(/^@/, '');

  if (!handle) return null;

  const platformHint = asString(
    row.platform,
    forcedPlatform,
    row.inputSource,
  ).toLowerCase();

  let platform: Platform;
  if (platformHint.includes('insta')) platform = 'instagram';
  else if (platformHint.includes('tiktok') || platformHint === 'tt') platform = 'tiktok';
  else if (forcedPlatform) platform = forcedPlatform;
  else if (asString(row.url, row.profileUrl, row.profile_url).includes('instagram'))
    platform = 'instagram';
  else if (
    asString(row.webVideoUrl, row.profile_url, row.url).includes('tiktok') ||
    Object.keys(authorMeta).length > 0
  )
    platform = 'tiktok';
  else platform = forcedPlatform ?? 'tiktok';

  const bio = asString(
    row.bio,
    row.biography,
    row.signature,
    authorMeta.signature,
    authorMeta.bio,
  );
  const nickname = asString(
    authorMeta.nickName,
    authorMeta.nickname,
    row.nickname,
    row.nickName,
  );
  const display_name =
    nickname && nickname.replace(/^@/, '').toLowerCase() !== handle.toLowerCase() ? nickname : null;
  const caption = asString(row.text, row.desc, row.caption);
  const bioLink = bioLinkText(authorMeta.bioLink ?? row.bioLink);

  const emailFromField = asString(row.email, row.businessEmail, authorMeta.email);
  const email =
    (emailFromField ? emailFromField.toLowerCase() : null) ??
    extractEmailFromBio([bio, caption, bioLink].filter(Boolean).join('\n'));

  const follower_count = asNumber(
    row.follower_count,
    row.followers,
    row.followersCount,
    row.followerCount,
    authorMeta.fans,
    authorMeta.followerCount,
    authorMeta.followers,
  );

  let engagement_rate = asNullableNumber(
    row.engagement_rate,
    row.engagementRate,
    authorMeta.engagement_rate,
  );

  if (engagement_rate == null && follower_count > 0) {
    const likes = asNumber(row.diggCount, row.likesCount, row.heart, authorMeta.heart);
    const comments = asNumber(row.commentCount, row.commentsCount);
    const shares = asNumber(row.shareCount);
    engagement_rate = engagementFromCounts(follower_count, likes, comments, shares);
  }
  engagement_rate = visibleEngagement(engagement_rate);

  const profile_url =
    asString(
      row.profile_url,
      row.profileUrl,
      row.url,
      authorMeta.profileUrl,
      authorMeta.url,
    ) || defaultProfileUrl(platform, handle);

  const user = asRecord(row.user) ?? asRecord(row.author) ?? {};
  const hdPic = asRecord(row.hd_profile_pic_url_info) ?? asRecord(row.hdProfilePicUrlInfo);
  const avatar_url =
    asString(
      row.avatar_url,
      row.avatarUrl,
      row.avatarLarger,
      row.avatarMedium,
      hdPic?.url,
      row.profilePicUrlHD,
      row.profilePicUrl,
      row.profile_pic_url_hd,
      row.profile_pic_url,
      row.profilePic,
      user.avatarLarger,
      user.avatarMedium,
      user.avatarThumb,
      user.profilePicUrl,
      authorMeta.avatarLarger,
      authorMeta.originalAvatarUrl,
      authorMeta.avatarMedium,
      authorMeta.avatar,
      authorMeta.avatarThumb,
      authorMeta.profilePicUrl,
      authorMeta.profilePicUrlHD,
    ) || null;

  const niches = Array.isArray(row.niches)
    ? row.niches.map(String)
    : asString(row.niche)
      ? [asString(row.niche)]
      : [];

  // Prefer explicit top_videos / latestPosts; else treat the row itself as one video
  let top_videos = topVideosFromList(
    row.top_videos ?? row.topVideos ?? row.latestPosts ?? row.latestIgtvVideos ?? row.posts,
    3,
  );
  if (top_videos.length === 0) {
    const single = parseTopVideo(row);
    if (single) top_videos = [single];
  }

  return {
    handle,
    platform,
    bio,
    display_name,
    email,
    follower_count,
    engagement_rate,
    profile_url,
    avatar_url,
    top_videos,
    niches,
    raw: row,
  };
}

/**
 * Aggregate TikTok video-centric rows into one candidate per author,
 * keeping the top 3 videos by play/view count.
 */
export function aggregateTikTokCandidates(
  items: unknown[],
  niches: string[] = [],
): CreatorCandidate[] {
  const byHandle = new Map<
    string,
    { candidate: CreatorCandidate; videos: TopVideo[] }
  >();

  for (const item of items) {
    const parsed = parseApifyItem(item, 'tiktok');
    if (!parsed) continue;

    const videos = parsed.top_videos?.length
      ? parsed.top_videos
      : (() => {
          const v = parseTopVideo(item);
          return v ? [v] : [];
        })();

    const existing = byHandle.get(parsed.handle);
    if (!existing) {
      byHandle.set(parsed.handle, {
        candidate: {
          ...parsed,
          niches: parsed.niches.length ? parsed.niches : niches,
          top_videos: [],
        },
        videos: [...videos],
      });
    } else {
      existing.videos.push(...videos);
      if (!existing.candidate.bio && parsed.bio) existing.candidate.bio = parsed.bio;
      if (!existing.candidate.display_name && parsed.display_name) {
        existing.candidate.display_name = parsed.display_name;
      }
      if (!existing.candidate.email && parsed.email)
        existing.candidate.email = parsed.email;
      if (!existing.candidate.avatar_url && parsed.avatar_url)
        existing.candidate.avatar_url = parsed.avatar_url;
      if (
        (existing.candidate.follower_count ?? 0) < (parsed.follower_count ?? 0)
      ) {
        existing.candidate.follower_count = parsed.follower_count;
      }
      if (
        existing.candidate.engagement_rate == null &&
        parsed.engagement_rate != null
      ) {
        existing.candidate.engagement_rate = parsed.engagement_rate;
      }
    }
  }

  const out: CreatorCandidate[] = [];
  for (const { candidate, videos } of byHandle.values()) {
    const sorted = [...videos].sort(
      (a, b) =>
        (b.play_count ?? b.view_count ?? 0) - (a.play_count ?? a.view_count ?? 0),
    );
    candidate.top_videos = sorted.slice(0, 3);
    out.push(candidate);
  }
  return out;
}

/**
 * Map a list of Apify dataset items for a platform into candidates.
 */
export function mapApifyDatasetItems(
  items: unknown[],
  platform: Platform,
  niches: string[] = [],
): CreatorCandidate[] {
  if (platform === 'tiktok') {
    // Prefer aggregation when rows look video-centric
    const lookLikeVideos = items.some((it) => {
      const r = asRecord(it);
      return Boolean(r && (r.webVideoUrl || r.authorMeta || r.playCount != null));
    });
    if (lookLikeVideos) {
      return aggregateTikTokCandidates(items, niches);
    }
  }

  const out: CreatorCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const c = parseApifyItem(item, platform);
    if (!c) continue;
    const key = `${c.platform}:${c.handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!c.niches.length && niches.length) c.niches = niches;
    out.push(c);
  }
  return out;
}

/** Copy a profile-scrape email and a longer bio onto creators we already kept. */
export function mergeProfileEmails(
  candidates: CreatorCandidate[],
  items: unknown[],
  platform: Platform,
): CreatorCandidate[] {
  const updates = new Map<string, { email: string | null; bio: string }>();
  for (const item of items) {
    const parsed = parseApifyItem(item, platform);
    if (!parsed?.handle) continue;
    const key = `${platform}:${parsed.handle.replace(/^@/, '').toLowerCase()}`;
    const prev = updates.get(key);
    const email = parsed.email?.trim() || prev?.email || null;
    const bio =
      (parsed.bio || '').length >= (prev?.bio || '').length ? parsed.bio || '' : prev?.bio || '';
    updates.set(key, { email, bio });
  }
  return candidates.map((candidate) => {
    const extra = updates.get(
      `${candidate.platform}:${candidate.handle.replace(/^@/, '').toLowerCase()}`,
    );
    if (!extra) return candidate;
    const email = candidate.email?.trim() || extra.email || null;
    const bio = (extra.bio || '').length > (candidate.bio || '').length ? extra.bio : candidate.bio;
    return { ...candidate, email, bio };
  });
}
