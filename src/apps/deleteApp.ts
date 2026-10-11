export interface AppRemovalPlan {
  action: 'keep' | 'archive' | 'delete';
  /** Toast copy, without the app name. */
  detail: string;
}

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/**
 * Never remove the last app. Apps with campaigns or creators are archived
 * so campaigns, creators, and email history stay. An empty app can be deleted.
 */
export function planAppRemoval(input: {
  visibleApps: number;
  campaigns: number;
  creators: number;
}): AppRemovalPlan {
  if (input.visibleApps <= 1) {
    return { action: 'keep', detail: 'Keep at least one app.' };
  }
  const campaigns = Math.max(0, Math.round(input.campaigns) || 0);
  const creators = Math.max(0, Math.round(input.creators) || 0);
  if (campaigns > 0 || creators > 0) {
    const parts = [
      campaigns > 0 ? countLabel(campaigns, 'campaign', 'campaigns') : '',
      creators > 0 ? countLabel(creators, 'creator', 'creators') : '',
    ].filter(Boolean);
    return {
      action: 'archive',
      detail: `It has ${parts.join(' and ')}. Campaigns, creators, and email history stay.`,
    };
  }
  return { action: 'delete', detail: 'It had no campaigns or creators.' };
}
