-- Links a creator who already lives in the CRM onto another campaign.
-- Does not copy the creator row and does not move creators.campaign_id.

CREATE TABLE IF NOT EXISTS public.campaign_creator_links (
  campaign_id uuid NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES public.creators (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, creator_id)
);

COMMENT ON TABLE public.campaign_creator_links IS
  'Creators already stored for the app, attached to this campaign by Accept batch. One row per creator. Sending stays manual.';

ALTER TABLE public.campaign_creator_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_campaign_creator_links" ON public.campaign_creator_links;
DROP POLICY IF EXISTS "admin_authenticated_select_campaign_creator_links" ON public.campaign_creator_links;

CREATE POLICY "admin_demo_anon_select_campaign_creator_links"
  ON public.campaign_creator_links FOR SELECT TO anon USING (true);
CREATE POLICY "admin_authenticated_select_campaign_creator_links"
  ON public.campaign_creator_links FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.campaign_creator_links TO anon, authenticated;
GRANT ALL ON public.campaign_creator_links TO service_role;
