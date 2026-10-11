import { describe, expect, it } from 'vitest';
import { planAppRemoval } from '../apps/deleteApp.js';

describe('planAppRemoval', () => {
  it('keeps the last app, archives linked apps, and deletes an empty one', () => {
    expect(planAppRemoval({ visibleApps: 1, campaigns: 0, creators: 0 })).toEqual({
      action: 'keep',
      detail: 'Keep at least one app.',
    });
    expect(planAppRemoval({ visibleApps: 2, campaigns: 4, creators: 12 }).action).toBe('archive');
    expect(planAppRemoval({ visibleApps: 2, campaigns: 4, creators: 0 }).detail).toContain('4 campaigns');
    expect(planAppRemoval({ visibleApps: 2, campaigns: 0, creators: 0 })).toEqual({
      action: 'delete',
      detail: 'It had no campaigns or creators.',
    });
  });
});
