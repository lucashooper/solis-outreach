import type { OutreachStatus } from '../types.ts';

/**
 * Creators who have an email and have not been successfully contacted.
 * pending / pending_review / queued are the pre-send statuses.
 * sent and replied have been contacted. archived was skipped on purpose.
 */
export const UNSENT_STATUSES: readonly OutreachStatus[] = [
  'pending',
  'pending_review',
  'queued',
];

export function hasContactEmail(email: string | null | undefined): boolean {
  return String(email ?? '').trim().includes('@');
}

export function isUnsentCreator(creator: {
  outreach_status?: string | null;
  email?: string | null;
}): boolean {
  if (!hasContactEmail(creator.email)) return false;
  return (UNSENT_STATUSES as readonly string[]).includes(
    String(creator.outreach_status ?? ''),
  );
}

/** Unsent, and not marked do-not-contact. This is who a preset batch may email. */
export function canReceivePresetEmail(creator: {
  outreach_status?: string | null;
  email?: string | null;
  do_not_contact?: boolean | null;
}): boolean {
  return isUnsentCreator(creator) && creator.do_not_contact !== true;
}

export type CrmStatusFilter = '' | 'unsent' | OutreachStatus;

/** Creator list tabs. Replies is a separate view, not one of these filters. */
export const CRM_CREATOR_TABS: ReadonlyArray<{
  key: '' | 'unsent' | 'sent' | 'replied';
  label: string;
}> = [
  { key: '', label: 'All' },
  { key: 'unsent', label: 'Unsent' },
  { key: 'sent', label: 'Sent' },
  { key: 'replied', label: 'Replied' },
];

/** Map retired queue tabs onto Unsent. Unknown values become All. */
export function normaliseCrmStatus(raw: string | null | undefined): CrmStatusFilter {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (
    value === 'unsent' ||
    value === 'pending' ||
    value === 'pending_review' ||
    value === 'queued'
  ) {
    return 'unsent';
  }
  if (value === 'sent' || value === 'replied' || value === 'archived') return value;
  return '';
}
