import { statusPillLabel } from '../../../src/crm/statusLabel.ts';
import type { OutreachStatus } from '../lib/types';

const STYLES: Record<string, string> = {
  pending: 'bg-white/[0.04] text-slate-400 ring-white/10',
  pending_review: 'bg-white/[0.04] text-slate-400 ring-white/10',
  queued: 'bg-white/[0.04] text-slate-400 ring-white/10',
  sent: 'bg-white/[0.04] text-sky-300/80 ring-white/10',
  replied: 'bg-white/[0.04] text-emerald-300/80 ring-white/10',
  bounced: 'bg-white/[0.04] text-amber-200/80 ring-white/10',
  archived: 'bg-white/[0.04] text-zinc-500 ring-white/10',
};

export function StatusBadge({ status }: { status: OutreachStatus | string }) {
  const label = statusPillLabel(status);
  return (
    <span
      className={`badge ring-1 ring-inset ${STYLES[status] ?? STYLES.pending}`}
    >
      {label}
    </span>
  );
}
