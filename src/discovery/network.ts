import {
  NETWORK_FOLLOWING_PER_PROFILE,
  planNetworkBatch,
  type NetworkBatchPlan,
} from './budget.js';
import {
  activeCategoryIds,
  categoriesForCounts,
  categoryKeywordMap,
  categoryTerms,
  type CategoryId,
} from './categories.js';
import { extractEmailFromBio, hasUsablePublicEmail } from './email.js';
import { normaliseHashtag } from './hashtags.js';
import type { CreatorCandidate } from './types.js';

/** clockworks/tiktok-followers-scraper. Override with APIFY_FOLLOWERS_ACTOR. */
export const FOLLOWERS_ACTOR_DEFAULT = 'clockworks/tiktok-followers-scraper';

/** Following accounts requested from each seed when the budget allows a deep read. */
export const FOLLOWING_PER_PROFILE = NETWORK_FOLLOWING_PER_PROFILE;

/** Re-check a hidden following list after this many days, and not before. */
export const HIDDEN_RECHECK_DAYS = 60;

/**
 * Only about half of seeds expose a following list.
 * Ask for twice the productive seeds so the run still returns lists.
 */
export const SEED_OVERPROVISION = 2;

/** Mid-size creators. Tiny accounts and celebrities are poor seeds. */
export const SEED_FOLLOWER_MIN = 5_000;
export const SEED_FOLLOWER_MAX = 150_000;

/** Do not reuse a seed until this many days have passed. */
export const SEED_COOLDOWN_DAYS = 14;

const PRODUCTIVE_MIN = 2;
const PRODUCTIVE_MAX = 7;

/**
 * Book-niche words, used when the campaign does not already name them.
 * Short words are matched on a word boundary so "lit" does not hit "politics"
 * and "read" does not hit "spread".
 */
export const BOOK_RELEVANCE_TERMS = [
  'book',
  'read',
  'booktok',
  'bookish',
  'lit',
  'novel',
  'reader',
  'author',
  'reading',
  'books',
] as const;

const STOP_TERMS = new Set([
  'the',
  'and',
  'for',
  'with',
  'tips',
  'creator',
  'content',
  'tok',
  'app',
  'from',
  'your',
  'this',
  'that',
  'video',
  'videos',
  'official',
]);

export interface SeedCreator {
  handle: string;
  platform: string;
  follower_count: number | null;
  bio: string | null;
  display_name?: string | null;
  niches?: string[] | null;
  /** Found earlier by a following-list run. Kept as a seed even when the bio is thin. */
  networkDiscovered?: boolean;
  lastResultCount?: number | null;
  qualifyingCount?: number | null;
}

/** How many lists we hope come back, before the 2× hidden-list allowance. */
export function productiveSeedTarget(resultTarget: number): number {
  const target = Math.max(1, Math.round(resultTarget) || 1);
  return Math.min(PRODUCTIVE_MAX, Math.max(PRODUCTIVE_MIN, Math.ceil(target / 4)));
}

/** Seeds to send. Twice the productive target, because many lists are hidden. */
export function requestedSeedCount(resultTarget: number): number {
  return productiveSeedTarget(resultTarget) * SEED_OVERPROVISION;
}

export type DiscoverySource = 'network' | 'hashtags' | 'both';

export function asDiscoverySource(value: unknown): DiscoverySource | null {
  return value === 'network' || value === 'hashtags' || value === 'both' ? value : null;
}

