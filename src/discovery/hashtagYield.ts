import { hasUsablePublicEmail } from './email.js';
import { normaliseHashtag, normaliseHashtags } from './hashtags.js';

export type HashtagYieldFlag = 'low' | 'thin' | 'strong' | 'insufficient';

/** Don't call a tag Thin or Low yield until about this many videos were sampled. */
export const MIN_YIELD_SAMPLE = 20;

/** Yield of one searched tag, from creators this run already collected. */
export interface HashtagYield {
  tag: string;
  creators: number;
  withEmail: number;
  stale: number;
  flag: HashtagYieldFlag;
  /** Videos returned for this tag, when the run recorded them. */
  sampled?: number;
}

interface YieldCreator {
  handle?: string | null;
  platform?: string | null;
  email?: string | null;
  bio?: string | null;
  engagement_rate?: number | null;
  raw?: unknown;
  top_videos?: Array<{ caption?: string | null }> | null;
}

/** Below 1% engagement. Unknown rates are not treated as stale. */
const STALE_ENGAGEMENT = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function addTag(into: Set<string>, raw: string): void {
  const tag = normaliseHashtag(raw);
  if (tag) into.add(tag.slice(1));
}

/** Hashtags written on a creator's videos, captions, or bio. */
export function creatorHashtagSet(creator: YieldCreator): Set<string> {
  const tags = new Set<string>();
  const raw = asRecord(creator.raw);
  const listed = raw?.hashtags ?? raw?.challenges;
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      if (typeof entry === 'string') addTag(tags, entry);
      else {
        const record = asRecord(entry);
        if (record) addTag(tags, String(record.name ?? record.title ?? record.hashtag ?? ''));
      }
    }
  }
  const text = [
    creator.bio,
    raw?.text,
    raw?.desc,
    raw?.caption,
    ...(creator.top_videos ?? []).map((video) => video.caption),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  for (const match of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    addTag(tags, match[1] ?? '');
  }
  return tags;
}

function isStale(creator: YieldCreator): boolean {
  const rate = creator.engagement_rate;
  return rate != null && Number.isFinite(Number(rate)) && Number(rate) < STALE_ENGAGEMENT;
}

/**
 * Flag searched tags from creators already in the follower window.
 * No extra Apify call. A tag searched on its own inherits the whole list
 * when videos do not echo hashtags. Combined searches are attributed by
 * the hashtag written on the video, so a silent tag can be dropped.
 */
/**
 * Videos sampled for each tag.
 * One tag gets the whole run. Several tags share the run evenly when the
 * actor does not label each video.
 */
export function sampleCountsForTags(tags: readonly string[], itemCount: number): Record<string, number> {
  const clean = normaliseHashtags(tags);
  const count = Math.max(0, Math.round(itemCount) || 0);
  if (clean.length === 0) return {};
  if (clean.length === 1) return { [clean[0]]: count };
  const share = Math.floor(count / clean.length);
  return Object.fromEntries(clean.map((tag) => [tag, share]));
}

export function scoreHashtagYield(
  tags: string[],
  creators: YieldCreator[],
  requireEmail: boolean,
  samples?: Record<string, number> | null,
): HashtagYield[] {
  const wanted = new Map<string, string>();
  for (const tag of tags) {
    const normal = normaliseHashtag(tag);
    if (!normal || wanted.has(normal)) continue;
    wanted.set(normal, normal);
  }
  if (wanted.size === 0) return [];

  const anyMetadata = creators.some((creator) => creatorHashtagSet(creator).size > 0);
  const shareCombined = !anyMetadata && wanted.size > 1;

  return [...wanted.values()].map((tag) => {
    const bare = tag.slice(1);
    const matched = creators.filter((creator) => {
      if (shareCombined || (!anyMetadata && wanted.size === 1)) return true;
      return creatorHashtagSet(creator).has(bare);
    });
    const seen = new Set<string>();
    const unique = matched.filter((creator) => {
      const key = `${creator.platform ?? ''}:${String(creator.handle ?? '').replace(/^@/, '').toLowerCase()}`;
      if (!key.endsWith(':') && seen.has(key)) return false;
      if (!key.endsWith(':')) seen.add(key);
      return Boolean(creator.handle?.trim());
    });
    const withEmail = unique.filter((creator) => hasUsablePublicEmail(creator.email)).length;
    const stale = unique.filter((creator) => isStale(creator)).length;
    const qualifying = requireEmail ? withEmail : unique.length;
    const mostlyStale = unique.length > 0 && stale * 2 >= unique.length;
    const sampled = samples?.[tag];
    const undersampled = typeof sampled === 'number' && sampled < MIN_YIELD_SAMPLE;
    const flag: HashtagYieldFlag = undersampled
      ? 'insufficient'
      : qualifying === 0
        ? 'low'
        : qualifying < 3 || mostlyStale
          ? 'thin'
          : 'strong';
    return {
      tag,
      creators: unique.length,
      withEmail,
      stale,
      flag,
      ...(typeof sampled === 'number' ? { sampled } : {}),
    };
  });
}

