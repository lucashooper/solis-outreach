import { describe, expect, it } from 'vitest';
import { formatEngagement, visibleEngagement } from '../discovery/engagement.js';

describe('visible engagement', () => {
  it('hides rates a single viral video would invent', () => {
    expect(visibleEngagement(4.2)).toBe(4.2);
    expect(visibleEngagement(400)).toBeNull();
    expect(visibleEngagement(796)).toBeNull();
    expect(formatEngagement(null)).toBe('—');
    expect(formatEngagement(5892)).toBe('—');
    expect(formatEngagement(3.25)).toBe('3.3%');
  });
});
