import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import type { DiscoveryFunnel } from '../../../src/discovery/types.ts';
import { ApifyAccountSpend } from './ApifyAccountSpend';

function formatFunnel(funnel: DiscoveryFunnel | null): string {
  if (!funnel) return 'No funnel stored.';
  const runs = funnel.apifyRunIds.filter(Boolean).join(', ') || 'none';
  return [
    `${funnel.rawItems} videos`,
    `${funnel.uniqueCreators} creators`,
    `${funnel.afterFollowers} in range`,
    `${funnel.withEmail} with email`,
    `${funnel.saved} new`,
    typeof funnel.existing === 'number' ? `${funnel.existing} already in the CRM` : '',
    `runs ${runs}`,
    funnel.reason ? `reason ${funnel.reason}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Short explanation when a search did not save creators. Details stay behind the info control. */
export function DiscoveryRunNote({
  title,
  action,
  jobId,
  funnel,
}: {
  title: string;
  action?: string | null;
  jobId?: string | null;
  funnel?: DiscoveryFunnel | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <section className="rounded-2xl border border-line bg-surface-raised px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-medium tracking-tight text-ink">{title}</h2>
          {action ? <p className="mt-1 text-xs text-ink-faint">{action}</p> : null}
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            className="icon-btn"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label="Search details"
            onClick={() => setOpen((value) => !value)}
          >
            <Info className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          {open && (
            <div
              id={panelId}
              role="note"
              className="absolute right-0 z-20 mt-1 w-80 max-w-[min(20rem,calc(100vw-3rem))] rounded-xl border border-line bg-surface-overlay p-3 text-left text-xs leading-relaxed text-ink-muted shadow-raised"
            >
              {jobId ? <p>Job {jobId}</p> : null}
              <p className={jobId ? 'mt-2' : ''}>{formatFunnel(funnel ?? null)}</p>
              {funnel ? (
                <div className="mt-2">
                  <ApifyAccountSpend funnel={funnel} />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
