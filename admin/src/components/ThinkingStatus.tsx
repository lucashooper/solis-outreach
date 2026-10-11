import { useEffect, useState } from 'react';

const STAGES = [
  'Querying Apify hashtags…',
  'Scraping creator profiles…',
  'Filtering by engagement…',
  'Writing outreach hooks…',
  'Saving results…',
];

export function ThinkingStatus({
  active,
  hint,
  slim = false,
}: {
  active: boolean;
  hint?: string | null;
  /** One quiet line. Does not cycle through stages. */
  slim?: boolean;
}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active || slim) {
      setIndex(0);
      return;
    }
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % STAGES.length);
    }, 2200);
    return () => window.clearInterval(timer);
  }, [active, slim]);

  if (!active) return null;

  if (slim) {
    return (
      <p className="flex items-center gap-2 text-xs text-ink-faint" role="status">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-zinc-400" />
        <span>{hint || 'Finding creators'}</span>
      </p>
    );
  }

  const known = hint && STAGES.includes(hint) ? hint : null;
  const copy = known ?? STAGES[index];

  return (
    <div className="flex items-center gap-2 text-sm text-ink-muted" role="status">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
      </span>
      <span key={copy} className="transition-opacity duration-300">
        {copy}
      </span>
    </div>
  );
}
