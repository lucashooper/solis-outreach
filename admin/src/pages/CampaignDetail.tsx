import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Eye,
  FlaskConical,
  Loader2,
  Rocket,
  Settings,
  Sparkles,
} from 'lucide-react';
import { IconButton } from '../components/IconButton';
import {
  normaliseHashtags,
  normaliseNiche,
  partitionListInput,
} from '../../../src/discovery/hashtags.ts';
import { usablePublicEmail } from '../../../src/discovery/email.ts';
import {
  asDiscoveryFunnel,
  discoveryResultNote,
  showFunnelExplanation,
  suggestIncludeExisting,
  suggestTurnOffEmail,
  suggestWidenRange,
  widenedFollowerRange,
} from '../../../src/discovery/funnel.ts';
import type { HashtagPack } from '../../../src/discovery/hashtagPacks.ts';
import { presentHashtagYield, type HashtagYield } from '../../../src/discovery/hashtagYield.ts';
import { asDiscoverySource } from '../../../src/discovery/network.ts';
import { resolveOutreachBranding } from '../../../src/pipeline/branding.ts';
import { showsWhenIncludeExisting } from '../../../src/discovery/campaignBatch.ts';
import { rankExpansionCandidates, strongPackName } from '../../../src/discovery/expansionTags.ts';
import type { HashtagHistoryRow } from '../../../src/discovery/hashtagAdvice.ts';
import { shortfallSheet } from '../../../src/discovery/shortfall.ts';
import { discoveryOutcomeCopy, jobIsLive } from '../../../src/discovery/runOutcome.ts';
import { AiFallbackToggle } from '../components/AiFallbackToggle';
import { DiscoveryCostNote } from '../components/DiscoveryCostNote';
import { FilterToggleRow, InfoTip } from '../components/InfoTip';
import { IncludeExistingSwitch } from '../components/IncludeExistingSwitch';
import { NarrowRangeHint } from '../components/NarrowRangeHint';
import { DiscoveryFunnelNote } from '../components/DiscoveryFunnelNote';
import { DiscoverySourceControl } from '../components/DiscoverySourceControl';
import { CompactHashtags } from '../components/CompactHashtags';
import { FindMoreCard } from '../components/FindMoreCard';
import { SearchProgressPanel } from '../components/SearchProgressPanel';
import { HashtagPresets } from '../components/HashtagPresets';
import { HashtagField } from '../components/HashtagField';
import { DiscoveryRunNote } from '../components/DiscoveryRunNote';
import { HashtagYieldNote } from '../components/HashtagYieldNote';
import { InlineToggle, RequirePublicEmailToggle } from '../components/RequirePublicEmailToggle';
import { ConnectBanner } from '../components/ConnectBanner';
import { useFeedback } from '../components/feedback';
import { useAppScope } from '../lib/apps';
import { LAUNCH_CAMPAIGN_STORAGE_KEY } from '../components/LaunchCampaignModal';
import { EmailTemplateAccordion } from '../components/EmailTemplateAccordion';
import { PageColumn } from '../components/PageColumn';
import { RepliesPanel } from '../components/RepliesPanel';
import { SendDrawer, type SendTarget } from '../components/SendDrawer';
import { CreatorListRow } from '../components/CreatorListRow';
import { SHOW_MORE_LIMIT, ShowMore, useExpandedList } from '../components/ShowMore';
import { campaignResultNote, loadShownCreators, unsavedCreator } from '../lib/campaignMatches';
import {
  deleteHashtagPack,
  loadHashtagPacks,
  renameHashtagPack,
  saveHashtagPack,
} from '../lib/hashtagPacks';
import { goBack, hasInAppHistory } from '../lib/back';
import { readQuickMode } from '../lib/quickMode';
import { isConfigured, loadSettings } from '../lib/settings';
import { skipReasonLabel, summariseBlast } from '../lib/skipReason';
import {
  fetchApiHealth,
  fetchAudience,
  fetchBlastSends,
  fetchCampaign,
  fetchCampaignSearchYield,
  fetchCreators,
  fetchDiscoveryRuns,
  fetchHashtagHistory,
  patchCampaign,
  patchCreator,
  setCreatorReplied,
  acceptCampaignBatch,
  continueCampaignDiscovery,
  fetchEligibleSuggestions,
  runCampaignAutopilot,
  runCampaignDiscovery,
  stopCampaignDiscovery,
  sendBlastOne,
  sendBlastTest,
  type AudienceMember,
  type BlastSend,
  type CampaignPatchPayload,
} from '../lib/supabase';
import type { Campaign, Creator, DiscoveryRun } from '../lib/types';
import { NICHE_SUGGESTIONS, PLATFORMS } from '../lib/types';

