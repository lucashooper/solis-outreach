/**
 * Duplicate and do-not-contact checks shared by pitches, blasts, and follow-ups.
 * A do-not-contact flag always blocks. A previous successful send blocks unless
 * the caller passes an explicit override.
 */

export interface SuppressionInput {
  doNotContact: boolean;
  alreadyEmailed: boolean;
  override?: boolean;
}

export interface SuppressionDecision {
  skip: boolean;
  reason: string | null;
}

export function suppressionDecision(input: SuppressionInput): SuppressionDecision {
  if (input.doNotContact) {
    return {
      skip: true,
      reason: 'Blocked: this person is marked Do not contact.',
    };
  }
  if (input.alreadyEmailed && !input.override) {
    return {
      skip: true,
      reason:
        'Skipped: this email or handle was already emailed. Send again only with an explicit override.',
    };
  }
  return { skip: false, reason: null };
}

export function normaliseEmail(email?: string | null): string {
  return String(email ?? '').trim().toLowerCase();
}

export function normaliseHandle(handle?: string | null): string {
  return String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
}

const SENT_STATUSES = new Set(['sent', 'opened']);

export function priorSendCounts(status?: string | null): boolean {
  return SENT_STATUSES.has(String(status ?? '').toLowerCase());
}

interface CreatorRow {
  id: string;
  do_not_contact?: boolean | null;
}

/**
 * Service-role lookup used by the Express pitch path.
 * Netlify functions use the matching helper in netlify/lib/suppression.mjs.
 */
export async function lookupSuppression(
  sb: {
    from: (table: string) => any;
  },
  input: { email?: string | null; handle?: string | null; doNotContact?: boolean; override?: boolean },
): Promise<SuppressionDecision> {
  const email = normaliseEmail(input.email);
  const handle = normaliseHandle(input.handle);
  const creators: CreatorRow[] = [];

  if (email) {
    const { data, error } = await sb
      .from('creators')
      .select('id, do_not_contact')
      .ilike('email', email)
      .limit(20);
    if (error) throw new Error(error.message);
    creators.push(...((data ?? []) as CreatorRow[]));
  }
  if (handle) {
    const { data, error } = await sb
      .from('creators')
      .select('id, do_not_contact')
      .ilike('handle', handle)
      .limit(20);
    if (error) throw new Error(error.message);
    creators.push(...((data ?? []) as CreatorRow[]));
  }

  const seen = new Set<string>();
  const unique = creators.filter((row) => {
    if (!row?.id || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  const doNotContact =
    Boolean(input.doNotContact) || unique.some((row) => row.do_not_contact === true);

  let alreadyEmailed = false;
  if (email) {
    const { data, error } = await sb
      .from('blast_sends')
      .select('id')
      .ilike('email', email)
      .in('status', ['sent', 'opened'])
      .limit(1);
    if (error) throw new Error(error.message);
    alreadyEmailed = Array.isArray(data) && data.length > 0;
  }
  if (!alreadyEmailed && unique.length > 0) {
    const { data, error } = await sb
      .from('outreach_logs')
      .select('id, sent_at, outcome')
      .in(
        'creator_id',
        unique.map((row) => row.id),
      )
      .not('sent_at', 'is', null)
      .limit(8);
    if (error) throw new Error(error.message);
    alreadyEmailed = Array.isArray(data)
      && data.some((row: { outcome?: string | null; sent_at?: string | null }) =>
        row.outcome !== 'skipped' && Boolean(row.sent_at),
      );
  }

  return suppressionDecision({
    doNotContact,
    alreadyEmailed,
    override: Boolean(input.override),
  });
}
