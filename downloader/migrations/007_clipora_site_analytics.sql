CREATE TABLE IF NOT EXISTS public.clipora_site_analytics_events (
  id BIGSERIAL PRIMARY KEY,
  path TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  referrer_host VARCHAR(255),
  device_type VARCHAR(20) NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT clipora_site_analytics_path_check CHECK (
    path IN ('/','/about','/linktree','/plans','/business','/u/:username')
  )
);

CREATE INDEX IF NOT EXISTS clipora_site_analytics_created_idx
  ON public.clipora_site_analytics_events(created_at DESC);

CREATE INDEX IF NOT EXISTS clipora_site_analytics_path_time_idx
  ON public.clipora_site_analytics_events(path, created_at DESC);
