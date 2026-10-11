import type { OutreachStatus } from '../types.js';

/**
 * Decide initial outreach_status after discovery upsert.
 *
 * - no email → pending (shown in the list, never pitched)
 * - auto_outreach off + email → pending_review
 * - auto_outreach on + email → queued (then personalise + send)
 */
export function resolveOutreachRouting(input: {
  autoOutreach: boolean;
  hasEmail: boolean;
}): OutreachStatus {
  if (!input.hasEmail) return 'pending';
  if (!input.autoOutreach) return 'pending_review';
  return 'queued';
}

/** Discovery sends only when Auto-email is on and the campaign has a template. */
export function shouldSendOnDiscovery(input: {
  autoOutreach: boolean;
  hasTemplate: boolean;
}): boolean {
  return input.autoOutreach === true && input.hasTemplate === true;
}

export function campaignCompleteDiscordMessage(input: {
  campaignName: string;
  found: number;
  autoOutreach: boolean;
  readyOrPendingCount: number;
}): string {
  const { campaignName, found, autoOutreach, readyOrPendingCount } = input;
  if (autoOutreach) {
    return `🎯 Best creators for ${campaignName} — found ${found} (${readyOrPendingCount} ready for auto-outreach).`;
  }
  return `🎯 Best creators for ${campaignName} — found ${found} (${readyOrPendingCount} pending review).`;
}

export function interestedReplyDiscordMessage(input: {
  handle: string;
  platform: string;
  snippet: string;
  adminBaseUrl?: string;
  creatorId?: string;
}): string {
  const base =
    (input.adminBaseUrl ?? process.env.ADMIN_BASE_URL ?? 'http://localhost:5173').replace(
      /\/$/,
      '',
    );
  const path = input.creatorId
    ? `${base}/creators/${input.creatorId}`
    : `${base}/creators`;
  const handle = input.handle.replace(/^@/, '');
  const snippet = input.snippet.replace(/\s+/g, ' ').trim().slice(0, 180);
  return `🔥 Hot Reply from @${handle} (${input.platform}): '${snippet}' → View in Admin ${path}`;
}
