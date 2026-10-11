import { describe, expect, it } from 'vitest';
import { isAutopilotDue, resolveAutopilotProvider } from '../../server/autopilot.js';

describe('isAutopilotDue', () => {
  it('returns true within the scheduled minute and no prior run', () => {
    // 10:00 London on a winter day (GMT) = 10:00 UTC
    const now = new Date('2026-01-15T10:00:30.000Z');
    expect(isAutopilotDue('0 10 * * *', null, now)).toBe(true);
  });

  it('returns false when already run for this slot', () => {
    const now = new Date('2026-01-15T10:00:30.000Z');
    const last = '2026-01-15T10:00:05.000Z';
    expect(isAutopilotDue('0 10 * * *', last, now)).toBe(false);
  });

  it('returns false far from the schedule', () => {
    const now = new Date('2026-01-15T14:00:00.000Z');
    expect(isAutopilotDue('0 10 * * *', null, now)).toBe(false);
  });
});

describe('resolveAutopilotProvider', () => {
  it('falls back to demo without an Apify account', () => {
    const saved = {
      APIFY_TOKEN: process.env.APIFY_TOKEN,
      APIFY_TOKEN_FALLBACK: process.env.APIFY_TOKEN_FALLBACK,
      APIFY_TOKENS: process.env.APIFY_TOKENS,
    };
    delete process.env.APIFY_TOKEN;
    delete process.env.APIFY_TOKEN_FALLBACK;
    delete process.env.APIFY_TOKENS;
    expect(resolveAutopilotProvider().provider).toBe('demo');
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
