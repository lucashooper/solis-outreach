import { describe, expect, it } from 'vitest';
import {
  isGenericExpansionTag,
  rankExpansionCandidates,
  semanticNeighbourTags,
  strongPackName,
} from '../discovery/expansionTags.js';
import { parseFallbackHashtags } from '../discovery/fallbackTags.js';
import { expansionChoices } from '../discovery/shortfall.js';

describe('expansion tags', () => {
  it('drops generic creator-economy tags, including the old ExampleApp fallback', () => {
    expect(isGenericExpansionTag('#contentcreator')).toBe(true);
    expect(isGenericExpansionTag('#creatorcommunity')).toBe(true);
    expect(isGenericExpansionTag('#fyp')).toBe(true);
    expect(isGenericExpansionTag('#booktok')).toBe(false);
    expect(
      parseFallbackHashtags(
        '{"hashtags":["#contentcreator","#creatorcommunity","#fyp","#bookrecommendations"]}',
        ['#booktok'],
      ),
    ).toEqual(['#bookrecommendations']);
  });

  it('ranks strong history, then packs, then reading neighbours for ExampleApp', () => {
    const ranked = rankExpansionCandidates({
      appName: 'ExampleApp',
      niche: 'book summaries',
      pitch: 'scans a physical book and gives you the key ideas',
      blocked: ['#booktok', '#books'],
      history: [
        { tag: '#readingcommunity', runs: 2, creators: 12, withEmail: 8 },
        { tag: '#deepstash', runs: 3, creators: 0, withEmail: 0 },
        { tag: '#contentcreator', runs: 1, creators: 4, withEmail: 2 },
      ],
      packTags: ['#productivity', '#bookstagram', '#booktok'],
      modelTags: ['#creatorcommunity', '#nonfictionbooks'],
    });
    expect(ranked[0]).toBe('#readingcommunity');
    expect(ranked).toContain('#productivity');
    expect(ranked).toContain('#bookstagram');
    expect(ranked).toContain('#nonfictionbooks');
    expect(ranked.indexOf('#readingcommunity')).toBeLessThan(ranked.indexOf('#productivity'));
    expect(ranked.indexOf('#productivity')).toBeLessThan(ranked.indexOf('#bookrecommendations'));
    expect(ranked).not.toContain('#contentcreator');
    expect(ranked).not.toContain('#creatorcommunity');
    expect(ranked).not.toContain('#booktok');
    expect(ranked).not.toContain('#deepstash');
  });

  it('offers ExampleApp neighbours such as book recommendations before a generic model tag', () => {
    const tags = semanticNeighbourTags({
      appName: 'ExampleApp',
      niche: 'reading',
      pitch: 'learning from books',
      blocked: ['#booktok'],
    });
    expect(tags.slice(0, 4)).toEqual([
      '#bookrecommendations',
      '#bookstagram',
      '#nonfictionbooks',
      '#selfimprovementbooks',
    ]);
    const choices = expansionChoices({
      tried: ['#booktok', '#books'],
      stored: ['#contentcreator', '#creatorcommunity'],
      niche: 'reading',
      appName: 'ExampleApp',
      pitch: 'book summaries',
    });
    expect(choices.suggested).toEqual(['#bookrecommendations', '#bookstagram']);
    expect(choices.suggested.join(' ')).not.toMatch(/contentcreator|creatorcommunity/);
  });

  it('names a strong-tag pack after the app', () => {
    expect(strongPackName('ExampleApp')).toBe('ExampleApp strong');
    expect(strongPackName('  ')).toBe('App strong');
  });
});
