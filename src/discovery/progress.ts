import type { DiscoveryFunnel } from './types.js';

export type DiscoveryPhase = 'network' | 'hashtags' | 'scoring' | 'bio_links' | 'saving' | 'done';

export interface DiscoveryStage {
  phase: DiscoveryPhase;
  label: string;
  checked: number;
  found: number;
  /** Hashtags in the call that is running, without a leading hash stored either way. */
  tags?: string[];
}

export function networkStageLabel(input: {
  seeds: number;
  checked: number;
  found: number;
}): string {
  const seeds = input.seeds === 1 ? '1 creator' : `${input.seeds} creators`;
  const profiles = Math.max(0, Math.round(input.checked) || 0).toLocaleString('en-GB');
  const found = Math.max(0, Math.round(input.found) || 0);
  const foundLabel = found === 1 ? '1 found' : `${found.toLocaleString('en-GB')} found`;
  return `Reading following lists of ${seeds} · ${profiles} profiles checked · ${foundLabel}`;
}

export function scoringStageLabel(): string {
  return 'Scoring niche fit with AI…';
}

export function bioLinkStageLabel(): string {
  return 'Checking bio links for emails…';
}

export function savingStageLabel(found: number): string {
  const count = Math.max(0, Math.round(found) || 0);
  const noun = count === 1 ? 'creator' : 'creators';
  return `Saving ${count.toLocaleString('en-GB')} new ${noun}`;
}

export function hashtagStageLabel(tags: readonly string[]): string {
  const shown = tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`));
  if (shown.length === 0) return 'Scanning hashtags…';
  const extra = tags.length > shown.length ? ` +${tags.length - shown.length}` : '';
  return `Scanning ${shown.join(', ')}${extra}…`;
}

export function asDiscoveryStage(value: unknown): DiscoveryStage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const phase = row.phase;
  if (
    phase !== 'network' &&
    phase !== 'hashtags' &&
    phase !== 'scoring' &&
    phase !== 'bio_links' &&
    phase !== 'saving' &&
    phase !== 'done'
  ) {
    return undefined;
  }
  const checked = Number(row.checked);
  const found = Number(row.found);
  const label = typeof row.label === 'string' ? row.label.trim() : '';
  if (!label) return undefined;
  const tags = Array.isArray(row.tags)
    ? row.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    phase,
    label,
    checked: Number.isFinite(checked) && checked >= 0 ? Math.round(checked) : 0,
    found: Number.isFinite(found) && found >= 0 ? Math.round(found) : 0,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export function stageFromFunnel(funnel: DiscoveryFunnel | null | undefined): DiscoveryStage | null {
  return funnel?.stage ?? null;
}
