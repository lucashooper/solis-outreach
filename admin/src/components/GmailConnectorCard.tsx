import { useEffect, useState } from 'react';
import { GmailMark } from './BrandMark';
import { expressApiUrl } from '../lib/settings';
import { fetchGmailConnection, type GmailConnection } from '../lib/supabase';

function when(value: string | null): string {
  if (!value) return '';
  return new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London' });
}

export function GmailConnectorCard() {
  const api = expressApiUrl();
  const [status, setStatus] = useState<GmailConnection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    fetchGmailConnection()
      .then((body) => {
        if (!cancelled) setStatus(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read Gmail status');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const missingClient =
    status?.missing.includes('GMAIL_CLIENT_ID') ||
    status?.missing.includes('GMAIL_CLIENT_SECRET');
  const synced = when(status?.lastSynced ?? null);

  return (
    <article className="rounded-2xl border border-line bg-surface-raised p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04]">
            <GmailMark />
          </span>
          <div>
            <h2 className="text-sm font-medium text-ink">Gmail</h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              {status?.email || 'studioowner@gmail.com'}
            </p>
          </div>
        </div>
        {status?.configured && (
          <span
            className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
            title={synced ? `Last synced ${synced}` : 'Not synced yet'}
          >
            Connected
          </span>
        )}
      </div>
      <div className="mt-4">
        {!api && (
          <p className="text-sm text-ink-faint">Connect Gmail needs the outreach API.</p>
        )}
        {api && missingClient && (
          <p className="mb-3 text-sm text-ink-faint">
            Add the Gmail client ID and secret under Settings → API keys, then connect.
          </p>
        )}
        {api && (
          <a
            className="btn-primary inline-flex"
            href={`${api}/api/gmail/oauth/start?return=${encodeURIComponent(window.location.origin)}`}
          >
            {status?.configured ? 'Reconnect Gmail' : 'Connect Gmail'}
          </a>
        )}
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      </div>
    </article>
  );
}
