import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import type { HashtagYield, HashtagYieldFlag } from '../../../src/discovery/hashtagYield.ts';
import { expansionRoundLabel } from '../../../src/discovery/expansionTiers.ts';
import { parseCustomHashtags } from '../../../src/discovery/expansionTiers.ts';
import {
  shortfallChips,
  shortfallHeadline,
  type DiscoveryShortfall,
} from '../../../src/discovery/shortfall.ts';

const RELAX_NOTE =
  'Adds creators from this batch who have no public email. Require public email stays on for the next search. No new Apify run.';
const ACCEPT_NOTE = 'Keeps this batch. Nothing else is searched and no email is sent.';
const EXPAND_NOTE =
  'Searches the tags below. At most two tags and 30 videos each, and up to three rounds if a round finds nobody new. Nothing is emailed.';

function yieldWord(flag: HashtagYieldFlag | null): string | null {
  if (flag === 'strong') return 'Strong';
  if (flag === 'low') return 'Low yield';
  if (flag === 'thin') return 'Thin';
  if (flag === 'insufficient') return 'Not enough data';
  return null;
}

function CountNote({
  why,
  passNote,
  relaxNote,
}: {
  why: string;
  passNote: string;
  relaxNote?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        className="icon-btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="How this count was reached"
        onClick={() => setOpen((value) => !value)}
      >
        <Info className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      {open && (
        <div
          id={panelId}
          role="note"
          className="absolute right-0 z-20 mt-1 w-80 max-w-[min(20rem,calc(100vw-3rem))] rounded-xl border border-line bg-surface-overlay p-3 text-left text-xs leading-relaxed text-ink-muted shadow-raised"
        >
          <p>{why}</p>
          {passNote ? <p className="mt-2 text-ink-faint">{passNote}</p> : null}
          {relaxNote ? <p className="mt-2 text-ink-faint">{relaxNote}</p> : null}
        </div>
      )}
    </div>
  );
}

export type ExpansionBusy = 'expand' | 'relax' | 'accept' | 'custom' | 'network' | null;

