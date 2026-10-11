import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Radar, Rocket } from 'lucide-react';
import { usablePublicEmail } from '../../../src/discovery/email.ts';
import {
  discoveryFunnelMessage,
  showFunnelExplanation,
  suggestIncludeExisting,
  suggestWidenRange,
  widenedFollowerRange,
} from '../../../src/discovery/funnel.ts';
import { suggestBusinessHashtags } from '../../../src/discovery/hashtags.ts';
import {
  storedSearchSummary,
  toDiscoverForm,
  type StoredDiscoverySearch,
} from '../../../src/discovery/historyForm.ts';
import type { HashtagYield } from '../../../src/discovery/hashtagYield.ts';
import { showsWhenIncludeExisting } from '../../../src/discovery/campaignBatch.ts';
import { shortfallSheet } from '../../../src/discovery/shortfall.ts';
import type { DiscoverySource } from '../../../src/discovery/network.ts';
import type { DiscoveryFunnel } from '../../../src/discovery/types.ts';
import { DiscoveryCostNote } from '../components/DiscoveryCostNote';
import { FilterToggleRow, InfoTip } from '../components/InfoTip';
import { NarrowRangeHint } from '../components/NarrowRangeHint';
import { DiscoverySourceControl } from '../components/DiscoverySourceControl';
import { CreatorAvatar } from '../components/CreatorAvatar';
import { PlatformMark } from '../components/PlatformMark';
import { AiFallbackToggle } from '../components/AiFallbackToggle';
import { DiscoveryFunnelNote } from '../components/DiscoveryFunnelNote';
import { DiscoveryShortfallSheet } from '../components/DiscoveryShortfallSheet';
import { HashtagYieldNote } from '../components/HashtagYieldNote';
import { IncludeExistingSwitch } from '../components/IncludeExistingSwitch';
import { RequirePublicEmailToggle } from '../components/RequirePublicEmailToggle';
import { ConnectBanner } from '../components/ConnectBanner';
import { DiscoveryPresets } from '../components/DiscoveryPresets';
import { LaunchCampaignModal } from '../components/LaunchCampaignModal';
import { SendDrawer, type SendTarget } from '../components/SendDrawer';
import { ThinkingStatus } from '../components/ThinkingStatus';
import { useFeedback } from '../components/feedback';
import { useAppScope } from '../lib/apps';
import { loadSettings, isConfigured } from '../lib/settings';
import {
  addDiscoveredCreators,
  createDiscoveryPreset,
  deleteDiscoveryPreset,
  fetchCreators,
  fetchDiscoveryPresets,
  renameDiscoveryPreset,
  fetchDiscoverHistory,
  fetchDiscoveryAvailability,
  fetchStoredSearch,
  lookupCreatorsByHandle,
  continueDiscoverySearch,
  pollDiscoverySearch,
  startDiscoverySearch,
  type DiscoverHistoryItem,
  type DiscoveryHit,
  type DiscoveryPreset,
} from '../lib/supabase';
import { CAMPAIGN_STATUS_LABELS } from '../lib/types';

const REQUIRE_EMAIL_KEY = 'solis-require-public-email';
const MIN_CREATORS_KEY = 'solis-min-creators';

const VOLUME_PRESETS = [
  { id: 'conservative', label: 'Conservative', limit: '15' },
  { id: 'standard', label: 'Standard', limit: '40' },
  { id: 'aggressive', label: 'Aggressive', limit: '80' },
] as const;

function readMinCreators(): string {
  try {
    const raw = localStorage.getItem(MIN_CREATORS_KEY);
    if (raw && Number(raw) >= 1) return String(Math.min(100, Math.round(Number(raw))));
  } catch {
    /* private mode */
  }
  return '';
}

function readRequirePublicEmail(): boolean {
  try {
    const raw = localStorage.getItem(REQUIRE_EMAIL_KEY);
    if (raw === '0' || raw === 'false') return false;
  } catch {
    /* private mode */
  }
  return true;
}

function storedFromHistory(item: DiscoverHistoryItem): StoredDiscoverySearch {
  return {
    niche: item.niche,
    hashtags: item.hashtags,
    platforms: item.platforms,
    followerMin: item.follower_min,
    followerMax: item.follower_max,
    resultLimit: item.result_limit,
    minCreators: item.min_creators,
    requirePublicEmail: item.require_public_email,
    includeExisting: item.include_existing,
  };
}

function rememberSearchPrefs(requireEmail: boolean, minCreators: string) {
  try {
    localStorage.setItem(REQUIRE_EMAIL_KEY, requireEmail ? '1' : '0');
    if (minCreators.trim()) localStorage.setItem(MIN_CREATORS_KEY, minCreators.trim());
    else localStorage.removeItem(MIN_CREATORS_KEY);
  } catch {
    /* private mode */
  }
}

