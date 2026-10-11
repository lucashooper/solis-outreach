export interface LaunchRow {
  handle: string;
  email: string | null;
  doNotContact: boolean;
  alreadyContacted: boolean;
}

export interface LaunchPlan {
  eligible: Array<{ handle: string; email: string }>;
  skipped: {
    noEmail: number;
    doNotContact: number;
    alreadyContacted: number;
  };
}

/** Who a Discover launch will email, and why the rest are left out. */
export function planLaunch(rows: LaunchRow[]): LaunchPlan {
  const eligible: Array<{ handle: string; email: string }> = [];
  const seen = new Set<string>();
  const skipped = { noEmail: 0, doNotContact: 0, alreadyContacted: 0 };
  for (const row of rows) {
    const email = String(row.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) {
      skipped.noEmail += 1;
      continue;
    }
    if (row.doNotContact) {
      skipped.doNotContact += 1;
      continue;
    }
    if (row.alreadyContacted) {
      skipped.alreadyContacted += 1;
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    eligible.push({
      handle: String(row.handle ?? '').replace(/^@/, ''),
      email,
    });
  }
  return { eligible, skipped };
}

export function skippedTotal(plan: LaunchPlan): number {
  return plan.skipped.noEmail + plan.skipped.doNotContact + plan.skipped.alreadyContacted;
}

/** "Discovery · #booktok · 6 Oct 13:05" in London time. */
export function discoveryAudienceName(niche: string, now = new Date()): string {
  const raw = niche.trim().replace(/^#+/, '').replace(/\s+/g, '');
  const tag = raw ? `#${raw}` : '#search';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = read('hour').replace(/\D/g, '').padStart(2, '0');
  const minute = read('minute').replace(/\D/g, '').padStart(2, '0');
  return `Discovery · ${tag} · ${read('day')} ${read('month')} ${hour}:${minute}`;
}

function londonParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

/** "5 Oct", or "5 Oct 2025" when the year is not the current London year. */
export function formatCreatedLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const created = londonParts(date);
  const today = londonParts(now);
  const stamp = `${created.day} ${created.month}`;
  return created.year === today.year ? stamp : `${stamp} ${created.year}`;
}

export function audienceSelectorLine(
  group: { member_count?: number; created_at: string },
  now = new Date(),
): string {
  const count = group.member_count ?? 0;
  const members = `${count} ${count === 1 ? 'member' : 'members'}`;
  const when = formatCreatedLabel(group.created_at, now);
  return when ? `${members} · created ${when}` : members;
}

export function isNewAudience(iso: string, now = Date.now()): boolean {
  const created = Date.parse(iso);
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  return age >= 0 && age < 24 * 60 * 60 * 1000;
}
