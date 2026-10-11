/** Supported creator platforms. */
export type Platform = 'tiktok' | 'instagram';

/** Lifecycle of a creator in the outreach funnel. */
export type OutreachStatus =
  | 'pending'
  | 'pending_review'
  | 'queued'
  | 'sent'
  | 'replied'
  | 'archived';

/** Cold-email sequence step (1–3). */
export type SequenceStep = 1 | 2 | 3;

/** Supported outbound email providers. */
export type EmailProvider = 'resend' | 'instantly' | 'smartlead';

/** Labels returned by the reply classifier. */
export type ReplySentiment =
  | 'Interested'
  | 'Not Interested'
  | 'Price Question'
  | 'Unsubscribe';

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

export interface PersonalizationResult {
  hook: string;
}

export interface ColdEmailInput {
  provider: EmailProvider;
  to: string;
  from?: string;
  /** Resend reply_to address (e.g. studioowner@gmail.com). */
  replyTo?: string;
  subject: string;
  htmlOrText: string;
  sequenceTags?: string[];
  creatorId: string;
  sequenceStep: SequenceStep;
}
