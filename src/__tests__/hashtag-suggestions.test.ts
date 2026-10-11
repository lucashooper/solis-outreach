import { describe, expect, it } from 'vitest';
import {
  appendHashtag,
  hashtagSuggestionHint,
  insertHashtagAsSearched,
  rankHashtagSuggestions,
} from '../discovery/hashtagAdvice.ts';
import { aggregateHashtagHistory } from '../discovery/hashtagAdvice.ts';

describe('dynamic hashtag suggestions', () => {
  const history = aggregateHashtagHistory([
    [
      { tag: '#booktok', creators: 34, withEmail: 18 },
      { tag: '#books', creators: 4, withEmail: 3 },
      { tag: '#quiet', creators: 0, withEmail: 0 },
    ],
    [
      { tag: '#booktok', creators: 22, withEmail: 11 },
      { tag: '#quiet', creators: 0, withEmail: 0 },
    ],
  ]);

  it('ranks stored yield, then niche tags, and skips tags already added', () => {
    const ranked = rankHashtagSuggestions({
      history,
      current: ['#books'],
      niches: ['reading'],
    });
    expect(ranked[0]).toMatchObject({
      tag: '#booktok',
      source: 'history',
      creators: 56,
      withEmail: 29,
    });
    expect(ranked.map((row) => row.tag)).not.toContain('#books');
    expect(ranked.map((row) => row.tag)).not.toContain('#quiet');
    expect(ranked.map((row) => row.tag)).toEqual(
      expect.arrayContaining([
        '#bookstagram',
        '#bookrecommendations',
        '#readingcommunity',
      ]),
    );
    expect(hashtagSuggestionHint(ranked[0]!)).toBe('56 creators · 29 with email · 2 runs');
    const niche = ranked.find((row) => row.tag === '#bookstagram');
    expect(hashtagSuggestionHint(niche!)).toBe('Often works in this niche');
  });

  it('adds a tag, or moves it into the searched pair', () => {
    expect(appendHashtag(['#books', '#reading'], '#booktok')).toEqual([
      '#books',
      '#reading',
      '#booktok',
    ]);
    expect(appendHashtag(['#booktok', '#books'], '#booktok')).toEqual(['#booktok', '#books']);
    expect(insertHashtagAsSearched(['#books', '#reading', '#reader'], '#booktok')).toEqual([
      '#booktok',
      '#books',
      '#reading',
      '#reader',
    ]);
    expect(insertHashtagAsSearched(['#books', '#booktok', '#reading'], 'BookTok')).toEqual([
      '#booktok',
      '#books',
      '#reading',
    ]);
  });
});
