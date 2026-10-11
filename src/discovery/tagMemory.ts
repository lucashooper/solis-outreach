import {
  CATEGORY_IDS,
  PREFERRED_TAGS,
  categoryDest,
  categoryOfTag,
  categoryTitle,
  type CategoryId,
} from './categories.js';
import { planNextRound, type ExpansionTier, type ExpansionTierIndex } from './expansionTiers.js';
import { normaliseHashtag, normaliseHashtags } from './hashtags.js';

/** A dry, well-sampled round. Two of these suppress the tag. */
export const DRY_ROUND_VIDEOS = 20;
export const DRY_ROUNDS_TO_SUPPRESS = 2;
export const SUPPRESS_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TagStat {
  tag: string;
  category: string | null;
  runs: number;
  videosSampled: number;
  inRange: number;
  withEmail: number;
  newSaved: number;
  dryRounds: number;
  lastScrapedAt: string | null;
  suppressedUntil: string | null;
}

export interface TagRound {
  tag: string;
  category?: string | null;
  videos: number;
  inRange: number;
  withEmail: number;
  newSaved: number;
}

export function emptyTagStat(tag: string, category: string | null = null): TagStat {
  return {
    tag,
    category,
    runs: 0,
    videosSampled: 0,
    inRange: 0,
    withEmail: 0,
    newSaved: 0,
    dryRounds: 0,
    lastScrapedAt: null,
    suppressedUntil: null,
  };
}

/** New qualifying creators per 100 videos. Unknown history is not a yield. */
export function yieldPer100(stat: Pick<TagStat, 'newSaved' | 'videosSampled'>): number | null {
  if (stat.videosSampled <= 0) return null;
  return (stat.newSaved / stat.videosSampled) * 100;
}

