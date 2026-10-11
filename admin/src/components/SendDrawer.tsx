import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { renderTemplate } from '../../../src/templates/tokens.ts';
import {
  emptyVideoHookProvenance,
  fallbackVideoHook,
  type VideoHookProvenance,
  type VideoHookSource,
} from '../../../src/templates/videoHook.ts';
import { Drawer } from './Drawer';
import { HookSourceDisclosure } from './HookSourceDisclosure';
import { TemplateFields } from './TemplateFields';
import { useFeedback } from './feedback';
import { readQuickMode } from '../lib/quickMode';
import { skipReasonLabel } from '../lib/skipReason';
import {
  approveCreator,
  ensureVideoHooks,
  fetchEmailTemplate,
  fetchEmailTemplates,
  saveCreatorVideoHook,
} from '../lib/supabase';

export interface SendTarget {
  id?: string;
  handle: string;
  email: string | null;
  platform?: string | null;
  bio?: string | null;
  /** TikTok display name, when it is not just the handle. */
  displayName?: string | null;
  hook?: string | null;
  doNotContact?: boolean;
  topic?: string | null;
  niches?: string[] | null;
  captions?: string[] | null;
  videos?: Array<{
    caption?: string | null;
    video_url?: string | null;
    scraped_at?: string | null;
  }> | null;
  /** creators.created_at, shown as Found on when a video has no scrape time. */
  foundAt?: string | null;
}

interface HookState {
  text: string;
  source: VideoHookSource;
  basis: string;
  edited: boolean;
  provenance: VideoHookProvenance;
}

const DEFAULT_SUBJECT = 'Collab idea for @{{creator_handle}} — {{app_name}}';

function usesVideoHook(subject: string, body: string): boolean {
  return /\{\{\s*video_hook\s*\}\}/.test(`${subject}\n${body}`);
}

function targetKey(row: { id?: string; platform?: string | null; handle: string }): string {
  if (row.id) return row.id;
  return `${row.platform ?? ''}:${row.handle.replace(/^@/, '').toLowerCase()}`;
}

function handleKey(row: { platform?: string | null; handle: string }): string {
  return `${row.platform ?? ''}:${row.handle.replace(/^@/, '').toLowerCase()}`;
}

function materialFor(row: SendTarget) {
  const fromVideos = row.videos?.filter((video) => video.caption || video.video_url) ?? [];
  const captions = row.captions?.filter(Boolean) ?? [];
  const videos = fromVideos.length
    ? fromVideos
    : (captions.length ? captions : row.topic ? [row.topic] : []).map((caption) => ({ caption }));
  return {
    handle: row.handle,
    bio: row.bio,
    niches: row.niches,
    videos,
    foundAt: row.foundAt,
  };
}

function fallbackFor(row: SendTarget): HookState {
  const fallback = fallbackVideoHook(materialFor(row));
  return {
    text: fallback.text,
    source: fallback.source,
    basis: '',
    edited: false,
    provenance: fallback.provenance,
  };
}

function stateFromResult(row: {
  text: string;
  source: VideoHookSource;
  basis: string;
  edited?: boolean;
  provenance?: VideoHookProvenance | null;
}): HookState {
  return {
    text: row.text,
    source: row.source,
    basis: row.basis,
    edited: row.edited === true,
    provenance: row.provenance ?? emptyVideoHookProvenance(),
  };
}

function PersonalisedMark() {
  return (
    <span
      className="inline-flex items-center rounded-full border border-line px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint"
      title="Filled from a recent video already saved on this creator."
    >
      Personalised
    </span>
  );
}

