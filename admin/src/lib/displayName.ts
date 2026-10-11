import type { User } from '@supabase/supabase-js';

/** Saved display name, otherwise the part of the email before @. */
export function displayNameOf(user: User | null | undefined): string {
  const saved = user?.user_metadata?.display_name;
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  const email = user?.email ?? '';
  const local = email.split('@')[0]?.trim();
  return local || 'there';
}

export function savedDisplayName(user: User | null | undefined): string {
  const saved = user?.user_metadata?.display_name;
  return typeof saved === 'string' ? saved.trim() : '';
}

/** Greeting for the current hour in London. */
export function londonGreeting(now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: 'Europe/London',
    }).format(now),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
