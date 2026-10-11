import { describe, expect, it } from 'vitest';
import {
  CRM_CREATOR_TABS,
  canReceivePresetEmail,
  isUnsentCreator,
  normaliseCrmStatus,
} from '../crm/unsent.ts';

describe('unsent creators', () => {
  it('includes emailed leads that have not been sent', () => {
    expect(isUnsentCreator({ outreach_status: 'pending_review', email: 'a@b.co' })).toBe(true);
    expect(isUnsentCreator({ outreach_status: 'pending', email: 'a@b.co' })).toBe(true);
    expect(isUnsentCreator({ outreach_status: 'queued', email: 'a@b.co' })).toBe(true);
  });

  it('excludes sent, replied, archived, and missing emails', () => {
    expect(isUnsentCreator({ outreach_status: 'sent', email: 'a@b.co' })).toBe(false);
    expect(isUnsentCreator({ outreach_status: 'replied', email: 'a@b.co' })).toBe(false);
    expect(isUnsentCreator({ outreach_status: 'archived', email: 'a@b.co' })).toBe(false);
    expect(isUnsentCreator({ outreach_status: 'pending_review', email: '' })).toBe(false);
    expect(isUnsentCreator({ outreach_status: 'pending', email: null })).toBe(false);
  });

  it('keeps do-not-contact out of a preset batch', () => {
    const row = {
      outreach_status: 'pending_review',
      email: 'a@b.co',
      do_not_contact: true,
    };
    expect(isUnsentCreator(row)).toBe(true);
    expect(canReceivePresetEmail(row)).toBe(false);
  });

  it('maps the retired queue tabs onto Unsent', () => {
    expect(normaliseCrmStatus('pending_review')).toBe('unsent');
    expect(normaliseCrmStatus('queued')).toBe('unsent');
    expect(normaliseCrmStatus('pending')).toBe('unsent');
    expect(normaliseCrmStatus('replied')).toBe('replied');
    expect(normaliseCrmStatus('sent')).toBe('sent');
    expect(normaliseCrmStatus('nope')).toBe('');
    expect(normaliseCrmStatus(null)).toBe('');
  });

  it('lists Sent beside All, Unsent, and Replied', () => {
    expect(CRM_CREATOR_TABS.map((tab) => tab.label)).toEqual([
      'All',
      'Unsent',
      'Sent',
      'Replied',
    ]);
    expect(CRM_CREATOR_TABS.find((tab) => tab.label === 'Sent')?.key).toBe('sent');
  });
});
