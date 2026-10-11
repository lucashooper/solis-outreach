/**
 * Unread CRM replies.
 *
 * A reply stays unread until the operator has seen it. Seen ids live in the
 * browser (see admin replyInbox) because email_replies is select-only for the
 * admin client — this does not add a column or a write path.
 *
 * - An inbox row (email_replies) is unread until that message is opened, or
 *   until the creator thread that owns it is opened.
 * - A blast mailbox reply (blast_sends.replied_at) has no thread. It is unread
 *   until that row is opened. If the same address already has an email_replies
 *   row, only the inbox row counts.
 *
 * Counts:
 * - Sidebar: one per creator with an unseen reply, plus each unlinked inbox
 *   reply, plus each unseen blast-only reply.
 * - Replied tab: creators with an unseen reply, plus unseen blast-only replies.
 * - Replies tab: unseen email_replies rows, one per message.
 */

export interface UnreadReplyRef {
  id: string;
  creator_id: string | null;
  from_email: string;
}

export interface UnreadBlastRef {
  email: string;
}

export interface UnreadSummary {
  total: number;
  repliedTab: number;
  repliesTab: number;
  unseenReplyIds: string[];
  unseenCreatorIds: string[];
  unseenBlastIds: string[];
}

export function blastUnreadId(email: string): string {
  return `blast:${email.trim().toLowerCase()}`;
}

export function summariseUnread(
  replies: readonly UnreadReplyRef[],
  blasts: readonly UnreadBlastRef[],
  seen: ReadonlySet<string>,
): UnreadSummary {
  const unseenReplies = replies.filter((row) => row.id && !seen.has(row.id));
  const replyEmails = new Set(
    replies
      .map((row) => row.from_email.trim().toLowerCase())
      .filter((email) => email.includes('@')),
  );
  const unseenBlasts = blasts.filter((row) => {
    const email = row.email.trim().toLowerCase();
    if (!email.includes('@')) return false;
    if (seen.has(blastUnreadId(email))) return false;
    if (replyEmails.has(email)) return false;
    return true;
  });
  const unseenCreatorIds = [
    ...new Set(
      unseenReplies
        .map((row) => row.creator_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const unlinked = unseenReplies.filter((row) => !row.creator_id).length;
  const unseenBlastIds = unseenBlasts.map((row) => blastUnreadId(row.email));
  return {
    total: unseenCreatorIds.length + unlinked + unseenBlasts.length,
    repliedTab: unseenCreatorIds.length + unseenBlasts.length,
    repliesTab: unseenReplies.length,
    unseenReplyIds: unseenReplies.map((row) => row.id),
    unseenCreatorIds,
    unseenBlastIds,
  };
}
