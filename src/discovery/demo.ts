import type { Platform } from '../types.js';
import { extractEmailFromBio } from './email.js';
import type { Campaign, CreatorCandidate } from './types.js';

/** Deterministic seed pool for offline E2E / demo discovery. */
const DEMO_POOL: Array<{
  handle: string;
  platform: Platform;
  niche: string;
  bio: string;
  follower_count: number;
  engagement_rate: number;
  hasEmailInBio: boolean;
}> = [
  { handle: 'fitwithamy', platform: 'tiktok', niche: 'fitness', bio: 'HIIT coach · collabs: amy@fitwithamy.demo', follower_count: 85000, engagement_rate: 4.2, hasEmailInBio: true },
  { handle: 'liftlegends', platform: 'instagram', niche: 'fitness', bio: 'Powerlifting tips daily', follower_count: 120000, engagement_rate: 3.1, hasEmailInBio: false },
  { handle: 'yogawithkai', platform: 'tiktok', niche: 'fitness', bio: 'Morning flows · business: kai@yogawithkai.demo', follower_count: 45000, engagement_rate: 5.5, hasEmailInBio: true },
  { handle: 'runclubuk', platform: 'instagram', niche: 'fitness', bio: 'London 5K crew', follower_count: 22000, engagement_rate: 2.8, hasEmailInBio: false },
  { handle: 'proteinprep', platform: 'tiktok', niche: 'fitness', bio: 'Meal prep macros · hello@proteinprep.demo', follower_count: 210000, engagement_rate: 3.8, hasEmailInBio: true },
  { handle: 'glowbyjess', platform: 'instagram', niche: 'beauty', bio: 'Skincare reviews · jess@glowbyjess.demo', follower_count: 95000, engagement_rate: 4.0, hasEmailInBio: true },
  { handle: 'makeupmaven', platform: 'tiktok', niche: 'beauty', bio: 'GRWM & drugstore finds', follower_count: 310000, engagement_rate: 2.5, hasEmailInBio: false },
  { handle: 'cleanbeautyuk', platform: 'instagram', niche: 'beauty', bio: 'Clean formulas only · press@cleanbeautyuk.demo', follower_count: 67000, engagement_rate: 3.6, hasEmailInBio: true },
  { handle: 'nailartnova', platform: 'tiktok', niche: 'beauty', bio: 'Gel tips & trends', follower_count: 18000, engagement_rate: 6.1, hasEmailInBio: false },
  { handle: 'haircarehugo', platform: 'instagram', niche: 'beauty', bio: 'Curly care · hugo@haircarehugo.demo', follower_count: 54000, engagement_rate: 3.3, hasEmailInBio: true },
  { handle: 'gadgetguru', platform: 'tiktok', niche: 'tech', bio: 'Unboxings weekly · biz@gadgetguru.demo', follower_count: 440000, engagement_rate: 2.2, hasEmailInBio: true },
  { handle: 'codewithcleo', platform: 'instagram', niche: 'tech', bio: 'Dev tips for beginners', follower_count: 78000, engagement_rate: 4.7, hasEmailInBio: false },
  { handle: 'aiexplains', platform: 'tiktok', niche: 'tech', bio: 'AI in plain English · hello@aiexplains.demo', follower_count: 156000, engagement_rate: 3.9, hasEmailInBio: true },
  { handle: 'setupstudio', platform: 'instagram', niche: 'tech', bio: 'Desk setups & peripherals', follower_count: 91000, engagement_rate: 2.9, hasEmailInBio: false },
  { handle: 'appscout', platform: 'tiktok', niche: 'tech', bio: 'App reviews · scout@appscout.demo', follower_count: 33000, engagement_rate: 5.0, hasEmailInBio: true },
  { handle: 'traveltoni', platform: 'tiktok', niche: 'travel', bio: 'Budget Europe · toni@traveltoni.demo', follower_count: 200000, engagement_rate: 3.4, hasEmailInBio: true },
  { handle: 'foodiefran', platform: 'instagram', niche: 'food', bio: 'London eats · fran@foodiefran.demo', follower_count: 112000, engagement_rate: 4.1, hasEmailInBio: true },
  { handle: 'fashionfinn', platform: 'tiktok', niche: 'fashion', bio: 'Street style thrift', follower_count: 275000, engagement_rate: 2.7, hasEmailInBio: false },
  { handle: 'parentingpat', platform: 'instagram', niche: 'parenting', bio: 'Toddler tips · pat@parentingpat.demo', follower_count: 48000, engagement_rate: 3.5, hasEmailInBio: true },
  { handle: 'gamergwen', platform: 'tiktok', niche: 'gaming', bio: 'Indie game highlights · gwen@gamergwen.demo', follower_count: 189000, engagement_rate: 4.4, hasEmailInBio: true },
  { handle: 'fitfuelzoe', platform: 'instagram', niche: 'fitness', bio: 'Supplements & lifts · zoe@fitfuelzoe.demo', follower_count: 72000, engagement_rate: 3.0, hasEmailInBio: true },
  { handle: 'beautylabrio', platform: 'tiktok', niche: 'beauty', bio: 'Lab-tested skincare', follower_count: 41000, engagement_rate: 4.8, hasEmailInBio: false },
  { handle: 'techtinker', platform: 'instagram', niche: 'tech', bio: 'DIY electronics · tink@techtinker.demo', follower_count: 29000, engagement_rate: 5.2, hasEmailInBio: true },
  { handle: 'cardiochris', platform: 'tiktok', niche: 'fitness', bio: 'Zone 2 evangelist', follower_count: 61000, engagement_rate: 3.7, hasEmailInBio: false },
  { handle: 'lipglosslex', platform: 'instagram', niche: 'beauty', bio: 'Lip products only · lex@lipglosslex.demo', follower_count: 135000, engagement_rate: 3.2, hasEmailInBio: true },
];

