import { describe, expect, it } from 'vitest';
import { gmailListPageUrl, GMAIL_LIST_LIMIT } from '../../netlify/lib/gmailSync.mjs';

describe('gmail list pages', () => {
  it('asks for the newest inbox messages and stops at the cap', () => {
    const first = gmailListPageUrl(0, '');
    expect(first).toContain('maxResults=40');
    expect(decodeURIComponent(first ?? '')).toContain('in:inbox newer_than:30d');
    expect(gmailListPageUrl(GMAIL_LIST_LIMIT, 'next')).toBeNull();
  });

  it('carries the page token while there is still room', () => {
    const next = gmailListPageUrl(40, 'abc 1');
    expect(next).toContain('pageToken=abc%201');
    expect(next).toContain('maxResults=40');
  });
});
