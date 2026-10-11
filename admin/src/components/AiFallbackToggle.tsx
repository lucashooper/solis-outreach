import { InlineToggle } from './RequirePublicEmailToggle';

const HINT = 'If the list is short, one extra search tries up to two related tags, then stops.';

export function AiFallbackToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <InlineToggle
      label="AI fallback search"
      checked={checked}
      onChange={onChange}
      ariaLabel="AI fallback search"
      hint={HINT}
      title={HINT}
    />
  );
}
