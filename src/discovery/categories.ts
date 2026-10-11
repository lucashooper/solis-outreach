import { normaliseHashtag } from './hashtags.js';

/**
 * App-relevant creator categories.
 * ExampleApp searches all of them. Other apps use the ones named by the
 * value proposition, niches, and campaign hashtags.
 */
export const CATEGORY_IDS = [
  'books',
  'study',
  'productivity',
  'self-improvement',
  'learning',
  'entrepreneurship',
  'desk',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/** Sentence label. "Book tags were thin, switched to study". */
const CATEGORY_COPY: Record<CategoryId, { title: string; dest: string }> = {
  books: { title: 'Book', dest: 'books' },
  study: { title: 'Study', dest: 'study' },
  productivity: { title: 'Productivity', dest: 'productivity' },
  'self-improvement': { title: 'Self-improvement', dest: 'self-improvement' },
  learning: { title: 'Learning', dest: 'learning' },
  entrepreneurship: { title: 'Entrepreneurship', dest: 'entrepreneurship' },
  desk: { title: 'Desk', dest: 'desk' },
};

/**
 * Words and phrases matched in a bio or nickname.
 * Short words are matched on a word boundary by the relevance checker.
 */
const CATEGORY_TERMS: Record<CategoryId, readonly string[]> = {
  books: [
    'book',
    'books',
    'reading',
    'read',
    'booktok',
    'bookish',
    'nonfiction',
    'non-fiction',
    'novel',
    'author',
    'reader',
    'lit',
    'tbr',
  ],
  study: ['studytok', 'studyblr', 'student', 'exam', 'uni', 'study', 'university', 'revision'],
  productivity: ['productivity', 'notion', 'planner', 'routine', 'habits', 'habit'],
  'self-improvement': [
    'self improvement',
    'self-improvement',
    'selfimprovement',
    'growth',
    'discipline',
    'mindset',
    'selfgrowth',
  ],
  learning: ['learn', 'learning', 'summaries', 'summary', 'podcast', 'knowledge'],
  entrepreneurship: ['founder', 'business', 'startup', 'entrepreneur'],
  desk: ['desk setup', 'desksetup', 'study aesthetic', 'studyaesthetic', 'deskaesthetic', 'desk'],
};

/**
 * Curated tags used when the campaign hashtags are on cooldown or used up.
 * Ranked later by tag memory. Order here is the fallback when a tag has no history.
 */
export const PREFERRED_TAGS: Record<CategoryId, readonly string[]> = {
  books: [
    'nonfictionbooks',
    'nonfictionreads',
    'tbrpile',
    'readinghabits',
    'bookrecs',
    'whattoreadnext',
  ],
  study: ['studytok', 'studyblr', 'studywithme', 'studytips', 'studymotivation'],
  productivity: [
    'productivitytips',
    'productivityhacks',
    'notiontemplates',
    'planwithme',
    'dailyroutine',
  ],
  'self-improvement': ['selfimprovement', 'selfgrowth', 'habits', 'discipline'],
  learning: ['learnontiktok', 'booksummary'],
  desk: ['desksetup', 'studyaesthetic', 'deskaesthetic'],
  entrepreneurship: ['entrepreneurtok', 'businessbooks'],
};

export function isCategoryId(value: string): value is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(value);
}

export function categoryTitle(id: CategoryId): string {
  return CATEGORY_COPY[id].title;
}

export function categoryDest(id: CategoryId): string {
  return CATEGORY_COPY[id].dest;
}

export function categoryTerms(id: CategoryId): string[] {
  return [...CATEGORY_TERMS[id]];
}

export function categoryKeywordMap(ids: readonly CategoryId[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of ids) out[id] = categoryTerms(id);
  return out;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function blobOf(parts: readonly (string | null | undefined)[]): string {
  return parts
    .flatMap((part) => (part ? [part] : []))
    .join(' ')
    .toLowerCase();
}

function categoryMentioned(id: CategoryId, blob: string, compactBlob: string): boolean {
  return CATEGORY_TERMS[id].some((term) => {
    const raw = term.toLowerCase();
    if (raw.includes(' ') || raw.includes('-')) return blob.includes(raw) || compactBlob.includes(compact(raw));
    const token = compact(raw);
    if (token.length <= 4) {
      return new RegExp(`(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`, 'i').test(blob);
    }
    return blob.includes(raw) || compactBlob.includes(token);
  });
}

/**
 * Categories this app should search.
 * ExampleApp uses every category. Anything else uses the categories named in
 * the value proposition, niches, and hashtags. A reading-shaped app with no
 * single hit still gets the full set, so a vague pitch does not collapse to books only.
 */
export function activeCategoryIds(input: {
  appName?: string | null;
  valueProp?: string | null;
  niches?: readonly string[] | null;
  hashtags?: readonly string[] | null;
}): CategoryId[] {
  const blob = blobOf([
    input.appName,
    input.valueProp,
    ...(input.niches ?? []),
    ...(input.hashtags ?? []),
  ]);
  const compactBlob = compact(blob);
  if (/exampleapp/.test(blob)) return [...CATEGORY_IDS];
  const matched = CATEGORY_IDS.filter((id) => categoryMentioned(id, blob, compactBlob));
  if (matched.length > 0) return matched;
  if (/book|read|author|novel|fiction|learning|study|productiv|selfimprove|summary|nonfiction/.test(blob)) {
    return [...CATEGORY_IDS];
  }
  return ['books'];
}

/** Which preferred-tag category a hashtag belongs to, if any. */
export function categoryOfTag(tag: string): CategoryId | null {
  const bare = compact(normaliseHashtag(tag).replace(/^#/, ''));
  if (!bare) return null;
  for (const id of CATEGORY_IDS) {
    if (PREFERRED_TAGS[id].some((preferred) => compact(preferred) === bare)) return id;
    if (CATEGORY_TERMS[id].some((term) => compact(term) === bare)) return id;
  }
  for (const id of CATEGORY_IDS) {
    if (
      CATEGORY_TERMS[id].some((term) => {
        const token = compact(term);
        return token.length >= 5 && (bare.includes(token) || token.includes(bare));
      })
    ) {
      return id;
    }
  }
  return null;
}

export function categoriesForCounts(
  text: string,
  ids: readonly CategoryId[],
  matches: (text: string, keywords: readonly string[]) => boolean,
): CategoryId[] {
  return ids.filter((id) => matches(text, CATEGORY_TERMS[id]));
}
