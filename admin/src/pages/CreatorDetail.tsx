import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ExternalLink, MoreHorizontal, RefreshCw } from 'lucide-react';
import { creatorProfileUrl } from '../../../src/creators/profile.ts';
import { buildOutreachThread, type ThreadBlastInput } from '../../../src/outreach/thread.ts';
import { renderTemplate } from '../../../src/templates/tokens.ts';
import { AiVariablesDisclosure } from '../components/AiVariablesDisclosure';
import { CreatorAvatar } from '../components/CreatorAvatar';
import { PlatformMark } from '../components/PlatformMark';
import { ConnectBanner } from '../components/ConnectBanner';
import { OutreachThread } from '../components/OutreachThread';
import { SendDrawer, type SendTarget } from '../components/SendDrawer';
import { StatusBadge } from '../components/StatusBadge';
import { isConfigured, loadSettings } from '../lib/settings';
import { useAppScope } from '../lib/apps';
import { useAuth } from '../lib/auth';
import { useFeedback } from '../components/feedback';
import {
  ensureFreshReplies,
  subscribeReplySyncErrors,
  subscribeWhenVisible,
} from '../lib/replyRefresh';
import { blastUnreadId, markRepliesSeen } from '../lib/replyInbox';
import {
  fetchCreator,
  fetchCreatorCorrespondence,
  fetchOutreachLogs,
  syncGmailReplies,
  updateCreatorStatus,
  type CreatorBlastSend,
  type EmailReply,
} from '../lib/supabase';
import type { Creator, OutreachLog, OutreachStatus } from '../lib/types';
import {
  outreachStatusChoices,
  statusPillLabel,
} from '../../../src/crm/statusLabel.ts';
import { resolveOutreachBranding } from '../../../src/pipeline/branding.ts';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export function CreatorDetail() {
  const { id } = useParams<{ id: string }>();
  const connected = isConfigured();
  const { session } = useAuth();
  const { toast } = useFeedback();
  const { apps, selected } = useAppScope();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [logs, setLogs] = useState<OutreachLog[]>([]);
  const [replies, setReplies] = useState<EmailReply[]>([]);
  const [blasts, setBlasts] = useState<CreatorBlastSend[]>([]);
  const [threadWarning, setThreadWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!connected || !id) {
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const c = await fetchCreator(id);
      if (!c) {
        setCreator(null);
        setLogs([]);
        setReplies([]);
        setBlasts([]);
        setThreadWarning(null);
        setError(null);
        return;
      }
      let warning: string | null = null;
      const [l, correspondence] = await Promise.all([
        fetchOutreachLogs(id),
        fetchCreatorCorrespondence(id, c.email).catch((err: unknown) => {
          warning = err instanceof Error ? err.message : 'Could not load replies';
          return { replies: [] as EmailReply[], blasts: [] as CreatorBlastSend[] };
        }),
      ]);
      setCreator(c);
      setLogs(l);
      setReplies(correspondence.replies);
      setBlasts(correspondence.blasts);
      setThreadWarning(warning);
      setError(null);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to load creator';
      if (quiet) {
        toast('error', message);
        return;
      }
      setError(message);
      setCreator(null);
      setLogs([]);
      setReplies([]);
      setBlasts([]);
      setThreadWarning(null);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [connected, id, toast]);

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
    if (!creator) return;
    const ids = replies.map((row) => row.id);
    if (creator.email) ids.push(blastUnreadId(creator.email));
    markRepliesSeen(ids);
  }, [creator, replies]);

  const onSyncReplies = async () => {
    const token = session?.access_token;
    if (!token) {
      toast('info', 'Sign in again before syncing replies.');
      return;
    }
    setSyncing(true);
    try {
      await syncGmailReplies(token);
      await load(true);
      toast('success', 'Replies synced.');
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Gmail sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const thread = useMemo(() => {
    if (!creator) return [];
    const hook = typeof creator.ai_variables?.hook === 'string' ? creator.ai_variables.hook : '';
    const settings = loadSettings();
    const linked = apps.find((app) => app.id === creator.app_id) ?? selected;
    const renderedBlasts: ThreadBlastInput[] = blasts.map((blast) => {
      const branding = resolveOutreachBranding({
        appName: linked?.name,
        appValueProp: linked?.value_prop,
        campaignAppName: blast.app_name,
        fallbackAppName: settings.appName,
        fallbackValueProp: settings.appValueProp,
      });
      const context = {
        handle: creator.handle,
        creatorName: creator.handle,
        displayName: creator.handle.replace(/^@/, ''),
        appName: branding.appName,
        platform: creator.platform,
        hook,
        valueProp: branding.valueProp,
      };
      const subject = blast.subject ? renderTemplate(blast.subject, context).trim() : '';
      const body = blast.body ? renderTemplate(blast.body, context).trim() : '';
      return {
        id: blast.id,
        email: blast.email,
        status: blast.status,
        sent_at: blast.sent_at,
        replied_at: blast.replied_at,
        provider_message_id: blast.provider_message_id,
        subject: subject || null,
        body: body || null,
      };
    });
    return buildOutreachThread({ logs, replies, blasts: renderedBlasts });
  }, [apps, blasts, creator, logs, replies, selected]);

  const onStatusChange = async (next: OutreachStatus) => {
    if (!creator) return;
    setStatusBusy(true);
    setMenuOpen(false);
    setStatusOpen(false);
    try {
      const updated = await updateCreatorStatus(creator.id, next);
      setCreator(updated);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Status update failed');
    } finally {
      setStatusBusy(false);
    }
  };

  if (!connected) {
    return (
      <div className="space-y-6">
        <ConnectBanner />
      </div>
    );
  }

  if (loading) {
    return <p className="text-slate-500">Loading…</p>;
  }

  if (error || !creator) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error || 'Creator not found'}
        </div>
        <Link to="/creators" className="btn-secondary">
          Back to creators
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <CreatorAvatar
            name={creator.handle}
            url={creator.avatar_url}
            creatorId={creator.id}
            size="lg"
          />
          <div className="min-w-0">
            <Link to="/creators" className="text-xs text-slate-500 hover:text-accent">
              ← Creators
            </Link>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
              {creator.handle}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={creator.outreach_status} />
              <PlatformMark platform={creator.platform} />
              <a
                href={creatorProfileUrl(creator)}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost !px-2 !py-1 text-xs"
                aria-label="Open profile"
                title="Open profile"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
              </a>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {creator.outreach_status !== 'sent' &&
            creator.outreach_status !== 'replied' &&
            creator.email && (
              <button type="button" className="btn-primary" onClick={() => setSendOpen(true)}>
                Send email
              </button>
            )}
          {creator.outreach_status !== 'replied' && (
            <button
              type="button"
              className="btn-secondary"
              disabled={statusBusy}
              onClick={() => void onStatusChange('replied')}
            >
              Mark replied
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              className="btn-ghost !px-2"
              aria-label="More"
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen((open) => !open);
                setStatusOpen(false);
              }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-line bg-surface-raised p-1 shadow-lg">
                <button
                  type="button"
                  className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-white/[0.04]"
                  onClick={() => setStatusOpen((open) => !open)}
                >
                  Set status…
                </button>
                {statusOpen && (
                  <div className="my-1 border-y border-line py-1">
                    {outreachStatusChoices().map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink-muted hover:bg-white/[0.04]"
                        disabled={
                          statusBusy ||
                          statusPillLabel(creator.outreach_status) === choice.label
                        }
                        onClick={() => void onStatusChange(choice.value)}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                )}
                {(creator.outreach_status === 'sent' || creator.outreach_status === 'replied') &&
                  creator.email && (
                    <button
                      type="button"
                      className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-white/[0.04]"
                      onClick={() => {
                        setMenuOpen(false);
                        setSendOpen(true);
                      }}
                    >
                      Resend
                    </button>
                  )}
                <button
                  type="button"
                  className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-ink-faint hover:bg-white/[0.04]"
                  disabled={statusBusy || creator.outreach_status === 'archived'}
                  onClick={() => void onStatusChange('archived')}
                >
                  Archive
                </button>
                <Link
                  to={`/creators/${creator.id}/edit`}
                  className="block rounded-md px-2 py-1.5 text-sm text-ink-muted hover:bg-white/[0.04]"
                >
                  Edit profile
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4">
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">Profile</h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="label">Email</dt>
              <dd className="text-sm text-slate-200">{creator.email || '—'}</dd>
            </div>
            <div>
              <dt className="label">Followers</dt>
              <dd className="text-sm tabular-nums text-slate-200">
                {creator.follower_count?.toLocaleString('en-GB') ?? '—'}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="label">Bio</dt>
              <dd className="whitespace-pre-wrap text-sm text-slate-300">
                {creator.bio || '—'}
              </dd>
            </div>
            <div>
              <dt className="label">Created</dt>
              <dd className="text-sm text-slate-400">{formatDate(creator.created_at)}</dd>
            </div>
            <div>
              <dt className="label">Updated</dt>
              <dd className="text-sm text-slate-400">{formatDate(creator.updated_at)}</dd>
            </div>
          </dl>
          <AiVariablesDisclosure vars={creator.ai_variables} />
        </div>
      </div>
      <SendDrawer
        open={sendOpen}
        targets={[
          {
            id: creator.id,
            handle: creator.handle,
            email: creator.email,
            platform: creator.platform,
            bio: creator.bio,
            hook: typeof creator.ai_variables?.hook === 'string' ? creator.ai_variables.hook : '',
            niches: Array.isArray(creator.ai_variables?.niches)
              ? creator.ai_variables.niches.map(String)
              : [],
            captions: (creator.top_videos ?? [])
              .map((video) => video.caption)
              .filter((caption): caption is string => Boolean(caption)),
            videos: (creator.top_videos ?? []).map((video) => ({
              caption: video.caption,
              video_url: video.video_url,
              scraped_at: video.scraped_at ?? null,
            })),
            foundAt: creator.created_at,
            topic:
              creator.top_videos?.map((video) => video.caption).find((caption) => caption) ?? null,
          } satisfies SendTarget,
        ]}
        appName={
          resolveOutreachBranding({
            appName: (apps.find((app) => app.id === creator.app_id) ?? selected)?.name,
            campaignAppName: loadSettings().appName,
          }).appName
        }
        valueProp={
          resolveOutreachBranding({
            appValueProp: (apps.find((app) => app.id === creator.app_id) ?? selected)?.value_prop,
            fallbackValueProp: loadSettings().appValueProp,
          }).valueProp
        }
        storeUrl={
          apps.find((app) => app.id === creator.app_id)?.store_url ?? selected?.store_url
        }
        appId={creator.app_id}
        onClose={() => setSendOpen(false)}
        onFinished={() => void load()}
      />

      <div className="card">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-200">Conversation</h2>
          <button
            type="button"
            className="btn-ghost !px-2 !py-1.5"
            aria-label="Sync replies"
            title="Sync replies"
            disabled={syncing}
            onClick={() => void onSyncReplies()}
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {threadWarning && <p className="mb-3 text-sm text-amber-200">{threadWarning}</p>}
        <OutreachThread items={thread} />
      </div>
    </div>
  );
}
