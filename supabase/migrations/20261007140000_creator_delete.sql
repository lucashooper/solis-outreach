-- Allow the admin UI to delete a CRM creator.
-- First-tap delete with Undo. outreach_logs cascade; email_replies.creator_id is set null.
-- British English comments.

GRANT DELETE ON public.creators TO anon, authenticated;

DROP POLICY IF EXISTS "admin_demo_anon_delete_creators" ON public.creators;
CREATE POLICY "admin_demo_anon_delete_creators"
  ON public.creators
  FOR DELETE
  TO anon
  USING (true);

DROP POLICY IF EXISTS "admin_authenticated_delete_creators" ON public.creators;
CREATE POLICY "admin_authenticated_delete_creators"
  ON public.creators
  FOR DELETE
  TO authenticated
  USING (true);

COMMENT ON POLICY "admin_demo_anon_delete_creators" ON public.creators IS
  'INTERNAL ADMIN — allow anon DELETE so the CRM trash control can remove a creator.';
COMMENT ON POLICY "admin_authenticated_delete_creators" ON public.creators IS
  'Allow authenticated DELETE so a signed-in admin can remove a CRM creator.';
