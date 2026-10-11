/**
 * Do-not-contact always blocks. A previous sent or opened email blocks
 * unless override is explicitly true. Logic matches src/outreach/suppression.ts.
 */

export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function normaliseHandle(handle) {
  return String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
}

export function suppressionDecision(input) {
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

async function matchingCreators(sb, email, handle) {
  const rows = [];
  if (email) {
    const { data, error } = await sb
      .from('creators')
      .select('id, email, handle, do_not_contact')
      .ilike('email', email)
      .limit(20);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
  }
  if (handle) {
    const { data, error } = await sb
      .from('creators')
      .select('id, email, handle, do_not_contact')
      .ilike('handle', handle)
      .limit(20);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
  }
  const seen = new Set();
  return rows.filter((row) => {
    if (!row?.id || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

export async function lookupSuppression(sb, input) {
  const email = normaliseEmail(input.email);
  const handle = normaliseHandle(input.handle);
  const creators = await matchingCreators(sb, email, handle);
  const doNotContact =
    Boolean(input.doNotContact) || creators.some((row) => row.do_not_contact === true);

  let alreadyEmailed = false;
  if (email) {
    const { data, error } = await sb
      .from('blast_sends')
      .select('id')
      .ilike('email', email)
      .in('status', ['sent', 'opened'])
      .limit(1);
    if (error) throw new Error(error.message);
    alreadyEmailed = (data ?? []).length > 0;
  }

  if (!alreadyEmailed && creators.length > 0) {
    const { data, error } = await sb
      .from('outreach_logs')
      .select('id, sent_at, outcome')
      .in(
        'creator_id',
        creators.map((row) => row.id),
      )
      .not('sent_at', 'is', null)
      .limit(8);
    if (error) throw new Error(error.message);
    alreadyEmailed = (data ?? []).some((row) => row.outcome !== 'skipped' && row.sent_at);
  }

  return suppressionDecision({
    doNotContact,
    alreadyEmailed,
    override: Boolean(input.override),
  });
}
