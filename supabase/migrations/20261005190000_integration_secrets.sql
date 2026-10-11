-- Server-only OAuth secrets. The browser never reads this table.
-- British English comments.

CREATE TABLE IF NOT EXISTS public.integration_secrets (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.integration_secrets IS
  'Service-role secrets such as the Gmail refresh token. No anon or authenticated policies.';

ALTER TABLE public.integration_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.integration_secrets FROM anon, authenticated;
GRANT ALL ON public.integration_secrets TO service_role;
