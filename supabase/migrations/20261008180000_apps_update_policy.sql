-- Let the admin switcher rename an app and edit its store link, icon, and pitch.
-- SELECT and INSERT already exist for anon and authenticated. UPDATE did not,
-- so a browser save was rejected by RLS.
--
-- Not applied by this change. Run it in the Supabase SQL editor before rename
-- will persist for the anon and authenticated roles.

DROP POLICY IF EXISTS "admin_demo_anon_update_apps" ON public.apps;
DROP POLICY IF EXISTS "admin_authenticated_update_apps" ON public.apps;

CREATE POLICY "admin_demo_anon_update_apps"
  ON public.apps
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "admin_authenticated_update_apps"
  ON public.apps
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY "admin_demo_anon_update_apps" ON public.apps IS
  'INTERNAL ADMIN DEMO ONLY — allow anon UPDATE so the switcher can rename an app. Matches admin_demo_anon_insert_apps.';
COMMENT ON POLICY "admin_authenticated_update_apps" ON public.apps IS
  'Logged-in admin can rename an app and edit its details. Matches admin_authenticated_insert_apps.';
