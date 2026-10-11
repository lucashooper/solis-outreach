import { isGroqConfigured, chatJson } from '../llm/client.js';
import { videoHookModel } from '../templates/videoHook.js';
import { isGenericExpansionTag, semanticNeighbourTags } from './expansionTags.js';
import { normaliseHashtag, normaliseHashtags } from './hashtags.js';

/** One extra search, and only this many tags, so a dry niche cannot fan out. */
export const FALLBACK_TAG_CAP = 2;

/**
 * Videos requested per tag on an expand round.
 * maxItems is tags × this, so two tags ask for 60, not a shared 15.
 */
export const FALLBACK_VIDEO_CAP = 30;

/** Alias used by the run controls. */
export const EXPAND_VIDEOS_PER_TAG = FALLBACK_VIDEO_CAP;

const NEIGHBOURS: Record<string, string[]> = {
  deepstash: ['productivityhacks', 'studytok'],
  productivity: ['productivityhacks', 'studytok'],
  productivityhacks: ['studytok', 'deepstash'],
  study: ['studytok', 'studygram'],
  studytok: ['studygram', 'productivityhacks'],
  book: ['booktok', 'authortok'],
  booktok: ['authortok', 'readingcommunity'],
  books: ['booktok', 'authortok'],
  fitness: ['fitnesstok', 'workout'],
  fitnesstok: ['workout', 'gymtok'],
  beauty: ['beautytok', 'skincare'],
  skincare: ['skintok', 'beautytok'],
};

function bare(tag: string): string {
  return tag.replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

/** Explicit neighbour-map tags for a niche. No stem guesses, and no generic tags. */
export function neighbourHashtags(seeds: readonly string[], blocked: readonly string[] = []): string[] {
  const skip = new Set(normaliseHashtags(blocked));
  const out: string[] = [];
  const push = (value: string) => {
    const tag = normaliseHashtag(value);
    if (!tag || skip.has(tag) || out.includes(tag) || isGenericExpansionTag(tag)) return;
    out.push(tag);
  };
  for (const seed of seeds.map((value) => bare(value)).filter(Boolean)) {
    for (const neighbour of NEIGHBOURS[seed] ?? []) push(neighbour);
  }
  return out;
}

/** Adjacent tags from the niche when the model is off or returns nothing. */
export function localAdjacentHashtags(niche: string, current: readonly string[]): string[] {
  const blocked = new Set(normaliseHashtags(current));
  const seeds = [niche, ...current].map((value) => bare(value)).filter(Boolean);
  const out: string[] = [];
  const push = (value: string) => {
    const tag = normaliseHashtag(value);
    if (!tag || blocked.has(tag) || out.includes(tag) || isGenericExpansionTag(tag)) return;
    out.push(tag);
  };
  for (const tag of semanticNeighbourTags({ niche, blocked: current })) push(tag);
  for (const seed of seeds) {
    for (const neighbour of NEIGHBOURS[seed] ?? []) push(neighbour);
  }
  for (const seed of seeds) {
    if (out.length >= FALLBACK_TAG_CAP) break;
    const stem = seed.endsWith('tok') ? seed.slice(0, -3) : seed;
    if (!stem) continue;
    push(`${stem}hacks`);
    push(`${stem}tok`);
    push(`${stem}tips`);
  }
  return out.slice(0, FALLBACK_TAG_CAP);
}

/** Read {"hashtags":["#tag"]} and drop tags already searched. */
export function parseFallbackHashtags(content: string, current: readonly string[]): string[] {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const list = record?.hashtags ?? record?.tags;
  if (!Array.isArray(list)) return [];
  const blocked = new Set(normaliseHashtags(current));
  const out: string[] = [];
  for (const item of list) {
    const tag = normaliseHashtag(String(item));
    if (!tag || blocked.has(tag) || out.includes(tag) || isGenericExpansionTag(tag)) continue;
    out.push(tag);
    if (out.length >= FALLBACK_TAG_CAP) break;
  }
  return out;
}

/**
 * Up to two related tags. Uses the model when Groq is configured, then the
 * niche list. Never throws — a dry suggestion simply skips the extra run.
 */
const suggestionCache = new Map<string, { tags: string[]; source: 'ai' | 'niche' }>();

export async function suggestFallbackHashtags(input: {
  niche: string;
  current: string[];
  pitch?: string | null;
  appName?: string | null;
  chat?: (prompt: string) => Promise<string>;
}): Promise<{ tags: string[]; source: 'ai' | 'niche' }> {
  const current = normaliseHashtags(input.current);
  const cacheKey = [input.appName ?? '', input.niche, input.pitch ?? '', current.join(' ')].join('|');
  const cached = input.chat ? undefined : suggestionCache.get(cacheKey);
  if (cached) return cached;
  const prompt = [
    `App: ${input.appName || 'this app'}`,
    `Niche: ${input.niche || 'creator'}`,
    input.pitch ? `Pitch: ${input.pitch}` : '',
    `Already searched: ${current.join(' ') || 'none'}`,
    `Reply with JSON {"hashtags":["#tag"]} and at most ${FALLBACK_TAG_CAP} hashtags a viewer of this specific app would use.`,
    'Stay inside the niche. Do not repeat a tag already searched.',
    'Never suggest broad creator-economy tags: contentcreator, creatorcommunity, fyp, foryou, viral, ugc, influencer.',
    'No commentary.',
  ]
    .filter(Boolean)
    .join('\n');

  const ask =
    input.chat ??
    (isGroqConfigured()
      ? async (user: string) => {
          const result = await chatJson({
            temperature: 0.2,
            model: videoHookModel(),
            maxTokens: 120,
            system:
              'You suggest niche hashtags for one app. Refuse generic creator tags. Reply with JSON only.',
            user,
          });
          return result.content;
        }
      : null);

  if (ask) {
    try {
      const tags = parseFallbackHashtags(await ask(prompt), current);
      if (tags.length > 0) {
        const result = { tags, source: 'ai' as const };
        if (!input.chat) suggestionCache.set(cacheKey, result);
        return result;
      }
    } catch (err) {
      console.warn(
        '[discovery] fallback tags used the niche list:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  const result = { tags: localAdjacentHashtags(input.niche, current), source: 'niche' as const };
  if (!input.chat) suggestionCache.set(cacheKey, result);
  return result;
}
