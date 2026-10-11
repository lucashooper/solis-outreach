-- Inbox rows written by Gmail reply sync. The admin reads them; the service role writes them.
-- British English comments.

CREATE TABLE IF NOT EXISTS public.email_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id text NOT NULL UNIQUE,
  from_email text NOT NULL,
  from_name text,
  subject text,
  snippet text,
  body_text text,
  received_at timestamptz,
  creator_id uuid REFERENCES public.creators (id) ON DELETE SET NULL,
  audience_member_id uuid REFERENCES public.audience_members (id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES public.campaigns (id) ON DELETE SET NULL,
  app_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_replies_received_at_idx
  ON public.email_replies (received_at DESC);

CREATE INDEX IF NOT EXISTS email_replies_campaign_id_idx
  ON public.email_replies (campaign_id);

CREATE INDEX IF NOT EXISTS email_replies_app_id_idx
  ON public.email_replies (app_id);

COMMENT ON TABLE public.email_replies IS
  'Inbound mailbox messages stored by Gmail reply sync. Snippet is the message text until a full body is available.';

ALTER TABLE public.email_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_authenticated_select_email_replies"
  ON public.email_replies FOR SELECT TO authenticated USING (true);

CREATE POLICY "admin_demo_anon_select_email_replies"
  ON public.email_replies FOR SELECT TO anon USING (true);

GRANT SELECT ON public.email_replies TO anon, authenticated;
GRANT ALL ON public.email_replies TO service_role;
