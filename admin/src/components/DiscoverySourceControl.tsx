import type { DiscoverySource } from '../../../src/discovery/network';

const OPTIONS: { id: DiscoverySource; label: string }[] = [
  { id: 'network', label: 'Network' },
  { id: 'hashtags', label: 'Hashtags' },
  { id: 'both', label: 'Both' },
];

export function DiscoverySourceControl({
  value,
  onChange,
  disabled = false,
  subtle = false,
}: {
  value: DiscoverySource;
  onChange: (next: DiscoverySource) => void;
  disabled?: boolean;
  /** Quieter control for the campaign header. */
  subtle?: boolean;
}) {
  return (
    <div className="inline-flex flex-col gap-1">
      {subtle ? null : (
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint">Source</span>
      )}
      <div
        role="radiogroup"
        aria-label="Discovery source"
        title="Network reads following lists of creators already in this app. Both tries that first, then hashtags if it is short of the target."
        className={
          subtle
            ? 'inline-flex rounded-md bg-white/[0.03] p-0.5'
            : 'inline-flex rounded-lg border border-line bg-white/[0.03] p-0.5'
        }
      >
        {OPTIONS.map((option) => {
          const selected = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              className={
                selected
                  ? subtle
                    ? 'rounded-md bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-ink-muted'
                    : 'rounded-md bg-white/[0.08] px-2.5 py-1 text-xs font-medium text-ink'
                  : subtle
                    ? 'rounded-md px-2 py-0.5 text-[11px] text-ink-faint hover:text-ink-muted'
                    : 'rounded-md px-2.5 py-1 text-xs text-ink-faint hover:text-ink-muted'
              }
              onClick={() => onChange(option.id)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
