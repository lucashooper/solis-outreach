-- Grant authenticated the same access as anon for admin UI after login (JWT).
-- Root cause of 403 on campaign create: browser uses authenticated role; policies
-- previously only targeted anon.
--
-- Apply in the Supabase SQL editor (production) or via supabase db push.
-- British English comments.

-- ---------------------------------------------------------------------------
-- campaigns: SELECT / INSERT / UPDATE (match anon policies)
-- ---------------------------------------------------------------------------
CREATE POLICY "admin_authenticated_select_campaigns"
  ON public.campaigns
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admin_authenticated_insert_campaigns"
  ON public.campaigns
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "admin_authenticated_update_campaigns"
  ON public.campaigns
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "admin_authenticated_select_campaigns" ON public.campaigns IS
  'Allow authenticated SELECT (matches admin_demo_anon_* for logged-in admin JWT).';
COMMENT ON POLICY "admin_authenticated_insert_campaigns" ON public.campaigns IS
  'Allow authenticated INSERT (fixes 403 after login when anon-only policies existed).';
COMMENT ON POLICY "admin_authenticated_update_campaigns" ON public.campaigns IS
  'Allow authenticated UPDATE (matches admin_demo_anon_* for logged-in admin JWT).';

-- ---------------------------------------------------------------------------
-- creators: SELECT / INSERT / UPDATE
-- ---------------------------------------------------------------------------
CREATE POLICY "admin_authenticated_select_creators"
  ON public.creators
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admin_authenticated_insert_creators"
  ON public.creators
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "admin_authenticated_update_creators"
  ON public.creators
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "admin_authenticated_select_creators" ON public.creators IS
  'Allow authenticated SELECT (matches admin_demo_anon_*).';
COMMENT ON POLICY "admin_authenticated_insert_creators" ON public.creators IS
  'Allow authenticated INSERT (matches admin_demo_anon_*).';
COMMENT ON POLICY "admin_authenticated_update_creators" ON public.creators IS
  'Allow authenticated UPDATE (matches admin_demo_anon_*).';

-- ---------------------------------------------------------------------------
-- outreach_logs: SELECT / INSERT (no UPDATE — append-oriented)
-- ---------------------------------------------------------------------------
CREATE POLICY "admin_authenticated_select_outreach_logs"
  ON public.outreach_logs
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admin_authenticated_insert_outreach_logs"
  ON public.outreach_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

COMMENT ON POLICY "admin_authenticated_select_outreach_logs" ON public.outreach_logs IS
  'Allow authenticated SELECT (matches admin_demo_anon_*).';
COMMENT ON POLICY "admin_authenticated_insert_outreach_logs" ON public.outreach_logs IS
  'Allow authenticated INSERT (matches admin_demo_anon_*).';

-- ---------------------------------------------------------------------------
-- discovery_runs: SELECT / INSERT
-- ---------------------------------------------------------------------------
CREATE POLICY "admin_authenticated_select_discovery_runs"
  ON public.discovery_runs
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admin_authenticated_insert_discovery_runs"
  ON public.discovery_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

COMMENT ON POLICY "admin_authenticated_select_discovery_runs" ON public.discovery_runs IS
  'Allow authenticated SELECT (matches admin_demo_anon_*).';
COMMENT ON POLICY "admin_authenticated_insert_discovery_runs" ON public.discovery_runs IS
  'Allow authenticated INSERT (matches admin_demo_anon_*).';

-- ---------------------------------------------------------------------------
-- OPTIONAL — local-only disable RLS (DO NOT run in production)
-- Uncomment only for disposable local Supabase when debugging without policies.
-- Preferred path in production: keep RLS + authenticated policies above, and
-- create campaigns via Express POST /api/campaigns (service role bypasses RLS).
-- ---------------------------------------------------------------------------
-- ALTER TABLE public.campaigns DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.creators DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.outreach_logs DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.discovery_runs DISABLE ROW LEVEL SECURITY;
