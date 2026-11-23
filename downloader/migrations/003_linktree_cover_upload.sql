ALTER TABLE public.linktree_profiles
  ADD COLUMN IF NOT EXISTS cover_data BYTEA,
  ADD COLUMN IF NOT EXISTS cover_mime VARCHAR(32);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linktree_cover_mime_check') THEN
    ALTER TABLE public.linktree_profiles
      ADD CONSTRAINT linktree_cover_mime_check
      CHECK (cover_mime IS NULL OR cover_mime IN ('image/jpeg','image/png','image/webp'));
  END IF;
END $$;
