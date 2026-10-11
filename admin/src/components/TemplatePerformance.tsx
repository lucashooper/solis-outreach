import { useEffect, useState } from 'react';
import { InfoTip } from './InfoTip';
import {
  fetchTemplatePerformance,
  type TemplatePerformanceRow,
  type TemplateRange,
} from '../lib/supabase';

const RANGES: Array<{ id: TemplateRange; label: string }> = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'All' },
];

function rateText(rate: number): string {
  const rounded = Math.round(rate * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export function TemplatePerformanceCard({ appId }: { appId: string | null }) {
  const [range, setRange] = useState<TemplateRange>('30d');
  const [rows, setRows] = useState<TemplatePerformanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!appId) {
      setRows([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setRows(null);
    fetchTemplatePerformance(appId, range)
      .then((next) => {
        if (cancelled) return;
        setRows(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        setError(err instanceof Error ? err.message : 'Could not load template performance');
      });
    return () => {
      cancelled = true;
    };
  }, [appId, range]);

  return (
    <section className="section">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">Template performance</h2>
        <div className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="Time range">
          {RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                range === item.id
                  ? 'rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-ink'
                  : 'rounded-md px-2 py-0.5 text-xs text-ink-faint hover:text-ink-muted'
              }
              aria-pressed={range === item.id}
              onClick={() => setRange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {!error && rows == null && <p className="mt-3 text-sm text-ink-faint">Loading…</p>}
      {!error && rows != null && rows.length === 0 && (
        <p className="mt-3 text-sm text-ink-faint">No sends in this range.</p>
      )}
      {rows != null && rows.length > 0 && (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => (
            <li key={row.id} className={row.lowSample ? 'text-ink-faint' : ''}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm text-ink">
                  <span className={`truncate ${row.lowSample ? 'text-ink-faint' : ''}`}>{row.name}</span>
                  {row.lowSample && (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-ink-faint">
                      low sample
                      <InfoTip label="Low sample" text="Fewer than 10 sends, so this rate is listed after the others." />
                    </span>
                  )}
                </p>
                <p className="shrink-0 text-xs tabular-nums text-ink-faint">
                  {row.sent} sent · {row.replies} {row.replies === 1 ? 'reply' : 'replies'} · {rateText(row.replyRate)}
                </p>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
                <div
                  className={`h-full rounded-full ${row.lowSample ? 'bg-white/25' : 'bg-accent'}`}
                  style={{ width: `${Math.max(0, Math.min(100, row.replyRate))}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
