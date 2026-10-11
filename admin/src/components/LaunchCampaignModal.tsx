import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import {
  discoveryAudienceName,
  planLaunch,
  skippedTotal,
  type LaunchRow,
} from '../../../src/audiences/naming.ts';
import { suggestedCampaignName } from '../lib/campaignNames';
import { readQuickMode } from '../lib/quickMode';
import {
  addAudienceMembers,
  createAudience,
  createCampaign,
  fetchEmailTemplates,
  lookupContactFlags,
  type DiscoveryHit,
} from '../lib/supabase';
import { TemplateFields } from './TemplateFields';
import { useFeedback } from './feedback';

const LAUNCH_KEY = 'solis-launch-campaign';

const BLAST_DEFAULT_SUBJECT = 'A note from {{app_name}}';
const BLAST_DEFAULT_BODY = `Hi {{display_name}},

We're reaching out from {{app_name}} with a quick update.

Reply to this email if you'd like to chat.

Cheers,
{{app_name}} team`;

export function LaunchCampaignModal({
  open,
  hits,
  niche,
  appId,
  appName,
  valueProp,
  onClose,
}: {
  open: boolean;
  hits: DiscoveryHit[];
  niche: string;
  appId: string | null;
  appName: string;
  valueProp: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { confirm, toast } = useFeedback();
  const [name, setName] = useState('');
  const [rows, setRows] = useState<LaunchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'save' | 'launch' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [subject, setSubject] = useState(BLAST_DEFAULT_SUBJECT);
  const [body, setBody] = useState(BLAST_DEFAULT_BODY);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (!open) return;
    setName(discoveryAudienceName(niche));
    setError(null);
    setBusy(null);
    setTemplateId(null);
    setSubject(BLAST_DEFAULT_SUBJECT);
    setBody(BLAST_DEFAULT_BODY);
    let cancelled = false;
    setLoading(true);
    const draft: LaunchRow[] = hits.map((hit) => ({
      handle: hit.handle,
      email: hit.email,
      doNotContact: false,
      alreadyContacted: false,
    }));
    setRows(draft);
    const load = async () => {
      try {
        const [flags, templates] = await Promise.all([
          appId
            ? lookupContactFlags(appId, hits)
            : Promise.resolve(
                {} as Record<string, { doNotContact: boolean; alreadyContacted: boolean }>,
              ),
          fetchEmailTemplates(appId),
        ]);
        if (cancelled) return;
        setRows(
          hits.map((hit) => {
            const key = `${hit.platform}:${hit.handle.replace(/^@/, '').toLowerCase()}`;
            const flag = flags[key];
            return {
              handle: hit.handle,
              email: hit.email,
              doNotContact: flag?.doNotContact === true,
              alreadyContacted: flag?.alreadyContacted === true,
            };
          }),
        );
        const direct = templates.find((row) => row.name === 'Direct blast') || templates[0];
        if (direct) {
          setTemplateId(direct.id);
          setSubject(direct.subject);
          setBody(direct.body);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not prepare this audience');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // Prepare once each time the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const plan = useMemo(() => planLaunch(rows), [rows]);
  const skipped = skippedTotal(plan);

  const saveGroup = async () => {
    if (!appId) throw new Error('Choose an app first.');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Name the audience.');
    if (plan.eligible.length === 0) throw new Error('No one with an email is left to add.');
    const group = await createAudience(trimmed, appId, 'discovery');
    await addAudienceMembers(group.id, {
      members: plan.eligible.map((row) => ({
        email: row.email,
        display_name: row.handle,
      })),
    });
    return group;
  };

  const onSaveOnly = async () => {
    setBusy('save');
    setError(null);
    try {
      const group = await saveGroup();
      toast('success', `Saved “${group.name}”.`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the audience');
    } finally {
      setBusy(null);
    }
  };

  const onLaunch = async () => {
    if (!appId) {
      setError('Choose an app first.');
      return;
    }
    if (plan.eligible.length === 0) {
      setError('No one with an email is left to contact.');
      return;
    }
    if (!subject.trim() || !body.trim()) {
      setError('Subject and body are required.');
      return;
    }
    if (!readQuickMode()) {
      const ok = await confirm({
        title: 'Launch campaign',
        body: `Send this blast to ${plan.eligible.length} recipient${plan.eligible.length === 1 ? '' : 's'}?`,
        confirmLabel: 'Launch',
      });
      if (!ok) return;
    }
    setBusy('launch');
    setError(null);
    try {
      const group = await saveGroup();
      const created = await createCampaign(
        {
          name:
            name.trim() ||
            suggestedCampaignName({ type: 'direct_blast', audienceName: group.name }),
          niches: [],
          platforms: [],
          follower_min: '',
          follower_max: '',
          engagement_rate_min: '',
          result_limit: '1',
          auto_outreach: false,
          is_autopilot_enabled: false,
          schedule_cron: '0 10 * * *',
          app_name: appName,
          value_prop: valueProp,
          campaign_type: 'direct_blast',
          audience_group_id: group.id,
          email_subject: subject,
          email_body: body,
          template_id: templateId,
        },
        appId,
      );
      try {
        sessionStorage.setItem(LAUNCH_KEY, created.id);
      } catch {
        /* The campaign page will not auto-send if storage is blocked. */
      }
      onClose();
      navigate(`/campaigns/${created.id}?launch=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not launch the campaign');
      setBusy(null);
    }
  };

  if (!open) return null;

  const skipBits = [
    plan.skipped.noEmail ? `${plan.skipped.noEmail} no email` : '',
    plan.skipped.doNotContact ? `${plan.skipped.doNotContact} do not contact` : '',
    plan.skipped.alreadyContacted ? `${plan.skipped.alreadyContacted} already contacted` : '',
  ].filter(Boolean);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-campaign-title"
        className="flex max-h-[min(44rem,calc(100vh-2rem))] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 id="launch-campaign-title" className="text-base font-medium text-ink">
              Launch campaign
            </h2>
            <p className="mt-1 text-sm text-ink-faint">
              {loading
                ? 'Checking who can be emailed…'
                : `${hits.length} creator${hits.length === 1 ? '' : 's'} · ${plan.eligible.length} eligible · ${skipped} skipped`}
            </p>
          </div>
          <button type="button" className="btn-ghost !px-2 !py-1" onClick={onClose} disabled={Boolean(busy)} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <label>
            <span className="label">Audience</span>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          {!loading && skipBits.length > 0 && (
            <p className="text-sm text-ink-faint">Skipped: {skipBits.join(', ')}.</p>
          )}
          <TemplateFields
            appId={appId}
            templateId={templateId}
            subject={subject}
            body={body}
            appName={appName}
            valueProp={valueProp}
            onChange={(next) => {
              setTemplateId(next.templateId);
              setSubject(next.subject);
              setBody(next.body);
            }}
          />
          {error && (
            <p className="text-sm text-red-300" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            type="button"
            className="btn-secondary"
            disabled={Boolean(busy) || loading}
            onClick={() => void onSaveOnly()}
          >
            {busy === 'save' ? 'Saving…' : 'Save audience only'}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={Boolean(busy) || loading || plan.eligible.length === 0}
            onClick={() => void onLaunch()}
          >
            {busy === 'launch' ? 'Launching…' : 'Launch'}
          </button>
        </div>
      </div>
    </div>
  );
}

export const LAUNCH_CAMPAIGN_STORAGE_KEY = LAUNCH_KEY;
