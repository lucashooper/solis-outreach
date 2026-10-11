import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Compass, Mail, Rocket, Save } from 'lucide-react';
import { suggestedCampaignName } from '../lib/campaignNames';
import {
  normaliseHashtags,
  normaliseNiche,
  partitionListInput,
} from '../../../src/discovery/hashtags.ts';
import { AudienceFacts } from '../components/AudienceFacts';
import { ConnectBanner } from '../components/ConnectBanner';
import { TemplateFields } from '../components/TemplateFields';
import { useAppScope } from '../lib/apps';
import { isConfigured } from '../lib/settings';
import {
  createCampaign,
  createCampaignPreset,
  fetchAudiences,
  fetchCampaignPresets,
  type AudienceGroup,
} from '../lib/supabase';
import type { CampaignFormData, CampaignType } from '../lib/types';
import { NICHE_SUGGESTIONS, PLATFORMS } from '../lib/types';
import { DiscoveryCostNote } from '../components/DiscoveryCostNote';
import { FilterToggleRow, InfoTip } from '../components/InfoTip';
import { NarrowRangeHint } from '../components/NarrowRangeHint';
import { IncludeExistingSwitch } from '../components/IncludeExistingSwitch';
import { DiscoverySourceControl } from '../components/DiscoverySourceControl';
import { RequirePublicEmailToggle } from '../components/RequirePublicEmailToggle';
import { HashtagField } from '../components/HashtagField';
import { HashtagPresets } from '../components/HashtagPresets';
import type { HashtagPack } from '../../../src/discovery/hashtagPacks.ts';
import {
  deleteHashtagPack,
  loadHashtagPacks,
  renameHashtagPack,
  saveHashtagPack,
} from '../lib/hashtagPacks';
import { useFeedback } from '../components/feedback';
import { goBack, hasInAppHistory } from '../lib/back';

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

const PRESET_QUERY: Record<
  string,
  Partial<CampaignFormData> & { name: string }
> = {
  micro: {
    name: 'Micro-Influencers',
    niches: ['lifestyle', 'fitness'],
    platforms: ['tiktok', 'instagram'],
    follower_min: '5000',
    follower_max: '35000',
    engagement_rate_min: '4',
    result_limit: '10',
    is_autopilot_enabled: false,
    auto_outreach: false,
  },
  saas: {
    name: 'SaaS Tech Reviewers',
    niches: ['tech', 'saas'],
    platforms: ['tiktok', 'instagram'],
    follower_min: '10000',
    follower_max: '100000',
    engagement_rate_min: '3',
    result_limit: '10',
    is_autopilot_enabled: false,
    auto_outreach: false,
  },
  ugc: {
    name: 'UGC Creators',
    niches: ['ugc', 'lifestyle'],
    platforms: ['tiktok', 'instagram'],
    follower_min: '5000',
    follower_max: '50000',
    engagement_rate_min: '5',
    result_limit: '10',
    is_autopilot_enabled: false,
    auto_outreach: false,
  },
};

function silentBranding(): { app_name: string; value_prop: string } {
  return {
    app_name: import.meta.env.VITE_APP_NAME?.trim() || 'Solis',
    value_prop:
      import.meta.env.VITE_APP_VALUE_PROP?.trim() ||
      'helps creators monetise short-form content without ads',
  };
}

const BLAST_DEFAULT_BODY = `Hi {{display_name}},

We're reaching out from {{app_name}} with a quick update.

Reply to this email if you'd like to chat.

Cheers,
{{app_name}} team`;

