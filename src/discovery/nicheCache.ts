import type { SupabaseClient } from '@supabase/supabase-js';
import { nicheScoreKey, type NicheScore } from './nicheScore.js';

function categoriesKey(categories: readonly string[]): string {
  return [...categories].map((id) => id.trim().toLowerCase()).filter(Boolean).sort().join(',');
}

/**
 * Scores already stored for this platform and category set.
 * A missing table, or a read error, leaves the in-memory cache to start empty.
 */
export async function loadNicheScoreCache(
  sb: SupabaseClient,
  platform: string,
  categories: readonly string[],
): Promise<Map<string, NicheScore>> {
  const cache = new Map<string, NicheScore>();
  const cats = categoriesKey(categories);
  const { data, error } = await sb
    .from('discovery_niche_scores')
    .select('handle, score, reason, band')
    .eq('platform', platform)
    .eq('categories', cats);
  if (error || !data) return cache;
  for (const row of data) {
    const handle = String(row.handle ?? '').replace(/^@/, '').trim().toLowerCase();
    const score = Number(row.score);
    const band = row.band;
    if (!handle || !Number.isFinite(score)) continue;
    if (band !== 'relevant' && band !== 'review' && band !== 'drop') continue;
    const stored: NicheScore = {
      score,
      reason: String(row.reason ?? '').slice(0, 180) || 'Scored earlier.',
      band,
      source: 'ai',
    };
    cache.set(nicheScoreKey(platform, handle, categories), stored);
  }
  return cache;
}

/** Persist new scores. Failures are ignored so a search still finishes. */
export async function saveNicheScoreCache(
  sb: SupabaseClient,
  cache: ReadonlyMap<string, NicheScore>,
  platform: string,
  categories: readonly string[],
): Promise<void> {
  const cats = categoriesKey(categories);
  const rows = [...cache.entries()].flatMap(([key, score]) => {
    const handle = key.split(':')[1]?.trim().toLowerCase();
    if (!handle) return [];
    return [
      {
        platform,
        handle,
        categories: cats,
        score: score.score,
        reason: score.reason.slice(0, 180),
        band: score.band,
        scored_at: new Date().toISOString(),
      },
    ];
  });
  if (rows.length === 0) return;
  const { error } = await sb.from('discovery_niche_scores').upsert(rows, {
    onConflict: 'platform,handle,categories',
  });
  if (error) console.warn('[discovery] could not store niche scores', error.message);
}
