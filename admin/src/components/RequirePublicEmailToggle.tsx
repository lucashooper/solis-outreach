import { InfoTip } from './InfoTip';

export function InlineToggle({
  label,
  checked,
  onChange,
  title,
  ariaLabel,
  hint,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
  ariaLabel: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-sm text-ink">{label}</span>
      {hint ? <InfoTip label={`${label} details`} text={hint} /> : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        title={title ?? hint}
        disabled={disabled}
        className={checked ? 'toggle-on' : 'toggle-off'}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-knob" style={{ left: checked ? '1.25rem' : '0.125rem' }} />
      </button>
    </div>
  );
}

const EMAIL_HINT = 'Only list creators whose bio already shows a public email.';

export function RequirePublicEmailToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <InlineToggle
      label="Require public email"
      checked={checked}
      onChange={onChange}
      ariaLabel="Require public email"
      hint={EMAIL_HINT}
      title={EMAIL_HINT}
    />
  );
}
