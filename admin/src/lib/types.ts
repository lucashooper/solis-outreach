import { statusPillLabel } from '../../../src/crm/statusLabel.ts';

export type Platform = 'tiktok' | 'instagram';

export type OutreachStatus =
  | 'pending'
  | 'pending_review'
  | 'queued'
  | 'sent'
  | 'replied'
  | 'archived';

export type SequenceStep = 1 | 2 | 3;

export type CampaignStatus =
  | 'draft'
  | 'searching'
  | 'ready'
  | 'outreaching'
  | 'done';

export type CampaignType = 'discovery' | 'direct_blast';

export interface TopVideo {
  video_url: string;
  thumbnail_url: string | null;
  view_count: number | null;
  play_count: number | null;
  caption: string | null;
  /** When this caption was scraped. Absent on rows saved before provenance. */
  scraped_at?: string | null;
}

export interface Creator {
  id: string;
  handle: string;
  platform: Platform;
  bio: string | null;
  email: string | null;
  follower_count: number | null;
  outreach_status: OutreachStatus;
  ai_variables: Record<string, unknown>;
  campaign_id?: string | null;
  engagement_rate?: number | null;
  profile_url?: string | null;
  avatar_url?: string | null;
  top_videos?: TopVideo[];
  app_id?: string | null;
  do_not_contact?: boolean;
  /** Shown on a campaign when the row already belongs to the CRM. */
  alreadyInCrm?: boolean;
  /** Accept batch attached this CRM row to the campaign without copying it. */
  linked?: boolean;
  /** Present in the cached search, but not stored as a CRM row. */
  unsaved?: boolean;
  created_at: string;
  updated_at: string;
}

export interface OutreachLog {
  id: string;
  creator_id: string;
  message_body: string | null;
  sequence_step: SequenceStep;
  sent_at: string | null;
  webhook_events: unknown[];
  provider: string | null;
  provider_message_id: string | null;
  created_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  niches: string[];
  hashtags?: string[];
  platforms: string[];
  follower_min: number | null;
  follower_max: number | null;
  engagement_rate_min: number | null;
  result_limit: number;
  min_creators?: number | null;
  require_public_email?: boolean;
  /** Off by default. On shows creators this app already stores and lets them count. */
  include_crm_creators?: boolean;
  auto_outreach: boolean;
  status: CampaignStatus;
  app_name: string | null;
  value_prop: string | null;
  is_autopilot_enabled: boolean;
  schedule_cron: string;
  autopilot_last_run_at: string | null;
  campaign_type?: CampaignType;
  audience_group_id?: string | null;
  email_subject?: string | null;
  email_body?: string | null;
  template_id?: string | null;
  app_id?: string | null;
  /** network, hashtags, or both. Missing rows behave as both. */
  discovery_source?: 'network' | 'hashtags' | 'both';
  created_at: string;
  updated_at: string;
}

export interface CampaignPreset {
  id: string;
  app_id: string;
  name: string;
  niches: string[];
  hashtags: string[];
  platforms: string[];
  follower_min: number | null;
  follower_max: number | null;
  engagement_rate_min: number | null;
  result_limit: number;
  min_creators?: number | null;
  include_crm_creators?: boolean;
  is_autopilot_enabled: boolean;
  created_at: string;
}

export interface SolisApp {
  id: string;
  name: string;
  developer: string | null;
  bundle_id: string | null;
  track_id: string | null;
  icon_url: string | null;
  store_url: string | null;
  value_prop?: string | null;
  /** Set when the app is hidden from the switcher. Linked rows stay. */
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryRun {
  id: string;
  campaign_id: string;
  provider: string;
  query: Record<string, unknown>;
  results_count: number;
  raw: unknown;
  funnel?: unknown;
  error?: string | null;
  created_at: string;
}

export interface CampaignFormData {
  name: string;
  niches: string[];
  hashtags?: string[];
  platforms: string[];
  follower_min: string;
  follower_max: string;
  engagement_rate_min: string;
  result_limit: string;
  min_creators?: string;
  require_public_email?: boolean;
  include_crm_creators?: boolean;
  auto_outreach: boolean;
  is_autopilot_enabled: boolean;
  schedule_cron: string;
  app_name: string;
  value_prop: string;
  campaign_type?: CampaignType;
  audience_group_id?: string;
  email_subject?: string;
  email_body?: string;
  template_id?: string | null;
  discovery_source?: 'network' | 'hashtags' | 'both';
}

export interface CreatorFormData {
  handle: string;
  platform: Platform;
  bio: string;
  email: string;
  follower_count: string;
  outreach_status: OutreachStatus;
}

export interface AppSettings {
  supabaseUrl: string;
  supabaseAnonKey: string;
  discordWebhookUrl: string;
  appName: string;
  appValueProp: string;
  /** Base URL for the Express campaign API (default http://localhost:3001). */
  apiBaseUrl: string;
  /** Informational only in v1 — real token must live server-side. */
  apifyTokenNote: string;
}

export interface StatusCounts {
  pending: number;
  pending_review: number;
  queued: number;
  sent: number;
  replied: number;
  archived: number;
  total: number;
}

export const OUTREACH_STATUSES: OutreachStatus[] = [
  'pending',
  'pending_review',
  'queued',
  'sent',
  'replied',
  'archived',
];

/** Filter tabs for the Visual CRM. Replies stays a separate view beside these. */
export { CRM_CREATOR_TABS as CRM_FILTER_TABS } from '../../../src/crm/unsent.ts';

export const CAMPAIGN_STATUSES: CampaignStatus[] = [
  'draft',
  'searching',
  'ready',
  'outreaching',
  'done',
];

export const PLATFORMS: Platform[] = ['tiktok', 'instagram'];

export const STATUS_LABELS: Record<OutreachStatus, string> = {
  pending: statusPillLabel('pending'),
  pending_review: statusPillLabel('pending_review'),
  queued: statusPillLabel('queued'),
  sent: statusPillLabel('sent'),
  replied: statusPillLabel('replied'),
  archived: statusPillLabel('archived'),
};

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  searching: 'Searching',
  ready: 'Ready',
  outreaching: 'Outreaching',
  done: 'Done',
};

export const NICHE_SUGGESTIONS = [
  'fitness',
  'beauty',
  'tech',
  'fashion',
  'food',
  'travel',
  'gaming',
  'parenting',
];
