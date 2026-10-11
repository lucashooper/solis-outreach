-- Discover form presets, scoped per app, plus a Discord notify stamp on replies.
-- British English comments.

CREATE TABLE IF NOT EXISTS public.discovery_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps (id) ON DELETE CASCADE,
  name text NOT NULL,
  niche text NOT NULL DEFAULT '',
  platform text NOT NULL DEFAULT 'tiktok',
  follower_min integer,
  follower_max integer,
  result_limit integer NOT NULL DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_presets_platform_check CHECK (
    platform IN ('tiktok', 'instagram', 'both')
  ),
  CONSTRAINT discovery_presets_name_check CHECK (char_length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS discovery_presets_app_id_idx
  ON public.discovery_presets (app_id, created_at);

COMMENT ON TABLE public.discovery_presets IS
  'Saved Discover searches: niche tags, platform, follower range, and result limit. One row per app.';

ALTER TABLE public.discovery_presets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_discovery_presets" ON public.discovery_presets;
DROP POLICY IF EXISTS "admin_demo_anon_insert_discovery_presets" ON public.discovery_presets;
DROP POLICY IF EXISTS "admin_demo_anon_update_discovery_presets" ON public.discovery_presets;
DROP POLICY IF EXISTS "admin_demo_anon_delete_discovery_presets" ON public.discovery_presets;
DROP POLICY IF EXISTS "admin_authenticated_select_discovery_presets" ON public.discovery_presets;
DROP POLICY IF EXISTS "admin_authenticated_insert_discovery_presets" ON public.discovery_presets;
DROP POLICY IF EXISTS "admin_authenticated_update_discovery_presets" ON public.discovery_presets;
DROP POLICY IF EXISTS "admin_authenticated_delete_discovery_presets" ON public.discovery_presets;

CREATE POLICY "admin_demo_anon_select_discovery_presets"
  ON public.discovery_presets FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_discovery_presets"
  ON public.discovery_presets FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_update_discovery_presets"
  ON public.discovery_presets FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "admin_demo_anon_delete_discovery_presets"
  ON public.discovery_presets FOR DELETE TO anon USING (true);

CREATE POLICY "admin_authenticated_select_discovery_presets"
  ON public.discovery_presets FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_discovery_presets"
  ON public.discovery_presets FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_update_discovery_presets"
  ON public.discovery_presets FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "admin_authenticated_delete_discovery_presets"
  ON public.discovery_presets FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.discovery_presets TO anon, authenticated;
GRANT ALL ON public.discovery_presets TO service_role;

-- Seeded from ExampleApp discovery (Solis): niches journal + productivity,
-- hashtags #booktok and #books, TikTok, 10,000–500,000 followers, limit 10.
-- #deepstash stays on that campaign and is not its own preset.
INSERT INTO public.discovery_presets (
  id, app_id, name, niche, platform, follower_min, follower_max, result_limit
)
SELECT seed.id, seed.app_id, seed.name, seed.niche, seed.platform,
       seed.follower_min, seed.follower_max, seed.result_limit
FROM (
  VALUES
    (
      'a0000000-0000-4000-8000-0000000000d1'::uuid,
      'a0000000-0000-4000-8000-000000000001'::uuid,
      'BookTok',
      'booktok, books',
      'tiktok',
      10000,
      500000,
      10
    ),
    (
      'a0000000-0000-4000-8000-0000000000d2'::uuid,
      'a0000000-0000-4000-8000-000000000001'::uuid,
      'Journaling & Productivity',
      'journal, productivity',
      'tiktok',
      10000,
      500000,
      10
    )
) AS seed(id, app_id, name, niche, platform, follower_min, follower_max, result_limit)
WHERE EXISTS (SELECT 1 FROM public.apps WHERE apps.id = seed.app_id)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.email_replies
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

COMMENT ON COLUMN public.email_replies.notified_at IS
  'When the Discord reply alert was sent. Rows that already existed are stamped so they are not sent again.';

UPDATE public.email_replies
SET notified_at = COALESCE(created_at, now())
WHERE notified_at IS NULL;

CREATE INDEX IF NOT EXISTS email_replies_unnotified_idx
  ON public.email_replies (received_at DESC)
  WHERE notified_at IS NULL;
