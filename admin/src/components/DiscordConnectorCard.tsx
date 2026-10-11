import { useEffect, useState } from 'react';
import { DiscordMark } from './BrandMark';
import { useFeedback } from './feedback';
import { expressApiUrl } from '../lib/settings';
import {
  fetchDiscordIntegration,
  saveDiscordIntegration,
  testDiscordIntegration,
  type DiscordIntegration,
} from '../lib/supabase';

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? 'toggle-on' : 'toggle-off'}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" style={{ left: checked ? '1.25rem' : '0.125rem' }} />
    </button>
  );
}

export function DiscordConnectorCard() {
  const api = expressApiUrl();
  const { toast } = useFeedback();
  const [status, setStatus] = useState<DiscordIntegration | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [replies, setReplies] = useState(true);
  const [creators, setCreators] = useState(true);
  const [sent, setSent] = useState(true);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    fetchDiscordIntegration()
      .then((body) => {
        if (cancelled) return;
        setStatus(body);
        setReplies(body.notifyReplies);
        setCreators(body.notifyCreators);
        setSent(body.notifySent);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read Discord');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const next = await saveDiscordIntegration({
        webhookUrl,
        notifyReplies: replies,
        notifyCreators: creators,
        notifySent: sent,
      });
      setStatus(next);
      setWebhookUrl('');
      toast('success', 'Discord settings saved.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save Discord';
      setError(message);
      toast('error', message);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setError(null);
    try {
      await testDiscordIntegration(webhookUrl);
      toast('success', 'Test sent. Check the Discord channel.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Discord test failed';
      setError(message);
      toast('error', message);
    } finally {
      setBusy(null);
    }
  };

  const source = status?.usingEnv
    ? 'Using the server webhook until you save a new one.'
    : status?.configured
      ? 'Saved for this workspace.'
      : 'Paste a webhook to start alerts.';

  return (
    <article className="rounded-2xl border border-line bg-surface-raised p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04]">
            <DiscordMark />
          </span>
          <div>
            <h2 className="text-sm font-medium text-ink">Discord</h2>
            <p className="mt-0.5 text-sm text-ink-muted">{source}</p>
          </div>
        </div>
        {status?.configured && (
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
            Connected
          </span>
        )}
      </div>

      {!api && <p className="mt-4 text-sm text-ink-faint">Discord settings need the outreach API.</p>}

      {api && (
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="label">Webhook URL</span>
            <input
              className="input font-mono text-xs"
              type="password"
              autoComplete="off"
              placeholder={status?.maskedUrl || 'Paste a Discord webhook URL'}
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
            />
          </label>

          <ul className="space-y-3">
            <li className="flex items-center justify-between gap-3">
              <span className="text-sm text-ink">Replies</span>
              <Toggle checked={replies} label="Replies" onChange={setReplies} />
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-sm text-ink">Creators found</span>
              <Toggle checked={creators} label="Creators found" onChange={setCreators} />
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-sm text-ink">Emails sent</span>
              <Toggle checked={sent} label="Emails sent" onChange={setSent} />
            </li>
          </ul>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy != null} onClick={() => void save()}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy != null || (!webhookUrl.trim() && !status?.configured)}
              onClick={() => void test()}
            >
              {busy === 'test' ? 'Sending…' : 'Send test'}
            </button>
          </div>
          {error && <p className="text-sm text-red-300">{error}</p>}
        </div>
      )}
    </article>
  );
}
