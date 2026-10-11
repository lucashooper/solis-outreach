import { describe, expect, it } from 'vitest';
import { summariseReplyMetrics } from '../../admin/src/lib/replyMetrics.ts';
import {
  decodeGmailBody,
  formatGmailApiError,
  gmailNotConfiguredMessage,
  inboundFromGmailPayload,
  isAutomatedSender,
  isOwnMailbox,
  leadEmailKey,
  missingGmailEnv,
  normaliseEmail,
  planManualReplyToggle,
  planReplySync,
} from '../../netlify/lib/replySync.mjs';

const ASTRA = 'Quick question about Astra (free PRO pass inside)';

const creators = [
  {
    id: 'c-jasper',
    email: 'creator.two@gmail.com',
    outreach_status: 'sent',
    ai_variables: { hook: 'keep' },
    campaign_id: 'camp-astra',
  },
  {
    id: 'c-other',
    email: 'someoneelse@example.com',
    outreach_status: 'sent',
    ai_variables: {},
    campaign_id: 'camp-other',
  },
];

const blasts = [
  {
    id: 'b-orwell',
    email: 'reader.one@gmail.com',
    status: 'sent',
    replied_at: null,
    campaign_id: 'camp-astra',
  },
  {
    id: 'b-orwell-other',
    email: 'reader.one@gmail.com',
    status: 'sent',
    replied_at: null,
    campaign_id: 'camp-other',
  },
  {
    id: 'b-failed',
    email: 'failed-person@example.com',
    status: 'failed',
    replied_at: null,
    campaign_id: 'camp-astra',
  },
];

const campaigns = [
  { id: 'camp-astra', email_subject: ASTRA },
  { id: 'camp-other', email_subject: 'A note from Solis' },
];

function inbox() {
  return [
    {
      id: 'm-jasper',
      from: 'Jasper <creator.two@gmail.com>',
      subject: `Re: ${ASTRA}`,
    },
    {
      id: 'm-orwell',
      from: 'Orwell Max <reader.one@gmail.com>',
      subject: `Re: ${ASTRA}`,
    },
    {
      id: 'm-google',
      from: 'Google <no-reply@accounts.google.com>',
      subject: 'Security alert',
    },
    {
      id: 'm-stranger',
      from: 'Stranger <nobody@example.com>',
      subject: `Re: ${ASTRA}`,
    },
    {
      id: 'm-self',
      from: 'Alex <studio.owner@gmail.com>',
      subject: `Re: ${ASTRA}`,
    },
  ];
}

describe('mailbox address', () => {
  it('treats the dotted Gmail address as our own reply-to mailbox', () => {
    expect(isOwnMailbox('studio.owner@gmail.com')).toBe(true);
    expect(isOwnMailbox('Solis Labs Studio <studioowner@gmail.com>')).toBe(true);
    expect(isOwnMailbox('outreach@example.com')).toBe(true);
    expect(isOwnMailbox('creator.two@gmail.com')).toBe(false);
  });

  it('collapses gmail plus-tags but keeps dots for lead matching', () => {
    expect(leadEmailKey('reader.one+new@gmail.com')).toBe('reader.one@gmail.com');
    expect(leadEmailKey('Reader.One@gmail.com')).toBe('reader.one@gmail.com');
    expect(leadEmailKey('creator.dots@gmail.com')).not.toBe('creatortwo@gmail.com');
  });

  it('ignores Google security mail and no-reply senders', () => {
    expect(isAutomatedSender('no-reply@accounts.google.com')).toBe(true);
    expect(isAutomatedSender('mailer-daemon@example.com')).toBe(true);
    expect(isAutomatedSender('creator.two@gmail.com')).toBe(false);
    expect(normaliseEmail('Jasper <creator.two@gmail.com>')).toBe(
      'creator.two@gmail.com',
    );
  });
});

