import type { Platform } from '../types.js';
import type { ExpansionRoundLog, ExpansionTier } from './expansionTiers.js';
import type { ApifyAccountSpend, ApifyRoundSpend } from './apifyPool.js';
import type { HashtagYield } from './hashtagYield.js';
import type { DiscoverySource, NetworkFunnelStats } from './network.js';
import type { DiscoveryStage } from './progress.js';
import type { SkippedTag } from './tagCooldown.js';

/** Campaign status lifecycle. */
export type CampaignStatus =
  | 'draft'
  | 'searching'
  | 'ready'
  | 'outreaching'
  | 'done';

/** Discovery provider identifiers. */
export type DiscoveryProviderName = 'demo' | 'apify';

export interface Campaign {
  id: string;
  name: string;
  niches: string[];
  /** Explicit hashtags, stored with a leading #. Optional for older rows. */
  hashtags?: string[] | null;
  platforms: string[];
  follower_min: number | null;
  follower_max: number | null;
  engagement_rate_min: number | null;
  result_limit: number;
  /** Optional. One extra page is tried when a search saves fewer than this. */
  min_creators?: number | null;
  /** When true (the default), only keep creators with a usable public email. */
  require_public_email?: boolean;
  /**
   * When true, creators this app already stores can be shown and count toward the target.
   * Absent or false: they are skipped, hidden, and the search keeps looking for new ones.
   */
  include_crm_creators?: boolean;
  auto_outreach: boolean;
  status: CampaignStatus;
  app_name: string | null;
  value_prop: string | null;
  is_autopilot_enabled?: boolean;
  schedule_cron?: string;
  autopilot_last_run_at?: string | null;
  email_subject?: string | null;
  email_body?: string | null;
  template_id?: string | null;
  /**
   * Where Find creators looks first.
   * both: following lists, then hashtags if the network is short of the target.
   * Absent on older rows, which keep the hashtag search.
   */
  discovery_source?: DiscoverySource | null;
  created_at: string;
  updated_at: string;
}

/** Top video snippet stored on creators.top_videos jsonb. */
export interface TopVideo {
  video_url: string;
  thumbnail_url: string | null;
  view_count: number | null;
  play_count: number | null;
  caption: string | null;
  /** When this caption was scraped. Absent on rows saved before provenance. */
  scraped_at?: string | null;
}

/** Normalised creator candidate returned by discovery providers. */
export interface CreatorCandidate {
  handle: string;
  platform: Platform;
  bio: string;
  /** TikTok nickname when it is a display name, not the handle. */
  display_name?: string | null;
  email: string | null;
  /** bio: address was in the profile text. bio_link: fetched from the link in the bio. */
  email_source?: 'bio' | 'bio_link' | null;
  /** Page the bio_link address was read from. */
  email_source_url?: string | null;
  /** Link on the profile, when the followers scraper returned one. */
  bio_link?: string | null;
  /** 0–1 niche fit. Absent until scoring runs. */
  niche_score?: number | null;
  niche_reason?: string | null;
  niche_band?: 'relevant' | 'review' | 'drop' | null;
  follower_count: number;
  engagement_rate: number | null;
  profile_url: string;
  avatar_url?: string | null;
  top_videos?: TopVideo[];
  niches: string[];
  raw?: Record<string, unknown>;
  /** Set when this handle was already stored for the app before the run. */
  creatorId?: string;
  alreadyInCrm?: boolean;
  /** network: mined from a seed's following list. Hashtag hits leave this unset. */
  discovery_source?: 'network' | 'hashtag';
  /** Seed whose following list produced this creator. */
  discovery_seed?: string | null;
}

/**
 * Why a search finished the way it did.
 * Stored on the funnel so a job is never "succeeded" with an empty explanation.
 */
export type DiscoveryReasonCode =
  | 'ok'
  | 'apify_not_configured'
  | 'apify_budget_exceeded'
  | 'no_search_terms'
  | 'already_running'
  | 'actor_failed'
  | 'zero_raw_items'
  | 'all_filtered_by_followers'
  | 'all_filtered_by_email'
  | 'all_in_crm'
  | 'tags_on_cooldown'
  | 'network_charge_rejected';

