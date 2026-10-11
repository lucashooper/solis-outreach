import { chatJson } from '../llm/client.js';
import type { CategoryId } from './categories.js';
import { matchesRelevance } from './network.js';

export type NicheBand = 'relevant' | 'review' | 'drop';

export interface NicheScore {
  score: number;
  reason: string;
  band: NicheBand;
  source: 'ai' | 'keywords';
}

export interface NicheScoreInput {
  handle: string;
  displayName?: string | null;
  bio?: string | null;
  bioLinkDomain?: string | null;
  followerCount?: number | null;
  /** True when this creator was mined from a seed already in the niche. */
  seedInNiche?: boolean;
  /** True when this creator was returned by the campaign's own hashtag search. */
  campaignSourced?: boolean;
}

const RELEVANT_AT = 0.6;
const REVIEW_AT = 0.4;
const BATCH_SIZE = 30;
const SCORE_TIMEOUT_MS = 20_000;

const GENERIC_BIO =
  /^(dm|dms|email|business|collab|collabs|link|links|follow|creator|content|tiktok|ig|insta|inquiries|enquiry|enquiries|pr|ugc)?[\s.|·•,!-]*$/i;

const OFF_NICHE = [
  'makeup',
  'skincare',
  'grwm',
  'gym',
  'fitness',
  'workout',
  'crypto',
  'forex',
  'nft',
  'nfl',
  'nba',
  'recipe',
  'cooking',
  'foodie',
  'gaming',
  'fortnite',
  'onlyfans',
  'fashion',
  'ootd',
] as const;

export function bandForScore(score: number): NicheBand {
  if (score >= RELEVANT_AT) return 'relevant';
  if (score >= REVIEW_AT) return 'review';
  return 'drop';
}

