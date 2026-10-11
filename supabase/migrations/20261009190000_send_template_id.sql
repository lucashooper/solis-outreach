-- Attribute each outreach and blast send to an email template.
-- Historic rows are filled best-effort. Anything still null is "Untracked / custom".
-- Existing anon and authenticated SELECT policies already cover these tables,
-- so the new columns are readable without extra policies.
-- British English comments.

ALTER TABLE public.outreach_logs
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.email_templates (id) ON DELETE SET NULL;

ALTER TABLE public.outreach_logs
  ADD COLUMN IF NOT EXISTS subject text;

ALTER TABLE public.blast_sends
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.email_templates (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.outreach_logs.template_id IS
  'Template used for this send. Null means the copy was custom or could not be matched.';
COMMENT ON COLUMN public.outreach_logs.subject IS
  'Rendered subject. Stored so a later match can use subject and body together.';
COMMENT ON COLUMN public.blast_sends.template_id IS
  'Template used for this blast send. Null means the copy was custom or could not be matched.';

CREATE INDEX IF NOT EXISTS outreach_logs_template_id_idx
  ON public.outreach_logs (template_id)
  WHERE template_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS blast_sends_template_id_idx
  ON public.blast_sends (template_id)
  WHERE template_id IS NOT NULL;

-- Lowercase, strip {{tokens}}, collapse whitespace. Used only for this backfill.
CREATE OR REPLACE FUNCTION public.normalise_template_copy(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(lower(coalesce(raw, '')), '\{\{[^}]*\}\}', ' ', 'g'),
      '\s+',
      ' ',
      'g'
    )
  );
$$;

-- Blasts store the template text on the campaign, not on the send.
-- Prefer an exact subject and body match. Then fall back to campaigns.template_id.
UPDATE public.blast_sends AS sends
SET template_id = matched.template_id
FROM public.campaigns AS campaigns
JOIN LATERAL (
  SELECT templates.id AS template_id
  FROM public.email_templates AS templates
  WHERE public.normalise_template_copy(templates.subject) = public.normalise_template_copy(campaigns.email_subject)
    AND public.normalise_template_copy(templates.body) = public.normalise_template_copy(campaigns.email_body)
    AND length(public.normalise_template_copy(templates.body)) >= 20
  ORDER BY templates.updated_at DESC NULLS LAST
  LIMIT 1
) AS matched ON true
WHERE sends.campaign_id = campaigns.id
  AND sends.template_id IS NULL;

UPDATE public.blast_sends AS sends
SET template_id = campaigns.template_id
FROM public.campaigns AS campaigns
WHERE sends.campaign_id = campaigns.id
  AND sends.template_id IS NULL
  AND campaigns.template_id IS NOT NULL;

-- Outreach logs store the rendered body. A template matches when its static
-- text (tokens removed, at least 40 characters) sits inside that body.
-- If a subject was stored, the template subject must sit inside it too.
UPDATE public.outreach_logs AS logs
SET template_id = picked.template_id
FROM (
  SELECT DISTINCT ON (logs.id)
    logs.id AS log_id,
    templates.id AS template_id
  FROM public.outreach_logs AS logs
  JOIN public.email_templates AS templates
    ON length(public.normalise_template_copy(templates.body)) >= 40
   AND position(
     public.normalise_template_copy(templates.body)
     IN public.normalise_template_copy(logs.message_body)
   ) > 0
   AND (
     logs.subject IS NULL
     OR length(public.normalise_template_copy(templates.subject)) < 8
     OR position(
       public.normalise_template_copy(templates.subject)
       IN public.normalise_template_copy(logs.subject)
     ) > 0
   )
  WHERE logs.template_id IS NULL
    AND logs.sent_at IS NOT NULL
    AND coalesce(logs.outcome, '') <> 'skipped'
    AND coalesce(logs.provider, '') <> 'skipped'
  ORDER BY
    logs.id,
    length(public.normalise_template_copy(templates.body)) DESC,
    templates.updated_at DESC NULLS LAST
) AS picked
WHERE logs.id = picked.log_id
  AND logs.template_id IS NULL;

-- One real send on a creator, and the campaign recorded a template: use that
-- when the rendered body did not contain a template skeleton.
UPDATE public.outreach_logs AS logs
SET template_id = campaigns.template_id
FROM public.creators AS creators
JOIN public.campaigns AS campaigns ON campaigns.id = creators.campaign_id
WHERE logs.creator_id = creators.id
  AND logs.template_id IS NULL
  AND logs.sent_at IS NOT NULL
  AND coalesce(logs.outcome, '') <> 'skipped'
  AND coalesce(logs.provider, '') <> 'skipped'
  AND campaigns.template_id IS NOT NULL
  AND (
    SELECT count(*)
    FROM public.outreach_logs AS other
    WHERE other.creator_id = logs.creator_id
      AND other.sent_at IS NOT NULL
      AND coalesce(other.outcome, '') <> 'skipped'
      AND coalesce(other.provider, '') <> 'skipped'
  ) = 1;

DROP FUNCTION IF EXISTS public.normalise_template_copy(text);
