/**
 * Direct blast helpers — template merge + Resend send for custom audiences.
 * British English comments.
 */
import { buildColdEmailPayload } from '../cold-email.js';
import { renderTemplate, type TemplateContext } from '../templates/tokens.js';
import { resolveBlastFrom, resolveBlastReplyTo } from './blastFrom.js';

export { BLAST_FROM, BLAST_REPLY_TO } from './blastFrom.js';

export interface BlastMember {
  id?: string;
  email: string;
  display_name?: string | null;
}

export interface BlastTemplateVars {
  display_name?: string;
  creator_name?: string;
  hook?: string;
  app_name?: string;
  creator_handle?: string;
  platform?: string;
  recent_video_topic?: string;
  value_prop?: string;
  [key: string]: string | undefined;
}

/** Apply outreach tokens. Missing display name becomes "there"; unused hook stays blank. */
export function applyBlastTemplate(
  template: string,
  vars: BlastTemplateVars,
): string {
  const context: TemplateContext = {
    displayName: vars.display_name,
    creatorName: vars.creator_name || vars.display_name,
    handle: vars.creator_handle,
    appName: vars.app_name,
    platform: vars.platform,
    hook: vars.hook,
    recentVideoTopic: vars.recent_video_topic,
    valueProp: vars.value_prop,
  };
  return renderTemplate(template, context);
}

export interface SendBlastEmailResult {
  ok: boolean;
  providerMessageId: string | null;
  error?: string;
  dryRun?: boolean;
}

/**
 * Send one Resend email for a blast (or dry-run when RESEND_API_KEY missing).
 * The original production from-address keeps its display name. Any other
 * saved or environment address is used as given.
 */
export async function sendBlastEmail(input: {
  to: string;
  subject: string;
  body: string;
  resendApiKey?: string;
  resendFrom?: string;
  campaignId?: string;
  fetchImpl?: typeof fetch;
}): Promise<SendBlastEmailResult> {
  const from = resolveBlastFrom(process.env, input.resendFrom);
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(input.body);
  const htmlOrText = looksLikeHtml
    ? input.body
    : input.body.replace(/\n/g, '<br>\n');

  const payload = buildColdEmailPayload({
    provider: 'resend',
    to: input.to.trim(),
    from,
    subject: input.subject,
    htmlOrText,
    creatorId: input.campaignId ?? 'blast',
    sequenceStep: 1,
    sequenceTags: ['direct_blast'],
    replyTo: resolveBlastReplyTo(process.env),
  });

  const apiKey = input.resendApiKey ?? process.env.RESEND_API_KEY ?? '';
  if (!apiKey.trim()) {
    return {
      ok: true,
      providerMessageId: `dry-run-blast-${Date.now()}`,
      dryRun: true,
      error: 'RESEND_API_KEY not set — blast recorded as dry-run',
    };
  }

  const fetchFn = input.fetchImpl ?? fetch;
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        providerMessageId: null,
        error: `Resend ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
      };
    }
    return {
      ok: true,
      providerMessageId: typeof body.id === 'string' ? body.id : null,
    };
  } catch (err) {
    return {
      ok: false,
      providerMessageId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Parse emails from comma/newline paste, or {email, display_name?} objects. */
export function parseAudienceMembersInput(body: unknown): Array<{
  email: string;
  display_name: string | null;
}> {
  const out: Array<{ email: string; display_name: string | null }> = [];
  const seen = new Set<string>();

  const push = (emailRaw: string, displayName?: string | null) => {
    const email = emailRaw.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    if (seen.has(email)) return;
    seen.add(email);
    const name = displayName?.trim() || null;
    out.push({ email, display_name: name });
  };

  if (!body || typeof body !== 'object') return out;
  const b = body as Record<string, unknown>;

  if (Array.isArray(b.members)) {
    for (const m of b.members) {
      if (typeof m === 'string') {
        push(m);
      } else if (m && typeof m === 'object') {
        const row = m as Record<string, unknown>;
        const email = String(row.email ?? '').trim();
        const display =
          typeof row.display_name === 'string'
            ? row.display_name
            : typeof row.displayName === 'string'
              ? row.displayName
              : null;
        push(email, display);
      }
    }
  }

  if (Array.isArray(b.emails)) {
    for (const e of b.emails) {
      if (typeof e === 'string') {
        // Support "Name <email@x.com>" or "email,name" CSV-ish lines mixed in
        parseLooseEmailLine(e, push);
      }
    }
  }

  if (typeof b.text === 'string') {
    for (const line of b.text.split(/[\n,;]+/)) {
      parseLooseEmailLine(line, push);
    }
  }

  return out;
}

function parseLooseEmailLine(
  line: string,
  push: (email: string, displayName?: string | null) => void,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  // "Display Name <email@x.com>"
  const angle = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (angle) {
    push(angle[2]!, angle[1]!);
    return;
  }
  // CSV: email,display_name
  if (trimmed.includes(',') && trimmed.includes('@')) {
    const parts = trimmed.split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
    const emailPart = parts.find((p) => p.includes('@')) ?? parts[0]!;
    const namePart = parts.find((p) => p !== emailPart && !p.includes('@'));
    push(emailPart, namePart ?? null);
    return;
  }
  push(trimmed);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
