import { useEffect, useState } from 'react';
import { discoveryCostHint, discoveryCostTooltip } from '../../../src/discovery/funnel';
import type { DiscoverySource } from '../../../src/discovery/network';
import { expressApiUrl } from '../lib/settings';

function creditLine(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const credit = (body as { credit?: { remainingUsd?: unknown; maxUsd?: unknown; accountCount?: unknown } })
    .credit;
  const remaining = Number(credit?.remainingUsd);
  const max = Number(credit?.maxUsd);
  const accounts = Number(credit?.accountCount);
  if (!Number.isFinite(remaining) || !Number.isFinite(max)) return null;
  const across =
    Number.isFinite(accounts) && accounts > 1 ? ` across ${accounts} accounts` : '';
  return `Apify monthly credit: $${remaining.toFixed(2)} of $${max.toFixed(2)} left${across}.`;
}

export function DiscoveryCostNote({
  limit,
  requireEmail = true,
  source = 'both',
}: {
  limit: number;
  requireEmail?: boolean;
  source?: DiscoverySource;
}) {
  const [credit, setCredit] = useState<string | null>(null);
  useEffect(() => {
    const base = expressApiUrl();
    if (!base) return;
    let cancelled = false;
    fetch(`${base}/api/discovery/credit`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        setCredit(creditLine(body));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const hint = discoveryCostHint(limit, requireEmail, source);
  const price = hint.split('·')[0]?.trim() || hint;
  const tooltip = [discoveryCostTooltip(limit, requireEmail, source), credit].filter(Boolean).join(' ');
  return (
    <span
      className="inline-flex rounded-full border border-line px-1.5 py-px text-[10px] font-normal normal-case tracking-normal text-ink-faint"
      title={tooltip}
    >
      {price}
    </span>
  );
}
