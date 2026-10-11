-- Campaigns, discovery runs, and extended creator fields for the outreach pipeline.
-- British English comments. Admin demo anon policies match the existing pattern.

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------
CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  niches text[] NOT NULL DEFAULT '{}'::text[],
  platforms text[] NOT NULL DEFAULT '{}'::text[],
  follower_min integer,
  follower_max integer,
  engagement_rate_min numeric,
  result_limit integer NOT NULL DEFAULT 20,
  auto_outreach boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'searching', 'ready', 'outreaching', 'done')),
  app_name text,
  value_prop text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_platforms_check CHECK (
    platforms <@ ARRAY['tiktok', 'instagram']::text[]
  ),
  CONSTRAINT campaigns_result_limit_check CHECK (result_limit > 0 AND result_limit <= 500)
);

CREATE INDEX campaigns_status_idx ON public.campaigns (status);
CREATE INDEX campaigns_created_at_idx ON public.campaigns (created_at);

CREATE TRIGGER campaigns_set_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.campaigns IS
  'Discovery + outreach campaigns. Status: draft → searching → ready → outreaching → done.';
COMMENT ON COLUMN public.campaigns.niches IS
  'Target niches (e.g. fitness, beauty, tech).';
COMMENT ON COLUMN public.campaigns.auto_outreach IS
  'When true, creators with email are queued and outreach is triggered after discovery.';

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_demo_anon_select_campaigns"
  ON public.campaigns FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_campaigns"
  ON public.campaigns FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_update_campaigns"
  ON public.campaigns FOR UPDATE TO anon USING (true) WITH CHECK (true);

COMMENT ON POLICY "admin_demo_anon_select_campaigns" ON public.campaigns IS
  'INTERNAL ADMIN DEMO ONLY — allow anon SELECT; replace with auth before public deploy.';
COMMENT ON POLICY "admin_demo_anon_insert_campaigns" ON public.campaigns IS
  'INTERNAL ADMIN DEMO ONLY — allow anon INSERT; replace with auth before public deploy.';
COMMENT ON POLICY "admin_demo_anon_update_campaigns" ON public.campaigns IS
  'INTERNAL ADMIN DEMO ONLY — allow anon UPDATE; replace with auth before public deploy.';

-- ---------------------------------------------------------------------------
-- creators: campaign link + enrichment fields
-- ---------------------------------------------------------------------------
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS engagement_rate numeric,
  ADD COLUMN IF NOT EXISTS profile_url text;

CREATE INDEX IF NOT EXISTS creators_campaign_id_idx ON public.creators (campaign_id);

COMMENT ON COLUMN public.creators.campaign_id IS
  'Optional campaign that discovered / owns this creator row.';
COMMENT ON COLUMN public.creators.engagement_rate IS
  'Estimated engagement rate as a percentage (e.g. 3.5 = 3.5%).';
COMMENT ON COLUMN public.creators.profile_url IS
  'Canonical profile URL on the platform.';

-- ---------------------------------------------------------------------------
-- discovery_runs
-- ---------------------------------------------------------------------------
CREATE TABLE public.discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
  provider text NOT NULL,
  query jsonb NOT NULL DEFAULT '{}'::jsonb,
  results_count integer NOT NULL DEFAULT 0,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discovery_runs_campaign_id_idx ON public.discovery_runs (campaign_id);
CREATE INDEX discovery_runs_created_at_idx ON public.discovery_runs (created_at);

COMMENT ON TABLE public.discovery_runs IS
  'Audit log of each discovery provider invocation for a campaign.';

ALTER TABLE public.discovery_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_demo_anon_select_discovery_runs"
  ON public.discovery_runs FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_discovery_runs"
  ON public.discovery_runs FOR INSERT TO anon WITH CHECK (true);

COMMENT ON POLICY "admin_demo_anon_select_discovery_runs" ON public.discovery_runs IS
  'INTERNAL ADMIN DEMO ONLY — allow anon SELECT; replace with auth before public deploy.';
COMMENT ON POLICY "admin_demo_anon_insert_discovery_runs" ON public.discovery_runs IS
  'INTERNAL ADMIN DEMO ONLY — allow anon INSERT; replace with auth before public deploy.';
