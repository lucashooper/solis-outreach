import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

export function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <span className="group/tip relative inline-flex align-middle">
      <button
        type="button"
        className="inline-flex text-ink-faint hover:text-ink-muted"
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Info className="h-3 w-3" strokeWidth={1.75} />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden w-52 -translate-x-1/2 rounded-lg border border-line bg-surface-overlay px-2.5 py-1.5 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-ink-muted shadow-raised group-hover/tip:block group-focus-within/tip:block"
      >
        {text}
      </span>
    </span>
  );
}

export function FilterToggleRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-5 gap-y-2">{children}</div>;
}
