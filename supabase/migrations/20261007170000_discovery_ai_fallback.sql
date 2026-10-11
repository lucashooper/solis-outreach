-- One optional extra Apify run of related hashtags. Off unless the search asks for it.

ALTER TABLE public.discovery_jobs
  ADD COLUMN IF NOT EXISTS ai_fallback boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.discovery_jobs.ai_fallback IS
  'When true, a short search may run one extra Apify query of up to 2 related tags.';