function shortfallWasAccepted(id: string): boolean {
  try {
    return sessionStorage.getItem(`solis-shortfall-accept:${id}`) === '1';
  } catch {
    return false;
  }
}

function rememberShortfallAccepted(id: string): void {
  try {
    sessionStorage.setItem(`solis-shortfall-accept:${id}`, '1');
  } catch {
    /* private mode */
  }
}

function forgetShortfallAccepted(id: string): void {
  try {
    sessionStorage.removeItem(`solis-shortfall-accept:${id}`);
  } catch {
    /* private mode */
  }
}

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function HistoryRow({
  item,
  active,
  reveal,
  onOpen,
}: {
  item: DiscoverHistoryItem;
  active: boolean;
  reveal: number;
  onOpen: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summary = storedSearchSummary(storedFromHistory(item));
  const when = new Date(item.created_at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/London',
  });
  const status =
    CAMPAIGN_STATUS_LABELS[item.status as keyof typeof CAMPAIGN_STATUS_LABELS] ||
    item.status ||
    'Saved';

  useEffect(() => {
    if (active && detailsRef.current) detailsRef.current.open = true;
  }, [active, reveal]);

  return (
    <li className={active ? 'bg-white/[0.03] px-4 py-3' : 'px-4 py-3'}>
      <button
        type="button"
        className="w-full rounded-lg text-left hover:bg-white/[0.04]"
        aria-pressed={active}
        title={summary}
        onClick={onOpen}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-sm font-medium text-ink">{item.name}</p>
          <span className="shrink-0 text-xs text-ink-faint">{status}</span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-faint">
          <span className="max-w-[14rem] truncate">
            {item.niche || item.hashtags.slice(0, 3).join(' ') || '—'}
          </span>
          <span aria-hidden>·</span>
          {item.platforms.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              {item.platforms.map((platform) => (
                <PlatformMark key={platform} platform={platform} />
              ))}
            </span>
          ) : (
            <span>—</span>
          )}
          <span aria-hidden>·</span>
          <span>
            {item.found} creator{item.found === 1 ? '' : 's'}
          </span>
          <span aria-hidden>·</span>
          <span>{when}</span>
        </p>
        {active && <p className="mt-1 text-xs text-accent">In the search form</p>}
      </button>
      {item.error && <p className="mt-1 text-xs text-red-300">{item.error}</p>}
      <details ref={detailsRef} className="mt-2 text-xs text-ink-faint">
        <summary className="cursor-pointer">Details</summary>
        <p className="mt-1">{summary}</p>
        {item.funnel && <DiscoveryFunnelNote funnel={item.funnel} compact bare />}
      </details>
    </li>
  );
}

