-- Where an audience group came from. Discovery launches set source = 'discovery'.
-- Groups created by hand stay null.

ALTER TABLE public.audience_groups
  ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN public.audience_groups.source IS
  'Origin of the group. discovery for groups saved from Discover. Null when created by hand.';
