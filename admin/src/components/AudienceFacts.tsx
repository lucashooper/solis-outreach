import { audienceSelectorLine, isNewAudience } from '../../../src/audiences/naming.ts';
import type { AudienceGroup } from '../lib/supabase';

export function AudienceFacts({ group }: { group: AudienceGroup }) {
  const fresh = isNewAudience(group.created_at);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <p className="text-sm text-ink-faint">{audienceSelectorLine(group)}</p>
      {fresh && (
        <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
          New
        </span>
      )}
      {group.source === 'discovery' && (
        <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">
          Discovery
        </span>
      )}
    </div>
  );
}
