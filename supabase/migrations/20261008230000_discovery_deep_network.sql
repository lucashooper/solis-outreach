-- Deeper creator-network mining and hashtag memory.
-- Hidden seeds are not requested again for 60 days.
-- discovery_tag_stats ranks tags and suppresses ones that keep returning nobody.

ALTER TABLE public.discovery_network_seeds
  ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_result_count integer,
  ADD COLUMN IF NOT EXISTS qualifying_count integer;

COMMENT ON COLUMN public.discovery_network_seeds.hidden IS
  'The following list did not come back. Do not request this seed again until hidden_at is 60 days old.';

COMMENT ON COLUMN public.discovery_network_seeds.last_result_count IS
  'Following rows returned the last time this seed was mined.';

COMMENT ON COLUMN public.discovery_network_seeds.qualifying_count IS
  'In-range relevant creators this seed produced last time.';

-- Seeds whose following list was hidden on a recent job.
-- GROUP BY the conflict key so ON CONFLICT never updates the same row twice.
INSERT INTO public.discovery_network_seeds (
  app_id,
  platform,
  handle,
  used_at,
  hidden,
  hidden_at,
  last_result_count,
  qualifying_count
)
SELECT
  grouped.app_id,
  'tiktok',
  grouped.handle,
  grouped.used_at,
  true,
  grouped.used_at,
  0,
  0
FROM (
  SELECT
    j.app_id,
    btrim(seed) AS handle,
    max(j.created_at) AS used_at
  FROM public.discovery_jobs j
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(j.funnel->'network'->'hiddenSeeds', '[]'::jsonb)
  ) AS seed
  WHERE j.app_id IS NOT NULL
    AND btrim(seed) <> ''
  GROUP BY j.app_id, btrim(seed)
) AS grouped
ON CONFLICT (app_id, platform, handle) DO UPDATE
SET
  hidden = true,
  hidden_at = COALESCE(public.discovery_network_seeds.hidden_at, EXCLUDED.hidden_at),
  last_result_count = COALESCE(public.discovery_network_seeds.last_result_count, EXCLUDED.last_result_count),
  qualifying_count = COALESCE(public.discovery_network_seeds.qualifying_count, EXCLUDED.qualifying_count);

CREATE TABLE IF NOT EXISTS public.discovery_tag_stats (
  app_id uuid NOT NULL REFERENCES public.apps (id) ON DELETE CASCADE,
  tag text NOT NULL,
  category text,
  runs integer NOT NULL DEFAULT 0,
  videos_sampled integer NOT NULL DEFAULT 0,
  in_range integer NOT NULL DEFAULT 0,
  with_email integer NOT NULL DEFAULT 0,
  new_saved integer NOT NULL DEFAULT 0,
  dry_rounds integer NOT NULL DEFAULT 0,
  last_scraped_at timestamptz,
  suppressed_until timestamptz,
  PRIMARY KEY (app_id, tag)
);

CREATE INDEX IF NOT EXISTS discovery_tag_stats_app_suppressed_idx
  ON public.discovery_tag_stats (app_id, suppressed_until);

COMMENT ON TABLE public.discovery_tag_stats IS
  'Hashtag yield for an app. Ranked by new qualifying creators per 100 videos. A tag is suppressed for 30 days after two rounds with at least 20 videos and no new qualifying creators.';

ALTER TABLE public.discovery_tag_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_discovery_tag_stats" ON public.discovery_tag_stats;
DROP POLICY IF EXISTS "admin_demo_anon_insert_discovery_tag_stats" ON public.discovery_tag_stats;
DROP POLICY IF EXISTS "admin_demo_anon_update_discovery_tag_stats" ON public.discovery_tag_stats;
DROP POLICY IF EXISTS "admin_authenticated_select_discovery_tag_stats" ON public.discovery_tag_stats;
DROP POLICY IF EXISTS "admin_authenticated_insert_discovery_tag_stats" ON public.discovery_tag_stats;
DROP POLICY IF EXISTS "admin_authenticated_update_discovery_tag_stats" ON public.discovery_tag_stats;

