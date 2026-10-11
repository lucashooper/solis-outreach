/**
 * Extract the first email address from free-text (typically a creator bio).
 * Accepts a plain address and a few common obfuscations. Mentions such as
 * "@booktok" and "meet me @ the park" are ignored.
 */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const SOCIAL_HOSTS = new Set([
  'tiktok.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'linktr.ee',
]);

function cleanEmail(raw: string, fromObfuscation: boolean): string | null {
  const email = raw.replace(/^[<("']+|[>)"',.;:]+$/g, '').toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return null;
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || local.length > 64 || !domain || domain.length > 253) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  const labels = domain.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (!/^[a-z]{2,24}$/.test(tld)) return null;
  if (labels.some((label) => !label || label.length > 63)) return null;
  if (fromObfuscation && SOCIAL_HOSTS.has(domain)) return null;
  return email;
}

/** Turn "name [at] domain [dot] com" and "name @ domain . com" into a plain address. */
export function deobfuscateEmailText(text: string): string {
  const marked = text
    .replace(/[\[({]\s*at\s*[\])}]/gi, '@')
    .replace(/[\[({]\s*dot\s*[\])}]/gi, '.');
  return marked.replace(
    /(^|[\s:;])([a-z0-9][a-z0-9._%+-]{0,63})\s+@\s+([a-z0-9][a-z0-9-]{0,62}(?:\s*\.\s*[a-z0-9][a-z0-9-]{0,62})+)/gi,
    (_match, lead: string, local: string, domain: string) =>
      `${lead}${local}@${domain.replace(/\s*\.\s*/g, '.')}`,
  );
}

/**
 * A public address we can actually mail.
 * Blank strings and placeholders such as "n/a" are not addresses.
 */
export function usablePublicEmail(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) return null;
  return cleanEmail(trimmed, false);
}

export function hasUsablePublicEmail(value: string | null | undefined): boolean {
  return usablePublicEmail(value) != null;
}

export function extractEmailFromBio(bio: string | null | undefined): string | null {
  if (!bio || typeof bio !== 'string') return null;
  const direct = bio.match(EMAIL_RE);
  if (direct?.[0]) {
    const cleaned = cleanEmail(direct[0], false);
    if (cleaned) return cleaned;
  }
  const normalised = deobfuscateEmailText(bio);
  if (normalised === bio) return null;
  const obfuscated = normalised.match(EMAIL_RE);
  if (!obfuscated?.[0]) return null;
  return cleanEmail(obfuscated[0], true);
}

/**
 * Enrichment stub: return bio email if present, otherwise null.
 * Wire a real enrichment API (Hunter, Apollo, etc.) here later.
 */
export function enrichCreatorEmail(input: {
  bio?: string | null;
  handle?: string;
  existingEmail?: string | null;
}): string | null {
  const existing = usablePublicEmail(input.existingEmail);
  if (existing) return existing;
  return extractEmailFromBio(input.bio ?? null);
}
