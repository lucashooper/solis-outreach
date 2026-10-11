-- Creator outreach engine: creators + outreach_logs
-- n8n workflows authenticate with the Supabase service role key, which bypasses RLS.
-- Keep RLS enabled so anon/authenticated clients cannot read or mutate outreach data by default.

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  'Sets updated_at to now() on row UPDATE. Used by creators.';

-- ---------------------------------------------------------------------------
-- creators
-- ---------------------------------------------------------------------------
CREATE TABLE public.creators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('tiktok', 'instagram')),
  bio text,
  email text,
  follower_count integer,
  outreach_status text NOT NULL DEFAULT 'pending'
    CHECK (outreach_status IN ('pending', 'queued', 'sent', 'replied')),
  ai_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, handle)
);

CREATE INDEX creators_outreach_status_idx ON public.creators (outreach_status);
CREATE INDEX creators_email_idx ON public.creators (email);
CREATE INDEX creators_created_at_idx ON public.creators (created_at);

CREATE TRIGGER creators_set_updated_at
  BEFORE UPDATE ON public.creators
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.creators IS
  'Creator profiles queued for cold outreach. UNIQUE(platform, handle).';
COMMENT ON COLUMN public.creators.ai_variables IS
  'JSON bag for personalisation outputs (e.g. {"hook": "..."}).';
COMMENT ON COLUMN public.creators.outreach_status IS
  'pending → queued → sent → replied (set by n8n on reply classification).';

ALTER TABLE public.creators ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated: only service_role (n8n) can access.
-- Add explicit policies later if a dashboard needs limited client access.

-- ---------------------------------------------------------------------------
-- outreach_logs
-- ---------------------------------------------------------------------------
CREATE TABLE public.outreach_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES public.creators (id) ON DELETE CASCADE,
  message_body text,
  sequence_step smallint NOT NULL CHECK (sequence_step BETWEEN 1 AND 3),
  sent_at timestamptz,
  webhook_events jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outreach_logs_creator_id_idx ON public.outreach_logs (creator_id);
CREATE INDEX outreach_logs_sequence_step_idx ON public.outreach_logs (sequence_step);
CREATE INDEX outreach_logs_sent_at_idx ON public.outreach_logs (sent_at);

COMMENT ON TABLE public.outreach_logs IS
  'One row per sequence step sent (or attempted) to a creator.';
COMMENT ON COLUMN public.outreach_logs.webhook_events IS
  'Append-only array of inbound provider webhook payloads / classifications.';

ALTER TABLE public.outreach_logs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Supabase Database Webhook (manual setup — not created by SQL)
-- ---------------------------------------------------------------------------
-- To fire n8n when a creator is inserted:
--   1. Supabase Dashboard → Database → Webhooks → Create a new hook
--   2. Table: public.creators | Events: INSERT
--   3. Type: HTTP Request → POST to your n8n webhook URL
--   4. Headers: include Authorization: Bearer <WEBHOOK_SHARED_SECRET> (or x-webhook-secret)
--   5. Payload: leave default JSON (record / old_record / type / table / schema)
-- See docs/webhook-setup.md for the full checklist.
