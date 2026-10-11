/** Rates above 100% come from one viral video divided by followers. Hide them. */
export function visibleEngagement(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

export function formatEngagement(value: number | null | undefined): string {
  const n = visibleEngagement(value);
  if (n == null) return '—';
  return `${n.toFixed(1)}%`;
}