function profileUrl(platform: Platform, handle: string): string {
  return platform === 'tiktok'
    ? `https://www.tiktok.com/@${handle}`
    : `https://www.instagram.com/${handle}/`;
}

/**
 * Deterministic demo discovery: filters the fixed pool by niche, platform,
 * follower range, optional engagement floor, then caps at result_limit.
 */
export function discoverDemo(campaign: Campaign): CreatorCandidate[] {
  const niches = (campaign.niches ?? []).map((n) => n.toLowerCase().trim()).filter(Boolean);
  const platforms = (campaign.platforms ?? []).map((p) => p.toLowerCase().trim());
  const allowBoth = platforms.length === 0 || platforms.includes('both');
  const allowedPlatforms = new Set(
    allowBoth ? (['tiktok', 'instagram'] as Platform[]) : (platforms as Platform[]),
  );

  const minF = campaign.follower_min ?? 0;
  const maxF = campaign.follower_max ?? Number.MAX_SAFE_INTEGER;
  const minEng = campaign.engagement_rate_min ?? null;
  const limit = campaign.result_limit ?? 20;

  const matched: CreatorCandidate[] = [];

  for (const row of DEMO_POOL) {
    if (!allowedPlatforms.has(row.platform)) continue;
    if (niches.length > 0 && !niches.includes(row.niche)) continue;
    if (row.follower_count < minF || row.follower_count > maxF) continue;
    if (minEng != null && row.engagement_rate < Number(minEng)) continue;

    const email = extractEmailFromBio(row.bio);
    matched.push({
      handle: row.handle,
      platform: row.platform,
      bio: row.bio,
      email,
      follower_count: row.follower_count,
      engagement_rate: row.engagement_rate,
      avatar_url: null,
      top_videos: [],
      profile_url: profileUrl(row.platform, row.handle),
      niches: [row.niche],
      raw: { provider: 'demo', niche: row.niche },
    });

    if (matched.length >= limit) break;
  }

  return matched;
}
