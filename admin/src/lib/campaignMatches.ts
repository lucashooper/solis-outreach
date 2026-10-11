import { mergeCampaignCreatorRows } from '../../../src/discovery/campaignBatch.ts';
import { hasUsablePublicEmail } from '../../../src/discovery/email.ts';
import { asDiscoveryFunnel, discoveryResultNote } from '../../../src/discovery/funnel.ts';
import {
  creatorMatchKey,
  discoveryQueryKey,
  readDiscoveryCache,
} from '../../../src/discovery/queryCache.ts';
import type { CreatorCandidate, DiscoveryFunnel } from '../../../src/discovery/types.ts';
import type { Campaign, Creator, DiscoveryRun } from './types';
import { fetchCampaignLinkedCreatorIds, fetchCreatorsByIds, getSupabase } from './supabase';

export interface UnsavedMatch {
  handle: string;
  platform: 'tiktok' | 'instagram';
  bio: string | null;
  email: string | null;
  follower_count: number | null;
  engagement_rate: number | null;
  profile_url: string | null;
  avatar_url: string | null;
}

/** A finished run that saved nobody, while the 24-hour cache still has the matches. */
export function shouldRecoverCachedMatches(funnel: DiscoveryFunnel | null): boolean {
  if (!funnel) return false;
  if ((funnel.existingCreatorIds?.length ?? 0) > 0) return false;
  return funnel.afterFollowers > 0 && funnel.saved === 0 && funnel.afterDedupe === 0;
}

export function unsavedCreator(row: UnsavedMatch): Creator {
  return {
    id: `unsaved:${row.platform}:${row.handle.toLowerCase()}`,
    handle: row.handle,
    platform: row.platform,
    bio: row.bio,
    email: row.email,
    follower_count: row.follower_count,
    engagement_rate: row.engagement_rate ?? null,
    profile_url: row.profile_url,
    avatar_url: row.avatar_url,
    outreach_status: 'pending_review',
    ai_variables: {},
    unsaved: true,
    created_at: '',
    updated_at: '',
  };
}

function keepWhenEmailRequired<T extends { email?: string | null }>(
  rows: T[],
  requirePublicEmail: boolean,
): T[] {
  if (!requirePublicEmail) return rows;
  return rows.filter((row) => hasUsablePublicEmail(row.email));
}

function cacheQueryKey(campaign: Campaign): string {
  return discoveryQueryKey({
    niche: (campaign.niches ?? []).join(','),
    hashtags: campaign.hashtags,
    platforms: campaign.platforms,
    followerMin: campaign.follower_min,
    followerMax: campaign.follower_max,
    limit: campaign.result_limit,
    requirePublicEmail: campaign.require_public_email !== false,
  });
}

async function recoverFromCache(
  campaign: Campaign,
): Promise<{ known: Creator[]; unsaved: UnsavedMatch[] }> {
  const sb = getSupabase();
  if (!sb || !campaign.app_id) return { known: [], unsaved: [] };
  const cached = await readDiscoveryCache(sb, cacheQueryKey(campaign));
  if (!cached || cached.length === 0) return { known: [], unsaved: [] };
  const handles = [...new Set(cached.map((row) => row.handle.replace(/^@/, '')).filter(Boolean))];
  const { data, error } = await sb
    .from('creators')
    .select('*')
    .eq('app_id', campaign.app_id)
    .in('handle', handles);
  if (error || !data) return { known: [], unsaved: [] };
  const knownRows = data as Creator[];
  const knownKeys = new Set(
    knownRows.map((row) => creatorMatchKey(row.platform, row.handle)),
  );
  const requireEmail = campaign.require_public_email !== false;
  const wanted = new Set(cached.map((row) => creatorMatchKey(row.platform, row.handle)));
  const known = keepWhenEmailRequired(
    knownRows.filter((row) => wanted.has(creatorMatchKey(row.platform, row.handle))),
    requireEmail,
  );
  const unsaved = keepWhenEmailRequired(
    cached.filter((row) => !knownKeys.has(creatorMatchKey(row.platform, row.handle))),
    requireEmail,
  )
    .filter((row): row is CreatorCandidate & { platform: 'tiktok' | 'instagram' } =>
      row.platform === 'tiktok' || row.platform === 'instagram',
    )
    .map((row) => ({
      handle: row.handle.replace(/^@/, ''),
      platform: row.platform,
      bio: row.bio || null,
      email: row.email,
      follower_count: row.follower_count ?? null,
      engagement_rate: row.engagement_rate ?? null,
      profile_url: row.profile_url || null,
      avatar_url: row.avatar_url ?? null,
    }));
  return { known, unsaved };
}

/**
 * Campaign rows, plus CRM matches from this search that live on another campaign.
 * Accept batch links those matches here without moving creators.campaign_id.
 * A wiped run can also show cached creators that were never stored.
 */
export async function loadShownCreators(
  campaign: Campaign,
  owned: Creator[],
  runs: DiscoveryRun[],
): Promise<{ creators: Creator[]; unsaved: UnsavedMatch[]; existingCount: number }> {
  const funnel = asDiscoveryFunnel(runs[0]?.funnel);
  const ownedIds = new Set(owned.map((row) => row.id));
  let extras: Creator[] = [];
  let unsaved: UnsavedMatch[] = [];
  const includeCrm = campaign.include_crm_creators === true;
  if (includeCrm && funnel?.existingCreatorIds?.length) {
    extras = await fetchCreatorsByIds(funnel.existingCreatorIds);
  } else if (includeCrm && shouldRecoverCachedMatches(funnel)) {
    const recovered = await recoverFromCache(campaign);
    extras = recovered.known;
    unsaved = recovered.unsaved;
  }
  const linkIds = (await fetchCampaignLinkedCreatorIds(campaign.id)).filter((id) => !ownedIds.has(id));
  const linkedRows = await fetchCreatorsByIds(linkIds);
  const requireEmail = campaign.require_public_email !== false;
  const emailFilteredExtras = keepWhenEmailRequired(
    extras.filter((row) => !ownedIds.has(row.id) && row.campaign_id !== campaign.id),
    requireEmail,
  );
  const creators = mergeCampaignCreatorRows({
    owned,
    linked: linkedRows,
    extras: emailFilteredExtras,
  });
  return {
    creators,
    unsaved,
    existingCount: creators.filter((row) => row.alreadyInCrm).length,
  };
}

export function campaignResultNote(
  funnel: DiscoveryFunnel | null,
  existingCount: number,
): string | null {
  if (!funnel) return null;
  const display =
    typeof funnel.existing === 'number'
      ? funnel
      : { ...funnel, existing: existingCount };
  return discoveryResultNote(display);
}