describe('planReplySync', () => {
  it('marks the matching creator and the subject-matching blast only', () => {
    const plan = planReplySync(inbox(), {
      creators,
      blasts,
      campaigns,
      seenIds: [],
    });

    expect(plan.creatorUpdates.map((u) => u.id)).toEqual(['c-jasper']);
    expect(plan.creatorUpdates[0].outreach_status).toBe('replied');
    expect(plan.creatorUpdates[0].ai_variables.hook).toBe('keep');
    expect(plan.creatorUpdates[0].ai_variables.status_before_reply).toBe('sent');
    expect(plan.blastUpdates.map((u) => u.id)).toEqual(['b-orwell']);
    expect(plan.creatorUpdates.some((u) => u.id === 'c-other')).toBe(false);
    expect(plan.blastUpdates.some((u) => u.id === 'b-failed')).toBe(false);
    expect(plan.skipped.find((s) => s.id === 'm-stranger')?.reason).toBe(
      'no_matching_lead',
    );
    expect(plan.skipped.find((s) => s.id === 'm-google')?.reason).toBe('automated');
    expect(plan.skipped.find((s) => s.id === 'm-self')?.reason).toBe('own_mailbox');
  });

  it('matches a gmail plus-alias to the stored lead', () => {
    const plan = planReplySync(
      [
        {
          id: 'm-plus',
          from: 'reader.one+new@gmail.com',
          subject: 'hello',
        },
      ],
      { creators: [], blasts, campaigns, seenIds: [] },
    );
    expect(plan.blastUpdates.map((u) => u.id).sort()).toEqual([
      'b-orwell',
      'b-orwell-other',
    ]);
  });

  it('is idempotent: a second run with seen ids does not mark again', () => {
    const first = planReplySync(inbox(), {
      creators,
      blasts,
      campaigns,
      seenIds: [],
    });
    const repliedCreator = {
      ...creators[0],
      outreach_status: 'replied',
      ai_variables: first.creatorUpdates[0].ai_variables,
    };
    const second = planReplySync(inbox(), {
      creators: [repliedCreator, creators[1]],
      blasts: blasts.map((b) =>
        first.blastUpdates.some((u) => u.id === b.id)
          ? { ...b, replied_at: '2026-09-30T10:00:00.000Z' }
          : b,
      ),
      campaigns,
      seenIds: first.seen.map((s) => s.gmail_message_id),
    });
    expect(second.creatorUpdates).toEqual([]);
    expect(second.blastUpdates).toEqual([]);
    expect(second.seen).toEqual([]);
    expect(second.skipped.every((s) => s.reason === 'already_seen')).toBe(true);
  });

  it('does not invent a reply when nobody matches', () => {
    const plan = planReplySync(
      [{ id: 'm-x', from: 'new@example.com', subject: `Re: ${ASTRA}` }],
      { creators, blasts, campaigns, seenIds: [] },
    );
    expect(plan.creatorUpdates).toEqual([]);
    expect(plan.blastUpdates).toEqual([]);
  });
});

describe('planManualReplyToggle', () => {
  it('marks replied and restores the previous status', () => {
    const marked = planManualReplyToggle(
      { outreach_status: 'sent', ai_variables: { hook: 'keep' } },
      true,
    );
    expect(marked.outreach_status).toBe('replied');
    expect(marked.ai_variables.status_before_reply).toBe('sent');
    expect(marked.ai_variables.hook).toBe('keep');
    expect(marked.changed).toBe(true);

    const cleared = planManualReplyToggle(
      { outreach_status: 'replied', ai_variables: marked.ai_variables },
      false,
    );
    expect(cleared.outreach_status).toBe('sent');
    expect(cleared.ai_variables.status_before_reply).toBeUndefined();
    expect(cleared.ai_variables.hook).toBe('keep');
  });

  it('marking twice does not change a lead that is already replied', () => {
    const once = planManualReplyToggle(
      { outreach_status: 'pending_review', ai_variables: {} },
      true,
    );
    const twice = planManualReplyToggle(
      { outreach_status: 'replied', ai_variables: once.ai_variables },
      true,
    );
    expect(twice.changed).toBe(false);
    expect(twice.ai_variables.status_before_reply).toBe('pending_review');
  });
});

describe('summariseReplyMetrics', () => {
  it('stays at zero replies when nobody has replied', () => {
    const summary = summariseReplyMetrics({
      creators: [
        { outreach_status: 'pending', email: 'a@demo.test' },
        { outreach_status: 'sent', email: 'b@demo.test' },
      ],
      logs: [],
      blastRows: [{ status: 'sent', email: 'reader.one@gmail.com', replied_at: null }],
    });
    expect(summary.replied).toBe(0);
    expect(summary.replyRate).toBe(0);
    expect(summary.counts.replied).toBe(0);
    expect(summary.counts.total).toBe(2);
  });

  it('counts a creator reply once and a distinct blast reply once', () => {
    const summary = summariseReplyMetrics({
      creators: [
        { outreach_status: 'replied', email: 'creator.two@gmail.com' },
        { outreach_status: 'sent', email: 'b@demo.test' },
      ],
      logs: [{ sent_at: '2026-09-01' }, { sent_at: '2026-09-02' }],
      blastRows: [
        { status: 'sent', email: 'creator.two@gmail.com', replied_at: '2026-09-30' },
        { status: 'sent', email: 'reader.one@gmail.com', replied_at: '2026-09-30' },
        { status: 'sent', email: 'reader.one@gmail.com', replied_at: '2026-09-30' },
        { status: 'sent', email: 'quiet@example.com', replied_at: null },
      ],
    });
    expect(summary.replied).toBe(2);
    expect(summary.counts.replied).toBe(2);
    expect(summary.counts.total).toBe(3);
    expect(summary.blastSent).toBe(4);
    expect(summary.replyRate).toBeGreaterThan(0);

    const again = summariseReplyMetrics({
      creators: [
        { outreach_status: 'replied', email: 'creator.two@gmail.com' },
        { outreach_status: 'sent', email: 'b@demo.test' },
      ],
      logs: [{ sent_at: '2026-09-01' }, { sent_at: '2026-09-02' }],
      blastRows: [
        { status: 'sent', email: 'creator.two@gmail.com', replied_at: '2026-09-30' },
        { status: 'sent', email: 'reader.one@gmail.com', replied_at: '2026-09-30' },
        { status: 'sent', email: 'reader.one@gmail.com', replied_at: '2026-09-30' },
        { status: 'sent', email: 'quiet@example.com', replied_at: null },
      ],
    });
    expect(again.replied).toBe(summary.replied);
    expect(again.replyRate).toBe(summary.replyRate);
  });
});

