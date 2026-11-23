-- Clipora Link Hub foundation: additive only; existing profile/link data is preserved.
ALTER TABLE public.linktree_profiles
  ADD COLUMN IF NOT EXISTS appearance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.linktree_links
  ADD COLUMN IF NOT EXISTS category VARCHAR(24) NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS description VARCHAR(180) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS schedule_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS schedule_end TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.linktree_sections (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES public.linktree_profiles(id) ON DELETE CASCADE,
  title VARCHAR(60) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS linktree_sections_profile_order_idx
  ON public.linktree_sections(profile_id, sort_order, id);

ALTER TABLE public.linktree_links
  ADD COLUMN IF NOT EXISTS section_id BIGINT REFERENCES public.linktree_sections(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.linktree_short_links (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES public.linktree_profiles(id) ON DELETE CASCADE,
  link_id BIGINT REFERENCES public.linktree_links(id) ON DELETE SET NULL,
  slug VARCHAR(32) NOT NULL UNIQUE,
  destination_url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT linktree_short_link_url_scheme CHECK (destination_url ~* '^https?://')
);
CREATE INDEX IF NOT EXISTS linktree_short_links_profile_created_idx
  ON public.linktree_short_links(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.linktree_analytics_events (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES public.linktree_profiles(id) ON DELETE CASCADE,
  link_id BIGINT REFERENCES public.linktree_links(id) ON DELETE SET NULL,
  event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('page_view','link_click')),
  visitor_hash CHAR(64),
  referrer_host VARCHAR(255),
  device_type VARCHAR(16) NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS linktree_analytics_profile_time_idx
  ON public.linktree_analytics_events(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS linktree_analytics_link_time_idx
  ON public.linktree_analytics_events(link_id, created_at DESC);
