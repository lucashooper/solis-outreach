/** Canonical profile URL and avatar display helpers shared by the admin. */

export function platformLabel(platform: string): string {
  if (platform === 'tiktok') return 'TikTok';
  if (platform === 'instagram') return 'Instagram';
  return platform;
}

export function creatorProfileUrl(creator: {
  platform: string;
  handle: string;
  profile_url?: string | null;
}): string {
  const stored = creator.profile_url?.trim() ?? '';
  if (/^https:\/\/(www\.)?(tiktok\.com|instagram\.com)\//i.test(stored)) return stored;
  const handle = encodeURIComponent(creator.handle.replace(/^@/, '').trim());
  if (creator.platform === 'instagram') return `https://www.instagram.com/${handle}/`;
  return `https://www.tiktok.com/@${handle}`;
}

/**
 * A signed TikTok CDN link with `x-expires` in the past returns 403.
 * Anything else that is https can be requested; the image falls back to initials.
 */
export function usableAvatarUrl(
  url: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!url || !/^https:\/\//i.test(url)) return null;
  try {
    const exp = new URL(url).searchParams.get('x-expires');
    if (exp) {
      const seconds = Number(exp);
      if (Number.isFinite(seconds) && seconds * 1000 <= now) return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function isStoredAvatarUrl(url: string | null | undefined): boolean {
  return /\/storage\/v1\/object\/public\/creator-avatars\//.test(url ?? '');
}
