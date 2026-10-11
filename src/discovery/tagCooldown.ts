import { normaliseHashtag, normaliseHashtags } from './hashtags.js';

/** Skip a hashtag already scraped for this app inside this window. */
export const TAG_COOLDOWN_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TagScrape {
  tag: string;
  scrapedAt: string;
}

export interface SkippedTag {
  tag: string;
  daysAgo: number;
}

/**
 * Drop tags scraped for this app in the last 10 days.
 * Tags in `allow` were typed by the user as custom tags and are always kept.
 */
export function applyTagCooldown(
  tags: readonly string[],
  history: readonly TagScrape[],
  options?: { allow?: readonly string[]; now?: number },
): { tags: string[]; skipped: SkippedTag[] } {
  const now = options?.now ?? Date.now();
  const allow = new Set(normaliseHashtags(options?.allow ?? []));
  const latest = new Map<string, number>();
  for (const row of history) {
    const tag = normaliseHashtag(row.tag);
    const at = Date.parse(row.scrapedAt);
    if (!tag || !Number.isFinite(at)) continue;
    const age = now - at;
    if (age < 0 || age > TAG_COOLDOWN_DAYS * DAY_MS) continue;
    const prev = latest.get(tag);
    if (prev == null || at > prev) latest.set(tag, at);
  }

  const kept: string[] = [];
  const skipped: SkippedTag[] = [];
  for (const tag of normaliseHashtags(tags)) {
    const at = latest.get(tag);
    if (at != null && !allow.has(tag)) {
      skipped.push({ tag, daysAgo: Math.max(0, Math.floor((now - at) / DAY_MS)) });
      continue;
    }
    kept.push(tag);
  }
  return { tags: kept, skipped };
}

/**
 * Hashtags the user put on the campaign are always searched once.
 * Cooldown and suppression apply to auto-suggested tags, and to a repeat of
 * the same tag inside this campaign. Another campaign's scrape does not block them.
 */
export function selectCampaignHashtags(input: {
  explicit: readonly string[];
  planned: readonly string[];
  appHistory: readonly TagScrape[];
  /** Tags this campaign already sent to Apify inside the cooldown window. */
  campaignRecent?: readonly string[];
  now?: number;
}): { tags: string[]; skipped: SkippedTag[] } {
  const explicit = new Set(normaliseHashtags(input.explicit));
  const recent = new Set(normaliseHashtags(input.campaignRecent ?? []));
  const allow = [...explicit].filter((tag) => !recent.has(tag));
  const cooled = applyTagCooldown(input.planned, input.appHistory, {
    allow,
    now: input.now,
  });
  const tags = normaliseHashtags([
    ...allow,
    ...cooled.tags.filter((tag) => !explicit.has(tag)),
  ]);
  const skipped = cooled.skipped.filter((row) => !allow.includes(row.tag));
  return { tags, skipped };
}

export function cooldownWhen(daysAgo: number): string {
  if (daysAgo <= 0) return 'today';
  if (daysAgo === 1) return '1 day ago';
  return `${daysAgo} days ago`;
}

/** "Skipped #booktok, searched 2 days ago." */
export function cooldownMessage(skipped: readonly SkippedTag[]): string {
  if (skipped.length === 0) return '';
  return skipped
    .map((row) => `Skipped ${row.tag}, searched ${cooldownWhen(row.daysAgo)}`)
    .join('. ');
}

export function asSkippedTags(value: unknown): SkippedTag[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: SkippedTag[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const tag = normaliseHashtag(String(record.tag ?? ''));
    const daysAgo = Number(record.daysAgo);
    if (!tag || !Number.isFinite(daysAgo) || daysAgo < 0 || daysAgo > TAG_COOLDOWN_DAYS) continue;
    rows.push({ tag, daysAgo: Math.round(daysAgo) });
  }
  return rows.length > 0 ? rows : undefined;
}
