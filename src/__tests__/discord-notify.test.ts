import { describe, expect, it } from 'vitest';
import {
  creatorsFoundPayload,
  discordFlag,
  emailsSentPayload,
  isDiscordWebhook,
  maskWebhookUrl,
  replyDiscordPayload,
  replySnippet,
} from '../pipeline/discordNotify.js';

describe('discord settings helpers', () => {
  it('reads event flags and falls back when unset', () => {
    expect(discordFlag(undefined, true)).toBe(true);
    expect(discordFlag('false', true)).toBe(false);
    expect(discordFlag('1', false)).toBe(true);
  });

  it('accepts a Discord webhook and hides the token', () => {
    const url = ['https://discord.com', '/api/', 'webhooks', '/1234567890/secret-token'].join('');
    expect(isDiscordWebhook(url)).toBe(true);
    expect(isDiscordWebhook('https://example.com/api/webhooks/123/token')).toBe(false);
    const masked = maskWebhookUrl(url);
    expect(masked).toContain('discord.com');
    expect(masked).not.toContain('secret-token');
  });
});

describe('discord embeds', () => {
  it('builds a reply embed with a CRM deep link and a short snippet', () => {
    const payload = replyDiscordPayload({
      handle: '@fitwithamy',
      platform: 'tiktok',
      campaignName: 'BookTok',
      snippet: replySnippet(['Yes, happy to chat about this next week and share a draft.']),
      receivedAt: '2026-10-06T12:00:00.000Z',
      creatorId: 'abc-123',
      adminBaseUrl: 'https://admin.example.com',
    });
    const embed = payload.embeds?.[0];
    expect(embed?.title).toBe('Reply from @fitwithamy');
    expect(embed?.url).toBe('https://admin.example.com/crm?creator=abc-123');
    expect(embed?.description).toContain('happy to chat');
    expect(embed?.fields?.find((field) => field.name === 'Platform')?.value).toBe('TikTok');
    expect(embed?.fields?.find((field) => field.name === 'Campaign')?.value).toBe('BookTok');
  });

  it('cuts a long reply to about 200 characters', () => {
    const snippet = replySnippet(['a'.repeat(240)]);
    expect(snippet.length).toBeLessThanOrEqual(200);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('builds tidy discovery and send embeds', () => {
    const found = creatorsFoundPayload({
      campaignName: 'Journaling',
      found: 4,
      autoOutreach: false,
      readyOrPendingCount: 4,
    });
    expect(found.embeds?.[0]?.title).toBe('Creators found');
    expect(found.embeds?.[0]?.fields?.map((field) => field.name)).toEqual([
      'Found',
      'Pending review',
    ]);

    const sent = emailsSentPayload({ campaignName: 'Journaling', sent: 2 });
    expect(sent.embeds?.[0]?.title).toBe('Emails sent');
    expect(sent.embeds?.[0]?.fields?.[0]?.value).toBe('2');
  });
});
