import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Copy, Pencil, Plus, Trash2, X } from 'lucide-react';
import { IconButton } from '../components/IconButton';
import { AudienceDrawer } from '../components/AudienceDrawer';
import { ConnectBanner } from '../components/ConnectBanner';
import { Drawer } from '../components/Drawer';
import { useFeedback } from '../components/feedback';
import { ShowMore, useExpandedList } from '../components/ShowMore';
import { campaignsCacheKey } from '../lib/prefetch';
import { getCache, putCache } from '../lib/shellCache';
import { useAppScope } from '../lib/apps';
import { isConfigured } from '../lib/settings';
import {
  deleteCampaign,
  deleteCampaignPreset,
  duplicateCampaign,
  fetchCampaignPresets,
  fetchCampaigns,
} from '../lib/supabase';
import type { Campaign, CampaignPreset } from '../lib/types';
import { CAMPAIGN_STATUS_LABELS } from '../lib/types';

const STATUS_STYLES: Record<string, string> = {
  draft: 'border-slate-800 bg-white/[0.04] text-slate-400',
  searching: 'border-amber-500/30 bg-amber-500/10 text-amber-300/90',
  ready: 'border-sky-500/30 bg-sky-500/10 text-sky-300/90',
  outreaching: 'border-sky-500/30 bg-sky-500/10 text-sky-300/90',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300/90',
};

