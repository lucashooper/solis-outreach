import { normaliseHashtags } from './hashtags.js';

/** Filters already stored on a campaign or discovery job. */
export interface StoredDiscoverySearch {
  niche: string;
  hashtags: string[];
  platforms: string[];
  followerMin: number | null;
  followerMax: number | null;
  resultLimit: number | null;
  minCreators: number | null;
  requirePublicEmail: boolean;
  includeExisting: boolean;
}

export interface DiscoverFormValues {
  niche: string;
  hashtags: string[];
  platform: 'tiktok' | 'instagram' | 'both';
  followerMin: string;
  followerMax: string;
  resultLimit: string;
  minCreators: string;
  requirePublicEmail: boolean;
  includeExisting: boolean;
}

function asInt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function uniquePlatforms(values: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const platform = String(value).trim().toLowerCase();
    if ((platform === 'tiktok' || platform === 'instagram') && !out.includes(platform)) {
      out.push(platform);
    }
  }
  return out;
}

/**
 * Read the search form from a campaign or discovery job.
 * Follower bounds and the public-email flag fall back to the stored funnel
 * when the row itself left them empty.
 */
export function coerceStoredSearch(input: {
  niche?: string | null;
  niches?: readonly string[] | null;
  hashtags?: readonly string[] | null;
  platforms?: readonly string[] | null;
  followerMin?: unknown;
  followerMax?: unknown;
  resultLimit?: unknown;
  minCreators?: unknown;
  requirePublicEmail?: boolean | null;
  includeExisting?: boolean | null;
  funnel?: {
    followerMin?: number | null;
    followerMax?: number | null;
    requirePublicEmail?: boolean;
  } | null;
}): StoredDiscoverySearch {
  const fromList = (input.niches ?? []).map((niche) => String(niche).trim()).filter(Boolean);
  const niche = fromList.length ? fromList.join(', ') : (input.niche ?? '').trim();
  const resultLimit = asInt(input.resultLimit);
  const minCreators = asInt(input.minCreators);
  const followerMin = asInt(input.followerMin) ?? asInt(input.funnel?.followerMin);
  const followerMax = asInt(input.followerMax) ?? asInt(input.funnel?.followerMax);
  const requirePublicEmail =
    typeof input.requirePublicEmail === 'boolean'
      ? input.requirePublicEmail
      : typeof input.funnel?.requirePublicEmail === 'boolean'
        ? input.funnel.requirePublicEmail
        : true;

  return {
    niche,
    hashtags: normaliseHashtags(input.hashtags ?? []),
    platforms: uniquePlatforms(input.platforms),
    followerMin,
    followerMax,
    resultLimit: resultLimit != null && resultLimit >= 1 ? resultLimit : null,
    minCreators: minCreators != null && minCreators >= 1 ? minCreators : null,
    requirePublicEmail,
    includeExisting: input.includeExisting === true,
  };
}

export function toDiscoverForm(stored: StoredDiscoverySearch): DiscoverFormValues {
  const tiktok = stored.platforms.includes('tiktok');
  const instagram = stored.platforms.includes('instagram');
  let platform: DiscoverFormValues['platform'] = 'tiktok';
  if (tiktok && instagram) platform = 'both';
  else if (instagram) platform = 'instagram';
  return {
    niche: stored.niche,
    hashtags: stored.hashtags,
    platform,
    followerMin: stored.followerMin != null ? String(stored.followerMin) : '',
    followerMax: stored.followerMax != null ? String(stored.followerMax) : '',
    resultLimit: stored.resultLimit != null ? String(stored.resultLimit) : '10',
    minCreators: stored.minCreators != null ? String(stored.minCreators) : '',
    requirePublicEmail: stored.requirePublicEmail,
    includeExisting: stored.includeExisting,
  };
}

function formatCount(value: number): string {
  return value.toLocaleString('en-GB');
}

/** One readable line for the Details disclosure. No raw JSON. */
export function storedSearchSummary(stored: StoredDiscoverySearch): string {
  const keywords = stored.niche.trim() || 'No keywords';
  const tags = stored.hashtags.length ? stored.hashtags.join(' ') : 'No hashtags';
  const platforms = stored.platforms.length
    ? stored.platforms.map((platform) => (platform === 'instagram' ? 'Instagram' : 'TikTok')).join(' and ')
    : 'No platform';
  const followers =
    stored.followerMin == null && stored.followerMax == null
      ? 'Any followers'
      : `${stored.followerMin != null ? formatCount(stored.followerMin) : '0'}–${
          stored.followerMax != null ? formatCount(stored.followerMax) : 'any'
        } followers`;
  const limit = stored.resultLimit != null ? `Limit ${stored.resultLimit}` : 'No result limit';
  const email = stored.requirePublicEmail ? 'Public email required' : 'Public email optional';
  const minimum =
    stored.minCreators != null ? `Minimum ${stored.minCreators} creators` : 'No minimum creators';
  const parts = [keywords, tags, platforms, followers, limit, email, minimum];
  if (stored.includeExisting) parts.push('Includes creators already in the CRM');
  return parts.join(' · ');
}
