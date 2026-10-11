export interface HashtagPack {
  id: string;
  name: string;
  hashtags: string[];
  system: boolean;
}

/** Starting packs. Custom packs the user saves sit beside these, not mixed in. */
export const SYSTEM_HASHTAG_PACKS: readonly HashtagPack[] = [
  {
    id: 'system-booktok',
    name: 'BookTok',
    hashtags: ['#booktok', '#books'],
    system: true,
  },
];

export function splitHashtagPacks(packs: readonly HashtagPack[]): {
  custom: HashtagPack[];
  system: HashtagPack[];
} {
  return {
    custom: packs.filter((pack) => !pack.system),
    system: packs.filter((pack) => pack.system),
  };
}

/** Saved packs for this app, plus system packs when the database has none of its own. */
export function visibleHashtagPacks(
  custom: readonly HashtagPack[],
  remoteSystem: readonly HashtagPack[],
): { custom: HashtagPack[]; system: HashtagPack[] } {
  return {
    custom: [...custom],
    system: remoteSystem.length > 0 ? [...remoteSystem] : [...SYSTEM_HASHTAG_PACKS],
  };
}
