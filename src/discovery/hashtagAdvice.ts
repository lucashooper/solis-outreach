import { normaliseHashtags, suggestBusinessHashtags } from './hashtags.js';
import type { HashtagYield } from './hashtagYield.js';

/** TikTok searches send at most this many hashtags. Order is the search order. */
export const SEARCHED_HASHTAG_CAP = 2;

export interface HashtagHistoryRow {
  tag: string;
  runs: number;
  creators: number;
  withEmail: number;
}

/** Sum hashtagYield across stored jobs. One run counts a tag once. */
export function aggregateHashtagHistory(
  yields: ReadonlyArray<readonly Pick<HashtagYield, 'tag' | 'creators' | 'withEmail'>[] | null | undefined>,
): HashtagHistoryRow[] {
  const map = new Map<string, HashtagHistoryRow>();
  for (const rows of yields) {
    if (!rows || rows.length === 0) continue;
    const seen = new Set<string>();
    for (const row of rows) {
      const tag = normaliseHashtags([row.tag])[0];
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      const current = map.get(tag) ?? { tag, runs: 0, creators: 0, withEmail: 0 };
      current.runs += 1;
      current.creators += Math.max(0, Number(row.creators) || 0);
      current.withEmail += Math.max(0, Number(row.withEmail) || 0);
      map.set(tag, current);
    }
  }
  return [...map.values()].sort((a, b) => b.withEmail - a.withEmail || b.creators - a.creators);
}

/** Repeatedly empty. A single quiet run is not enough to mark a tag. */
export function isWeakHashtag(row: HashtagHistoryRow | undefined): boolean {
  if (!row || row.runs < 2) return false;
  return row.creators === 0;
}

export function weakHashtagTooltip(row: HashtagHistoryRow): string {
  const runs = row.runs === 1 ? '1 run' : `${row.runs} runs`;
  const creators = row.creators === 1 ? '1 creator' : `${row.creators} creators`;
  return `${creators} across ${runs}`;
}

function historyByTag(history: readonly HashtagHistoryRow[]): Map<string, HashtagHistoryRow> {
  return new Map(history.map((row) => [row.tag, row]));
}

export interface HashtagSuggestion {
  tag: string;
  source: 'history' | 'niche';
  creators: number;
  withEmail: number;
  runs: number;
}

/** Tooltip for a suggestion chip. History uses stored yield. Niche tags have no run yet. */
export function hashtagSuggestionHint(row: HashtagSuggestion): string {
  if (row.source === 'history' && (row.runs > 0 || row.creators > 0 || row.withEmail > 0)) {
    const creators = row.creators === 1 ? '1 creator' : `${row.creators} creators`;
    const emails = row.withEmail === 1 ? '1 with email' : `${row.withEmail} with email`;
    const runs = row.runs === 1 ? '1 run' : `${row.runs} runs`;
    return `${creators} · ${emails} · ${runs}`;
  }
  return 'Often works in this niche';
}

/**
 * Strong stored tags first (by public emails, then creators), then niche
 * high-performers that are not already on the campaign. No Apify call.
 */
export function rankHashtagSuggestions(input: {
  history: readonly HashtagHistoryRow[];
  current: readonly string[];
  niches?: readonly string[] | null;
  presetTags?: readonly string[] | null;
  limit?: number;
}): HashtagSuggestion[] {
  const current = new Set(normaliseHashtags(input.current));
  const byTag = historyByTag(input.history);
  const fromHistory = input.history
    .filter(
      (row) =>
        !current.has(row.tag) &&
        !isWeakHashtag(row) &&
        (row.withEmail >= 1 || row.creators >= 1),
    )
    .sort((a, b) => b.withEmail - a.withEmail || b.creators - a.creators || b.runs - a.runs)
    .map((row) => ({
      tag: row.tag,
      source: 'history' as const,
      creators: row.creators,
      withEmail: row.withEmail,
      runs: row.runs,
    }));
  const seen = new Set(fromHistory.map((row) => row.tag));
  const extras = normaliseHashtags([
    ...suggestBusinessHashtags((input.niches ?? []).join(' ')),
    ...(input.presetTags ?? []),
  ])
    .filter((tag) => !current.has(tag) && !seen.has(tag) && !isWeakHashtag(byTag.get(tag)))
    .map((tag) => {
      const known = byTag.get(tag);
      return {
        tag,
        source: 'niche' as const,
        creators: known?.creators ?? 0,
        withEmail: known?.withEmail ?? 0,
        runs: known?.runs ?? 0,
      };
    });
  const limit = input.limit ?? 6;
  return [...fromHistory, ...extras].slice(0, limit);
}

/** Strong tags from history, then niche and preset tags that are not already selected. */
export function suggestHashtags(input: {
  history: readonly HashtagHistoryRow[];
  current: readonly string[];
  niches?: readonly string[] | null;
  presetTags?: readonly string[] | null;
  limit?: number;
}): string[] {
  return rankHashtagSuggestions(input).map((row) => row.tag);
}

/** Add a tag at the end. Already-selected tags stay put. */
export function appendHashtag(tags: readonly string[], tag: string): string[] {
  return normaliseHashtags([...tags, tag]);
}

/** Put a tag into the searched window (the first two slots) and keep the rest. */
export function insertHashtagAsSearched(tags: readonly string[], tag: string): string[] {
  const next = normaliseHashtags([tag])[0];
  if (!next) return normaliseHashtags(tags);
  const rest = normaliseHashtags(tags).filter((item) => item !== next);
  return [next, ...rest];
}

/** Put tags that have produced creators first. Unknown tags keep their relative order. */
export function sortHashtagsByYield(
  tags: readonly string[],
  history: readonly HashtagHistoryRow[],
): string[] {
  const list = normaliseHashtags(tags);
  const byTag = historyByTag(history);
  return list
    .map((tag, index) => ({ tag, index, row: byTag.get(tag) }))
    .sort((a, b) => {
      const email = (b.row?.withEmail ?? -1) - (a.row?.withEmail ?? -1);
      if (email !== 0) return email;
      const creators = (b.row?.creators ?? -1) - (a.row?.creators ?? -1);
      if (creators !== 0) return creators;
      return a.index - b.index;
    })
    .map((item) => item.tag);
}

export function withoutWeakHashtags(
  tags: readonly string[],
  history: readonly HashtagHistoryRow[],
): string[] {
  const byTag = historyByTag(history);
  return normaliseHashtags(tags).filter((tag) => !isWeakHashtag(byTag.get(tag)));
}
