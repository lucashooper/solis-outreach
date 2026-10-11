import { normaliseHashtags } from '../../../src/discovery/hashtags.ts';
import {
  visibleHashtagPacks,
  type HashtagPack,
} from '../../../src/discovery/hashtagPacks.ts';
import { getSupabase } from './supabase';

const LOCAL_PREFIX = 'solis-hashtag-packs:';

interface PackRow {
  id: string;
  name: string;
  hashtags: string[] | null;
  is_system: boolean | null;
}

function mapRow(row: PackRow): HashtagPack {
  return {
    id: row.id,
    name: row.name,
    hashtags: normaliseHashtags(row.hashtags ?? []),
    system: row.is_system === true,
  };
}

function readLocal(appId: string): HashtagPack[] {
  try {
    const raw = localStorage.getItem(`${LOCAL_PREFIX}${appId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { id?: string; name?: string; hashtags?: string[] };
      const name = String(row.name ?? '').trim();
      const hashtags = normaliseHashtags(row.hashtags ?? []);
      if (!row.id || !name || hashtags.length === 0) return [];
      return [{ id: row.id, name, hashtags, system: false }];
    });
  } catch {
    return [];
  }
}

function writeLocal(appId: string, packs: HashtagPack[]) {
  try {
    localStorage.setItem(
      `${LOCAL_PREFIX}${appId}`,
      JSON.stringify(packs.filter((pack) => !pack.system)),
    );
  } catch {
    /* private mode */
  }
}

function missingTable(message: string): boolean {
  return /hashtag_presets|schema cache|relation/i.test(message);
}

export async function loadHashtagPacks(appId: string | null): Promise<{
  custom: HashtagPack[];
  system: HashtagPack[];
}> {
  if (!appId) return visibleHashtagPacks([], []);
  const sb = getSupabase();
  if (!sb) return visibleHashtagPacks(readLocal(appId), []);
  const { data, error } = await sb
    .from('hashtag_presets')
    .select('id, name, hashtags, is_system')
    .eq('app_id', appId)
    .order('created_at', { ascending: true });
  if (error) return visibleHashtagPacks(readLocal(appId), []);
  const rows = ((data ?? []) as PackRow[]).map(mapRow);
  return visibleHashtagPacks(
    rows.filter((pack) => !pack.system),
    rows.filter((pack) => pack.system),
  );
}

export async function saveHashtagPack(
  appId: string,
  name: string,
  hashtags: string[],
): Promise<HashtagPack> {
  const label = name.trim();
  const tags = normaliseHashtags(hashtags);
  if (!label) throw new Error('Name the pack before saving.');
  if (tags.length === 0) throw new Error('Add a hashtag before saving a pack.');
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('hashtag_presets')
      .insert({ app_id: appId, name: label, hashtags: tags, is_system: false })
      .select('id, name, hashtags, is_system')
      .single();
    if (!error && data) return mapRow(data as PackRow);
    if (error && !missingTable(error.message)) throw new Error(error.message);
  }
  const pack: HashtagPack = {
    id: `local-${crypto.randomUUID()}`,
    name: label,
    hashtags: tags,
    system: false,
  };
  writeLocal(appId, [...readLocal(appId), pack]);
  return pack;
}

export async function renameHashtagPack(
  appId: string,
  pack: HashtagPack,
  name: string,
): Promise<void> {
  if (pack.system) return;
  const label = name.trim();
  if (!label) throw new Error('Name the pack before saving.');
  if (pack.id.startsWith('local-')) {
    writeLocal(
      appId,
      readLocal(appId).map((row) => (row.id === pack.id ? { ...row, name: label } : row)),
    );
    return;
  }
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb
    .from('hashtag_presets')
    .update({ name: label })
    .eq('id', pack.id)
    .eq('is_system', false);
  if (error && !missingTable(error.message)) throw new Error(error.message);
}

export async function deleteHashtagPack(appId: string, pack: HashtagPack): Promise<void> {
  if (pack.system) return;
  if (pack.id.startsWith('local-')) {
    writeLocal(
      appId,
      readLocal(appId).filter((row) => row.id !== pack.id),
    );
    return;
  }
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from('hashtag_presets').delete().eq('id', pack.id).eq('is_system', false);
  if (error && !missingTable(error.message)) throw new Error(error.message);
}
