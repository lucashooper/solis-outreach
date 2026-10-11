export function skipReasonLabel(error: string | null | undefined): string {
  const text = (error ?? '').toLowerCase();
  if (text.includes('already emailed') || text.includes('already contacted')) {
    return 'Already contacted';
  }
  if (text.includes('do not contact')) return 'Do not contact';
  const trimmed = (error ?? '').trim();
  return trimmed || 'Skipped';
}

export function summariseBlast(
  rows: Array<{ status: string; error?: string | null }>,
): string {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let already = 0;
  for (const row of rows) {
    if (row.status === 'sent' || row.status === 'opened') sent += 1;
    else if (row.status === 'failed') failed += 1;
    else if (row.status === 'skipped') {
      skipped += 1;
      if (skipReasonLabel(row.error) === 'Already contacted') already += 1;
    }
  }
  if (sent === 0 && failed === 0 && skipped > 0 && already === skipped) {
    return `Blast finished: skipped ${skipped} (already contacted).`;
  }
  const parts = [`${sent} sent`, `${failed} failed`];
  if (skipped > 0) {
    parts.push(
      already > 0 ? `skipped ${skipped} (already contacted)` : `skipped ${skipped}`,
    );
  }
  return `Blast finished: ${parts.join(', ')}.`;
}
