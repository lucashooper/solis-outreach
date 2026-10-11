import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ThreadItem } from '../../../src/outreach/thread.ts';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= 180) return flat;
  return `${flat.slice(0, 179).trimEnd()}…`;
}

function tone(item: ThreadItem): string {
  if (item.direction === 'received') return 'border-l-emerald-400/80';
  if (item.direction === 'note') return 'border-l-amber-300/70';
  return 'border-l-accent/80';
}

function labelTone(item: ThreadItem): string {
  if (item.direction === 'received') return 'text-emerald-300';
  if (item.direction === 'note') return 'text-amber-200';
  return 'text-ink-faint';
}

function defaultOpen(items: ThreadItem[]): Set<string> {
  if (items.length <= 3) return new Set(items.map((item) => item.id));
  const latest = items[items.length - 1];
  return new Set(latest ? [latest.id] : []);
}

export function OutreachThread({ items }: { items: ThreadItem[] }) {
  const signature = items.map((item) => item.id).join('|');
  const [openIds, setOpenIds] = useState<Set<string>>(() => defaultOpen(items));
  const [tracked, setTracked] = useState(signature);
  if (signature !== tracked) {
    setTracked(signature);
    setOpenIds(defaultOpen(items));
  }

  if (items.length === 0) {
    return <p className="text-sm text-slate-500">No messages with this creator yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {items.map((item) => {
        const expandable = item.direction !== 'note' && Boolean(item.body.trim());
        const open = !expandable || openIds.has(item.id);
        const snippet = preview(item.body);
        const header = (
          <>
            <span className="min-w-0">
              <span className={`block text-[11px] font-medium uppercase tracking-[0.14em] ${labelTone(item)}`}>
                {item.label}
              </span>
              {item.meta && <span className="mt-1 block text-xs text-ink-faint">{item.meta}</span>}
              {item.subject && (
                <span className="mt-2 block truncate text-sm font-medium text-ink">{item.subject}</span>
              )}
              {!open && snippet && (
                <span className="mt-1 block line-clamp-2 text-sm text-slate-400">{snippet}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <time className="text-xs text-ink-faint" dateTime={item.at ?? undefined}>
                {formatDate(item.at)}
              </time>
              {expandable && (
                <ChevronDown
                  className={`h-4 w-4 text-ink-faint transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                />
              )}
            </span>
          </>
        );
        return (
          <li
            key={item.id}
            className={`rounded-xl border border-line border-l-2 bg-white/[0.02] ${tone(item)}`}
          >
            {expandable ? (
              <button
                type="button"
                className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
                aria-expanded={open}
                title={item.tooltip ?? undefined}
                onClick={() =>
                  setOpenIds((current) => {
                    const next = new Set(current);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })
                }
              >
                {header}
              </button>
            ) : (
              <div className="flex items-start justify-between gap-3 px-4 py-3" title={item.tooltip ?? undefined}>
                {header}
              </div>
            )}
            {open && item.body && (
              <p className="max-h-96 overflow-y-auto whitespace-pre-wrap px-4 pb-4 text-sm leading-6 text-slate-300">
                {item.body}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
