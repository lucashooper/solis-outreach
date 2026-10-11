-- Custom audience groups + direct blast campaigns.
-- British English comments. Admin demo anon + authenticated policies match existing pattern.
-- Mutations preferred via Express service role (bypasses RLS).

-- ---------------------------------------------------------------------------
-- audience_groups
-- ---------------------------------------------------------------------------
CREATE TABLE public.audience_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audience_groups_created_at_idx ON public.audience_groups (created_at);
CREATE INDEX audience_groups_name_idx ON public.audience_groups (name);

CREATE TRIGGER audience_groups_set_updated_at
  BEFORE UPDATE ON public.audience_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.audience_groups IS
  'Named custom email audiences for direct blast campaigns (e.g. Current Astra Users).';

ALTER TABLE public.audience_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_demo_anon_select_audience_groups"
  ON public.audience_groups FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_audience_groups"
  ON public.audience_groups FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_update_audience_groups"
  ON public.audience_groups FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "admin_demo_anon_delete_audience_groups"
  ON public.audience_groups FOR DELETE TO anon USING (true);

CREATE POLICY "admin_authenticated_select_audience_groups"
  ON public.audience_groups FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_audience_groups"
  ON public.audience_groups FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_update_audience_groups"
  ON public.audience_groups FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "admin_authenticated_delete_audience_groups"
  ON public.audience_groups FOR DELETE TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- audience_members
-- ---------------------------------------------------------------------------
CREATE TABLE public.audience_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.audience_groups (id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, email)
);

CREATE INDEX audience_members_group_id_idx ON public.audience_members (group_id);
CREATE INDEX audience_members_email_idx ON public.audience_members (email);

COMMENT ON TABLE public.audience_members IS
  'Email recipients in an audience group. UNIQUE(group_id, email).';

ALTER TABLE public.audience_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_demo_anon_select_audience_members"
  ON public.audience_members FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_audience_members"
  ON public.audience_members FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_update_audience_members"
  ON public.audience_members FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "admin_demo_anon_delete_audience_members"
  ON public.audience_members FOR DELETE TO anon USING (true);

CREATE POLICY "admin_authenticated_select_audience_members"
  ON public.audience_members FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_audience_members"
  ON public.audience_members FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_update_audience_members"
  ON public.audience_members FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "admin_authenticated_delete_audience_members"
  ON public.audience_members FOR DELETE TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- campaigns: direct_blast fields
-- ---------------------------------------------------------------------------
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS campaign_type text NOT NULL DEFAULT 'discovery',
  ADD COLUMN IF NOT EXISTS audience_group_id uuid REFERENCES public.audience_groups (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS email_subject text,
  ADD COLUMN IF NOT EXISTS email_body text;

-- Drop and re-add check so existing rows (default discovery) stay valid
ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_campaign_type_check;

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_campaign_type_check
  CHECK (campaign_type IN ('discovery', 'direct_blast'));

CREATE INDEX IF NOT EXISTS campaigns_campaign_type_idx ON public.campaigns (campaign_type);
CREATE INDEX IF NOT EXISTS campaigns_audience_group_id_idx ON public.campaigns (audience_group_id);

COMMENT ON COLUMN public.campaigns.campaign_type IS
  'discovery = Apify/influencer outreach; direct_blast = email a custom audience group.';
COMMENT ON COLUMN public.campaigns.audience_group_id IS
  'Audience for direct_blast campaigns.';
COMMENT ON COLUMN public.campaigns.email_subject IS
  'Subject line for direct_blast (supports {{display_name}}, {{app_name}}, …).';
COMMENT ON COLUMN public.campaigns.email_body IS
  'Body for direct_blast (plain or HTML; template tokens as subject).';

-- ---------------------------------------------------------------------------
-- blast_sends
-- ---------------------------------------------------------------------------
CREATE TABLE public.blast_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.audience_members (id) ON DELETE SET NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed', 'opened')),
  error text,
  provider_message_id text,
  sent_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX blast_sends_campaign_id_idx ON public.blast_sends (campaign_id);
CREATE INDEX blast_sends_status_idx ON public.blast_sends (status);
CREATE INDEX blast_sends_email_idx ON public.blast_sends (email);
CREATE INDEX blast_sends_member_id_idx ON public.blast_sends (member_id);

COMMENT ON TABLE public.blast_sends IS
  'Per-recipient send log for direct_blast campaigns. status: sent | failed | opened.';

ALTER TABLE public.blast_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_demo_anon_select_blast_sends"
  ON public.blast_sends FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_blast_sends"
  ON public.blast_sends FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_demo_anon_update_blast_sends"
  ON public.blast_sends FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "admin_authenticated_select_blast_sends"
  ON public.blast_sends FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_blast_sends"
  ON public.blast_sends FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_update_blast_sends"
  ON public.blast_sends FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
