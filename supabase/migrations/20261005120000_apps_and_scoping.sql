-- Multi-app workspaces for the outreach admin.
-- Existing campaigns, creators, audiences and blast sends are attached to a
-- default Solis app so nothing already in the database disappears.
-- British English comments.

CREATE TABLE IF NOT EXISTS public.apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  developer text,
  bundle_id text,
  track_id text,
  icon_url text,
  store_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS apps_set_updated_at ON public.apps;
CREATE TRIGGER apps_set_updated_at
  BEFORE UPDATE ON public.apps
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.apps IS
  'Products the admin outreaches for. Campaigns, creators, audiences and blasts belong to one app.';

INSERT INTO public.apps (id, name, developer)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'Solis',
  'Solis Labs'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES public.apps (id) ON DELETE RESTRICT;
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES public.apps (id) ON DELETE RESTRICT;
ALTER TABLE public.audience_groups
  ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES public.apps (id) ON DELETE RESTRICT;
ALTER TABLE public.blast_sends
  ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES public.apps (id) ON DELETE RESTRICT;

UPDATE public.campaigns
SET app_id = 'a0000000-0000-4000-8000-000000000001'
WHERE app_id IS NULL;

UPDATE public.creators
SET app_id = 'a0000000-0000-4000-8000-000000000001'
WHERE app_id IS NULL;

UPDATE public.audience_groups
SET app_id = 'a0000000-0000-4000-8000-000000000001'
WHERE app_id IS NULL;

UPDATE public.blast_sends AS sends
SET app_id = campaigns.app_id
FROM public.campaigns AS campaigns
WHERE sends.campaign_id = campaigns.id
  AND sends.app_id IS NULL;

UPDATE public.blast_sends
SET app_id = 'a0000000-0000-4000-8000-000000000001'
WHERE app_id IS NULL;

ALTER TABLE public.campaigns
  ALTER COLUMN app_id SET DEFAULT 'a0000000-0000-4000-8000-000000000001';
ALTER TABLE public.campaigns ALTER COLUMN app_id SET NOT NULL;

ALTER TABLE public.creators
  ALTER COLUMN app_id SET DEFAULT 'a0000000-0000-4000-8000-000000000001';
ALTER TABLE public.creators ALTER COLUMN app_id SET NOT NULL;

ALTER TABLE public.audience_groups
  ALTER COLUMN app_id SET DEFAULT 'a0000000-0000-4000-8000-000000000001';
ALTER TABLE public.audience_groups ALTER COLUMN app_id SET NOT NULL;

-- Copy the campaign's app onto new blast rows so analytics stay scoped
-- even when the insert omits app_id.
CREATE OR REPLACE FUNCTION public.set_blast_send_app_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.app_id IS NULL THEN
    SELECT campaigns.app_id INTO NEW.app_id
    FROM public.campaigns AS campaigns
    WHERE campaigns.id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blast_sends_set_app_id ON public.blast_sends;
CREATE TRIGGER blast_sends_set_app_id
  BEFORE INSERT ON public.blast_sends
  FOR EACH ROW
  EXECUTE FUNCTION public.set_blast_send_app_id();

-- Same handle may be compiled into more than one app.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint AS con
    WHERE con.conrelid = 'public.creators'::regclass
      AND con.contype = 'u'
      AND pg_get_constraintdef(con.oid) ILIKE '%platform%'
      AND pg_get_constraintdef(con.oid) ILIKE '%handle%'
      AND pg_get_constraintdef(con.oid) NOT ILIKE '%app_id%'
  LOOP
    EXECUTE format('ALTER TABLE public.creators DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.creators
  DROP CONSTRAINT IF EXISTS creators_app_platform_handle_key;
ALTER TABLE public.creators
  ADD CONSTRAINT creators_app_platform_handle_key UNIQUE (app_id, platform, handle);

CREATE INDEX IF NOT EXISTS campaigns_app_id_idx ON public.campaigns (app_id);
CREATE INDEX IF NOT EXISTS creators_app_id_idx ON public.creators (app_id);
CREATE INDEX IF NOT EXISTS audience_groups_app_id_idx ON public.audience_groups (app_id);
CREATE INDEX IF NOT EXISTS blast_sends_app_id_idx ON public.blast_sends (app_id);

-- Async discovery searches. Service role only; the browser polls the function.
CREATE TABLE IF NOT EXISTS public.discovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid REFERENCES public.apps (id) ON DELETE CASCADE,
  niche text NOT NULL,
  platforms text[] NOT NULL DEFAULT '{}',
  follower_min integer,
  follower_max integer,
  result_limit integer NOT NULL DEFAULT 20,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed')),
  runs jsonb NOT NULL DEFAULT '[]'::jsonb,
  results jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS discovery_jobs_set_updated_at ON public.discovery_jobs;
CREATE TRIGGER discovery_jobs_set_updated_at
  BEFORE UPDATE ON public.discovery_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.discovery_jobs IS
  'In-flight Apify searches. Results are stored only after the actor dataset returns.';

ALTER TABLE public.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_demo_anon_select_apps" ON public.apps;
DROP POLICY IF EXISTS "admin_demo_anon_insert_apps" ON public.apps;
DROP POLICY IF EXISTS "admin_authenticated_select_apps" ON public.apps;
DROP POLICY IF EXISTS "admin_authenticated_insert_apps" ON public.apps;

CREATE POLICY "admin_demo_anon_select_apps"
  ON public.apps FOR SELECT TO anon USING (true);
CREATE POLICY "admin_demo_anon_insert_apps"
  ON public.apps FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin_authenticated_select_apps"
  ON public.apps FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_authenticated_insert_apps"
  ON public.apps FOR INSERT TO authenticated WITH CHECK (true);

COMMENT ON POLICY "admin_authenticated_select_apps" ON public.apps IS
  'Logged-in admin can list apps. Matches the existing admin RLS pattern.';
COMMENT ON POLICY "admin_authenticated_insert_apps" ON public.apps IS
  'Logged-in admin can save an App Store app. No anon delete policy.';
