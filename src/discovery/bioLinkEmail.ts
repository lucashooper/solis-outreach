import { deobfuscateEmailText, extractEmailFromBio, hasUsablePublicEmail, usablePublicEmail } from './email.js';

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BYTES = 512_000;
const MAX_CONCURRENCY = 5;
const USER_AGENT =
  'Mozilla/5.0 (compatible; MarketingBot/1.0; +https://cursor.com) AppleWebKit/537.36 (KHTML, like Gecko)';

const JUNK_LOCAL = /^(no[-_]?reply|do[-_]?not[-_]?reply|donotreply|support|help|privacy|abuse|security|sentry|wix|notifications?|mailer-daemon|postmaster|webmaster|jobs|careers|billing)$/i;

const JUNK_HOST = new Set([
  'example.com',
  'example.org',
  'example.net',
  'test.com',
  'email.com',
  'domain.com',
  'sentry.io',
  'wixpress.com',
  'linktr.ee',
  'beacons.ai',
  'stan.store',
  'komi.io',
  'carrd.co',
  'link.bio',
  'bio.link',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'google.com',
  'schema.org',
]);

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;

export interface BioLinkEmail {
  email: string;
  url: string;
}

export function bioLinkDomain(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

/** True for placeholders, platform inboxes, and filenames that look like addresses. */
export function isJunkEmail(email: string | null | undefined): boolean {
  const cleaned = usablePublicEmail(email);
  if (!cleaned) return true;
  const at = cleaned.lastIndexOf('@');
  const local = cleaned.slice(0, at);
  const host = cleaned.slice(at + 1);
  if (JUNK_LOCAL.test(local)) return true;
  if (JUNK_HOST.has(host)) return true;
  if (host.endsWith('.png') || host.endsWith('.jpg') || host.endsWith('.jpeg') || host.endsWith('.gif')) {
    return true;
  }
  if (IMAGE_EXT.test(local) || IMAGE_EXT.test(cleaned)) return true;
  if (local.includes('sentry') || host.includes('sentry')) return true;
  if (/wixpress|linktree|beacons\.ai|stan\.store/.test(host)) return true;
  return false;
}

function uniqueEmails(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (let i = 0; i < 6 && rest; i += 1) {
    const email = extractEmailFromBio(rest);
    if (!email) break;
    if (!found.includes(email)) found.push(email);
    const at = rest.toLowerCase().indexOf(email);
    rest = at >= 0 ? rest.slice(at + email.length) : '';
  }
  return found;
}

/** mailto: links first, then addresses and common obfuscations in the page text. */
export function extractEmailsFromPage(html: string | null | undefined): string[] {
  if (!html || typeof html !== 'string') return [];
  const mailtos = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((match) =>
    decodeURIComponent(match[1] ?? ''),
  );
  const fromText = uniqueEmails(deobfuscateEmailText(html.replace(/<[^>]+>/g, ' ')));
  const out: string[] = [];
  for (const raw of [...mailtos, ...fromText]) {
    const email = usablePublicEmail(raw);
    if (!email || isJunkEmail(email) || out.includes(email)) continue;
    out.push(email);
  }
  return out;
}

function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127\.|10\.|192\.168\.|0\.0\.0\.0|169\.254\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  if (host === '::1' || host.includes(':')) return false;
  return true;
}

async function readLimited(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.slice(0, cap);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const step = await reader.read();
    if (step.done) break;
    const piece = step.value;
    const room = cap - total;
    chunks.push(piece.byteLength > room ? piece.slice(0, room) : piece);
    total += Math.min(piece.byteLength, room);
    if (piece.byteLength > room) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

async function fetchOne(
  url: string,
  fetchImpl: typeof fetch,
): Promise<BioLinkEmail | null> {
  if (!isPublicHttpUrl(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|text|xml|json/i.test(type)) return null;
    const html = await readLimited(res, MAX_BYTES);
    const email = extractEmailsFromPage(html).find((row) => hasUsablePublicEmail(row) && !isJunkEmail(row));
    return email ? { email, url } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch bio-link pages for creators who have no email yet.
 * No Apify spend. Failures are skipped; the creator stays without an email.
 */
export async function fetchBioLinkEmails(
  urls: readonly string[],
  options?: { fetchImpl?: typeof fetch; concurrency?: number },
): Promise<Map<string, BioLinkEmail>> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, options?.concurrency ?? MAX_CONCURRENCY));
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const url = raw.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  const found = new Map<string, BioLinkEmail>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (cursor < unique.length) {
      const index = cursor;
      cursor += 1;
      const url = unique[index];
      if (!url) continue;
      const hit = await fetchOne(url, fetchImpl);
      if (hit) found.set(url, hit);
    }
  });
  await Promise.all(workers);
  return found;
}