function applyLocalBlastTemplate(
  template: string,
  vars: { display_name?: string; app_name?: string },
): string {
  const displayName = (vars.display_name ?? '').trim() || 'there';
  const map: Record<string, string> = {
    display_name: displayName,
    hook: '',
    app_name: vars.app_name ?? '',
    creator_handle: '',
  };
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    key in map ? map[key]! : '',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function EditFiltersModal({
  open,
  campaign,
  busy,
  aiFallback,
  onAiFallback,
  onClose,
  onSave,
}: {
  open: boolean;
  campaign: Campaign;
  busy: boolean;
  aiFallback: boolean;
  onAiFallback: (next: boolean) => void;
  onClose: () => void;
  onSave: (payload: CampaignPatchPayload) => void;
}) {
  const [name, setName] = useState(campaign.name);
  const [niches, setNiches] = useState<string[]>(campaign.niches ?? []);
  const [hashtags, setHashtags] = useState<string[]>(campaign.hashtags ?? []);
  const [hashtagInput, setHashtagInput] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(campaign.platforms ?? []);
  const [followerMin, setFollowerMin] = useState(
    campaign.follower_min != null ? String(campaign.follower_min) : '',
  );
  const [followerMax, setFollowerMax] = useState(
    campaign.follower_max != null ? String(campaign.follower_max) : '',
  );
  const [engMin, setEngMin] = useState(
    campaign.engagement_rate_min != null
      ? String(campaign.engagement_rate_min)
      : '',
  );
  const [resultLimit, setResultLimit] = useState(
    String(campaign.result_limit || 10),
  );
  const [minCreators, setMinCreators] = useState(
    campaign.min_creators != null ? String(campaign.min_creators) : '',
  );
  const [requireEmail, setRequireEmail] = useState(campaign.require_public_email !== false);
  const [includeCrm, setIncludeCrm] = useState(campaign.include_crm_creators === true);
  const [discoverySource, setDiscoverySource] = useState(
    asDiscoverySource(campaign.discovery_source) ?? 'both',
  );
  const [nicheInput, setNicheInput] = useState('');
  const [customPacks, setCustomPacks] = useState<HashtagPack[]>([]);
  const [systemPacks, setSystemPacks] = useState<HashtagPack[]>([]);
  const [savingPack, setSavingPack] = useState(false);
  const { toast, undoable } = useFeedback();

  useEffect(() => {
    if (!open) return;
    setName(campaign.name);
    setNiches(campaign.niches ?? []);
    setHashtags(campaign.hashtags ?? []);
    setHashtagInput('');
    setPlatforms(campaign.platforms ?? []);
    setFollowerMin(
      campaign.follower_min != null ? String(campaign.follower_min) : '',
    );
    setFollowerMax(
      campaign.follower_max != null ? String(campaign.follower_max) : '',
    );
    setEngMin(
      campaign.engagement_rate_min != null
        ? String(campaign.engagement_rate_min)
        : '',
    );
    setResultLimit(String(campaign.result_limit || 10));
    setMinCreators(campaign.min_creators != null ? String(campaign.min_creators) : '');
    setRequireEmail(campaign.require_public_email !== false);
    setIncludeCrm(campaign.include_crm_creators === true);
    setDiscoverySource(asDiscoverySource(campaign.discovery_source) ?? 'both');
  }, [open, campaign]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadHashtagPacks(campaign.app_id ?? null)
      .then((packs) => {
        if (cancelled) return;
        setCustomPacks(packs.custom);
        setSystemPacks(packs.system);
      })
      .catch(() => {
        if (cancelled) return;
        setCustomPacks([]);
        setSystemPacks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, campaign.app_id]);

  if (!open) return null;

  const commitNiches = (raw: string, flush: boolean) => {
    const { parts, rest } = partitionListInput(raw, flush);
    const next = parts.map(normaliseNiche).filter(Boolean);
    if (next.length) {
      setNiches((prev) => {
        const nichesNext = [...prev];
        for (const niche of next) {
          if (!nichesNext.includes(niche)) nichesNext.push(niche);
        }
        return nichesNext;
      });
    }
    setNicheInput(rest);
  };

  const commitHashtags = (raw: string, flush: boolean) => {
    const { parts, rest } = partitionListInput(raw, flush);
    const next = normaliseHashtags(parts);
    if (next.length) {
      setHashtags((prev) => {
        const tags = [...prev];
        for (const tag of next) {
          if (!tags.includes(tag)) tags.push(tag);
        }
        return tags;
      });
    }
    setHashtagInput(rest);
    return next;
  };

  const applyPack = (pack: HashtagPack) => {
    setHashtags(normaliseHashtags(pack.hashtags));
    setHashtagInput('');
    toast('info', `Loaded ${pack.name}.`);
  };

  const onSavePack = async (packName: string) => {
    const appId = campaign.app_id;
    if (!appId) {
      toast('error', 'Choose an app before saving a pack.');
      return false;
    }
    const pending = commitHashtags(hashtagInput, true);
    const tags = normaliseHashtags([...(pending ?? []), ...hashtags]);
    setSavingPack(true);
    try {
      const created = await saveHashtagPack(appId, packName, tags.length ? tags : hashtags);
      setCustomPacks((current) => [...current, created]);
      toast('success', `Saved pack ${created.name}.`);
      return true;
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not save that pack');
      return false;
    } finally {
      setSavingPack(false);
    }
  };

  const onRenamePack = async (pack: HashtagPack, nextName: string) => {
    const appId = campaign.app_id;
    if (!appId) return;
    const previous = pack.name;
    setCustomPacks((current) =>
      current.map((row) => (row.id === pack.id ? { ...row, name: nextName } : row)),
    );
    try {
      await renameHashtagPack(appId, pack, nextName);
    } catch (err) {
      setCustomPacks((current) =>
        current.map((row) => (row.id === pack.id ? { ...row, name: previous } : row)),
      );
      toast('error', err instanceof Error ? err.message : 'Could not rename that pack');
    }
  };

  const onDeletePack = (pack: HashtagPack) => {
    if (pack.system || !campaign.app_id) return;
    const appId = campaign.app_id;
    setCustomPacks((current) => current.filter((row) => row.id !== pack.id));
    undoable(
      'Pack deleted',
      () => deleteHashtagPack(appId, pack),
      () =>
        setCustomPacks((current) =>
          [...current, pack].sort((a, b) => a.name.localeCompare(b.name)),
        ),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
      <div className="h-full w-full max-w-md overflow-y-auto border-l border-white/[0.06] bg-surface-raised p-6 shadow-xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Edit Campaign Filters</h2>
          <button type="button" className="btn-ghost text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <label className="label" htmlFor="edit-name">
              Name
            </label>
            <input
              id="edit-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="label">Niches</label>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {niches.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="pill-active"
                  onClick={() => setNiches((prev) => prev.filter((x) => x !== n))}
                >
                  {n} ×
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className="input"
                placeholder="Add niche…"
                value={nicheInput}
                onChange={(e) => commitNiches(e.target.value, false)}
                onBlur={(e) => commitNiches(e.target.value, true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitNiches(e.currentTarget.value, true);
                  }
                }}
              />
              <button
                type="button"
                className="btn-secondary shrink-0"
                onClick={() => commitNiches(nicheInput, true)}
              >
                Add
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {NICHE_SUGGESTIONS.filter((s) => !niches.includes(s)).map((s) => (
                <button
                  key={s}
                  type="button"
                  className="pill-idle"
                  onClick={() => commitNiches(s, true)}
                >
                  + {s}
                </button>
              ))}
            </div>
          </div>

          <HashtagField
            id="edit-hashtag"
            appId={campaign.app_id}
            tags={hashtags}
            niches={niches}
            presetTags={[...customPacks, ...systemPacks].flatMap((pack) => pack.hashtags)}
            input={hashtagInput}
            onInput={commitHashtags}
            onAdd={() => commitHashtags(hashtagInput, true)}
            onChange={setHashtags}
          >
            <HashtagPresets
              custom={customPacks}
              system={systemPacks}
              saving={savingPack}
              onApply={applyPack}
              onSave={onSavePack}
              onRename={(pack, nextName) => void onRenamePack(pack, nextName)}
              onDelete={onDeletePack}
            />
          </HashtagField>

          <fieldset>
            <legend className="label">Platforms</legend>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => {
                const active = platforms.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    className={active ? 'pill-active' : 'pill-idle'}
                    onClick={() =>
                      setPlatforms((prev) =>
                        active ? prev.filter((x) => x !== p) : [...prev, p],
                      )
                    }
                  >
                    {p === 'tiktok' ? 'TikTok' : 'Instagram'}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="fmin">
                Follower min
              </label>
              <input
                id="fmin"
                className="input"
                type="number"
                value={followerMin}
                onChange={(e) => setFollowerMin(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="fmax">
                Follower max
              </label>
              <input
                id="fmax"
                className="input"
                type="number"
                value={followerMax}
                onChange={(e) => setFollowerMax(e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <NarrowRangeHint
                min={followerMin.trim() ? Number(followerMin) : null}
                max={followerMax.trim() ? Number(followerMax) : null}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="eng">
                Engagement min %
              </label>
              <input
                id="eng"
                className="input"
                type="number"
                step="0.1"
                value={engMin}
                onChange={(e) => setEngMin(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="limit">
                <span className="inline-flex items-center gap-2">
                  Result limit
                  <DiscoveryCostNote
                    limit={Number(resultLimit) || 10}
                    requireEmail={requireEmail}
                    source={discoverySource}
                  />
                </span>
              </label>
              <input
                id="limit"
                className="input"
                type="number"
                min={1}
                max={100}
                value={resultLimit}
                onChange={(e) => setResultLimit(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="min-creators">
              <span className="inline-flex items-center gap-1.5">
                Minimum creators
                <InfoTip
                  label="Minimum creators details"
                  text="If the search is short, expand it from the card. Nothing is emailed."
                />
              </span>
            </label>
            <input
              id="min-creators"
              className="input"
              type="number"
              min={1}
              max={100}
              placeholder="Optional"
              value={minCreators}
              onChange={(e) => setMinCreators(e.target.value)}
            />
          </div>

          <DiscoverySourceControl
            value={discoverySource}
            onChange={setDiscoverySource}
            disabled={busy}
          />
          <FilterToggleRow>
            <RequirePublicEmailToggle checked={requireEmail} onChange={setRequireEmail} />
            <IncludeExistingSwitch checked={includeCrm} onChange={setIncludeCrm} />
            <AiFallbackToggle checked={aiFallback} onChange={onAiFallback} />
          </FilterToggleRow>
        </div>

        <div className="mt-8 flex gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !name.trim() || platforms.length === 0}
            onClick={() =>
              onSave({
                name: name.trim(),
                niches,
                hashtags,
                platforms,
                follower_min: followerMin === '' ? null : Number(followerMin),
                follower_max: followerMax === '' ? null : Number(followerMax),
                engagement_rate_min: engMin === '' ? null : Number(engMin),
                result_limit: Number(resultLimit) || 10,
                min_creators: minCreators.trim() ? Number(minCreators) : null,
                require_public_email: requireEmail,
                include_crm_creators: includeCrm,
                discovery_source: discoverySource,
              })
            }
          >
            {busy ? 'Saving…' : 'Save filters'}
          </button>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function CampaignDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { confirm, toast } = useFeedback();
  const { apps, selected } = useAppScope();
  const connected = isConfigured();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [loading, setLoading] = useState(connected);
  const [error, setError] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [runOutcome, setRunOutcome] = useState<{
    title: string;
    action: string;
    jobId: string | null;
    funnel: ReturnType<typeof asDiscoveryFunnel>;
  } | null>(null);
  const findLock = useRef(false);
  const [hashtagHistory, setHashtagHistory] = useState<HashtagHistoryRow[]>([]);
  const [pagePacks, setPagePacks] = useState<string[]>([]);
  const [savingStrongPack, setSavingStrongPack] = useState(false);
  const [revealTemplate, setRevealTemplate] = useState(0);
  const [busy, setBusy] = useState<
    'find' | 'demo' | 'schedule-run' | 'toggle' | 'filters' | string | null
  >(null);
  const [sendTargets, setSendTargets] = useState<SendTarget[] | null>(null);
  const [apifyOk, setApifyOk] = useState(false);
  const [apiOk, setApiOk] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [aiFallback, setAiFallback] = useState(false);
  const [continuing, setContinuing] = useState<'expand' | 'relax' | 'accept' | 'custom' | 'network' | null>(null);
  const [eligibleOffer, setEligibleOffer] = useState<{
    tags: string[];
    networkOnly: boolean;
    note: string;
  } | null>(null);
  const [expandProgress, setExpandProgress] = useState<string | null>(null);
  const latestRunKey = runs[0]?.id ?? '';
  useEffect(() => {
    if (!id) return;
    let cancel = false;
    setEligibleOffer(null);
    void fetchEligibleSuggestions(id)
      .then((result) => {
        if (!cancel) setEligibleOffer(result);
      })
      .catch(() => {
        if (!cancel) setEligibleOffer(null);
      });
    return () => {
      cancel = true;
    };
  }, [id, latestRunKey, continuing]);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [reopenedRunId, setReopenedRunId] = useState<string | null>(null);
  const [liveYield, setLiveYield] = useState<HashtagYield[]>([]);
  const [liveFallback, setLiveFallback] = useState<{
    tags: string[];
    source: 'ai' | 'niche' | null;
  }>({ tags: [], source: null });
  const [liveStage, setLiveStage] = useState<string | null>(null);
  const [liveFound, setLiveFound] = useState(0);
  const [liveChecked, setLiveChecked] = useState(0);
  const [jobLive, setJobLive] = useState(false);
  const [jobStartedAt, setJobStartedAt] = useState<string | null>(null);
  const [stoppingSearch, setStoppingSearch] = useState(false);
  const [searchClock, setSearchClock] = useState(0);
  const searchStartedAt = useRef<number | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [blastCounts, setBlastCounts] = useState({
    sent: 0,
    failed: 0,
    opened: 0,
  });
  const [audienceLabel, setAudienceLabel] = useState('');
  const [audienceMembers, setAudienceMembers] = useState<AudienceMember[]>([]);
  const [blastSends, setBlastSends] = useState<BlastSend[]>([]);
  const creatorRows = useExpandedList();
  const blastHistory = useExpandedList();
  const recentRuns = useExpandedList();
  const blastTab =
    params.get('tab') === 'history' ? 'history' : params.get('tab') === 'replies' ? 'replies' : 'launch';
  const setBlastTab = (tab: 'launch' | 'history' | 'replies') => {
    const next = new URLSearchParams(params);
    if (tab === 'launch') next.delete('tab');
    else next.set('tab', tab);
    setParams(next);
  };
  const [overrideDuplicates, setOverrideDuplicates] = useState(false);
  const [blastProgress, setBlastProgress] = useState<{
    total: number;
    done: number;
    sending: boolean;
  }>({ total: 0, done: 0, sending: false });
  const [blastLog, setBlastLog] = useState<
    Array<{ email: string; status: 'sending' | 'sent' | 'failed' | 'skipped'; error?: string }>
  >([]);
  const [previewSend, setPreviewSend] = useState<{
    email: string;
    subject: string;
    body: string;
  } | null>(null);
  const [blastSubject, setBlastSubject] = useState('');
  const [blastBody, setBlastBody] = useState('');
  const [blastTemplateId, setBlastTemplateId] = useState<string | null>(null);
  const blastSync = useRef({ id: '', subject: '', body: '', templateId: null as string | null });
  const emailDraft = useRef({ subject: '', body: '', templateId: null as string | null });
  const blastAbortRef = useRef(false);
  const seenCreatorIds = useRef<Set<string> | null>(null);
  const creatorsRef = useRef<Creator[]>([]);
  const [freshCreatorIds, setFreshCreatorIds] = useState<Set<string>>(new Set());

  const applyCreators = useCallback((rows: Creator[], animateNew: boolean) => {
    const seen = seenCreatorIds.current;
    if (!seen) {
      seenCreatorIds.current = new Set(rows.map((row) => row.id));
      setCreators(rows);
      return;
    }
    if (animateNew) {
      const added = rows.map((row) => row.id).filter((rowId) => !seen.has(rowId));
      if (added.length > 0) {
        setFreshCreatorIds((current) => {
          const next = new Set(current);
          for (const rowId of added) next.add(rowId);
          return next;
        });
      }
    }
    for (const row of rows) seen.add(row.id);
    creatorsRef.current = rows;
    setCreators(rows);
  }, []);

  useEffect(() => {
    if (!campaign) return;
    const next = {
      id: campaign.id,
      subject: campaign.email_subject || '',
      body: campaign.email_body || '',
      templateId: campaign.template_id ?? null,
    };
    const prev = blastSync.current;
    if (
      prev.id === next.id &&
      prev.subject === next.subject &&
      prev.body === next.body &&
      prev.templateId === next.templateId
    ) {
      return;
    }
    blastSync.current = next;
    emailDraft.current = {
      subject: next.subject,
      body: next.body,
      templateId: next.templateId,
    };
    setBlastSubject(next.subject);
    setBlastBody(next.body);
    setBlastTemplateId(next.templateId);
  }, [campaign]);

  const load = useCallback(
    (animateNew = false, quiet = false) => {
      if (!connected || !id) {
        setLoading(false);
        return Promise.resolve();
      }
      if (!quiet) setLoading(true);
      return Promise.all([
        fetchCampaign(id),
        fetchCreators({ campaignId: id }),
        fetchDiscoveryRuns(id),
        fetchApiHealth(),
      ])
        .then(async ([c, cr, r, health]) => {
          const shown = c ? await loadShownCreators(c, cr, r) : null;
          const rows = shown
            ? [...shown.creators, ...shown.unsaved.map(unsavedCreator)]
            : cr;
          setCampaign(c);
          applyCreators(rows, animateNew);
          setRuns(r);
          setApiOk(Boolean(health.ok));
          setApifyOk(Boolean(health.apifyConfigured));
          setError(c ? null : 'Campaign not found');
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : 'Failed to load');
        })
        .finally(() => setLoading(false));
    },
    [applyCreators, connected, id],
  );

  useEffect(() => {
    seenCreatorIds.current = null;
    setFreshCreatorIds(new Set());
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!campaign?.app_id) return;
    let cancelled = false;
    void fetchHashtagHistory(campaign.app_id).then((rows) => {
      if (!cancelled) setHashtagHistory(rows);
    });
    void loadHashtagPacks(campaign.app_id).then((packs) => {
      if (!cancelled) {
        setPagePacks([...packs.custom, ...packs.system].flatMap((pack) => pack.hashtags));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [campaign?.app_id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let wasLive = false;
    const tick = async () => {
      const yieldState = await fetchCampaignSearchYield(id).catch(() => null);
      if (cancelled || !yieldState) return;
      const attached = jobIsLive(yieldState.status, yieldState.updatedAt);
      if (yieldState.rows.length > 0) {
        setLiveYield(yieldState.rows);
        setLiveFallback({ tags: yieldState.fallbackTags, source: yieldState.fallbackSource });
      }
      if (yieldState.stageLabel) setLiveStage(yieldState.stageLabel);
      setLiveFound(yieldState.found);
      setLiveChecked(yieldState.checked);
      setJobStartedAt(yieldState.createdAt);
      setStoppingSearch(yieldState.status === 'stopping');
      setJobLive(attached);
      if (attached) {
        wasLive = true;
        await load(true, true);
      } else if (wasLive) {
        wasLive = false;
        await load(true, true);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, load]);

  const searchingNow = jobLive || busy === 'find';
  useEffect(() => {
    if (!searchingNow) {
      searchStartedAt.current = null;
      return;
    }
    if (searchStartedAt.current == null) searchStartedAt.current = Date.now();
    const timer = window.setInterval(() => setSearchClock((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [searchingNow]);

  const streamCreatorsWhile = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T> => {
      if (!id) return task();
      let stopped = false;
      const loop = (async () => {
        while (!stopped) {
          try {
            const rows = await fetchCreators({ campaignId: id });
            if (!stopped) {
              const kept = creatorsRef.current.filter(
                (row) => row.alreadyInCrm || row.unsaved,
              );
              const ids = new Set(rows.map((row) => row.id));
              applyCreators(
                [...rows, ...kept.filter((row) => !ids.has(row.id))],
                true,
              );
            }
          } catch {
            /* The next tick retries. A failed read must not wipe the list. */
          }
          await new Promise((resolve) => setTimeout(resolve, 450));
        }
      })();
      try {
        return await task();
      } finally {
        stopped = true;
        await loop;
      }
    },
    [applyCreators, id],
  );

  useEffect(() => {
    if (!campaign || campaign.campaign_type !== 'direct_blast') return;
    let cancelled = false;
    fetchBlastSends(campaign.id)
      .then((r) => {
        if (!cancelled) {
          setBlastCounts(r.counts);
          setBlastSends(r.sends);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBlastCounts({ sent: 0, failed: 0, opened: 0 });
          setBlastSends([]);
        }
      });
    if (campaign.audience_group_id) {
      fetchAudience(campaign.audience_group_id)
        .then((a) => {
          if (!cancelled) {
            const members = a.members ?? [];
            setAudienceMembers(members);
            setAudienceLabel(`${a.name} (${members.length} members)`);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAudienceLabel('');
            setAudienceMembers([]);
          }
        });
    } else {
      setAudienceMembers([]);
    }
    return () => {
      cancelled = true;
    };
  }, [campaign]);

  const saveEmailCopy = async (next: {
    subject: string;
    body: string;
    templateId: string | null;
  }) => {
    if (!id || !campaign) return;
    if (
      next.subject === (campaign.email_subject || '') &&
      next.body === (campaign.email_body || '') &&
      (next.templateId || null) === (campaign.template_id ?? null)
    ) {
      return;
    }
    const updated = await patchCampaign(id, {
      email_subject: next.subject,
      email_body: next.body,
      template_id: next.templateId,
    });
    blastSync.current = {
      id: updated.id,
      subject: updated.email_subject || '',
      body: updated.email_body || '',
      templateId: updated.template_id ?? null,
    };
    setCampaign(updated);
  };

  const onEmailChange = (next: { templateId: string | null; subject: string; body: string }) => {
    const previousId = emailDraft.current.templateId;
    emailDraft.current = next;
    setBlastSubject(next.subject);
    setBlastBody(next.body);
    setBlastTemplateId(next.templateId);
    if (next.templateId !== previousId) {
      void saveEmailCopy(next).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not save the template');
      });
    }
  };

  const onSendTest = async () => {
    if (!id || !testEmail.trim()) {
      setError('Enter a test email address');
      return;
    }
    setBusy('blast-test');
    setError(null);
    setRunMsg(null);
    try {
      await saveEmailCopy(emailDraft.current);
      const result = await sendBlastTest(id, testEmail.trim());
      const message = result.dryRun
        ? `Dry-run test to ${testEmail} (RESEND_API_KEY missing)`
        : `Test email sent to ${testEmail}`;
      setRunMsg(message);
      toast(result.dryRun ? 'info' : 'success', message);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Test send failed');
    } finally {
      setBusy(null);
    }
  };

  const onLaunchBlast = async (options?: { skipConfirm?: boolean }) => {
    if (!id || !campaign) return;
    if (audienceMembers.length === 0) {
      setError('Audience has no members');
      return;
    }
    try {
      await saveEmailCopy(emailDraft.current);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the email');
      return;
    }
    if (!options?.skipConfirm && !readQuickMode()) {
      const launch = await confirm({
        title: 'Launch blast',
        body: `Send this blast to ${audienceMembers.length} recipient${audienceMembers.length === 1 ? '' : 's'}?`,
        confirmLabel: 'Launch',
      });
      if (!launch) return;
    }
    setBusy('blast-send');
    setError(null);
    setRunMsg(null);
    setBlastTab('launch');
    blastAbortRef.current = false;
    setBlastLog([]);
    setBlastProgress({ total: audienceMembers.length, done: 0, sending: true });

    let sent = 0;
    let failed = 0;
    try {
      for (let i = 0; i < audienceMembers.length; i++) {
        if (blastAbortRef.current) break;
        const member = audienceMembers[i]!;
        setBlastLog((prev) => [
          ...prev,
          { email: member.email, status: 'sending' },
        ]);
        try {
          const result = await sendBlastOne(id, {
            memberId: member.id,
            isFirst: i === 0,
            isLast: i === audienceMembers.length - 1,
            override: overrideDuplicates,
          });
          const outcome =
            result.status === 'skipped' ? 'skipped' : result.ok ? 'sent' : 'failed';
          if (outcome === 'sent') sent += 1;
          else if (outcome === 'failed') failed += 1;
          setBlastLog((prev) => {
            const next = [...prev];
            let idx = -1;
            for (let j = next.length - 1; j >= 0; j--) {
              if (next[j]!.email === member.email && next[j]!.status === 'sending') {
                idx = j;
                break;
              }
            }
            if (idx >= 0) {
              next[idx] = {
                email: member.email,
                status:
                  result.status === 'skipped' ? 'skipped' : result.ok ? 'sent' : 'failed',
                error: result.error ?? undefined,
              };
            }
            return next;
          });
        } catch (err: unknown) {
          failed += 1;
          const msg = err instanceof Error ? err.message : 'send failed';
          setBlastLog((prev) => {
            const next = [...prev];
            let idx = -1;
            for (let j = next.length - 1; j >= 0; j--) {
              if (next[j]!.email === member.email && next[j]!.status === 'sending') {
                idx = j;
                break;
              }
            }
            if (idx >= 0) {
              next[idx] = { email: member.email, status: 'failed', error: msg };
            }
            return next;
          });
        }
        setBlastProgress({
          total: audienceMembers.length,
          done: i + 1,
          sending: i + 1 < audienceMembers.length,
        });
        if (i < audienceMembers.length - 1) await sleep(500);
      }
      setRunMsg(null);
      load();
      const sends = await fetchBlastSends(id).catch(() => null);
      if (sends) {
        setBlastCounts(sends.counts);
        setBlastSends(sends.sends);
        toast('success', summariseBlast(sends.sends));
      } else {
        toast('success', 'Blast launched.');
      }
      setBlastTab('history');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Launch blast failed');
    } finally {
      setBlastProgress((p) => ({ ...p, sending: false }));
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!id || params.get('launch') !== '1') return;
    if (!campaign || campaign.campaign_type !== 'direct_blast') return;
    if (!audienceLabel || audienceMembers.length === 0) return;
    let armed = false;
    try {
      armed = sessionStorage.getItem(LAUNCH_CAMPAIGN_STORAGE_KEY) === id;
    } catch {
      armed = false;
    }
    if (!armed) return;
    try {
      sessionStorage.removeItem(LAUNCH_CAMPAIGN_STORAGE_KEY);
    } catch {
      /* already consumed */
    }
    const next = new URLSearchParams(params);
    next.delete('launch');
    setParams(next, { replace: true });
    void onLaunchBlast({ skipConfirm: true });
    // The Discover modal already confirmed. Run once when the audience is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, campaign, audienceLabel, audienceMembers, params, setParams]);

  const openHistoryPreview = (row: BlastSend) => {
    if (!campaign) return;
    const member = audienceMembers.find(
      (m) => m.id === row.member_id || m.email === row.email,
    );
    const appName = liveBranding.appName;
    const subject = applyLocalBlastTemplate(campaign.email_subject || '', {
      display_name: member?.display_name || undefined,
      app_name: appName,
    });
    const body = applyLocalBlastTemplate(campaign.email_body || '', {
      display_name: member?.display_name || undefined,
      app_name: appName,
    });
    setPreviewSend({ email: row.email, subject, body });
  };

  const onFindAndPitch = async () => {
    if (!id || findLock.current || jobLive) return;
    findLock.current = true;
    setBusy('find');
    setLiveYield([]);
    setLiveFallback({ tags: [], source: null });
    setLiveStage(null);
    setLiveFound(0);
    setLiveChecked(0);
    searchStartedAt.current = Date.now();
    setRunMsg(null);
    setRunOutcome(null);
    setError(null);
    try {
      const result = await streamCreatorsWhile(() =>
        runCampaignDiscovery(id, 'apify', {
          forceOutreach: false,
          aiFallback,
        }),
      );
      const found = Number(result.found) || 0;
      const sent = Number(result.sent) || 0;
      const funnel = asDiscoveryFunnel(result.funnel);
      const outcomeTitle = typeof result.outcomeTitle === 'string' ? result.outcomeTitle.trim() : '';
      const outcomeAction = typeof result.outcomeAction === 'string' ? result.outcomeAction.trim() : '';
      const alreadyRunning =
        result.alreadyRunning === true || result.reason === 'already_running';
      if (alreadyRunning) {
        setRunOutcome(null);
        setRunMsg(null);
        setJobLive(true);
        toast('info', 'Search in progress.');
        await load(true, true);
        return;
      }
      if (outcomeTitle) {
        setRunOutcome({
          title: outcomeTitle,
          action: outcomeAction,
          jobId: typeof result.discoveryJobId === 'string' ? result.discoveryJobId : null,
          funnel,
        });
        setRunMsg(null);
        toast('info', outcomeTitle);
      } else {
        setRunOutcome(null);
        const sheet = funnel
          ? shortfallSheet({
              funnel,
              minCreators: campaign?.min_creators,
              resultLimit: campaign?.result_limit,
              niche: (campaign?.niches ?? []).join(' '),
              pitch: campaign?.value_prop,
              appName: campaign?.app_name,
              searchedTags: campaign?.hashtags ?? [],
            })
          : null;
        let note: string;
        if (sheet) {
          note = '';
        } else if (funnel) {
          const counts = discoveryResultNote(funnel);
          if (!campaign?.auto_outreach) {
            note = `${counts} Emails were not sent.`;
          } else if (sent > 0) {
            note = `${counts} ${sent} sent.`;
          } else {
            note = `${counts} None were emailed.`;
          }
        } else if (!campaign?.auto_outreach) {
          note = `Found ${found} creators. Emails were not sent.`;
        } else if (sent > 0) {
          note = `Found ${found} creators, ${sent} sent.`;
        } else {
          note = `Found ${found} creators. None were emailed.`;
        }
        setRunMsg(note || null);
        if (note) toast('info', note);
      }
      const finished = asDiscoveryFunnel(result.funnel);
      if (finished?.hashtagYield?.length) setLiveYield(finished.hashtagYield);
      await load(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Find creators failed';
      setError(message);
      toast('error', message);
    } finally {
      findLock.current = false;
      setAiFallback(false);
      setBusy(null);
    }
  };

  const onStopSearch = async () => {
    if (!id) return;
    setStoppingSearch(true);
    try {
      await stopCampaignDiscovery(id);
      toast('info', 'Stopping the search…');
    } catch (err: unknown) {
      setStoppingSearch(false);
      const message = err instanceof Error ? err.message : 'Could not stop the search';
      toast('error', message);
    }
  };

  const onContinueShortfall = async (
    action: 'expand' | 'relax' | 'custom',
    tags?: string[],
    addToCampaign?: boolean,
  ) => {
    if (!id) return;
    setContinuing(action);
    setEligibleOffer(null);
    setError(null);
    if (action !== 'relax' && tags && tags.length > 0) {
      setExpandProgress(`Searching ${tags.join(', ')}…`);
    }
    const poll = window.setInterval(() => {
      void load(true, true);
    }, 2000);
    try {
      const result = await continueCampaignDiscovery(id, {
        action,
        tags: action === 'relax' ? undefined : tags,
        addToCampaign: action === 'custom' ? addToCampaign : undefined,
      });
      toast('success', result.message);
      await load(true, true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not continue this search';
      setError(message);
      toast('error', message);
    } finally {
      window.clearInterval(poll);
      setExpandProgress(null);
      setContinuing(null);
    }
  };

  const onNetworkExpand = async () => {
    if (!id || findLock.current) return;
    findLock.current = true;
    setContinuing('network');
    setEligibleOffer(null);
    setError(null);
    try {
      await runCampaignDiscovery(id, 'apify', { source: 'network' });
      toast('info', 'Searched the creator network. Nothing was emailed.');
      await load(true, true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not search the creator network';
      setError(message);
      toast('error', message);
    } finally {
      findLock.current = false;
      setContinuing(null);
    }
  };

  const onAcceptShortfall = async () => {
    const runId = runs[0]?.id;
    if (!id || !runId || continuing) return;
    setContinuing('accept');
    setError(null);
    try {
      const result = await acceptCampaignBatch(id, { runId });
      rememberShortfallAccepted(runId);
      setReopenedRunId(null);
      setDismissedRunId(runId);
      await load(true);
      toast('info', result.message, {
        undo: () => {
          setReopenedRunId(runId);
          setDismissedRunId(null);
          forgetShortfallAccepted(runId);
          void (async () => {
            try {
              await acceptCampaignBatch(id, { undo: true, runId });
              await load(true);
            } catch (err: unknown) {
              rememberShortfallAccepted(runId);
              setReopenedRunId(null);
              setDismissedRunId(runId);
              toast('error', err instanceof Error ? err.message : 'Could not undo this batch');
              await load(true);
            }
          })();
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not keep this batch';
      setError(message);
      toast('error', message);
    } finally {
      setContinuing(null);
    }
  };

  const onDemo = async () => {
    if (!id) return;
    setBusy('demo');
    setRunMsg(null);
    setError(null);
    setAdvancedOpen(false);
    try {
      const result = await streamCreatorsWhile(() => runCampaignDiscovery(id, 'demo'));
      setRunMsg(`Demo: found ${String(result.found)} creators.`);
      await load(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Demo run failed');
    } finally {
      setBusy(null);
    }
  };

  const onScheduleRunNow = async () => {
    setBusy('schedule-run');
    setError(null);
    setRunMsg(null);
    setAdvancedOpen(false);
    try {
      const result = await streamCreatorsWhile(() => runCampaignAutopilot(id));
      setRunMsg(
        `Daily automation: sent ${String(result.sent ?? 0)} via ${String(result.provider ?? '?')}`,
      );
      await load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Schedule run failed');
    } finally {
      setBusy(null);
    }
  };

  const onToggleSchedule = async () => {
    if (!campaign) return;
    setBusy('toggle');
    try {
      const next = !campaign.is_autopilot_enabled;
      await patchCampaign(campaign.id, {
        is_autopilot_enabled: next,
        schedule_cron: campaign.schedule_cron || '0 10 * * *',
      });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to toggle schedule');
    } finally {
      setBusy(null);
    }
  };

  const onWidenRange = async () => {
    if (!campaign) return;
    const next = widenedFollowerRange(campaign.follower_min, campaign.follower_max);
    try {
      await patchCampaign(campaign.id, {
        follower_min: next.min,
        follower_max: next.max,
      });
      toast(
        'info',
        `Follower range set to ${next.min.toLocaleString('en-GB')}–${next.max.toLocaleString('en-GB')}. Search again when you are ready.`,
      );
      load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not widen the range');
    }
  };

  const onSetIncludeCrm = async (next: boolean) => {
    if (!campaign || next === (campaign.include_crm_creators === true)) return;
    try {
      await patchCampaign(campaign.id, { include_crm_creators: next });
      toast(
        'info',
        next
          ? 'Include CRM creators is on. The next search can count people already in this app.'
          : 'Include CRM creators is off. The next search skips people already in this app.',
      );
      load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not update Include CRM creators');
    }
  };

  const onSetAutoEmail = async (next: boolean) => {
    if (!campaign || next === campaign.auto_outreach) return;
    const subject = (campaign.email_subject || '').trim();
    const body = (campaign.email_body || '').trim();
    if (next && (!subject || !body)) {
      setRevealTemplate((value) => value + 1);
      toast('error', 'Add a subject and body before Auto-email can send.');
      return;
    }
    try {
      await patchCampaign(campaign.id, { auto_outreach: next });
      toast(
        'info',
        next
          ? 'Auto-email is on. The next discovery can send this template.'
          : 'Auto-email is off. Discovery will only save creators.',
      );
      load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not update Auto-email');
    }
  };

  const onSetDiscoverySource = async (next: 'network' | 'hashtags' | 'both') => {
    if (!campaign || next === (asDiscoverySource(campaign.discovery_source) ?? 'both')) return;
    try {
      await patchCampaign(campaign.id, { discovery_source: next });
      toast(
        'info',
        next === 'network'
          ? 'Next search reads following lists of creators already in this app.'
          : next === 'hashtags'
            ? 'Next search uses hashtags only.'
            : 'Next search tries the creator network first, then hashtags if it is short.',
      );
      load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not update the discovery source');
    }
  };

  const onSetRequireEmail = async (next: boolean) => {
    if (!campaign || next === (campaign.require_public_email !== false)) return;
    try {
      await patchCampaign(campaign.id, { require_public_email: next });
      toast(
        'info',
        next
          ? 'Require public email is on. The next search only saves creators with an email.'
          : 'Require public email is off. The next search will keep creators without an email.',
      );
      load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not update the email filter');
    }
  };

  const onSaveFilters = async (payload: CampaignPatchPayload) => {
    if (!campaign) return;
    setBusy('filters');
    setError(null);
    try {
      await patchCampaign(campaign.id, payload);
      setEditOpen(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save filters');
    } finally {
      setBusy(null);
    }
  };

  const toSendTarget = (c: Creator): SendTarget => ({
    id: c.id,
    handle: c.handle,
    email: c.email,
    platform: c.platform,
    bio: c.bio,
    displayName: typeof c.ai_variables?.display_name === 'string' ? c.ai_variables.display_name : null,
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

  const openSend = (rows: Creator[]) => {
    setSendTargets(rows.map(toSendTarget));
  };

  const onSkip = async (c: Creator) => {
    setBusy(c.id);
    try {
      await patchCreator(c.id, { outreach_status: 'archived' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Skip failed');
    } finally {
      setBusy(null);
    }
  };

  const onToggleReplied = async (c: Creator) => {
    setBusy(c.id);
    setError(null);
    try {
      await setCreatorReplied(c, c.outreach_status !== 'replied');
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not update replied status');
    } finally {
      setBusy(null);
    }
  };

  if (!connected) {
    return (
      <div className="space-y-6">
        <ConnectBanner />
      </div>
    );
  }

  if (loading && !campaign) {
    return <p className="text-slate-500">Loading…</p>;
  }

  if (!campaign) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          className="text-xs text-slate-500 hover:text-accent"
          onClick={() => goBack(navigate, '/campaigns')}
        >
          ← {hasInAppHistory() ? 'Back' : 'Campaigns'}
        </button>
        <p className="text-red-300">{error || 'Campaign not found'}</p>
      </div>
    );
  }

  const requirePublicEmail = campaign.require_public_email !== false;
  const emailOk = (c: { email?: string | null; alreadyInCrm?: boolean; unsaved?: boolean }) =>
    !requirePublicEmail || !(c.alreadyInCrm || c.unsaved) || Boolean(usablePublicEmail(c.email));
  const includeCrm = campaign.include_crm_creators === true;
  const visibleCreators = creators.filter(
    (c) =>
      showsWhenIncludeExisting(c.alreadyInCrm === true, includeCrm, c.linked === true) &&
      emailOk(c),
  );
  const withEmail = visibleCreators.filter((c) => usablePublicEmail(c.email)).length;
  const existingCreators = creators.filter((c) => c.alreadyInCrm && emailOk(c));
  const crmToggleCount = creators.filter((c) => c.alreadyInCrm && !c.linked && emailOk(c)).length;
  const unsavedCount = visibleCreators.filter((c) => c.unsaved).length;
  const latestFunnel = asDiscoveryFunnel(runs[0]?.funnel);
  const persistedOutcome =
    !runOutcome && latestFunnel?.reason && latestFunnel.reason !== 'ok'
      ? discoveryOutcomeCopy(latestFunnel.reason, latestFunnel)
      : null;
  const latestRunId = runs[0]?.id ?? null;
  const shortfallDismissed =
    latestRunId != null &&
    reopenedRunId !== latestRunId &&
    (dismissedRunId === latestRunId ||
      shortfallWasAccepted(latestRunId) ||
      latestFunnel?.batchAccepted === true);
  const searchRunning =
    searchingNow || continuing === 'expand' || continuing === 'custom';
  const elapsedAnchor = jobStartedAt ? Date.parse(jobStartedAt) : searchStartedAt.current;
  const elapsedSeconds =
    searchRunning && elapsedAnchor != null && Number.isFinite(elapsedAnchor)
      ? Math.max(0, Math.floor((Date.now() - elapsedAnchor) / 1000))
      : 0;
  void searchClock;
  const progressTarget = Math.max(
    1,
    campaign.min_creators != null && campaign.min_creators >= 1
      ? campaign.min_creators
      : campaign.result_limit || 1,
  );
  const measuredYield = searchRunning ? liveYield : (latestFunnel?.hashtagYield ?? liveYield);
  const yieldPills = presentHashtagYield({
    campaignTags: campaign.hashtags ?? [],
    measured: measuredYield,
    running: searchRunning,
    requireEmail: requirePublicEmail,
  });
  const yieldRows = measuredYield;
  const yieldFallbackTags =
    busy === 'find' ? liveFallback.tags : (latestFunnel?.fallbackTags ?? liveFallback.tags);
  const yieldFallbackSource =
    busy === 'find'
      ? (liveFallback.source ?? undefined)
      : (latestFunnel?.fallbackSource ?? liveFallback.source ?? undefined);
  const displayFunnel =
    latestFunnel && typeof latestFunnel.existing !== 'number'
      ? { ...latestFunnel, existing: existingCreators.length }
      : latestFunnel;
  const matchNote = campaignResultNote(displayFunnel, existingCreators.length);
  const linkedApp = apps.find((app) => app.id === campaign.app_id) ?? selected;
  const liveBranding = resolveOutreachBranding({
    appName: linkedApp?.name,
    appValueProp: linkedApp?.value_prop,
    campaignAppName: campaign.app_name,
    campaignValueProp: campaign.value_prop,
    fallbackAppName: loadSettings().appName,
    fallbackValueProp: loadSettings().appValueProp,
  });
  const isBlast = campaign.campaign_type === 'direct_blast';
  const emailSaved = Boolean(
    campaign.template_id || campaign.email_subject?.trim() || campaign.email_body?.trim(),
  );
  const expansionCandidates = rankExpansionCandidates({
    history: hashtagHistory,
    packTags: pagePacks,
    niche: (campaign.niches ?? []).join(' '),
    pitch: liveBranding.valueProp,
    appName: liveBranding.appName,
    blocked: [
      ...(campaign.hashtags ?? []),
      ...(displayFunnel?.triedTags ?? []),
      ...(displayFunnel?.fallbackTags ?? []),
      ...(displayFunnel?.hashtagYield ?? []).map((row) => row.tag),
    ],
  });
  const offerSheet = searchRunning
    ? null
    : shortfallSheet({
        funnel: displayFunnel,
        minCreators: campaign.min_creators,
        resultLimit: campaign.result_limit,
        niche: (campaign.niches ?? []).join(' '),
        pitch: liveBranding.valueProp,
        appName: liveBranding.appName,
        searchedTags: campaign.hashtags ?? [],
        history: hashtagHistory,
        packTags: pagePacks,
        candidates: expansionCandidates,
      });
  const campaignSheet = offerSheet && !shortfallDismissed ? offerSheet : null;
  const cardSheet = campaignSheet
    ? {
        ...campaignSheet,
        suggestedTags: eligibleOffer?.tags ?? [],
        canExpand: (eligibleOffer?.tags.length ?? 0) > 0,
        networkOnly: eligibleOffer?.networkOnly === true,
        suggestionNote: eligibleOffer?.note || campaignSheet.suggestionNote,
        tiersExhausted: eligibleOffer ? eligibleOffer.networkOnly : campaignSheet.tiersExhausted,
      }
    : null;
  const runLabel = runs.length === 1 ? '1 run' : `${runs.length} runs`;
  const saveStrongPack = (tags: string[]) => {
    const appId = campaign.app_id;
    if (!appId) {
      toast('error', 'Choose an app before saving a pack.');
      return;
    }
    const name = strongPackName(liveBranding.appName || campaign.app_name);
    setSavingStrongPack(true);
    void saveHashtagPack(appId, name, tags)
      .then((created) => {
        setPagePacks((current) => [...current, ...created.hashtags]);
        toast('success', `Saved pack ${created.name}.`, {
          undo: () => {
            void deleteHashtagPack(appId, created).catch((err: unknown) => {
              toast('error', err instanceof Error ? err.message : 'Could not undo that pack');
            });
          },
        });
      })
      .catch((err: unknown) => {
        toast('error', err instanceof Error ? err.message : 'Could not save that pack');
      })
      .finally(() => setSavingStrongPack(false));
  };

  if (isBlast) {
    const progressPct =
      blastProgress.total > 0
        ? Math.round((blastProgress.done / blastProgress.total) * 100)
        : 0;

    return (
      <PageColumn>
        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-accent"
            onClick={() => goBack(navigate, '/campaigns')}
          >
            <ArrowLeft className="h-3 w-3" />
            {hasInAppHistory() ? 'Back' : 'Campaigns'}
          </button>
          <div className="mt-2 flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-sky-400/80">
                Direct Blast
              </p>
              <h1 className="break-words text-2xl font-semibold tracking-tight text-white">
                {campaign.name}
              </h1>
              <p className="mt-2 text-sm text-ink-muted">
                {blastCounts.sent} sent · {blastCounts.failed} failed · {blastCounts.opened} opened
                {audienceLabel ? ` · ${audienceLabel}` : ''}
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {(runMsg || blastSends.length > 0) && (
          <div className="rounded-lg border border-slate-800 bg-white/[0.02] px-3 py-2 text-sm text-slate-300">
            {blastSends.length > 0 ? summariseBlast(blastSends) : runMsg}
          </div>
        )}

        <div className="flex gap-1 rounded-xl border border-slate-800 bg-white/[0.02] p-1">
          <button
            type="button"
            className={
              blastTab === 'launch'
                ? 'flex-1 rounded-lg bg-accent/15 px-3 py-2 text-sm font-medium text-white shadow-[0_0_16px_rgba(91,141,239,0.2)] ring-1 ring-accent/30'
                : 'flex-1 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-200'
            }
            onClick={() => setBlastTab('launch')}
          >
            Launch
          </button>
          <button
            type="button"
            className={
              blastTab === 'history'
                ? 'flex-1 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-white'
                : 'flex-1 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-200'
            }
            onClick={() => setBlastTab('history')}
          >
            Sent History
          </button>
          <button
            type="button"
            className={
              blastTab === 'replies'
                ? 'flex-1 rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-white'
                : 'flex-1 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-200'
            }
            onClick={() => setBlastTab('replies')}
          >
            Replies
          </button>
        </div>

        {blastTab === 'launch' && (
          <div className="section space-y-5">
            <EmailTemplateAccordion
              embedded
              campaignId={campaign.id}
              defaultOpen={emailSaved}
              appId={campaign.app_id}
              templateId={blastTemplateId}
              subject={blastSubject}
              body={blastBody}
              appName={liveBranding.appName}
              valueProp={liveBranding.valueProp}
              onChange={onEmailChange}
              onBlur={() => {
                void saveEmailCopy(emailDraft.current).catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : 'Could not save the email');
                });
              }}
            />

            <div>
              <p className="label">
                Recipients ({audienceMembers.length})
              </p>
              {audienceMembers.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No members in the selected audience.
                </p>
              ) : (
                <ul className="max-h-40 overflow-auto divide-y divide-slate-800 rounded-lg border border-slate-800">
                  {audienceMembers.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span className="truncate text-slate-200">{m.email}</span>
                      <span className="shrink-0 rounded-full border border-slate-800 bg-white/[0.03] px-2 py-0.5 text-[11px] text-slate-400">
                        {m.display_name || '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {(blastProgress.sending || blastProgress.done > 0) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>
                    {blastProgress.sending
                      ? `Sending… ${blastProgress.done}/${blastProgress.total}`
                      : `Completed ${blastProgress.done}/${blastProgress.total}`}
                  </span>
                  <span className="tabular-nums text-accent">{progressPct}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full border border-slate-800 bg-white/[0.04]">
                  <div
                    className="h-full rounded-full bg-accent shadow-[0_0_12px_rgba(91,141,239,0.55)] transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <ul className="max-h-36 overflow-auto rounded-lg border border-slate-800 bg-black/30 p-2 font-mono text-[11px] text-slate-300">
                  {blastLog.map((l, i) => (
                    <li key={`${l.email}-${i}`} className="py-0.5">
                      Sending to {l.email}…{' '}
                      {l.status === 'sending' && (
                        <span className="text-amber-300">[…]</span>
                      )}
                      {l.status === 'sent' && (
                        <span className="text-emerald-400">[Done]</span>
                      )}
                      {l.status === 'failed' && (
                        <span className="text-red-400">
                          [Failed]{l.error ? ` ${l.error}` : ''}
                        </span>
                      )}
                      {l.status === 'skipped' && (
                        <span className="text-amber-200">
                          [Skipped]{l.error ? ` ${l.error}` : ''}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label className="label" htmlFor="test-to">
                  Send test email
                </label>
                <input
                  id="test-to"
                  className="input"
                  type="email"
                  placeholder="you@example.com"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy !== null || !testEmail.trim()}
                onClick={() => void onSendTest()}
              >
                <FlaskConical className="h-4 w-4" />
                {busy === 'blast-test' ? 'Sending…' : 'Send Test'}
              </button>
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={overrideDuplicates}
                  onChange={(e) => setOverrideDuplicates(e.target.checked)}
                />
                Send even if this email was already contacted
              </label>
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || audienceMembers.length === 0}
                onClick={() => void onLaunchBlast()}
              >
                <Rocket className="h-4 w-4" />
                {busy === 'blast-send' ? 'Launching…' : 'Launch Blast'}
              </button>
            </div>
          </div>
        )}

        {blastTab === 'replies' && <RepliesPanel campaignId={campaign.id} />}

        {blastTab === 'history' && (
          <div className="section space-y-3">
            <h2 className="text-sm font-semibold text-white">Sent History</h2>
            {blastSends.length === 0 ? (
              <p className="text-sm text-slate-500">No sends yet.</p>
            ) : (
              <div className="max-w-full overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead className="border-b border-slate-800 bg-white/[0.02] text-[11px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Recipient</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Sent At</th>
                      <th className="px-3 py-2 font-medium">Preview</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {blastHistory.slice(blastSends).map((row) => (
                      <tr key={row.id} className="text-slate-300">
                        <td className="px-3 py-2">
                          <p className="text-white">{row.email}</p>
                          <p className="text-[11px] text-slate-500">
                            {audienceMembers.find(
                              (m) =>
                                m.id === row.member_id || m.email === row.email,
                            )?.display_name || '—'}
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                              row.status === 'sent'
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                : row.status === 'failed'
                                  ? 'border-red-500/30 bg-red-500/10 text-red-300'
                                  : row.status === 'skipped'
                                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                                    : 'border-sky-500/30 bg-sky-500/10 text-sky-300'
                            }`}
                          >
                            {row.status === 'skipped' ? skipReasonLabel(row.error) : row.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-400">
                          {row.sent_at
                            ? new Date(row.sent_at).toLocaleString('en-GB', {
                                timeZone: 'Europe/London',
                              }) + ' LT'
                            : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <IconButton label="Preview" onClick={() => openHistoryPreview(row)}>
                            <Eye className="h-3.5 w-3.5" />
                          </IconButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {blastSends.length > SHOW_MORE_LIMIT && (
                  <ShowMore
                    total={blastSends.length}
                    expanded={blastHistory.expanded}
                    onToggle={blastHistory.toggle}
                    lined
                  />
                )}
              </div>
            )}
          </div>
        )}

        {previewSend && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="card max-h-[85vh] w-full max-w-lg overflow-y-auto border-slate-800 shadow-[0_0_40px_rgba(91,141,239,0.15)]">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">
                  Preview · {previewSend.email}
                </h3>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => setPreviewSend(null)}
                >
                  Close
                </button>
              </div>
              <p className="label">Subject</p>
              <p className="mb-3 text-sm text-slate-200">{previewSend.subject}</p>
              <p className="label">Body</p>
              <pre className="whitespace-pre-wrap rounded-lg border border-slate-800 bg-black/30 p-3 text-xs text-slate-300">
                {previewSend.body}
              </pre>
            </div>
          </div>
        )}
      </PageColumn>
    );
  }

  return (
    <PageColumn>
      <div>
        <button
          type="button"
          className="text-xs text-slate-500 hover:text-accent"
          onClick={() => goBack(navigate, '/campaigns')}
        >
          ← {hasInAppHistory() ? 'Back' : 'Campaigns'}
        </button>
        <div className="mt-2 flex min-w-0 flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold tracking-tight text-white">
              {campaign.name}
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
              <span>
                {campaignSheet
                  ? `${visibleCreators.length} creators · ${withEmail} with email · limit ${campaign.result_limit} · ${runLabel}`
                  : matchNote
                    ? `${matchNote}${unsavedCount > 0 ? ` ${unsavedCount} not saved.` : ''} ${withEmail} with email · limit ${campaign.result_limit} · ${runLabel}`
                    : `${visibleCreators.length} creators · ${withEmail} with email · limit ${campaign.result_limit} · ${runLabel}`}
              </span>
              {offerSheet && shortfallDismissed && (
                <button
                  type="button"
                  className="pill-idle"
                  onClick={() => {
                    if (!latestRunId) return;
                    setReopenedRunId(latestRunId);
                    setDismissedRunId(null);
                  }}
                >
                  Find more
                </button>
              )}
            </p>
            <div className="mt-4 inline-flex max-w-full flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-white/[0.03] px-4 py-2">
              <InlineToggle
                label="Require public email"
                checked={campaign.require_public_email !== false}
                onChange={(next) => void onSetRequireEmail(next)}
                ariaLabel="Require public email"
                hint="Only list creators whose bio already shows a public email."
              />
              <InlineToggle
                label="Auto-email found creators"
                checked={campaign.auto_outreach === true}
                onChange={(next) => void onSetAutoEmail(next)}
                ariaLabel="Auto-email found creators"
                hint="Off by default. Sends after discovery only when a template is set."
              />
              <InlineToggle
                label="Include CRM creators"
                checked={includeCrm}
                onChange={(next) => void onSetIncludeCrm(next)}
                ariaLabel="Include CRM creators"
                hint="Off skips people already in this app. They do not count toward the limit."
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DiscoverySourceControl
                subtle
                value={asDiscoverySource(campaign.discovery_source) ?? 'both'}
                disabled={busy !== null || searchRunning}
                onChange={(next) => void onSetDiscoverySource(next)}
              />
              <CompactHashtags tags={campaign.hashtags ?? []} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-col items-stretch gap-1 sm:items-end">
              {searchRunning ? (
                <button type="button" className="btn-primary" disabled>
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  {stoppingSearch ? 'Stopping…' : 'Searching…'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== null || continuing !== null}
                  onClick={() => void onFindAndPitch()}
                  title={
                    apifyOk
                      ? 'Finds creators only. Turn on Auto-email to send after discovery.'
                      : 'Requires APIFY_TOKEN on the API'
                  }
                >
                  <Sparkles className="h-4 w-4" />
                  Find creators
                </button>
              )}
            </div>
            <div className="relative">
              <button
                type="button"
                className="btn-ghost !px-2"
                aria-label="Campaign settings"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                <Settings className="h-4 w-4" />
              </button>
              {advancedOpen && (
                <div className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-white/10 bg-surface-raised p-3 shadow-lg">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5 text-sm text-ink">
                      Daily Auto-Run
                      <InfoTip
                        label="Daily Auto-Run details"
                        text="Searches on a schedule. Sends only when Auto-email is on."
                      />
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(campaign.is_autopilot_enabled)}
                      disabled={busy !== null}
                      className={
                        campaign.is_autopilot_enabled ? 'toggle-on' : 'toggle-off'
                      }
                      onClick={() => void onToggleSchedule()}
                    >
                      <span
                        className="toggle-knob"
                        style={{
                          left: campaign.is_autopilot_enabled
                            ? '1.25rem'
                            : '0.125rem',
                        }}
                      />
                    </button>
                  </div>
                  <div className="mt-3 border-t border-line pt-3">
                    <InlineToggle
                      label="Include CRM creators"
                      checked={includeCrm}
                      onChange={(next) => void onSetIncludeCrm(next)}
                      ariaLabel="Include CRM creators"
                      disabled={busy !== null}
                      hint="Off skips people already in this app. They do not count toward the limit."
                    />
                  </div>
                  <button
                    type="button"
                    className="mt-2 block w-full rounded-md px-2 py-2 text-left text-sm text-slate-300 hover:bg-white/[0.04]"
                    onClick={() => {
                      setAdvancedOpen(false);
                      setEditOpen(true);
                    }}
                  >
                    Edit filters
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-2 text-left text-sm text-slate-300 hover:bg-white/[0.04]"
                    disabled={busy !== null}
                    onClick={() => void onDemo()}
                  >
                    {busy === 'demo' ? 'Running…' : 'Run demo discovery'}
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-2 text-left text-sm text-slate-300 hover:bg-white/[0.04]"
                    disabled={busy !== null}
                    onClick={() => void onScheduleRunNow()}
                  >
                    {busy === 'schedule-run' ? 'Running…' : 'Run Daily Auto-Run now'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {!apiOk && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-slate-500">
          Express API not reachable. Start with{' '}
          <code className="text-xs">npm run server</code>.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {searchRunning && (
        <SearchProgressPanel
          stage={(continuing && expandProgress) || liveStage || 'Starting the search…'}
          found={liveFound}
          target={progressTarget}
          checked={liveChecked}
          elapsedSeconds={elapsedSeconds}
          stopping={stoppingSearch}
          onStop={() => void onStopSearch()}
        />
      )}
      {!searchRunning &&
        (runOutcome || persistedOutcome) &&
        (runOutcome?.title ?? persistedOutcome?.title) !==
          'A search is already running for this campaign.' && (
        <DiscoveryRunNote
          title={runOutcome?.title ?? persistedOutcome?.title ?? ''}
          action={runOutcome?.action ?? persistedOutcome?.action}
          jobId={runOutcome?.jobId ?? null}
          funnel={runOutcome?.funnel ?? latestFunnel}
        />
      )}
      {runMsg && !searchRunning && !campaignSheet && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-slate-300">
          {runMsg}
        </div>
      )}
      {!searchRunning && (yieldPills.length > 0 || yieldFallbackTags.length > 0) && !offerSheet && (
        <HashtagYieldNote
          rows={yieldRows}
          pills={yieldPills}
          requireEmail={requirePublicEmail}
          fallbackTags={yieldFallbackTags}
          fallbackSource={yieldFallbackSource}
          savingPack={savingStrongPack}
          onSaveStrong={saveStrongPack}
        />
      )}

      {!searchRunning && (
      <EmailTemplateAccordion
        mode="template"
        campaignId={campaign.id}
        defaultOpen={false}
        reveal={revealTemplate}
        appId={campaign.app_id}
        templateId={blastTemplateId}
        subject={blastSubject}
        body={blastBody}
        appName={liveBranding.appName}
        valueProp={liveBranding.valueProp}
        onChange={onEmailChange}
        onBlur={() => {
          void saveEmailCopy(emailDraft.current).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : 'Could not save the email');
          });
        }}
      />
      )}

      <section className="section">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="text-base font-medium text-white">Creators</h2>
          </div>
          <div className="flex items-center gap-2">
            {existingCreators.length > 0 && (
              <Link
                to={`/creators?${new URLSearchParams({
                  handles: existingCreators.map((c) => c.handle).join(','),
                }).toString()}`}
                className="btn-ghost !px-3 !py-1.5 text-xs"
              >
                Open in CRM
              </Link>
            )}
            <button
              type="button"
              className="btn-secondary !px-3 !py-1.5 text-xs"
              disabled={
                !visibleCreators.some(
                  (c) => c.email && !c.unsaved && c.do_not_contact !== true,
                )
              }
              onClick={() =>
                openSend(
                  visibleCreators.filter(
                    (c) => c.email && !c.unsaved && c.do_not_contact !== true,
                  ),
                )
              }
            >
              Email all
            </button>
          </div>
        </div>
        {!searchRunning && creators.length > 0 &&
          (() => {
            if (!displayFunnel || !showFunnelExplanation(displayFunnel)) return null;
            return (
              <div className="mb-4">
                <DiscoveryFunnelNote funnel={displayFunnel} compact hideYield />
              </div>
            );
          })()}
        <div className="divide-y divide-line">
          {visibleCreators.length === 0 && (
            <div className="py-8 text-center">
              {searchRunning || busy === 'demo' || busy === 'schedule-run' ? (
                <p className="text-sm text-ink-faint">
                  Creators will appear here as they are found.
                </p>
              ) : (
                (() => {
                  if (displayFunnel && showFunnelExplanation(displayFunnel)) {
                    return (
                      <DiscoveryFunnelNote
                        funnel={displayFunnel}
                        hideYield
                        onWiden={suggestWidenRange(displayFunnel) ? () => void onWidenRange() : undefined}
                        onIncludeExisting={
                          suggestIncludeExisting(displayFunnel) ? () => void onSetIncludeCrm(true) : undefined
                        }
                        onTurnOffEmail={
                          suggestTurnOffEmail(displayFunnel)
                            ? () => void onSetRequireEmail(false)
                            : undefined
                        }
                      />
                    );
                  }
                  if (!includeCrm && crmToggleCount > 0) {
                    return (
                      <p className="text-sm text-ink-faint">
                        {crmToggleCount} already in the CRM are hidden. Turn on Include CRM creators to see them.
                      </p>
                    );
                  }
                  return (
                    <p className="text-sm text-slate-500">No creators yet. Find creators to start.</p>
                  );
                })()
              )}
            </div>
          )}
          {creatorRows.slice(visibleCreators).map((c) => (
            <CreatorListRow
              key={c.id}
              creator={c}
              entering={freshCreatorIds.has(c.id)}
              busy={busy === c.id}
              onSend={c.unsaved ? undefined : () => openSend([c])}
              onSkip={c.unsaved ? undefined : () => void onSkip(c)}
              onToggleReplied={c.unsaved ? undefined : () => void onToggleReplied(c)}
            />
          ))}
          {visibleCreators.length > SHOW_MORE_LIMIT && (
            <ShowMore
              total={visibleCreators.length}
              expanded={creatorRows.expanded}
              onToggle={creatorRows.toggle}
            />
          )}
        </div>
      </section>

      {!searchRunning && runs.length > 0 && (
        <section className="section">
          <h2 className="mb-3 text-sm font-medium text-ink">Recent runs</h2>
          <ul className="mt-3 space-y-2 text-sm text-ink-faint">
            {recentRuns.slice(runs).map((r) => {
              const funnel =
                r.id === runs[0]?.id && displayFunnel ? displayFunnel : asDiscoveryFunnel(r.funnel);
              return (
                <li key={r.id}>
                  {r.provider} · {r.results_count} results ·{' '}
                  {new Date(r.created_at).toLocaleString('en-GB', {
                    timeZone: 'Europe/London',
                  })}{' '}
                  LT
                  {r.error && <p className="mt-1 text-xs text-red-300">{r.error}</p>}
                  {funnel && (
                    <DiscoveryFunnelNote
                      funnel={funnel}
                      compact
                      hideYield={r.id === runs[0]?.id}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <ShowMore
            total={runs.length}
            expanded={recentRuns.expanded}
            onToggle={recentRuns.toggle}
            spaced
          />
        </section>
      )}

      {cardSheet && (
        <FindMoreCard
          sheet={cardSheet}
          busy={continuing}
          progress={expandProgress}
          onDismiss={() => {
            if (!latestRunId) return;
            setDismissedRunId(latestRunId);
            setReopenedRunId(null);
          }}
          onExpand={(tags) => void onContinueShortfall('expand', tags)}
          onRelaxEmail={() => void onContinueShortfall('relax')}
          onCustom={(tags, addToCampaign) => void onContinueShortfall('custom', tags, addToCampaign)}
          onAccept={() => void onAcceptShortfall()}
          onNetwork={() => void onNetworkExpand()}
        />
      )}
      <EditFiltersModal
        open={editOpen}
        campaign={campaign}
        busy={busy === 'filters'}
        aiFallback={aiFallback}
        onAiFallback={setAiFallback}
        onClose={() => setEditOpen(false)}
        onSave={(p) => void onSaveFilters(p)}
      />
      <SendDrawer
        open={Boolean(sendTargets)}
        targets={sendTargets ?? []}
        appName={liveBranding.appName}
        valueProp={liveBranding.valueProp}
        storeUrl={(apps.find((app) => app.id === campaign?.app_id) ?? selected)?.store_url}
        appId={campaign?.app_id}
        initialTemplateId={campaign?.template_id}
        initialSubject={campaign?.email_subject || ''}
        initialBody={campaign?.email_body || ''}
        onClose={() => setSendTargets(null)}
        onFinished={load}
      />
    </PageColumn>
  );
}
