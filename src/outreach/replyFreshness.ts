/** Match the Railway autopilot Gmail poll (every five minutes). */
export const REPLY_SYNC_STALE_MS = 5 * 60 * 1000;

function stamp(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * True when neither the server stamp nor a recent browser attempt is fresh.
 * A missing stamp is stale so the first open of the day still syncs.
 */
export function replySyncIsStale(
  lastSynced: string | null | undefined,
  now = Date.now(),
  clientAttemptAt?: string | number | null,
): boolean {
  const times = [stamp(lastSynced), stamp(clientAttemptAt)].filter(
    (value): value is number => value != null,
  );
  if (times.length === 0) return true;
  return now - Math.max(...times) >= REPLY_SYNC_STALE_MS;
}
