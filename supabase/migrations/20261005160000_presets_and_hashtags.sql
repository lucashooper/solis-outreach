-- Hashtag targeting on campaigns, and saved discovery presets per app.
-- British English comments.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS hashtags text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.campaigns.hashtags IS
  'Explicit hashtags (stored with a leading #) passed to Apify ahead of broad niche expansion.';

CREATE TABLE IF NOT EXISTS public.campaign_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps (id) ON DELETE CASCADE,
  name text NOT NULL,
  niches text[] NOT NULL DEFAULT '{}'::text[],
  hashtags text[] NOT NULL DEFAULT '{}'::text[],
  platforms text[] NOT NULL DEFAULT '{}'::text[],
  follower_min integer,
  follower_max integer,
  engagement_rate_min numeric,
  result_limit integer NOT NULL DEFAULT 10,
  is_autopilot_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_presets_platforms_check CHECK (
    platforms <@ ARRAY['tiktok', 'instagram']::text[]
  )
);

CREATE INDEX IF NOT EXISTS campaign_presets_app_id_idx
  ON public.campaign_presets (app_id, created_at);

COMMENT ON TABLE public.campaign_presets IS
  'Saved discovery filters for one app. Shown beside the built-in campaign presets.';

ALTER TABLE public.campaign_presets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_campaign_presets" ON public.campaign_presets;
DROP POLICY IF EXISTS "admin_demo_anon_insert_campaign_presets" ON public.campaign_presets;
DROP POLICY IF EXISTS "admin_demo_anon_delete_campaign_presets" ON public.campaign_presets;
DROP POLICY IF EXISTS "admin_authenticated_select_campaign_presets" ON public.campaign_presets;
DROP POLICY IF EXISTS "admin_authenticated_insert_campaign_presets" ON public.campaign_presets;
DROP POLICY IF EXISTS "admin_authenticated_delete_campaign_presets" ON public.campaign_presets;

CREATE POLICY "admin_demo_anon_select_campaign_presets"
  ON public.campaign_presets FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_campaign_presets"
  ON public.campaign_presets FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_delete_campaign_presets"
  ON public.campaign_presets FOR DELETE TO anon USING (true);

CREATE POLICY "admin_authenticated_select_campaign_presets"
  ON public.campaign_presets FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_campaign_presets"
  ON public.campaign_presets FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_delete_campaign_presets"
  ON public.campaign_presets FOR DELETE TO authenticated USING (true);

COMMENT ON POLICY "admin_authenticated_select_campaign_presets" ON public.campaign_presets IS
  'Logged-in admin can list presets for the selected app.';
COMMENT ON POLICY "admin_authenticated_insert_campaign_presets" ON public.campaign_presets IS
  'Logged-in admin can save a discovery preset.';
COMMENT ON POLICY "admin_authenticated_delete_campaign_presets" ON public.campaign_presets IS
  'Logged-in admin can remove a saved preset.';

GRANT SELECT, INSERT, DELETE ON public.campaign_presets TO anon, authenticated;
