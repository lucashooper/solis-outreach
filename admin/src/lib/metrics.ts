/** Em dash for a missing or zero analytics figure. Real counts stay as numbers. */
export function dashOrCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '\u2014';
  return String(value);
}

/** Em dash for a missing or zero rate. A known non-zero rate keeps its percent sign. */
export function dashOrPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '\u2014';
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${text}%`;
}
