import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreatorCandidate } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function discoveryQueryKey(input: {
  niche?: string | null;
  hashtags?: string[] | null;
  platforms?: string[] | null;
  followerMin?: number | null;
  followerMax?: number | null;
  limit?: number | null;
  requirePublicEmail?: boolean;
  source?: string | null;
}): string {
  const niche = String(input.niche ?? '').trim().toLowerCase();
  const tags = [...(input.hashtags ?? [])]
    .map((tag) => tag.replace(/^#+/, '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const platforms = [...(input.platforms ?? [])]
    .map((platform) => platform.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const limit = Number(input.limit);
  return [
    niche,
    tags.join(','),
    platforms.join(','),
    input.followerMin ?? '',
    input.followerMax ?? '',
    Number.isFinite(limit) ? limit : '',
    input.requirePublicEmail === false ? 'any' : 'email',
    input.source ?? '',
  ].join('|');
}

export async function readDiscoveryCache(
  sb: SupabaseClient,
  queryKey: string,
  now = Date.now(),
): Promise<CreatorCandidate[] | null> {
  const since = new Date(now - DAY_MS).toISOString();
  const { data, error } = await sb
    .from('discovery_query_cache')
    .select('results, created_at')
    .eq('query_key', queryKey)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data || !shouldStoreDiscoveryCache(data.results)) return null;
  return data.results as CreatorCandidate[];
}

/** An empty search must not be reused. The next run should call Apify again. */
export function shouldStoreDiscoveryCache(results: unknown): boolean {
  return Array.isArray(results) && results.length > 0;
}

export async function writeDiscoveryCache(
  sb: SupabaseClient,
  input: { queryKey: string; appId?: string | null; results: unknown[] },
): Promise<void> {
  if (!shouldStoreDiscoveryCache(input.results)) return;
  const { error } = await sb.from('discovery_query_cache').insert({
    query_key: input.queryKey,
    app_id: input.appId || null,
    results: input.results,
  });
  if (error) {
    console.warn('[discovery-cache]', error.message);
  }
}

export function creatorMatchKey(platform: string, handle: string): string {
  return `${platform.trim().toLowerCase()}:${handle.replace(/^@/, '').trim().toLowerCase()}`;
}

/**
 * Split in-range creators into new rows and ones already stored.
 * Handles in `insertedThisRun` were saved by this search while it was streaming.
 * They must stay new. A later lookup would otherwise see those inserts and delete them.
 */
export function classifyDiscoveryMatches<T extends { handle: string; platform: string }>(
  rows: T[],
  knownIds: ReadonlyMap<string, string>,
  insertedThisRun: ReadonlySet<string> = new Set(),
): { fresh: T[]; existing: Array<T & { creatorId: string }> } {
  const fresh: T[] = [];
  const existing: Array<T & { creatorId: string }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = creatorMatchKey(row.platform, row.handle);
    if (!key.endsWith(':') && seen.has(key)) continue;
    if (key.endsWith(':')) continue;
    seen.add(key);
    const creatorId = knownIds.get(key);
    if (creatorId && !insertedThisRun.has(key)) {
      existing.push({ ...row, creatorId });
    } else {
      fresh.push(row);
    }
  }
  return { fresh, existing };
}

/** CRM id by platform:handle for the rows this app already stores. */
export async function lookupKnownCreatorIds(
  sb: SupabaseClient,
  appId: string | null | undefined,
  rows: Array<{ handle: string; platform: string }>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const handles = [...new Set(rows.map((row) => row.handle.replace(/^@/, '').trim()).filter(Boolean))];
  if (!appId || handles.length === 0) return map;
  const { data, error } = await sb
    .from('creators')
    .select('id, handle, platform')
    .eq('app_id', appId)
    .in('handle', handles);
  if (error || !data) return map;
  const wanted = new Set(rows.map((row) => creatorMatchKey(row.platform, row.handle)));
  for (const row of data) {
    const key = creatorMatchKey(String(row.platform), String(row.handle));
    if (!wanted.has(key) || map.has(key)) continue;
    map.set(key, String(row.id));
  }
  return map;
}

/** Every platform:handle this app already stores, so a search can skip them up front. */
export async function loadKnownCreatorKeys(
  sb: SupabaseClient,
  appId: string | null | undefined,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!appId) return keys;
  const pageSize = 1000;
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await sb
      .from('creators')
      .select('handle, platform')
      .eq('app_id', appId)
      .range(from, from + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) {
      const key = creatorMatchKey(String(row.platform ?? ''), String(row.handle ?? ''));
      if (!key.endsWith(':')) keys.add(key);
    }
    if (data.length < pageSize) break;
  }
  return keys;
}

/** Drop handles this app already stores, before any further profile work. */
export async function omitKnownCreators<T extends { handle: string; platform: string }>(
  sb: SupabaseClient,
  appId: string | null | undefined,
  rows: T[],
): Promise<T[]> {
  const known = await lookupKnownCreatorIds(sb, appId, rows);
  return classifyDiscoveryMatches(rows, known).fresh;
}
