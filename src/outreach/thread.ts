/**
 * Chronological creator conversation built from data the admin already stores:
 * outreach logs, Gmail reply rows, and blast send / reply marks.
 */

export interface ThreadLogInput {
  id: string;
  message_body: string | null;
  sequence_step: number;
  sent_at: string | null;
  created_at: string;
  provider: string | null;
  provider_message_id: string | null;
  outcome?: string | null;
}

export interface ThreadReplyInput {
  id: string;
  from_email: string;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  body_text?: string | null;
  received_at?: string | null;
  created_at: string;
}

export interface ThreadBlastInput {
  id: string;
  email: string;
  status: string;
  sent_at: string | null;
  replied_at: string | null;
  provider_message_id?: string | null;
  subject?: string | null;
  body?: string | null;
}

export type ThreadDirection = 'sent' | 'received' | 'note';

export interface ThreadItem {
  id: string;
  direction: ThreadDirection;
  at: string | null;
  subject: string | null;
  body: string;
  label: 'Sent' | 'Received' | 'Skipped';
  /** Short human context, such as "Follow-up" or the sender address. */
  meta: string | null;
  /** Provider ids and step numbers. Shown as a tooltip, not in the card body. */
  tooltip: string | null;
}

const HTML_TAG =
  /<\/?(?:p|div|br|span|a|b|i|em|strong|ul|ol|li|table|tr|td|th|h[1-6]|blockquote|html|body|head|img|font|center|style|script)\b[^>]*>/gi;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function plainText(value: string): string {
  const text = decodeEntities(value.replace(/\r\n/g, '\n'));
  HTML_TAG.lastIndex = 0;
  if (!HTML_TAG.test(text)) return text.trim();
  HTML_TAG.lastIndex = 0;
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(HTML_TAG, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drop the quoted original so a reply does not repeat the outbound email. */
export function stripQuotedReply(value: string): string {
  const text = plainText(value);
  const lines = text.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? '';
    if (
      /^On .+ wrote:\s*$/i.test(trimmed) ||
      /^>+/.test(trimmed) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)
    ) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return text.trim();
  let start = cut;
  let previous = start - 1;
  while (previous >= 0 && (lines[previous]?.trim() ?? '') === '') previous -= 1;
  const prev = previous >= 0 ? (lines[previous]?.trim() ?? '') : '';
  if (/^On .+/i.test(prev) || /^wrote:\s*$/i.test(prev)) start = previous;
  const kept = lines
    .slice(0, start)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return kept || text.trim();
}

function replyText(reply: ThreadReplyInput): string {
  for (const value of [reply.body, reply.body_text, reply.snippet]) {
    const text = plainText(value ?? '');
    if (text) return text;
  }
  return '';
}

function stepMeta(step: number): string | null {
  if (step === 2) return 'Follow-up';
  if (step === 3) return 'Second follow-up';
  if (step > 3) return `Step ${step}`;
  return null;
}

function logTooltip(log: ThreadLogInput): string {
  const parts = [`Step ${log.sequence_step}`];
  if (log.provider) parts.push(log.provider);
  if (log.provider_message_id) parts.push(log.provider_message_id);
  return parts.join(' · ');
}

function fromLog(log: ThreadLogInput): ThreadItem {
  const skipped = log.outcome === 'skipped' || log.provider === 'skipped';
  const body = plainText(log.message_body ?? '');
  return {
    id: `log:${log.id}`,
    direction: skipped ? 'note' : 'sent',
    at: log.sent_at || log.created_at,
    subject: null,
    body,
    label: skipped ? 'Skipped' : 'Sent',
    meta: stepMeta(log.sequence_step),
    tooltip: logTooltip(log),
  };
}

function senderLine(reply: ThreadReplyInput): string {
  const name = reply.from_name?.trim() ?? '';
  const email = reply.from_email.trim();
  if (name && name.toLowerCase() !== email.toLowerCase()) return `${name} · ${email}`;
  return email;
}

function fromReply(reply: ThreadReplyInput): ThreadItem {
  const subject = reply.subject?.trim() || null;
  return {
    id: `reply:${reply.id}`,
    direction: 'received',
    at: reply.received_at || reply.created_at,
    subject,
    body: stripQuotedReply(replyText(reply)),
    label: 'Received',
    meta: senderLine(reply),
    tooltip: null,
  };
}

function fromBlastSend(blast: ThreadBlastInput): ThreadItem | null {
  const status = blast.status.toLowerCase();
  if (status !== 'sent' && status !== 'opened') return null;
  if (!blast.sent_at) return null;
  const subject = plainText(blast.subject ?? '') || null;
  const body = plainText(blast.body ?? '');
  return {
    id: `blast:${blast.id}`,
    direction: 'sent',
    at: blast.sent_at,
    subject,
    body,
    label: 'Sent',
    meta: status === 'opened' ? 'Audience blast · Opened' : 'Audience blast',
    tooltip: blast.provider_message_id?.trim() || null,
  };
}

function fromBlastReply(blast: ThreadBlastInput): ThreadItem | null {
  if (!blast.replied_at) return null;
  const subject = plainText(blast.subject ?? '');
  return {
    id: `blast-reply:${blast.id}`,
    direction: 'received',
    at: blast.replied_at,
    subject: subject ? `Re: ${subject}` : null,
    body: '',
    label: 'Received',
    meta: 'Inbound reply on a blast send',
    tooltip: null,
  };
}

function timeValue(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

export function buildOutreachThread(input: {
  logs: ThreadLogInput[];
  replies: ThreadReplyInput[];
  blasts?: ThreadBlastInput[];
}): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const log of input.logs) items.push(fromLog(log));
  for (const reply of input.replies) items.push(fromReply(reply));

  const inboxCoversBlastReplies = input.replies.length > 0;
  for (const blast of input.blasts ?? []) {
    const sent = fromBlastSend(blast);
    if (sent) items.push(sent);
    if (!inboxCoversBlastReplies) {
      const received = fromBlastReply(blast);
      if (received) items.push(received);
    }
  }

  items.sort((a, b) => timeValue(a.at) - timeValue(b.at) || a.id.localeCompare(b.id));
  return items;
}
