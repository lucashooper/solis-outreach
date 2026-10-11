-- Visual Influencer CRM + Apify enrichment fields.
-- Idempotent ALTERs. British English comments.
-- Apply via: supabase db push  OR  paste into Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- creators: avatar, top videos, ensure enrichment columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS profile_url text,
  ADD COLUMN IF NOT EXISTS engagement_rate numeric,
  ADD COLUMN IF NOT EXISTS top_videos jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.creators.avatar_url IS
  'Profile avatar / headshot URL from discovery (Apify).';
COMMENT ON COLUMN public.creators.top_videos IS
  'Top videos JSON array: [{video_url, thumbnail_url, view_count, play_count, caption}].';
COMMENT ON COLUMN public.creators.profile_url IS
  'Canonical profile URL on the platform.';
COMMENT ON COLUMN public.creators.engagement_rate IS
  'Estimated engagement rate as a percentage (e.g. 3.5 = 3.5%).';

-- ---------------------------------------------------------------------------
-- Extend outreach_status CHECK to include pending_review + archived
-- ---------------------------------------------------------------------------
ALTER TABLE public.creators DROP CONSTRAINT IF EXISTS creators_outreach_status_check;

ALTER TABLE public.creators
  ADD CONSTRAINT creators_outreach_status_check
  CHECK (
    outreach_status IN (
      'pending',
      'pending_review',
      'queued',
      'sent',
      'replied',
      'archived'
    )
  );

COMMENT ON COLUMN public.creators.outreach_status IS
  'pending → pending_review (approval queue) | queued → sent → replied; archived skips outreach.';