export function ExpansionOptions({
  sheet,
  busy = null,
  progress = null,
  showCampaignHashtags = false,
  onExpand,
  onRelaxEmail,
  onCustom,
}: {
  sheet: DiscoveryShortfall;
  busy?: ExpansionBusy;
  progress?: string | null;
  showCampaignHashtags?: boolean;
  onExpand: (tags: string[]) => void;
  onRelaxEmail: () => void;
  onCustom: (tags: string[], addToCampaign: boolean) => void;
}) {
  const tagKey = sheet.suggestedTags.join('|');
  const [pickedFor, setPickedFor] = useState(tagKey);
  const [picked, setPicked] = useState(sheet.suggestedTags);
  const [customText, setCustomText] = useState('');
  const [addToCampaign, setAddToCampaign] = useState(false);
  if (pickedFor !== tagKey) {
    setPickedFor(tagKey);
    setPicked(sheet.suggestedTags);
  }
  const parsed = parseCustomHashtags(customText);
  const customReady = customText.trim().length > 0 && parsed.error == null && parsed.tags.length > 0;
  const roundSuffix =
    (busy === 'expand' || busy === 'custom') && sheet.expansionRounds
      ? ` · ${expansionRoundLabel(sheet.expansionRounds)}`
      : '';
  const searching =
    busy === 'expand' && picked.length > 0
      ? `Searching ${picked.join(', ')}…${roundSuffix}`
      : busy === 'custom' && parsed.tags.length > 0
        ? `Searching ${parsed.tags.join(', ')}…${roundSuffix}`
        : busy === 'relax'
          ? 'Including creators from this batch…'
          : '';
  const status = searching || progress || sheet.roundNote;
  const swap = (tag: string) => {
    const next = sheet.alternatives.find((item) => !picked.includes(item));
    if (!next) {
      setPicked((current) => current.filter((item) => item !== tag));
      return;
    }
    setPicked((current) => current.map((item) => (item === tag ? next : item)));
  };
  const remove = (tag: string) => setPicked((current) => current.filter((item) => item !== tag));
  return (
    <div>
      <p className="min-h-[1.25rem] text-xs text-ink-muted" aria-live="polite">
        {status || '\u00a0'}
      </p>
      <div className="mt-2 space-y-2" role="radiogroup" aria-label="Ways to find more creators">
        <div className="rounded-xl border border-accent/40 bg-accent/[0.06] px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Related tags</p>
              <p className="mt-0.5 text-xs text-ink-faint">
                {sheet.networkOnly
                  ? sheet.suggestionNote || 'No related tags are left to search. Search the creator network instead.'
                  : sheet.tiersExhausted
                    ? 'Related tags are used up. Type your own hashtags below.'
                    : `Next tier${sheet.nextTier ? ` ${sheet.nextTier}` : ''}`}
              </p>
            </div>
            {sheet.canExpand && (
              <button
                type="button"
                className="btn-primary shrink-0"
                disabled={busy !== null || picked.length === 0}
                title={EXPAND_NOTE}
                onClick={() => onExpand(picked)}
              >
                {busy === 'expand' ? 'Searching…' : 'Expand search'}
              </button>
            )}
          </div>
          {picked.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Tags the next search will use">
              {picked.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-accent/35 bg-accent/10 px-2 py-0.5 text-[11px] text-ink"
                >
                  <button
                    type="button"
                    title={sheet.alternatives.length > 0 ? 'Swap this tag' : 'Remove this tag'}
                    onClick={() => swap(tag)}
                  >
                    {tag}
                  </button>
                  <button
                    type="button"
                    className="text-ink-faint hover:text-ink"
                    aria-label={`Remove ${tag}`}
                    onClick={() => remove(tag)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Include creators without a public email</p>
              <p className="mt-0.5 text-xs text-ink-faint">
                {sheet.canRelaxEmail
                  ? 'Uses creators already scraped for this batch. No new Apify run.'
                  : 'Nothing further from this batch can be included without another search.'}
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary shrink-0"
              disabled={busy !== null || !sheet.canRelaxEmail}
              title={RELAX_NOTE}
              onClick={onRelaxEmail}
            >
              {busy === 'relax' ? 'Including…' : 'Include'}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-line bg-white/[0.02] px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Custom hashtags</p>
              <p className="mt-0.5 text-xs text-ink-faint">
                Comma-separated. Up to five, searched two at a time. Nothing is emailed.
              </p>
              <input
                className="input mt-2"
                aria-label="Custom hashtags"
                placeholder="#bookreview, currentlyreading"
                value={customText}
                onChange={(event) => setCustomText(event.target.value)}
              />
              {customText.trim() && parsed.error ? (
                <p className="mt-1 text-xs text-amber-200/90">{parsed.error}</p>
              ) : null}
              {showCampaignHashtags && (
                <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    checked={addToCampaign}
                    onChange={(event) => setAddToCampaign(event.target.checked)}
                  />
                  Add to campaign hashtags
                </label>
              )}
            </div>
            <button
              type="button"
              className="btn-secondary shrink-0"
              disabled={busy !== null || !customReady}
              onClick={() => onCustom(parsed.tags, addToCampaign)}
            >
              {busy === 'custom' ? 'Searching…' : 'Search these'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Same choices as the shortfall card, collapsed beside Find creators when the card is hidden. */
export function ExpandSearchDisclosure({
  sheet,
  busy = null,
  progress = null,
  onExpand,
  onRelaxEmail,
  onCustom,
}: {
  sheet: DiscoveryShortfall;
  busy?: ExpansionBusy;
  progress?: string | null;
  onExpand: (tags: string[]) => void;
  onRelaxEmail: () => void;
  onCustom: (tags: string[], addToCampaign: boolean) => void;
}) {
  return (
    <details className="rounded-2xl border border-line bg-surface-raised px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-ink">Expand search</summary>
      <div className="mt-3">
        <ExpansionOptions
          sheet={sheet}
          busy={busy}
          progress={progress}
          showCampaignHashtags
          onExpand={onExpand}
          onRelaxEmail={onRelaxEmail}
          onCustom={onCustom}
        />
      </div>
    </details>
  );
}

export function DiscoveryShortfallSheet({
  sheet,
  yieldRows = [],
  busy = null,
  progress = null,
  showCampaignHashtags = false,
  onExpand,
  onRelaxEmail,
  onCustom,
  onAccept,
  onSaveStrong,
  savingPack = false,
}: {
  sheet: DiscoveryShortfall;
  yieldRows?: HashtagYield[];
  requireEmail?: boolean;
  busy?: ExpansionBusy;
  progress?: string | null;
  showCampaignHashtags?: boolean;
  onExpand: (tags: string[]) => void;
  onRelaxEmail: () => void;
  onCustom?: (tags: string[], addToCampaign: boolean) => void;
  onAccept: () => void;
  onSaveStrong?: (tags: string[]) => void;
  savingPack?: boolean;
}) {
  const headline = shortfallHeadline(sheet);
  const chips = shortfallChips(sheet.triedTags, sheet.expandedTags, yieldRows);
  const strongTags = yieldRows.filter((row) => row.flag === 'strong').map((row) => row.tag);
  return (
    <section
      className="rounded-2xl border border-line bg-surface-raised px-4 py-4"
      aria-labelledby="shortfall-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="shortfall-title" className="text-base font-medium tracking-tight text-ink">
            {headline.title}
          </h2>
          <p className="mt-1 text-xs text-ink-faint">{headline.detail}</p>
        </div>
        <CountNote
          why={sheet.why}
          passNote={sheet.passNote}
          relaxNote={sheet.canRelaxEmail ? RELAX_NOTE : undefined}
        />
      </div>
      {chips.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
          {chips.map((chip) => {
            const yieldLabel = yieldWord(chip.yieldFlag);
            const className = chip.expanded
              ? 'border-accent/35 bg-accent/10 text-ink'
              : chip.yieldFlag === 'low'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
                : chip.yieldFlag === 'strong'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
                  : 'border-line text-ink-muted';
            return (
              <li
                key={chip.tag}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${className}`}
              >
                {chip.tag}
                {chip.expanded ? <span className="text-ink-faint"> · Expanded</span> : null}
                {yieldLabel ? <span> · {yieldLabel}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3">
        <ExpansionOptions
          sheet={sheet}
          busy={busy}
          progress={progress}
          showCampaignHashtags={showCampaignHashtags}
          onExpand={onExpand}
          onRelaxEmail={onRelaxEmail}
          onCustom={onCustom ?? (() => undefined)}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          className="text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
          disabled={busy !== null}
          title={ACCEPT_NOTE}
          onClick={onAccept}
        >
          {busy === 'accept' ? 'Keeping this batch…' : 'Accept batch'}
        </button>
        {onSaveStrong && strongTags.length > 0 && (
          <button
            type="button"
            className="text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
            disabled={busy !== null || savingPack}
            onClick={() => onSaveStrong(strongTags)}
          >
            {savingPack ? 'Saving…' : 'Save strong tags as pack'}
          </button>
        )}
      </div>
    </section>
  );
}
