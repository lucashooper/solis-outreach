/** Rank outreach templates by reply rate. Pure: the dashboard feeds it rows. */

export const LOW_SAMPLE_SENT = 10;
export const UNTRACKED_TEMPLATE_ID = 'untracked';
export const UNTRACKED_TEMPLATE_NAME = 'Untracked / custom';

export type TemplateRange = '7d' | '30d' | 'all';

export interface PerformanceTemplate {
  id: string;
  name: string;
}

export interface PerformanceSend {
  id: string;
  templateId: string | null;
  sentAt: string | null;
  creatorId?: string | null;
  /** Blast rows that already recorded a reply. */
  replied?: boolean;
  skipped?: boolean;
}

export interface PerformanceReply {
  id?: string | null;
  creatorId: string | null;
  receivedAt: string | null;
}

export interface PerformanceCreator {
  id: string;
  replied: boolean;
}

export interface TemplatePerformanceRow {
  id: string;
  name: string;
  sent: number;
  replies: number;
  /** Replies / sent, as a percentage from 0 to 100. */
  replyRate: number;
  lowSample: boolean;
}

interface CountedSend {
  templateId: string;
  sentAtMs: number;
  creatorId: string | null;
  replied: boolean;
}

export function templateWindowStart(range: TemplateRange, now: Date): number | null {
  if (range === 'all') return null;
  const days = range === '7d' ? 7 : 30;
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

function sentMillis(value: string | null, start: number | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (start != null && ms < start) return null;
  return ms;
}

function templateKey(id: string | null | undefined): string {
  const trimmed = id?.trim();
  return trimmed ? trimmed : UNTRACKED_TEMPLATE_ID;
}

function ratePercent(replies: number, sent: number): number {
  if (sent <= 0) return 0;
  return Math.round((replies / sent) * 1000) / 10;
}

/**
 * Reply rate is replies / sent for sends in the window.
 * A creator reply attaches to the latest send at or before it.
 * A creator marked replied, with no inbox row, attaches to their latest send.
 * Each send counts at most one reply. Samples under 10 are listed after the rest.
 */
export function rankTemplatePerformance(input: {
  templates: readonly PerformanceTemplate[];
  sends: readonly PerformanceSend[];
  replies?: readonly PerformanceReply[];
  creators?: readonly PerformanceCreator[];
  range: TemplateRange;
  now?: Date;
}): TemplatePerformanceRow[] {
  const start = templateWindowStart(input.range, input.now ?? new Date());
  const names = new Map(input.templates.map((template) => [template.id, template.name.trim() || 'Untitled']));
  const counted: CountedSend[] = [];
  const byCreator = new Map<string, CountedSend[]>();

  for (const send of input.sends) {
    if (send.skipped) continue;
    const sentAtMs = sentMillis(send.sentAt, start);
    if (sentAtMs == null) continue;
    const row: CountedSend = {
      templateId: templateKey(send.templateId),
      sentAtMs,
      creatorId: send.creatorId?.trim() || null,
      replied: send.replied === true,
    };
    counted.push(row);
    if (row.creatorId) {
      const list = byCreator.get(row.creatorId) ?? [];
      list.push(row);
      byCreator.set(row.creatorId, list);
    }
  }

  for (const list of byCreator.values()) {
    list.sort((a, b) => a.sentAtMs - b.sentAtMs);
  }

  for (const reply of input.replies ?? []) {
    const creatorId = reply.creatorId?.trim();
    if (!creatorId) continue;
    const list = byCreator.get(creatorId);
    if (!list?.length) continue;
    const at = reply.receivedAt ? Date.parse(reply.receivedAt) : NaN;
    let chosen = list[list.length - 1]!;
    if (Number.isFinite(at)) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const send = list[i]!;
        if (send.sentAtMs <= at) {
          chosen = send;
          break;
        }
      }
    }
    chosen.replied = true;
  }

  for (const creator of input.creators ?? []) {
    if (!creator.replied) continue;
    const list = byCreator.get(creator.id);
    if (!list?.length || list.some((send) => send.replied)) continue;
    list[list.length - 1]!.replied = true;
  }

  const buckets = new Map<string, { sent: number; replies: number }>();
  for (const send of counted) {
    const bucket = buckets.get(send.templateId) ?? { sent: 0, replies: 0 };
    bucket.sent += 1;
    if (send.replied) bucket.replies += 1;
    buckets.set(send.templateId, bucket);
  }

  const rows: TemplatePerformanceRow[] = [];
  for (const [id, bucket] of buckets) {
    if (bucket.sent <= 0) continue;
    rows.push({
      id,
      name:
        id === UNTRACKED_TEMPLATE_ID
          ? UNTRACKED_TEMPLATE_NAME
          : names.get(id) || 'Deleted template',
      sent: bucket.sent,
      replies: bucket.replies,
      replyRate: ratePercent(bucket.replies, bucket.sent),
      lowSample: bucket.sent < LOW_SAMPLE_SENT,
    });
  }

  const byRate = (a: TemplatePerformanceRow, b: TemplatePerformanceRow) => {
    if (b.replyRate !== a.replyRate) return b.replyRate - a.replyRate;
    if (b.replies !== a.replies) return b.replies - a.replies;
    if (b.sent !== a.sent) return b.sent - a.sent;
    return a.name.localeCompare(b.name, 'en-GB');
  };
  const ranked = rows.filter((row) => !row.lowSample).sort(byRate);
  const low = rows.filter((row) => row.lowSample).sort(byRate);
  return [...ranked, ...low];
}
