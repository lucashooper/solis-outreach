import type { HashtagHistoryRow } from './hashtagAdvice.js';
import { isWeakHashtag } from './hashtagAdvice.js';
import { isGenericExpansionTag, isReadingExpansionApp } from './expansionTags.js';
import { FALLBACK_TAG_CAP, neighbourHashtags } from './fallbackTags.js';
import { normaliseHashtag, normaliseHashtags } from './hashtags.js';

/** One Expand click may run this many Apify rounds, and only when earlier rounds add nobody. */
export const EXPANSION_ROUNDS_PER_CLICK = 3;

/** Custom hashtags typed on the shortfall card. */
export const CUSTOM_HASHTAG_CAP = 5;

export type ExpansionTierIndex = 1 | 2 | 3;

export interface ExpansionTier {
  tier: ExpansionTierIndex;
  tags: string[];
}

export interface ExpansionRoundLog {
  tags: string[];
  added: number;
  tier?: ExpansionTierIndex;
}

/** Close book-niche synonyms. Strong history and saved packs are placed in front of these. */
const BOOK_CLOSE = [
  'bookrecommendations',
  'bookstagram',
  'booktokbooks',
  'readingcommunity',
  'authortok',
];

/** Adjacent book tags. Used only after the close tier is skipped or used up for this click. */
const BOOK_ADJACENT = [
  'nonfictionbooks',
  'selfimprovementbooks',
  'bookreview',
  'currentlyreading',
  'booklover',
];

/** Broader semantic tags. Last resort before the custom hashtag field. */
const BOOK_BROAD = ['productivity', 'personalgrowth', 'learning', 'studytok'];

export interface ExpansionTierInput {
  appName?: string | null;
  niche?: string | null;
  pitch?: string | null;
  history?: readonly HashtagHistoryRow[];
  packTags?: readonly string[];
  /** Cached cheap-model suggestions. Generic tags are dropped. */
  modelTags?: readonly string[];
  /** Cooldown, suppression, campaign hashtags, and tags already searched. */
  blocked?: readonly string[];
}

function pushTag(out: string[], seen: Set<string>, raw: string): void {
  const tag = normaliseHashtag(raw);
  if (!tag || seen.has(tag) || isGenericExpansionTag(tag)) return;
  seen.add(tag);
  out.push(tag);
}

function strongHistory(history: readonly HashtagHistoryRow[] | undefined, seen: Set<string>): string[] {
  const rows = (history ?? [])
    .filter((row) => row.withEmail >= 1 && !isWeakHashtag(row))
    .sort((a, b) => b.withEmail - a.withEmail || b.creators - a.creators || b.runs - a.runs);
  const out: string[] = [];
  for (const row of rows) pushTag(out, seen, row.tag);
  return out;
}

/**
 * Ordered tag tiers for one app.
 * Tier 1 is close (strong history, saved packs, niche synonyms).
 * Tier 2 is adjacent. Tier 3 is broader. Generic creator tags never appear.
 */
export function buildExpansionTiers(input: ExpansionTierInput): ExpansionTier[] {
  const blob = [input.appName, input.niche, input.pitch].filter(Boolean).join(' ');
  const reading = isReadingExpansionApp(blob);
  const seen = new Set<string>(normaliseHashtags(input.blocked ?? []));
  const close: string[] = [];
  const adjacent: string[] = [];
  const broad: string[] = [];

  for (const tag of strongHistory(input.history, seen)) close.push(tag);
  for (const tag of input.packTags ?? []) pushTag(close, seen, tag);

  if (reading) {
    for (const bare of BOOK_CLOSE) pushTag(close, seen, bare);
    for (const bare of BOOK_ADJACENT) pushTag(adjacent, seen, bare);
    for (const bare of BOOK_BROAD) pushTag(broad, seen, bare);
  } else {
    for (const tag of neighbourHashtags([input.niche ?? '', input.appName ?? ''])) {
      pushTag(close, seen, tag);
    }
  }

  for (const tag of input.modelTags ?? []) pushTag(close, seen, tag);

  const tiers: ExpansionTier[] = [
    { tier: 1, tags: close },
    { tier: 2, tags: adjacent },
    { tier: 3, tags: broad },
  ];
  return tiers.filter((tier) => tier.tags.length > 0);
}

export function tierOfTag(tiers: readonly ExpansionTier[], tag: string): ExpansionTierIndex | null {
  const needle = normaliseHashtag(tag);
  if (!needle) return null;
  for (const tier of tiers) {
    if (tier.tags.includes(needle)) return tier.tier;
  }
  return null;
}

/**
 * The next capped round: at most two untried tags.
 * `afterTier` skips that tier and everything before it, so a dry round
 * moves on to the next tier inside the same click. Leftover tags in the
 * dry tier stay available for a later click.
 */
export function planNextRound(input: {
  tiers: readonly ExpansionTier[];
  tried: readonly string[];
  afterTier?: number | null;
}): { tags: string[]; tier: ExpansionTierIndex | null; exhausted: boolean } {
  const tried = new Set(normaliseHashtags(input.tried).filter((tag) => !isGenericExpansionTag(tag)));
  const start = input.afterTier && input.afterTier >= 1 ? input.afterTier + 1 : 1;
  for (const tier of input.tiers) {
    if (tier.tier < start) continue;
    const tags = tier.tags
      .filter((tag) => !tried.has(tag) && !isGenericExpansionTag(tag))
      .slice(0, FALLBACK_TAG_CAP);
    if (tags.length > 0) return { tags, tier: tier.tier, exhausted: false };
  }
  const anyLeft = input.tiers.some((tier) =>
    tier.tags.some((tag) => !tried.has(tag) && !isGenericExpansionTag(tag)),
  );
  return { tags: [], tier: null, exhausted: !anyLeft };
}

