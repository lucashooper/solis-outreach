-- Reuse a niche / hashtag / platform search for 24 hours.
-- Service role writes. The admin can read recent Discover jobs.

CREATE TABLE IF NOT EXISTS public.discovery_query_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid REFERENCES public.apps (id) ON DELETE SET NULL,
  query_key text NOT NULL,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_query_cache_key_idx
  ON public.discovery_query_cache (query_key, created_at DESC);

COMMENT ON TABLE public.discovery_query_cache IS
  'Recent Apify result sets. A matching query within 24 hours is reused instead of a new run.';

ALTER TABLE public.discovery_query_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_discovery_cache" ON public.discovery_query_cache;
CREATE POLICY "admin_demo_anon_select_discovery_cache"
  ON public.discovery_query_cache FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "admin_authenticated_select_discovery_cache" ON public.discovery_query_cache;
CREATE POLICY "admin_authenticated_select_discovery_cache"
  ON public.discovery_query_cache FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "admin_demo_anon_select_discovery_jobs" ON public.discovery_jobs;
CREATE POLICY "admin_demo_anon_select_discovery_jobs"
  ON public.discovery_jobs FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "admin_authenticated_select_discovery_jobs" ON public.discovery_jobs;
CREATE POLICY "admin_authenticated_select_discovery_jobs"
  ON public.discovery_jobs FOR SELECT TO authenticated USING (true);
