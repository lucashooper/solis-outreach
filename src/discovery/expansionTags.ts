import type { HashtagHistoryRow } from './hashtagAdvice.js';
import { isWeakHashtag } from './hashtagAdvice.js';
import { normaliseHashtag, normaliseHashtags } from './hashtags.js';

/**
 * Broad creator-economy tags. The fallback model used to offer these
 * (#contentcreator, #creatorcommunity) for every niche, including ExampleApp.
 */
const GENERIC_EXPANSION_TAGS = new Set([
  'contentcreator',
  'contentcreators',
  'creatorcommunity',
  'creator',
  'creators',
  'creatoreconomy',
  'fyp',
  'foryou',
  'foryoupage',
  'fy',
  'fypage',
  'viral',
  'viralvideo',
  'ugc',
  'ugccreator',
  'influencer',
  'influencers',
  'influencerlife',
  'tiktok',
  'instagram',
  'reels',
  'explore',
  'trending',
  'xyzbca',
  'duet',
  'stitch',
]);

export function expansionTagBare(tag: string): string {
  return tag.replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isGenericExpansionTag(tag: string): boolean {
  const bare = expansionTagBare(tag);
  return !bare || GENERIC_EXPANSION_TAGS.has(bare);
}

const READING_TAGS = [
  'bookrecommendations',
  'bookstagram',
  'nonfictionbooks',
  'selfimprovementbooks',
  'productivity',
  'personalgrowth',
  'readingcommunity',
  'authortok',
  'booktok',
];

export function isReadingExpansionApp(blob: string): boolean {
  return /book|read|author|novel|fiction|learning|study|productiv|selfimprove|summary|nonfiction|exampleapp/i.test(
    blob,
  );
}

/** Niche neighbours for this app. Book and learning apps get reading tags, not creator-economy tags. */
export function semanticNeighbourTags(input: {
  niche?: string | null;
  pitch?: string | null;
  appName?: string | null;
  blocked?: readonly string[];
}): string[] {
  const blob = [input.appName, input.niche, input.pitch].filter(Boolean).join(' ');
  if (!isReadingExpansionApp(blob)) return [];
  const blocked = new Set(normaliseHashtags(input.blocked ?? []));
  const out: string[] = [];
  for (const bare of READING_TAGS) {
    const tag = normaliseHashtag(bare);
    if (!tag || blocked.has(tag) || out.includes(tag) || isGenericExpansionTag(tag)) continue;
    out.push(tag);
  }
  return out;
}

export interface ExpansionRankInput {
  history?: readonly HashtagHistoryRow[];
  packTags?: readonly string[];
  niche?: string | null;
  pitch?: string | null;
  appName?: string | null;
  blocked?: readonly string[];
  /** Cheap-model suggestions. They rank after history, packs, and local neighbours. */
  modelTags?: readonly string[];
  limit?: number;
}

/**
 * Tags worth searching next.
 * Strong stored yield, then this app's packs, then niche neighbours, then the model.
 * Generic creator tags are dropped at every step.
 */
export function rankExpansionCandidates(input: ExpansionRankInput): string[] {
  const blocked = new Set(normaliseHashtags(input.blocked ?? []));
  const out: string[] = [];
  const push = (raw: string) => {
    const tag = normaliseHashtag(raw);
    if (!tag || blocked.has(tag) || out.includes(tag) || isGenericExpansionTag(tag)) return;
    out.push(tag);
  };

  const strong = (input.history ?? [])
    .filter((row) => row.withEmail >= 1 && !isWeakHashtag(row))
    .sort((a, b) => b.withEmail - a.withEmail || b.creators - a.creators || b.runs - a.runs);
  for (const row of strong) push(row.tag);
  for (const tag of input.packTags ?? []) push(tag);
  for (const tag of semanticNeighbourTags(input)) push(tag);
  for (const tag of input.modelTags ?? []) push(tag);

  const limit = input.limit ?? 8;
  return out.slice(0, limit);
}

/** Name used when saving the strong tags from a yield row. */
export function strongPackName(appName: string | null | undefined): string {
  const name = (appName ?? '').trim() || 'App';
  return `${name} strong`;
}
