import { ChevronDown } from 'lucide-react';
import { readVideoHookProvenance } from '../../../src/templates/videoHook.ts';
import { STATUS_LABELS, type OutreachStatus } from '../lib/types';
import { HookSourceDisclosure } from './HookSourceDisclosure';

const LABELS: Record<string, string> = {
  hook: 'Hook',
  niches: 'Niches',
  status_before_reply: 'Status before reply',
  last_outreach_error: 'Last outreach error',
  video_hook: 'Video hook',
  video_hook_source: 'Video hook source',
  video_hook_edited: 'Video hook edited',
};

const HIDDEN = new Set(['video_hook_basis', 'video_hook_version', 'video_hook_provenance']);

function humanise(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(key: string, raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (key === 'status_before_reply' && text in STATUS_LABELS) {
      return STATUS_LABELS[text as OutreachStatus];
    }
    if (key === 'video_hook_source') {
      if (text === 'video') return 'Video';
      if (text === 'bio') return 'Bio';
      if (text === 'generic') return 'Neutral';
    }
    return text;
  }
  if (key === 'video_hook_edited' && typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    return raw
      .map((item) => formatValue(key, item))
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

export function describeAiVariables(
  vars: Record<string, unknown>,
): Array<{ key: string; label: string; value: string }> {
  return Object.entries(vars).flatMap(([key, raw]) => {
    if (HIDDEN.has(key)) return [];
    const value = formatValue(key, raw);
    if (!value) return [];
    return [{ key, label: LABELS[key] ?? humanise(key), value }];
  });
}

function isPresent(value: unknown): boolean {
  if (value == null || value === '') return false;
  if (Array.isArray(value)) return value.some((item) => isPresent(item));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(isPresent);
  return true;
}

export function AiVariablesDisclosure({
  vars,
}: {
  vars: Record<string, unknown> | null | undefined;
}) {
  const entries = Object.entries(vars ?? {}).filter(
    ([key, value]) => !HIDDEN.has(key) && isPresent(value),
  );
  const provenance = readVideoHookProvenance(vars?.video_hook_provenance);
  const edited = vars?.video_hook_edited === true;
  if (entries.length === 0 && !provenance) return null;
  const rows = describeAiVariables(vars ?? {});
  const countLabel = entries.length === 1 ? '1 field' : `${entries.length} fields`;

  return (
    <details className="group border-t border-line pt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm text-ink-muted [&::-webkit-details-marker]:hidden">
        <span>
          AI variables
          <span className="ml-2 text-xs text-ink-faint">{countLabel}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-faint transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="mt-3 space-y-3">
        {rows.length > 0 && (
          <dl className="grid gap-3 sm:grid-cols-2">
            {rows.map((row) => (
              <div
                key={row.key}
                className={row.key === 'hook' || row.key === 'video_hook' ? 'sm:col-span-2' : undefined}
              >
                <dt className="label">{row.label}</dt>
                <dd className="whitespace-pre-wrap text-sm text-slate-300">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {(provenance || edited) && (
          <HookSourceDisclosure provenance={provenance} edited={edited} />
        )}
        <details className="rounded-lg border border-line bg-surface">
          <summary className="cursor-pointer px-3 py-2 text-xs text-ink-faint">Raw JSON</summary>
          <pre className="overflow-x-auto border-t border-line px-3 py-2 text-xs text-slate-400">
            {JSON.stringify(vars, null, 2)}
          </pre>
        </details>
      </div>
    </details>
  );
}
