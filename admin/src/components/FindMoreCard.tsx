import { useState } from 'react';
import { X } from 'lucide-react';
import { parseCustomHashtags } from '../../../src/discovery/expansionTiers.ts';
import type { DiscoveryShortfall } from '../../../src/discovery/shortfall.ts';
import type { ExpansionBusy } from './DiscoveryShortfallSheet';

const RELAX_NOTE =
  'Adds creators from this batch who have no public email. The setting stays on for the next search.';
const ACCEPT_NOTE = 'Keeps this batch. Nothing else is searched and no email is sent.';
const EXPAND_NOTE = 'Searches the tags below. At most two tags, and up to three rounds if a round finds nobody new.';

export function FindMoreCard({
  sheet,
  busy = null,
  progress = null,
  onDismiss,
  onExpand,
  onRelaxEmail,
  onCustom,
  onAccept,
  onNetwork,
}: {
  sheet: DiscoveryShortfall;
  busy?: ExpansionBusy;
  progress?: string | null;
  onDismiss: () => void;
  onExpand: (tags: string[]) => void;
  onRelaxEmail: () => void;
  onCustom: (tags: string[], addToCampaign: boolean) => void;
  onAccept: () => void;
  onNetwork?: () => void;
}) {
  const visibleTags = sheet.suggestedTags.slice(0, 3);
  const tagKey = visibleTags.join('|');
  const [pickedFor, setPickedFor] = useState(tagKey);
  const [picked, setPicked] = useState(visibleTags);
  const [more, setMore] = useState(false);
  const [customText, setCustomText] = useState('');
  if (pickedFor !== tagKey) {
    setPickedFor(tagKey);
    setPicked(visibleTags);
  }
  const parsed = parseCustomHashtags(customText);
  const customReady = customText.trim().length > 0 && parsed.error == null && parsed.tags.length > 0;
  const headline = `Found ${sheet.finished} of ${sheet.target} — want more?`;
  const status =
    busy === 'expand'
      ? progress || 'Searching related tags…'
      : busy === 'custom'
        ? progress || 'Searching those hashtags…'
        : busy === 'relax'
          ? 'Including creators from this batch…'
          : progress;
  return (
    <aside
      className="find-more-card fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface-raised p-4 shadow-raised"
      aria-labelledby="find-more-title"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="find-more-title" className="text-sm font-medium tracking-tight text-ink">
          {headline}
        </h2>
        <button type="button" className="icon-btn !p-1" aria-label="Dismiss" onClick={onDismiss}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {sheet.networkOnly ? (
        <div className="mt-3">
          <p className="text-sm text-ink">
            {sheet.suggestionNote || 'No related tags are left to search. Search the creator network instead.'}
          </p>
          {onNetwork ? (
            <button
              type="button"
              className="btn-primary mt-3 w-full"
              disabled={busy !== null}
              onClick={onNetwork}
            >
              {busy === 'network' ? 'Searching…' : 'Search the creator network'}
            </button>
          ) : null}
        </div>
      ) : picked.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Related tags">
          {picked.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                className="pill-idle"
                aria-label={`Remove ${tag}`}
                title="Remove this tag"
                onClick={() => setPicked((current) => current.filter((item) => item !== tag))}
              >
                {tag}
                <span className="ml-1 text-ink-faint" aria-hidden="true">
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {sheet.networkOnly ? null : (
      <button
        type="button"
        className="btn-primary mt-3 w-full"
        disabled={busy !== null || !sheet.canExpand || picked.length === 0}
        title={EXPAND_NOTE}
        onClick={() => onExpand(picked)}
      >
        {busy === 'expand' ? 'Searching…' : 'Search related tags'}
      </button>
      )}
      {status ? <p className="mt-2 text-xs text-ink-faint">{status}</p> : null}
      <button
        type="button"
        className="mt-3 text-xs text-ink-faint hover:text-ink"
        aria-expanded={more}
        onClick={() => setMore((value) => !value)}
      >
        {more ? 'Hide options' : 'More options'}
      </button>
      {more && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink" title={RELAX_NOTE}>
              Include creators without a public email
            </p>
            <button
              type="button"
              className="btn-ghost !px-2 !py-1 text-xs"
              disabled={busy !== null || !sheet.canRelaxEmail}
              title={RELAX_NOTE}
              onClick={onRelaxEmail}
            >
              {busy === 'relax' ? 'Including…' : 'Include'}
            </button>
          </div>
          <div>
            <label className="text-sm text-ink" htmlFor="find-more-tags" title="Comma-separated. Up to five.">
              Custom hashtags
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="find-more-tags"
                className="input"
                placeholder="#bookreview"
                value={customText}
                onChange={(event) => setCustomText(event.target.value)}
              />
              <button
                type="button"
                className="btn-ghost shrink-0"
                disabled={busy !== null || !customReady}
                title="Searches these tags. Nothing is emailed."
                onClick={() => onCustom(parsed.tags, false)}
              >
                {busy === 'custom' ? 'Searching…' : 'Search'}
              </button>
            </div>
            {customText.trim() && parsed.error ? (
              <p className="mt-1 text-xs text-amber-200/90">{parsed.error}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
            disabled={busy !== null}
            title={ACCEPT_NOTE}
            onClick={onAccept}
          >
            {busy === 'accept' ? 'Keeping this batch…' : 'Accept batch'}
          </button>
        </div>
      )}
    </aside>
  );
}
