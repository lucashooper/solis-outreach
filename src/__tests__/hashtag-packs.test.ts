import { describe, expect, it } from 'vitest';
import {
  SYSTEM_HASHTAG_PACKS,
  splitHashtagPacks,
  visibleHashtagPacks,
  type HashtagPack,
} from '../discovery/hashtagPacks.js';

const custom: HashtagPack = {
  id: 'pack-1',
  name: 'Romance',
  hashtags: ['#romancebooks'],
  system: false,
};

describe('hashtag packs', () => {
  it('keeps custom packs apart from system packs', () => {
    const packs = visibleHashtagPacks([custom], []);
    expect(packs.custom.map((pack) => pack.name)).toEqual(['Romance']);
    expect(packs.system.map((pack) => pack.name)).toEqual(
      SYSTEM_HASHTAG_PACKS.map((pack) => pack.name),
    );
    expect(splitHashtagPacks([...packs.custom, ...packs.system]).system.every((pack) => pack.system)).toBe(
      true,
    );
  });

  it('uses saved system packs when the app already has them', () => {
    const remote: HashtagPack = {
      id: 'sys-1',
      name: 'BookTok',
      hashtags: ['#booktok', '#books'],
      system: true,
    };
    const packs = visibleHashtagPacks([custom], [remote]);
    expect(packs.system).toEqual([remote]);
    expect(packs.custom).toEqual([custom]);
  });
});