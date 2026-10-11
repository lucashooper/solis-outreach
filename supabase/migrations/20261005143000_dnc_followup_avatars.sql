-- Do-not-contact, skipped send logs, and a public bucket for cached avatars.
-- British English comments. Project: creator-outreach (your-project-ref).

ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.creators.do_not_contact IS
  'When true, pitches, blasts, and follow-ups to this creator are blocked.';

ALTER TABLE public.blast_sends
  DROP CONSTRAINT IF EXISTS blast_sends_status_check;

ALTER TABLE public.blast_sends
  ADD CONSTRAINT blast_sends_status_check
  CHECK (status IN ('sent', 'failed', 'opened', 'skipped'));

COMMENT ON COLUMN public.blast_sends.status IS
  'sent, failed, opened, or skipped. Skipped is a do-not-contact or duplicate block.';

ALTER TABLE public.outreach_logs
  ADD COLUMN IF NOT EXISTS outcome text;

COMMENT ON COLUMN public.outreach_logs.outcome IS
  'sent, failed, or skipped. Null on older rows means the send was attempted.';

-- Avatar bucket exists on Supabase. A plain Postgres without storage skips this.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('creator-avatars', 'creator-avatars', true)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF to_regclass('storage.objects') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage'
         AND tablename = 'objects'
         AND policyname = 'public_read_creator_avatars'
     ) THEN
    EXECUTE $policy$
      CREATE POLICY public_read_creator_avatars
        ON storage.objects FOR SELECT
        TO public
        USING (bucket_id = 'creator-avatars')
    $policy$;
  END IF;
END $$;
