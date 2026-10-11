-- Cached niche scores so a creator seen again is not sent back to Groq.
-- Service role writes these. No anon policies: the admin reads the score from the creator row.

CREATE TABLE IF NOT EXISTS public.discovery_niche_scores (
  platform text NOT NULL,
  handle text NOT NULL,
  categories text NOT NULL,
  score numeric NOT NULL,
  reason text NOT NULL DEFAULT '',
  band text NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, handle, categories),
  CONSTRAINT discovery_niche_scores_band_check CHECK (band IN ('relevant', 'review', 'drop')),
  CONSTRAINT discovery_niche_scores_score_check CHECK (score >= 0 AND score <= 1)
);

ALTER TABLE public.discovery_niche_scores ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.discovery_niche_scores IS
  'Niche fit scored for a handle against a sorted category list. Re-seen accounts are not scored again.';