export function hashtagYieldHint(row: HashtagYield, requireEmail: boolean): string {
  if (row.flag === 'insufficient') {
    const sampled = row.sampled ?? 0;
    const videos = sampled === 1 ? '1 video' : `${sampled} videos`;
    return `${row.tag} had ${videos} sampled. Not enough data to call it thin or low yield.`;
  }
  if (row.flag === 'low') {
    if (requireEmail && row.creators > 0 && row.withEmail === 0) {
      return `${row.tag} brought ${row.creators} in-range creators and no public email. Drop it to save Apify credit.`;
    }
    return `${row.tag} brought no in-range creators. Drop it to save Apify credit.`;
  }
  if (row.stale > 0 && row.creators > 0 && row.stale * 2 >= row.creators) {
    return `${row.tag} is mostly low-engagement accounts (${row.withEmail} with a public email).`;
  }
  return `${row.tag}: ${row.creators} in range, ${row.withEmail} with a public email.`;
}

export type YieldPillTone = 'strong' | 'thin' | 'low' | 'neutral';

export interface YieldPill {
  tag: string;
  tone: YieldPillTone;
  /** Empty when the pill is the tag alone. A measured tag can show "4/100". */
  suffix: string;
  hint: string;
}

function yieldPerHundred(row: HashtagYield, requireEmail: boolean): number | null {
  if (row.sampled == null || row.sampled < 20) return null;
  const qualifying = requireEmail ? row.withEmail : row.creators;
  return Math.round((qualifying / row.sampled) * 100);
}

function pillFromMeasured(row: HashtagYield, requireEmail: boolean): YieldPill {
  const perHundred = yieldPerHundred(row, requireEmail);
  if (perHundred != null) {
    const qualifying = requireEmail ? row.withEmail : row.creators;
    return {
      tag: row.tag,
      tone: row.flag === 'strong' ? 'strong' : row.flag === 'low' ? 'low' : row.flag === 'thin' ? 'thin' : 'neutral',
      suffix: `${perHundred}/100`,
      hint: `${row.tag}: ${qualifying} qualifying from ${row.sampled} videos, ${perHundred} per 100.`,
    };
  }
  if (row.flag === 'insufficient') {
    return {
      tag: row.tag,
      tone: 'neutral',
      suffix: 'Not enough data',
      hint: hashtagYieldHint(row, requireEmail),
    };
  }
  if (row.flag === 'low') {
    return {
      tag: row.tag,
      tone: 'low',
      suffix: 'Low yield',
      hint: hashtagYieldHint(row, requireEmail),
    };
  }
  if (row.flag === 'thin') {
    return {
      tag: row.tag,
      tone: 'thin',
      suffix: 'Thin',
      hint: hashtagYieldHint(row, requireEmail),
    };
  }
  return {
    tag: row.tag,
    tone: 'strong',
    suffix: 'Strong',
    hint: hashtagYieldHint(row, requireEmail),
  };
}

function yieldHasSignal(rows: readonly HashtagYield[]): boolean {
  return rows.some(
    (row) =>
      row.creators > 0 ||
      row.withEmail > 0 ||
      row.flag === 'strong' ||
      row.flag === 'thin' ||
      row.flag === 'insufficient',
  );
}

/**
 * Pills for the campaign hashtag row.
 * A tag with no stored yield is "Not searched", never "Low yield".
 * While a search is running and nothing has been measured, return nothing.
 */
export function presentHashtagYield(input: {
  campaignTags?: readonly string[] | null;
  measured?: readonly HashtagYield[] | null;
  running?: boolean;
  requireEmail?: boolean;
}): YieldPill[] {
  const requireEmail = input.requireEmail !== false;
  const measured: HashtagYield[] = [];
  const byTag = new Map<string, HashtagYield>();
  for (const row of input.measured ?? []) {
    const tag = normaliseHashtag(row.tag);
    if (!tag || byTag.has(tag)) continue;
    const next = { ...row, tag };
    byTag.set(tag, next);
    measured.push(next);
  }
  if (measured.length === 0) return [];
  if (input.running && !yieldHasSignal(measured)) return [];

  const campaign = normaliseHashtags(input.campaignTags ?? []);
  const ordered = campaign.length > 0 ? campaign : measured.map((row) => row.tag);
  const pills: YieldPill[] = [];
  const seen = new Set<string>();
  for (const tag of ordered) {
    seen.add(tag);
    const row = byTag.get(tag);
    if (!row) {
      if (input.running) continue;
      pills.push({
        tag,
        tone: 'neutral',
        suffix: 'Not searched',
        hint: `${tag} was not part of this search.`,
      });
      continue;
    }
    pills.push(pillFromMeasured(row, requireEmail));
  }
  for (const row of measured) {
    if (seen.has(row.tag)) continue;
    pills.push(pillFromMeasured(row, requireEmail));
  }
  return pills;
}

export function asHashtagYield(value: unknown): HashtagYield[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: HashtagYield[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const tag = normaliseHashtag(String(row.tag ?? ''));
    const flag =
      row.flag === 'low' || row.flag === 'thin' || row.flag === 'strong' || row.flag === 'insufficient'
        ? row.flag
        : null;
    if (!tag || !flag) continue;
    const sampled = Number(row.sampled);
    rows.push({
      tag,
      creators: Number(row.creators) || 0,
      withEmail: Number(row.withEmail) || 0,
      stale: Number(row.stale) || 0,
      flag,
      ...(Number.isFinite(sampled) && sampled >= 0 ? { sampled: Math.round(sampled) } : {}),
    });
  }
  return rows.length > 0 ? rows : undefined;
}
