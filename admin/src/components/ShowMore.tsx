import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export const SHOW_MORE_LIMIT = 5;

export function useExpandedList() {
  const [expanded, setExpanded] = useState(false);
  return {
    expanded,
    toggle: () => setExpanded((value) => !value),
    slice<T>(items: readonly T[]): readonly T[] {
      if (expanded || items.length <= SHOW_MORE_LIMIT) return items;
      return items.slice(0, SHOW_MORE_LIMIT);
    },
  };
}

export function ShowMore({
  total,
  expanded,
  onToggle,
  lined = false,
  spaced = false,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
  /** Hairline above the control, for a block that has no row dividers. */
  lined?: boolean;
  /** Extra space above the control when it sits under cards rather than rows. */
  spaced?: boolean;
}) {
  if (total <= SHOW_MORE_LIMIT) return null;
  return (
    <button
      type="button"
      className={`flex w-full items-center justify-center gap-1.5 px-3 py-2.5 text-sm text-ink-muted transition hover:bg-white/[0.03] hover:text-ink ${
        lined ? 'border-t border-line' : ''
      } ${spaced ? 'mt-3' : ''}`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.75} />
      ) : (
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
      )}
      {expanded ? 'Show less' : 'Show more'}
    </button>
  );
}