export function SendDrawer({
  open,
  targets,
  appName,
  valueProp,
  storeUrl,
  appId,
  initialTemplateId,
  initialSubject,
  initialBody,
  prepare,
  preset = false,
  onClose,
  onFinished,
}: {
  open: boolean;
  targets: SendTarget[];
  appName: string;
  valueProp?: string;
  storeUrl?: string | null;
  appId?: string | null;
  initialTemplateId?: string | null;
  initialSubject?: string;
  initialBody?: string;
  prepare?: (rows: SendTarget[]) => Promise<SendTarget[]>;
  /** Unsent batch: pick a saved template, review the list, then send. */
  preset?: boolean;
  onClose: () => void;
  onFinished?: () => void;
}) {
  const { confirm, toast } = useFeedback();
  const [picked, setPicked] = useState<string | null>(null);
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [hooks, setHooks] = useState<Record<string, HookState>>({});
  const [hookBusy, setHookBusy] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [preparedRows, setPreparedRows] = useState<SendTarget[] | null>(null);
  const hooksRef = useRef(hooks);
  const regenerating = useRef(false);
  hooksRef.current = hooks;

  const eligible = useMemo(
    () => (preparedRows ?? targets).filter((row) => row.email && row.doNotContact !== true),
    [preparedRows, targets],
  );
  const wantsHook = usesVideoHook(subject, body);
  const hookIds = eligible
    .map((row) => row.id)
    .filter((id): id is string => Boolean(id))
    .join('|');
  const previewTarget =
    eligible.find((row) => targetKey(row) === activeKey) ?? eligible[0] ?? targets[0];

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProgress(null);
    setSending(false);
    setHooks({});
    setActiveKey(null);
    setPreparedRows(null);
    if (preset) {
      setPicked(null);
      setSubject('');
      setBody('');
      return () => {
        cancelled = true;
      };
    }
    const savedSubject = initialSubject?.trim() || '';
    const savedBody = initialBody?.trim() || '';
    if (savedSubject || savedBody) {
      setPicked(initialTemplateId || null);
      setSubject(savedSubject || DEFAULT_SUBJECT);
      setBody(savedBody);
      return () => {
        cancelled = true;
      };
    }
    fetchEmailTemplates(appId)
      .then(async (rows) => {
        if (cancelled) return;
        const cold = rows.find((row) => row.name === 'Default cold email') || rows[0];
        if (cold) {
          setPicked(cold.id);
          setSubject(cold.subject);
          setBody(cold.body);
          return;
        }
        const loaded = await fetchEmailTemplate();
        if (cancelled) return;
        setPicked(null);
        setSubject(DEFAULT_SUBJECT);
        setBody(loaded.template);
      })
      .catch(() => {
        if (cancelled) return;
        setPicked(null);
        setSubject(DEFAULT_SUBJECT);
        setBody('');
      });
    return () => {
      cancelled = true;
    };
    // Load once each time the drawer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset]);

  useEffect(() => {
    if (!open || !wantsHook || !hookIds) {
      setHookBusy(false);
      return;
    }
    let cancelled = false;
    setHookBusy(true);
    const ids = hookIds.split('|');
    ensureVideoHooks(ids)
      .then((rows) => {
        if (cancelled) return;
        setHooks((current) => {
          const next = { ...current };
          for (const row of rows) {
            if (next[row.id]?.edited) continue;
            next[row.id] = stateFromResult(row);
          }
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) {
          toast('info', 'Could not write video lines, so these use a neutral opening.');
        }
      })
      .finally(() => {
        if (!cancelled) setHookBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, wantsHook, hookIds, toast]);

  const hookFor = (row: SendTarget | undefined): HookState => {
    if (!row) return fallbackFor({ handle: '', email: null });
    const saved = hooks[targetKey(row)];
    if (saved?.text) return saved;
    return fallbackFor(row);
  };

  const contextFor = (row: SendTarget, videoHook: string) => ({
    handle: row.handle,
    creatorName: row.displayName?.trim() || row.handle,
    displayName: row.displayName?.trim() || '',
    bio: row.bio,
    appName,
    valueProp,
    platform: row.platform,
    hook: row.hook,
    recentVideoTopic: row.topic,
    videoHook,
    storeUrl,
  });

  const updateHook = (row: SendTarget, text: string) => {
    const key = targetKey(row);
    setHooks((current) => {
      const prev = current[key] ?? fallbackFor(row);
      return { ...current, [key]: { ...prev, text, edited: true } };
    });
  };

  const persistHook = async (row: SendTarget) => {
    if (regenerating.current || !row.id) return;
    const saved = hooksRef.current[row.id];
    if (!saved?.edited || !saved.text.trim()) return;
    try {
      await saveCreatorVideoHook(row.id, saved.text.trim(), saved.source);
    } catch (err) {
      toast('info', err instanceof Error ? err.message : 'Could not save that opening line.');
    }
  };

  const regenerate = async (row: SendTarget) => {
    if (!row.id) {
      toast('info', 'Save this creator before rewriting the opening line.');
      return;
    }
    regenerating.current = true;
    setHookBusy(true);
    try {
      const [fresh] = await ensureVideoHooks([row.id], row.id);
      if (!fresh) {
        toast('error', 'Could not rewrite that opening line.');
        return;
      }
      setHooks((current) => ({
        ...current,
        [row.id!]: stateFromResult(fresh),
      }));
      toast(
        fresh.source === 'video' ? 'success' : 'info',
        fresh.source === 'video'
          ? 'Opening line rewritten from a recent video.'
          : 'No video detail to go on, so this is a neutral line.',
      );
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not rewrite that opening line.');
    } finally {
      regenerating.current = false;
      setHookBusy(false);
    }
  };

  const onSend = async () => {
    if (eligible.length === 0) {
      toast('error', 'No one with an email is left to contact.');
      return;
    }
    if (preset && !picked) {
      toast('info', 'Choose a template before sending.');
      return;
    }

    setSending(true);
    let sent = 0;
    let failed = 0;
    const skips: string[] = [];
    try {
      let rows = eligible;
      if (prepare) rows = await prepare(eligible);
      const queue = rows.filter((row) => row.email && row.doNotContact !== true);
      const blocked = rows.length - queue.length;
      if (blocked > 0) skips.push(`${blocked} skipped (do not contact or no email)`);
      let current = { ...hooksRef.current };
      if (wantsHook) {
        for (const row of queue) {
          if (!row.id) continue;
          const prior = current[handleKey(row)];
          if (prior && !current[row.id]) current = { ...current, [row.id]: prior };
        }
        const seen = new Map(
          queue.map((row) => [
            row.id,
            current[row.id ?? '']?.text || current[handleKey(row)]?.text || fallbackFor(row).text,
          ]),
        );
        const need = queue
          .map((row) => row.id)
          .filter((id): id is string => Boolean(id && !current[id]?.edited));
        let reviewAgain = false;
        if (need.length > 0) {
          try {
            const filled = await ensureVideoHooks(need);
            for (const row of filled) {
              if (current[row.id]?.edited) continue;
              const next = stateFromResult(row);
              if (seen.get(row.id) !== row.text) reviewAgain = true;
              const match = queue.find((item) => item.id === row.id);
              current = {
                ...current,
                [row.id]: next,
                ...(match ? { [handleKey(match)]: next } : {}),
              };
            }
          } catch (err) {
            toast(
              'info',
              err instanceof Error
                ? err.message
                : 'Could not write video lines, so these use a neutral opening.',
            );
          }
        }
        if (reviewAgain) {
          setHooks(current);
          setPreparedRows(queue);
          toast('info', 'Opening lines are ready. Check them, then send.');
          return;
        }
        for (const row of queue) {
          if (!row.id) continue;
          const saved = current[row.id];
          if (!saved?.edited || !saved.text.trim()) continue;
          try {
            await saveCreatorVideoHook(row.id, saved.text.trim(), saved.source);
          } catch {
            /* The rendered email still uses the edited line. */
          }
        }
        setHooks(current);
      }
      if (!readQuickMode() && !preset) {
        setSending(false);
        const ok = await confirm({
          title: queue.length === 1 ? 'Send email' : 'Email all',
          body: `Send to ${queue.length} recipient${queue.length === 1 ? '' : 's'}?`,
          confirmLabel: 'Send',
        });
        if (!ok) return;
        setSending(true);
      }
      if (preset) {
        toast(
          'info',
          `Sending to ${queue.length} creator${queue.length === 1 ? '' : 's'}…`,
        );
      }
      for (let i = 0; i < queue.length; i++) {
        const row = queue[i]!;
        setProgress(`Sending ${i + 1} of ${queue.length}`);
        if (!row.id) {
          failed += 1;
          skips.push(`@${row.handle}: could not save this creator`);
          continue;
        }
        const line = current[row.id] ?? current[handleKey(row)] ?? fallbackFor(row);
        const context = contextFor(row, line.text);
        try {
          const result = await approveCreator(row.id, {
            subject: renderTemplate(subject, context),
            body: renderTemplate(body, context),
            templateId: picked,
          });
          if (result.ok) {
            sent += 1;
          } else {
            failed += 1;
            const reason = skipReasonLabel(
              typeof result.error === 'string' ? result.error : '',
            );
            skips.push(`@${row.handle}: ${reason}`);
          }
        } catch (err) {
          failed += 1;
          skips.push(
            `@${row.handle}: ${err instanceof Error ? err.message : 'Send failed'}`,
          );
        }
      }
      const summary = [`Sent ${sent}`];
      if (failed > 0) summary.push(`${failed} not sent`);
      if (skips.length > 0) summary.push(skips.slice(0, 3).join('. '));
      toast(sent > 0 && failed === 0 ? 'success' : sent > 0 ? 'info' : 'error', summary.join('. ') + '.');
      onFinished?.();
      onClose();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
      setProgress(null);
    }
  };

  const skipped = targets.length - eligible.length;
  const needsPreset = preset && !picked;

  return (
    <Drawer
      open={open}
      title={preset ? 'Email all with preset' : eligible.length > 1 ? 'Email all' : 'Send email'}
      subtitle={
        preset
          ? 'Choose a template, check the list, then send. People without an email are left out.'
          : skipped > 0
            ? `${eligible.length} will be emailed. ${skipped} skipped (no email or do not contact).`
            : `${eligible.length} recipient${eligible.length === 1 ? '' : 's'}`
      }
      wide
      onClose={sending ? () => undefined : onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-ink-faint">{progress}</p>
          <button
            type="button"
            className="btn-primary"
            disabled={sending || hookBusy || eligible.length === 0 || !body.trim() || needsPreset}
            onClick={() => void onSend()}
          >
            {sending ? 'Sending…' : hookBusy ? 'Writing lines…' : preset ? `Send to ${eligible.length}` : 'Send'}
          </button>
        </div>
      }
    >
      <div className="space-y-4 pb-2">
        {preset && (
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <p className="label">Recipients</p>
            <p className="text-sm text-ink">
              {eligible.length} creator{eligible.length === 1 ? '' : 's'} with an email
            </p>
            <ul className="mt-2 space-y-1">
              {eligible.map((row) => (
                <li key={row.id ?? row.email ?? row.handle} className="truncate text-sm text-ink-muted">
                  @{row.handle.replace(/^@/, '')}
                  {row.email ? ` · ${row.email}` : ''}
                </li>
              ))}
            </ul>
            {skipped > 0 && (
              <p className="mt-2 text-xs text-ink-faint">
                {skipped} left out (no email or do not contact).
              </p>
            )}
          </div>
        )}
        <TemplateFields
          appId={appId}
          templateId={picked}
          subject={subject}
          body={body}
          appName={appName}
          showPreview={false}
          dense
          onChange={(next) => {
            setPicked(next.templateId);
            setSubject(next.subject);
            setBody(next.body);
          }}
        />
        {preset && !picked && (
          <p className="text-sm text-ink-faint">
            Choose a template before sending.{' '}
            <Link to="/templates" className="text-accent hover:text-accent-hover">
              Open Templates
            </Link>
          </p>
        )}
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="kicker">Preview</p>
            {wantsHook && <PersonalisedMark />}
          </div>
          {wantsHook && hookBusy && (
            <p className="mt-2 text-xs text-ink-faint">Writing opening lines…</p>
          )}
          <ul className="mt-3 space-y-4">
            {(eligible.length > 0 ? eligible : previewTarget ? [previewTarget] : []).map((row) => {
              const line = hookFor(row);
              const rendered = contextFor(row, line.text);
              return (
                <li key={targetKey(row)} className="space-y-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm text-ink">@{row.handle.replace(/^@/, '')}</p>
                    {wantsHook && line.source === 'video' && <PersonalisedMark />}
                  </div>
                  {wantsHook && (
                    <OpeningLine
                      value={line.text}
                      provenance={line.provenance}
                      edited={line.edited}
                      busy={hookBusy || sending}
                      onChange={(text) => updateHook(row, text)}
                      onBlur={() => void persistHook(row)}
                      onRegenerate={() => void regenerate(row)}
                    />
                  )}
                  <p className="text-sm text-ink">{renderTemplate(subject, rendered)}</p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                    {renderTemplate(body, rendered) || 'Nothing to preview yet.'}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Drawer>
  );
}

function OpeningLine({
  value,
  provenance,
  edited,
  busy,
  onChange,
  onBlur,
  onRegenerate,
}: {
  value: string;
  provenance: VideoHookProvenance;
  edited: boolean;
  busy: boolean;
  onChange: (text: string) => void;
  onBlur: () => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="mt-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="label mb-0">Opening line</span>
        <button
          type="button"
          className="text-xs text-ink-faint hover:text-ink disabled:opacity-40"
          disabled={busy}
          onClick={onRegenerate}
        >
          Regenerate
        </button>
      </div>
      <textarea
        className="input min-h-[64px] text-sm leading-6"
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      <HookSourceDisclosure provenance={provenance} edited={edited} />
    </div>
  );
}