/** Keywords from the active categories, plus the niche and hashtag tokens. */
export function relevanceKeywords(
  niche: string,
  hashtags: readonly string[] = [],
  context?: { appName?: string | null; valueProp?: string | null },
): string[] {
  const categories = activeCategoryIds({
    appName: context?.appName,
    valueProp: context?.valueProp,
    niches: niche ? [niche] : [],
    hashtags,
  });
  const out: string[] = [];
  const push = (raw: string) => {
    const token = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (token.length < 3 || STOP_TERMS.has(token) || out.includes(token)) return;
    out.push(token);
  };
  const pushPhrase = (raw: string) => {
    const phrase = raw.toLowerCase().trim();
    if (!phrase || out.includes(phrase)) return;
    if (phrase.includes(' ') || phrase.includes('-')) {
      out.push(phrase);
      return;
    }
    push(phrase);
  };
  for (const id of categories) {
    for (const term of categoryTerms(id)) pushPhrase(term);
  }
  for (const part of niche.split(/[^a-z0-9]+/i)) push(part);
  for (const tag of hashtags) push(normaliseHashtag(tag).replace(/^#/, ''));
  return out;
}

export function relevanceCategoryIds(
  niche: string,
  hashtags: readonly string[] = [],
  context?: { appName?: string | null; valueProp?: string | null },
): CategoryId[] {
  return activeCategoryIds({
    appName: context?.appName,
    valueProp: context?.valueProp,
    niches: niche ? [niche] : [],
    hashtags,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when bio or nickname mentions one of the niche keywords. */
export function matchesRelevance(text: string, keywords: readonly string[]): boolean {
  const hay = text.toLowerCase();
  if (!hay.trim() || keywords.length === 0) return false;
  return keywords.some((keyword) => {
    const compact = keyword.toLowerCase().replace(/[^a-z0-9]/g, '');
    const compactHay = hay.replace(/[^a-z0-9]/g, '');
    if (keyword.includes(' ') || keyword.includes('-')) {
      return hay.includes(keyword) || (compact.length >= 3 && compactHay.includes(compact));
    }
    if (compact.length <= 4) {
      return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(compact)}(?:[^a-z0-9]|$)`, 'i').test(hay);
    }
    return hay.includes(compact) || compactHay.includes(compact);
  });
}

export function creatorRelevanceText(input: {
  bio?: string | null;
  nickname?: string | null;
  niches?: readonly string[] | null;
}): string {
  return [input.bio, input.nickname, ...(input.niches ?? [])].filter(Boolean).join('\n');
}

export function isRelevantCreator(
  input: { bio?: string | null; nickname?: string | null; niches?: readonly string[] | null },
  keywords: readonly string[],
): boolean {
  return matchesRelevance(creatorRelevanceText(input), keywords);
}

const SEED_COOLDOWN_MS = SEED_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const HIDDEN_RECHECK_MS = HIDDEN_RECHECK_DAYS * 24 * 60 * 60 * 1000;

function rangeDistance(fans: number, min: number | null | undefined, max: number | null | undefined): number | null {
  if (min == null && max == null) return null;
  const low = min ?? max ?? fans;
  const high = max ?? min ?? fans;
  const mid = (low + high) / 2;
  return Math.abs(fans - mid);
}

/**
 * CRM creators for this app who can seed a following-list run.
 * Mid-size, relevant (or previously found via the network), not used in 14 days,
 * and not hidden inside the 60-day re-check. Higher past yield comes first,
 * then follower count closest to the campaign range.
 */
export function rankNetworkSeeds(input: {
  creators: readonly SeedCreator[];
  usedAt?: ReadonlyMap<string, number>;
  /** When the following list was found to be hidden. Skipped for 60 days. */
  hiddenAt?: ReadonlyMap<string, number>;
  now?: number;
  keywords: readonly string[];
  followerMin?: number | null;
  followerMax?: number | null;
  limit: number;
}): string[] {
  const now = input.now ?? Date.now();
  const usedAt = input.usedAt ?? new Map<string, number>();
  const hiddenAt = input.hiddenAt ?? new Map<string, number>();
  const limit = Math.max(0, Math.floor(input.limit) || 0);
  const ranked = input.creators
    .filter((creator) => {
      const handle = creator.handle.replace(/^@/, '').trim();
      if (!handle || creator.platform.trim().toLowerCase() !== 'tiktok') return false;
      const fans = Number(creator.follower_count);
      if (!Number.isFinite(fans) || fans < SEED_FOLLOWER_MIN || fans > SEED_FOLLOWER_MAX) return false;
      const relevant = isRelevantCreator(
        { bio: creator.bio, nickname: creator.display_name, niches: creator.niches },
        input.keywords,
      );
      if (!relevant && !creator.networkDiscovered) return false;
      const key = handle.toLowerCase();
      const used = usedAt.get(key);
      if (used != null && now - used < SEED_COOLDOWN_MS) return false;
      const hidden = hiddenAt.get(key);
      if (hidden != null && now - hidden < HIDDEN_RECHECK_MS) return false;
      return true;
    })
    .sort((a, b) => {
      const qualify = (Number(b.qualifyingCount) || 0) - (Number(a.qualifyingCount) || 0);
      if (qualify !== 0) return qualify;
      const rows = (Number(b.lastResultCount) || 0) - (Number(a.lastResultCount) || 0);
      if (rows !== 0) return rows;
      const left = rangeDistance(Number(a.follower_count) || 0, input.followerMin, input.followerMax);
      const right = rangeDistance(Number(b.follower_count) || 0, input.followerMin, input.followerMax);
      if (left != null && right != null && left !== right) return left - right;
      return (Number(b.follower_count) || 0) - (Number(a.follower_count) || 0);
    });
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const creator of ranked) {
    const handle = creator.handle.replace(/^@/, '').trim();
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
    if (handles.length >= limit) break;
  }
  return handles;
}

export interface NetworkFunnelStats {
  seedsRequested: number;
  seedsReturned: number;
  seedsHidden: number;
  /** Handles sent to the actor. */
  seeds: string[];
  hiddenSeeds: string[];
  rows: number;
  inRange: number;
  withEmail: number;
  relevant: number;
  existing: number;
  fresh: number;
  /** Relevant creators in each active category. A creator can count in more than one. */
  categoryCounts?: Record<string, number>;
  /** Per seed, so hidden lists and yield can be stored. */
  seedResults?: SeedResult[];
  /** Set when the actor did not run, or rejected the cost cap. */
  note?: string;
}

export interface SeedResult {
  handle: string;
  rows: number;
  qualifying: number;
  hidden: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(...vals: unknown[]): string {
  for (const value of vals) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function asNumber(...vals: unknown[]): number {
  for (const value of vals) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value.replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function bioLinkText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const record = asRecord(value);
  if (!record) return '';
  return asString(record.link, record.url, record.href);
}

export interface MappedFollowing {
  candidate: CreatorCandidate;
  seed: string;
  privateAccount: boolean;
}

/**
 * One followers-scraper row → the same creator shape as a hashtag hit.
 * These rows have no video, so top_videos stays empty.
 * Returns null when the row is not a following connection or has no handle.
 */
export function mapFollowingRow(item: unknown): MappedFollowing | null {
  const row = asRecord(item);
  if (!row) return null;
  const connection = asString(row.connectionType, row.connection_type).toLowerCase();
  if (connection && connection !== 'following') return null;

  const author =
    asRecord(row.authorMeta) ??
    asRecord(row.author_meta) ??
    asRecord(row.author) ??
    {};
  const handle = asString(author.name, author.uniqueId, row.uniqueId, row.name).replace(/^@/, '');
  if (!handle) return null;

  const nickname = asString(author.nickName, author.nickname, row.nickName);
  const display_name =
    nickname && nickname.replace(/^@/, '').toLowerCase() !== handle.toLowerCase() ? nickname : null;
  const connected = asRecord(row.connectedTo) ?? asRecord(row.connected_to) ?? {};
  const seed = asString(connected.name, connected.uniqueId, row.seed, row.seedHandle).replace(/^@/, '');
  const bio = asString(author.signature, author.bio, row.signature, row.bio);
  const link = bioLinkText(
    author.bioLink ?? row.bioLink ?? author.bio_link ?? row.bio_link,
  );
  const fromBio = extractEmailFromBio([bio, link].filter(Boolean).join('\n'));
  const fromField = asString(author.email, row.email, row.businessEmail).toLowerCase();
  const email = fromBio || fromField || null;
  const privateAccount = author.privateAccount === true || row.privateAccount === true;
  const avatar =
    asString(
      author.avatarLarger,
      author.avatarMedium,
      author.avatar,
      author.originalAvatarUrl,
    ) || null;

  return {
    seed,
    privateAccount,
    candidate: {
      handle,
      platform: 'tiktok',
      bio,
      display_name,
      email: email || null,
      ...(email ? { email_source: 'bio' as const } : {}),
      ...(link ? { bio_link: link } : {}),
      follower_count: asNumber(author.fans, author.followerCount, row.fans, row.followers),
      engagement_rate: null,
      profile_url: `https://www.tiktok.com/@${handle}`,
      avatar_url: avatar,
      top_videos: [],
      niches: [],
      discovery_source: 'network',
      discovery_seed: seed || null,
      raw: {
        discoverySource: 'network',
        seedHandle: seed,
        connectionType: connection || 'following',
        privateAccount,
      },
    },
  };
}

function inWindow(fans: number, min: number | null, max: number | null): boolean {
  if (min != null && fans < min) return false;
  if (max != null && fans > max) return false;
  return true;
}

/**
 * Drop private accounts, out-of-range follower counts, irrelevant bios,
 * and (when required) rows with no usable email. Dedupe inside the batch
 * and against the CRM.
 */
export function filterNetworkBatch(input: {
  rows: readonly unknown[];
  seeds: readonly string[];
  followerMin: number | null;
  followerMax: number | null;
  requireEmail: boolean;
  keywords: readonly string[];
  knownKeys?: ReadonlySet<string>;
  niches?: readonly string[];
  /** Active categories, used to count who matched each one. */
  categories?: readonly CategoryId[];
  /**
   * Also return every in-range profile, before the keyword and email cuts.
   * Niche scoring and bio-link checks run on that wider set.
   */
  includeInRange?: boolean;
}): {
  creators: CreatorCandidate[];
  existing: CreatorCandidate[];
  /** In-range profiles, including ones the keyword pre-signal would drop. */
  inRangeCreators?: CreatorCandidate[];
  stats: NetworkFunnelStats;
} {
  const seeds = input.seeds.map((seed) => seed.replace(/^@/, '').trim()).filter(Boolean);
  const seedKeys = new Set(seeds.map((seed) => seed.toLowerCase()));
  const returned = new Set<string>();
  const known = input.knownKeys ?? new Set<string>();
  const niches = [...(input.niches ?? [])];
  const rowsBySeed = new Map<string, number>();

  const byHandle = new Map<string, CreatorCandidate>();
  for (const item of input.rows) {
    const mapped = mapFollowingRow(item);
    if (!mapped || mapped.privateAccount) continue;
    const handleKey = mapped.candidate.handle.toLowerCase();
    if (seedKeys.has(handleKey)) continue;
    if (mapped.seed) {
      const seedKey = mapped.seed.toLowerCase();
      if (seedKeys.size === 0 || seedKeys.has(seedKey)) {
        returned.add(seedKey);
        rowsBySeed.set(seedKey, (rowsBySeed.get(seedKey) ?? 0) + 1);
      }
    }
    const prev = byHandle.get(handleKey);
    const mappedEmail = hasUsablePublicEmail(mapped.candidate.email) ? mapped.candidate.email : null;
    const prevEmail = prev && hasUsablePublicEmail(prev.email) ? prev.email : null;
    if (!prev || mapped.candidate.follower_count >= prev.follower_count) {
      byHandle.set(handleKey, {
        ...mapped.candidate,
        niches: mapped.candidate.niches.length > 0 ? mapped.candidate.niches : niches,
        email: mappedEmail ?? prevEmail,
        email_source: mappedEmail ? mapped.candidate.email_source : prev?.email_source,
        bio: (mapped.candidate.bio || '').trim() ? mapped.candidate.bio : (prev?.bio ?? ''),
        bio_link: mapped.candidate.bio_link || prev?.bio_link || null,
      });
    } else if (mappedEmail && !prevEmail) {
      byHandle.set(handleKey, {
        ...prev,
        email: mappedEmail,
        email_source: 'bio',
        bio: prev.bio || mapped.candidate.bio,
        bio_link: prev.bio_link || mapped.candidate.bio_link || null,
      });
    }
  }

  const deduped = [...byHandle.values()];
  const ranged = deduped.filter((row) =>
    inWindow(row.follower_count, input.followerMin, input.followerMax),
  );
  const withEmail = ranged.filter((row) => hasUsablePublicEmail(row.email));
  const emailPool = input.requireEmail ? withEmail : ranged;
  const relevant = emailPool.filter((row) =>
    isRelevantCreator({ bio: row.bio, nickname: row.display_name }, input.keywords),
  );
  const categories = input.categories ?? [];
  const categoryCounts: Record<string, number> = {};
  if (categories.length > 0) {
    for (const id of categories) categoryCounts[id] = 0;
    for (const row of relevant) {
      const text = creatorRelevanceText({ bio: row.bio, nickname: row.display_name });
      for (const id of categoriesForCounts(text, categories, matchesRelevance)) {
        categoryCounts[id] = (categoryCounts[id] ?? 0) + 1;
      }
    }
  }
  const qualifyingBySeed = new Map<string, number>();
  for (const row of relevant) {
    const seedKey = (row.discovery_seed ?? '').toLowerCase();
    if (!seedKey) continue;
    qualifyingBySeed.set(seedKey, (qualifyingBySeed.get(seedKey) ?? 0) + 1);
  }

  const creators: CreatorCandidate[] = [];
  const existing: CreatorCandidate[] = [];
  const seen = new Set<string>();
  for (const row of relevant) {
    const key = `tiktok:${row.handle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (known.has(key)) existing.push({ ...row, alreadyInCrm: true });
    else creators.push(row);
  }

  const hiddenSeeds = seeds.filter((seed) => !returned.has(seed.toLowerCase()));
  const seedResults: SeedResult[] = seeds.map((seed) => {
    const key = seed.toLowerCase();
    const rows = rowsBySeed.get(key) ?? 0;
    return {
      handle: seed,
      rows,
      qualifying: qualifyingBySeed.get(key) ?? 0,
      hidden: rows === 0,
    };
  });
  return {
    creators,
    existing,
    ...(input.includeInRange ? { inRangeCreators: ranged } : {}),
    stats: {
      seedsRequested: seeds.length,
      seedsReturned: returned.size,
      seedsHidden: hiddenSeeds.length,
      seeds,
      hiddenSeeds,
      rows: input.rows.length,
      inRange: ranged.length,
      withEmail: withEmail.length,
      relevant: relevant.length,
      existing: existing.length,
      fresh: creators.length,
      ...(categories.length > 0 ? { categoryCounts } : {}),
      seedResults,
    },
  };
}

export function emptyNetworkStats(note: string, seeds: readonly string[] = []): NetworkFunnelStats {
  return {
    seedsRequested: seeds.length,
    seedsReturned: 0,
    seedsHidden: seeds.length,
    seeds: [...seeds],
    hiddenSeeds: [...seeds],
    rows: 0,
    inRange: 0,
    withEmail: 0,
    relevant: 0,
    existing: 0,
    fresh: 0,
    note,
  };
}

export function networkFunnelMessage(stats: NetworkFunnelStats): string {
  if (stats.note && stats.rows === 0) {
    return stats.note.endsWith('.') ? stats.note : `${stats.note}.`;
  }
  const lists = stats.seedsReturned === 1 ? '1 list' : `${stats.seedsReturned} lists`;
  const hidden = stats.seedsHidden === 1 ? '1 hidden' : `${stats.seedsHidden} hidden`;
  const rows = stats.rows === 1 ? '1 row' : `${stats.rows} rows`;
  const fresh = stats.fresh === 1 ? '1 new' : `${stats.fresh} new`;
  const already =
    stats.existing === 1 ? '1 already in the CRM' : `${stats.existing} already in the CRM`;
  const categories = categoryCountClause(stats.categoryCounts);
  const body = `Creator network: ${rows} from ${stats.seedsRequested} seeds (${lists}, ${hidden}) → ${stats.inRange} in range → ${stats.withEmail} with a public email → ${stats.relevant} relevant → ${fresh}. ${already}.${categories}`;
  return stats.note ? `${stats.note.endsWith('.') ? stats.note : `${stats.note}.`} ${body}` : body;
}

function categoryCountClause(counts: Record<string, number> | undefined): string {
  if (!counts) return '';
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `${id} ${count}`);
  if (parts.length === 0) return '';
  return ` Categories: ${parts.join(', ')}.`;
}

/** Actor body for clockworks/tiktok-followers-scraper. networkScrape is stripped before POST. */
export function buildFollowersActorInput(
  seeds: readonly string[],
  maxFollowing = FOLLOWING_PER_PROFILE,
): Record<string, unknown> | null {
  const profiles: string[] = [];
  for (const seed of seeds) {
    const handle = seed.replace(/^@/, '').trim();
    if (!handle || profiles.some((existing) => existing.toLowerCase() === handle.toLowerCase())) continue;
    profiles.push(handle);
  }
  if (profiles.length === 0) return null;
  return {
    profiles,
    maxFollowersPerProfile: 0,
    maxFollowingPerProfile: Math.max(1, Math.round(maxFollowing) || FOLLOWING_PER_PROFILE),
    networkScrape: true,
  };
}

export function asNetworkFunnelStats(value: unknown): NetworkFunnelStats | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const seeds = Array.isArray(row.seeds)
    ? row.seeds.map((seed) => String(seed).replace(/^@/, '').trim()).filter(Boolean)
    : [];
  const hiddenSeeds = Array.isArray(row.hiddenSeeds)
    ? row.hiddenSeeds.map((seed) => String(seed).replace(/^@/, '').trim()).filter(Boolean)
    : [];
  const count = (key: string) => {
    const n = Number(row[key]);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  if (row.rows == null && row.seedsRequested == null && !row.note) return undefined;
  return {
    seedsRequested: count('seedsRequested'),
    seedsReturned: count('seedsReturned'),
    seedsHidden: count('seedsHidden'),
    seeds,
    hiddenSeeds,
    rows: count('rows'),
    inRange: count('inRange'),
    withEmail: count('withEmail'),
    relevant: count('relevant'),
    existing: count('existing'),
    fresh: count('fresh'),
    ...(typeof row.note === 'string' && row.note.trim() ? { note: row.note.trim() } : {}),
    ...(() => {
      const counts = categoryCountsFrom(row.categoryCounts);
      return counts ? { categoryCounts: counts } : {};
    })(),
    ...(() => {
      const seedResults = seedResultsFrom(row.seedResults);
      return seedResults ? { seedResults } : {};
    })(),
  };
}

function categoryCountsFrom(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (!key || !Number.isFinite(n) || n < 0) continue;
    counts[key] = Math.round(n);
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function seedResultsFrom(value: unknown): SeedResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: SeedResult[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const handle = String(row.handle ?? '').replace(/^@/, '').trim();
    if (!handle) continue;
    const count = (key: string) => {
      const n = Number(row[key]);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
    };
    rows.push({
      handle,
      rows: count('rows'),
      qualifying: count('qualifying'),
      hidden: row.hidden === true || count('rows') === 0,
    });
  }
  return rows.length > 0 ? rows : undefined;
}

export function mergeNetworkStats(parts: readonly NetworkFunnelStats[]): NetworkFunnelStats {
  const seeds: string[] = [];
  const hiddenSeeds: string[] = [];
  const seen = new Set<string>();
  const hidden = new Set<string>();
  const categoryCounts: Record<string, number> = {};
  const seedResults: SeedResult[] = [];
  let note = '';
  const totals = {
    seedsRequested: 0,
    seedsReturned: 0,
    rows: 0,
    inRange: 0,
    withEmail: 0,
    relevant: 0,
    existing: 0,
    fresh: 0,
  };
  for (const part of parts) {
    totals.seedsRequested += part.seedsRequested;
    totals.seedsReturned += part.seedsReturned;
    totals.rows += part.rows;
    totals.inRange += part.inRange;
    totals.withEmail += part.withEmail;
    totals.relevant += part.relevant;
    totals.existing += part.existing;
    totals.fresh += part.fresh;
    for (const seed of part.seeds) {
      const key = seed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push(seed);
    }
    for (const seed of part.hiddenSeeds) {
      const key = seed.toLowerCase();
      if (hidden.has(key)) continue;
      hidden.add(key);
      hiddenSeeds.push(seed);
    }
    for (const [id, count] of Object.entries(part.categoryCounts ?? {})) {
      categoryCounts[id] = (categoryCounts[id] ?? 0) + count;
    }
    if (part.seedResults) seedResults.push(...part.seedResults);
    if (part.note) note = part.note;
  }
  return {
    ...totals,
    seedsHidden: hiddenSeeds.length,
    seeds,
    hiddenSeeds,
    ...(Object.keys(categoryCounts).length > 0 ? { categoryCounts } : {}),
    ...(seedResults.length > 0 ? { seedResults } : {}),
    ...(note ? { note } : {}),
  };
}

/** Fresh in-range creators from this run, used once as a second hop. */
export function secondHopSeeds(input: {
  handles: readonly { handle: string; followerCount: number }[];
  used: ReadonlySet<string>;
  hidden: ReadonlySet<string>;
  limit?: number;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of input.handles) {
    const handle = row.handle.replace(/^@/, '').trim();
    const key = handle.toLowerCase();
    if (!handle || seen.has(key) || input.used.has(key) || input.hidden.has(key)) continue;
    const fans = Number(row.followerCount);
    if (!Number.isFinite(fans) || fans < SEED_FOLLOWER_MIN || fans > SEED_FOLLOWER_MAX) continue;
    seen.add(key);
    out.push(handle);
    if (out.length >= (input.limit ?? 60)) break;
  }
  return out;
}

/**
 * The next followers batch, or null when the target is met, the pool is done,
 * or the remaining budget cannot buy a single result. The second hop runs once.
 */
export function planFollowUpNetworkBatch(input: {
  queue: readonly string[];
  hopped: boolean;
  fresh: number;
  goal: number;
  spentUsd: number;
  budgetUsd: number;
  hopCandidates: readonly { handle: string; followerCount: number }[];
  used: ReadonlySet<string>;
  hidden: ReadonlySet<string>;
  yieldBySeed?: ReadonlyMap<string, number>;
}): { batch: NetworkBatchPlan; queueAfter: string[]; hopped: boolean } | null {
  if (input.fresh >= input.goal) return null;
  const remaining = Math.max(0, input.budgetUsd - input.spentUsd);
  let queue = dedupeSeedList(input.queue);
  let hopped = input.hopped;
  if (queue.length === 0 && !hopped) {
    queue = secondHopSeeds({
      handles: input.hopCandidates,
      used: input.used,
      hidden: input.hidden,
    });
    hopped = true;
  }
  if (queue.length === 0) return null;
  const batch = planNetworkBatch({
    seeds: queue,
    budgetUsd: remaining,
    yieldBySeed: input.yieldBySeed,
  });
  if (!batch) return null;
  const taken = new Set(batch.seeds.map((seed) => seed.toLowerCase()));
  return {
    batch,
    queueAfter: queue.filter((seed) => !taken.has(seed.toLowerCase())),
    hopped,
  };
}

function dedupeSeedList(seeds: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const handle = seed.replace(/^@/, '').trim();
    const key = handle.toLowerCase();
    if (!handle || seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

export { categoryKeywordMap };

/** Hashtags this search would send, before the cooldown. */
export function normaliseSeedHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase();
}

export function seedUseKey(handle: string): string {
  return normaliseSeedHandle(handle);
}
