import { InlineToggle } from './RequirePublicEmailToggle';

const HINT = 'Off skips people already in this app. They do not count toward the limit.';

export function IncludeExistingSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <InlineToggle
      label="Include CRM creators"
      checked={checked}
      onChange={onChange}
      ariaLabel="Include CRM creators"
      hint={HINT}
      title={HINT}
    />
  );
}
