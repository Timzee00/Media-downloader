CREATE TABLE IF NOT EXISTS public.linktree_profiles (
  id BIGSERIAL PRIMARY KEY,
  auth_user_id TEXT NOT NULL UNIQUE,
  username VARCHAR(30) NOT NULL UNIQUE,
  display_name VARCHAR(80) NOT NULL,
  bio VARCHAR(280) NOT NULL DEFAULT '',
  avatar_url TEXT,
  cover_url TEXT,
  theme VARCHAR(24) NOT NULL DEFAULT 'liquid-dark',
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT linktree_username_format CHECK (username ~ '^[a-zA-Z0-9_][a-zA-Z0-9_.]{1,29}$')
);

CREATE TABLE IF NOT EXISTS public.linktree_links (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES public.linktree_profiles(id) ON DELETE CASCADE,
  title VARCHAR(80) NOT NULL,
  url TEXT NOT NULL,
  icon VARCHAR(40) NOT NULL DEFAULT 'link',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT linktree_link_url_scheme CHECK (url ~* '^https?://')
);

CREATE INDEX IF NOT EXISTS linktree_links_profile_order_idx
  ON public.linktree_links(profile_id, sort_order, id);
CREATE INDEX IF NOT EXISTS linktree_profiles_published_username_idx
  ON public.linktree_profiles(username) WHERE is_published = TRUE;
