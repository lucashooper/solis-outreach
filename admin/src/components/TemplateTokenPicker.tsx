import { useEffect, useRef, useState } from 'react';
import { TEMPLATE_TOKEN_HELP, TEMPLATE_TOKENS } from '../../../src/templates/tokens.ts';

export function TemplateTokenPicker({ onInsert }: { onInsert: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        className="btn-ghost !px-2 !py-1 text-xs"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        {'{ }'} Insert variable
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-20 mt-1 max-h-64 w-56 overflow-auto rounded-xl border border-line bg-surface-overlay p-1 shadow-raised"
        >
          {TEMPLATE_TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              role="menuitem"
              title={TEMPLATE_TOKEN_HELP[token]}
              className="block w-full rounded-lg px-2 py-1.5 text-left font-mono text-xs text-ink-muted hover:bg-white/[0.05] hover:text-ink"
              onClick={() => {
                onInsert(token);
                setOpen(false);
              }}
            >
              {`{{${token}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