export function isSuppressed(stat: Pick<TagStat, 'suppressedUntil'> | null | undefined, now = Date.now()): boolean {
  if (!stat?.suppressedUntil) return false;
  const until = Date.parse(stat.suppressedUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * Fold one hashtag round into the running totals.
 * A round with at least 20 videos and no new qualifying creator counts as dry.
 * Two dry rounds suppress the tag for 30 days. A round that finds someone clears the dry streak.
 */
export function applyTagRound(stat: TagStat, round: TagRound, now = Date.now()): TagStat {
  const videos = Math.max(0, Math.round(round.videos) || 0);
  const newSaved = Math.max(0, Math.round(round.newSaved) || 0);
  const dry = videos >= DRY_ROUND_VIDEOS && newSaved === 0;
  const dryRounds = newSaved > 0 ? 0 : dry ? stat.dryRounds + 1 : stat.dryRounds;
  let suppressedUntil = stat.suppressedUntil;
  if (dryRounds >= DRY_ROUNDS_TO_SUPPRESS) {
    const next = new Date(now + SUPPRESS_DAYS * DAY_MS).toISOString();
    const current = suppressedUntil ? Date.parse(suppressedUntil) : 0;
    if (!Number.isFinite(current) || Date.parse(next) > current) suppressedUntil = next;
  }
  return {
    tag: stat.tag,
    category: round.category ?? stat.category ?? categoryOfTag(stat.tag),
    runs: stat.runs + 1,
    videosSampled: stat.videosSampled + videos,
    inRange: stat.inRange + Math.max(0, Math.round(round.inRange) || 0),
    withEmail: stat.withEmail + Math.max(0, Math.round(round.withEmail) || 0),
    newSaved: stat.newSaved + newSaved,
    dryRounds,
    lastScrapedAt: new Date(now).toISOString(),
    suppressedUntil,
  };
}

/**
 * Positive yield first, then tags we have not measured, then known dry tags.
 * Ties keep the incoming order.
 */
export function rankTagsByMemory(tags: readonly string[], stats: readonly TagStat[]): string[] {
  const byTag = new Map(stats.map((stat) => [normaliseHashtag(stat.tag), stat]));
  const decorated = tags.map((tag, index) => {
    const stat = byTag.get(normaliseHashtag(tag));
    const yieldValue = stat ? yieldPer100(stat) : null;
    const band = yieldValue == null ? 1 : yieldValue > 0 ? 0 : 2;
    return { tag, index, band, yieldValue: yieldValue ?? 0 };
  });
  decorated.sort((a, b) => a.band - b.band || b.yieldValue - a.yieldValue || a.index - b.index);
  return decorated.map((row) => row.tag);
}

export function preferredSeedTags(input: {
  categories: readonly CategoryId[];
  stats?: readonly TagStat[];
  blocked?: readonly string[];
  now?: number;
  limit?: number;
}): string[] {
  const now = input.now ?? Date.now();
  const blocked = new Set(normaliseHashtags(input.blocked ?? []));
  const stats = input.stats ?? [];
  const suppressed = new Set(
    stats.filter((stat) => isSuppressed(stat, now)).map((stat) => normaliseHashtag(stat.tag)),
  );
  const pool: string[] = [];
  for (const id of input.categories) {
    for (const bare of PREFERRED_TAGS[id] ?? []) {
      const tag = normaliseHashtag(bare);
      if (!tag || blocked.has(tag) || suppressed.has(tag) || pool.includes(tag)) continue;
      pool.push(tag);
    }
  }
  const ranked = rankTagsByMemory(pool, stats);
  const limit = input.limit ?? ranked.length;
  return ranked.slice(0, Math.max(0, limit));
}

function roundAdjective(flags: readonly string[]): 'thin' | 'low' | null {
  if (flags.length === 0) return null;
  const weak = flags.every(
    (flag) => flag === 'thin' || flag === 'low' || flag === 'insufficient',
  );
  if (!weak) return null;
  return flags.every((flag) => flag === 'low') ? 'low' : 'thin';
}

export function rotationMessage(
  from: CategoryId,
  adjective: 'thin' | 'low',
  to: CategoryId,
  tags: readonly string[],
): string {
  return `${categoryTitle(from)} tags were ${adjective}, switched to ${categoryDest(to)}: ${tags.join(', ')}`;
}

/**
 * When the previous round was thin, low, or under-sampled, take the best
 * untried tags from a different active category. Suppressed and cooling tags
 * are never offered.
 */
export function planCategoryRotation(input: {
  previousTags: readonly string[];
  previousFlags: readonly string[];
  tried?: readonly string[];
  blocked?: readonly string[];
  stats?: readonly TagStat[];
  categories?: readonly CategoryId[];
  now?: number;
}): { tags: string[]; category: CategoryId; message: string } | null {
  const adjective = roundAdjective(input.previousFlags);
  if (!adjective) return null;
  const previous = input.previousTags.map((tag) => categoryOfTag(tag)).find((id): id is CategoryId => id != null);
  const from: CategoryId = previous ?? 'books';
  const active = (input.categories?.length ? input.categories : [...CATEGORY_IDS]).filter((id, index, all) =>
    all.indexOf(id) === index,
  );
  const pool = active.includes(from) ? active : [from, ...active];
  const start = Math.max(0, pool.indexOf(from));
  const tried = new Set(normaliseHashtags([...(input.tried ?? []), ...input.previousTags]));
  const blocked = new Set(normaliseHashtags(input.blocked ?? []));
  for (let step = 1; step <= pool.length; step += 1) {
    const category = pool[(start + step) % pool.length];
    if (!category || category === from) continue;
    const candidates = preferredSeedTags({
      categories: [category],
      stats: input.stats,
      blocked: [...tried, ...blocked],
      now: input.now,
    }).slice(0, 2);
    if (candidates.length === 0) continue;
    return {
      tags: candidates,
      category,
      message: rotationMessage(from, adjective, category, candidates),
    };
  }
  return null;
}

/**
 * Next expand round. A weak previous round rotates category. Otherwise the
 * existing tier planner runs, still skipping suppressed and cooling tags.
 */
export function selectExpansionTags(input: {
  tiers: readonly ExpansionTier[];
  tried: readonly string[];
  afterTier?: number | null;
  previousTags?: readonly string[];
  previousFlags?: readonly string[];
  blocked?: readonly string[];
  stats?: readonly TagStat[];
  categories?: readonly CategoryId[];
  now?: number;
}): {
  tags: string[];
  tier: ExpansionTierIndex | null;
  exhausted: boolean;
  rotation: string | null;
} {
  const blocked = new Set(normaliseHashtags(input.blocked ?? []));
  const rotation = planCategoryRotation({
    previousTags: input.previousTags ?? [],
    previousFlags: input.previousFlags ?? [],
    tried: input.tried,
    blocked: input.blocked,
    stats: input.stats,
    categories: input.categories ?? [...CATEGORY_IDS],
    now: input.now,
  });
  if (rotation) {
    return { tags: rotation.tags, tier: null, exhausted: false, rotation: rotation.message };
  }
  const tiers = input.tiers
    .map((tier) => ({ ...tier, tags: tier.tags.filter((tag) => !blocked.has(tag)) }))
    .filter((tier) => tier.tags.length > 0);
  const next = planNextRound({ tiers, tried: input.tried, afterTier: input.afterTier });
  return { tags: next.tags, tier: next.tier, exhausted: next.exhausted, rotation: null };
}
