import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw, Undo2, Mail } from 'lucide-react';
import { IconButton } from '../components/IconButton';
import { ConnectBanner } from '../components/ConnectBanner';
import { CreatorAvatar } from '../components/CreatorAvatar';
import { Drawer } from '../components/Drawer';
import { RepliesPanel } from '../components/RepliesPanel';
import { CreatorListRow } from '../components/CreatorListRow';
import { SendDrawer, type SendTarget } from '../components/SendDrawer';
import { ShowMore, useExpandedList } from '../components/ShowMore';
import { StatusBadge } from '../components/StatusBadge';
import { UnreadBadge } from '../components/UnreadBadge';
import { platformLabel } from '../../../src/creators/profile.ts';
import { useAppScope } from '../lib/apps';
import { useAuth } from '../lib/auth';
import { canReceivePresetEmail, normaliseCrmStatus } from '../../../src/crm/unsent.ts';
import { isConfigured, loadSettings } from '../lib/settings';
import {
  clearMailboxReply,
  deleteCreator,
  fetchCreator,
  fetchCreators,
  fetchLatestSends,
  fetchMailboxReplies,
  patchCreator,
  sendFollowUp,
  setCreatorReplied,
  setDoNotContact,
  syncGmailReplies,
  type MailboxReply,
} from '../lib/supabase';
import { blastUnreadId, markRepliesSeen, refreshCrmUnread, useUnreadSummary } from '../lib/replyInbox';
import type { Creator } from '../lib/types';
import { CRM_FILTER_TABS, PLATFORMS } from '../lib/types';
import { asFollowUpDays, needsFollowUp, type FollowUpDays } from '../../../src/outreach/followUp.ts';
import { useFeedback } from '../components/feedback';
import {
  ensureFreshReplies,
  subscribeReplySyncErrors,
  subscribeWhenVisible,
} from '../lib/replyRefresh';

