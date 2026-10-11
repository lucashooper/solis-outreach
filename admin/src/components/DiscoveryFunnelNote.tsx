import {
  discoveryFunnelMessage,
  showFunnelExplanation,
  suggestTurnOffEmail,
} from '../../../src/discovery/funnel.ts';
import { cooldownMessage } from '../../../src/discovery/tagCooldown.ts';
import type { DiscoveryFunnel } from '../../../src/discovery/types.ts';
import { ApifyAccountSpend } from './ApifyAccountSpend';
import { HashtagYieldNote } from './HashtagYieldNote';

export function DiscoveryFunnelNote({
  funnel,
  compact = false,
  bare = false,
  onWiden,
  onIncludeExisting,
  onTurnOffEmail,
  hideYield = false,
  hideSummary = false,
}: {
  funnel: DiscoveryFunnel | null;
  compact?: boolean;
  /** Paragraph only, for a parent disclosure that already has a summary. */
  bare?: boolean;
  onWiden?: () => void;
  onIncludeExisting?: () => void;
  onTurnOffEmail?: () => void;
  /** The parent already shows the yield pills. */
  hideYield?: boolean;
  /** The shortfall sheet already explains the drop-off. */
  hideSummary?: boolean;
}) {
  if (!funnel) return null;
  const explain = showFunnelExplanation(funnel);
  const runId = funnel.apifyRunIds.find(Boolean);
  const stats = (
    <p className={bare ? 'mt-1' : 'mt-1'}>
      {compact ? `${discoveryFunnelMessage(funnel)} ` : ''}
      {funnel.network
        ? `${funnel.network.rows} following rows · ${funnel.network.seedsReturned} lists · ${funnel.network.seedsHidden} hidden · ${funnel.network.inRange} in range · ${funnel.network.relevant} relevant · `
        : `${funnel.rawItems} videos · `}
      {funnel.uniqueCreators} creators · {funnel.afterFollowers} in
      range
      {typeof funnel.afterBioExtract === 'number' ? ` · ${funnel.afterBioExtract} from bios` : ''}
      {typeof funnel.afterProfileEnrich === 'number'
        ? ` · ${funnel.afterProfileEnrich} after profile lookup`
        : ''}
      {' · '}
      {funnel.withEmail} with email · {funnel.saved} new
      {typeof funnel.existing === 'number' ? ` · ${funnel.existing} already in the CRM` : ''}
      {runId ? ` · Apify ${runId}` : ''}
      {funnel.skippedTags?.length ? ` · ${cooldownMessage(funnel.skippedTags)}` : ''}
    </p>
  );
  const accounts = <ApifyAccountSpend funnel={funnel} />;
  if (bare) {
    return (
      <div className="space-y-2 text-xs text-ink-faint">
        {stats}
        {!hideYield && (
          <HashtagYieldNote
            rows={funnel.hashtagYield ?? []}
            requireEmail={funnel.requirePublicEmail !== false}
            fallbackTags={funnel.fallbackTags ?? []}
            fallbackSource={funnel.fallbackSource}
          />
        )}
        {accounts}
      </div>
    );
  }
  return (
    <div className="space-y-2 text-left">
      {!compact && explain && !hideSummary && (
        <p className="text-sm text-ink-muted">{discoveryFunnelMessage(funnel)}</p>
      )}
      {!compact && explain && (onWiden || onIncludeExisting || (onTurnOffEmail && suggestTurnOffEmail(funnel))) && (
        <div className="flex flex-wrap gap-2">
          {onWiden && (
            <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={onWiden}>
              Widen range
            </button>
          )}
          {onTurnOffEmail && suggestTurnOffEmail(funnel) && (
            <button
              type="button"
              className="btn-secondary !px-3 !py-1.5 text-xs"
              onClick={onTurnOffEmail}
            >
              Turn off Require public email
            </button>
          )}
          {onIncludeExisting && (
            <button
              type="button"
              className="btn-secondary !px-3 !py-1.5 text-xs"
              onClick={onIncludeExisting}
            >
              Show creators already in the CRM
            </button>
          )}
        </div>
      )}
      {!hideYield && (
        <HashtagYieldNote
          rows={funnel.hashtagYield ?? []}
          requireEmail={funnel.requirePublicEmail !== false}
          fallbackTags={funnel.fallbackTags ?? []}
          fallbackSource={funnel.fallbackSource}
        />
      )}
      <details className="text-xs text-ink-faint">
        <summary className="cursor-pointer">Details</summary>
        {stats}
        {accounts}
      </details>
    </div>
  );
}
