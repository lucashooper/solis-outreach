import type { DiscoveryFunnel } from '../../../src/discovery/types.ts';

function roundLabel(kind: string | undefined): string {
  if (kind === 'network') return 'following lists';
  if (kind === 'profile') return 'profile lookup';
  if (kind === 'expand') return 'expand';
  if (kind === 'hashtag') return 'hashtags';
  return 'search';
}

/** Compact account spend for a discovery run. Tokens are never shown. */
export function ApifyAccountSpend({ funnel }: { funnel: DiscoveryFunnel }) {
  const accounts = funnel.apifyAccounts ?? [];
  if (accounts.length === 0) return null;
  const rounds = funnel.apifyRounds ?? [];
  const summary = accounts.map((row) => `${row.label} · $${row.spentUsd.toFixed(2)}`).join(' · ');
  const title = rounds
    .map(
      (round) =>
        `${round.accountLabel}: ${roundLabel(round.kind)}, $${round.chargeUsd.toFixed(2)}`,
    )
    .join('\n');
  return (
    <details className="text-xs text-ink-faint">
      <summary className="cursor-pointer" title={title || summary}>
        {summary}
      </summary>
      {rounds.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {rounds.map((round, index) => (
            <li key={round.runId ?? `${round.accountIndex}-${index}`}>
              {round.accountLabel} · {roundLabel(round.kind)} · ${round.chargeUsd.toFixed(2)}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
