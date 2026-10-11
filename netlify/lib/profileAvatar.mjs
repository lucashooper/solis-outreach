/** Pull a fresh TikTok avatar from the public profile page. No Apify. */

export function signedUrlExpired(url, now = Date.now()) {
  try {
    const exp = new URL(String(url || '')).searchParams.get('x-expires');
    if (!exp) return false;
    const seconds = Number(exp);
    return Number.isFinite(seconds) && seconds * 1000 <= now;
  } catch {
    return true;
  }
}

export function tiktokProfileUrl(handle) {
  const clean = String(handle || '').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9._]{2,32}$/.test(clean)) return null;
  return `https://www.tiktok.com/@${clean}`;
}

export function extractTikTokAvatar(html) {
  const match = String(html || '').match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const user = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user;
  const url = user?.avatarLarger || user?.avatarMedium || user?.avatarThumb || '';
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}
