-- Optional pitch on the app. Campaign create and sends prefer this over the
-- generic Solis Labs sentence stored on older campaigns.
ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS value_prop text;

COMMENT ON COLUMN public.apps.value_prop IS
  'Outreach value proposition for this app. New campaigns copy it. Sends prefer it over a generic Solis default on the campaign.';
