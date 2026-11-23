ALTER TABLE public.linktree_profiles
  ADD COLUMN IF NOT EXISTS avatar_data BYTEA,
  ADD COLUMN IF NOT EXISTS avatar_mime VARCHAR(32);

ALTER TABLE public.linktree_profiles
  ADD CONSTRAINT linktree_avatar_mime_check
  CHECK (avatar_mime IS NULL OR avatar_mime IN ('image/jpeg','image/png','image/webp'));
