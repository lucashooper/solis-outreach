import { describe, expect, it } from 'vitest';
import { classifyDiscoveryMatches, creatorMatchKey } from '../discovery/queryCache.js';

describe('classifyDiscoveryMatches', () => {
  const rows = [
    { handle: '@Ada', platform: 'tiktok' },
    { handle: 'bea', platform: 'tiktok' },
    { handle: 'cy', platform: 'instagram' },
  ];

  it('keeps creators inserted during this run even after they are stored', () => {
    const known = new Map([
      [creatorMatchKey('tiktok', 'ada'), 'crm-ada'],
      [creatorMatchKey('tiktok', 'bea'), 'crm-bea'],
    ]);
    const insertedThisRun = new Set([creatorMatchKey('tiktok', 'ada')]);
    const split = classifyDiscoveryMatches(rows, known, insertedThisRun);
    expect(split.fresh.map((row) => row.handle)).toEqual(['@Ada', 'cy']);
    expect(split.existing.map((row) => row.creatorId)).toEqual(['crm-bea']);
  });

  it('labels creators stored before the run as already in the CRM', () => {
    const known = new Map([[creatorMatchKey('tiktok', 'bea'), 'crm-bea']]);
    const split = classifyDiscoveryMatches(rows, known);
    expect(split.fresh.map((row) => row.handle)).toEqual(['@Ada', 'cy']);
    expect(split.existing).toEqual([
      { handle: 'bea', platform: 'tiktok', creatorId: 'crm-bea' },
    ]);
  });
});
