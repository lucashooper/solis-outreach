-- Named email templates for campaigns, blasts, and the send drawer.
-- app_id is null for templates shared across apps.
-- British English comments.

CREATE TABLE IF NOT EXISTS public.email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid REFERENCES public.apps (id) ON DELETE SET NULL,
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS email_templates_set_updated_at ON public.email_templates;
CREATE TRIGGER email_templates_set_updated_at
  BEFORE UPDATE ON public.email_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS email_templates_app_id_idx
  ON public.email_templates (app_id);

CREATE INDEX IF NOT EXISTS email_templates_updated_at_idx
  ON public.email_templates (updated_at DESC);

COMMENT ON TABLE public.email_templates IS
  'Reusable subject and body pairs. Campaigns copy the text and keep template_id.';

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_anon_select_email_templates" ON public.email_templates;
DROP POLICY IF EXISTS "admin_anon_insert_email_templates" ON public.email_templates;
DROP POLICY IF EXISTS "admin_anon_update_email_templates" ON public.email_templates;
DROP POLICY IF EXISTS "admin_anon_delete_email_templates" ON public.email_templates;
DROP POLICY IF EXISTS "admin_authenticated_select_email_templates" ON public.email_templates;
DROP POLICY IF EXISTS "admin_authenticated_insert_email_templates" ON public.email_templates;
DROP POLICY IF EXISTS "admin_authenticated_update_email_templates" ON public.email_templates;
DROP POLICY IF EXISTS "admin_authenticated_delete_email_templates" ON public.email_templates;

CREATE POLICY "admin_anon_select_email_templates"
  ON public.email_templates FOR SELECT TO anon USING (true);
CREATE POLICY "admin_anon_insert_email_templates"
  ON public.email_templates FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_anon_update_email_templates"
  ON public.email_templates FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "admin_anon_delete_email_templates"
  ON public.email_templates FOR DELETE TO anon USING (true);

CREATE POLICY "admin_authenticated_select_email_templates"
  ON public.email_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_email_templates"
  ON public.email_templates FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "admin_authenticated_update_email_templates"
  ON public.email_templates FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "admin_authenticated_delete_email_templates"
  ON public.email_templates FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_templates TO anon, authenticated;
GRANT ALL ON public.email_templates TO service_role;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.email_templates (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.campaigns.template_id IS
  'Template chosen for this campaign. Subject and body are copied onto the campaign and stay editable.';

INSERT INTO public.email_templates (id, app_id, name, subject, body)
VALUES
  (
    'a0000000-0000-4000-8000-0000000000e1',
    NULL,
    'Default cold email',
    'Collab idea for @{{creator_handle}} — {{app_name}}',
    $cold$Hi {{creator_handle}},

{{hook}}

I'm reaching out from {{app_name}}.

Would you be open to a short-form collab?

Cheers,
{{app_name}} team$cold$
  ),
  (
    'a0000000-0000-4000-8000-0000000000e2',
    NULL,
    'Direct blast',
    'A note from {{app_name}}',
    $blast$Hi {{display_name}},

We're reaching out from {{app_name}} with a quick update.

Reply to this email if you'd like to chat.

Cheers,
{{app_name}} team$blast$
  )
ON CONFLICT (id) DO NOTHING;
