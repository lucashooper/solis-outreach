-- Full decoded text of an inbound Gmail reply. body_text stays for older readers.

ALTER TABLE public.email_replies
  ADD COLUMN IF NOT EXISTS body text;

COMMENT ON COLUMN public.email_replies.body IS
  'Decoded inbound text. text/plain when present, otherwise text/html with tags removed.';
