-- Per-campaign switch for creators this app already stores.
-- Off (the default) means they are not saved, shown, or counted toward the target.
-- Existing rows are forced off so a previous UI default cannot keep including them.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS include_crm_creators boolean NOT NULL DEFAULT false;

UPDATE public.campaigns
SET include_crm_creators = false
WHERE include_crm_creators IS DISTINCT FROM false;

COMMENT ON COLUMN public.campaigns.include_crm_creators IS
  'When false, creators already stored for this app are not saved, shown, or counted toward the search target.';

-- Stop writes "stopping" / "stopped". The original check only allowed running, succeeded, and failed.
ALTER TABLE public.discovery_jobs
  DROP CONSTRAINT IF EXISTS discovery_jobs_status_check;

ALTER TABLE public.discovery_jobs
  ADD CONSTRAINT discovery_jobs_status_check
  CHECK (status IN ('running', 'stopping', 'stopped', 'succeeded', 'failed'));
