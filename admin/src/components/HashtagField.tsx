import { useEffect, useState, type ReactNode } from 'react';
import {
  SEARCHED_HASHTAG_CAP,
  appendHashtag,
  hashtagSuggestionHint,
  insertHashtagAsSearched,
  isWeakHashtag,
  rankHashtagSuggestions,
  sortHashtagsByYield,
  weakHashtagTooltip,
  withoutWeakHashtags,
  type HashtagHistoryRow,
} from '../../../src/discovery/hashtagAdvice.ts';
import { fetchHashtagHistory } from '../lib/supabase';

export function HashtagField({
  id,
  appId,
  tags,
  niches,
  presetTags,
  input,
  onInput,
  onAdd,
  onChange,
  children,
}: {
  id: string;
  appId?: string | null;
  tags: string[];
  niches: string[];
  presetTags?: string[];
  input: string;
  onInput: (value: string, flush: boolean) => void;
  onAdd: () => void;
  onChange: (tags: string[]) => void;
  children?: ReactNode;
}) {
  const [history, setHistory] = useState<HashtagHistoryRow[]>([]);

  useEffect(() => {
    if (!appId) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    fetchHashtagHistory(appId)
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const byTag = new Map(history.map((row) => [row.tag, row]));
  const suggestions = rankHashtagSuggestions({
    history,
    current: tags,
    niches,
    presetTags,
  });
  const weakCount = tags.filter((tag) => isWeakHashtag(byTag.get(tag))).length;
  const sorted = sortHashtagsByYield(tags, history);
  const orderChanged = sorted.some((tag, index) => tag !== tags[index]);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <label className="label mb-0" htmlFor={id}>
          Hashtag targeting
        </label>
        {tags.length > SEARCHED_HASHTAG_CAP && (
          <p className="text-[11px] text-ink-faint">First 2 are searched</p>
        )}
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {tags.map((tag, index) => {
          const row = byTag.get(tag);
          const weak = isWeakHashtag(row);
          const searched = index < SEARCHED_HASHTAG_CAP;
          const tip = [
            searched ? 'Included in each search' : 'Not searched until it is in the first 2',
            row ? weakHashtagTooltip(row) : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <button
              key={tag}
              type="button"
              className={`pill ${
                weak
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
                  : 'border-accent/40 bg-accent/15 text-ink'
              }`}
              title={tip}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
            >
              {weak && (
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
              )}
              {tag}
              {searched && <span className="ml-1 text-[10px] text-ink-faint">Searched</span>}
              <span className="ml-1 text-ink-faint">×</span>
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <input
          id={id}
          className="input"
          placeholder="#booktok"
          value={input}
          onChange={(event) => onInput(event.target.value, false)}
          onBlur={(event) => onInput(event.target.value, true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onInput(event.currentTarget.value, true);
            }
          }}
        />
        <button type="button" className="btn-secondary shrink-0" onClick={onAdd}>
          Add
        </button>
      </div>
      {(suggestions.length > 0 || weakCount > 0 || orderChanged) && (
        <div className="mt-2 space-y-2">
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-ink-faint">Suggested</span>
              {suggestions.map((suggestion) => (
                <span
                  key={suggestion.tag}
                  className="inline-flex items-stretch overflow-hidden rounded-full border border-line"
                >
                  <button
                    type="button"
                    className="px-2 py-0.5 text-[11px] text-ink-faint hover:text-ink"
                    title={hashtagSuggestionHint(suggestion)}
                    onClick={() => onChange(appendHashtag(tags, suggestion.tag))}
                  >
                    + {suggestion.tag}
                  </button>
                  <button
                    type="button"
                    className="border-l border-line px-1.5 text-[10px] text-ink-faint hover:text-ink"
                    title="Search this tag. It moves into the first 2."
                    onClick={() => onChange(insertHashtagAsSearched(tags, suggestion.tag))}
                  >
                    Search
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {weakCount > 0 && (
              <button
                type="button"
                className="btn-ghost !px-2 !py-1 text-xs"
                onClick={() => onChange(withoutWeakHashtags(tags, history))}
              >
                Remove weak tags
              </button>
            )}
            {orderChanged && (
              <button
                type="button"
                className="btn-ghost !px-2 !py-1 text-xs"
                title="Stronger tags first. Only the first 2 are searched."
                onClick={() => onChange(sorted)}
              >
                Sort by yield
              </button>
            )}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
