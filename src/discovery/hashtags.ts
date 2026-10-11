const GENERIC_QUERIES = new Set([
  'content creator',
  'ugc creator',
  'influencer collab',
]);

/** Store hashtags as #tag, lower case, with a single leading hash. */
export function normaliseHashtag(raw: string): string {
  const compact = raw.trim().replace(/\s+/g, '');
  const body = compact.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  if (!body) return '';
  return `#${body.toLowerCase()}`;
}

export function normaliseHashtags(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const tag = normaliseHashtag(String(value));
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Lower-case niche label. A pasted hashtag loses its leading hash. */
export function normaliseNiche(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, ' ');
}

/**
 * Split a pasted list on commas, semicolons, spaces, or newlines.
 * While the user is still typing, the last fragment stays in the field
 * unless it already ends with a separator or flush is set (Enter, Add, blur).
 */
export function partitionListInput(
  raw: string,
  flush: boolean,
): { parts: string[]; rest: string } {
  const hasBreak = /[\s,;]/.test(raw);
  if (!flush && !hasBreak) return { parts: [], rest: raw };
  const ends = /[\s,;]$/.test(raw);
  const pieces = raw
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (flush || ends) return { parts: pieces, rest: '' };
  const rest = pieces.pop() ?? '';
  return { parts: pieces, rest };
}

/** Apify hashtag inputs omit the leading hash. */
export function apifyHashtag(tag: string): string {
  return tag.replace(/^#+/, '').trim().toLowerCase();
}

export interface SearchTermInput {
  niches?: string[] | null;
  hashtags?: string[] | null;
}

export interface SearchTerms {
  hashtags: string[];
  searchQueries: string[];
}

/**
 * Explicit campaign hashtags lead the Apify search.
 * Niche keywords still add search queries, and only fill hashtags when no tags were set.
 */
export function campaignSearchTerms(
  input: SearchTermInput,
  derived: SearchTerms,
): SearchTerms {
  const explicit = normaliseHashtags(input.hashtags ?? [])
    .map(apifyHashtag)
    .filter(Boolean);
  if (explicit.length === 0) return derived;

  const hashtags = explicit.slice(0, 12);
  const searchQueries: string[] = [];
  for (const tag of explicit) {
    if (!searchQueries.includes(tag)) searchQueries.push(tag);
  }
  for (const query of derived.searchQueries) {
    if (searchQueries.length >= 8) break;
    if (GENERIC_QUERIES.has(query)) continue;
    if (!searchQueries.includes(query)) searchQueries.push(query);
  }
  return { hashtags, searchQueries: searchQueries.slice(0, 8) };
}

const BOOKISH = /book|read|author|novel|romance|literar|fiction|poetry/;

/**
 * Hashtags that have produced business emails for book and reading niches.
 * Suggestions only — the search uses them when the user adds them.
 */
export function suggestBusinessHashtags(niche: string): string[] {
  const compact = niche.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!compact || !BOOKISH.test(compact)) return [];
  const tags = [
    '#booktok',
    '#bookstagram',
    '#bookrecommendations',
    '#readingcommunity',
    '#authortok',
  ];
  return tags.filter((tag) => tag.slice(1) !== compact);
}
