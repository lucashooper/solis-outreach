-- Funnel counts for discovery, plus a place to store the real Apify error.
-- Empty cached searches are deleted so a failed filter cannot be replayed for 24 hours.

ALTER TABLE public.discovery_runs
  ADD COLUMN IF NOT EXISTS funnel jsonb,
  ADD COLUMN IF NOT EXISTS error text;

ALTER TABLE public.discovery_jobs
  ADD COLUMN IF NOT EXISTS funnel jsonb,
  ADD COLUMN IF NOT EXISTS include_existing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hashtags text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.discovery_runs.funnel IS
  'rawItems, uniqueCreators, afterFollowers, afterDedupe, withEmail, saved, follower bounds, apifyRunIds.';
COMMENT ON COLUMN public.discovery_runs.error IS
  'Apify or search error shown on the run. Null when the search finished.';
COMMENT ON COLUMN public.discovery_jobs.funnel IS
  'Same funnel shape as discovery_runs.funnel.';

DELETE FROM public.discovery_query_cache
WHERE jsonb_typeof(results) = 'array'
  AND jsonb_array_length(results) = 0;
