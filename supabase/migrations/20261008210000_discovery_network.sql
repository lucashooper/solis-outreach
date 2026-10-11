-- Creator-network seeds and hashtag cooldown.
-- Following-list mining records which CRM creators were used as seeds.
-- Hashtag searches record the tag so the same feed is not scraped again for 10 days.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS discovery_source text NOT NULL DEFAULT 'both';

ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_discovery_source_check;

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_discovery_source_check
  CHECK (discovery_source IN ('network', 'hashtags', 'both'));

COMMENT ON COLUMN public.campaigns.discovery_source IS
  'Where Find creators looks. both mines following lists first, then hashtags if that is short of the target. network is following lists only, with hashtags when there are no seeds. hashtags skips the network.';

ALTER TABLE public.discovery_jobs
  ADD COLUMN IF NOT EXISTS discovery_source text NOT NULL DEFAULT 'both';

ALTER TABLE public.discovery_jobs
  DROP CONSTRAINT IF EXISTS discovery_jobs_discovery_source_check;

ALTER TABLE public.discovery_jobs
  ADD CONSTRAINT discovery_jobs_discovery_source_check
  CHECK (discovery_source IN ('network', 'hashtags', 'both'));

COMMENT ON COLUMN public.discovery_jobs.discovery_source IS
  'Source chosen for this search. both starts with following lists.';

CREATE TABLE IF NOT EXISTS public.discovery_network_seeds (
  app_id uuid NOT NULL REFERENCES public.apps (id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'tiktok',
  handle text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, platform, handle)
);

CREATE INDEX IF NOT EXISTS discovery_network_seeds_app_used_idx
  ON public.discovery_network_seeds (app_id, used_at DESC);

COMMENT ON TABLE public.discovery_network_seeds IS
  'Creators already used as following-list seeds for an app. A seed is skipped for 14 days after used_at.';

ALTER TABLE public.discovery_network_seeds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_discovery_network_seeds" ON public.discovery_network_seeds;
DROP POLICY IF EXISTS "admin_demo_anon_insert_discovery_network_seeds" ON public.discovery_network_seeds;
DROP POLICY IF EXISTS "admin_demo_anon_update_discovery_network_seeds" ON public.discovery_network_seeds;
DROP POLICY IF EXISTS "admin_authenticated_select_discovery_network_seeds" ON public.discovery_network_seeds;
DROP POLICY IF EXISTS "admin_authenticated_insert_discovery_network_seeds" ON public.discovery_network_seeds;
DROP POLICY IF EXISTS "admin_authenticated_update_discovery_network_seeds" ON public.discovery_network_seeds;

CREATE POLICY "admin_demo_anon_select_discovery_network_seeds"
  ON public.discovery_network_seeds FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_discovery_network_seeds"
  ON public.discovery_network_seeds FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_update_discovery_network_seeds"
  ON public.discovery_network_seeds FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "admin_authenticated_select_discovery_network_seeds"
  ON public.discovery_network_seeds FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_discovery_network_seeds"
  ON public.discovery_network_seeds FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_update_discovery_network_seeds"
  ON public.discovery_network_seeds FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.discovery_network_seeds TO anon, authenticated;
GRANT ALL ON public.discovery_network_seeds TO service_role;

CREATE TABLE IF NOT EXISTS public.discovery_tag_scrapes (
  app_id uuid NOT NULL REFERENCES public.apps (id) ON DELETE CASCADE,
  tag text NOT NULL,
  scraped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, tag)
);

CREATE INDEX IF NOT EXISTS discovery_tag_scrapes_app_scraped_idx
  ON public.discovery_tag_scrapes (app_id, scraped_at DESC);

COMMENT ON TABLE public.discovery_tag_scrapes IS
  'Last time a hashtag was sent to Apify for an app. Automatic searches skip a tag for 10 days. Custom tags typed by the user are exempt.';

ALTER TABLE public.discovery_tag_scrapes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_discovery_tag_scrapes" ON public.discovery_tag_scrapes;
DROP POLICY IF EXISTS "admin_demo_anon_insert_discovery_tag_scrapes" ON public.discovery_tag_scrapes;
DROP POLICY IF EXISTS "admin_demo_anon_update_discovery_tag_scrapes" ON public.discovery_tag_scrapes;
DROP POLICY IF EXISTS "admin_authenticated_select_discovery_tag_scrapes" ON public.discovery_tag_scrapes;
DROP POLICY IF EXISTS "admin_authenticated_insert_discovery_tag_scrapes" ON public.discovery_tag_scrapes;
DROP POLICY IF EXISTS "admin_authenticated_update_discovery_tag_scrapes" ON public.discovery_tag_scrapes;

CREATE POLICY "admin_demo_anon_select_discovery_tag_scrapes"
  ON public.discovery_tag_scrapes FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_discovery_tag_scrapes"
  ON public.discovery_tag_scrapes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_update_discovery_tag_scrapes"
  ON public.discovery_tag_scrapes FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "admin_authenticated_select_discovery_tag_scrapes"
  ON public.discovery_tag_scrapes FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_discovery_tag_scrapes"
  ON public.discovery_tag_scrapes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_update_discovery_tag_scrapes"
  ON public.discovery_tag_scrapes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.discovery_tag_scrapes TO anon, authenticated;
GRANT ALL ON public.discovery_tag_scrapes TO service_role;

-- Recent searches still count towards the cooldown, so #booktok is not scraped again tomorrow.
-- One row per app and tag: the same tag in several jobs must not be updated twice.
INSERT INTO public.discovery_tag_scrapes (app_id, tag, scraped_at)
SELECT j.app_id, lower(tag), max(j.created_at)
FROM public.discovery_jobs j
CROSS JOIN LATERAL jsonb_array_elements_text(
  COALESCE(j.funnel->'triedTags', '[]'::jsonb)
) AS tag
WHERE j.app_id IS NOT NULL
  AND j.created_at > now() - interval '10 days'
  AND tag <> ''
GROUP BY j.app_id, lower(tag)
ON CONFLICT (app_id, tag) DO UPDATE
  SET scraped_at = GREATEST(public.discovery_tag_scrapes.scraped_at, EXCLUDED.scraped_at);
