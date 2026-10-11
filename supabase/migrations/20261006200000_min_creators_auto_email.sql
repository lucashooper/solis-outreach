-- Optional minimum for a discovery search, and stop surprise sends on
-- ExampleApp-style campaigns that never turned Auto-email on.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS min_creators integer;

ALTER TABLE public.discovery_jobs
  ADD COLUMN IF NOT EXISTS min_creators integer;

ALTER TABLE public.discovery_presets
  ADD COLUMN IF NOT EXISTS min_creators integer;

COMMENT ON COLUMN public.campaigns.min_creators IS
  'When set, a short search tries one extra hashtag or page, then stops.';

-- Direct Blast is left alone. Daily Auto-Run with a template keeps Auto-email.
-- Every other discovery campaign was opted in by the old default.
UPDATE public.campaigns
SET auto_outreach = false
WHERE coalesce(campaign_type, 'discovery') <> 'direct_blast'
  AND NOT (
    is_autopilot_enabled = true
    AND (
      template_id IS NOT NULL
      OR (
        email_subject IS NOT NULL
        AND btrim(email_subject) <> ''
        AND email_body IS NOT NULL
        AND btrim(email_body) <> ''
      )
    )
  );
