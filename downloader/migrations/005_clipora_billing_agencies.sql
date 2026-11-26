-- Clipora billing, Paystack and agency workspaces.
-- Additive migration: existing downloader, profiles and links are retained.
ALTER TABLE public.clipora_plans
  ADD COLUMN IF NOT EXISTS entitlements jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS paystack_plan_code text;
ALTER TABLE public.clipora_plans
  ADD CONSTRAINT clipora_plans_entitlements_object_check
  CHECK (jsonb_typeof(entitlements) = 'object');

CREATE TABLE IF NOT EXISTS public.clipora_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id text NOT NULL,
  plan_id bigint NOT NULL REFERENCES public.clipora_plans(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','past_due','cancelled','expired')),
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly','yearly')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  paystack_customer_code text,
  paystack_subscription_code text,
  paystack_email_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clipora_subscriptions_user_idx ON public.clipora_subscriptions(auth_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS clipora_subscriptions_status_period_idx ON public.clipora_subscriptions(status,current_period_end);
CREATE UNIQUE INDEX IF NOT EXISTS clipora_one_active_subscription_per_user_idx ON public.clipora_subscriptions(auth_user_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS public.clipora_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id text NOT NULL,
  plan_id bigint REFERENCES public.clipora_plans(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES public.clipora_subscriptions(id) ON DELETE SET NULL,
  reference text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','reversed','refunded')),
  payment_type text NOT NULL DEFAULT 'subscription' CHECK (payment_type IN ('subscription','profile_pack')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  channel text,
  gateway_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clipora_payments_user_idx ON public.clipora_payments(auth_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS clipora_payments_status_idx ON public.clipora_payments(status,created_at DESC);

CREATE TABLE IF NOT EXISTS public.clipora_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT 'My Agency',
  slug text NOT NULL UNIQUE,
  included_profiles integer NOT NULL DEFAULT 10 CHECK (included_profiles >= 0),
  extra_profile_packs integer NOT NULL DEFAULT 0 CHECK (extra_profile_packs >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.clipora_workspace_members (
  workspace_id uuid NOT NULL REFERENCES public.clipora_workspaces(id) ON DELETE CASCADE,
  auth_user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','manager','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,auth_user_id)
);
CREATE TABLE IF NOT EXISTS public.clipora_workspace_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.clipora_workspaces(id) ON DELETE CASCADE,
  profile_id bigint NOT NULL UNIQUE REFERENCES public.linktree_profiles(id) ON DELETE CASCADE,
  client_name text NOT NULL,
  client_email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_approval','archived')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.linktree_profiles
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.clipora_workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS managed_by_user_id text;
CREATE INDEX IF NOT EXISTS linktree_profiles_workspace_idx ON public.linktree_profiles(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS clipora_workspace_clients_workspace_idx ON public.clipora_workspace_clients(workspace_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.clipora_billing_config (
  config_key text PRIMARY KEY,
  config_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.clipora_billing_config(config_key,config_value)
VALUES ('profile_packs', '{"pack_size":5,"price_minor":0,"enabled":false}'::jsonb)
ON CONFLICT(config_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.clipora_paystack_events (
  id bigserial PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  reference text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clipora_paystack_events_received_idx ON public.clipora_paystack_events(received_at DESC);

INSERT INTO public.clipora_plans(slug,name,description,price_minor,currency,billing_interval,features,entitlements,is_active,sort_order)
VALUES
('free','Free','The essentials for getting started.',0,'NGN','monthly',
 '["One personal Link Studio profile","Up to 5 active links","Basic profile customisation","Core downloader"]'::jsonb,
 '{"profile_limit":1,"max_active_links":5,"advanced_analytics":false,"custom_domain":false,"lead_capture":false,"remove_branding":false,"agency_workspace":false}'::jsonb,
 true,0),
('pro','Pro','Professional tools for creators and individual businesses.',0,'NGN','monthly',
 '["Advanced profile design and custom fonts","Advanced analytics and campaign tracking","Lead capture and enquiry forms","QR customisation and scheduled links","Remove Clipora branding"]'::jsonb,
 '{"profile_limit":1,"max_active_links":null,"advanced_analytics":true,"custom_domain":true,"lead_capture":true,"remove_branding":true,"agency_workspace":false}'::jsonb,
 false,1),
('business','Business','An agency workspace for managing client profiles.',0,'NGN','monthly',
 '["10 included client profiles","Additional profile packs available","Client onboarding and approval workflows","Team roles and unified client analytics","Agency reports and white-label tools"]'::jsonb,
 '{"profile_limit":10,"extra_profile_pack_size":5,"team_seats":3,"agency_workspace":true,"client_portal":true,"white_label":true,"unified_analytics":true}'::jsonb,
 false,2)
ON CONFLICT(slug) DO UPDATE SET
 description=EXCLUDED.description,features=EXCLUDED.features,entitlements=EXCLUDED.entitlements,updated_at=now();
