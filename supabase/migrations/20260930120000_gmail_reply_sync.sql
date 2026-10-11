-- Inbound Gmail reply sync for the outreach mailbox (studioowner@gmail.com).
-- Gmail treats studio.owner@gmail.com as the same inbox (dots are ignored).
-- Service role writes gmail_seen_messages. blast_sends.replied_at is readable
-- by the existing anon/authenticated blast policies so the admin can show it.
-- British English comments.
-- Apply in the Supabase SQL editor or via supabase db push.

ALTER TABLE public.blast_sends
  ADD COLUMN IF NOT EXISTS replied_at timestamptz;

COMMENT ON COLUMN public.blast_sends.replied_at IS
  'When an inbound reply matched this recipient. Null means no reply recorded. Status stays sent/failed/opened so blast sent counts do not drop.';

CREATE INDEX IF NOT EXISTS blast_sends_replied_at_idx
  ON public.blast_sends (replied_at)
  WHERE replied_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.gmail_seen_messages (
  gmail_message_id text PRIMARY KEY,
  from_email text,
  subject text,
  matched_creator_ids uuid[] NOT NULL DEFAULT '{}',
  matched_blast_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.gmail_seen_messages IS
  'Gmail message ids already handled by reply sync. A second run skips these so leads are not marked twice or flipped back.';

ALTER TABLE public.gmail_seen_messages ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies. Only the service role (Netlify / Express) writes this table.