describe('gmail configuration', () => {
  it('names the missing variables and does not pretend success', () => {
    expect(missingGmailEnv({})).toEqual([
      'GMAIL_CLIENT_ID',
      'GMAIL_CLIENT_SECRET',
      'GMAIL_REFRESH_TOKEN',
    ]);
    expect(missingGmailEnv({ GMAIL_CLIENT_ID: 'x' })).toEqual([
      'GMAIL_CLIENT_SECRET',
      'GMAIL_REFRESH_TOKEN',
    ]);
    const message = gmailNotConfiguredMessage(missingGmailEnv({}));
    expect(message).toContain('not configured');
    expect(message).toContain('Manual mark-as-replied still works');
  });

  it('reads From and Subject from a Gmail metadata payload', () => {
    const parsed = inboundFromGmailPayload({
      id: 'abc',
      payload: {
        headers: [
          { name: 'From', value: 'Jasper <creator.two@gmail.com>' },
          { name: 'Subject', value: `Re: ${ASTRA}` },
        ],
      },
    });
    expect(parsed).toEqual({
      id: 'abc',
      threadId: '',
      from: 'Jasper <creator.two@gmail.com>',
      subject: `Re: ${ASTRA}`,
      inReplyTo: '',
      references: '',
      snippet: '',
      body: '',
      receivedAt: null,
    });
  });

  it('keeps the Google error text and names the enable page when the API is off', () => {
    const message = formatGmailApiError(403, {
      error: {
        status: 'PERMISSION_DENIED',
        message: 'Gmail API has not been used in project 465091512038 before or it is disabled.',
        details: [{ reason: 'SERVICE_DISABLED' }],
      },
    });
    expect(message).toContain(
      'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=465091512038',
    );
    expect(message).toContain('Google said:');
    expect(message).toContain('Gmail API has not been used');

    const scopes = formatGmailApiError(403, {
      error: {
        status: 'PERMISSION_DENIED',
        message: 'Request had insufficient authentication scopes.',
      },
    });
    expect(scopes).toContain('PERMISSION_DENIED');
    expect(scopes).toContain('insufficient authentication scopes');
  });

  it('decodes text/plain and falls back to stripped html', () => {
    const plain = Buffer.from('hello there').toString('base64url');
    const html = Buffer.from('<p>Hi&nbsp;there<br>friend</p>').toString('base64url');
    expect(
      decodeGmailBody({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: plain } },
          { mimeType: 'text/html', body: { data: html } },
        ],
      }),
    ).toBe('hello there');
    expect(
      decodeGmailBody({
        mimeType: 'text/html',
        body: { data: html },
      }),
    ).toContain('Hi there');
  });
});

describe('thread matching', () => {
  it('matches a blast from In-Reply-To when From is a different address', () => {
    const plan = planReplySync(
      [
        {
          id: 'm-thread-blast',
          from: 'Someone Else <different@example.com>',
          subject: 'hello',
          inReplyTo: '<resend-abc12345@example.com>',
        },
      ],
      {
        creators: [],
        blasts,
        campaigns,
        seenIds: [],
        outbound: [{ provider_message_id: 'resend-abc12345', blast_id: 'b-orwell' }],
      },
    );
    expect(plan.blastUpdates.map((u) => u.id)).toEqual(['b-orwell']);
  });

  it('matches a creator from In-Reply-To when From is a different address', () => {
    const plan = planReplySync(
      [
        {
          id: 'm-thread-creator',
          from: 'Other <different@example.com>',
          subject: 'thanks',
          inReplyTo: '<provider-msg-99@mail.example>',
        },
      ],
      {
        creators,
        blasts: [],
        campaigns,
        seenIds: [],
        outbound: [{ provider_message_id: 'provider-msg-99', creator_id: 'c-jasper' }],
      },
    );
    expect(plan.creatorUpdates.map((u) => u.id)).toEqual(['c-jasper']);
  });

  it('skips mail from outreach@ and still marks the creator reply in the same batch', () => {
    const plan = planReplySync(
      [
        {
          id: 'm-sent-copy',
          from: 'Solis <outreach@example.com>',
          subject: `Re: ${ASTRA}`,
        },
        {
          id: 'm-creator-reply',
          from: 'Orwell <reader.one@gmail.com>',
          subject: `Re: ${ASTRA}`,
        },
      ],
      { creators, blasts, campaigns, seenIds: [] },
    );
    expect(plan.skipped.find((s) => s.id === 'm-sent-copy')?.reason).toBe('own_mailbox');
    expect(plan.blastUpdates.map((u) => u.id)).toEqual(['b-orwell']);
    expect(plan.skipped.find((s) => s.id === 'm-creator-reply')?.reason).toBe('matched');
  });
});
