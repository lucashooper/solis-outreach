import type { StatusCounts } from './types';
import { leadEmailKey } from '../../../netlify/lib/replySync.mjs';

export interface MetricsCreator {
  outreach_status: string;
  email?: string | null;
  campaign_id?: string | null;
}

export interface MetricsBlast {
  status?: string | null;
  email?: string | null;
  replied_at?: string | null;
}

export interface MetricsLog {
  sent_at?: string | null;
}

export interface ReplyMetricSummary {
  counts: StatusCounts;
  totalSent: number;
  replyRate: number;
  replied: number;
  blastSent: number;
  blastFailed: number;
  blastOpened: number;
}

const STATUS_KEYS = [
  'pending',
  'pending_review',
  'queued',
  'sent',
  'replied',
  'archived',
] as const;

/**
 * Creator funnel plus blast replies.
 * Blast-only repliers (audience emails that are not already a replied creator)
 * are added to REPLIED and TOTAL so the funnel still adds up.
 * Reply rate uses the same contacted base as Total Sent, plus opened blasts.
 */
export function summariseReplyMetrics(input: {
  creators: MetricsCreator[];
  logs?: MetricsLog[];
  blastRows?: MetricsBlast[];
}): ReplyMetricSummary {
  const counts: StatusCounts = {
    pending: 0,
    pending_review: 0,
    queued: 0,
    sent: 0,
    replied: 0,
    archived: 0,
    total: 0,
  };
  const repliedCreatorEmails = new Set<string>();

  for (const creator of input.creators) {
    const status = creator.outreach_status;
    if ((STATUS_KEYS as readonly string[]).includes(status)) {
      counts[status as (typeof STATUS_KEYS)[number]] += 1;
    }
    counts.total += 1;
    if (status === 'replied' && creator.email) {
      const key = leadEmailKey(creator.email);
      if (key) repliedCreatorEmails.add(key);
    }
  }

  const sentStatuses = new Set(['sent', 'replied']);
  const sentCreators = input.creators.filter((c) =>
    sentStatuses.has(String(c.outreach_status)),
  );
  const logsSent = (input.logs ?? []).filter((l) => l.sent_at).length;

  let blastSent = 0;
  let blastFailed = 0;
  let blastOpened = 0;
  const blastOnlyReplyEmails = new Set<string>();

  for (const row of input.blastRows ?? []) {
    const status = String(row.status || '');
    if (status === 'sent') blastSent += 1;
    else if (status === 'failed') blastFailed += 1;
    else if (status === 'opened') blastOpened += 1;
    if (row.replied_at && row.email) {
      const key = leadEmailKey(row.email);
      if (key && !repliedCreatorEmails.has(key)) blastOnlyReplyEmails.add(key);
    }
  }

  const creatorReplied = counts.replied;
  const replied = creatorReplied + blastOnlyReplyEmails.size;
  counts.replied = replied;
  counts.total += blastOnlyReplyEmails.size;

  const creatorContacted = Math.max(sentCreators.length, logsSent);
  const totalSent = creatorContacted + blastSent;
  const contacted = totalSent + blastOpened;
  const replyRate =
    contacted > 0 ? Math.round((replied / contacted) * 1000) / 10 : 0;

  return {
    counts,
    totalSent,
    replyRate,
    replied,
    blastSent,
    blastFailed,
    blastOpened,
  };
}
