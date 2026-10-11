import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, MessageSquareReply, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { IconButton } from './IconButton';
import { formatEngagement } from '../../../src/discovery/engagement.ts';
import { creatorProfileUrl } from '../../../src/creators/profile.ts';
import { StatusBadge } from './StatusBadge';
import { CreatorAvatar } from './CreatorAvatar';
import { PlatformMark } from './PlatformMark';
import type { Creator } from '../lib/types';

export function formatFollowers(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export { formatEngagement };

function RowIdentity({ creator, children }: { creator: Creator; children: ReactNode }) {
  const className = 'flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 hover:bg-white/[0.03]';
  if (creator.unsaved) {
    return (
      <a
        href={creatorProfileUrl(creator)}
        target="_blank"
        rel="noreferrer"
        className={className}
      >
        {children}
      </a>
    );
  }
  return (
    <Link to={`/creators/${creator.id}`} className={className}>
      {children}
    </Link>
  );
}

export function CreatorListRow({
  creator,
  busy,
  onSend,
  onSkip,
  onEditHook,
  onToggleReplied,
  onToggleDoNotContact,
  onFollowUp,
  needsFollowUp,
  sending,
  compact,
  entering,
  onDelete,
  unread,
}: {
  creator: Creator;
  busy?: boolean;
  /** True only while this row's email send is in flight. */
  sending?: boolean;
  onSend?: () => void;
  onSkip?: () => void;
  onEditHook?: () => void;
  onToggleReplied?: () => void;
  onToggleDoNotContact?: () => void;
  onFollowUp?: () => void;
  needsFollowUp?: boolean;
  compact?: boolean;
  /** Fade the row in when it has just arrived from a live search. */
  entering?: boolean;
  /** First-tap delete. The caller shows the Undo toast. */
  onDelete?: () => void;
  /** Unseen inbound reply linked to this creator. */
  unread?: boolean;
}) {
  const hook =
    typeof creator.ai_variables?.hook === 'string'
      ? creator.ai_variables.hook
      : '';
  const nicheBand = creator.ai_variables?.niche_band;
  const nicheReason =
    typeof creator.ai_variables?.niche_reason === 'string'
      ? creator.ai_variables.niche_reason.trim()
      : '';
  const emailFromLink = creator.ai_variables?.email_source === 'bio_link';
  const emailSourceUrl =
    typeof creator.ai_variables?.email_source_url === 'string'
      ? creator.ai_variables.email_source_url.trim()
      : '';
  const bioSnippet = (creator.bio || hook || '').trim();
  const alreadySent =
    creator.outreach_status === 'sent' || creator.outreach_status === 'replied';
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <article
      className={`flex flex-col gap-2 border-b border-line px-4 py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-3 ${
        entering ? 'stream-in' : ''
      }`}
    >
      <RowIdentity creator={creator}>
        <CreatorAvatar name={creator.handle} url={creator.avatar_url} creatorId={creator.id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="truncate text-sm font-medium text-ink"
              title={nicheReason || undefined}
            >
              @{creator.handle}
            </span>
            {nicheBand === 'review' && (
              <span
                className="rounded-full border border-amber-500/30 px-2 py-0.5 text-[11px] text-amber-200/90"
                title={nicheReason || 'Low-confidence niche match'}
              >
                Review
              </span>
            )}
            {unread && (
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_6px_rgba(59,130,246,0.9)]"
                title="Unread reply"
                aria-label="Unread reply"
              />
            )}
            <PlatformMark platform={creator.platform} />
            {!creator.unsaved && <StatusBadge status={creator.outreach_status} />}
            {creator.alreadyInCrm && (
              <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                Already in CRM
              </span>
            )}
            {creator.unsaved && (
              <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-faint">
                Not saved
              </span>
            )}
            {!creator.email && (
              <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-faint">
                No email
              </span>
            )}
            {creator.do_not_contact && (
              <span className="rounded-full border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300">
                Do not contact
              </span>
            )}
            {needsFollowUp && (
              <span className="rounded-full border border-amber-500/30 px-2 py-0.5 text-[11px] text-amber-200">
                Needs follow-up
              </span>
            )}
          </div>
          {bioSnippet && (
            <p className="mt-0.5 line-clamp-1 text-xs text-ink-faint">
              {bioSnippet}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-ink-muted">
            <span className="tabular-nums">
              {formatFollowers(creator.follower_count)} followers
            </span>
            <span className="tabular-nums">
              {formatEngagement(creator.engagement_rate)} eng
            </span>
            {!compact && creator.email && (
              <span
                className="truncate text-ink-faint"
                title={
                  emailFromLink
                    ? `Email from bio link${emailSourceUrl ? ` (${emailSourceUrl})` : ''}`
                    : undefined
                }
              >
                {creator.email}
              </span>
            )}
          </div>
        </div>
      </RowIdentity>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <a
          href={creatorProfileUrl(creator)}
          target="_blank"
          rel="noreferrer"
          className="icon-btn"
          aria-label="Open profile"
          title="Open profile"
        >
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span className="icon-btn-tip" role="tooltip" aria-hidden="true">
            Open profile
          </span>
        </a>
        {onEditHook && (
          <IconButton label="Edit hook" disabled={busy} onClick={onEditHook}>
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </IconButton>
        )}
        {creator.alreadyInCrm && (
          <Link to={`/creators/${creator.id}`} className="btn-ghost !px-3 !py-1.5 text-xs">
            Open in CRM
          </Link>
        )}
        {onSend && !alreadySent && (
          <button
            type="button"
            className="btn-primary !px-3 !py-1.5 text-xs"
            disabled={
              busy ||
              sending ||
              creator.unsaved ||
              !creator.email ||
              creator.outreach_status === 'archived'
            }
            title={
              creator.unsaved
                ? 'Not saved on this campaign yet'
                : creator.email
                  ? 'Send email'
                  : 'No public email'
            }
            onClick={onSend}
          >
            {sending ? 'Sending…' : 'Send email'}
          </button>
        )}
        {onFollowUp && needsFollowUp && (
          <button
            type="button"
            className="btn-secondary !px-2.5 !py-1.5 text-xs"
            disabled={busy}
            onClick={onFollowUp}
          >
            Send follow-up
          </button>
        )}
        {onToggleReplied && creator.outreach_status !== 'replied' && (
          <IconButton label="Mark replied" disabled={busy} onClick={onToggleReplied}>
            <MessageSquareReply className="h-3.5 w-3.5" strokeWidth={1.75} />
          </IconButton>
        )}
        {onDelete && (
          <IconButton
            label={`Delete @${creator.handle.replace(/^@/, '')}`}
            tone="danger"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </IconButton>
        )}
        {(onSend || onSkip || onToggleDoNotContact || onToggleReplied) && (
          <div className="relative">
            <button
              type="button"
              className="btn-ghost !px-2 !py-1.5"
              aria-label={`More actions for @${creator.handle}`}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-20 mt-1 w-44 rounded-xl border border-line bg-surface-raised p-1 shadow-lg">
                {onSend && alreadySent && (
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-white/[0.04]"
                    disabled={busy || sending || !creator.email}
                    onClick={() => {
                      setMenuOpen(false);
                      onSend();
                    }}
                  >
                    Resend
                  </button>
                )}
                {onToggleReplied && creator.outreach_status === 'replied' && (
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-white/[0.04]"
                    disabled={busy}
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleReplied();
                    }}
                  >
                    Clear replied
                  </button>
                )}
                {onToggleDoNotContact && (
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-white/[0.04]"
                    disabled={busy}
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleDoNotContact();
                    }}
                  >
                    {creator.do_not_contact ? 'Allow contact' : 'Do not contact'}
                  </button>
                )}
                {onSkip && (
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-ink-faint hover:bg-white/[0.04]"
                    disabled={busy || creator.outreach_status === 'archived'}
                    onClick={() => {
                      setMenuOpen(false);
                      onSkip();
                    }}
                  >
                    Archive
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
