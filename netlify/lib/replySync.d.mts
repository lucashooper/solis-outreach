/**
 * Types for the plain-JS reply matcher (netlify/lib/replySync.mjs).
 * The outreach mailbox is studioowner@gmail.com.
 */

export function normaliseEmail(input: unknown): string;
export function leadEmailKey(email: unknown): string;
export function isOwnMailbox(email: unknown, ownAddresses?: string[]): boolean;
export function isAutomatedSender(email: unknown): boolean;
export function normaliseSubject(subject: unknown): string;
export function subjectsRelate(replySubject: unknown, campaignSubject: unknown): boolean;
export function missingGmailEnv(env?: Record<string, string | undefined>): string[];
export function gmailNotConfiguredMessage(missing?: string[]): string;

export function inboundFromGmailPayload(raw: {
  id?: string;
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}): { id: string; from: string; subject: string };

export function planManualReplyToggle(
  creator: {
    outreach_status?: string;
    ai_variables?: Record<string, unknown> | null;
  },
  replied: boolean,
): {
  outreach_status: string;
  ai_variables: Record<string, unknown>;
  changed: boolean;
};

export interface ReplySyncPlan {
  creatorUpdates: Array<{
    id: string;
    outreach_status: 'replied';
    ai_variables: Record<string, unknown>;
  }>;
  blastUpdates: Array<{ id: string }>;
  seen: Array<{
    gmail_message_id: string;
    from_email: string;
    subject: string;
    matched_creator_ids: string[];
    matched_blast_ids: string[];
  }>;
  skipped: Array<{ id: string; reason: string }>;
}

export function planReplySync(
  messages: Array<{ id: string; from: string; subject?: string }>,
  input: {
    creators: Array<{
      id: string;
      email?: string | null;
      outreach_status?: string;
      ai_variables?: Record<string, unknown> | null;
      campaign_id?: string | null;
    }>;
    blasts: Array<{
      id: string;
      email?: string | null;
      status?: string;
      replied_at?: string | null;
      campaign_id?: string | null;
    }>;
    campaigns: Array<{ id: string; email_subject?: string | null }>;
    seenIds?: string[];
    ownAddresses?: string[];
  },
): ReplySyncPlan;