export function nicheScoreKey(platform: string, handle: string, categories: readonly string[]): string {
  const cats = [...categories].map((id) => id.trim().toLowerCase()).filter(Boolean).sort().join(',');
  return `${platform.trim().toLowerCase()}:${handle.replace(/^@/, '').trim().toLowerCase()}:${cats}`;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function textOf(row: NicheScoreInput): string {
  return [row.bio, row.displayName, row.bioLinkDomain].filter(Boolean).join('\n');
}

function isGenericBio(bio: string | null | undefined): boolean {
  const trimmed = (bio ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  if (trimmed.length <= 18 && GENERIC_BIO.test(trimmed)) return true;
  return false;
}

/**
 * Keyword stand-in used when Groq is down, and as the meaning of a keyword hit.
 * An in-niche seed with an empty or generic bio is review, not a drop.
 * A bio that only names another niche is dropped.
 */
export function keywordNicheScore(
  row: NicheScoreInput,
  keywords: readonly string[],
): NicheScore {
  const text = textOf(row);
  const onNiche = matchesRelevance(text, keywords);
  const offNiche = matchesRelevance(text, OFF_NICHE) && !onNiche;
  if (onNiche && !offNiche) {
    return {
      score: 0.74,
      reason: 'Bio or name mentions the niche.',
      band: 'relevant',
      source: 'keywords',
    };
  }
  if (offNiche) {
    return {
      score: 0.15,
      reason: 'Bio is about a different niche.',
      band: 'drop',
      source: 'keywords',
    };
  }
  if (row.campaignSourced && !offNiche) {
    return {
      score: 0.62,
      reason: 'Found on a campaign hashtag.',
      band: 'relevant',
      source: 'keywords',
    };
  }
  if (row.seedInNiche && isGenericBio(row.bio)) {
    return {
      score: 0.46,
      reason: 'Follows an in-niche creator. Bio is empty or generic.',
      band: 'review',
      source: 'keywords',
    };
  }
  if (row.seedInNiche) {
    return {
      score: 0.42,
      reason: 'Follows an in-niche creator, with no clear niche words.',
      band: 'review',
      source: 'keywords',
    };
  }
  return {
    score: 0.2,
    reason: 'No niche words in the bio or name.',
    band: 'drop',
    source: 'keywords',
  };
}

function parseScores(content: string, expected: readonly string[]): Map<string, NicheScore> {
  const out = new Map<string, NicheScore>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return out;
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const rows = Array.isArray(record?.creators)
    ? record.creators
    : Array.isArray(parsed)
      ? parsed
      : [];
  const wanted = new Set(expected.map((handle) => handle.toLowerCase()));
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const handle = String(row.handle ?? '').replace(/^@/, '').trim();
    if (!handle || !wanted.has(handle.toLowerCase())) continue;
    const score = clampScore(Number(row.score));
    const reason = String(row.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
    out.set(handle.toLowerCase(), {
      score,
      reason: reason || 'Scored from the bio.',
      band: bandForScore(score),
      source: 'ai',
    });
  }
  return out;
}

function promptFor(rows: readonly NicheScoreInput[], categories: readonly string[]): string {
  const people = rows.map((row) => ({
    handle: row.handle.replace(/^@/, ''),
    name: (row.displayName ?? '').slice(0, 80),
    bio: (row.bio ?? '').slice(0, 280),
    linkDomain: row.bioLinkDomain ?? '',
    followers: row.followerCount ?? 0,
    fromInNicheSeed: row.seedInNiche === true,
  }));
  return [
    'Score each TikTok creator for fit with this app.',
    `Categories: ${categories.join(', ') || 'books, reading'}.`,
    'Return JSON only: {"creators":[{"handle":"...","score":0.0,"reason":"short"}]}',
    'score is 0 to 1. 1 is a clear fit. 0 is a different niche.',
    'Use the handle, display name, bio, and link domain. Do not invent emails.',
    'A creator who follows an in-niche seed and has an empty bio can sit around 0.5.',
    'Someone whose bio is only beauty, sport, crypto, food, or gaming should be under 0.4.',
    JSON.stringify({ creators: people }),
  ].join('\n');
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Niche scoring timed out.')), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ScoreNicheOptions {
  categories: readonly (CategoryId | string)[];
  keywords: readonly string[];
  cache?: Map<string, NicheScore>;
  platform?: string;
  /** Injected for tests. When omitted, Groq is called. */
  chat?: (user: string) => Promise<string>;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Score a follower-range batch. Cached handles are not sent again.
 * A Groq failure falls back to the keyword score for that batch.
 */
export async function scoreNicheBatch(
  rows: readonly NicheScoreInput[],
  options: ScoreNicheOptions,
): Promise<Map<string, NicheScore>> {
  const platform = options.platform ?? 'tiktok';
  const categories = options.categories.map((id) => String(id));
  const cache = options.cache ?? new Map<string, NicheScore>();
  const result = new Map<string, NicheScore>();
  const pending: NicheScoreInput[] = [];
  for (const row of rows) {
    const handle = row.handle.replace(/^@/, '').trim();
    if (!handle) continue;
    const key = nicheScoreKey(platform, handle, categories);
    const cached = cache.get(key);
    if (cached) {
      result.set(handle.toLowerCase(), cached);
      continue;
    }
    pending.push({ ...row, handle });
  }

  const chat = options.chat;
  for (let index = 0; index < pending.length; index += BATCH_SIZE) {
    const batch = pending.slice(index, index + BATCH_SIZE);
    let scored = new Map<string, NicheScore>();
    if (chat || process.env.GROQ_API_KEY?.trim()) {
      for (let attempt = 0; attempt < 2 && scored.size === 0; attempt += 1) {
        try {
          const content = chat
            ? await withTimeout(chat(promptFor(batch, categories)), SCORE_TIMEOUT_MS)
            : (
                await withTimeout(
                  chatJson({
                    system: 'You score creator niche fit. Reply with JSON only.',
                    user: promptFor(batch, categories),
                    temperature: 0,
                      model: options.model ?? (process.env.LLM_HOOK_MODEL?.trim() || 'openai/gpt-oss-20b'),
                    maxTokens: 1200,
                    fetchImpl: options.fetchImpl,
                  }),
                  SCORE_TIMEOUT_MS,
                )
              ).content;
          scored = parseScores(content, batch.map((row) => row.handle));
        } catch (err) {
          if (attempt === 1) {
            console.warn(
              '[discovery] niche scoring fell back to keywords:',
              err instanceof Error ? err.message : err,
            );
          }
          scored = new Map();
        }
      }
    }
    for (const row of batch) {
      const key = row.handle.toLowerCase();
      const score = scored.get(key) ?? keywordNicheScore(row, options.keywords);
      result.set(key, score);
      cache.set(nicheScoreKey(platform, row.handle, categories), score);
    }
  }
  return result;
}
