import { Loader2 } from 'lucide-react';

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
}

export function SearchProgressPanel({
  stage,
  found,
  target,
  checked,
  elapsedSeconds,
  stopping = false,
  onStop,
}: {
  stage: string;
  found: number;
  target: number;
  checked: number;
  elapsedSeconds: number;
  stopping?: boolean;
  onStop: () => void;
}) {
  const goal = Math.max(1, target);
  const known = found > 0;
  const pct = Math.max(4, Math.min(100, Math.round((found / goal) * 100)));
  const foundLabel = found === 1 ? '1 found' : `${found.toLocaleString('en-GB')} found`;
  const checkedLabel =
    checked === 1 ? '1 checked' : `${checked.toLocaleString('en-GB')} checked`;
  return (
    <section
      className="rounded-2xl border border-line bg-surface-raised px-4 py-4"
      role="status"
      aria-live="polite"
      aria-label="Search progress"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="relative mt-1.5 flex h-2 w-2 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <div className="min-w-0">
            <p className="shimmer-text text-sm font-medium">{stage}</p>
            <p className="mt-1 text-xs tabular-nums text-ink-faint">
              {foundLabel} of {goal.toLocaleString('en-GB')} · {checkedLabel} · {formatElapsed(elapsedSeconds)}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0"
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
        {known ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="progress-indeterminate h-full rounded-full bg-accent" />
        )}
      </div>
    </section>
  );
}
