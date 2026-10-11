import { narrowRangeHint } from '../../../src/discovery/funnel';

export function NarrowRangeHint({
  min,
  max,
}: {
  min: number | null | undefined;
  max: number | null | undefined;
}) {
  const hint = narrowRangeHint(min, max);
  if (!hint) return null;
  return (
    <span
      className="inline-flex rounded-full border border-line px-1.5 py-px text-[10px] font-normal normal-case tracking-normal text-ink-faint"
      title={hint}
    >
      Narrow range
    </span>
  );
}
