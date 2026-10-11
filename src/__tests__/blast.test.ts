import { describe, expect, it } from 'vitest';
import {
  applyBlastTemplate,
  BLAST_FROM,
  BLAST_REPLY_TO,
  parseAudienceMembersInput,
  sendBlastEmail,
} from '../pipeline/blast.js';
import { resolveBlastFrom, resolveBlastReplyTo } from '../pipeline/blastFrom.js';
import { buildColdEmailPayload } from '../cold-email.js';

describe('applyBlastTemplate', () => {
  it('replaces display_name and falls back to there', () => {
    expect(
      applyBlastTemplate('Hi {{display_name}} from {{app_name}}', {
        app_name: 'Solis',
      }),
    ).toBe('Hi there from Solis');
    expect(
      applyBlastTemplate('Hi {{display_name}}', { display_name: 'Alex' }),
    ).toBe('Hi Alex');
  });

  it('leaves hook blank when unused and clears unused creator_handle', () => {
    expect(
      applyBlastTemplate('{{hook}}|{{creator_handle}}|{{app_name}}', {
        app_name: 'Solis',
      }),
    ).toBe('||Solis');
  });
});

describe('parseAudienceMembersInput', () => {
  it('parses emails array and members objects', () => {
    const rows = parseAudienceMembersInput({
      emails: ['a@x.com', 'Name <b@y.com>'],
      members: [{ email: 'c@z.com', display_name: 'Cee' }],
    });
    expect(rows.map((r) => r.email).sort()).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
    ]);
    expect(rows.find((r) => r.email === 'c@z.com')?.display_name).toBe('Cee');
    expect(rows.find((r) => r.email === 'b@y.com')?.display_name).toBe('Name');
  });

  it('parses newline paste via text', () => {
    const rows = parseAudienceMembersInput({
      text: 'one@ex.com\ntwo@ex.com, Two',
    });
    expect(rows).toHaveLength(2);
  });
});

describe('blast Resend headers', () => {
  it('exposes Alex from + reply-to constants', () => {
    expect(BLAST_FROM).toContain('Alex from Example');
    expect(BLAST_FROM).toContain('outreach@example.com');
    expect(BLAST_REPLY_TO).toBe('studioowner@gmail.com');
  });

  it('buildColdEmailPayload sets reply_to for Resend', () => {
    const payload = buildColdEmailPayload({
      provider: 'resend',
      to: 'a@x.com',
      from: BLAST_FROM,
      replyTo: BLAST_REPLY_TO,
      subject: 'Hi',
      htmlOrText: 'Body',
      creatorId: 'c1',
      sequenceStep: 1,
    });
    expect(payload.from).toBe(BLAST_FROM);
    expect(payload.reply_to).toBe(BLAST_REPLY_TO);
  });

  it('keeps the original blast display for that from-address and uses any other', () => {
    expect(resolveBlastFrom({ RESEND_FROM_EMAIL: 'outreach@example.com' })).toBe(BLAST_FROM);
    expect(resolveBlastFrom({ RESEND_FROM_EMAIL: 'Ada <ada@example.com>' })).toBe(
      'Ada <ada@example.com>',
    );
    expect(
      resolveBlastFrom({ RESEND_FROM_EMAIL: 'ada@example.com', RESEND_FROM_NAME: 'Ada' }),
    ).toBe('Ada <ada@example.com>');
    expect(resolveBlastReplyTo({ RESEND_REPLY_TO: 'ada@example.com' })).toBe('ada@example.com');
    expect(resolveBlastReplyTo({})).toBe(BLAST_REPLY_TO);
  });

  it('sendBlastEmail dry-run still ok without API key', async () => {
    const prev = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const result = await sendBlastEmail({
      to: 'a@x.com',
      subject: 'Hi',
      body: 'Hello',
      campaignId: 'camp',
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    if (prev !== undefined) process.env.RESEND_API_KEY = prev;
  });
});
