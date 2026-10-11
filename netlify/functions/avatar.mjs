/**
 * Copy a creator avatar into Supabase storage.
 * Fresh TikTok CDN links still download. Expired or missing TikTok pictures
 * are read once from the public profile page. Instagram rows with no stored
 * picture stay empty. Only creator ids, or URLs on known social CDNs, are accepted.
 */
import { json, handleOptions, serviceClient } from '../lib/blastShared.mjs';
import { extractTikTokAvatar, signedUrlExpired, tiktokProfileUrl } from '../lib/profileAvatar.mjs';

const ALLOWED_HOSTS = [
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'muscdn.com',
  'byteoversea.com',
  'ibyteimg.com',
  'cdninstagram.com',
  'fbcdn.net',
  'instagram.com',
  'supabase.co',
];

function allowedUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isStored(url) {
  return /\/storage\/v1\/object\/public\/creator-avatars\//.test(String(url || ''));
}

const BROWSER_HEADERS = {
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  Referer: 'https://www.tiktok.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
};

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Avatar host returned ${res.status}`);
  }
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type && !type.startsWith('image/')) {
    throw new Error('Avatar host did not return an image');
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 32 || bytes.length > 4_000_000) {
    throw new Error('Avatar image was empty or too large');
  }
  return { bytes, type: type || 'image/jpeg' };
}

function extensionFor(type) {
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

async function cacheImage(sb, creatorId, image) {
  const path = `${creatorId}.${extensionFor(image.type)}`;
  const { error } = await sb.storage.from('creator-avatars').upload(path, image.bytes, {
    contentType: image.type,
    upsert: true,
  });
  if (error) return null;
  const { data } = sb.storage.from('creator-avatars').getPublicUrl(path);
  const publicUrl = data?.publicUrl || null;
  if (publicUrl) {
    await sb.from('creators').update({ avatar_url: publicUrl }).eq('id', creatorId);
  }
  return publicUrl;
}

async function avatarFromTikTokProfile(creator) {
  const pageUrl = tiktokProfileUrl(creator?.handle);
  if (!pageUrl || creator?.platform !== 'tiktok') return null;
  const res = await fetch(pageUrl, {
    headers: { ...BROWSER_HEADERS, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  return allowedUrl(extractTikTokAvatar(html));
}

async function loadImage(creator) {
  const stored = creator?.avatar_url;
  const fresh =
    stored && !isStored(stored) && !signedUrlExpired(stored) ? allowedUrl(stored) : null;
  if (fresh) {
    try {
      return await fetchImage(fresh);
    } catch {
      // The signature was refused. Try the public profile once.
    }
  }
  const fromProfile = await avatarFromTikTokProfile(creator);
  if (!fromProfile) {
    throw new Error('No avatar stored for this creator');
  }
  return fetchImage(fromProfile);
}

function imageResponse(image) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': image.type,
      'Cache-Control': 'public, max-age=86400',
      // Any admin origin, including https://admin.example.com.
      'Access-Control-Allow-Origin': '*',
    },
    body: image.bytes.toString('base64'),
    isBase64Encoded: true,
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const params = event.queryStringParameters || {};
  const creatorId = String(params.creatorId || '').trim();
  const direct = allowedUrl(params.src);
  const sb = serviceClient();

  let source = direct;
  if (creatorId) {
    if (!sb) return json(500, { error: 'Supabase is not configured on the server' });
    const { data, error } = await sb
      .from('creators')
      .select('id, platform, handle, avatar_url')
      .eq('id', creatorId)
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: 'Creator not found' });
    if (isStored(data.avatar_url)) {
      return {
        statusCode: 302,
        headers: { Location: data.avatar_url, 'Cache-Control': 'public, max-age=86400' },
        body: '',
      };
    }
    try {
      const image = await loadImage(data);
      await cacheImage(sb, creatorId, image).catch(() => null);
      return imageResponse(image);
    } catch (err) {
      return json(404, {
        error: err instanceof Error ? err.message : 'Could not load the avatar',
      });
    }
  }

  if (!source) return json(400, { error: 'creatorId or an allowed src is required' });

  try {
    const image = await fetchImage(source);
    return imageResponse(image);
  } catch (err) {
    return json(404, {
      error: err instanceof Error ? err.message : 'Could not load the avatar',
    });
  }
}
