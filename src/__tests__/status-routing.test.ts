import { describe, expect, it } from 'vitest';
import {
  campaignCompleteDiscordMessage,
  interestedReplyDiscordMessage,
  resolveOutreachRouting,
  shouldSendOnDiscovery,
} from '../pipeline/statusRouting.js';
import { templateHookFromBio } from '../pipeline/outreach.js';

describe('resolveOutreachRouting', () => {
  it('sets pending_review when auto_outreach is off', () => {
    expect(
      resolveOutreachRouting({ autoOutreach: false, hasEmail: true }),
    ).toBe('pending_review');
    expect(
      resolveOutreachRouting({ autoOutreach: false, hasEmail: false }),
    ).toBe('pending');
  });

  it('queues when auto_outreach on and email present', () => {
    expect(
      resolveOutreachRouting({ autoOutreach: true, hasEmail: true }),
    ).toBe('queued');
  });

  it('keeps pending when auto_outreach on but no email', () => {
    expect(
      resolveOutreachRouting({ autoOutreach: true, hasEmail: false }),
    ).toBe('pending');
  });

  it('sends only when Auto-email is on and a template exists', () => {
    expect(shouldSendOnDiscovery({ autoOutreach: false, hasTemplate: true })).toBe(false);
    expect(shouldSendOnDiscovery({ autoOutreach: true, hasTemplate: false })).toBe(false);
    expect(shouldSendOnDiscovery({ autoOutreach: true, hasTemplate: true })).toBe(true);
  });
});

describe('Discord message helpers', () => {
  it('formats campaign complete for auto-outreach', () => {
    expect(
      campaignCompleteDiscordMessage({
        campaignName: 'Fitness Q3',
        found: 20,
        autoOutreach: true,
        readyOrPendingCount: 12,
      }),
    ).toBe(
      '🎯 Best creators for Fitness Q3 — found 20 (12 ready for auto-outreach).',
    );
  });

  it('formats campaign complete for pending review', () => {
    expect(
      campaignCompleteDiscordMessage({
        campaignName: 'Beauty',
        found: 8,
        autoOutreach: false,
        readyOrPendingCount: 8,
      }),
    ).toBe('🎯 Best creators for Beauty — found 8 (8 pending review).');
  });

  it('formats hot reply with admin URL', () => {
    const msg = interestedReplyDiscordMessage({
      handle: 'fitwithamy',
      platform: 'tiktok',
      snippet: 'Yes keen to chat!',
      adminBaseUrl: 'https://admin.example',
      creatorId: 'abc-123',
    });
    expect(msg).toContain("🔥 Hot Reply from @fitwithamy (tiktok): 'Yes keen to chat!'");
    expect(msg).toContain('https://admin.example/creators/abc-123');
  });
});

describe('templateHookFromBio', () => {
  it('uses the first bio line', () => {
    const hook = templateHookFromBio(
      'HIIT coach · collabs\nSecond line',
      'fitwithamy',
      'StyleKit',
    );
    expect(hook).toContain('HIIT coach');
    expect(hook).toContain('StyleKit');
    expect(hook).not.toContain('Second line');
  });
});
