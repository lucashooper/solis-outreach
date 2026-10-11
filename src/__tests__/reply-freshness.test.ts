import { describe, expect, it } from 'vitest';
import { REPLY_SYNC_STALE_MS, replySyncIsStale } from '../outreach/replyFreshness.ts';

describe('replySyncIsStale', () => {
  const now = Date.parse('2026-10-07T08:00:00.000Z');

  it('treats a missing stamp as stale', () => {
    expect(replySyncIsStale(null, now)).toBe(true);
    expect(replySyncIsStale('', now)).toBe(true);
    expect(replySyncIsStale('not-a-date', now)).toBe(true);
  });

  it('stays fresh inside the five-minute window', () => {
    const recent = new Date(now - REPLY_SYNC_STALE_MS + 1000).toISOString();
    expect(replySyncIsStale(recent, now)).toBe(false);
  });

  it('is stale once the server stamp is older than five minutes', () => {
    const old = new Date(now - REPLY_SYNC_STALE_MS - 1).toISOString();
    expect(replySyncIsStale(old, now)).toBe(true);
  });

  it('honours a recent browser attempt when the server stamp is old', () => {
    const old = new Date(now - 60 * 60 * 1000).toISOString();
    expect(replySyncIsStale(old, now, now - 1000)).toBe(false);
  });
});
