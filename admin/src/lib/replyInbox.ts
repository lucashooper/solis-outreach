import { useEffect, useState } from 'react';
import {
  blastUnreadId,
  summariseUnread,
  type UnreadBlastRef,
  type UnreadReplyRef,
  type UnreadSummary,
} from '../../../src/outreach/replyUnread.ts';
import { ensureFreshReplies, subscribeWhenVisible } from './replyRefresh';
import { fetchEmailReplies, fetchMailboxReplies } from './supabase';

const SEEN_KEY = 'solis-reply-seen';
const POLL_MS = 45_000;
const MAX_SEEN = 400;

const EMPTY: UnreadSummary = {
  total: 0,
  repliedTab: 0,
  repliesTab: 0,
  unseenReplyIds: [],
  unseenCreatorIds: [],
  unseenBlastIds: [],
};

type Cache = {
  appId: string;
  replies: UnreadReplyRef[];
  blasts: UnreadBlastRef[];
};

let cache: Cache | null = null;
let scopeAppId: string | null = null;
let scopeToken: string | undefined;
let seen = readSeen();
const listeners = new Set<() => void>();
let pollTimer = 0;
let stopVisible: (() => void) | null = null;
let request = 0;
let pollers = 0;
let started = false;

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function persistSeen(ids: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-MAX_SEEN)));
  } catch {
    /* private mode */
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function currentUnread(): UnreadSummary {
  if (!cache || cache.appId !== scopeAppId || !scopeAppId) return EMPTY;
  return summariseUnread(cache.replies, cache.blasts, seen);
}

/** Remember replies the operator has opened. No-op when they are already seen. */
export function markRepliesSeen(ids: readonly string[]): void {
  const fresh = ids.filter((id) => id && !seen.has(id));
  if (fresh.length === 0) return;
  const next = [...seen, ...fresh].slice(-MAX_SEEN);
  seen = new Set(next);
  persistSeen(next);
  emit();
}

export { blastUnreadId };

async function refresh(options?: { sync?: boolean }): Promise<void> {
  const appId = scopeAppId;
  const ticket = ++request;
  if (!appId) {
    cache = null;
    emit();
    return;
  }
  if (options?.sync) {
    try {
      await ensureFreshReplies(scopeToken);
    } catch {
      /* CRM screens already toast sync failures. */
    }
  }
  if (ticket !== request || scopeAppId !== appId) return;
  const [replies, blasts] = await Promise.all([
    fetchEmailReplies({ appId }).catch(() => []),
    fetchMailboxReplies(appId).catch(() => []),
  ]);
  if (ticket !== request || scopeAppId !== appId) return;
  cache = {
    appId,
    replies: replies.map((row) => ({
      id: row.id,
      creator_id: row.creator_id,
      from_email: row.from_email,
    })),
    blasts,
  };
  emit();
}

/** Re-read inbox rows after a screen has synced. Does not start another Gmail pull. */
export function refreshCrmUnread(): Promise<void> {
  return refresh();
}

function ensurePolling(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  seen = readSeen();
  const tick = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refresh();
  };
  void refresh({ sync: true });
  pollTimer = window.setInterval(tick, POLL_MS);
  stopVisible = subscribeWhenVisible(() => {
    void refresh({ sync: true });
  });
}

function stopPolling(): void {
  if (!started) return;
  started = false;
  window.clearInterval(pollTimer);
  stopVisible?.();
  stopVisible = null;
}

/** Subscribe to the latest counts without changing which app is polled. */
export function useUnreadSummary(): UnreadSummary {
  const [summary, setSummary] = useState<UnreadSummary>(EMPTY);
  useEffect(() => {
    const sync = () => setSummary(currentUnread());
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return summary;
}

/**
 * Live unread counts for the current app. Polls the existing reply tables
 * while the tab is visible, and refreshes on focus using the same Gmail
 * freshness check as the CRM. Call this once from the app shell.
 */
export function useCrmUnread(appId: string | null, accessToken?: string): UnreadSummary {
  const summary = useUnreadSummary();
  useEffect(() => {
    scopeAppId = appId;
    scopeToken = accessToken;
    pollers += 1;
    ensurePolling();
    void refresh({ sync: true });
    return () => {
      pollers -= 1;
      if (pollers === 0) stopPolling();
    };
  }, [appId, accessToken]);
  return summary;
}
