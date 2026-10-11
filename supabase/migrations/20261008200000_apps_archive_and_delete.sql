-- Hide an app from the switcher without deleting campaigns, creators, or email history.
-- Foreign keys stay ON DELETE RESTRICT. A hard delete is only possible when
-- nothing points at the app. Archiving sets archived_at and leaves every row.
--
-- Not applied by this change. Run it in the Supabase SQL editor before
-- Delete app can persist for the anon and authenticated roles.
-- The UPDATE policies are repeated so archive works even if
-- 20261008180000_apps_update_policy.sql has not been applied yet.

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN public.apps.archived_at IS
  'When set, the app is hidden from the switcher. Campaigns, creators, audiences, and email history stay.';

DROP POLICY IF EXISTS "admin_demo_anon_update_apps" ON public.apps;
DROP POLICY IF EXISTS "admin_authenticated_update_apps" ON public.apps;
DROP POLICY IF EXISTS "admin_demo_anon_delete_apps" ON public.apps;
DROP POLICY IF EXISTS "admin_authenticated_delete_apps" ON public.apps;

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

CREATE POLICY "admin_demo_anon_delete_apps"
  ON public.apps
  FOR DELETE
  TO anon
  USING (true);

CREATE POLICY "admin_authenticated_delete_apps"
  ON public.apps
  FOR DELETE
  TO authenticated
  USING (true);

COMMENT ON POLICY "admin_demo_anon_update_apps" ON public.apps IS
  'INTERNAL ADMIN DEMO ONLY — allow anon UPDATE so the switcher can archive or restore an app.';
COMMENT ON POLICY "admin_authenticated_update_apps" ON public.apps IS
  'Logged-in admin can archive or restore an app. Does not delete campaigns or creators.';
COMMENT ON POLICY "admin_demo_anon_delete_apps" ON public.apps IS
  'INTERNAL ADMIN DEMO ONLY — allow anon DELETE of an app with no linked rows. RESTRICT foreign keys block a delete that would cascade.';
COMMENT ON POLICY "admin_authenticated_delete_apps" ON public.apps IS
  'Logged-in admin can delete an app only when no campaigns, creators, or other rows reference it.';