function HookModal({
  open,
  initial,
  onClose,
  onSave,
  busy,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSave: (hook: string) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    setValue(initial);
  }, [initial, open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card w-full max-w-md">
        <h3 className="text-lg font-semibold text-white">Edit AI hook</h3>
        <p className="mt-1 text-xs text-slate-500">
          Injected into the outreach email as {'{{hook}}'}.
        </p>
        <textarea
          className="input mt-3 min-h-[120px]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !value.trim()}
            onClick={() => onSave(value.trim())}
          >
            {busy ? 'Saving…' : 'Save hook'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Creators() {
  const connected = isConfigured();
  const { appId, ready, selected } = useAppScope();
  const { session } = useAuth();
  const { toast, undoable } = useFeedback();
  const unread = useUnreadSummary();
  const creatorList = useExpandedList();
  const blastList = useExpandedList();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'replies' ? 'replies' : 'creators';
  const status = normaliseCrmStatus(params.get('status'));
  const platform = (params.get('platform') ?? '') as string;
  const search = params.get('q') ?? '';
  const handles = (params.get('handles') ?? '')
    .split(',')
    .map((handle) => handle.replace(/^@/, '').trim())
    .filter(Boolean);
  const focusId = params.get('creator');

  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(connected);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(search);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendTargets, setSendTargets] = useState<SendTarget[] | null>(null);
  const [hookFor, setHookFor] = useState<Creator | null>(null);
  const [mailboxReplies, setMailboxReplies] = useState<MailboxReply[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lastSent, setLastSent] = useState<Record<string, string>>({});
  const [followUpDays, setFollowUpDays] = useState<FollowUpDays>(3);
  const [focused, setFocused] = useState<Creator | null>(null);
  const [focusLoaded, setFocusLoaded] = useState(false);
  const [presetBatch, setPresetBatch] = useState(false);

  useEffect(() => {
    if (!connected || !focusId) {
      setFocused(null);
      setFocusLoaded(!focusId);
      return;
    }
    let cancelled = false;
    setFocusLoaded(false);
    fetchCreator(focusId)
      .then((row) => {
        if (!cancelled) setFocused(row);
      })
      .catch(() => {
        if (!cancelled) setFocused(null);
      })
      .finally(() => {
        if (!cancelled) setFocusLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, focusId]);

  const closeFocus = () => {
    const next = new URLSearchParams(params);
    next.delete('creator');
    setParams(next, { replace: true });
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const load = useCallback((quiet = false) => {
    if (!connected || !ready || !appId) {
      setCreators([]);
      setMailboxReplies([]);
      setLoading(false);
      return Promise.resolve();
    }
    if (!quiet) setLoading(true);
    return Promise.all([
      fetchCreators({ status, platform, search, appId, handles }),
      fetchMailboxReplies(appId),
    ])
      .then(async ([rows, replies]) => {
        setCreators(rows);
        setMailboxReplies(replies);
        setError(null);
        const sends = await fetchLatestSends(rows.map((row) => row.id));
        setLastSent(sends);
        void refreshCrmUnread();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load creators');
        if (!quiet) setCreators([]);
      })
      .finally(() => {
        if (!quiet) setLoading(false);
      });
  }, [connected, ready, appId, status, platform, search, handles.join(',')]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => subscribeReplySyncErrors((message) => toast('error', message)), [toast]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await ensureFreshReplies(session?.access_token);
      if (cancelled || !result.synced) return;
      await load(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, load]);

  useEffect(() => {
    return subscribeWhenVisible(() => {
      void (async () => {
        await ensureFreshReplies(session?.access_token);
        await load(true);
      })();
    });
  }, [session?.access_token, load]);

  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  useEffect(() => {
    try {
      setFollowUpDays(asFollowUpDays(localStorage.getItem('solis-follow-up-days')));
    } catch {
      /* ignore */
    }
  }, []);

  const changeFollowUpDays = (days: FollowUpDays) => {
    setFollowUpDays(days);
    try {
      localStorage.setItem('solis-follow-up-days', String(days));
    } catch {
      /* ignore */
    }
  };

  const dueFollowUp = (creator: Creator) =>
    needsFollowUp({
      status: creator.outreach_status,
      replied: creator.outreach_status === 'replied',
      doNotContact: creator.do_not_contact === true,
      lastSentAt: lastSent[creator.id] ?? null,
      days: followUpDays,
    });

  const onFollowUp = async (creator: Creator) => {
    setBusyId(creator.id);
    setActionMsg(null);
    try {
      const result = await sendFollowUp({ creatorId: creator.id, days: followUpDays });
      setActionMsg(
        result.dryRun
          ? `Follow-up for @${creator.handle} was recorded as a dry run.`
          : `Follow-up sent to @${creator.handle}${result.threaded ? ' in the same thread' : ''}.`,
      );
      load();
    } catch (e: unknown) {
      setActionMsg(e instanceof Error ? e.message : 'Follow-up failed');
    } finally {
      setBusyId(null);
    }
  };

  const onToggleDoNotContact = async (creator: Creator) => {
    setBusyId(creator.id);
    setActionMsg(null);
    const next = creator.do_not_contact !== true;
    try {
      await setDoNotContact(creator.id, next);
      setActionMsg(
        next
          ? `@${creator.handle} is marked Do not contact.`
          : `@${creator.handle} can be contacted again.`,
      );
      load();
    } catch (e: unknown) {
      setActionMsg(e instanceof Error ? e.message : 'Could not update Do not contact');
    } finally {
      setBusyId(null);
    }
  };

  const toSendTarget = (c: Creator): SendTarget => ({
    id: c.id,
    handle: c.handle,
    email: c.email,
    platform: c.platform,
    bio: c.bio,
    hook: typeof c.ai_variables?.hook === 'string' ? c.ai_variables.hook : '',
    doNotContact: c.do_not_contact === true,
    topic: c.top_videos?.map((video) => video.caption).find((caption) => caption) ?? null,
    niches: Array.isArray(c.ai_variables?.niches) ? c.ai_variables.niches.map(String) : [],
    captions: (c.top_videos ?? [])
      .map((video) => video.caption)
      .filter((caption): caption is string => Boolean(caption)),
    videos: (c.top_videos ?? []).map((video) => ({
      caption: video.caption,
      video_url: video.video_url,
      scraped_at: video.scraped_at ?? null,
    })),
    foundAt: c.created_at,
  });

  const onToggleReplied = async (c: Creator) => {
    setBusyId(c.id);
    setActionMsg(null);
    const next = c.outreach_status !== 'replied';
    try {
      await setCreatorReplied(c, next);
      setActionMsg(
        next
          ? `Marked @${c.handle} as replied`
          : `Cleared replied on @${c.handle}`,
      );
      load();
    } catch (e: unknown) {
      setActionMsg(e instanceof Error ? e.message : 'Could not update replied status');
    } finally {
      setBusyId(null);
    }
  };

  const onSyncReplies = async () => {
    const token = session?.access_token;
    if (!token) {
      toast('info', 'Sign in again before syncing replies.');
      return;
    }
    setSyncing(true);
    setActionMsg(null);
    setError(null);
    try {
      const result = await syncGmailReplies(token);
      const marked = result.markedCreators + result.markedBlasts;
      toast(
        'success',
        marked > 0
          ? `Sync marked ${result.markedCreators} CRM lead${result.markedCreators === 1 ? '' : 's'} and ${result.markedBlasts} blast recipient${result.markedBlasts === 1 ? '' : 's'}.`
          : 'Sync finished. No new matching replies.',
      );
      await load(true);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Gmail sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const onClearMailbox = async (email: string) => {
    setBusyId(email);
    setActionMsg(null);
    try {
      await clearMailboxReply(email, appId);
      setActionMsg(`Cleared replied on ${email}`);
      load();
    } catch (e: unknown) {
      setActionMsg(e instanceof Error ? e.message : 'Could not clear reply');
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = (creator: Creator) => {
    const snapshot = creators;
    setCreators((rows) => rows.filter((row) => row.id !== creator.id));
    if (focused?.id === creator.id) closeFocus();
    undoable(
      `Deleted “@${creator.handle.replace(/^@/, '')}”.`,
      () => deleteCreator(creator.id),
      () => setCreators(snapshot),
    );
  };

  const onArchive = async (c: Creator) => {
    setBusyId(c.id);
    setActionMsg(null);
    try {
      await patchCreator(c.id, { outreach_status: 'archived' });
      setActionMsg(`Skipped @${c.handle}`);
      load();
    } catch (e: unknown) {
      setActionMsg(e instanceof Error ? e.message : 'Skip failed');
    } finally {
      setBusyId(null);
    }
  };

  const onSaveHook = async (hook: string) => {
    if (!hookFor) return;
    setBusyId(hookFor.id);
    try {
      await patchCreator(hookFor.id, { hook });
      setActionMsg(`Hook updated for @${hookFor.handle}`);
      setHookFor(null);
      load();
    } catch (e: unknown) {
      setActionMsg(e instanceof Error ? e.message : 'Hook save failed');
    } finally {
      setBusyId(null);
    }
  };

  const presetCount = creators.filter((row) => canReceivePresetEmail(row)).length;

  return (
    <div className="page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title">Influencer CRM</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost !px-2"
            aria-label="Sync replies"
            title="Sync replies from Gmail"
            disabled={!connected || syncing}
            onClick={() => void onSyncReplies()}
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          </button>
          {view === 'creators' && status === 'unsent' && (
            <button
              type="button"
              className="btn-primary"
              disabled={!connected || loading || presetCount === 0}
              onClick={() => {
                setPresetBatch(true);
                setSendTargets(creators.map(toSendTarget));
              }}
            >
              <Mail className="h-4 w-4" />
              Email all with preset
            </button>
          )}
          <Link
            to="/creators/new"
            className={view === 'creators' && status === 'unsent' ? 'btn-secondary' : 'btn-primary'}
          >
            <Plus className="h-4 w-4" />
            Add creator
          </Link>
        </div>
      </div>

      {!connected && <ConnectBanner />}

      <div className="flex flex-wrap gap-1.5">
        {CRM_FILTER_TABS.map((tab) => {
          const active = view === 'creators' && status === tab.key;
          return (
            <button
              key={tab.label}
              type="button"
              className={
                active
                  ? 'inline-flex items-center rounded-md bg-white/[0.08] px-3 py-1.5 text-xs font-medium text-white'
                  : 'inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-300'
              }
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('view');
                if (tab.key) next.set('status', tab.key);
                else next.delete('status');
                setParams(next);
              }}
            >
              {tab.label}
              {tab.key === 'replied' && (
                <UnreadBadge count={unread.repliedTab} className="ml-1.5" />
              )}
            </button>
          );
        })}
        <button
          type="button"
          className={
            view === 'replies'
              ? 'inline-flex items-center rounded-md bg-white/[0.08] px-3 py-1.5 text-xs font-medium text-white'
              : 'inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-300'
          }
          onClick={() => {
            const next = new URLSearchParams(params);
            if (view === 'replies') next.delete('view');
            else {
              next.set('view', 'replies');
              next.delete('status');
            }
            setParams(next);
          }}
        >
          Replies
          <UnreadBadge count={unread.repliesTab} className="ml-1.5" />
        </button>
      </div>

      {handles.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white/[0.03] px-4 py-3 text-sm text-ink-muted">
          <p>
            Showing {handles.length === 1 ? '1 handle' : `${handles.length} handles`} from this search.
          </p>
          <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => setFilter('handles', '')}>
            Clear
          </button>
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="label" htmlFor="search">
            Search
          </label>
          <input
            id="search"
            className="input"
            placeholder="Handle or email…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter('q', searchInput.trim());
            }}
          />
        </div>
        <div className="w-full sm:w-40">
          <label className="label" htmlFor="platform">
            Platform
          </label>
          <select
            id="platform"
            className="input"
            value={platform}
            onChange={(e) => setFilter('platform', e.target.value)}
          >
            <option value="">All</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p === 'tiktok' ? 'TikTok' : 'Instagram'}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setFilter('q', searchInput.trim())}
        >
          Apply
        </button>
        <div className="w-full sm:w-44">
          <label className="label" htmlFor="follow-up-days">
            Follow-up after
          </label>
          <select
            id="follow-up-days"
            className="input"
            value={String(followUpDays)}
            onChange={(e) => changeFollowUpDays(asFollowUpDays(e.target.value))}
          >
            <option value="3">3 days</option>
            <option value="4">4 days</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-slate-300">
          {actionMsg}
        </div>
      )}

      {view === 'replies' && <RepliesPanel appId={appId} />}

      {view === 'creators' && loading && <p className="text-center text-slate-500">Loading…</p>}

      {view === 'creators' && !loading && creators.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] px-4 py-8 text-center text-slate-500">
          {connected
            ? 'No creators match these filters.'
            : 'Connect Supabase to load creators.'}
        </div>
      )}

      {view === 'creators' && !loading && creators.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          {creatorList.slice(creators).map((c) => (
            <CreatorListRow
              key={c.id}
              creator={c}
              busy={busyId === c.id}
              unread={unread.unseenCreatorIds.includes(c.id)}
              onSend={() => {
                setPresetBatch(false);
                setSendTargets([toSendTarget(c)]);
              }}
              onSkip={() => void onArchive(c)}
              onDelete={() => onDelete(c)}
              onEditHook={() => setHookFor(c)}
              onToggleReplied={() => void onToggleReplied(c)}
              onToggleDoNotContact={() => void onToggleDoNotContact(c)}
              onFollowUp={() => void onFollowUp(c)}
              needsFollowUp={dueFollowUp(c)}
            />
          ))}
          <ShowMore
            total={creators.length}
            expanded={creatorList.expanded}
            onToggle={creatorList.toggle}
          />
        </div>
      )}

      {view === 'creators' &&
        !loading &&
        mailboxReplies.length > 0 &&
        (status === '' || status === 'replied') && (
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Blast replies
            </h2>
            <div className="overflow-hidden rounded-xl border border-white/[0.06]">
              {blastList.slice(mailboxReplies).map((reply) => {
                const blastId = blastUnreadId(reply.email);
                const unseen = unread.unseenBlastIds.includes(blastId);
                return (
                <article
                  key={reply.email}
                  className="flex cursor-pointer flex-col gap-3 border-b border-white/[0.06] px-4 py-4 last:border-b-0 hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between"
                  onClick={() => markRepliesSeen([blastId])}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {unseen && (
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                          aria-label="Unread reply"
                        />
                      )}
                      <p className="truncate text-sm font-medium text-white">
                        {reply.email}
                      </p>
                      <StatusBadge status="replied" />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Inbound reply on a blast send
                    </p>
                  </div>
                  <IconButton
                    label={busyId === reply.email ? 'Clearing…' : 'Undo'}
                    disabled={busyId === reply.email}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onClearMailbox(reply.email);
                    }}
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </IconButton>
                </article>
                );
              })}
              <ShowMore
                total={mailboxReplies.length}
                expanded={blastList.expanded}
                onToggle={blastList.toggle}
              />
            </div>
          </section>
        )}

      <SendDrawer
        open={Boolean(sendTargets)}
        targets={sendTargets ?? []}
        preset={presetBatch}
        appName={selected?.name || loadSettings().appName || 'Solis'}
        valueProp={selected?.value_prop?.trim() || loadSettings().appValueProp}
        storeUrl={selected?.store_url}
        appId={appId}
        onClose={() => {
          setSendTargets(null);
          setPresetBatch(false);
        }}
        onFinished={() => void load(true)}
      />
      <Drawer
        open={Boolean(focusId)}
        title={focused ? `@${focused.handle.replace(/^@/, '')}` : 'Creator'}
        subtitle={focused ? platformLabel(focused.platform) : undefined}
        onClose={closeFocus}
      >
        {!focusLoaded && <p className="text-sm text-ink-muted">Loading…</p>}
        {focusLoaded && !focused && (
          <p className="text-sm text-ink-muted">This creator is not in the CRM.</p>
        )}
        {focused && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <CreatorAvatar
                name={focused.handle}
                url={focused.avatar_url}
                creatorId={focused.id}
              />
              <div className="min-w-0">
                <StatusBadge status={focused.outreach_status} />
                <p className="mt-1 truncate text-sm text-ink-muted">
                  {focused.email || 'No public email'}
                </p>
              </div>
            </div>
            {focused.bio && <p className="text-sm leading-6 text-ink-muted">{focused.bio}</p>}
            <Link to={`/creators/${focused.id}`} className="text-sm text-accent hover:text-accent-hover">
              Open creator
            </Link>
          </div>
        )}
      </Drawer>
      <HookModal
        open={Boolean(hookFor)}
        initial={
          typeof hookFor?.ai_variables?.hook === 'string'
            ? hookFor.ai_variables.hook
            : ''
        }
        onClose={() => setHookFor(null)}
        onSave={(h) => void onSaveHook(h)}
        busy={busyId === hookFor?.id}
      />
    </div>
  );
}
