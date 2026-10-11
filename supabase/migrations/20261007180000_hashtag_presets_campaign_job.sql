-- Hashtag packs for the campaign Find creators modal, and a campaign link
-- on the discovery job so that search can show yield while it is still running.

CREATE TABLE IF NOT EXISTS public.hashtag_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps (id) ON DELETE CASCADE,
  name text NOT NULL,
  hashtags text[] NOT NULL DEFAULT '{}'::text[],
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hashtag_presets_name_check CHECK (char_length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS hashtag_presets_app_id_idx
  ON public.hashtag_presets (app_id, is_system, created_at);

COMMENT ON TABLE public.hashtag_presets IS
  'Named hashtag packs for one app. System rows are starting packs; the rest are saved by the user.';

ALTER TABLE public.hashtag_presets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_hashtag_presets" ON public.hashtag_presets;
DROP POLICY IF EXISTS "admin_demo_anon_insert_hashtag_presets" ON public.hashtag_presets;
DROP POLICY IF EXISTS "admin_demo_anon_update_hashtag_presets" ON public.hashtag_presets;
DROP POLICY IF EXISTS "admin_demo_anon_delete_hashtag_presets" ON public.hashtag_presets;
DROP POLICY IF EXISTS "admin_authenticated_select_hashtag_presets" ON public.hashtag_presets;
DROP POLICY IF EXISTS "admin_authenticated_insert_hashtag_presets" ON public.hashtag_presets;
DROP POLICY IF EXISTS "admin_authenticated_update_hashtag_presets" ON public.hashtag_presets;
DROP POLICY IF EXISTS "admin_authenticated_delete_hashtag_presets" ON public.hashtag_presets;

CREATE POLICY "admin_demo_anon_select_hashtag_presets"
  ON public.hashtag_presets FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_hashtag_presets"
  ON public.hashtag_presets FOR INSERT TO anon WITH CHECK (is_system = false);
CREATE POLICY "admin_demo_anon_update_hashtag_presets"
  ON public.hashtag_presets FOR UPDATE TO anon USING (is_system = false) WITH CHECK (is_system = false);
CREATE POLICY "admin_demo_anon_delete_hashtag_presets"
  ON public.hashtag_presets FOR DELETE TO anon USING (is_system = false);

CREATE POLICY "admin_authenticated_select_hashtag_presets"
  ON public.hashtag_presets FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_hashtag_presets"
  ON public.hashtag_presets FOR INSERT TO authenticated WITH CHECK (is_system = false);
CREATE POLICY "admin_authenticated_update_hashtag_presets"
  ON public.hashtag_presets FOR UPDATE TO authenticated USING (is_system = false) WITH CHECK (is_system = false);
CREATE POLICY "admin_authenticated_delete_hashtag_presets"
  ON public.hashtag_presets FOR DELETE TO authenticated USING (is_system = false);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.hashtag_presets TO anon, authenticated;
GRANT ALL ON public.hashtag_presets TO service_role;

-- BookTok is the documented ExampleApp pack. Custom packs are separate rows.
INSERT INTO public.hashtag_presets (id, app_id, name, hashtags, is_system)
SELECT
  'a0000000-0000-4000-8000-0000000000b1'::uuid,
  'a0000000-0000-4000-8000-000000000001'::uuid,
  'BookTok',
  ARRAY['#booktok', '#books']::text[],
  true
WHERE EXISTS (
  SELECT 1 FROM public.apps WHERE apps.id = 'a0000000-0000-4000-8000-000000000001'::uuid
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.discovery_jobs
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.discovery_jobs.campaign_id IS
  'Set when Find creators on a campaign starts the search, so the page can read yield before the run row exists.';

CREATE INDEX IF NOT EXISTS discovery_jobs_campaign_id_idx
  ON public.discovery_jobs (campaign_id, created_at DESC);
