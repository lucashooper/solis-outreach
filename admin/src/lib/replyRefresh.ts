import { replySyncIsStale } from '../../../src/outreach/replyFreshness.ts';
import { fetchGmailConnection, syncGmailReplies } from './supabase';

const STAMP_KEY = 'solis-gmail-sync-at';

function readStamp(): string | null {
  try {
    return sessionStorage.getItem(STAMP_KEY);
  } catch {
    return null;
  }
}

function writeStamp(): void {
  try {
    sessionStorage.setItem(STAMP_KEY, new Date().toISOString());
  } catch {
    /* private mode */
  }
}

type ErrorListener = (message: string) => void;

const listeners = new Set<ErrorListener>();
let lastReported = '';
let inflight: Promise<{ synced: boolean }> | null = null;

/** One toast for a sync failure, even if several screens asked at once. */
export function subscribeReplySyncErrors(listener: ErrorListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function reportError(message: string): void {
  if (!message || message === lastReported) return;
  lastReported = message;
  const first = listeners.values().next().value as ErrorListener | undefined;
  first?.(message);
}

/**
 * Pull Gmail when the last successful sync is older than five minutes,
 * then let the caller reload Supabase. Quiet on success.
 */
export async function ensureFreshReplies(
  accessToken: string | undefined,
): Promise<{ synced: boolean }> {
  if (inflight) return inflight;
  inflight = run(accessToken).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function run(accessToken: string | undefined): Promise<{ synced: boolean }> {
  let lastSynced: string | null = null;
  try {
    const connection = await fetchGmailConnection();
    lastSynced = connection.lastSynced;
  } catch {
    lastSynced = null;
  }
  if (!replySyncIsStale(lastSynced, Date.now(), readStamp())) {
    return { synced: false };
  }
  if (!accessToken) return { synced: false };
  try {
    await syncGmailReplies(accessToken);
    writeStamp();
    lastReported = '';
    return { synced: true };
  } catch (err) {
    writeStamp();
    reportError(err instanceof Error ? err.message : 'Gmail sync failed');
    return { synced: false };
  }
}

/** Run when the tab becomes visible again. Does not fire for a hidden document. */
export function subscribeWhenVisible(onVisible: () => void): () => void {
  let timer = 0;
  const runVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    window.clearTimeout(timer);
    timer = window.setTimeout(onVisible, 250);
  };
  window.addEventListener('focus', runVisible);
  document.addEventListener('visibilitychange', runVisible);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('focus', runVisible);
    document.removeEventListener('visibilitychange', runVisible);
  };
}