export function CampaignNew() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const connected = isConfigured();
  const { appId, ready, selected } = useAppScope();
  const { toast } = useFeedback();
  const envBranding = silentBranding();
  const branding = {
    app_name: selected?.name || envBranding.app_name,
    value_prop: selected?.value_prop?.trim() || envBranding.value_prop,
  };

  const [campaignType, setCampaignType] = useState<CampaignType>('discovery');
  const [audiences, setAudiences] = useState<AudienceGroup[]>([]);
  const [audienceGroupId, setAudienceGroupId] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [autoEmail, setAutoEmail] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [form, setForm] = useState<CampaignFormData>({
    name: '',
    niches: [],
    platforms: ['tiktok'],
    follower_min: '10000',
    follower_max: '500000',
    engagement_rate_min: '',
    result_limit: '10',
    require_public_email: true,
    include_crm_creators: false,
    discovery_source: 'both',
    auto_outreach: false,
    is_autopilot_enabled: false,
    schedule_cron: '0 10 * * *',
    app_name: branding.app_name,
    value_prop: branding.value_prop,
  });
  const [nicheInput, setNicheInput] = useState('');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [hashtagInput, setHashtagInput] = useState('');
  const [customPacks, setCustomPacks] = useState<HashtagPack[]>([]);
  const [systemPacks, setSystemPacks] = useState<HashtagPack[]>([]);
  const [savingPack, setSavingPack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const chooseType = (type: CampaignType) => {
    setCampaignType(type);
    if (type !== 'direct_blast') return;
    setEmailSubject((current) => current.trim() || 'A note from {{app_name}}');
    setEmailBody((current) => current.trim() || BLAST_DEFAULT_BODY);
  };

  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    loadHashtagPacks(appId)
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
  }, [appId]);

  useEffect(() => {
    const type = params.get('type');
    if (type === 'direct_blast') chooseType('direct_blast');
    // Fill the blast copy once when the page opens on Direct Blast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    const preset = params.get('preset');
    if (!preset) return;
    const builtin = PRESET_QUERY[preset];
    if (builtin) {
      setCampaignType('discovery');
      setHashtags([]);
      setForm((f) => ({
        ...f,
        ...builtin,
        result_limit: builtin.result_limit || '10',
        include_crm_creators: false,
        engagement_rate_min: builtin.engagement_rate_min ?? '',
        app_name: branding.app_name,
        value_prop: branding.value_prop,
        schedule_cron: builtin.schedule_cron || '0 10 * * *',
      }));
      return;
    }
    if (!connected || !appId) return;
    let cancelled = false;
    fetchCampaignPresets(appId)
      .then((rows) => {
        if (cancelled) return;
        const found = rows.find((row) => row.id === preset);
        if (!found) return;
        setCampaignType('discovery');
        setHashtags(found.hashtags ?? []);
        setForm((f) => ({
          ...f,
          name: found.name,
          niches: found.niches ?? [],
          platforms: found.platforms?.length ? found.platforms : ['tiktok'],
          follower_min: found.follower_min != null ? String(found.follower_min) : '',
          follower_max: found.follower_max != null ? String(found.follower_max) : '',
          engagement_rate_min:
            found.engagement_rate_min != null ? String(found.engagement_rate_min) : '',
          result_limit: String(found.result_limit || 10),
          include_crm_creators: found.include_crm_creators === true,
          is_autopilot_enabled: found.is_autopilot_enabled,
          auto_outreach: false,
          app_name: branding.app_name,
          value_prop: branding.value_prop,
        }));
        setAutoEmail(false);
      })
      .catch(() => {
        /* The form stays editable if the preset cannot be loaded. */
      });
    return () => {
      cancelled = true;
    };
  }, [params, connected, appId, branding.app_name, branding.value_prop]);

  useEffect(() => {
    if (!connected || !ready || !appId || campaignType !== 'direct_blast') return;
    let cancelled = false;
    const requested = params.get('audience');
    fetchAudiences(appId)
      .then((list) => {
        if (cancelled) return;
        setAudiences(list);
        setAudienceGroupId((current) => {
          if (current && list.some((group) => group.id === current)) return current;
          if (requested && list.some((group) => group.id === requested)) return requested;
          return list[0]?.id ?? '';
        });
      })
      .catch(() => {
        if (!cancelled) setAudiences([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, ready, appId, campaignType, params]);

  const commitNiches = (raw: string, flush: boolean) => {
    const { parts, rest } = partitionListInput(raw, flush);
    const next = parts.map(normaliseNiche).filter(Boolean);
    if (next.length) {
      setForm((current) => {
        const niches = [...current.niches];
        for (const niche of next) {
          if (!niches.includes(niche)) niches.push(niche);
        }
        return { ...current, niches };
      });
    }
    setNicheInput(rest);
  };

  const removeNiche = (n: string) => {
    setForm((f) => ({ ...f, niches: f.niches.filter((x) => x !== n) }));
  };

  const commitHashtags = (raw: string, flush: boolean) => {
    const { parts, rest } = partitionListInput(raw, flush);
    const next = normaliseHashtags(parts);
    if (next.length) {
      setHashtags((current) => {
        const tags = [...current];
        for (const tag of next) {
          if (!tags.includes(tag)) tags.push(tag);
        }
        return tags;
      });
    }
    setHashtagInput(rest);
  };

  const togglePlatform = (p: string) => {
    setForm((f) => {
      const has = f.platforms.includes(p);
      const next = has ? f.platforms.filter((x) => x !== p) : [...f.platforms, p];
      return { ...f, platforms: next };
    });
  };

  const fMin = Number(form.follower_min) || 0;
  const fMax = Number(form.follower_max) || 1_000_000;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!connected) {
      setError('Connect Supabase first (npm run sync:env).');
      return;
    }
    const audienceName = audiences.find((group) => group.id === audienceGroupId)?.name;
    const name =
      form.name.trim() ||
      suggestedCampaignName({
        type: campaignType,
        audienceName,
        niches: form.niches,
      });

    if (campaignType === 'direct_blast') {
      if (!audienceGroupId) {
        setError('Select an audience group (create one under Audiences).');
        return;
      }
      if (!emailSubject.trim() || !emailBody.trim()) {
        setError('Subject and body are required for Direct Blast.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const created = await createCampaign({
          ...form,
          name,
          app_name: branding.app_name,
          value_prop: branding.value_prop,
          platforms: [],
          niches: [],
          campaign_type: 'direct_blast',
          audience_group_id: audienceGroupId,
          email_subject: emailSubject,
          email_body: emailBody,
          template_id: templateId,
          auto_outreach: false,
          is_autopilot_enabled: false,
        }, appId);
        navigate(`/campaigns/${created.id}`);
      } catch (err: unknown) {
        setError(
          err instanceof Error && err.message.trim()
            ? err.message
            : 'Failed to create campaign',
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    if (form.platforms.length === 0) {
      setError('Select at least one platform.');
      return;
    }
    if (autoEmail && (!emailSubject.trim() || !emailBody.trim())) {
      setError('Add a subject and body before Auto-email can send.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
        const created = await createCampaign({
          ...form,
          name,
          hashtags,
          app_name: branding.app_name,
          value_prop: branding.value_prop,
          result_limit: form.result_limit || '10',
          engagement_rate_min: form.engagement_rate_min || '',
          auto_outreach: autoEmail,
          is_autopilot_enabled: form.is_autopilot_enabled,
          campaign_type: 'discovery',
          email_subject: autoEmail ? emailSubject : '',
          email_body: autoEmail ? emailBody : '',
          template_id: autoEmail ? templateId : null,
        }, appId);
      navigate(`/campaigns/${created.id}`);
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message.trim()
          ? err.message
          : 'Failed to create campaign';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const onSavePreset = async () => {
    if (!connected || !appId) {
      setError('Choose an app before saving a preset.');
      return;
    }
    if (!form.name.trim()) {
      setError('Name the preset before saving.');
      return;
    }
    setSavingPreset(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await createCampaignPreset(
        {
          ...form,
          hashtags,
          app_name: branding.app_name,
          value_prop: branding.value_prop,
        },
        appId,
      );
      setNotice(`Saved preset “${saved.name}”.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save that preset');
    } finally {
      setSavingPreset(false);
    }
  };

  return (
    <div className="page">
      <div>
        <button
          type="button"
          className="text-sm text-ink-faint hover:text-accent"
          onClick={() => goBack(navigate, '/campaigns')}
        >
          ← {hasInAppHistory() ? 'Back' : 'Campaigns'}
        </button>
        <h1 className="page-title mt-2">New campaign</h1>
      </div>

      {!connected && <ConnectBanner />}

      <form onSubmit={(e) => void onSubmit(e)} className="section space-y-8">
        <fieldset>
          <legend className="label">Campaign type</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                {
                  key: 'discovery' as const,
                  title: 'Discovery',
                  line: 'Find new creators and pitch them.',
                  icon: Compass,
                },
                {
                  key: 'direct_blast' as const,
                  title: 'Direct Blast',
                  line: 'Email a saved audience.',
                  icon: Mail,
                },
              ]
            ).map((option) => {
              const selected = campaignType === option.key;
              const Icon = option.icon;
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={selected}
                  className={`rounded-2xl border p-4 text-left ${
                    selected
                      ? 'border-line-strong bg-white/[0.04]'
                      : 'border-line bg-transparent hover:border-line-strong'
                  }`}
                  onClick={() => chooseType(option.key)}
                >
                  <Icon className="h-4 w-4 text-ink-muted" />
                  <p className="mt-3 text-sm font-medium text-ink">{option.title}</p>
                  <p className="mt-1 text-sm text-ink-faint">{option.line}</p>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            className="input"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={suggestedCampaignName({
              type: campaignType,
              audienceName: audiences.find((group) => group.id === audienceGroupId)?.name,
              niches: form.niches,
            })}
          />
          <p className="mt-1 text-xs text-ink-faint">Emails use {branding.app_name}.</p>
        </div>

        {campaignType === 'direct_blast' ? (
          <>
            <div>
              <label className="label" htmlFor="audience">
                Audience group
              </label>
              {audiences.length === 0 ? (
                <p className="text-sm text-ink-faint">
                  No audiences for this app yet.{' '}
                  <Link to="/audiences" className="text-accent underline">
                    Create one
                  </Link>
                  .
                </p>
              ) : (
                <div id="audience" className="grid gap-2 sm:grid-cols-2" role="listbox" aria-label="Audience group">
                  {[...audiences]
                    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
                    .map((group) => {
                    const selected = group.id === audienceGroupId;
                    return (
                      <button
                        key={group.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`rounded-2xl border px-4 py-3 text-left ${
                          selected
                            ? 'border-line-strong bg-white/[0.06]'
                            : 'border-line bg-transparent hover:border-line-strong'
                        }`}
                        onClick={() => setAudienceGroupId(group.id)}
                      >
                        <p className="text-sm font-medium text-ink">{group.name}</p>
                        <AudienceFacts group={group} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

          </>
        ) : (
          <>
            <div>
              <label className="label">Niches</label>
              <div className="mb-2 flex flex-wrap gap-2">
                {form.niches.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="pill-active"
                    onClick={() => removeNiche(n)}
                    title="Remove"
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
                {NICHE_SUGGESTIONS.filter((s) => !form.niches.includes(s)).map(
                  (s) => (
                    <button
                      key={s}
                      type="button"
                      className="pill-idle"
                      onClick={() => commitNiches(s, true)}
                    >
                      + {s}
                    </button>
                  ),
                )}
              </div>
            </div>

            <HashtagField
              id="hashtag"
              appId={appId}
              tags={hashtags}
              niches={form.niches}
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
                onApply={(pack) => {
                  setHashtags(normaliseHashtags(pack.hashtags));
                  setHashtagInput('');
                  toast('info', `Loaded ${pack.name}.`);
                }}
                onSave={async (packName) => {
                  if (!appId) {
                    toast('error', 'Choose an app before saving a pack.');
                    return false;
                  }
                  setSavingPack(true);
                  try {
                    const created = await saveHashtagPack(appId, packName, hashtags);
                    setCustomPacks((current) => [...current, created]);
                    toast('success', `Saved pack ${created.name}.`);
                    return true;
                  } catch (err) {
                    toast('error', err instanceof Error ? err.message : 'Could not save that pack');
                    return false;
                  } finally {
                    setSavingPack(false);
                  }
                }}
                onRename={(pack, nextName) => {
                  if (!appId) return;
                  const previous = pack.name;
                  setCustomPacks((current) =>
                    current.map((row) => (row.id === pack.id ? { ...row, name: nextName } : row)),
                  );
                  void renameHashtagPack(appId, pack, nextName).catch((err: unknown) => {
                    setCustomPacks((current) =>
                      current.map((row) => (row.id === pack.id ? { ...row, name: previous } : row)),
                    );
                    toast('error', err instanceof Error ? err.message : 'Could not rename that pack');
                  });
                }}
                onDelete={(pack) => {
                  if (!appId) return;
                  setCustomPacks((current) => current.filter((row) => row.id !== pack.id));
                  toast('info', `Deleted ${pack.name}.`, {
                    undo: () => setCustomPacks((current) => [...current, pack]),
                  });
                  void deleteHashtagPack(appId, pack).catch((err: unknown) => {
                    setCustomPacks((current) => [...current, pack]);
                    toast('error', err instanceof Error ? err.message : 'Could not delete that pack');
                  });
                }}
              />
            </HashtagField>

            <fieldset>
              <legend className="label">Platform</legend>
              <div className="flex flex-wrap gap-2">
                {PLATFORMS.map((p) => {
                  const active = form.platforms.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      className={active ? 'pill-active' : 'pill-idle'}
                      onClick={() => togglePlatform(p)}
                    >
                      {p === 'tiktok' ? 'TikTok' : 'Instagram'}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="space-y-4 rounded-xl border border-slate-800 bg-white/[0.03] p-4">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="label mb-0">Follower range</label>
                  <span className="text-xs tabular-nums text-sky-300">
                    {formatFollowers(fMin)} – {formatFollowers(fMax)}
                  </span>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                      Min
                    </p>
                    <input
                      type="range"
                      min={0}
                      max={1_000_000}
                      step={1000}
                      value={fMin}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setForm((f) => ({
                          ...f,
                          follower_min: String(v),
                          follower_max: String(
                            Math.max(v, Number(f.follower_max) || v),
                          ),
                        }));
                      }}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                      Max
                    </p>
                    <input
                      type="range"
                      min={1000}
                      max={2_000_000}
                      step={5000}
                      value={fMax}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setForm((f) => ({
                          ...f,
                          follower_max: String(v),
                          follower_min: String(
                            Math.min(Number(f.follower_min) || 0, v),
                          ),
                        }));
                      }}
                    />
                  </div>
                </div>
                <NarrowRangeHint min={fMin} max={fMax} />
              </div>
            </div>

            <FilterToggleRow>
              <RequirePublicEmailToggle
                checked={form.require_public_email !== false}
                onChange={(next) => setForm((current) => ({ ...current, require_public_email: next }))}
              />
              <IncludeExistingSwitch
                checked={form.include_crm_creators === true}
                onChange={(next) => setForm((current) => ({ ...current, include_crm_creators: next }))}
              />
            </FilterToggleRow>

            <div className="rounded-xl border border-line">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <span className="text-sm font-medium text-ink">Advanced</span>
                <ChevronDown className={`h-4 w-4 text-ink-faint ${advancedOpen ? 'rotate-180' : ''}`} />
              </button>
              {advancedOpen && (
                <div className="space-y-5 border-t border-line px-4 py-4">
                  <div>
                    <label className="label" htmlFor="eng-min">
                      Min engagement %
                    </label>
                    <input
                      id="eng-min"
                      className="input"
                      type="number"
                      step="0.1"
                      min={0}
                      placeholder="e.g. 4"
                      value={form.engagement_rate_min}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, engagement_rate_min: e.target.value }))
                      }
                    />
                  </div>
                  <DiscoverySourceControl
                    value={form.discovery_source ?? 'both'}
                    onChange={(next) => setForm((f) => ({ ...f, discovery_source: next }))}
                  />
                  <div>
                    <label className="label" htmlFor="result-limit">
                      <span className="inline-flex items-center gap-2">
                        Result limit
                        <DiscoveryCostNote
                          limit={Number(form.result_limit) || 10}
                          requireEmail={form.require_public_email !== false}
                          source={form.discovery_source ?? 'both'}
                        />
                      </span>
                    </label>
                    <input
                      id="result-limit"
                      className="input"
                      inputMode="numeric"
                      min={1}
                      max={100}
                      value={form.result_limit}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, result_limit: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="min-creators">
                      <span className="inline-flex items-center gap-1.5">
                        Minimum creators
                        <InfoTip
                          label="Minimum creators details"
                          text="If the search is short, it can try one extra page. You can continue once after that."
                        />
                      </span>
                    </label>
                    <input
                      id="min-creators"
                      className="input"
                      inputMode="numeric"
                      min={1}
                      max={100}
                      placeholder="Optional"
                      value={form.min_creators || ''}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, min_creators: e.target.value }))
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <p className="inline-flex items-center gap-1.5 text-sm text-ink">
                      Daily Auto-Run
                      <InfoTip
                        label="Daily Auto-Run details"
                        text="Searches on a schedule. Sends only when Auto-email is on."
                      />
                    </p>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={form.is_autopilot_enabled}
                      className={
                        form.is_autopilot_enabled ? 'toggle-on' : 'toggle-off'
                      }
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          is_autopilot_enabled: !f.is_autopilot_enabled,
                        }))
                      }
                    >
                      <span
                        className="toggle-knob"
                        style={{
                          left: form.is_autopilot_enabled ? '1.25rem' : '0.125rem',
                        }}
                      />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {campaignType === 'direct_blast' ? (
          <TemplateFields
            appId={appId}
            templateId={templateId}
            subject={emailSubject}
            body={emailBody}
            appName={branding.app_name}
            valueProp={branding.value_prop}
            onChange={(next) => {
              setTemplateId(next.templateId);
              setEmailSubject(next.subject);
              setEmailBody(next.body);
            }}
          />
        ) : (
          <div className="rounded-xl border border-line">
            <div className="flex w-full items-center justify-between gap-3 px-4 py-3">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                aria-expanded={autoEmail}
                onClick={() => setAutoEmail((open) => !open)}
              >
                <span className="block text-sm font-medium text-ink">Auto-email found creators</span>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={autoEmail}
                aria-label="Auto-email found creators"
                title="Off by default. Turn this on, with a template, to send after discovery."
                className={autoEmail ? 'toggle-on' : 'toggle-off'}
                onClick={() => setAutoEmail((open) => !open)}
              >
                <span className="toggle-knob" style={{ left: autoEmail ? '1.25rem' : '0.125rem' }} />
              </button>
            </div>
            {autoEmail && (
              <div className="border-t border-line px-4 py-4">
                <TemplateFields
                  appId={appId}
                  templateId={templateId}
                  subject={emailSubject}
                  body={emailBody}
                  appName={branding.app_name}
                  valueProp={branding.value_prop}
                  onChange={(next) => {
                    setTemplateId(next.templateId);
                    setEmailSubject(next.subject);
                    setEmailBody(next.body);
                  }}
                />
              </div>
            )}
          </div>
        )}

        {notice && (
          <div className="rounded-2xl border border-line bg-white/[0.03] px-3 py-2 text-sm text-ink" role="status">
            {notice}
          </div>
        )}
        {error && (
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || savingPreset || !connected}
          >
            <Rocket className="h-4 w-4" />
            {busy ? 'Creating…' : 'Create campaign'}
          </button>
          {campaignType === 'discovery' && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || savingPreset || !connected}
              onClick={() => void onSavePreset()}
            >
              <Save className="h-4 w-4" />
              {savingPreset ? 'Saving…' : 'Save as preset'}
            </button>
          )}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => goBack(navigate, '/campaigns')}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
