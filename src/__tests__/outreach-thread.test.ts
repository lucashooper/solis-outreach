import { describe, expect, it } from 'vitest';
import { buildOutreachThread, plainText } from '../outreach/thread.ts';

const log = {
  id: 'l1',
  message_body: 'Hey,\n\nBeen following your content.',
  sequence_step: 1,
  sent_at: '2026-10-06T17:24:00.000Z',
  created_at: '2026-10-06T17:24:00.000Z',
  provider: 'resend',
  provider_message_id: '01a1123e-f625-7cc3-bd53-482a25d495e2',
  outcome: 'sent',
};

describe('buildOutreachThread', () => {
  it('interleaves outbound sends and inbound replies by time', () => {
    const items = buildOutreachThread({
      logs: [
        log,
        {
          ...log,
          id: 'l2',
          sequence_step: 2,
          message_body: 'Just checking in.',
          sent_at: '2026-10-09T17:24:00.000Z',
          created_at: '2026-10-09T17:24:00.000Z',
          provider_message_id: 'follow-up',
        },
      ],
      replies: [
        {
          id: 'r1',
          from_email: 'creator.three@example.com',
          from_name: 'Tatis',
          subject: 'Re: Collab',
          body: 'Sounds good.\n\nOn Tue, Oct 6, 2026 at 1:24 PM <outreach@example.com> wrote:\n\n> Hey,\n>\n> Been following your content.',
          received_at: '2026-10-07T09:00:00.000Z',
          created_at: '2026-10-07T09:01:00.000Z',
        },
      ],
    });

    expect(items.map((item) => item.id)).toEqual(['log:l1', 'reply:r1', 'log:l2']);
    expect(items[0]).toMatchObject({
      label: 'Sent',
      direction: 'sent',
      body: 'Hey,\n\nBeen following your content.',
      meta: null,
    });
    expect(items[0]?.tooltip).toContain('01a1123e-f625-7cc3-bd53-482a25d495e2');
    expect(items[0]?.tooltip).not.toBe(items[0]?.body);
    expect(items[1]).toMatchObject({
      label: 'Received',
      subject: 'Re: Collab',
      body: 'Sounds good.',
      meta: 'Tatis · creator.three@example.com',
    });
    expect(items[2]?.meta).toBe('Follow-up');
  });

  it('treats skipped sends as notes and keeps the reason', () => {
    const items = buildOutreachThread({
      logs: [
        {
          ...log,
          outcome: 'skipped',
          provider: 'skipped',
          sent_at: null,
          message_body: 'Do not contact',
          provider_message_id: null,
        },
      ],
      replies: [],
    });
    expect(items).toEqual([
      expect.objectContaining({
        direction: 'note',
        label: 'Skipped',
        body: 'Do not contact',
        at: log.created_at,
      }),
    ]);
  });

  it('uses a blast reply mark only when no inbox reply was stored', () => {
    const blast = {
      id: 'b1',
      email: 'creator.three@example.com',
      status: 'sent',
      sent_at: '2026-10-05T12:00:00.000Z',
      replied_at: '2026-10-06T12:00:00.000Z',
      subject: 'A note from Solis',
      body: 'Hi there,\n\nA short note.',
      provider_message_id: 'blast-id',
    };

    const withReply = buildOutreachThread({
      logs: [],
      replies: [
        {
          id: 'r1',
          from_email: 'creator.three@example.com',
          subject: 'Re: A note from Solis',
          snippet: 'I am in.',
          received_at: '2026-10-06T12:00:00.000Z',
          created_at: '2026-10-06T12:05:00.000Z',
        },
      ],
      blasts: [blast],
    });
    expect(withReply.map((item) => item.id)).toEqual(['blast:b1', 'reply:r1']);

    const markOnly = buildOutreachThread({ logs: [], replies: [], blasts: [blast] });
    expect(markOnly.map((item) => item.label)).toEqual(['Sent', 'Received']);
    expect(markOnly[1]).toMatchObject({
      id: 'blast-reply:b1',
      subject: 'Re: A note from Solis',
      meta: 'Inbound reply on a blast send',
      body: '',
    });
  });

  it('drops failed blasts and strips HTML from stored copy', () => {
    const items = buildOutreachThread({
      logs: [],
      replies: [],
      blasts: [
        {
          id: 'bad',
          email: 'a@b.com',
          status: 'failed',
          sent_at: '2026-10-01T00:00:00.000Z',
          replied_at: null,
          subject: 'Nope',
          body: 'Nope',
        },
        {
          id: 'ok',
          email: 'a@b.com',
          status: 'opened',
          sent_at: '2026-10-02T00:00:00.000Z',
          replied_at: null,
          subject: 'Hello',
          body: '<p>Hi there,<br>from us.</p>',
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      meta: 'Audience blast · Opened',
      body: 'Hi there,\nfrom us.',
    });
  });
});

describe('plainText', () => {
  it('leaves ordinary email copy and addresses in angle brackets alone', () => {
    expect(plainText('a < b and c > d')).toBe('a < b and c > d');
    expect(plainText('wrote: &lt;outreach@example.com&gt;')).toBe(
      'wrote: <outreach@example.com>',
    );
  });
});
