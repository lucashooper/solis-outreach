/**
 * Blast From / reply-to.
 * A saved or environment address is used when it is not the original
 * production mailbox, so that deploy keeps its display name.
 */

export const BLAST_FROM = 'Alex from Example <outreach@example.com>';
export const BLAST_REPLY_TO = 'studioowner@gmail.com';

const LEGACY_ADDRESS = 'outreach@example.com';

export function resolveBlastFrom(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string | null,
): string {
  const direct = explicit?.trim() ?? '';
  if (direct && direct !== LEGACY_ADDRESS && direct !== BLAST_FROM) return direct;
  const from = String(env.RESEND_FROM_EMAIL ?? '').trim();
  if (from && from !== LEGACY_ADDRESS && from !== BLAST_FROM) {
    const name = String(env.RESEND_FROM_NAME ?? '').trim();
    if (name && !from.includes('<')) return `${name} <${from}>`;
    return from;
  }
  return BLAST_FROM;
}

export function resolveBlastReplyTo(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string | null,
): string {
  const direct = explicit?.trim() ?? '';
  if (direct) return direct;
  return String(env.RESEND_REPLY_TO ?? '').trim() || BLAST_REPLY_TO;
}
