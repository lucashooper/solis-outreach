import {
  presentHashtagYield,
  type HashtagYield,
  type YieldPill,
} from '../../../src/discovery/hashtagYield.ts';
import { InfoTip } from './InfoTip';

const TONE: Record<YieldPill['tone'], string> = {
  low: 'rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-100',
  thin: 'rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-muted',
  strong:
    'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-100',
  neutral: 'rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-faint',
};

export function HashtagYieldNote({
  rows,
  pills,
  requireEmail = true,
  fallbackTags = [],
  fallbackSource,
  onSaveStrong,
  savingPack = false,
}: {
  rows?: HashtagYield[];
  pills?: YieldPill[];
  requireEmail?: boolean;
  fallbackTags?: string[];
  fallbackSource?: 'ai' | 'niche';
  onSaveStrong?: (tags: string[]) => void;
  savingPack?: boolean;
}) {
  const shown =
    pills ??
    presentHashtagYield({
      measured: rows ?? [],
      running: false,
      requireEmail,
    });
  const strongTags = (rows ?? []).filter((row) => row.flag === 'strong').map((row) => row.tag);
  if (shown.length === 0 && fallbackTags.length === 0) return null;
  const added = fallbackTags.length === 0 ? null : fallbackTags.join(' ');
  const addedHint =
    fallbackSource === 'niche'
      ? 'AI was unavailable, so these came from the niche. A dry round tries the next tier.'
      : 'A dry round tries the next tier.';
  return (
    <div className="space-y-2">
      {added && (
        <p className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          Added {added}
          <InfoTip label="Added tags" text={addedHint} />
        </p>
      )}
      {shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
            Hashtag yield
            <InfoTip label="Hashtag yield" text="Strong tags found more creators. Low yield tags are thin." />
          </span>
          {shown.map((pill) => (
            <span key={`${pill.tag}-${pill.suffix}`} title={pill.hint} className={TONE[pill.tone]}>
              {pill.tag}
              {pill.suffix ? ` · ${pill.suffix}` : ''}
            </span>
          ))}
          {onSaveStrong && strongTags.length > 0 && (
            <button
              type="button"
              className="btn-ghost !px-2 !py-1 text-xs"
              disabled={savingPack}
              onClick={() => onSaveStrong(strongTags)}
            >
              {savingPack ? 'Saving…' : 'Save strong tags as pack'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
