-- Admin demo policies for the Vite admin frontend (anon key).
--
-- COMMENT / WARNING:
--   This is for an INTERNAL admin tool only. The base migration intentionally
--   left RLS with no anon/authenticated policies so only service_role (n8n)
--   could access data. These policies deliberately open SELECT/INSERT/UPDATE
--   to the anon role so the browser admin can work with VITE_SUPABASE_ANON_KEY.
--
--   Before any public deploy: remove or tighten these policies and replace with
--   authenticated-role policies (or a server proxy using the service role).
--   Never ship the service role key to the browser.

-- ---------------------------------------------------------------------------
-- creators: anon may list, create, and update (including status changes)
-- ---------------------------------------------------------------------------
CREATE POLICY "admin_demo_anon_select_creators"
  ON public.creators
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "admin_demo_anon_insert_creators"
  ON public.creators
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "admin_demo_anon_update_creators"
  ON public.creators
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "admin_demo_anon_select_creators" ON public.creators IS
  'INTERNAL ADMIN DEMO ONLY — allow anon SELECT; replace with auth before public deploy.';
COMMENT ON POLICY "admin_demo_anon_insert_creators" ON public.creators IS
  'INTERNAL ADMIN DEMO ONLY — allow anon INSERT; replace with auth before public deploy.';
COMMENT ON POLICY "admin_demo_anon_update_creators" ON public.creators IS
  'INTERNAL ADMIN DEMO ONLY — allow anon UPDATE; replace with auth before public deploy.';

-- ---------------------------------------------------------------------------
-- outreach_logs: anon may list and insert (no UPDATE — logs are append-oriented)
-- ---------------------------------------------------------------------------
CREATE POLICY "admin_demo_anon_select_outreach_logs"
  ON public.outreach_logs
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "admin_demo_anon_insert_outreach_logs"
  ON public.outreach_logs
  FOR INSERT
  TO anon
  WITH CHECK (true);

COMMENT ON POLICY "admin_demo_anon_select_outreach_logs" ON public.outreach_logs IS
  'INTERNAL ADMIN DEMO ONLY — allow anon SELECT; replace with auth before public deploy.';
COMMENT ON POLICY "admin_demo_anon_insert_outreach_logs" ON public.outreach_logs IS
  'INTERNAL ADMIN DEMO ONLY — allow anon INSERT; replace with auth before public deploy.';
