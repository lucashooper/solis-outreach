-- Autopilot: daily scheduled discovery + outreach for campaigns.
-- British English comments. Anon UPDATE policy already exists on campaigns.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS is_autopilot_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS schedule_cron text NOT NULL DEFAULT '0 10 * * *';

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS autopilot_last_run_at timestamptz;

COMMENT ON COLUMN public.campaigns.is_autopilot_enabled IS
  'When true, the Express autopilot cron runs discovery + forced auto-outreach on schedule_cron.';
COMMENT ON COLUMN public.campaigns.schedule_cron IS
  '5-field cron expression evaluated in Europe/London (default: daily at 10:00).';
COMMENT ON COLUMN public.campaigns.autopilot_last_run_at IS
  'Timestamp of the last successful autopilot tick for this campaign (dedupe).';

CREATE INDEX IF NOT EXISTS campaigns_autopilot_enabled_idx
  ON public.campaigns (is_autopilot_enabled)
  WHERE is_autopilot_enabled = true;
