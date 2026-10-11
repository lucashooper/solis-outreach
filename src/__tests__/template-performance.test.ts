import { describe, expect, it } from 'vitest';
import {
  LOW_SAMPLE_SENT,
  rankTemplatePerformance,
  UNTRACKED_TEMPLATE_ID,
  UNTRACKED_TEMPLATE_NAME,
} from '../metrics/templatePerformance.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY).toISOString();
}

describe('rankTemplatePerformance', () => {
  it('ranks by reply rate and parks small samples after', () => {
    const sends = [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `a-${i}`,
        templateId: 'alpha',
        sentAt: iso(1),
        creatorId: `a-creator-${i}`,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `b-${i}`,
        templateId: 'beta',
        sentAt: iso(2),
        creatorId: `b-creator-${i}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `c-${i}`,
        templateId: 'gamma',
        sentAt: iso(1),
        creatorId: `c-creator-${i}`,
        replied: i === 0,
      })),
    ];
    const rows = rankTemplatePerformance({
      templates: [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
        { id: 'gamma', name: 'Gamma' },
      ],
      sends,
      creators: sends
        .filter((send) => send.templateId === 'alpha')
        .slice(0, 2)
        .map((send) => ({ id: send.creatorId, replied: true }))
        .concat(
          sends
            .filter((send) => send.templateId === 'beta')
            .slice(0, 10)
            .map((send) => ({ id: send.creatorId, replied: true })),
        ),
      range: 'all',
      now: NOW,
    });

    expect(rows.map((row) => row.name)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(rows[0]).toMatchObject({ sent: 20, replies: 10, replyRate: 50, lowSample: false });
    expect(rows[1]).toMatchObject({ sent: 10, replies: 2, replyRate: 20, lowSample: false });
    expect(rows[2]).toMatchObject({
      sent: 4,
      replies: 1,
      replyRate: 25,
      lowSample: true,
    });
    expect(LOW_SAMPLE_SENT).toBe(10);
  });

  it('attributes a reply to the send before it and ignores a second reply', () => {
    const rows = rankTemplatePerformance({
      templates: [
        { id: 'first', name: 'First' },
        { id: 'second', name: 'Second' },
      ],
      sends: [
        { id: '1', templateId: 'first', sentAt: iso(5), creatorId: 'creator' },
        { id: '2', templateId: 'second', sentAt: iso(1), creatorId: 'creator' },
      ],
      replies: [
        { id: 'r1', creatorId: 'creator', receivedAt: iso(4) },
        { id: 'r2', creatorId: 'creator', receivedAt: iso(3) },
      ],
      creators: [{ id: 'creator', replied: true }],
      range: 'all',
      now: NOW,
    });
    expect(rows.find((row) => row.id === 'first')).toMatchObject({ sent: 1, replies: 1 });
    expect(rows.find((row) => row.id === 'second')).toMatchObject({ sent: 1, replies: 0 });
  });

  it('groups sends with no template as Untracked / custom and honours the window', () => {
    const rows = rankTemplatePerformance({
      templates: [{ id: 'alpha', name: 'Alpha' }],
      sends: [
        { id: 'old', templateId: null, sentAt: iso(40), creatorId: 'old', replied: true },
        { id: 'new', templateId: null, sentAt: iso(2), creatorId: 'new' },
        { id: 'skip', templateId: 'alpha', sentAt: iso(1), creatorId: 'skip', skipped: true },
        {
          id: 'blast',
          templateId: 'alpha',
          sentAt: iso(3),
          replied: true,
        },
      ],
      range: '30d',
      now: NOW,
    });
    expect(rows.map((row) => row.id)).toEqual(['alpha', UNTRACKED_TEMPLATE_ID]);
    expect(rows[0]).toMatchObject({ name: 'Alpha', sent: 1, replies: 1, replyRate: 100 });
    expect(rows[1]).toMatchObject({
      name: UNTRACKED_TEMPLATE_NAME,
      sent: 1,
      replies: 0,
      lowSample: true,
    });
  });
});