function formatFollowers(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function presetBlurb(preset: CampaignPreset): string {
  const range = `${formatFollowers(preset.follower_min)}–${formatFollowers(preset.follower_max)}`;
  const eng =
    preset.engagement_rate_min != null ? `eng > ${preset.engagement_rate_min}%` : '';
  const tags = (preset.hashtags ?? []).slice(0, 2).join(' ');
  return [range, eng, tags].filter(Boolean).join(' · ');
}

const PRESETS = [
  {
    key: 'micro',
    title: 'Micro-Influencers',
    blurb: '5K–35K · eng > 4%',
    followers: '5K–35K',
    engagement: '> 4%',
    niches: 'lifestyle, fitness',
    hashtags: '—',
  },
  {
    key: 'saas',
    title: 'SaaS Tech Reviewers',
    blurb: '10K–100K · eng > 3%',
    followers: '10K–100K',
    engagement: '> 3%',
    niches: 'tech, saas',
    hashtags: '—',
  },
  {
    key: 'ugc',
    title: 'UGC Creators',
    blurb: '5K–50K · eng > 5%',
    followers: '5K–50K',
    engagement: '> 5%',
    niches: 'ugc, lifestyle',
    hashtags: '—',
  },
];

export function Campaigns() {
  const connected = isConfigured();
  const { appId, ready, selected } = useAppScope();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { undoable } = useFeedback();
  const campaignList = useExpandedList();
  const presetList = useExpandedList();
  const seeded = appId ? getCache<Campaign[]>(campaignsCacheKey(appId)) : null;
  const [campaigns, setCampaigns] = useState<Campaign[]>(seeded ?? []);
  const [loading, setLoading] = useState(connected && !seeded);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [presets, setPresets] = useState<CampaignPreset[]>([]);

  const load = useCallback(() => {
    if (!connected || !ready || !appId) {
      setCampaigns([]);
      setLoading(false);
      return;
    }
    const hit = getCache<Campaign[]>(campaignsCacheKey(appId));
    if (hit) {
      setCampaigns(hit);
      setLoading(false);
    } else {
      setLoading(true);
    }
    fetchCampaigns(appId)
      .then((rows) => {
        setCampaigns(rows);
        putCache(campaignsCacheKey(appId), rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load campaigns');
        setCampaigns([]);
      })
      .finally(() => setLoading(false));
  }, [connected, ready, appId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!connected || !ready || !appId) {
      setPresets([]);
      return;
    }
    let cancelled = false;
    fetchCampaignPresets(appId)
      .then((rows) => {
        if (!cancelled) setPresets(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPresets([]);
          setError(e instanceof Error ? e.message : 'Could not load saved presets');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connected, ready, appId]);

  const openQuery = (key: 'audience' | 'preset', value: string) => {
    const next = new URLSearchParams(params);
    next.delete(key === 'audience' ? 'preset' : 'audience');
    next.set(key, value);
    setParams(next);
  };

  const removePreset = (preset: CampaignPreset) => {
    const snapshot = presets;
    setPresets((rows) => rows.filter((row) => row.id !== preset.id));
    undoable(
      `Removed “${preset.name}”.`,
      () => deleteCampaignPreset(preset.id),
      () => setPresets(snapshot),
    );
  };

  const onDuplicate = async (c: Campaign) => {
    setBusyId(c.id);
    setError(null);
    try {
      const copy = await duplicateCampaign(c);
      navigate(`/campaigns/${copy.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Duplicate failed');
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = (c: Campaign) => {
    const snapshot = campaigns;
    setCampaigns((rows) => rows.filter((row) => row.id !== c.id));
    undoable(
      `Deleted “${c.name}”.`,
      () => deleteCampaign(c.id),
      () => setCampaigns(snapshot),
    );
  };

  return (
    <div className="page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title">Campaigns</h1>
        </div>
        <Link to="/campaigns/new" className="btn-primary">
          <Plus className="h-4 w-4" />
          New campaign
        </Link>
      </div>

      {!connected && <ConnectBanner />}

      <section className="w-full">
        <h2 className="kicker mb-3">Presets</h2>
        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => openQuery('preset', p.key)}
              className="panel w-full p-4 text-left shadow-none transition hover:border-line-strong"
            >
              <p className="text-sm font-medium text-ink">{p.title}</p>
              <p className="mt-1 text-sm text-ink-faint">{p.blurb}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="w-full">
        <h2 className="kicker mb-3">Your Presets</h2>
        {presets.length === 0 ? (
          <p className="text-sm text-ink-faint">
            No saved presets yet. Use Save as preset when you create a campaign.
          </p>
        ) : (
          <>
            <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {presetList.slice(presets).map((preset) => (
                <div key={preset.id} className="panel relative w-full p-4 shadow-none">
                  <button
                    type="button"
                    className="w-full pr-8 text-left"
                    onClick={() => openQuery('preset', preset.id)}
                  >
                    <p className="text-sm font-medium text-ink">{preset.name}</p>
                    <p className="mt-1 text-sm text-ink-faint">{presetBlurb(preset)}</p>
                  </button>
                  <IconButton
                    label={`Remove ${preset.name}`}
                    tone="danger"
                    className="!absolute right-2 top-2"
                    onClick={() => void removePreset(preset)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              ))}
            </div>
            <ShowMore
              total={presets.length}
              expanded={presetList.expanded}
              onToggle={presetList.toggle}
              spaced
            />
          </>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="panel w-full shadow-none">
        {loading && (
          <div className="px-4 py-8 text-center text-slate-500">Loading…</div>
        )}
        {!loading && campaigns.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-slate-400">
              {connected
                ? `No campaigns for ${selected?.name || 'this app'} yet.`
                : 'Connect Supabase to load campaigns.'}
            </p>
          </div>
        )}
        {!loading &&
          campaignList.slice(campaigns).map((c) => (
            <div
              key={c.id}
              role="link"
              tabIndex={0}
              className="relative flex cursor-pointer flex-col gap-3 border-b border-slate-800 px-4 py-3 last:border-b-0 hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between"
              onClick={() => navigate(`/campaigns/${c.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate(`/campaigns/${c.id}`);
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-white">
                    {c.name}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_STYLES[c.status] ?? STATUS_STYLES.draft}`}
                  >
                    {CAMPAIGN_STATUS_LABELS[c.status] ?? c.status}
                  </span>
                  {c.campaign_type === 'direct_blast' ? (
                    <span className="inline-flex items-center rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-200">
                      Direct Blast
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-medium text-violet-200">
                      Discovery
                    </span>
                  )}
                </div>
              </div>

              <div
                className="flex items-center gap-0.5"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <IconButton
                  label="Edit"
                  disabled={busyId === c.id}
                  onClick={() => navigate(`/campaigns/${c.id}`)}
                >
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton
                  label="Duplicate"
                  disabled={busyId === c.id}
                  onClick={() => void onDuplicate(c)}
                >
                  <Copy className="h-4 w-4" />
                </IconButton>
                <IconButton
                  label="Delete"
                  tone="danger"
                  disabled={busyId === c.id}
                  onClick={() => onDelete(c)}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          ))}
        {!loading && (
          <ShowMore
            total={campaigns.length}
            expanded={campaignList.expanded}
            onToggle={campaignList.toggle}
          />
        )}
      </div>

      <AudienceDrawer
        groupId={params.get('audience')}
        onClose={() => navigate(-1)}
      />
      <PresetDrawer
        presetKey={params.get('preset')}
        saved={presets}
        onClose={() => navigate(-1)}
        onUse={(key) => navigate(`/campaigns/new?preset=${key}`)}
      />
    </div>
  );
}

function PresetDrawer({
  presetKey,
  saved,
  onClose,
  onUse,
}: {
  presetKey: string | null;
  saved: CampaignPreset[];
  onClose: () => void;
  onUse: (key: string) => void;
}) {
  const builtin = PRESETS.find((preset) => preset.key === presetKey);
  const custom = saved.find((preset) => preset.id === presetKey);
  const title = builtin?.title || custom?.name || 'Preset';
  const open = Boolean(presetKey && (builtin || custom));
  return (
    <Drawer open={open} title={title} onClose={onClose}>
      <dl className="space-y-3 text-sm">
        {builtin && (
          <>
            <div>
              <dt className="text-ink-faint">Followers</dt>
              <dd className="mt-1 text-ink">{builtin.followers}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Engagement</dt>
              <dd className="mt-1 text-ink">{builtin.engagement}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Niches</dt>
              <dd className="mt-1 text-ink">{builtin.niches}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Hashtags</dt>
              <dd className="mt-1 text-ink">{builtin.hashtags}</dd>
            </div>
          </>
        )}
        {custom && (
          <>
            <div>
              <dt className="text-ink-faint">Followers</dt>
              <dd className="mt-1 text-ink">
                {formatFollowers(custom.follower_min)}–{formatFollowers(custom.follower_max)}
              </dd>
            </div>
            <div>
              <dt className="text-ink-faint">Engagement</dt>
              <dd className="mt-1 text-ink">
                {custom.engagement_rate_min != null ? `> ${custom.engagement_rate_min}%` : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-ink-faint">Niches</dt>
              <dd className="mt-1 text-ink">{(custom.niches ?? []).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Hashtags</dt>
              <dd className="mt-1 text-ink">{(custom.hashtags ?? []).join(' ') || '—'}</dd>
            </div>
          </>
        )}
      </dl>
      {presetKey && (
        <button type="button" className="btn-primary mt-6 w-full" onClick={() => onUse(presetKey)}>
          Use preset
        </button>
      )}
    </Drawer>
  );
}
