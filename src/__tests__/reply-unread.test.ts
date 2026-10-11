import { describe, expect, it } from 'vitest';
import { blastUnreadId, summariseUnread } from '../outreach/replyUnread.ts';

describe('summariseUnread', () => {
  const replies = [
    { id: 'r1', creator_id: 'c1', from_email: 'ada@example.com' },
    { id: 'r2', creator_id: 'c1', from_email: 'ada@example.com' },
    { id: 'r3', creator_id: null, from_email: 'no-lead@example.com' },
  ];

  it('counts a creator once on the sidebar and once on Replied, and each message on Replies', () => {
    const summary = summariseUnread(replies, [], new Set());
    expect(summary.total).toBe(2);
    expect(summary.repliedTab).toBe(1);
    expect(summary.repliesTab).toBe(3);
    expect(summary.unseenCreatorIds).toEqual(['c1']);
    expect(summary.unseenReplyIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('drops replies the operator has already opened', () => {
    const summary = summariseUnread(replies, [], new Set(['r1', 'r2']));
    expect(summary.repliesTab).toBe(1);
    expect(summary.repliedTab).toBe(0);
    expect(summary.total).toBe(1);
    expect(summary.unseenCreatorIds).toEqual([]);
  });

  it('counts a blast reply once, and not again when the inbox already has that address', () => {
    const blasts = [{ email: 'Ada@example.com' }, { email: 'blast-only@example.com' }, { email: '' }];
    const summary = summariseUnread(replies, blasts, new Set());
    expect(summary.unseenBlastIds).toEqual([blastUnreadId('blast-only@example.com')]);
    expect(summary.repliedTab).toBe(2);
    expect(summary.total).toBe(3);
    expect(summary.repliesTab).toBe(3);
  });

  it('ignores a blast reply after that row has been opened', () => {
    const summary = summariseUnread(
      [],
      [{ email: 'blast-only@example.com' }],
      new Set([blastUnreadId('blast-only@example.com')]),
    );
    expect(summary.total).toBe(0);
    expect(summary.repliedTab).toBe(0);
    expect(summary.unseenBlastIds).toEqual([]);
  });
});
