import { describe, expect, it } from 'vitest';
import { renderTemplate, templateValues } from '../templates/tokens.js';
import { renderTemplate as renderMjs } from '../../netlify/lib/templateTokens.mjs';
import { needsFollowUp } from '../outreach/followUp.js';
import { suppressionDecision } from '../outreach/suppression.js';

describe('template tokens', () => {
  it('fills the approved tokens and falls back when a value is missing', () => {
    const body = renderTemplate(
      'Hi {{creator_name}} on {{platform}}. {{custom_hook}} Re: {{recent_video_topic}} from {{app_name}}.',
      { handle: 'alexfits', platform: 'tiktok' },
    );
    expect(body).toContain('Hi alexfits on TikTok');
    expect(body).toContain('I have been enjoying your TikTok posts.');
    expect(body).toContain('your latest post');
    expect(body).toContain('our app');
  });

  it('keeps an empty hook blank and a missing display name as there', () => {
    expect(renderTemplate('{{hook}}|{{display_name}}|{{app_name}}', { appName: 'Solis' })).toBe(
      '|there|Solis',
    );
  });

  it('matches the Netlify copy', () => {
    const input = { handle: 'alex', appName: 'Astra', platform: 'instagram', hook: 'Nice reel.' };
    expect(renderMjs('{{custom_hook}} {{platform}}', input)).toBe(
      renderTemplate('{{custom_hook}} {{platform}}', input),
    );
    expect(templateValues(input).creator_handle).toBe('@alex');
    const withHook = {
      ...input,
      videoHook: 'your Fourth Wing reaction video was great.',
      storeUrl: 'https://apps.apple.com/app/id1',
    };
    expect(renderMjs('{{first_name}} {{video_hook}} {{store_url}}', withHook)).toBe(
      renderTemplate('{{first_name}} {{video_hook}} {{store_url}}', withHook),
    );
  });
});

describe('follow-up and suppression', () => {
  it('flags a sent lead after three days and drops replied or blocked leads', () => {
    const sentAt = new Date(Date.now() - 3.5 * 24 * 60 * 60 * 1000).toISOString();
    expect(needsFollowUp({ status: 'sent', lastSentAt: sentAt, days: 3 })).toBe(true);
    expect(needsFollowUp({ status: 'sent', lastSentAt: sentAt, days: 4 })).toBe(false);
    expect(needsFollowUp({ status: 'sent', lastSentAt: sentAt, replied: true, days: 3 })).toBe(false);
    expect(
      needsFollowUp({ status: 'sent', lastSentAt: sentAt, doNotContact: true, days: 3 }),
    ).toBe(false);
  });

  it('blocks do-not-contact even with an override, and duplicates only without one', () => {
    expect(suppressionDecision({ doNotContact: true, alreadyEmailed: false, override: true }).skip).toBe(
      true,
    );
    expect(suppressionDecision({ doNotContact: false, alreadyEmailed: true }).reason).toMatch(/already emailed/i);
    expect(suppressionDecision({ doNotContact: false, alreadyEmailed: true, override: true }).skip).toBe(
      false,
    );
  });
});
