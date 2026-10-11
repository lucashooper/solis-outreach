import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  ensureFreshReplies,
  subscribeWhenVisible,
} from '../lib/replyRefresh';
import {
  fetchEmailReplies,
  fetchGmailConnection,
  syncGmailReplies,
  type EmailReply,
  type GmailConnection,
} from '../lib/supabase';
import { useFeedback } from './feedback';
import { Drawer } from './Drawer';
import { SHOW_MORE_LIMIT, ShowMore, useExpandedList } from './ShowMore';
import { markRepliesSeen, refreshCrmUnread, useUnreadSummary } from '../lib/replyInbox';

const SETUP_DOC =
  'docs/webhook-setup.md#7-gmail-reply-sync-outreach-mailbox';

function when(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London' });
}

function replyText(row: EmailReply): string {
  return row.body || row.body_text || row.snippet || '—';
}

function preview(row: EmailReply): string {
  const text = replyText(row).replace(/\s+/g, ' ').trim();
  return text === '—' ? '—' : text;
}

function ErrorNote({ message }: { message: string }) {
  const parts = message.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <p className="text-sm text-red-300">
      {parts.map((part, index) =>
        part.startsWith('http') ? (
          <a key={index} className="underline" href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

export function RepliesPanel({
  appId,
  campaignId,
}: {
  appId?: string | null;
  campaignId?: string | null;
}) {
  const { session } = useAuth();
  const { toast } = useFeedback();
  const unread = useUnreadSummary();
  const replyList = useExpandedList();
  const [rows, setRows] = useState<EmailReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<GmailConnection | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = (quiet = false) => {
    if (!quiet) setLoading(true);
    return fetchEmailReplies({ appId: appId ?? null, campaignId: campaignId ?? null })
      .then((list) => {
        setRows(list);
        setListError(null);
        void refreshCrmUnread();
      })
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : 'Could not load replies');
      })
      .finally(() => setLoading(false));
  };

  const loadStatus = () => {
    setStatusLoading(true);
    return fetchGmailConnection()
      .then((status) => setConnection(status))
      .catch(() => setConnection(null))
      .finally(() => setStatusLoading(false));
  };

  useEffect(() => {
    void load();
    void loadStatus();
    // Reload when the scope changes. load closes over the latest ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, campaignId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await ensureFreshReplies(session?.access_token);
      if (cancelled || !result.synced) return;
      await Promise.all([load(true), loadStatus()]);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token, appId, campaignId]);

  useEffect(() => {
    return subscribeWhenVisible(() => {
      void (async () => {
        await ensureFreshReplies(session?.access_token);
        await Promise.all([load(true), loadStatus()]);
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token, appId, campaignId]);

  const onSync = async () => {
    const token = session?.access_token;
    if (!token) {
      toast('info', 'Sign in again before syncing replies.');
      return;
    }
    setSyncing(true);
    setSyncError(null);
    try {
      await syncGmailReplies(token);
      toast('success', 'Reply sync finished.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gmail sync failed';
      setSyncError(message);
      toast('error', message);
    } finally {
      await Promise.all([load(true), loadStatus()]);
      setSyncing(false);
    }
  };

  const selected = rows.find((row) => row.id === openId) ?? null;
  const needsConnecting = !statusLoading && connection?.configured === false && rows.length === 0;

  const syncTitle = connection?.configured
    ? `Connected as ${connection.email}${
        connection.lastSynced ? ` · Last synced ${when(connection.lastSynced)}` : ' · Not synced yet'
      }`
    : 'Sync replies';

  return (
    <section className="section space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">Replies</h2>
        <button
          type="button"
          className="btn-ghost !px-2 !py-1.5"
          aria-label="Sync replies"
          title={syncTitle}
          disabled={syncing}
          onClick={() => void onSync()}
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {syncError && <ErrorNote message={syncError} />}
      {loading && rows.length === 0 && <p className="text-sm text-ink-faint">Loading…</p>}
      {!loading && listError && rows.length === 0 && <ErrorNote message={listError} />}
      {!loading && needsConnecting && (
        <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-sm text-ink-muted">
          <p>The inbox needs connecting before replies can appear here.</p>
          <p className="mt-2">
            Add the Gmail OAuth values for studioowner@gmail.com, then use Sync now.{' '}
            <a className="text-accent underline" href={SETUP_DOC} target="_blank" rel="noreferrer">
              Setup steps
            </a>
          </p>
        </div>
      )}
      {!loading && !needsConnecting && rows.length === 0 && !listError && connection?.configured && (
        <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-sm text-ink-muted">
          <p>No replies yet.</p>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
          {replyList.slice(rows).map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-white/[0.03]"
                onClick={() => {
                  markRepliesSeen([row.id]);
                  setOpenId(row.id);
                }}
              >
                {unread.unseenReplyIds.includes(row.id) && (
                  <span
                    className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    aria-label="Unread reply"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-ink">{row.from_email}</span>
                    <span className="shrink-0 text-xs text-ink-faint">{when(row.received_at)}</span>
                  </span>
                  <span className="mt-1 block truncate text-sm text-ink-muted">{row.subject || '—'}</span>
                  <span className="mt-1 block truncate text-xs text-ink-faint">{preview(row)}</span>
                </span>
              </button>
            </li>
          ))}
          {rows.length > SHOW_MORE_LIMIT && (
            <li>
              <ShowMore
                total={rows.length}
                expanded={replyList.expanded}
                onToggle={replyList.toggle}
              />
            </li>
          )}
        </ul>
      )}
      <Drawer
        open={Boolean(selected)}
        title={selected?.subject || 'Reply'}
        subtitle={selected?.from_email}
        onClose={() => setOpenId(null)}
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-faint">{when(selected.received_at)}</p>
            <p className="text-ink-muted">
              {selected.creator_id
                ? 'Linked creator'
                : selected.audience_member_id
                  ? 'Linked audience member'
                  : 'No linked lead'}
            </p>
            <p className="whitespace-pre-wrap text-ink">{replyText(selected)}</p>
          </div>
        )}
      </Drawer>
    </section>
  );
}
