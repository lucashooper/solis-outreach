import { useId, useState } from 'react';
import { normaliseHashtags } from '../../../src/discovery/hashtags.ts';

export function CompactHashtags({ tags }: { tags: readonly string[] }) {
  const list = normaliseHashtags(tags);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (list.length === 0) return null;
  if (list.length <= 4) {
    return (
      <ul className="flex min-w-0 flex-wrap gap-1" aria-label="Hashtags">
        {list.map((tag) => (
          <li key={tag} className="pill-idle !px-2 !py-0.5">
            {tag}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="relative">
      <button
        type="button"
        className="pill-idle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {list.length} hashtags
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute left-0 z-20 mt-1 flex w-64 max-w-[min(16rem,calc(100vw-3rem))] flex-wrap gap-1 rounded-xl border border-line bg-surface-raised p-2 shadow-raised"
        >
          {list.map((tag) => (
            <span key={tag} className="pill-idle">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
