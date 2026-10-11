import { fetchBioLinkEmails, isJunkEmail } from './bioLinkEmail.js';
import { enrichCreatorEmail, hasUsablePublicEmail } from './email.js';
import {
  keywordNicheScore,
  scoreNicheBatch,
  type NicheScore,
  type NicheScoreInput,
} from './nicheScore.js';
import type { CreatorCandidate } from './types.js';

/** A missing engagement rate is unknown, not zero. Following lists have no video stats. */
export function passesEngagementMinimum(
  rate: number | null | undefined,
  min: number | null | undefined,
): boolean {
  if (min == null || !Number.isFinite(Number(min))) return true;
  if (rate == null || !Number.isFinite(Number(rate))) return true;
  return Number(rate) >= Number(min);
}

/** Keep the richer profile when the same handle appears on two seeds. Never drop an email. */
export function mergeCandidate(prev: CreatorCandidate, next: CreatorCandidate): CreatorCandidate {
  const preferNext = (next.follower_count ?? 0) > (prev.follower_count ?? 0);
  const base = preferNext ? { ...next } : { ...prev };
  const other = preferNext ? prev : next;
  const baseEmail = hasUsablePublicEmail(base.email) ? base.email : null;
  const otherEmail = hasUsablePublicEmail(other.email) ? other.email : null;
  const email = baseEmail ?? otherEmail;
  const bio = (base.bio ?? '').trim().length >= (other.bio ?? '').trim().length ? base.bio : other.bio;
  const bioLink = base.bio_link || other.bio_link || null;
  const emailSource = baseEmail ? base.email_source : otherEmail ? other.email_source : base.email_source;
  const emailUrl = baseEmail ? base.email_source_url : otherEmail ? other.email_source_url : base.email_source_url;
  return {
    ...base,
    email: email ?? null,
    bio: bio ?? '',
    bio_link: bioLink,
    ...(emailSource ? { email_source: emailSource } : {}),
    ...(emailUrl ? { email_source_url: emailUrl } : {}),
    display_name: base.display_name || other.display_name || null,
    avatar_url: base.avatar_url || other.avatar_url || null,
    discovery_seed: base.discovery_seed || other.discovery_seed || null,
  };
}

export function dedupeCandidates(rows: readonly CreatorCandidate[]): CreatorCandidate[] {
  const map = new Map<string, CreatorCandidate>();
  for (const row of rows) {
    const handle = row.handle?.replace(/^@/, '').trim();
    if (!handle) continue;
    const key = `${row.platform}:${handle.toLowerCase()}`;
    const prev = map.get(key);
    map.set(key, prev ? mergeCandidate(prev, { ...row, handle }) : { ...row, handle });
  }
  return [...map.values()];
}

function restoreBioEmail(row: CreatorCandidate): CreatorCandidate {
  const email = enrichCreatorEmail({
    bio: [row.bio, row.bio_link].filter(Boolean).join('\n'),
    handle: row.handle,
    existingEmail: row.email,
  });
  if (!email) return { ...row, email: null };
  if (email === row.email && row.email_source) return { ...row, email };
  return {
    ...row,
    email,
    email_source: row.email_source ?? 'bio',
  };
}

export interface QualifyResult {
  unique: CreatorCandidate[];
  inRange: CreatorCandidate[];
  kept: CreatorCandidate[];
  afterBioExtract: number;
  bioLinksChecked: number;
  emailsFromBioLinks: number;
  nicheRelevant: number;
  nicheReview: number;
  nicheDropped: number;
  nicheSource: 'ai' | 'keywords';
  withEmail: number;
}

