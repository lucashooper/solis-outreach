/** A sent lead with no reply becomes due after 3 or 4 days. */

export type FollowUpDays = 3 | 4;

export function asFollowUpDays(value: unknown): FollowUpDays {
  return Number(value) === 4 ? 4 : 3;
}

export function needsFollowUp(input: {
  status?: string | null;
  replied?: boolean;
  doNotContact?: boolean;
  lastSentAt?: string | null;
  now?: number;
  days?: FollowUpDays;
}): boolean {
  if (input.doNotContact) return false;
  if (input.replied) return false;
  if (String(input.status ?? '') !== 'sent') return false;
  if (!input.lastSentAt) return false;
  const sent = Date.parse(input.lastSentAt);
  if (!Number.isFinite(sent)) return false;
  const days = asFollowUpDays(input.days);
  const ageMs = (input.now ?? Date.now()) - sent;
  return ageMs >= days * 24 * 60 * 60 * 1000;
}

export const DEFAULT_FOLLOW_UP_TEMPLATE = `Hi {{creator_name}},

I sent a note a few days ago about {{app_name}} and did not want it to get buried.

{{custom_hook}}

If a short collaboration is not a fit, no need to reply. If it is, I would love to hear from you.

Cheers,
{{app_name}}`;

export const DEFAULT_FOLLOW_UP_SUBJECT = 'Re: {{app_name}} and {{creator_handle}}';
