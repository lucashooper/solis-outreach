import type { OutreachStatus } from '../types.ts';

/**
 * Display labels for creator rows.
 * pending, pending_review, and queued are all pre-send, so they read as Unsent.
 * Database values stay as they are.
 */
export function statusPillLabel(status: string | null | undefined): string {
  switch (String(status ?? '').trim()) {
    case 'pending':
    case 'pending_review':
    case 'queued':
      return 'Unsent';
    case 'sent':
      return 'Sent';
    case 'replied':
      return 'Replied';
    case 'bounced':
    case 'bounce':
      return 'Bounced';
    case 'archived':
      return 'Archived';
    default: {
      const raw = String(status ?? '').trim();
      if (!raw) return 'Unsent';
      return raw.replace(/_/g, ' ');
    }
  }
}

const CHOICE_ORDER: OutreachStatus[] = [
  'pending',
  'pending_review',
  'queued',
  'sent',
  'replied',
  'archived',
];

/** One menu row per label. Unsent covers the pre-send statuses. */
export function outreachStatusChoices(): Array<{ value: OutreachStatus; label: string }> {
  const seen = new Set<string>();
  const choices: Array<{ value: OutreachStatus; label: string }> = [];
  for (const value of CHOICE_ORDER) {
    const label = statusPillLabel(value);
    if (seen.has(label)) continue;
    seen.add(label);
    choices.push({ value, label });
  }
  return choices;
}

/** Select value that matches a visible choice, without rewriting a stored status. */
export function outreachStatusChoiceValue(status: string | null | undefined): OutreachStatus {
  const label = statusPillLabel(status);
  const match = outreachStatusChoices().find((choice) => choice.label === label);
  return match?.value ?? 'pending';
}
