-- Clipora custom link logos and moderation support. Additive; existing data is preserved.
ALTER TABLE public.linktree_links
  ADD COLUMN IF NOT EXISTS logo_data BYTEA,
  ADD COLUMN IF NOT EXISTS logo_mime VARCHAR(40);

CREATE INDEX IF NOT EXISTS linktree_profiles_admin_created_idx
  ON public.linktree_profiles(created_at DESC);
