/** London calendar label such as "5 Oct". */
export function campaignDateLabel(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/London',
  }).formatToParts(date);
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  return `${day} ${month}`.trim();
}

export function suggestedCampaignName(input: {
  type: 'discovery' | 'direct_blast';
  audienceName?: string | null;
  niches?: string[];
  date?: Date;
}): string {
  const date = campaignDateLabel(input.date);
  if (input.type === 'direct_blast') {
    const audience = input.audienceName?.trim() || 'Audience';
    return `Blast · ${audience} · ${date}`;
  }
  const niches = (input.niches ?? []).map((niche) => niche.trim()).filter(Boolean);
  const niche = niches.length > 0 ? niches.slice(0, 3).join(', ') : 'Creators';
  return `Discovery · ${niche} · ${date}`;
}
