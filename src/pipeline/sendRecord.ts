import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asTemplateId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return UUID_RE.test(id) ? id : null;
}

/** Drop columns the database has not migrated yet so a send still records. */
export function omitMissingSendColumns(
  row: Record<string, unknown>,
  message: string,
): Record<string, unknown> {
  const next = { ...row };
  if (/template_id/i.test(message)) delete next.template_id;
  if (/\bsubject\b/i.test(message)) delete next.subject;
  return next;
}

export async function insertSendRow(
  sb: SupabaseClient,
  table: 'outreach_logs' | 'blast_sends',
  row: Record<string, unknown>,
  options?: { select?: boolean },
): Promise<{ data: unknown; error: { message: string } | null }> {
  const run = (payload: Record<string, unknown>) => {
    const query = sb.from(table).insert(payload);
    return options?.select ? query.select().single() : query;
  };
  const first = await run(row);
  if (!first.error) return first;
  const next = omitMissingSendColumns(row, first.error.message);
  if (Object.keys(next).length === Object.keys(row).length) return first;
  return run(next);
}
