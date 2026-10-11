import { ChevronDown } from 'lucide-react';
import { hookDateLabel, type VideoHookProvenance } from '../../../src/templates/videoHook.ts';

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function videoLinkLabel(href: string): string {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '');
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'TikTok video';
  } catch {
    /* A non-TikTok http(s) link still opens in a new tab. */
  }
  return 'Video';
}

/** Collapsed source for a {{video_hook}} line. British English. Does not confirm or alert. */
export function HookSourceDisclosure({
  provenance,
  edited = false,
}: {
  provenance: VideoHookProvenance | null | undefined;
  edited?: boolean;
}) {
  if (!provenance && !edited) return null;
  const href = safeHttpUrl(provenance?.video_url);
  const dateLabel = provenance ? hookDateLabel(provenance) : null;
  const ungrounded = provenance ? provenance.grounded !== true : false;

  return (
    <details className="group/source mt-2 rounded-lg border border-line bg-white/[0.03]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-ink-faint [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span>Source</span>
          {ungrounded && (
            <span className="truncate rounded-full border border-line px-1.5 py-px text-[10px] font-medium text-ink-faint">
              Not grounded, generic line
            </span>
          )}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200 group-open/source:rotate-180" />
      </summary>
      <div className="space-y-1 border-t border-line px-2.5 py-2 text-[11px] leading-5 text-ink-faint">
        {edited && <p>Edited by you</p>}
        {href && (
          <p>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-white/15 underline-offset-2 hover:text-ink"
            >
              {videoLinkLabel(href)}
            </a>
          </p>
        )}
        {provenance?.caption_snippet && (
          <p className="break-words">Caption: {provenance.caption_snippet}</p>
        )}
        {dateLabel && <p>{dateLabel}</p>}
        <p>Model: {provenance?.model ?? 'none'}</p>
      </div>
    </details>
  );
}
