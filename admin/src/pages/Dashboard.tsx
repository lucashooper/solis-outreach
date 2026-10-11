import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CircleAlert,
  Clock,
  Mail,
  MessageSquareReply,
  Plus,
  Radar,
  Rocket,
  Send,
  Timer,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { ConnectBanner } from '../components/ConnectBanner';
import { TemplatePerformanceCard } from '../components/TemplatePerformance';
import { useAuth } from '../lib/auth';
import { useAppScope } from '../lib/apps';
import { displayNameOf, londonGreeting } from '../lib/displayName';
import { isConfigured } from '../lib/settings';
import {
  fetchAnalytics,
  fetchCampaigns,
  fetchEmailReplies,
  fetchStatusCounts,
  type EmailReply,
} from '../lib/supabase';
import type { AnalyticsSummary } from '../lib/supabase';
import type { Campaign, StatusCounts } from '../lib/types';
import { CAMPAIGN_STATUS_LABELS } from '../lib/types';
import { dashboardCacheKey, type DashboardCache } from '../lib/prefetch';
import { getCache, putCache } from '../lib/shellCache';

const EMPTY: StatusCounts = {
  pending: 0,
  pending_review: 0,
  queued: 0,
  sent: 0,
  replied: 0,
  archived: 0,
  total: 0,
};

const EMPTY_ANALYTICS: AnalyticsSummary = {
  totalSent: 0,
  openRate: null,
  openRateLabel: '\u2014',
  replyRate: 0,
  replied: 0,
  topPerformingCampaign: null,
  blastSent: 0,
  blastFailed: 0,
  blastOpened: 0,
};

function countText(value: number | null | undefined, known: boolean): string {
  if (!known || value == null || !Number.isFinite(value)) return '\u2014';
  return String(value);
}

function percentText(value: number | null | undefined, known: boolean): string {
  if (!known || value == null || !Number.isFinite(value)) return '\u2014';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

function when(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/London',
  });
}

interface Activity {
  id: string;
  at: string;
  title: string;
  detail: string;
  href: string;
  kind: 'reply' | 'campaign';
}

function buildActivity(replies: EmailReply[], campaigns: Campaign[]): Activity[] {
  const replyItems: Activity[] = replies.slice(0, 4).map((reply) => ({
    id: `reply:${reply.id}`,
    at: reply.received_at || reply.created_at,
    title: reply.from_name?.trim() || reply.from_email,
    detail: (reply.snippet || reply.subject || 'Reply').replace(/\s+/g, ' ').trim(),
    href: reply.creator_id ? `/crm?creator=${reply.creator_id}` : '/creators?view=replies',
    kind: 'reply',
  }));
  const campaignItems: Activity[] = campaigns.slice(0, 4).map((campaign) => ({
    id: `campaign:${campaign.id}`,
    at: campaign.updated_at || campaign.created_at,
    title: campaign.name,
    detail: CAMPAIGN_STATUS_LABELS[campaign.status] || campaign.status,
    href: `/campaigns/${campaign.id}`,
    kind: 'campaign',
  }));
  return [...replyItems, ...campaignItems]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 6);
}