export async function qualifyCandidates(
  rows: readonly CreatorCandidate[],
  input: {
    followerMin: number | null;
    followerMax: number | null;
    engagementMin?: number | null;
    keywords: readonly string[];
    categories: readonly string[];
    cache?: Map<string, NicheScore>;
    chat?: (user: string) => Promise<string>;
    fetchImpl?: typeof fetch;
    /** Skip the network fetch. Tests pass a resolved map. */
    bioLinkLookup?: (urls: readonly string[]) => Promise<Map<string, { email: string; url: string }>>;
    /** Live stage line. Fired before niche scoring and before bio-link checks. */
    onStage?: (label: string) => void | Promise<void>;
  },
): Promise<QualifyResult> {
  const unique = dedupeCandidates(rows).map(restoreBioEmail);
  const inRange = unique.filter((row) => {
    const fans = row.follower_count ?? 0;
    if (input.followerMin != null && fans < input.followerMin) return false;
    if (input.followerMax != null && fans > input.followerMax) return false;
    return passesEngagementMinimum(row.engagement_rate, input.engagementMin);
  });
  const afterBioExtract = inRange.filter(
    (row) => hasUsablePublicEmail(row.email) && row.email_source !== 'bio_link',
  ).length;

  const scoreInputs: NicheScoreInput[] = inRange.map((row) => ({
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    bioLinkDomain: row.bio_link ? row.bio_link.replace(/^https?:\/\//, '').split('/')[0] : null,
    followerCount: row.follower_count,
    seedInNiche: row.discovery_source === 'network' && Boolean(row.discovery_seed),
    campaignSourced: row.discovery_source !== 'network',
  }));
  if (inRange.length > 0) await input.onStage?.('Scoring niche fit with AI…');
  const scores = await scoreNicheBatch(scoreInputs, {
    categories: input.categories,
    keywords: input.keywords,
    cache: input.cache,
    chat: input.chat,
    fetchImpl: input.fetchImpl,
    platform: inRange[0]?.platform,
  });
  const nicheSource = [...scores.values()].some((score) => score.source === 'ai') ? 'ai' : 'keywords';
  let nicheRelevant = 0;
  let nicheReview = 0;
  let nicheDropped = 0;
  const scored: CreatorCandidate[] = [];
  for (const row of inRange) {
    const seedInNiche = row.discovery_source === 'network' && Boolean(row.discovery_seed);
    const score = scores.get(row.handle.toLowerCase()) ?? keywordNicheScore(
      {
        handle: row.handle,
        bio: row.bio,
        displayName: row.display_name,
        seedInNiche,
        campaignSourced: row.discovery_source !== 'network',
      },
      input.keywords,
    );
    const next: CreatorCandidate = {
      ...row,
      niche_score: score.score,
      niche_reason: score.reason,
      niche_band: score.band,
    };
    if (score.band === 'drop') {
      nicheDropped += 1;
      continue;
    }
    if (score.band === 'review') nicheReview += 1;
    else nicheRelevant += 1;
    scored.push(next);
  }

  const needLink = scored.filter(
    (row) => !hasUsablePublicEmail(row.email) && row.bio_link && /^https?:\/\//i.test(row.bio_link),
  );
  const lookup =
    input.bioLinkLookup ??
    ((urls: readonly string[]) => fetchBioLinkEmails(urls, { fetchImpl: input.fetchImpl }));
  if (needLink.length > 0) await input.onStage?.('Checking bio links for emails…');
  const links = needLink.length > 0 ? await lookup(needLink.map((row) => row.bio_link as string)) : new Map();
  let emailsFromBioLinks = 0;
  const kept = scored.map((row) => {
    if (hasUsablePublicEmail(row.email) || !row.bio_link) return row;
    const hit = links.get(row.bio_link);
    if (!hit || isJunkEmail(hit.email)) return row;
    emailsFromBioLinks += 1;
    return {
      ...row,
      email: hit.email,
      email_source: 'bio_link' as const,
      email_source_url: hit.url,
    };
  });
  return {
    unique,
    inRange,
    kept,
    afterBioExtract,
    bioLinksChecked: needLink.length,
    emailsFromBioLinks,
    nicheRelevant,
    nicheReview,
    nicheDropped,
    nicheSource: scores.size === 0 ? 'keywords' : nicheSource,
    withEmail: kept.filter((row) => hasUsablePublicEmail(row.email)).length,
  };
}