/** Other untried tags in the same tier, so a chip can be swapped. */
export function tierAlternatives(
  tiers: readonly ExpansionTier[],
  suggested: readonly string[],
  tried: readonly string[],
): string[] {
  const skip = new Set(normaliseHashtags([...suggested, ...tried]));
  const tier = suggested.map((tag) => tierOfTag(tiers, tag)).find((value) => value != null) ?? null;
  const pool = (tier == null ? inputTags(tiers) : (tiers.find((row) => row.tier === tier)?.tags ?? []))
    .filter((tag) => !skip.has(tag) && !isGenericExpansionTag(tag));
  return pool.slice(0, 6);
}

function inputTags(tiers: readonly ExpansionTier[]): string[] {
  return tiers.flatMap((tier) => tier.tags);
}

/**
 * Whether the same click should start another Apify round.
 * A related-tag round chains only when it added nobody. A custom list
 * keeps going until those tags are done. Both stop at the round cap
 * and once the minimum is reached.
 */
export function shouldChainRound(input: {
  added: number;
  roundsUsed: number;
  finished: number;
  target: number;
  exhausted: boolean;
  custom?: boolean;
}): boolean {
  if (input.exhausted) return false;
  if (input.roundsUsed >= EXPANSION_ROUNDS_PER_CLICK) return false;
  if (input.target >= 1 && input.finished >= input.target) return false;
  if (input.custom) return true;
  return input.added <= 0;
}

export function expansionRoundLabel(round: number, total = EXPANSION_ROUNDS_PER_CLICK): string {
  const current = Math.max(1, Math.min(total, Math.round(round) || 1));
  return `Apify round ${current} of ${total}`;
}

export function expansionResultMessage(
  log: readonly ExpansionRoundLog[],
  opts: { exhausted?: boolean; metTarget?: boolean } = {},
): string {
  const rounds = log.length;
  const added = log.reduce((sum, row) => sum + Math.max(0, row.added), 0);
  const roundWord = rounds === 1 ? '1 Apify round' : `${rounds} Apify rounds`;
  const searched = log
    .map((row) => row.tags.filter(Boolean))
    .filter((tags) => tags.length > 0)
    .map((tags) => (tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`));
  const list =
    searched.length === 0
      ? ''
      : searched.length === 1
        ? searched[0]
        : `${searched.slice(0, -1).join(', then ')}, then ${searched[searched.length - 1]}`;
  if (rounds === 0) {
    return opts.exhausted
      ? 'Related tags are used up. Type your own hashtags to search again.'
      : 'No related tags left to try.';
  }
  if (opts.metTarget) {
    const creator = added === 1 ? '1 creator' : `${added} creators`;
    return `Reached the minimum. Added ${creator}${list ? ` from ${list}` : ''}. ${roundWord}. Nothing was emailed.`;
  }
  if (added === 0) {
    const tail = opts.exhausted ? ' Related tags are used up. Type your own hashtags to search again.' : '';
    return `No new creators${list ? ` from ${list}` : ''}. ${roundWord}.${tail} Nothing was emailed.`;
  }
  const creator = added === 1 ? '1 creator' : `${added} creators`;
  return `Added ${creator}${list ? ` from ${list}` : ''}. ${roundWord}. Nothing was emailed.`;
}

export interface ParsedCustomHashtags {
  tags: string[];
  error: string | null;
}

/**
 * Comma-separated hashtags. Accepts a leading hash or not, trims,
 * lowercases, and drops duplicates. At most five. Generic tags are rejected.
 */
export function parseCustomHashtags(raw: string): ParsedCustomHashtags {
  const pieces = raw
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (pieces.length === 0) return { tags: [], error: 'Enter one or more hashtags.' };
  const tags: string[] = [];
  const rejected: string[] = [];
  for (const piece of pieces) {
    const tag = normaliseHashtag(piece);
    const body = tag.replace(/^#+/, '');
    if (!tag || body.length < 2 || body.length > 40) {
      rejected.push(piece);
      continue;
    }
    if (isGenericExpansionTag(tag)) {
      rejected.push(tag);
      continue;
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > CUSTOM_HASHTAG_CAP) {
    return {
      tags: [],
      error: `Use at most ${CUSTOM_HASHTAG_CAP} hashtags.`,
    };
  }
  if (tags.length === 0) {
    return {
      tags: [],
      error: 'Those hashtags are too broad or not valid. Try a niche tag.',
    };
  }
  if (rejected.length > 0) {
    return {
      tags,
      error: `Drop ${rejected.join(', ')}. ${rejected.length === 1 ? 'It is' : 'They are'} too broad or not valid.`,
    };
  }
  return { tags, error: null };
}

/** Drop denylisted tags, including ones stored on an older funnel. */
export function withoutDeniedTags(tags: readonly string[] | null | undefined): string[] {
  return normaliseHashtags(tags ?? []).filter((tag) => !isGenericExpansionTag(tag));
}