export function Dashboard() {
  const connected = isConfigured();
  const { user } = useAuth();
  const { appId, selected, ready, error: appError } = useAppScope();
  const cached = appId ? getCache<DashboardCache>(dashboardCacheKey(appId)) : null;
  const [counts, setCounts] = useState<StatusCounts>(cached?.counts ?? EMPTY);
  const [analytics, setAnalytics] = useState<AnalyticsSummary>(cached?.analytics ?? EMPTY_ANALYTICS);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(connected && !cached);

  useEffect(() => {
    if (!connected || !ready || !appId) {
      setCounts(EMPTY);
      setAnalytics(EMPTY_ANALYTICS);
      setActivity([]);
      setLoading(false);
      return;
    }
    const hit = getCache<DashboardCache>(dashboardCacheKey(appId));
    if (hit) {
      setCounts(hit.counts);
      if (hit.analytics) setAnalytics(hit.analytics);
      setLoading(false);
    } else {
      setLoading(true);
    }
    let cancelled = false;
    Promise.all([
      fetchStatusCounts(appId),
      fetchAnalytics(appId).catch(() => EMPTY_ANALYTICS),
      fetchEmailReplies({ appId }).catch(() => [] as EmailReply[]),
      fetchCampaigns(appId).catch(() => [] as Campaign[]),
    ])
      .then(([c, a, replies, campaigns]) => {
        if (!cancelled) {
          setCounts(c);
          setAnalytics(a);
          setActivity(buildActivity(replies, campaigns));
          putCache<DashboardCache>(dashboardCacheKey(appId), { counts: c, analytics: a });
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load');
          setCounts(EMPTY);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, ready, appId]);

  const known = !loading;
  const name = displayNameOf(user);
  const quiet =
    known &&
    analytics.totalSent === 0 &&
    analytics.replied === 0 &&
    analytics.blastSent === 0 &&
    counts.pending + counts.pending_review + counts.queued === 0 &&
    counts.total === 0;
  const unsent = counts.pending + counts.pending_review + counts.queued;
  const summary = !known
    ? 'Loading the latest numbers.'
    : quiet
      ? 'Nothing sent yet. Discover a niche or start a campaign.'
      : `${analytics.totalSent} sent, ${analytics.replied} replied, and ${unsent} unsent.`;

  const cards: Array<{
    key: string;
    label: string;
    value: string;
    icon: LucideIcon;
    href?: string;
  }> = [
    { key: 'sent', label: 'Total sent', value: countText(analytics.totalSent, known), icon: Mail, href: '/creators?status=sent' },
    { key: 'open', label: 'Open rate', value: percentText(analytics.openRate, known), icon: TrendingUp },
    { key: 'reply', label: 'Reply rate', value: percentText(analytics.replyRate, known), icon: MessageSquareReply },
    { key: 'replied', label: 'Replied', value: countText(analytics.replied, known), icon: Users, href: '/creators?status=replied' },
    { key: 'pending', label: 'Unsent', value: countText(unsent, known), icon: Clock, href: '/creators?status=unsent' },
    { key: 'queued', label: 'Queued', value: countText(counts.queued, known), icon: Timer, href: '/creators?status=unsent' },
    { key: 'blastSent', label: 'Blast sent', value: countText(analytics.blastSent, known), icon: Send },
    { key: 'blastFailed', label: 'Blast failed', value: countText(analytics.blastFailed, known), icon: CircleAlert },
  ];

  return (
    <div className="page">
      <section className="section flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">
            {londonGreeting()}, {name}.
          </h1>
          <p className="mt-2 text-sm text-ink-muted">{summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/campaigns/new" className="btn-primary">
            <Plus className="h-4 w-4" />
            New campaign
          </Link>
          <Link to="/discover" className="btn-secondary">
            <Radar className="h-4 w-4" />
            Discover
          </Link>
        </div>
      </section>

      {!connected && <ConnectBanner />}
      {(error || appError) && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
          {error || appError}
        </div>
      )}

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          const body = (
            <>
              <p className="flex items-center gap-1.5 text-[13px] text-ink-muted">
                <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={1.75} />
                {card.label}
              </p>
              <p className="mt-1.5 text-2xl font-semibold leading-none tracking-tight text-ink tabular-nums">
                {card.value}
              </p>
            </>
          );
          const className = 'section block !px-3.5 !py-2.5';
          return card.href ? (
            <Link key={card.key} to={card.href} className={`${className} hover:border-line-strong`}>
              {body}
            </Link>
          ) : (
            <article key={card.key} className={className}>
              {body}
            </article>
          );
        })}
      </div>

      {connected && ready && appId && <TemplatePerformanceCard appId={appId} />}

      {activity.length > 0 && (
        <section className="section">
          <h2 className="text-sm font-medium text-ink">Recent</h2>
          <ul className="mt-3 divide-y divide-line">
            {activity.map((item) => {
              const Icon = item.kind === 'reply' ? MessageSquareReply : Radar;
              return (
                <li key={item.id}>
                  <Link to={item.href} className="flex items-center gap-3 py-3 hover:text-accent">
                    <Icon className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{item.title}</p>
                      <p className="truncate text-xs text-ink-faint">{item.detail}</p>
                    </div>
                    <span className="shrink-0 text-xs text-ink-faint">{when(item.at)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {connected && ready && !loading && counts.total === 0 && !error && (
        <div className="panel w-full border-dashed bg-transparent px-6 py-12 text-center shadow-none">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface-raised text-accent">
            <Rocket className="h-5 w-5" />
          </div>
          <p className="text-ink">No creators in {selected?.name || 'this app'} yet.</p>
          <p className="mt-1 text-sm text-ink-faint">Discover a niche, or launch a direct blast.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link to="/discover" className="btn-primary inline-flex">
              Discover
            </Link>
            <Link to="/campaigns/new?type=direct_blast" className="btn-secondary inline-flex">
              Direct blast
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
