-- Persist Include CRM creators on saved filters.
-- Off is the default, matching campaigns.include_crm_creators.
-- British English comments.

ALTER TABLE public.discovery_presets
  ADD COLUMN IF NOT EXISTS include_existing boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.discovery_presets.include_existing IS
  'Include CRM creators for a saved Discover search. Off excludes people already stored for this app from the result limit.';

ALTER TABLE public.campaign_presets
  ADD COLUMN IF NOT EXISTS include_crm_creators boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campaign_presets.include_crm_creators IS
  'Saved Include CRM creators choice. Off means a campaign created from this preset skips people already in the app.';
