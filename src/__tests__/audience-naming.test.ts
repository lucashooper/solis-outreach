import { describe, expect, it } from 'vitest';
import {
  audienceSelectorLine,
  discoveryAudienceName,
  isNewAudience,
  planLaunch,
} from '../audiences/naming.js';
import { ADMIN_ORIGINS, allowedAdminOrigin, DEFAULT_ADMIN_ORIGIN } from '../adminOrigins.js';
import { gmailReturnOrigin } from '../../server/gmailOAuth.ts';

describe('discovery audience name', () => {
  it('uses the niche and London time', () => {
    const name = discoveryAudienceName('booktok', new Date('2026-10-06T12:05:00Z'));
    expect(name).toBe('Discovery · #booktok · 6 Oct 13:05');
  });

  it('does not double the hash', () => {
    const name = discoveryAudienceName('#booktok', new Date('2026-10-06T12:05:00Z'));
    expect(name.startsWith('Discovery · #booktok ·')).toBe(true);
  });
});

describe('launch plan', () => {
  it('splits no email, do not contact, and already contacted', () => {
    const plan = planLaunch([
      { handle: 'a', email: 'a@example.com', doNotContact: false, alreadyContacted: false },
      { handle: 'b', email: null, doNotContact: false, alreadyContacted: false },
      { handle: 'c', email: 'c@example.com', doNotContact: true, alreadyContacted: false },
      { handle: 'd', email: 'd@example.com', doNotContact: false, alreadyContacted: true },
      { handle: 'a2', email: 'A@example.com', doNotContact: false, alreadyContacted: false },
    ]);
    expect(plan.eligible).toEqual([{ handle: 'a', email: 'a@example.com' }]);
    expect(plan.skipped).toEqual({ noEmail: 1, doNotContact: 1, alreadyContacted: 1 });
  });
});

describe('audience selector', () => {
  it('shows the member count and creation date', () => {
    const line = audienceSelectorLine(
      { member_count: 70, created_at: '2026-10-05T11:00:00Z' },
      new Date('2026-10-06T12:00:00Z'),
    );
    expect(line).toBe('70 members · created 5 Oct');
  });

  it('marks groups from the last 24 hours as new', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(isNewAudience('2026-10-06T10:00:00Z', now)).toBe(true);
    expect(isNewAudience('2026-10-04T10:00:00Z', now)).toBe(false);
  });
});

describe('admin origins', () => {
  it('allows the custom domain and both Netlify hosts', () => {
    expect(DEFAULT_ADMIN_ORIGIN).toBe('https://admin.example.com');
    expect(ADMIN_ORIGINS).toContain('https://admin.example.com');
    expect(ADMIN_ORIGINS).toContain('https://your-admin.example.com');
    expect(ADMIN_ORIGINS).toContain('https://your-admin-alias.example.com');
    expect(allowedAdminOrigin('https://admin.example.com/connectors?gmail=1')).toBe(
      'https://admin.example.com',
    );
    expect(allowedAdminOrigin('https://evil.example')).toBeNull();
    const packed = Buffer.from('https://admin.example.com').toString('base64url');
    expect(gmailReturnOrigin(`abc.${packed}`)).toBe('https://admin.example.com');
    expect(gmailReturnOrigin(`abc.${Buffer.from('https://evil.example').toString('base64url')}`)).toBe('');
  });
});
