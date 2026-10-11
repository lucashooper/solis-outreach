-- Require a public email by default. Daily auto-run still requires one even when this is off.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS require_public_email boolean NOT NULL DEFAULT true;

ALTER TABLE public.discovery_presets
  ADD COLUMN IF NOT EXISTS require_public_email boolean NOT NULL DEFAULT true;

ALTER TABLE public.discovery_jobs
  ADD COLUMN IF NOT EXISTS require_public_email boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.campaigns.require_public_email IS
  'When true, discovery only saves creators with a public email. Daily auto-run always requires one.';
COMMENT ON COLUMN public.discovery_presets.require_public_email IS
  'Discover preset: only keep creators with a public email.';
COMMENT ON COLUMN public.discovery_jobs.require_public_email IS
  'Whether this Discover search dropped creators who had no public email.';