export function Discover() {
  const connected = isConfigured();
  const { appId, selected, ready } = useAppScope();
  const [niche, setNiche] = useState('fitness');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [platform, setPlatform] = useState<'tiktok' | 'instagram' | 'both'>('tiktok');
  const [followerMin, setFollowerMin] = useState('5000');
  const [followerMax, setFollowerMax] = useState('50000');
  const [resultLimit, setResultLimit] = useState('10');
  const [minCreators, setMinCreators] = useState(readMinCreators);
  const [requireEmail, setRequireEmail] = useState(readRequirePublicEmail);
  const [discoverySource, setDiscoverySource] = useState<DiscoverySource>('both');
  const [aiFallback, setAiFallback] = useState(false);
  const [hashtagYield, setHashtagYield] = useState<HashtagYield[]>([]);
  const [hits, setHits] = useState<DiscoveryHit[]>([]);
  const [history, setHistory] = useState<DiscoverHistoryItem[]>([]);
  const [historyName, setHistoryName] = useState<string | null>(null);
  const [activeHistoryKey, setActiveHistoryKey] = useState<string | null>(null);
  const [historyReveal, setHistoryReveal] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [stageHint, setStageHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [sendTargets, setSendTargets] = useState<SendTarget[] | null>(null);
  const [launchHits, setLaunchHits] = useState<DiscoveryHit[] | null>(null);
  const [searchFunnel, setSearchFunnel] = useState<DiscoveryFunnel | null>(null);
  const [searchJobId, setSearchJobId] = useState<string | null>(null);
  const [continuing, setContinuing] = useState<'expand' | 'relax' | 'custom' | null>(null);
  const [shortfallDismissed, setShortfallDismissed] = useState(false);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [presets, setPresets] = useState<DiscoveryPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [namingPreset, setNamingPreset] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const { toast, undoable } = useFeedback();

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    fetchDiscoveryAvailability()
      .then((status) => {
        if (cancelled) return;
        setConfigured(status.configured);
        if (!status.configured) setNotice(status.message);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConfigured(false);
        setNotice(err instanceof Error ? err.message : 'Discovery is unavailable.');
      });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  useEffect(() => {
    if (!connected || !ready || !appId) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    fetchDiscoverHistory(appId)
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, ready, appId]);

  useEffect(() => {
    if (!connected || !ready || !appId) {
      setPresets([]);
      return;
    }
    let cancelled = false;
    fetchDiscoveryPresets(appId)
      .then((rows) => {
        if (!cancelled) setPresets(rows);
      })
      .catch(() => {
        if (!cancelled) setPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, ready, appId]);

  const keyFor = (hit: DiscoveryHit) => `${hit.platform}:${hit.handle.toLowerCase()}`;
  const batchRelaxed = searchFunnel?.emailRelaxed === true;
  const allowHit = (hit: DiscoveryHit) =>
    batchRelaxed || !requireEmail || Boolean(usablePublicEmail(hit.email));
  const hitsRef = useRef<DiscoveryHit[]>([]);
  const seenHits = useRef(new Set<string>());
  const [freshHits, setFreshHits] = useState<Set<string>>(new Set());

  const publishHits = (next: DiscoveryHit[]) => {
    hitsRef.current = next;
    setHits(next);
    const added: string[] = [];
    for (const hit of next) {
      const key = keyFor(hit);
      if (seenHits.current.has(key)) continue;
      seenHits.current.add(key);
      added.push(key);
    }
    if (added.length > 0) {
      setFreshHits((current) => {
        const merged = new Set(current);
        for (const key of added) merged.add(key);
        return merged;
      });
    }
  };

  const mergeHits = (current: DiscoveryHit[], incoming: DiscoveryHit[]): DiscoveryHit[] => {
    const byKey = new Map(current.map((hit) => [keyFor(hit), hit]));
    const order = current.map((hit) => keyFor(hit));
    for (const hit of incoming) {
      const key = keyFor(hit);
      if (!byKey.has(key)) order.push(key);
      byKey.set(key, hit);
    }
    return order.map((key) => byKey.get(key)!);
  };
  const searchNiche =
    niche.trim() ||
    hashtags
      .map((tag) => tag.replace(/^#/, ''))
      .filter(Boolean)
      .join(' ')
      .slice(0, 80);

  const showSearchError = (message: string) => {
    setError(message);
    toast('error', message);
  };

  const asHit = (row: {
    handle: string;
    platform: string;
    bio: string | null;
    email: string | null;
    follower_count: number | null;
    engagement_rate?: number | null;
    profile_url?: string | null;
    avatar_url?: string | null;
  }): DiscoveryHit | null => {
    if (row.platform !== 'tiktok' && row.platform !== 'instagram') return null;
    return {
      handle: row.handle.replace(/^@/, ''),
      platform: row.platform,
      bio: row.bio || '',
      email: row.email,
      follower_count: row.follower_count ?? 0,
      engagement_rate: row.engagement_rate ?? null,
      profile_url: row.profile_url || '',
      avatar_url: row.avatar_url ?? null,
    };
  };

  const applyStoredSearch = (stored: StoredDiscoverySearch) => {
    const form = toDiscoverForm(stored);
    setNiche(form.niche);
    setHashtags(form.hashtags);
    setPlatform(form.platform);
    setFollowerMin(form.followerMin);
    setFollowerMax(form.followerMax);
    setResultLimit(form.resultLimit);
    setMinCreators(form.minCreators);
    setRequireEmail(form.requirePublicEmail);
    setIncludeExisting(form.includeExisting);
    rememberSearchPrefs(form.requirePublicEmail, form.minCreators);
  };

  const openHistory = async (item: DiscoverHistoryItem) => {
    setError(null);
    setNotice(null);
    setPicked({});
    setHistoryName(item.name);
    setActiveHistoryKey(`${item.kind}:${item.id}`);
    setHistoryReveal((value) => value + 1);
    setSearchFunnel(item.kind === 'search' ? item.funnel : null);
    setSearchJobId(item.kind === 'search' ? item.id : null);
    setShortfallDismissed(item.kind === 'search' && shortfallWasAccepted(item.id));
    applyStoredSearch(storedFromHistory(item));
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('info', `Loaded “${item.name}” into the search form.`);
    try {
      if (item.kind === 'search') {
        setHits(await fetchStoredSearch(item.id));
        return;
      }
      const creators = await fetchCreators({ campaignId: item.id });
      setHits(creators.map(asHit).filter((hit): hit is DiscoveryHit => hit != null));
    } catch (err) {
      setHits([]);
      setError(err instanceof Error ? err.message : 'Could not open that search');
    }
  };

  const applyPreset = (preset: DiscoveryPreset) => {
    setNiche(preset.niche);
    setHashtags([]);
    setPlatform(preset.platform);
    setIncludeExisting(preset.include_existing === true);
    setHistoryName(null);
    setActiveHistoryKey(null);
    setFollowerMin(preset.follower_min != null ? String(preset.follower_min) : '');
    setFollowerMax(preset.follower_max != null ? String(preset.follower_max) : '');
    setResultLimit(String(preset.result_limit || 10));
    const presetMin =
      preset.min_creators != null && preset.min_creators >= 1 ? String(preset.min_creators) : '';
    setMinCreators(presetMin);
    const next = preset.require_public_email !== false;
    setRequireEmail(next);
    rememberSearchPrefs(next, presetMin);
  };

  const followerNumbers = ():
    | { ok: false; error: string }
    | {
        ok: true;
        min: number | null;
        max: number | null;
        limit: number;
        minCreators: number | null;
      } => {
    const min = followerMin.trim() ? Number(followerMin) : null;
    const max = followerMax.trim() ? Number(followerMax) : null;
    const limit = Number(resultLimit);
    if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) {
      return { ok: false, error: 'Follower range must be a number.' };
    }
    if (!Number.isFinite(limit) || limit < 1) {
      return { ok: false, error: 'Result limit must be at least 1.' };
    }
    const minimum = minCreators.trim() ? Number(minCreators) : null;
    if (minimum != null && (!Number.isFinite(minimum) || minimum < 1)) {
      return { ok: false, error: 'Minimum creators must be at least 1.' };
    }
    return {
      ok: true,
      min,
      max,
      limit: Math.min(100, Math.round(limit)),
      minCreators: minimum != null ? Math.min(100, Math.round(minimum)) : null,
    };
  };

  const onSavePreset = async () => {
    if (!appId) {
      setError('Choose an app before saving a preset.');
      return;
    }
    const parsed = followerNumbers();
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const name = (presetName || searchNiche).trim();
    if (!name) {
      setError('Name the preset before saving.');
      return;
    }
    setSavingPreset(true);
    setError(null);
    try {
      const created = await createDiscoveryPreset({
        appId,
        name,
        niche: searchNiche,
        platform,
        followerMin: parsed.min,
        followerMax: parsed.max,
        resultLimit: parsed.limit,
        minCreators: parsed.minCreators,
        requirePublicEmail: requireEmail,
        includeExisting,
      });
      setPresets((current) => [...current, created]);
      setNamingPreset(false);
      toast('success', `Saved preset ${created.name}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save the preset';
      setError(message);
      toast('error', message);
    } finally {
      setSavingPreset(false);
    }
  };

  const onRenamePreset = async (preset: DiscoveryPreset, name: string) => {
    const previous = preset.name;
    setPresets((current) =>
      current.map((row) => (row.id === preset.id ? { ...row, name } : row)),
    );
    try {
      await renameDiscoveryPreset(preset.id, name);
    } catch (err) {
      setPresets((current) =>
        current.map((row) => (row.id === preset.id ? { ...row, name: previous } : row)),
      );
      toast('error', err instanceof Error ? err.message : 'Could not rename the preset');
    }
  };

  const onDeletePreset = (preset: DiscoveryPreset) => {
    setPresets((current) => current.filter((row) => row.id !== preset.id));
    undoable(
      'Preset deleted',
      () => deleteDiscoveryPreset(preset.id),
      () =>
        setPresets((current) =>
          [...current, preset].sort((a, b) => a.created_at.localeCompare(b.created_at)),
        ),
    );
  };

  const onSearch = async () => {
    if (!appId) {
      setError('Choose an app before searching.');
      return;
    }
    const parsed = followerNumbers();
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const { min, max, limit, minCreators: minimum } = parsed;
    setSearching(true);
    setStageHint('Finding creators');
    setError(null);
    setNotice(null);
    setHistoryName(null);
    setActiveHistoryKey(null);
    hitsRef.current = [];
    seenHits.current = new Set();
    setFreshHits(new Set());
    setHits([]);
    setSearchFunnel(null);
    setSearchJobId(null);
    setShortfallDismissed(false);
    setHashtagYield([]);
    setPicked({});
    try {
      const platforms =
        platform === 'both' ? ['tiktok', 'instagram'] : [platform];
      const jobId = await startDiscoverySearch({
        appId,
        niche: searchNiche,
        platforms,
        followerMin: min,
        followerMax: max,
        resultLimit: limit,
        hashtags,
        includeExisting,
        requirePublicEmail: requireEmail,
        minCreators: minimum,
        aiFallback,
        discoverySource,
      });
      setSearchJobId(jobId);
      const deadline = Date.now() + 3 * 60 * 1000;
      let waited = false;
      while (Date.now() < deadline) {
        if (waited) await new Promise((resolve) => setTimeout(resolve, 2000));
        waited = true;
        const poll = await pollDiscoverySearch(jobId);
        if (poll.status === 'running') {
          setStageHint(poll.message || 'Finding creators');
          if (poll.hashtagYield.length > 0) setHashtagYield(poll.hashtagYield);
          const incoming = poll.candidates.filter(allowHit);
          const current = hitsRef.current.filter(allowHit);
          if (incoming.length > 0 || current.length !== hitsRef.current.length) {
            publishHits(mergeHits(current, incoming));
          }
          continue;
        }
        if (poll.status === 'failed') {
          setSearchFunnel(null);
          setStageHint(null);
          showSearchError(poll.error || 'The search failed. No creators were added.');
          setNotice(null);
          return;
        }
        const finalRows = poll.candidates.filter(allowHit);
        const finalKeys = new Set(finalRows.map((hit) => keyFor(hit)));
        const kept = hitsRef.current.filter((hit) => {
          if (!allowHit(hit)) return false;
          return finalKeys.has(keyFor(hit)) || hit.existing === true;
        });
        publishHits(mergeHits(kept, finalRows));
        setSearchFunnel(poll.funnel);
        if (poll.funnel?.fallbackTags?.length) {
          const source = poll.funnel.fallbackSource ?? 'ai';
          const tags = poll.funnel.fallbackTags.join(' ');
          toast(
            'info',
            source === 'niche'
              ? `Related tags added: ${tags}.`
              : `AI fallback added ${tags}.`,
          );
        }
        if (poll.funnel && showFunnelExplanation(poll.funnel)) {
          setNotice(discoveryFunnelMessage(poll.funnel));
        } else if (finalRows.length) {
          setNotice(
            `${finalRows.length} creator${finalRows.length === 1 ? '' : 's'} from Apify.`,
          );
        } else {
          setNotice('No creators matched that niche and follower range.');
        }
        const rows = await fetchDiscoverHistory(appId).catch(() => null);
        if (rows) setHistory(rows);
        return;
      }
      setNotice(
        'The search is still running. It did not finish within three minutes. Try a narrower niche.',
      );
    } catch (err) {
      showSearchError(err instanceof Error ? err.message : 'Discovery failed');
      setNotice(null);
    } finally {
      setSearching(false);
      setStageHint(null);
    }
  };

  const onExpandShortfall = async (tags?: string[], action: 'expand' | 'custom' = 'expand') => {
    if (!searchJobId || !appId) return;
    const chosen = tags ?? discoverySheet?.suggestedTags ?? [];
    setContinuing(action);
    setSearching(true);
    setStageHint(chosen.length ? `Searching ${chosen.join(', ')}…` : 'Searching related tags…');
    setError(null);
    try {
      const started = await continueDiscoverySearch(searchJobId, { action, tags: chosen });
      if (started.message) toast('info', started.message);
      const deadline = Date.now() + 3 * 60 * 1000;
      let waited = false;
      while (Date.now() < deadline) {
        if (waited) await new Promise((resolve) => setTimeout(resolve, 2000));
        waited = true;
        const poll = await pollDiscoverySearch(searchJobId);
        if (poll.status === 'running') {
          setStageHint(poll.message || 'Searching related tags…');
          if (poll.hashtagYield.length > 0) setHashtagYield(poll.hashtagYield);
          const incoming = poll.candidates.filter(allowHit);
          if (incoming.length > 0) publishHits(mergeHits(hitsRef.current.filter(allowHit), incoming));
          continue;
        }
        if (poll.status === 'failed') {
          showSearchError(poll.error || 'The extra search failed.');
          return;
        }
        const finalRows = poll.candidates.filter(allowHit);
        publishHits(mergeHits(hitsRef.current.filter(allowHit), finalRows));
        setSearchFunnel(poll.funnel);
        if (poll.hashtagYield.length > 0) setHashtagYield(poll.hashtagYield);
        toast('success', poll.message || 'Related tags finished. Nothing was emailed.');
        const rows = await fetchDiscoverHistory(appId).catch(() => null);
        if (rows) setHistory(rows);
        return;
      }
      setNotice('The extra search is still running. It did not finish within three minutes.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not continue this search';
      showSearchError(message);
      toast('error', message);
    } finally {
      setContinuing(null);
      setSearching(false);
      setStageHint(null);
    }
  };

  const onRelaxShortfall = async () => {
    if (!searchJobId) return;
    setContinuing('relax');
    setError(null);
    try {
      const result = await continueDiscoverySearch(searchJobId, { action: 'relax' });
      const funnel = result.funnel ?? searchFunnel;
      setSearchFunnel(funnel);
      if (result.candidates.length > 0) {
        publishHits(mergeHits(hitsRef.current, result.candidates));
      }
      toast('success', result.message || 'Public email is off for this batch only.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not relax public email for this batch';
      setError(message);
      toast('error', message);
    } finally {
      setContinuing(null);
    }
  };

  const onAcceptShortfall = () => {
    if (searchJobId) rememberShortfallAccepted(searchJobId);
    setShortfallDismissed(true);
    toast('info', 'Kept this batch.', {
      undo: () => {
        if (searchJobId) forgetShortfallAccepted(searchJobId);
        setShortfallDismissed(false);
      },
    });
  };

  const toTarget = (hit: DiscoveryHit): SendTarget => ({
    handle: hit.handle,
    email: hit.email,
    platform: hit.platform,
    bio: hit.bio,
    niches: niche.trim() ? [niche.trim()] : [],
  });

  const prepareTargets = async (rows: SendTarget[]) => {
    if (!appId) return rows;
    const keys = new Set(
      rows.map((row) => `${row.platform}:${row.handle.replace(/^@/, '').toLowerCase()}`),
    );
    const chosen = hits.filter((hit) =>
      keys.has(`${hit.platform}:${hit.handle.replace(/^@/, '').toLowerCase()}`),
    );
    await addDiscoveredCreators(appId, niche.trim(), chosen);
    const found = await lookupCreatorsByHandle(appId, chosen);
    return rows.map((row) => {
      const match = found.find(
        (item) =>
          item.handle.replace(/^@/, '').toLowerCase() === row.handle.replace(/^@/, '').toLowerCase() &&
          item.platform === row.platform,
      );
      if (!match) return row;
      return {
        ...row,
        id: match.id,
        email: match.email || row.email,
        doNotContact: match.do_not_contact === true,
      };
    });
  };

  const shownHits = hits.filter(
    (hit) => showsWhenIncludeExisting(hit.existing === true, includeExisting) && allowHit(hit),
  );
  const discoverySheet =
    !searching && !shortfallDismissed && searchJobId
      ? shortfallSheet({
          funnel: searchFunnel,
          minCreators: minCreators.trim() ? Number(minCreators) : null,
          resultLimit: Number(resultLimit) || null,
          niche: searchNiche,
          pitch: selected?.value_prop,
          appName: selected?.name,
          searchedTags: hashtags,
        })
      : null;
  const selectedHits = shownHits.filter((hit) => picked[keyFor(hit)]);

  const onAdd = async () => {
    if (!appId || selectedHits.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const result = await addDiscoveredCreators(appId, niche.trim(), selectedHits);
      const message = `Added ${result.added} to ${selected?.name || 'this app'}. ${result.skipped} already in the CRM.`;
      setNotice(message);
      toast('success', message);
      setPicked({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add creators');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="page-title">Discover</h1>
        </div>
      </div>

      {!connected && <ConnectBanner />}

      {configured === false && notice && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-100">
          {notice}
        </div>
      )}

      <form
        ref={formRef}
        className="section space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void onSearch();
        }}
      >
        <DiscoveryPresets
          presets={presets}
          onApply={applyPreset}
          onRename={(preset, name) => void onRenamePreset(preset, name)}
          onDelete={onDeletePreset}
        />
        <label className="block">
          <span className="label">Niche</span>
          <input
            className="input"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="fitness, beauty, SaaS"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hashtags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="pill-active"
                onClick={() => setHashtags((current) => current.filter((item) => item !== tag))}
              >
                {tag} ×
              </button>
            ))}
            {suggestBusinessHashtags(niche)
              .filter((tag) => !hashtags.includes(tag))
              .map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="pill-idle"
                  onClick={() => setHashtags((current) => [...current, tag])}
                >
                  + {tag}
                </button>
              ))}
          </div>
        </label>
        <label className="block">
          <span className="label">Platform</span>
          <select
            className="input"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as typeof platform)}
          >
            <option value="tiktok">TikTok</option>
            <option value="instagram">Instagram</option>
            <option value="both">Both</option>
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">Minimum followers</span>
            <input
              className="input"
              inputMode="numeric"
              value={followerMin}
              onChange={(e) => setFollowerMin(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">Maximum followers</span>
            <input
              className="input"
              inputMode="numeric"
              value={followerMax}
              onChange={(e) => setFollowerMax(e.target.value)}
            />
          </label>
          <div className="sm:col-span-2">
            <NarrowRangeHint
              min={followerMin.trim() ? Number(followerMin) : null}
              max={followerMax.trim() ? Number(followerMax) : null}
            />
          </div>
        </div>
        <div>
          <span className="label">Volume</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {VOLUME_PRESETS.map((volume) => (
              <button
                key={volume.id}
                type="button"
                className={resultLimit === volume.limit ? 'pill-active' : 'pill-idle'}
                onClick={() => setResultLimit(volume.limit)}
              >
                {volume.label}
                <span className="ml-1 text-ink-faint">{volume.limit}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="label">
            <span className="inline-flex items-center gap-2">
              Result limit
              <DiscoveryCostNote
                limit={Number(resultLimit) || 10}
                requireEmail={requireEmail}
                source={discoverySource}
              />
            </span>
          </span>
          <input
            className="input"
            inputMode="numeric"
            min={1}
            max={100}
            value={resultLimit}
            onChange={(e) => setResultLimit(e.target.value)}
          />
        </label>
        <DiscoverySourceControl value={discoverySource} onChange={setDiscoverySource} disabled={searching} />
        <label className="block">
          <span className="label">
            <span className="inline-flex items-center gap-1.5">
              Minimum creators
              <InfoTip
                label="Minimum creators details"
                text="If the search is short, it can try one extra page. You can continue once after that."
              />
            </span>
          </span>
          <input
            className="input"
            inputMode="numeric"
            min={1}
            max={100}
            placeholder="Optional"
            value={minCreators}
            onChange={(e) => {
              const next = e.target.value;
              setMinCreators(next);
              try {
                if (next.trim()) localStorage.setItem(MIN_CREATORS_KEY, next.trim());
                else localStorage.removeItem(MIN_CREATORS_KEY);
              } catch {
                /* private mode */
              }
            }}
          />
        </label>
        <FilterToggleRow>
          <IncludeExistingSwitch checked={includeExisting} onChange={setIncludeExisting} />
          <RequirePublicEmailToggle
            checked={requireEmail}
            onChange={(next) => {
              setRequireEmail(next);
              try {
                localStorage.setItem(REQUIRE_EMAIL_KEY, next ? '1' : '0');
              } catch {
                /* private mode */
              }
            }}
          />
          <AiFallbackToggle checked={aiFallback} onChange={setAiFallback} />
        </FilterToggleRow>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className="btn-primary"
            disabled={!ready || !appId || searching || configured === false || !searchNiche}
          >
            <Radar className="h-4 w-4" />
            {searching ? 'Searching…' : 'Search creators'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={!ready || !appId || !searchNiche}
            onClick={() => {
              setPresetName((historyName || niche).trim());
              setNamingPreset(true);
            }}
          >
            Save as preset
          </button>
          {namingPreset && (
            <>
              <input
                className="input !w-48"
                aria-label="Preset name"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void onSavePreset();
                  }
                }}
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={savingPreset}
                onClick={() => void onSavePreset()}
              >
                {savingPreset ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={shownHits.length === 0}
            onClick={() => setLaunchHits(shownHits)}
          >
            Email all
          </button>
        </div>
      </form>

      {error && (
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
      {configured !== false &&
        !searching &&
        notice &&
        !(searchFunnel && showFunnelExplanation(searchFunnel)) && (
          <p className="text-sm text-ink-muted">{notice}</p>
        )}
      {searching && hashtagYield.length > 0 && (
        <HashtagYieldNote rows={hashtagYield} requireEmail={requireEmail} />
      )}
      {discoverySheet && (
        <DiscoveryShortfallSheet
          sheet={discoverySheet}
          yieldRows={searchFunnel?.hashtagYield ?? hashtagYield}
          requireEmail={searchFunnel?.requirePublicEmail !== false}
          busy={continuing}
          onExpand={(tags) => void onExpandShortfall(tags, 'expand')}
          onRelaxEmail={() => void onRelaxShortfall()}
          onCustom={(tags) => void onExpandShortfall(tags, 'custom')}
          onAccept={onAcceptShortfall}
        />
      )}
      {configured !== false && !searching && searchFunnel && (
        <DiscoveryFunnelNote
          funnel={searchFunnel}
          hideYield={Boolean(discoverySheet)}
          hideSummary={Boolean(discoverySheet)}
          onWiden={
            suggestWidenRange(searchFunnel)
              ? () => {
                  const next = widenedFollowerRange(
                    followerMin.trim() ? Number(followerMin) : null,
                    followerMax.trim() ? Number(followerMax) : null,
                  );
                  setFollowerMin(String(next.min));
                  setFollowerMax(String(next.max));
                  toast(
                    'info',
                    `Follower range set to ${next.min.toLocaleString('en-GB')}–${next.max.toLocaleString('en-GB')}. Search again when you are ready.`,
                  );
                }
              : undefined
          }
          onIncludeExisting={
            suggestIncludeExisting(searchFunnel)
              ? () => {
                  setIncludeExisting(true);
                  toast('info', 'Creators already in the CRM stay in this list.');
                }
              : undefined
          }
          onTurnOffEmail={() => {
            setRequireEmail(false);
            try {
              localStorage.setItem(REQUIRE_EMAIL_KEY, '0');
            } catch {
              /* private mode */
            }
            toast(
              'info',
              'Require public email is off. Search again when you want creators without an email.',
            );
          }}
        />
      )}

      {(searching || shownHits.length > 0) && (
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <p className="text-sm text-ink-muted">
                {searching && shownHits.length === 0
                  ? 'Results'
                  : historyName
                    ? historyName
                    : `${selectedHits.length} selected`}
                {historyName && shownHits.length > 0 ? ` · ${selectedHits.length} selected` : ''}
              </p>
              <ThinkingStatus slim active={searching} hint={stageHint || 'Finding creators'} />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  const all = shownHits.every((hit) => picked[keyFor(hit)]);
                  const next: Record<string, boolean> = {};
                  if (!all) {
                    for (const hit of shownHits) next[keyFor(hit)] = true;
                  }
                  setPicked(next);
                }}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={selectedHits.length === 0}
                onClick={() => setLaunchHits(selectedHits)}
              >
                <Rocket className="h-3.5 w-3.5" />
                Launch campaign
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={selectedHits.length === 0 || saving}
                onClick={() => void onAdd()}
              >
                {saving ? 'Adding…' : 'Add to CRM'}
              </button>
            </div>
          </div>
          {searching && shownHits.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-ink-faint">
              Creators will appear here as they are found.
            </p>
          )}
          <ul>
            {shownHits.map((hit) => {
              const key = keyFor(hit);
              return (
                <li
                  key={key}
                  className={`flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 ${
                    freshHits.has(key) ? 'stream-in' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#3b82f6]"
                    checked={Boolean(picked[key])}
                    onChange={(e) =>
                      setPicked((current) => ({ ...current, [key]: e.target.checked }))
                    }
                    aria-label={`Select @${hit.handle}`}
                  />
                  <a
                    href={hit.profile_url || '#'}
                    target={hit.profile_url ? '_blank' : undefined}
                    rel="noreferrer"
                    className="flex min-w-0 flex-1 items-center gap-3"
                    onClick={(event) => {
                      if (!hit.profile_url) event.preventDefault();
                    }}
                  >
                    <CreatorAvatar name={hit.handle} url={hit.avatar_url} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-ink">
                        @{hit.handle}
                        <PlatformMark platform={hit.platform} />
                        {hit.existing && (
                          <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-normal text-accent">
                            Already in CRM
                          </span>
                        )}
                        {!hit.email && (
                          <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-normal text-ink-faint">
                            No email
                          </span>
                        )}
                      </p>
                      <p className="line-clamp-1 text-xs text-ink-faint">
                        {formatFollowers(hit.follower_count)} followers
                        {hit.bio ? ` · ${hit.bio}` : ''}
                        {' · '}
                        {hit.email || 'No public email'}
                      </p>
                    </div>
                  </a>
                  {hit.existing && hit.creatorId && (
                    <Link
                      to={`/creators/${hit.creatorId}`}
                      className="btn-ghost !px-3 !py-1.5 text-xs"
                    >
                      Open in CRM
                    </Link>
                  )}
                  <button
                    type="button"
                    className="btn-ghost !px-3 !py-1.5 text-xs"
                    disabled={!hit.email}
                    title={hit.email ? 'Send email' : 'No public email'}
                    onClick={() => setSendTargets([toTarget(hit)])}
                  >
                    Send
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line px-5 py-3 text-xs text-ink-faint">
            <Link to="/creators?status=unsent" className="hover:text-accent">
              Open unsent creators
            </Link>
          </div>
        </section>
      )}
      <section className="section">
        <h2 className="text-sm font-medium text-ink">Recent searches</h2>
        {history.length === 0 && (
          <p className="mt-3 text-sm text-ink-faint">No previous searches for this app.</p>
        )}
        {history.length > 0 && (
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
            {history.map((item) => (
              <HistoryRow
                key={`${item.kind}:${item.id}`}
                item={item}
                active={activeHistoryKey === `${item.kind}:${item.id}`}
                reveal={historyReveal}
                onOpen={() => void openHistory(item)}
              />
            ))}
          </ul>
        )}
      </section>

      <LaunchCampaignModal
        open={Boolean(launchHits)}
        hits={launchHits ?? []}
        niche={niche}
        appId={appId}
        appName={selected?.name || loadSettings().appName || 'Solis'}
        valueProp={selected?.value_prop?.trim() || loadSettings().appValueProp}
        onClose={() => setLaunchHits(null)}
      />
      <SendDrawer
        open={Boolean(sendTargets)}
        targets={sendTargets ?? []}
        appName={selected?.name || loadSettings().appName || 'Solis'}
        valueProp={selected?.value_prop?.trim() || loadSettings().appValueProp}
        storeUrl={selected?.store_url}
        appId={appId}
        prepare={prepareTargets}
        onClose={() => setSendTargets(null)}
      />
    </div>
  );
}
