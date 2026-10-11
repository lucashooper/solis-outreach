import { describe, expect, it } from 'vitest';
import {
  outreachStatusChoiceValue,
  outreachStatusChoices,
  statusPillLabel,
} from '../crm/statusLabel.ts';

describe('creator status pills', () => {
  it('maps pre-send statuses to Unsent and keeps sent states', () => {
    expect(statusPillLabel('pending')).toBe('Unsent');
    expect(statusPillLabel('pending_review')).toBe('Unsent');
    expect(statusPillLabel('queued')).toBe('Unsent');
    expect(statusPillLabel('sent')).toBe('Sent');
    expect(statusPillLabel('replied')).toBe('Replied');
    expect(statusPillLabel('bounced')).toBe('Bounced');
    expect(statusPillLabel('archived')).toBe('Archived');
  });

  it('offers one Unsent choice for the status menu', () => {
    expect(outreachStatusChoices().map((choice) => choice.label)).toEqual([
      'Unsent',
      'Sent',
      'Replied',
      'Archived',
    ]);
    expect(outreachStatusChoiceValue('pending_review')).toBe('pending');
    expect(outreachStatusChoiceValue('queued')).toBe('pending');
    expect(outreachStatusChoiceValue('sent')).toBe('sent');
  });
});