/** Where a search lost creators, stored on the run and shown in the admin. */
export interface DiscoveryFunnel {
  rawItems: number;
  uniqueCreators: number;
  afterFollowers: number;
  afterDedupe: number;
  /** In-range creators whose video bio already contained an email. */
  afterBioExtract?: number;
  /** In-range creators with an email after the capped profile lookup. */
  afterProfileEnrich?: number;
  withEmail: number;
  saved: number;
  /** In-range creators already stored for this app before the run. */
  existing?: number;
  /** CRM ids for those creators, so the list can link to them without another search. */
  existingCreatorIds?: string[];
  followerMin: number | null;
  followerMax: number | null;
  apifyRunIds: string[];
  /** Absent on older rows. Treated as on when the email stage saved nobody. */
  requirePublicEmail?: boolean;
  /** Yield of the tags this search actually sent to Apify. */
  hashtagYield?: HashtagYield[];
  /** Tags added by the one extra fallback run, when that option was on. */
  fallbackTags?: string[];
  fallbackSource?: 'ai' | 'niche';
  /** Which single extra Apify pass ran, if the search was still short. */
  extraPass?: 'fallback' | 'page';
  /** Qualifying creators after that pass, before the result-limit slice. */
  finished?: number;
  /** Every tag sent to Apify, including the extra pass. */
  triedTags?: string[];
  /** Up to two adjacent tags offered on the shortfall sheet. Not yet searched. */
  suggestedTags?: string[];
  /**
   * Tags the next expand will search, computed when the job is read.
   * Never includes a tag on cooldown, suppressed, already scraped, or already on the campaign.
   */
  eligibleSuggestions?: string[];
  /** Shown when no eligible tag remains. British English. */
  suggestionNote?: string;
  /** No hashtag is eligible. The card offers a creator-network search instead. */
  networkOnly?: boolean;
  /** Further ranked tags, so a chip on the sheet can be swapped. */
  expansionPool?: string[];
  suggestedSource?: 'ai' | 'niche';
  /** Ordered tiers still available for this campaign. Generic tags are never stored. */
  expansionPlan?: ExpansionTier[];
  /** Tier used by the latest expand round. */
  expansionTier?: 1 | 2 | 3;
  /** Apify rounds used by the latest Expand click. At most three. */
  expansionRounds?: number;
  /** True when every tier has been searched. Custom hashtags are still available. */
  expansionExhausted?: boolean;
  /** Set while a click is still chaining dry rounds. */
  expansionCascade?: boolean;
  /** Qualifying creators before the round that is in flight. */
  expansionBaseline?: number;
  /** Custom hashtags for the click that is in flight. */
  expansionCustom?: string[];
  /** What the latest click searched, one entry per Apify round. */
  expansionLog?: ExpansionRoundLog[];
  /** An expand has been used. Further expands stay available while tiers remain. */
  continueUsed?: 'expand' | 'relax';
  /** This batch includes in-range creators without a public email. The setting is unchanged. */
  emailRelaxed?: boolean;
  /** Accept batch linked the CRM matches onto this campaign. The sheet stays dismissed. */
  batchAccepted?: boolean;
  /** Link rows this accept added, so Undo can remove them without deleting creators. */
  batchLinkedIds?: string[];
  /** Why the search ended. Absent on older rows. */
  reason?: DiscoveryReasonCode;
  /** True when this funnel was rebuilt from the 24-hour query cache, not a new Apify run. */
  cached?: boolean;
  /** network, hashtags, or both. Absent on older rows. */
  discoverySource?: DiscoverySource;
  /** Following-list step. Absent when the run only searched hashtags. */
  network?: NetworkFunnelStats;
  /** Hashtags skipped because this app scraped them in the last 10 days. */
  skippedTags?: SkippedTag[];
  /** Dollars this run may still spend. The chosen job budget, not one account's leftover credit. */
  runBudgetUsd?: number;
  /** Charge authorised so far, from maxTotalChargeUsd on each call. */
  runSpentUsd?: number;
  /** Plain-language note when the budget stopped further calls, or every account is out of credit. */
  runBudgetNote?: string;
  /** Spend per connected Apify account. Labels only, never tokens. */
  apifyAccounts?: ApifyAccountSpend[];
  /** Which account paid for each actor round. */
  apifyRounds?: ApifyRoundSpend[];
  /** 1-based accounts that hit a credit limit during this job. */
  apifyExhausted?: number[];
  /** Seeds still waiting for a following-list batch. */
  networkQueue?: string[];
  /** The second hop (this run's fresh matches) has been queued. */
  networkHopped?: boolean;
  /** Keywords used for the network relevance check. */
  relevanceTerms?: string[];
  /** Categories counted on the network step. */
  activeCategories?: string[];
  /** Why an expand round left the previous category. */
  categoryRotation?: string;
  /** Live line shown while the job is still running. */
  stage?: DiscoveryStage;
  /** Bio-link pages fetched for in-range creators who had no email in the bio. */
  bioLinksChecked?: number;
  /** Addresses found on those pages. */
  emailsFromBioLinks?: number;
  /** In-range creators the niche score kept at 0.6 or above. */
  nicheRelevant?: number;
  /** Kept, but between 0.4 and 0.6, so the list can mark them for review. */
  nicheReview?: number;
  /** Dropped below 0.4. */
  nicheDropped?: number;
  /** ai when Groq scored the batch. keywords when scoring fell back. */
  nicheSource?: 'ai' | 'keywords';
}

export interface DiscoveryRunResult {
  candidates: CreatorCandidate[];
  provider: DiscoveryProviderName;
  query: Record<string, unknown>;
  raw?: unknown;
  funnel?: DiscoveryFunnel;
  /** In-range creators already in the CRM. Not inserted again and not moved off their campaign. */
  existingMatches?: CreatorCandidate[];
}