CREATE POLICY "admin_demo_anon_select_discovery_tag_stats"
  ON public.discovery_tag_stats FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_discovery_tag_stats"
  ON public.discovery_tag_stats FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_update_discovery_tag_stats"
  ON public.discovery_tag_stats FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "admin_authenticated_select_discovery_tag_stats"
  ON public.discovery_tag_stats FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_discovery_tag_stats"
  ON public.discovery_tag_stats FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_update_discovery_tag_stats"
  ON public.discovery_tag_stats FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.discovery_tag_stats TO anon, authenticated;
GRANT ALL ON public.discovery_tag_stats TO service_role;

-- One row per app and tag. Yield from past jobs is aggregated before the upsert.
INSERT INTO public.discovery_tag_stats (
  app_id,
  tag,
  category,
  runs,
  videos_sampled,
  in_range,
  with_email,
  new_saved,
  dry_rounds,
  last_scraped_at,
  suppressed_until
)
SELECT
  grouped.app_id,
  grouped.tag,
  NULL,
  grouped.runs,
  grouped.videos_sampled,
  grouped.in_range,
  grouped.with_email,
  grouped.new_saved,
  CASE
    WHEN grouped.new_saved = 0 AND grouped.runs >= 2 AND grouped.videos_sampled >= 40 THEN 2
    ELSE 0
  END,
  grouped.last_scraped_at,
  CASE
    WHEN grouped.new_saved = 0 AND grouped.runs >= 2 AND grouped.videos_sampled >= 40
      THEN now() + interval '30 days'
    ELSE NULL
  END
FROM (
  SELECT
    j.app_id,
    lower(btrim(elem->>'tag')) AS tag,
    count(*)::integer AS runs,
    coalesce(sum(
      CASE
        WHEN coalesce(elem->>'sampled', '') ~ '^[0-9]+$' THEN (elem->>'sampled')::integer
        ELSE 0
      END
    ), 0)::integer AS videos_sampled,
    coalesce(sum(
      CASE
        WHEN coalesce(elem->>'creators', '') ~ '^[0-9]+$' THEN (elem->>'creators')::integer
        ELSE 0
      END
    ), 0)::integer AS in_range,
    coalesce(sum(
      CASE
        WHEN coalesce(elem->>'withEmail', '') ~ '^[0-9]+$' THEN (elem->>'withEmail')::integer
        ELSE 0
      END
    ), 0)::integer AS with_email,
    coalesce(sum(
      CASE
        WHEN coalesce(elem->>'withEmail', '') ~ '^[0-9]+$' THEN (elem->>'withEmail')::integer
        ELSE 0
      END
    ), 0)::integer AS new_saved,
    max(j.created_at) AS last_scraped_at
  FROM public.discovery_jobs j
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(j.funnel->'hashtagYield', '[]'::jsonb)
  ) AS elem
  WHERE j.app_id IS NOT NULL
    AND btrim(coalesce(elem->>'tag', '')) <> ''
  GROUP BY j.app_id, lower(btrim(elem->>'tag'))
) AS grouped
WHERE grouped.tag <> ''
ON CONFLICT (app_id, tag) DO UPDATE
SET
  runs = GREATEST(public.discovery_tag_stats.runs, EXCLUDED.runs),
  videos_sampled = GREATEST(public.discovery_tag_stats.videos_sampled, EXCLUDED.videos_sampled),
  in_range = GREATEST(public.discovery_tag_stats.in_range, EXCLUDED.in_range),
  with_email = GREATEST(public.discovery_tag_stats.with_email, EXCLUDED.with_email),
  new_saved = GREATEST(public.discovery_tag_stats.new_saved, EXCLUDED.new_saved),
  dry_rounds = GREATEST(public.discovery_tag_stats.dry_rounds, EXCLUDED.dry_rounds),
  last_scraped_at = GREATEST(public.discovery_tag_stats.last_scraped_at, EXCLUDED.last_scraped_at),
  suppressed_until = COALESCE(public.discovery_tag_stats.suppressed_until, EXCLUDED.suppressed_until);
