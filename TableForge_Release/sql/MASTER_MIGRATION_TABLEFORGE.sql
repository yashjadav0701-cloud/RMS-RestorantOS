-- TableForge / RMS master migration
-- Generated against the supplied live Supabase metadata export (2026-10-18/19).
-- IMPORTANT: run on a restorable backup or staging clone first.
-- This migration preserves existing business rows; it does not rebuild tables.
-- It is intentionally guarded and transactional. If a precondition fails, stop and inspect the error.

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

DO $preflight$
BEGIN
  IF to_regclass('public.restaurants') IS NULL
     OR to_regclass('public.tables') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_items') IS NULL
     OR to_regclass('public.dining_sessions') IS NULL
     OR to_regclass('public.app_settings') IS NULL
     OR to_regclass('public.security_logs') IS NULL THEN
    RAISE EXCEPTION 'TableForge preflight failed: expected live application tables are missing. No changes were applied.';
  END IF;
  IF to_regprocedure('public._tableforge_hash_pin(text)') IS NULL
     OR to_regprocedure('public._tableforge_verify_pin_hash(text,text)') IS NULL THEN
    RAISE EXCEPTION 'TableForge preflight failed: expected PIN hash helpers are missing. No changes were applied.';
  END IF;
END;
$preflight$;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1. Durable panel credentials, short-lived grants, rate limiting and requests
-- ---------------------------------------------------------------------------
-- Operator-controlled allowlist: new Auth users are provisioned only when a platform
-- operator first inserts the email here from the Supabase SQL Editor/backend.
CREATE TABLE IF NOT EXISTS public.restaurant_provisioning_allowlist (
  email text PRIMARY KEY CHECK (length(btrim(email)) BETWEEN 3 AND 320),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes')
);
ALTER TABLE public.restaurant_provisioning_allowlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.restaurant_provisioning_allowlist FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.panel_pin_credentials (
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  panel_id text NOT NULL CHECK (panel_id IN ('captain','kot','cashier','manager','admin')),
  pin_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (restaurant_id, panel_id)
);

CREATE TABLE IF NOT EXISTS public.panel_access_tokens (
  token_hash text PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  panel_id text NOT NULL CHECK (panel_id IN ('captain','kot','cashier','manager','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS public.panel_management_tokens (
  token_hash text PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS public.panel_pin_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  owner_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  panel_id text NOT NULL,
  succeeded boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS panel_pin_attempts_owner_time_idx
  ON public.panel_pin_attempts(owner_id, panel_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS panel_access_tokens_tenant_expiry_idx
  ON public.panel_access_tokens(restaurant_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS panel_management_tokens_tenant_expiry_idx
  ON public.panel_management_tokens(restaurant_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.operational_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  table_id uuid NULL REFERENCES public.tables(id) ON DELETE SET NULL,
  session_id uuid NULL REFERENCES public.dining_sessions(id) ON DELETE SET NULL,
  request_type text NOT NULL CHECK (request_type IN ('captain')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acknowledged','resolved','cancelled')),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_requests_one_pending_idx
  ON public.operational_requests(session_id, request_type)
  WHERE status = 'pending' AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operational_requests_tenant_status_idx
  ON public.operational_requests(restaurant_id, status, created_at DESC);

-- Persistent inventory foundation. Stock is derived from immutable movements, not a client-side array.
CREATE TABLE IF NOT EXISTS public.inventory_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  category text NOT NULL DEFAULT 'other',
  base_unit text NOT NULL CHECK (base_unit IN ('g','ml','pcs')),
  reorder_level numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level>=0),
  cost_per_unit numeric(14,4) NULL CHECK (cost_per_unit IS NULL OR cost_per_unit>=0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,restaurant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_ingredients_tenant_name_uq
  ON public.inventory_ingredients(restaurant_id,lower(name));

CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES public.inventory_ingredients(id) ON DELETE RESTRICT,
  movement_type text NOT NULL CHECK (movement_type IN ('opening_stock','received','waste','adjustment_in','adjustment_out')),
  quantity_delta numeric(14,3) NOT NULL CHECK (quantity_delta<>0),
  unit text NOT NULL CHECK (unit IN ('g','ml','pcs')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 300),
  actor_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS reference_order_id uuid NULL REFERENCES public.orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reference_order_item_id uuid NULL REFERENCES public.order_items(id) ON DELETE SET NULL;
ALTER TABLE public.inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN ('opening_stock','received','waste','adjustment_in','adjustment_out','sale'));
CREATE UNIQUE INDEX IF NOT EXISTS inventory_sale_item_ingredient_uq
  ON public.inventory_movements(reference_order_item_id,ingredient_id)
  WHERE movement_type='sale' AND reference_order_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_one_opening_stock_uq
  ON public.inventory_movements(ingredient_id) WHERE movement_type='opening_stock';
CREATE INDEX IF NOT EXISTS inventory_movements_tenant_time_idx
  ON public.inventory_movements(restaurant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_ingredient_time_idx
  ON public.inventory_movements(ingredient_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.product_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES public.inventory_ingredients(id) ON DELETE RESTRICT,
  quantity_per_serving numeric(14,4) NOT NULL CHECK (quantity_per_serving>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id,ingredient_id)
);
CREATE INDEX IF NOT EXISTS product_recipes_tenant_product_idx
  ON public.product_recipes(restaurant_id,product_id);

ALTER TABLE public.inventory_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_recipes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_ingredients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inventory_movements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.product_recipes FROM PUBLIC, anon, authenticated;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS cancellation_reason text NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_serving_status_check;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_serving_status_check
  CHECK (serving_status = ANY (ARRAY['pending'::text,'preparing'::text,'ready'::text,'served'::text,'cancelled'::text]));

CREATE TABLE IF NOT EXISTS public.dish_cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  session_id uuid NULL REFERENCES public.dining_sessions(id) ON DELETE SET NULL,
  request_reason text NOT NULL CHECK (length(btrim(request_reason)) BETWEEN 1 AND 300),
  requested_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz NULL,
  decision_reason text NULL,
  item_name_snapshot text NOT NULL,
  quantity_snapshot integer NOT NULL,
  item_status_snapshot text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS dish_cancellation_one_pending_idx
  ON public.dish_cancellation_requests(order_item_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS dish_cancellation_tenant_status_idx
  ON public.dish_cancellation_requests(restaurant_id, status, requested_at DESC);

-- Expand the legacy event table into a useful, backward-compatible audit log.
ALTER TABLE public.security_logs
  ADD COLUMN IF NOT EXISTS actor_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_table text NULL,
  ADD COLUMN IF NOT EXISTS target_id text NULL,
  ADD COLUMN IF NOT EXISTS reason text NULL,
  ADD COLUMN IF NOT EXISTS before_state jsonb NULL,
  ADD COLUMN IF NOT EXISTS after_state jsonb NULL,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Copy the existing Admin PIN hash into the panel credential store. No PIN is generated
-- or exposed by this migration; other panel PINs are set by the Admin after unlocking.
INSERT INTO public.panel_pin_credentials (restaurant_id, panel_id, pin_hash, updated_by)
SELECT r.id, 'admin', r.admin_pin_hash, r.owner_id
FROM public.restaurants r
WHERE COALESCE(r.admin_pin_hash, '') <> ''
ON CONFLICT (restaurant_id, panel_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash,updated_at=now(),updated_by=EXCLUDED.updated_by;

-- Non-zero random salts make the existing daily table PIN calculation independent of
-- predictable table/tenant identifiers. This changes the displayed daily PIN; Admin can
-- immediately retrieve the new PIN using the protected RPC after deployment.
UPDATE public.tables
SET pin_salt = (floor(random() * 2147483646)::integer + 1), updated_at = now()
WHERE COALESCE(pin_salt, 0) = 0;

-- Public sign-up cannot create a restaurant tenant by itself. The operator must
-- pre-authorize the email in restaurant_provisioning_allowlist before creating the Auth user.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_allowed_email text;
BEGIN
  DELETE FROM public.restaurant_provisioning_allowlist a
  WHERE lower(a.email)=lower(COALESCE(NEW.email,'')) AND a.expires_at>now()
  RETURNING a.email INTO v_allowed_email;
  IF v_allowed_email IS NULL THEN
    RAISE EXCEPTION 'Restaurant accounts must be provisioned by the TableForge platform operator.';
  END IF;
  INSERT INTO public.profiles(id,full_name,role)
  VALUES(NEW.id,COALESCE(NEW.raw_user_meta_data->>'full_name',''),'admin')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.restaurants(owner_id,name,slug)
  VALUES(NEW.id,'New Restaurant','tenant-'||substr(NEW.id::text,1,8));
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. RLS and grants for new private tables
-- ---------------------------------------------------------------------------
ALTER TABLE public.panel_pin_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panel_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panel_management_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panel_pin_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dish_cancellation_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS panel_pin_credentials_owner_read ON public.panel_pin_credentials;
CREATE POLICY panel_pin_credentials_owner_read ON public.panel_pin_credentials
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = restaurant_id AND r.owner_id = auth.uid())
  );
DROP POLICY IF EXISTS operational_requests_owner_read ON public.operational_requests;
CREATE POLICY operational_requests_owner_read ON public.operational_requests
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = restaurant_id AND r.owner_id = auth.uid())
  );
DROP POLICY IF EXISTS dish_cancellation_requests_owner_read ON public.dish_cancellation_requests;
CREATE POLICY dish_cancellation_requests_owner_read ON public.dish_cancellation_requests
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = restaurant_id AND r.owner_id = auth.uid())
  );

REVOKE ALL ON public.panel_pin_credentials FROM anon, authenticated;
REVOKE ALL ON public.panel_access_tokens FROM anon, authenticated;
REVOKE ALL ON public.panel_management_tokens FROM anon, authenticated;
REVOKE ALL ON public.panel_pin_attempts FROM anon, authenticated;
REVOKE ALL ON public.operational_requests FROM anon, authenticated;
REVOKE ALL ON public.dish_cancellation_requests FROM anon, authenticated;
REVOKE ALL ON public.security_logs FROM anon, authenticated;
GRANT SELECT ON public.panel_pin_credentials TO authenticated;
GRANT SELECT ON public.operational_requests TO authenticated;
GRANT SELECT ON public.dish_cancellation_requests TO authenticated;

CREATE OR REPLACE FUNCTION public._tableforge_audit_event(
  p_restaurant_id uuid,
  p_event_type text,
  p_target_table text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_before jsonb DEFAULT NULL,
  p_after jsonb DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
BEGIN
  IF p_restaurant_id IS NULL OR COALESCE(btrim(p_event_type), '') = '' THEN
    RAISE EXCEPTION 'Audit event requires restaurant and event type.';
  END IF;
  INSERT INTO public.security_logs
    (restaurant_id, event_type, actor_id, target_table, target_id, reason, before_state, after_state, metadata)
  VALUES
    (p_restaurant_id, left(p_event_type, 120), auth.uid(), p_target_table, p_target_id,
     NULLIF(left(btrim(COALESCE(p_reason,'')), 500), ''), p_before, p_after, COALESCE(p_metadata,'{}'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public._tableforge_validate_panel_token(
  p_panel_token text,
  p_allowed_panels text[]
) RETURNS TABLE(restaurant_id uuid, owner_id uuid, panel_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
  SELECT pat.restaurant_id, pat.owner_id, pat.panel_id
  FROM public.panel_access_tokens pat
  JOIN public.restaurants r ON r.id = pat.restaurant_id AND r.owner_id = pat.owner_id
  WHERE auth.uid() IS NOT NULL
    AND pat.owner_id = auth.uid()
    AND pat.token_hash = encode(digest(COALESCE(p_panel_token,''), 'sha256'), 'hex')
    AND pat.revoked_at IS NULL
    AND pat.expires_at > now()
    AND pat.panel_id = ANY(COALESCE(p_allowed_panels, ARRAY[]::text[]))
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public._tableforge_validate_management_token(p_management_token text)
RETURNS TABLE(restaurant_id uuid, owner_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
  SELECT mt.restaurant_id, mt.owner_id
  FROM public.panel_management_tokens mt
  JOIN public.restaurants r ON r.id = mt.restaurant_id AND r.owner_id = mt.owner_id
  WHERE auth.uid() IS NOT NULL
    AND mt.owner_id = auth.uid()
    AND mt.token_hash = encode(digest(COALESCE(p_management_token,''), 'sha256'), 'hex')
    AND mt.revoked_at IS NULL
    AND mt.expires_at > now()
  LIMIT 1
$function$;

-- ---------------------------------------------------------------------------
-- 3. Panel PIN verification and PIN management
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_panel_pin(p_panel_id text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_hash text;
  v_token text;
  v_expires timestamptz;
  v_failures integer;
  v_first_setup boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;
  IF p_panel_id IS NULL OR p_panel_id NOT IN ('captain','kot','cashier','manager','admin')
     OR p_pin IS NULL OR p_pin !~ '^[0-9]{6}$' THEN
    RETURN jsonb_build_object('ok',false);
  END IF;

  SELECT r.id INTO v_restaurant_id FROM public.restaurants r WHERE r.owner_id = auth.uid() LIMIT 1;
  IF v_restaurant_id IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;

  SELECT count(*) INTO v_failures
  FROM public.panel_pin_attempts a
  WHERE a.owner_id = auth.uid() AND a.panel_id = p_panel_id
    AND NOT a.succeeded AND a.attempted_at > now() - interval '15 minutes';
  IF v_failures >= 5 THEN
    INSERT INTO public.panel_pin_attempts(restaurant_id,owner_id,panel_id,succeeded)
    VALUES(v_restaurant_id,auth.uid(),p_panel_id,false);
    RETURN jsonb_build_object('ok',false,'message','PIN verification failed');
  END IF;

  SELECT c.pin_hash INTO v_hash FROM public.panel_pin_credentials c
  WHERE c.restaurant_id = v_restaurant_id AND c.panel_id = p_panel_id;
  IF COALESCE(v_hash,'') = '' AND p_panel_id='admin' THEN
    SELECT r.admin_pin_hash INTO v_hash FROM public.restaurants r WHERE r.id=v_restaurant_id AND r.owner_id=auth.uid();
  END IF;

  IF COALESCE(v_hash,'') = '' AND p_panel_id='admin' THEN
    IF EXISTS (SELECT 1 FROM public.panel_pin_credentials c WHERE c.restaurant_id=v_restaurant_id AND c.panel_id<>'admin' AND public._tableforge_verify_pin_hash(p_pin,c.pin_hash)) THEN
      INSERT INTO public.panel_pin_attempts(restaurant_id,owner_id,panel_id,succeeded)
      VALUES(v_restaurant_id,auth.uid(),p_panel_id,false);
      RETURN jsonb_build_object('ok',false,'message','PIN verification failed');
    END IF;
    -- First Admin PIN for a newly operator-provisioned tenant: the owner chooses it now.
    v_hash := public._tableforge_hash_pin(p_pin);
    UPDATE public.restaurants SET admin_pin_hash=v_hash,admin_pin=NULL,updated_at=now()
    WHERE id=v_restaurant_id AND owner_id=auth.uid() AND COALESCE(admin_pin_hash,'')='';
    IF NOT FOUND THEN
      INSERT INTO public.panel_pin_attempts(restaurant_id,owner_id,panel_id,succeeded)
      VALUES(v_restaurant_id,auth.uid(),p_panel_id,false);
      RETURN jsonb_build_object('ok',false,'message','PIN verification failed');
    END IF;
    INSERT INTO public.panel_pin_credentials(restaurant_id,panel_id,pin_hash,updated_by)
    VALUES(v_restaurant_id,'admin',v_hash,auth.uid())
    ON CONFLICT (restaurant_id,panel_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash,updated_at=now(),updated_by=EXCLUDED.updated_by;
    v_first_setup := true;
    PERFORM public._tableforge_audit_event(v_restaurant_id,'admin_pin_initial_setup','panel_pin_credentials','admin',NULL,NULL,jsonb_build_object('configured',true));
  ELSIF COALESCE(v_hash,'') = '' OR NOT public._tableforge_verify_pin_hash(p_pin,v_hash) THEN
    INSERT INTO public.panel_pin_attempts(restaurant_id,owner_id,panel_id,succeeded)
    VALUES(v_restaurant_id,auth.uid(),p_panel_id,false);
    PERFORM public._tableforge_audit_event(v_restaurant_id,'panel_pin_verification_failed','panel_pin_credentials',p_panel_id,NULL,NULL,NULL,jsonb_build_object('panel_id',p_panel_id));
    RETURN jsonb_build_object('ok',false,'message','PIN verification failed');
  END IF;

  INSERT INTO public.panel_pin_attempts(restaurant_id,owner_id,panel_id,succeeded)
  VALUES(v_restaurant_id,auth.uid(),p_panel_id,true);
  v_token := encode(gen_random_bytes(32),'hex');
  v_expires := now() + interval '20 minutes';
  INSERT INTO public.panel_access_tokens(token_hash,restaurant_id,owner_id,panel_id,expires_at)
  VALUES(encode(digest(v_token,'sha256'),'hex'),v_restaurant_id,auth.uid(),p_panel_id,v_expires);
  PERFORM public._tableforge_audit_event(v_restaurant_id,'panel_pin_verified','panel_access_tokens',p_panel_id,NULL,NULL,NULL,jsonb_build_object('panel_id',p_panel_id,'expires_at',v_expires));
  RETURN jsonb_build_object('ok',true,'panel_token',v_token,'expires_at',v_expires,'first_setup',v_first_setup);
END;
$function$;

CREATE OR REPLACE FUNCTION public.authorize_panel_pin_management(p_restaurant_id uuid, p_current_admin_pin text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_hash text;
  v_failures integer;
  v_token text;
  v_expires timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_current_admin_pin IS NULL OR p_current_admin_pin !~ '^[0-9]{6}$' THEN
    RETURN jsonb_build_object('ok',false);
  END IF;
  SELECT r.id,r.admin_pin_hash INTO v_restaurant_id,v_hash
  FROM public.restaurants r
  WHERE r.id = p_restaurant_id AND r.owner_id = auth.uid();
  IF v_restaurant_id IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;

  SELECT count(*) INTO v_failures FROM public.panel_pin_attempts a
  WHERE a.owner_id=auth.uid() AND a.panel_id='admin_management'
    AND NOT a.succeeded AND a.attempted_at > now()-interval '15 minutes';
  IF v_failures >= 5 THEN
    INSERT INTO public.panel_pin_attempts(restaurant_id,owner_id,panel_id,succeeded)
    VALUES(v_restaurant_id,auth.uid(),'admin_management',false);
    RETURN jsonb_build_object('ok',false);
  END IF;
  IF COALESCE(v_hash,'') = '' OR NOT public._tableforge_verify_pin_hash(p_current_admin_pin,v_hash) THEN
    INSERT INTO public.panel_pin_attempts(restaurant_id,owner_id,panel_id,succeeded)
    VALUES(v_restaurant_id,auth.uid(),'admin_management',false);
    PERFORM public._tableforge_audit_event(v_restaurant_id,'admin_pin_management_verification_failed','panel_management_tokens',NULL,NULL,NULL,NULL,'{}'::jsonb);
    RETURN jsonb_build_object('ok',false);
  END IF;

  INSERT INTO public.panel_pin_attempts(restaurant_id,owner_id,panel_id,succeeded)
  VALUES(v_restaurant_id,auth.uid(),'admin_management',true);
  v_token := encode(gen_random_bytes(32),'hex');
  v_expires := now() + interval '5 minutes';
  INSERT INTO public.panel_management_tokens(token_hash,restaurant_id,owner_id,expires_at)
  VALUES(encode(digest(v_token,'sha256'),'hex'),v_restaurant_id,auth.uid(),v_expires);
  PERFORM public._tableforge_audit_event(v_restaurant_id,'admin_pin_management_authorized','panel_management_tokens',NULL,NULL,NULL,NULL,jsonb_build_object('expires_at',v_expires));
  RETURN jsonb_build_object('ok',true,'management_token',v_token,'expires_at',v_expires);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_panel_pin_statuses(p_management_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_owner_id uuid; v_panels jsonb;
BEGIN
  SELECT x.restaurant_id,x.owner_id INTO v_restaurant_id,v_owner_id
  FROM public._tableforge_validate_management_token(p_management_token) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'PIN management authorization expired or invalid.'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('panel_id',p.panel_id,'configured',c.pin_hash IS NOT NULL) ORDER BY p.panel_id),'[]'::jsonb)
  INTO v_panels
  FROM unnest(ARRAY['admin','captain','cashier','kot','manager']::text[]) AS p(panel_id)
  LEFT JOIN public.panel_pin_credentials c ON c.restaurant_id=v_restaurant_id AND c.panel_id=p.panel_id;
  RETURN jsonb_build_object('ok',true,'panels',v_panels);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_panel_pin(p_management_token text, p_panel_id text, p_new_pin text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_owner_id uuid; v_hash text;
BEGIN
  SELECT x.restaurant_id,x.owner_id INTO v_restaurant_id,v_owner_id
  FROM public._tableforge_validate_management_token(p_management_token) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'PIN management authorization expired or invalid.'; END IF;
  IF p_panel_id IS NULL OR p_panel_id NOT IN ('captain','kot','cashier','manager','admin')
     OR p_new_pin IS NULL OR p_new_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'Select a valid panel and enter exactly six digits.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.panel_pin_credentials c
    WHERE c.restaurant_id=v_restaurant_id AND c.panel_id<>p_panel_id
      AND public._tableforge_verify_pin_hash(p_new_pin,c.pin_hash)
  ) THEN
    RAISE EXCEPTION 'Each staff panel must use a different six-digit PIN.';
  END IF;
  v_hash := public._tableforge_hash_pin(p_new_pin);
  INSERT INTO public.panel_pin_credentials(restaurant_id,panel_id,pin_hash,updated_by)
  VALUES(v_restaurant_id,p_panel_id,v_hash,v_owner_id)
  ON CONFLICT (restaurant_id,panel_id) DO UPDATE
    SET pin_hash=EXCLUDED.pin_hash,updated_at=now(),updated_by=EXCLUDED.updated_by;
  IF p_panel_id='admin' THEN
    UPDATE public.restaurants SET admin_pin_hash=v_hash,admin_pin=NULL,updated_at=now()
    WHERE id=v_restaurant_id AND owner_id=v_owner_id;
    UPDATE public.panel_management_tokens SET revoked_at=now()
    WHERE restaurant_id=v_restaurant_id AND owner_id=v_owner_id AND revoked_at IS NULL;
  END IF;
  UPDATE public.panel_access_tokens SET revoked_at=now()
  WHERE restaurant_id=v_restaurant_id AND panel_id=p_panel_id AND revoked_at IS NULL;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'panel_pin_changed','panel_pin_credentials',p_panel_id,'Admin PIN management',NULL,jsonb_build_object('panel_id',p_panel_id,'configured',true));
  RETURN jsonb_build_object('ok',true,'panel_id',p_panel_id);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Protected KOT, Captain and cashier workflows
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_kot_queue(p_panel_token text)
RETURNS TABLE(
  item_id uuid, order_id uuid, order_number bigint, order_type text,
  table_label text, round_number integer, order_note text,
  order_created_at timestamptz, item_name text, quantity integer,
  serving_status text, cancellation_reason text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['kot','manager']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'KOT panel authorization expired or invalid.'; END IF;
  RETURN QUERY
  SELECT oi.id,o.id,o.order_number,o.order_type::text,t.table_no,o.round_number,o.note,o.created_at,
         oi.name_snapshot,oi.quantity,oi.serving_status,oi.cancellation_reason
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
  LEFT JOIN public.tables t ON t.id=o.table_id AND t.restaurant_id=o.restaurant_id
  WHERE o.restaurant_id=v_restaurant_id
    AND o.status <> 'cancelled'::public.order_status
    AND oi.serving_status IN ('pending','preparing','ready','cancelled')
  ORDER BY o.created_at ASC, o.round_number ASC NULLS FIRST, oi.created_at ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_kot_item_status(p_panel_token text,p_item_id uuid,p_new_status text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_before text; v_order_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['kot','manager']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'KOT panel authorization expired or invalid.'; END IF;
  IF p_new_status NOT IN ('pending','preparing','ready','served') THEN RAISE EXCEPTION 'Unsupported KOT status.'; END IF;
  SELECT oi.serving_status,oi.order_id INTO v_before,v_order_id
  FROM public.order_items oi JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
  WHERE oi.id=p_item_id AND oi.restaurant_id=v_restaurant_id AND o.status <> 'cancelled'::public.order_status
  FOR UPDATE OF oi;
  IF v_order_id IS NULL THEN RAISE EXCEPTION 'Order item not found in this restaurant.'; END IF;
  IF NOT ((v_before='pending' AND p_new_status='preparing') OR
          (v_before='preparing' AND p_new_status IN ('pending','ready')) OR
          (v_before='ready' AND p_new_status IN ('preparing','served'))) THEN
    RAISE EXCEPTION 'Invalid KOT status transition: % to %.',v_before,p_new_status;
  END IF;
  UPDATE public.order_items SET serving_status=p_new_status WHERE id=p_item_id;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'kot_item_status_changed','order_items',p_item_id::text,NULL,
    jsonb_build_object('serving_status',v_before),jsonb_build_object('serving_status',p_new_status));
  RETURN jsonb_build_object('ok',true,'item_id',p_item_id,'serving_status',p_new_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_captain(p_table_id uuid,p_session_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_session public.dining_sessions%ROWTYPE; v_request_id uuid;
BEGIN
  IF p_table_id IS NULL OR COALESCE(btrim(p_session_token),'')='' THEN RAISE EXCEPTION 'A valid table session is required.'; END IF;
  SELECT ds.* INTO v_session
  FROM public.dining_sessions ds
  JOIN public.tables t ON t.id=ds.table_id AND t.restaurant_id=ds.restaurant_id
  WHERE ds.table_id=p_table_id AND ds.session_token::text=p_session_token
    AND ds.status IN ('open','bill_requested','bill_ready') AND t.is_active
  FOR UPDATE OF ds;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'Session is invalid or expired.'; END IF;
  INSERT INTO public.operational_requests(restaurant_id,table_id,session_id,request_type,status,created_by)
  VALUES(v_session.restaurant_id,v_session.table_id,v_session.id,'captain','pending',auth.uid())
  ON CONFLICT (session_id,request_type) WHERE status='pending' AND session_id IS NOT NULL
  DO UPDATE SET updated_at=now()
  RETURNING id INTO v_request_id;
  PERFORM public._tableforge_audit_event(v_session.restaurant_id,'captain_requested','operational_requests',v_request_id::text,NULL,NULL,NULL,jsonb_build_object('table_id',p_table_id,'session_id',v_session.id));
  RETURN jsonb_build_object('ok',true,'request_id',v_request_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_cashier_bill_queue(p_panel_token text)
RETURNS TABLE(
  order_id uuid, session_id uuid, order_type text, order_number bigint,
  table_label text, bill_requested_at timestamptz, billing_status text,
  grand_total numeric, currency_symbol text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['cashier','manager']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Cashier panel authorization expired or invalid.'; END IF;
  RETURN QUERY
  SELECT o.id,NULL::uuid,o.order_type::text,o.order_number,NULL::text,o.bill_requested_at,o.billing_status,o.grand_total,a.currency_symbol
  FROM public.orders o
  LEFT JOIN public.app_settings a ON a.restaurant_id=o.restaurant_id
  WHERE o.restaurant_id=v_restaurant_id AND o.order_type::text='takeaway'
    AND o.status <> 'cancelled'::public.order_status AND o.billing_status IN ('bill_requested','bill_ready')
  UNION ALL
  SELECT NULL::uuid,ds.id,'dine_in'::text,
         (SELECT min(o.order_number) FROM public.orders o WHERE o.session_id=ds.id AND o.restaurant_id=ds.restaurant_id AND o.status <> 'cancelled'::public.order_status),
         t.table_no,ds.bill_requested_at,
         CASE WHEN ds.status='bill_ready' THEN 'bill_ready' ELSE 'bill_requested' END,
         ds.bill_grand_total,a.currency_symbol
  FROM public.dining_sessions ds
  LEFT JOIN public.tables t ON t.id=ds.table_id AND t.restaurant_id=ds.restaurant_id
  LEFT JOIN public.app_settings a ON a.restaurant_id=ds.restaurant_id
  WHERE ds.restaurant_id=v_restaurant_id AND ds.status IN ('bill_requested','bill_ready')
    AND EXISTS (SELECT 1 FROM public.orders o WHERE o.session_id=ds.id AND o.restaurant_id=ds.restaurant_id AND o.status <> 'cancelled'::public.order_status)
  ORDER BY bill_requested_at ASC NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_cashier_bill(p_panel_token text,p_order_id uuid DEFAULT NULL,p_session_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid; v_order public.orders%ROWTYPE; v_session public.dining_sessions%ROWTYPE;
  v_settings jsonb; v_order_json jsonb; v_items jsonb; v_tables jsonb; v_table_label text;
  v_subtotal numeric(12,2); v_cgst numeric(12,2); v_sgst numeric(12,2); v_rounding numeric(12,2); v_total numeric(12,2);
  v_order_number bigint; v_created_at timestamptz; v_type text; v_table_string text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Cashier panel authorization expired or invalid.'; END IF;
  IF (p_order_id IS NULL) = (p_session_id IS NULL) THEN RAISE EXCEPTION 'Provide exactly one order ID or session ID.'; END IF;

  SELECT jsonb_build_object('restaurant_id',a.restaurant_id,'restaurant_name',a.restaurant_name,'upi_id',a.upi_id,'cgst_rate',a.cgst_rate,'sgst_rate',a.sgst_rate,'currency_symbol',a.currency_symbol,'receipt_footer',a.receipt_footer,'gst_number',a.gst_number,'restaurant_address',a.restaurant_address) INTO v_settings FROM public.app_settings a WHERE a.restaurant_id=v_restaurant_id LIMIT 1;
  IF v_settings IS NULL THEN RAISE EXCEPTION 'Restaurant receipt settings are missing.'; END IF;

  IF p_order_id IS NOT NULL THEN
    SELECT o.* INTO v_order FROM public.orders o
    WHERE o.id=p_order_id AND o.restaurant_id=v_restaurant_id AND o.order_type::text='takeaway'
      AND o.status <> 'cancelled'::public.order_status FOR UPDATE;
    IF v_order.id IS NULL THEN RAISE EXCEPTION 'Takeaway order not found or unavailable.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id=v_order.id AND oi.restaurant_id=v_restaurant_id AND oi.serving_status <> 'cancelled') THEN
      RAISE EXCEPTION 'This order has no billable items.';
    END IF;
    UPDATE public.orders SET billing_status='bill_ready',bill_ready_at=COALESCE(bill_ready_at,now()),updated_at=now()
    WHERE id=v_order.id RETURNING * INTO v_order;
    v_type := 'takeaway'; v_table_label := NULL; v_order_number := v_order.order_number; v_created_at := v_order.created_at;
    v_subtotal:=v_order.subtotal; v_cgst:=v_order.cgst; v_sgst:=v_order.sgst; v_rounding:=v_order.rounding; v_total:=v_order.grand_total;
    v_order_json := to_jsonb(v_order);
    v_items := COALESCE((SELECT jsonb_agg(jsonb_build_object('id',oi.id,'order_id',oi.order_id,'name',oi.name_snapshot,'name_snapshot',oi.name_snapshot,'unit_price',oi.unit_price,'quantity',oi.quantity,'line_total',oi.line_total,'tax_exempt_snapshot',oi.tax_exempt_snapshot,'round_number',v_order.round_number) ORDER BY oi.created_at)
      FROM public.order_items oi WHERE oi.order_id=v_order.id AND oi.restaurant_id=v_restaurant_id AND oi.serving_status <> 'cancelled'),'[]'::jsonb);
    v_tables := '[]'::jsonb; v_table_string := 'Takeaway #'||v_order.order_number::text;
  ELSE
    SELECT ds.* INTO v_session FROM public.dining_sessions ds
    WHERE ds.id=p_session_id AND ds.restaurant_id=v_restaurant_id AND ds.status IN ('bill_requested','bill_ready') FOR UPDATE;
    IF v_session.id IS NULL THEN RAISE EXCEPTION 'Dine-in bill must be requested before it can be generated.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
      WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status <> 'cancelled'::public.order_status AND oi.serving_status <> 'cancelled') THEN
      RAISE EXCEPTION 'This session has no billable items.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
      WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status <> 'cancelled'::public.order_status AND oi.serving_status NOT IN ('served','cancelled')) THEN
      RAISE EXCEPTION 'All billable items must be served before generating the final bill.';
    END IF;
    UPDATE public.dining_sessions SET status='bill_ready',bill_ready_at=COALESCE(bill_ready_at,now()),updated_at=now()
    WHERE id=v_session.id RETURNING * INTO v_session;
    UPDATE public.orders SET billing_status='bill_ready',bill_ready_at=COALESCE(bill_ready_at,now()),updated_at=now()
    WHERE session_id=v_session.id AND restaurant_id=v_restaurant_id AND status <> 'cancelled'::public.order_status;
    SELECT COALESCE(sum(o.subtotal),0),COALESCE(sum(o.cgst),0),COALESCE(sum(o.sgst),0),COALESCE(sum(o.rounding),0),COALESCE(sum(o.grand_total),0),min(o.order_number),min(o.created_at)
    INTO v_subtotal,v_cgst,v_sgst,v_rounding,v_total,v_order_number,v_created_at
    FROM public.orders o WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status <> 'cancelled'::public.order_status;
    SELECT t.table_no INTO v_table_label FROM public.tables t WHERE t.id=v_session.table_id AND t.restaurant_id=v_restaurant_id;
    UPDATE public.dining_sessions SET
      bill_subtotal=v_subtotal,bill_cgst=v_cgst,bill_sgst=v_sgst,bill_rounding=v_rounding,bill_grand_total=v_total,
      bill_cgst_rate=COALESCE((v_settings->>'cgst_rate')::numeric,0),
      bill_sgst_rate=COALESCE((v_settings->>'sgst_rate')::numeric,0),updated_at=now()
    WHERE id=v_session.id AND restaurant_id=v_restaurant_id RETURNING * INTO v_session;
    v_type := 'dine_in'; v_table_string := 'Dine-in · Table '||COALESCE(v_table_label,'—');
    v_order_json := jsonb_build_object('id',v_session.id,'order_number',v_order_number,'order_type','dine_in','table_id',v_session.table_id,'session_id',v_session.id,'created_at',v_created_at,'subtotal',v_subtotal,'cgst',v_cgst,'sgst',v_sgst,'rounding',v_rounding,'grand_total',v_total,'billing_status','bill_ready','payment_status',v_session.payment_status);
    v_items := COALESCE((SELECT jsonb_agg(jsonb_build_object('id',oi.id,'order_id',o.id,'order_number',o.order_number,'order_type',o.order_type::text,'round_number',o.round_number,'name',oi.name_snapshot,'name_snapshot',oi.name_snapshot,'unit_price',oi.unit_price,'quantity',oi.quantity,'line_total',oi.line_total,'tax_exempt_snapshot',oi.tax_exempt_snapshot) ORDER BY o.round_number,o.created_at,oi.created_at)
      FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
      WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status <> 'cancelled'::public.order_status AND oi.serving_status <> 'cancelled'),'[]'::jsonb);
    v_tables := COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.tables t WHERE t.id=v_session.table_id AND t.restaurant_id=v_restaurant_id),'[]'::jsonb);
  END IF;

  -- Settings aliases consumed by the shared receipt renderer.
  v_settings := v_settings || jsonb_build_object('cgst_rate',COALESCE((v_settings->>'cgst_rate')::numeric,0),'sgst_rate',COALESCE((v_settings->>'sgst_rate')::numeric,0));
  PERFORM public._tableforge_audit_event(v_restaurant_id,'bill_generated',CASE WHEN p_order_id IS NOT NULL THEN 'orders' ELSE 'dining_sessions' END,COALESCE(p_order_id,p_session_id)::text,NULL,NULL,NULL,jsonb_build_object('order_type',v_type,'grand_total',v_total));
  RETURN jsonb_build_object('ok',true,'order',v_order_json,'items',v_items,'settings',v_settings,'tables',v_tables,'table_label',v_table_label,'table_string',v_table_string);
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_takeaway_bill(p_order_id uuid,p_panel_token text)
RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_order public.orders%ROWTYPE;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Cashier panel authorization expired or invalid.'; END IF;
  UPDATE public.orders o SET billing_status='bill_ready',bill_ready_at=COALESCE(o.bill_ready_at,now()),updated_at=now()
  WHERE o.id=p_order_id AND o.restaurant_id=v_restaurant_id AND o.order_type::text='takeaway'
    AND o.status <> 'cancelled'::public.order_status
  RETURNING o.* INTO v_order;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Takeaway order not found or unavailable.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id=v_order.id AND oi.restaurant_id=v_restaurant_id AND oi.serving_status <> 'cancelled') THEN
    RAISE EXCEPTION 'This order has no billable items.';
  END IF;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'takeaway_bill_generated','orders',v_order.id::text,NULL,NULL,NULL,jsonb_build_object('grand_total',v_order.grand_total));
  RETURN v_order;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Session-bound customer cancellation and Admin approval
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_order_item(p_item_id uuid,p_reason text,p_session_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_item public.order_items%ROWTYPE; v_order public.orders%ROWTYPE; v_session public.dining_sessions%ROWTYPE; v_restaurant_id uuid;
BEGIN
  IF COALESCE(length(btrim(p_reason)),0)=0 OR length(p_reason)>300 THEN RAISE EXCEPTION 'A cancellation reason of 1–300 characters is required.'; END IF;
  SELECT oi.* INTO v_item FROM public.order_items oi WHERE oi.id=p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Order item not found.'; END IF;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id=v_item.order_id AND o.restaurant_id=v_item.restaurant_id FOR UPDATE;
  IF v_order.id IS NULL OR v_order.session_id IS NULL THEN RAISE EXCEPTION 'Only a valid dine-in session item can be cancelled here.'; END IF;
  SELECT ds.* INTO v_session FROM public.dining_sessions ds WHERE ds.id=v_order.session_id AND ds.restaurant_id=v_order.restaurant_id AND ds.session_token::text=p_session_token AND ds.status <> 'closed' FOR UPDATE;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'Session is invalid or expired.'; END IF;
  IF v_item.serving_status <> 'pending' THEN RAISE EXCEPTION 'Only pending dishes can be cancelled directly; preparing/ready dishes require Admin approval.'; END IF;
  UPDATE public.order_items SET serving_status='cancelled',cancellation_reason=btrim(p_reason),cancelled_at=now(),cancelled_by=auth.uid() WHERE id=p_item_id;
  PERFORM public._tableforge_recalculate_order(v_order.id);
  PERFORM public._tableforge_audit_event(v_order.restaurant_id,'dish_cancelled','order_items',p_item_id::text,btrim(p_reason),to_jsonb(v_item),jsonb_build_object('serving_status','cancelled','cancellation_reason',btrim(p_reason)));
  RETURN jsonb_build_object('ok',true,'item_id',p_item_id,'status','cancelled');
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_dish_cancellation(p_item_id uuid,p_reason text,p_session_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_item public.order_items%ROWTYPE; v_order public.orders%ROWTYPE; v_session public.dining_sessions%ROWTYPE; v_request_id uuid;
BEGIN
  IF COALESCE(length(btrim(p_reason)),0)=0 OR length(p_reason)>300 THEN RAISE EXCEPTION 'A cancellation reason of 1–300 characters is required.'; END IF;
  SELECT oi.* INTO v_item FROM public.order_items oi WHERE oi.id=p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Order item not found.'; END IF;
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id=v_item.order_id AND o.restaurant_id=v_item.restaurant_id FOR UPDATE;
  IF v_order.id IS NULL OR v_order.session_id IS NULL THEN RAISE EXCEPTION 'Only a valid dine-in session item can be requested here.'; END IF;
  SELECT ds.* INTO v_session FROM public.dining_sessions ds WHERE ds.id=v_order.session_id AND ds.restaurant_id=v_order.restaurant_id AND ds.session_token::text=p_session_token AND ds.status <> 'closed' FOR UPDATE;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'Session is invalid or expired.'; END IF;
  IF v_item.serving_status NOT IN ('preparing','ready') THEN RAISE EXCEPTION 'Only preparing or ready dishes require an Admin cancellation request.'; END IF;
  INSERT INTO public.dish_cancellation_requests(restaurant_id,order_id,order_item_id,session_id,request_reason,requested_by,item_name_snapshot,quantity_snapshot,item_status_snapshot)
  VALUES(v_order.restaurant_id,v_order.id,v_item.id,v_order.session_id,btrim(p_reason),auth.uid(),v_item.name_snapshot,v_item.quantity,v_item.serving_status)
  RETURNING id INTO v_request_id;
  PERFORM public._tableforge_audit_event(v_order.restaurant_id,'dish_cancellation_requested','dish_cancellation_requests',v_request_id::text,btrim(p_reason),NULL,jsonb_build_object('order_item_id',v_item.id,'status','pending'));
  RETURN jsonb_build_object('ok',true,'request_id',v_request_id,'status','pending');
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok',false,'message','A cancellation request is already pending for this dish.');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_cancellation_requests(p_restaurant_id uuid,p_panel_token text)
RETURNS TABLE(
  request_id uuid, order_type text, order_number bigint, table_label text,
  item_name text, quantity integer, item_status text, request_reason text,
  requested_at timestamptz, requested_by_label text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL OR v_restaurant_id <> p_restaurant_id THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  RETURN QUERY
  SELECT cr.id,o.order_type::text,o.order_number,t.table_no,cr.item_name_snapshot,cr.quantity_snapshot,cr.item_status_snapshot,cr.request_reason,cr.requested_at,
         COALESCE(p.full_name,'Staff')
  FROM public.dish_cancellation_requests cr
  JOIN public.orders o ON o.id=cr.order_id AND o.restaurant_id=cr.restaurant_id
  LEFT JOIN public.tables t ON t.id=o.table_id AND t.restaurant_id=o.restaurant_id
  LEFT JOIN public.profiles p ON p.id=cr.requested_by
  WHERE cr.restaurant_id=v_restaurant_id AND cr.status='pending'
  ORDER BY cr.requested_at ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.decide_dish_cancellation(p_restaurant_id uuid,p_request_id uuid,p_decision text,p_reason text,p_panel_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_request public.dish_cancellation_requests%ROWTYPE; v_item public.order_items%ROWTYPE;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL OR v_restaurant_id<>p_restaurant_id THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF p_decision NOT IN ('approve','reject') OR COALESCE(length(btrim(p_reason)),0)=0 OR length(p_reason)>500 THEN
    RAISE EXCEPTION 'Decision must be approve/reject and include a reason.';
  END IF;
  SELECT cr.* INTO v_request FROM public.dish_cancellation_requests cr
  WHERE cr.id=p_request_id AND cr.restaurant_id=v_restaurant_id AND cr.status='pending' FOR UPDATE;
  IF v_request.id IS NULL THEN RAISE EXCEPTION 'Cancellation request is missing or already decided.'; END IF;
  SELECT oi.* INTO v_item FROM public.order_items oi WHERE oi.id=v_request.order_item_id AND oi.restaurant_id=v_restaurant_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Requested order item no longer exists.'; END IF;
  IF p_decision='approve' THEN
    IF v_item.serving_status NOT IN ('preparing','ready') THEN RAISE EXCEPTION 'Dish status changed; refresh the request before deciding.'; END IF;
    UPDATE public.order_items SET serving_status='cancelled',cancellation_reason=v_request.request_reason,cancelled_at=now(),cancelled_by=auth.uid() WHERE id=v_item.id;
    PERFORM public._tableforge_recalculate_order(v_request.order_id);
  END IF;
  UPDATE public.dish_cancellation_requests SET status=CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END,
    decided_by=auth.uid(),decided_at=now(),decision_reason=btrim(p_reason) WHERE id=v_request.id;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'dish_cancellation_'||p_decision,'dish_cancellation_requests',v_request.id::text,btrim(p_reason),to_jsonb(v_request),jsonb_build_object('status',CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END,'order_item_id',v_item.id));
  RETURN jsonb_build_object('ok',true,'request_id',v_request.id,'decision',p_decision);
END;
$function$;

-- Internal recalculation keeps snapshots and history, excluding cancelled lines from totals.
CREATE OR REPLACE FUNCTION public._tableforge_recalculate_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_order public.orders%ROWTYPE; v_subtotal numeric(12,2); v_taxable numeric(12,2); v_cgst numeric(12,2); v_sgst numeric(12,2); v_pre numeric(12,2); v_total numeric(12,2); v_rounding numeric(12,2); v_count bigint;
BEGIN
  SELECT o.* INTO v_order FROM public.orders o WHERE o.id=p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found.'; END IF;
  SELECT count(*) FILTER (WHERE oi.serving_status<>'cancelled'),
         COALESCE(sum(oi.unit_price*oi.quantity) FILTER (WHERE oi.serving_status<>'cancelled'),0),
         COALESCE(sum(oi.unit_price*oi.quantity) FILTER (WHERE oi.serving_status<>'cancelled' AND NOT COALESCE(oi.tax_exempt_snapshot,false)),0)
  INTO v_count,v_subtotal,v_taxable FROM public.order_items oi WHERE oi.order_id=v_order.id AND oi.restaurant_id=v_order.restaurant_id;
  v_cgst:=round(v_taxable*v_order.cgst_rate/100.0,2); v_sgst:=round(v_taxable*v_order.sgst_rate/100.0,2);
  v_pre:=round(v_subtotal+v_cgst+v_sgst,2); v_total:=round(v_pre); v_rounding:=round(v_total-v_pre,2);
  UPDATE public.orders SET subtotal=v_subtotal,cgst=v_cgst,sgst=v_sgst,rounding=v_rounding,grand_total=v_total,
    status=CASE WHEN v_count=0 THEN 'cancelled'::public.order_status ELSE status END,updated_at=now()
  WHERE id=v_order.id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Token-gated wrappers for existing operational write RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_pos_order(
  p_restaurant_id uuid,p_order_type text,p_table_id uuid,p_items jsonb,p_note text,p_panel_token text
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_panel_id text; v_order public.orders%ROWTYPE;
BEGIN
  SELECT x.restaurant_id,x.panel_id INTO v_restaurant_id,v_panel_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['captain','cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL OR v_restaurant_id<>p_restaurant_id THEN RAISE EXCEPTION 'Panel authorization expired or invalid.'; END IF;
  IF p_order_type='dine_in' AND v_panel_id NOT IN ('captain','manager','admin') THEN RAISE EXCEPTION 'This panel cannot create dine-in orders.'; END IF;
  IF p_order_type='takeaway' AND v_panel_id NOT IN ('cashier','manager','admin') THEN RAISE EXCEPTION 'This panel cannot create takeaway orders.'; END IF;
  v_order := public.create_pos_order(p_restaurant_id,p_order_type,p_table_id,p_items,p_note);
  RETURN v_order;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_pos_order(p_order_id uuid,p_panel_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id=p_order_id AND o.restaurant_id=v_restaurant_id AND (o.payment_status='paid'::public.payment_status OR o.billing_status='closed')) THEN
    RAISE EXCEPTION 'Paid/closed order history is immutable. Use an audited adjustment/refund workflow.';
  END IF;
  -- Soft cancellation preserves the order and its line-item history.
  UPDATE public.orders SET status='cancelled'::public.order_status,updated_at=now()
  WHERE id=p_order_id AND restaurant_id=v_restaurant_id AND status<>'completed'::public.order_status;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found or cannot be cancelled.'; END IF;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'order_cancelled','orders',p_order_id::text,'Admin cancellation',NULL,jsonb_build_object('status','cancelled'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_order_item(p_item_id uuid,p_panel_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_order_id uuid; v_item public.order_items%ROWTYPE;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  SELECT oi.* INTO v_item FROM public.order_items oi WHERE oi.id=p_item_id AND oi.restaurant_id=v_restaurant_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Order item not found in this restaurant.'; END IF;
  SELECT o.id INTO v_order_id FROM public.orders o WHERE o.id=v_item.order_id AND o.restaurant_id=v_restaurant_id
    AND o.status NOT IN ('completed'::public.order_status,'cancelled'::public.order_status)
    AND o.payment_status<>'paid'::public.payment_status AND o.billing_status<>'closed' FOR UPDATE;
  IF v_order_id IS NULL THEN RAISE EXCEPTION 'Completed, paid, or closed order history cannot be edited.'; END IF;
  IF v_item.serving_status<>'pending' THEN RAISE EXCEPTION 'Only pending items can be cancelled directly.'; END IF;
  UPDATE public.order_items SET serving_status='cancelled',cancellation_reason='Removed by Admin',cancelled_at=now(),cancelled_by=auth.uid() WHERE id=p_item_id;
  PERFORM public._tableforge_recalculate_order(v_order_id);
  PERFORM public._tableforge_audit_event(v_restaurant_id,'admin_item_cancelled','order_items',p_item_id::text,'Removed by Admin',to_jsonb(v_item),jsonb_build_object('serving_status','cancelled'));
  RETURN jsonb_build_object('ok',true,'item_id',p_item_id,'status','cancelled');
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_order_item_status(p_item_id uuid,p_status text,p_panel_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_before text; v_order_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin','manager','kot']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Panel authorization expired or invalid.'; END IF;
  IF p_status NOT IN ('pending','preparing','ready','served') THEN RAISE EXCEPTION 'Invalid item status.'; END IF;
  SELECT oi.serving_status,oi.order_id INTO v_before,v_order_id FROM public.order_items oi
  JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
  WHERE oi.id=p_item_id AND oi.restaurant_id=v_restaurant_id AND o.status<>'cancelled'::public.order_status FOR UPDATE OF oi;
  IF v_order_id IS NULL THEN RAISE EXCEPTION 'Order item not found in this restaurant.'; END IF;
  IF v_before='cancelled' THEN RAISE EXCEPTION 'Cancelled item cannot be served or changed.'; END IF;
  IF NOT ((v_before='pending' AND p_status='preparing') OR (v_before='preparing' AND p_status IN ('pending','ready')) OR (v_before='ready' AND p_status IN ('preparing','served'))) THEN
    RAISE EXCEPTION 'Invalid item status transition: % to %.',v_before,p_status;
  END IF;
  UPDATE public.order_items SET serving_status=p_status WHERE id=p_item_id;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'order_item_status_changed','order_items',p_item_id::text,NULL,jsonb_build_object('serving_status',v_before),jsonb_build_object('serving_status',p_status));
  RETURN jsonb_build_object('ok',true,'item_id',p_item_id,'status',p_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.close_empty_dining_session(p_session_id uuid,p_panel_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_session public.dining_sessions%ROWTYPE;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin','manager','captain']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Panel authorization expired or invalid.'; END IF;
  SELECT ds.* INTO v_session FROM public.dining_sessions ds WHERE ds.id=p_session_id AND ds.restaurant_id=v_restaurant_id AND ds.status<>'closed' FOR UPDATE;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'Session not found or already closed.'; END IF;
  IF EXISTS (SELECT 1 FROM public.orders o WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status<>'cancelled'::public.order_status) THEN
    RAISE EXCEPTION 'This session has orders. Request/settle the bill instead of closing it as empty.';
  END IF;
  UPDATE public.dining_sessions SET status='closed',closed_at=now(),updated_at=now() WHERE id=v_session.id;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'empty_session_closed','dining_sessions',v_session.id::text,NULL,to_jsonb(v_session),jsonb_build_object('status','closed'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_session_payment(p_session_id uuid,p_payment_method text,p_panel_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_session public.dining_sessions%ROWTYPE; v_method text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Cashier/Admin panel authorization expired or invalid.'; END IF;
  v_method:=lower(btrim(COALESCE(p_payment_method,'')));
  IF v_method NOT IN ('upi_qr','cash') THEN RAISE EXCEPTION 'Payment method must be staff-confirmed UPI QR or cash.'; END IF;
  SELECT ds.* INTO v_session FROM public.dining_sessions ds WHERE ds.id=p_session_id AND ds.restaurant_id=v_restaurant_id AND ds.status='bill_ready' FOR UPDATE;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'The bill must be ready before payment can be confirmed.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status<>'cancelled'::public.order_status) THEN RAISE EXCEPTION 'This session has no active orders.'; END IF;
  IF EXISTS (SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
    WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status<>'cancelled'::public.order_status AND oi.serving_status NOT IN ('served','cancelled')) THEN
    RAISE EXCEPTION 'All billable items must be served before payment.';
  END IF;
  UPDATE public.dining_sessions ds SET status='closed',updated_at=now(),payment_status='paid'::public.payment_status,payment_method=v_method,closed_at=now()
  WHERE ds.id=v_session.id;
  UPDATE public.orders o SET status='completed'::public.order_status,payment_status='paid'::public.payment_status,billing_status='closed',updated_at=now()
  WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status<>'cancelled'::public.order_status;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'session_payment_confirmed','dining_sessions',v_session.id::text,NULL,to_jsonb(v_session),jsonb_build_object('payment_method',v_method,'payment_status','paid','status','closed'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_takeaway_payment(p_order_id uuid,p_payment_method text,p_panel_token text)
RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_order public.orders%ROWTYPE; v_method text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Cashier/Admin panel authorization expired or invalid.'; END IF;
  v_method:=lower(btrim(COALESCE(p_payment_method,'')));
  IF v_method NOT IN ('upi_qr','cash') THEN RAISE EXCEPTION 'Payment method must be staff-confirmed UPI QR or cash.'; END IF;
  SELECT o.* INTO v_order FROM public.orders o
  WHERE o.id=p_order_id AND o.restaurant_id=v_restaurant_id AND o.order_type::text='takeaway'
    AND o.billing_status='bill_ready' AND o.status<>'cancelled'::public.order_status
  FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Takeaway bill must be ready before payment can be confirmed.'; END IF;
  IF v_order.payment_status='paid'::public.payment_status OR v_order.billing_status='closed' THEN
    RAISE EXCEPTION 'This takeaway order is already paid and closed.';
  END IF;
  UPDATE public.orders SET status='completed'::public.order_status,payment_status='paid'::public.payment_status,
    billing_status='closed',updated_at=now()
  WHERE id=v_order.id AND restaurant_id=v_restaurant_id RETURNING * INTO v_order;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'takeaway_payment_confirmed','orders',v_order.id::text,NULL,to_jsonb(v_order),
    jsonb_build_object('payment_method',v_method,'payment_status','paid','billing_status','closed'));
  RETURN v_order;
END;
$function$;

-- Panel-protected table PIN lookup and regeneration. Customer-session RPC still uses the
-- old function internally; direct authenticated access is revoked below.
CREATE OR REPLACE FUNCTION public.get_table_daily_pin(p_table_id uuid,p_panel_token text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id=p_table_id AND t.restaurant_id=v_restaurant_id AND t.is_active) THEN
    RAISE EXCEPTION 'Admin panel authorization or table is invalid.';
  END IF;
  RETURN public.get_table_daily_pin(p_table_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.regenerate_table_daily_pin(p_table_id uuid,p_panel_token text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_pin text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  UPDATE public.tables SET pin_salt=(floor(random()*2147483646)::integer+1),updated_at=now()
  WHERE id=p_table_id AND restaurant_id=v_restaurant_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Table not found or inactive.'; END IF;
  v_pin:=public.get_table_daily_pin(p_table_id);
  PERFORM public._tableforge_audit_event(v_restaurant_id,'table_daily_pin_regenerated','tables',p_table_id::text,NULL,NULL,NULL,'{}'::jsonb);
  RETURN v_pin;
END;
$function$;

-- Replace the legacy bill-request body with tenant checks and cancellation-aware totals.
CREATE OR REPLACE FUNCTION public.request_session_bill(p_table_id uuid,p_session_token text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_token uuid; v_session public.dining_sessions%ROWTYPE; v_settings public.app_settings%ROWTYPE; v_order_count bigint;
BEGIN
  IF p_table_id IS NULL THEN RAISE EXCEPTION 'Table ID is required.'; END IF;
  IF auth.uid() IS NOT NULL AND (p_session_token IS NULL OR btrim(p_session_token)='' OR p_session_token='staff_override') THEN
    SELECT ds.* INTO v_session
    FROM public.dining_sessions ds
    JOIN public.restaurants r ON r.id=ds.restaurant_id AND r.owner_id=auth.uid()
    JOIN public.tables t ON t.id=ds.table_id AND t.restaurant_id=ds.restaurant_id
    WHERE ds.table_id=p_table_id AND ds.status IN ('open','bill_requested','bill_ready')
    ORDER BY ds.created_at DESC LIMIT 1 FOR UPDATE OF ds;
  ELSE
    BEGIN v_token:=p_session_token::uuid;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Session token is invalid.'; END;
    SELECT ds.* INTO v_session
    FROM public.dining_sessions ds
    JOIN public.tables t ON t.id=ds.table_id AND t.restaurant_id=ds.restaurant_id AND t.is_active=true
    WHERE ds.table_id=p_table_id AND ds.session_token=v_token
      AND ds.status IN ('open','bill_requested','bill_ready')
    FOR UPDATE OF ds;
  END IF;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'Session is invalid or expired.'; END IF;
  SELECT count(*) INTO v_order_count FROM public.orders o
  WHERE o.session_id=v_session.id AND o.restaurant_id=v_session.restaurant_id AND o.status<>'cancelled'::public.order_status
    AND EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id AND oi.serving_status<>'cancelled');
  IF v_order_count=0 THEN RAISE EXCEPTION 'There are no active billable orders.'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
    WHERE o.session_id=v_session.id AND o.restaurant_id=v_session.restaurant_id AND o.status<>'cancelled'::public.order_status
      AND oi.serving_status NOT IN ('served','cancelled')
  ) THEN RAISE EXCEPTION 'Some items have not been served yet. Please mark all active items as served first.'; END IF;
  SELECT a.* INTO v_settings FROM public.app_settings a WHERE a.restaurant_id=v_session.restaurant_id;
  IF v_settings.restaurant_id IS NULL THEN RAISE EXCEPTION 'Restaurant billing settings are missing.'; END IF;
  UPDATE public.dining_sessions ds SET
    status=CASE WHEN ds.status='bill_ready' THEN 'bill_ready' ELSE 'bill_requested' END,
    bill_requested_at=COALESCE(ds.bill_requested_at,now()),
    bill_subtotal=totals.subtotal,bill_cgst=totals.cgst,bill_sgst=totals.sgst,bill_rounding=totals.rounding,
    bill_grand_total=totals.grand_total,bill_cgst_rate=v_settings.cgst_rate,bill_sgst_rate=v_settings.sgst_rate,updated_at=now()
  FROM (
    SELECT COALESCE(sum(o.subtotal),0)::numeric(12,2) subtotal,COALESCE(sum(o.cgst),0)::numeric(12,2) cgst,
      COALESCE(sum(o.sgst),0)::numeric(12,2) sgst,COALESCE(sum(o.rounding),0)::numeric(12,2) rounding,
      COALESCE(sum(o.grand_total),0)::numeric(12,2) grand_total
    FROM public.orders o WHERE o.session_id=v_session.id AND o.restaurant_id=v_session.restaurant_id AND o.status<>'cancelled'::public.order_status
  ) totals WHERE ds.id=v_session.id;
  UPDATE public.orders SET billing_status=CASE WHEN v_session.status='bill_ready' THEN 'bill_ready' ELSE 'bill_requested' END,
    bill_requested_at=COALESCE(bill_requested_at,now()),bill_requested_by=auth.uid(),updated_at=now()
  WHERE session_id=v_session.id AND restaurant_id=v_session.restaurant_id AND status<>'cancelled'::public.order_status;
END;
$function$;

-- Staff bill requests must carry a live panel grant. Anonymous customers may only
-- request the bill for the session whose random session token they possess.
CREATE OR REPLACE FUNCTION public.request_session_bill(p_table_id uuid,p_session_token text,p_panel_token text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    IF COALESCE(btrim(p_session_token),'')='' THEN RAISE EXCEPTION 'A valid customer session token is required.'; END IF;
    PERFORM public.request_session_bill(p_table_id,p_session_token);
    RETURN;
  END IF;
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['captain','cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.tables t WHERE t.id=p_table_id AND t.restaurant_id=v_restaurant_id
  ) THEN RAISE EXCEPTION 'Panel authorization or table is invalid.'; END IF;
  PERFORM public.request_session_bill(p_table_id,p_session_token);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_settings(p_panel_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_settings jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  SELECT jsonb_build_object('id',a.id,'restaurant_id',a.restaurant_id,'restaurant_name',a.restaurant_name,
    'upi_id',a.upi_id,'cgst_rate',a.cgst_rate,'sgst_rate',a.sgst_rate,'currency_symbol',a.currency_symbol,
    'receipt_footer',a.receipt_footer,'gst_number',a.gst_number,'restaurant_address',a.restaurant_address,'updated_at',a.updated_at)
  INTO v_settings FROM public.app_settings a WHERE a.restaurant_id=v_restaurant_id LIMIT 1;
  IF v_settings IS NULL THEN RAISE EXCEPTION 'Restaurant settings are missing.'; END IF;
  RETURN v_settings;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_operational_settings(p_panel_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_settings jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['captain','cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Operational panel authorization expired or invalid.'; END IF;
  SELECT jsonb_build_object('restaurant_id',a.restaurant_id,'restaurant_name',a.restaurant_name,
    'upi_id',a.upi_id,'cgst_rate',a.cgst_rate,'sgst_rate',a.sgst_rate,'currency_symbol',a.currency_symbol,
    'receipt_footer',a.receipt_footer,'gst_number',a.gst_number,'restaurant_address',a.restaurant_address)
  INTO v_settings FROM public.app_settings a WHERE a.restaurant_id=v_restaurant_id LIMIT 1;
  IF v_settings IS NULL THEN RAISE EXCEPTION 'Restaurant receipt settings are missing.'; END IF;
  RETURN v_settings;
END;
$function$;

-- Public menu bootstrap: table ID is the scope anchor; never accept a client-supplied
-- restaurant ID. This lets us remove broad anonymous SELECT from tenant tables.
CREATE OR REPLACE FUNCTION public.get_public_pos_data(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_table public.tables%ROWTYPE; v_settings jsonb; v_products jsonb; v_cuisines jsonb; v_restaurant public.restaurants%ROWTYPE;
BEGIN
  IF p_table_id IS NULL THEN RAISE EXCEPTION 'A valid table QR is required.'; END IF;
  SELECT t.* INTO v_table FROM public.tables t WHERE t.id=p_table_id AND t.is_active=true;
  IF v_table.id IS NULL THEN RAISE EXCEPTION 'Table not found or inactive.'; END IF;
  SELECT r.* INTO v_restaurant FROM public.restaurants r WHERE r.id=v_table.restaurant_id;
  IF v_restaurant.id IS NULL THEN RAISE EXCEPTION 'Restaurant not found.'; END IF;
  SELECT jsonb_build_object(
    'restaurant_id',a.restaurant_id,'restaurant_name',a.restaurant_name,
    'cgst_rate',a.cgst_rate,'sgst_rate',a.sgst_rate,'currency_symbol',a.currency_symbol,
    'receipt_footer',a.receipt_footer
  ) INTO v_settings FROM public.app_settings a WHERE a.restaurant_id=v_table.restaurant_id LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'description',p.description,'category',p.category,
    'price',p.price,'tax_exempt',p.tax_exempt,'image_url',p.image_url,
    'is_active',p.is_active,'sort_order',p.sort_order,'restaurant_id',p.restaurant_id,'is_veg',p.is_veg
  ) ORDER BY p.sort_order,p.name),'[]'::jsonb) INTO v_products
  FROM public.products p WHERE p.restaurant_id=v_table.restaurant_id AND p.is_active=true;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',c.id,'name',c.name,'image_url',c.image_url,'sort_order',c.sort_order,'restaurant_id',c.restaurant_id
  ) ORDER BY c.sort_order,c.name),'[]'::jsonb) INTO v_cuisines
  FROM public.cuisines c WHERE c.restaurant_id=v_table.restaurant_id;
  RETURN jsonb_build_object(
    'restaurant_id',v_restaurant.id,
    'restaurant',jsonb_build_object('id',v_restaurant.id,'name',v_restaurant.name,'slug',v_restaurant.slug,
      'icon_url',v_restaurant.icon_url,'logo_url',v_restaurant.logo_url,
      'background_color',v_restaurant.background_color,'foreground_color',v_restaurant.foreground_color),
    'settings',COALESCE(v_settings,'{}'::jsonb),
    'products',COALESCE(v_products,'[]'::jsonb),
    'tables',jsonb_build_array(jsonb_build_object('id',v_table.id,'table_no',v_table.table_no,'capacity',v_table.capacity,'is_active',v_table.is_active,'restaurant_id',v_table.restaurant_id)),
    'cuisines',COALESCE(v_cuisines,'[]'::jsonb)
  );
END;
$function$;

-- Single Admin-only mutation gateway for tenant configuration and master data.
-- This replaces direct authenticated table writes so panel PIN grants are enforced server-side.
CREATE OR REPLACE FUNCTION public.admin_mutate_resource(
  p_panel_token text,p_resource text,p_action text,p_record_id uuid,p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid; v_id uuid; v_record jsonb; v_name text; v_price numeric; v_table_no text;
  v_capacity integer; v_is_active boolean; v_bg text; v_fg text; v_url text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF p_resource NOT IN ('products','cuisines','tables','settings','branding') THEN RAISE EXCEPTION 'Unsupported resource.'; END IF;
  IF p_action NOT IN ('insert','update','delete','save') THEN RAISE EXCEPTION 'Unsupported action.'; END IF;
  v_id := COALESCE(p_record_id,NULLIF(p_payload->>'id','')::uuid,gen_random_uuid());

  IF p_resource='products' THEN
    IF p_action='delete' THEN
      UPDATE public.products SET is_active=false,updated_at=now() WHERE id=v_id AND restaurant_id=v_restaurant_id RETURNING to_jsonb(products) INTO v_record;
      IF v_record IS NULL THEN RAISE EXCEPTION 'Product not found.'; END IF;
    ELSIF p_action IN ('insert','update') THEN
      v_name:=btrim(COALESCE(p_payload->>'name','')); v_price:=NULLIF(p_payload->>'price','')::numeric;
      IF v_name='' OR length(v_name)>160 OR v_price IS NULL OR v_price<0 THEN RAISE EXCEPTION 'Product name and non-negative price are required.'; END IF;
      IF p_action='insert' THEN
        INSERT INTO public.products(id,restaurant_id,name,description,category,price,tax_exempt,image_url,is_active,sort_order,created_by,is_veg)
        VALUES(v_id,v_restaurant_id,v_name,NULLIF(p_payload->>'description',''),NULLIF(p_payload->>'category',''),v_price,
          COALESCE((p_payload->>'tax_exempt')::boolean,false),NULLIF(p_payload->>'image_url',''),COALESCE((p_payload->>'is_active')::boolean,true),
          COALESCE(NULLIF(p_payload->>'sort_order','')::integer,0),auth.uid(),COALESCE((p_payload->>'is_veg')::boolean,true))
        RETURNING to_jsonb(products) INTO v_record;
      ELSE
        UPDATE public.products SET name=v_name,description=NULLIF(p_payload->>'description',''),category=NULLIF(p_payload->>'category',''),price=v_price,
          tax_exempt=COALESCE((p_payload->>'tax_exempt')::boolean,false),image_url=NULLIF(p_payload->>'image_url',''),
          is_active=COALESCE((p_payload->>'is_active')::boolean,true),is_veg=COALESCE((p_payload->>'is_veg')::boolean,true),updated_at=now()
        WHERE id=v_id AND restaurant_id=v_restaurant_id RETURNING to_jsonb(products) INTO v_record;
        IF v_record IS NULL THEN RAISE EXCEPTION 'Product not found.'; END IF;
      END IF;
    ELSE RAISE EXCEPTION 'Invalid product action.';
    END IF;

  ELSIF p_resource='cuisines' THEN
    IF p_action='delete' THEN
      DELETE FROM public.cuisines WHERE id=v_id AND restaurant_id=v_restaurant_id RETURNING to_jsonb(cuisines) INTO v_record;
      IF v_record IS NULL THEN RAISE EXCEPTION 'Category not found.'; END IF;
    ELSIF p_action IN ('insert','update') THEN
      v_name:=btrim(COALESCE(p_payload->>'name',''));
      IF v_name='' OR length(v_name)>100 THEN RAISE EXCEPTION 'Category name is required.'; END IF;
      IF p_action='insert' THEN
        INSERT INTO public.cuisines(id,restaurant_id,name,image_url,sort_order)
        VALUES(v_id,v_restaurant_id,v_name,NULLIF(p_payload->>'image_url',''),COALESCE(NULLIF(p_payload->>'sort_order','')::integer,0))
        RETURNING to_jsonb(cuisines) INTO v_record;
      ELSE
        UPDATE public.cuisines SET name=v_name,image_url=NULLIF(p_payload->>'image_url',''),sort_order=COALESCE(NULLIF(p_payload->>'sort_order','')::integer,0),updated_at=now()
        WHERE id=v_id AND restaurant_id=v_restaurant_id RETURNING to_jsonb(cuisines) INTO v_record;
        IF v_record IS NULL THEN RAISE EXCEPTION 'Category not found.'; END IF;
      END IF;
    ELSE RAISE EXCEPTION 'Invalid category action.';
    END IF;

  ELSIF p_resource='tables' THEN
    IF p_action='delete' THEN
      IF EXISTS (SELECT 1 FROM public.dining_sessions ds WHERE ds.table_id=v_id AND ds.restaurant_id=v_restaurant_id AND ds.status<>'closed') THEN
        RAISE EXCEPTION 'A table with an open session cannot be deactivated.';
      END IF;
      UPDATE public.tables SET is_active=false,updated_at=now() WHERE id=v_id AND restaurant_id=v_restaurant_id RETURNING to_jsonb(tables) INTO v_record;
      IF v_record IS NULL THEN RAISE EXCEPTION 'Table not found.'; END IF;
    ELSIF p_action IN ('insert','update') THEN
      v_table_no:=btrim(COALESCE(p_payload->>'table_no','')); v_capacity:=NULLIF(p_payload->>'capacity','')::integer;
      v_is_active:=COALESCE((p_payload->>'is_active')::boolean,true);
      IF v_table_no='' OR length(v_table_no)>30 OR v_capacity IS NULL OR v_capacity<1 OR v_capacity>100 THEN RAISE EXCEPTION 'Valid table number and capacity are required.'; END IF;
      IF p_action='insert' THEN
        INSERT INTO public.tables(id,restaurant_id,table_no,capacity,is_active,qr_token,pin_salt)
        VALUES(v_id,v_restaurant_id,v_table_no,v_capacity,v_is_active,gen_random_uuid(),(floor(random()*2147483646)::integer+1))
        RETURNING to_jsonb(tables) INTO v_record;
      ELSE
        IF NOT v_is_active AND EXISTS (SELECT 1 FROM public.dining_sessions ds WHERE ds.table_id=v_id AND ds.restaurant_id=v_restaurant_id AND ds.status<>'closed') THEN
          RAISE EXCEPTION 'A table with an open session cannot be deactivated.';
        END IF;
        UPDATE public.tables SET table_no=v_table_no,capacity=v_capacity,is_active=v_is_active,updated_at=now()
        WHERE id=v_id AND restaurant_id=v_restaurant_id RETURNING to_jsonb(tables) INTO v_record;
        IF v_record IS NULL THEN RAISE EXCEPTION 'Table not found.'; END IF;
      END IF;
    ELSE RAISE EXCEPTION 'Invalid table action.';
    END IF;

  ELSIF p_resource='settings' THEN
    v_id:=v_restaurant_id;
    IF p_action NOT IN ('save','update','insert') THEN RAISE EXCEPTION 'Invalid settings action.'; END IF;
    v_name:=btrim(COALESCE(p_payload->>'restaurant_name',''));
    IF v_name='' OR length(v_name)>160 THEN RAISE EXCEPTION 'Restaurant name is required.'; END IF;
    IF COALESCE(NULLIF(p_payload->>'cgst_rate','')::numeric,0)<0 OR COALESCE(NULLIF(p_payload->>'cgst_rate','')::numeric,0)>100
       OR COALESCE(NULLIF(p_payload->>'sgst_rate','')::numeric,0)<0 OR COALESCE(NULLIF(p_payload->>'sgst_rate','')::numeric,0)>100 THEN
      RAISE EXCEPTION 'Tax rates must be between 0 and 100.';
    END IF;
    INSERT INTO public.app_settings(restaurant_id,restaurant_name,upi_id,cgst_rate,sgst_rate,currency_symbol,receipt_footer,gst_number,restaurant_address,daily_pin,updated_at,updated_by)
    VALUES(v_restaurant_id,v_name,COALESCE(p_payload->>'upi_id',''),COALESCE(NULLIF(p_payload->>'cgst_rate','')::numeric,0),COALESCE(NULLIF(p_payload->>'sgst_rate','')::numeric,0),
      COALESCE(NULLIF(p_payload->>'currency_symbol',''),(SELECT a.currency_symbol FROM public.app_settings a WHERE a.restaurant_id=v_restaurant_id LIMIT 1),'₹'),COALESCE(p_payload->>'receipt_footer','Thank you for dining with us!'),NULLIF(p_payload->>'gst_number',''),
      NULLIF(p_payload->>'restaurant_address',''),NULL,now(),auth.uid())
    ON CONFLICT (restaurant_id) DO UPDATE SET restaurant_name=EXCLUDED.restaurant_name,upi_id=EXCLUDED.upi_id,cgst_rate=EXCLUDED.cgst_rate,sgst_rate=EXCLUDED.sgst_rate,
      currency_symbol=EXCLUDED.currency_symbol,receipt_footer=EXCLUDED.receipt_footer,gst_number=EXCLUDED.gst_number,restaurant_address=EXCLUDED.restaurant_address,daily_pin=NULL,updated_at=now(),updated_by=auth.uid()
    RETURNING to_jsonb(app_settings) INTO v_record;
    UPDATE public.restaurants SET name=v_name,updated_at=now() WHERE id=v_restaurant_id;

  ELSIF p_resource='branding' THEN
    v_id:=v_restaurant_id;
    IF p_action NOT IN ('save','update') THEN RAISE EXCEPTION 'Invalid branding action.'; END IF;
    v_bg:=COALESCE(p_payload->>'background_color','#fcfbf7'); v_fg:=COALESCE(p_payload->>'foreground_color','#122216');
    IF v_bg !~ '^#[0-9A-Fa-f]{6}$' OR v_fg !~ '^#[0-9A-Fa-f]{6}$' THEN RAISE EXCEPTION 'Brand colors must be six-digit hex values.'; END IF;
    IF NULLIF(p_payload->>'icon_url','') IS NOT NULL AND p_payload->>'icon_url' !~ '^https://' THEN RAISE EXCEPTION 'Restaurant icon URL must use HTTPS.'; END IF;
    IF NULLIF(p_payload->>'logo_url','') IS NOT NULL AND p_payload->>'logo_url' !~ '^https://' THEN RAISE EXCEPTION 'Restaurant logo URL must use HTTPS.'; END IF;
    UPDATE public.restaurants SET background_color=v_bg,foreground_color=v_fg,icon_url=NULLIF(p_payload->>'icon_url',''),logo_url=NULLIF(p_payload->>'logo_url',''),updated_at=now()
    WHERE id=v_restaurant_id RETURNING to_jsonb(restaurants) INTO v_record;
  END IF;

  PERFORM public._tableforge_audit_event(v_restaurant_id,'admin_resource_'||p_action,p_resource,v_id::text,NULL,NULL,v_record,jsonb_build_object('resource',p_resource,'action',p_action));
  RETURN jsonb_build_object('ok',true,'resource',p_resource,'id',v_id,'record',v_record);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_inventory_dashboard(p_panel_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_ingredients jsonb; v_movements jsonb; v_recipes jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',i.id,'name',i.name,'category',i.category,'baseUnit',i.base_unit,'reorderLevel',i.reorder_level,
    'costPerUnit',i.cost_per_unit,'currentStock',COALESCE(m.balance,0),'isActive',i.is_active
  ) ORDER BY i.name),'[]'::jsonb) INTO v_ingredients
  FROM public.inventory_ingredients i
  LEFT JOIN LATERAL (SELECT sum(im.quantity_delta) AS balance FROM public.inventory_movements im WHERE im.ingredient_id=i.id AND im.restaurant_id=i.restaurant_id) m ON true
  WHERE i.restaurant_id=v_restaurant_id AND i.is_active=true;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',m.id,'ingredientId',m.ingredient_id,'movementType',m.movement_type,
    'label',CASE m.movement_type WHEN 'opening_stock' THEN 'Opening stock' WHEN 'received' THEN 'Stock received' WHEN 'waste' THEN 'Wastage' WHEN 'adjustment_in' THEN 'Correction (+)' WHEN 'sale' THEN 'Dish consumption' ELSE 'Correction (−)' END,
    'quantityDelta',m.quantity_delta,'unit',m.unit,'reason',m.reason,'createdAt',extract(epoch FROM m.created_at)*1000,'orderId',m.reference_order_id,'orderItemId',m.reference_order_item_id
  ) ORDER BY m.created_at DESC),'[]'::jsonb) INTO v_movements
  FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id',r.product_id,'ingredient_id',r.ingredient_id,'quantity_per_serving',r.quantity_per_serving)),'[]'::jsonb)
  INTO v_recipes FROM public.product_recipes r WHERE r.restaurant_id=v_restaurant_id;
  RETURN jsonb_build_object('ok',true,'ingredients',COALESCE(v_ingredients,'[]'::jsonb),'movements',COALESCE(v_movements,'[]'::jsonb),'recipes',COALESCE(v_recipes,'[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_save_ingredient(p_panel_token text,p_ingredient_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_id uuid; v_name text; v_category text; v_unit text; v_reorder numeric; v_cost numeric; v_record jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  v_name:=btrim(COALESCE(p_payload->>'name','')); v_category:=COALESCE(NULLIF(p_payload->>'category',''),'other'); v_unit:=p_payload->>'baseUnit';
  v_reorder:=COALESCE(NULLIF(p_payload->>'reorderLevel','')::numeric,0); v_cost:=NULLIF(p_payload->>'costPerUnit','')::numeric;
  IF v_name='' OR length(v_name)>120 OR v_unit NOT IN ('g','ml','pcs') OR v_reorder<0 OR (v_cost IS NOT NULL AND v_cost<0) THEN
    RAISE EXCEPTION 'Ingredient name, unit, reorder level or cost is invalid.';
  END IF;
  IF p_ingredient_id IS NULL THEN
    INSERT INTO public.inventory_ingredients(restaurant_id,name,category,base_unit,reorder_level,cost_per_unit)
    VALUES(v_restaurant_id,v_name,v_category,v_unit,v_reorder,v_cost) RETURNING id,to_jsonb(inventory_ingredients) INTO v_id,v_record;
  ELSE
    UPDATE public.inventory_ingredients SET name=v_name,category=v_category,base_unit=v_unit,reorder_level=v_reorder,cost_per_unit=v_cost,updated_at=now()
    WHERE id=p_ingredient_id AND restaurant_id=v_restaurant_id RETURNING id,to_jsonb(inventory_ingredients) INTO v_id,v_record;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Ingredient not found in this restaurant.'; END IF;
  END IF;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'inventory_ingredient_saved','inventory_ingredients',v_id::text,NULL,NULL,v_record);
  RETURN jsonb_build_object('ok',true,'ingredient',v_record);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_record_inventory_movement(
  p_panel_token text,p_ingredient_id uuid,p_movement_type text,p_quantity numeric,p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_ingredient public.inventory_ingredients%ROWTYPE; v_delta numeric(14,3); v_balance numeric(14,3); v_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF p_movement_type NOT IN ('opening_stock','received','waste','adjustment_in','adjustment_out') OR p_quantity IS NULL OR p_quantity<=0 OR COALESCE(length(btrim(p_reason)),0)=0 OR length(p_reason)>300 THEN
    RAISE EXCEPTION 'Movement type, positive quantity and reason are required.';
  END IF;
  SELECT i.* INTO v_ingredient FROM public.inventory_ingredients i WHERE i.id=p_ingredient_id AND i.restaurant_id=v_restaurant_id AND i.is_active FOR UPDATE;
  IF v_ingredient.id IS NULL THEN RAISE EXCEPTION 'Ingredient not found.'; END IF;
  IF p_movement_type='opening_stock' AND EXISTS(SELECT 1 FROM public.inventory_movements m WHERE m.ingredient_id=p_ingredient_id AND m.movement_type='opening_stock') THEN
    RAISE EXCEPTION 'Opening stock has already been recorded for this ingredient.';
  END IF;
  IF p_movement_type<>'opening_stock' AND NOT EXISTS(SELECT 1 FROM public.inventory_movements m WHERE m.ingredient_id=p_ingredient_id AND m.movement_type='opening_stock') THEN
    RAISE EXCEPTION 'Record opening stock before other movements.';
  END IF;
  v_delta:=CASE WHEN p_movement_type IN ('waste','adjustment_out') THEN -p_quantity ELSE p_quantity END;
  SELECT COALESCE(sum(m.quantity_delta),0) INTO v_balance FROM public.inventory_movements m WHERE m.ingredient_id=p_ingredient_id AND m.restaurant_id=v_restaurant_id;
  IF v_balance+v_delta<0 THEN RAISE EXCEPTION 'This movement would create negative stock.'; END IF;
  INSERT INTO public.inventory_movements(restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id)
  VALUES(v_restaurant_id,p_ingredient_id,p_movement_type,v_delta,v_ingredient.base_unit,btrim(p_reason),auth.uid()) RETURNING id INTO v_id;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'inventory_movement_recorded','inventory_movements',v_id::text,btrim(p_reason),jsonb_build_object('balance',v_balance),jsonb_build_object('movement_type',p_movement_type,'quantity_delta',v_delta,'balance',v_balance+v_delta));
  RETURN jsonb_build_object('ok',true,'movement_id',v_id,'quantity_delta',v_delta,'balance',v_balance+v_delta);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_product_recipe(p_panel_token text,p_product_id uuid,p_recipe jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_row jsonb; v_ingredient_id uuid; v_qty numeric; v_count integer:=0;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.products p WHERE p.id=p_product_id AND p.restaurant_id=v_restaurant_id) THEN RAISE EXCEPTION 'Product not found in this restaurant.'; END IF;
  IF p_recipe IS NULL OR jsonb_typeof(p_recipe)<>'array' THEN RAISE EXCEPTION 'Recipe must be an array.'; END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_recipe) LOOP
    v_ingredient_id:=NULLIF(v_row->>'ingredient_id','')::uuid; v_qty:=NULLIF(v_row->>'quantity_per_serving','')::numeric;
    IF v_ingredient_id IS NULL OR v_qty IS NULL OR v_qty<=0 OR NOT EXISTS(SELECT 1 FROM public.inventory_ingredients i WHERE i.id=v_ingredient_id AND i.restaurant_id=v_restaurant_id AND i.is_active) THEN
      RAISE EXCEPTION 'Every recipe row must reference an active ingredient in this restaurant and a positive quantity.';
    END IF;
    v_count:=v_count+1;
  END LOOP;
  DELETE FROM public.product_recipes WHERE product_id=p_product_id AND restaurant_id=v_restaurant_id;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_recipe) LOOP
    INSERT INTO public.product_recipes(restaurant_id,product_id,ingredient_id,quantity_per_serving)
    VALUES(v_restaurant_id,p_product_id,(v_row->>'ingredient_id')::uuid,(v_row->>'quantity_per_serving')::numeric);
  END LOOP;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'product_recipe_saved','product_recipes',p_product_id::text,NULL,NULL,jsonb_build_object('ingredient_count',v_count));
  RETURN jsonb_build_object('ok',true,'product_id',p_product_id,'ingredient_count',v_count);
END;
$function$;

-- Automatically record recipe consumption exactly once when a line item first reaches Served.
CREATE OR REPLACE FUNCTION public._tableforge_consume_recipe_on_served()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_order public.orders%ROWTYPE; v_recipe record;
BEGIN
  IF NEW.serving_status='served' AND OLD.serving_status IS DISTINCT FROM 'served' AND NEW.serving_status<>'cancelled' THEN
    SELECT o.* INTO v_order FROM public.orders o WHERE o.id=NEW.order_id AND o.restaurant_id=NEW.restaurant_id;
    IF v_order.id IS NOT NULL THEN
      FOR v_recipe IN
        SELECT r.ingredient_id,r.quantity_per_serving,i.base_unit
        FROM public.product_recipes r
        JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id
        WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id AND i.is_active
      LOOP
        INSERT INTO public.inventory_movements(restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id,reference_order_id,reference_order_item_id)
        VALUES(NEW.restaurant_id,v_recipe.ingredient_id,'sale',-(v_recipe.quantity_per_serving*NEW.quantity),v_recipe.base_unit,
          'Recipe consumption when item served',auth.uid(),v_order.id,NEW.id)
        ON CONFLICT (reference_order_item_id,ingredient_id) WHERE movement_type='sale' AND reference_order_item_id IS NOT NULL DO NOTHING;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_tableforge_consume_recipe_on_served ON public.order_items;
CREATE TRIGGER trg_tableforge_consume_recipe_on_served
AFTER UPDATE OF serving_status ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public._tableforge_consume_recipe_on_served();

CREATE OR REPLACE FUNCTION public.get_inventory_usage_report(p_panel_token text,p_period text DEFAULT '7')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_since timestamptz;
  v_until timestamptz;
  v_ingredients jsonb;
  v_dishes jsonb;
  v_adjustments jsonb;
  v_metrics jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Admin panel authorization expired or invalid.';
  END IF;

  -- All custom date-only ranges use India local calendar days and an exclusive end.
  IF p_period LIKE 'range:%' THEN
    IF p_period !~ '^range:[0-9]{4}-[0-9]{2}-[0-9]{2}:[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Invalid reporting date range.';
    END IF;
    IF split_part(p_period, ':', 2)::date > split_part(p_period, ':', 3)::date THEN
      RAISE EXCEPTION 'The reporting end date must be on or after the start date.';
    END IF;
    v_since := split_part(p_period, ':', 2)::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := (split_part(p_period, ':', 3)::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period = 'today' THEN
    v_since := (now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period IN ('7', '30', '90') THEN
    v_since := ((now() AT TIME ZONE 'Asia/Kolkata')::date - (p_period::integer - 1))::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period = 'all' THEN
    v_since := NULL;
    v_until := NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported reporting period.';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('ingredient',x.name,'unit',x.base_unit,'quantity',x.consumed) ORDER BY x.name),'[]'::jsonb)
  INTO v_ingredients
  FROM (
    SELECT i.name,i.base_unit,round(sum(-m.quantity_delta),3) AS consumed
    FROM public.inventory_movements m
    JOIN public.inventory_ingredients i ON i.id=m.ingredient_id AND i.restaurant_id=m.restaurant_id
    WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale'
      AND (v_since IS NULL OR m.created_at >= v_since)
      AND (v_until IS NULL OR m.created_at < v_until)
    GROUP BY i.name,i.base_unit
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('dish',x.dish,'servings',x.servings) ORDER BY x.dish),'[]'::jsonb)
  INTO v_dishes
  FROM (
    SELECT oi.name_snapshot AS dish,sum(oi.quantity)::numeric AS servings
    FROM (
      SELECT DISTINCT m.reference_order_item_id
      FROM public.inventory_movements m
      WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale'
        AND (v_since IS NULL OR m.created_at >= v_since)
        AND (v_until IS NULL OR m.created_at < v_until)
        AND m.reference_order_item_id IS NOT NULL
    ) used
    JOIN public.order_items oi ON oi.id=used.reference_order_item_id AND oi.restaurant_id=v_restaurant_id
    GROUP BY oi.name_snapshot
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('ingredient',i.name,'unit',m.unit,'movement_type',m.movement_type,'quantity_delta',m.quantity_delta,'reason',m.reason,'created_at',m.created_at) ORDER BY m.created_at DESC),'[]'::jsonb)
  INTO v_adjustments
  FROM public.inventory_movements m
  JOIN public.inventory_ingredients i ON i.id=m.ingredient_id AND i.restaurant_id=m.restaurant_id
  WHERE m.restaurant_id=v_restaurant_id AND m.movement_type<>'sale'
    AND (v_since IS NULL OR m.created_at >= v_since)
    AND (v_until IS NULL OR m.created_at < v_until);

  SELECT jsonb_build_object(
    'ingredientsConsumed',COALESCE((SELECT count(DISTINCT m.ingredient_id) FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale' AND (v_since IS NULL OR m.created_at >= v_since) AND (v_until IS NULL OR m.created_at < v_until)),0),
    'eligibleServings',COALESCE((SELECT sum(oi.quantity) FROM (SELECT DISTINCT m.reference_order_item_id FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale' AND (v_since IS NULL OR m.created_at >= v_since) AND (v_until IS NULL OR m.created_at < v_until) AND m.reference_order_item_id IS NOT NULL) u JOIN public.order_items oi ON oi.id=u.reference_order_item_id AND oi.restaurant_id=v_restaurant_id),0),
    'movementCount',COALESCE((SELECT count(*) FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id AND (v_since IS NULL OR m.created_at >= v_since) AND (v_until IS NULL OR m.created_at < v_until)),0)
  ) INTO v_metrics;

  RETURN jsonb_build_object('ok',true,'period',p_period,'since',v_since,'until',v_until,'metrics',v_metrics,'ingredients',COALESCE(v_ingredients,'[]'::jsonb),'dishes',COALESCE(v_dishes,'[]'::jsonb),'adjustments',COALESCE(v_adjustments,'[]'::jsonb));
END;
$function$;


-- ---------------------------------------------------------------------------
-- 7. Execute grants: only intended entry points are exposed
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._tableforge_audit_event(uuid,text,text,text,text,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tableforge_validate_panel_token(text,text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tableforge_validate_management_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tableforge_recalculate_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tableforge_consume_recipe_on_served() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.verify_panel_pin(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_panel_pin(text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.authorize_panel_pin_management(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_panel_pin_management(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_panel_pin_statuses(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_panel_pin_statuses(text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_set_panel_pin(text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_panel_pin(text,text,text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_kot_queue(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kot_queue(text) TO authenticated;
REVOKE ALL ON FUNCTION public.set_kot_item_status(text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_kot_item_status(text,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.request_captain(uuid,text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.request_captain(uuid,text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_cashier_bill_queue(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cashier_bill_queue(text) TO authenticated;
REVOKE ALL ON FUNCTION public.generate_cashier_bill(text,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_cashier_bill(text,uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.generate_takeaway_bill(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_takeaway_bill(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.complete_takeaway_payment(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_takeaway_payment(uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.cancel_order_item(uuid,text,text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_order_item(uuid,text,text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.request_dish_cancellation(uuid,text,text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.request_dish_cancellation(uuid,text,text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_admin_cancellation_requests(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_cancellation_requests(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.decide_dish_cancellation(uuid,uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_dish_cancellation(uuid,uuid,text,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.create_pos_order(uuid,text,uuid,jsonb,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pos_order(uuid,text,uuid,jsonb,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_pos_order(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_pos_order(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.remove_order_item(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_order_item(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.set_order_item_status(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_order_item_status(uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.close_empty_dining_session(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_empty_dining_session(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.complete_session_payment(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_session_payment(uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_table_daily_pin(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_table_daily_pin(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.regenerate_table_daily_pin(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regenerate_table_daily_pin(uuid,text) TO authenticated;

-- Retire direct-call entry points that bypass panel authorization. The customer session
-- RPCs remain callable anonymously; old authenticated signatures are explicitly revoked.
REVOKE ALL ON FUNCTION public.create_pos_order(uuid,text,uuid,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_pos_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_order_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_order_item_status(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_empty_dining_session(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_session_payment(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_table_pin(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_table_daily_pin(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.rms_set_pin_v2(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_initial_admin_pin(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.change_admin_pin(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_takeaway_bill(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_session_bill_ready(uuid) FROM PUBLIC, anon, authenticated;

-- Customer session bootstrap remains the only anonymous route that may internally compute
-- a table's daily PIN. The PIN function itself is no longer directly callable by anon.
REVOKE ALL ON FUNCTION public.get_table_daily_pin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_customer_session(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_session_state(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_table_access(uuid,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_customer_order(uuid,uuid,jsonb) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.request_session_bill(uuid,text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.request_session_bill(uuid,text) TO anon;
REVOKE ALL ON FUNCTION public.request_session_bill(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_session_bill(uuid,text,text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_inventory_usage_report(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_usage_report(text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_inventory_dashboard(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_dashboard(text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_save_ingredient(text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_ingredient(text,uuid,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_record_inventory_movement(text,uuid,text,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_inventory_movement(text,uuid,text,numeric,text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_set_product_recipe(text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_product_recipe(text,uuid,jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.get_admin_settings(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_settings(text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_operational_settings(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operational_settings(text) TO authenticated;
REVOKE SELECT ON public.app_settings FROM anon, authenticated;
REVOKE SELECT (id,restaurant_name,upi_id,cgst_rate,sgst_rate,currency_symbol,receipt_footer,updated_at,updated_by,gst_number,restaurant_address,restaurant_id,razorpay_key,razorpay_secret,gateway_active,daily_pin) ON public.app_settings FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_mutate_resource(text,text,text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mutate_resource(text,text,text,uuid,jsonb) TO authenticated;
-- Admin writes now go through the token-checked gateway. Owner-scoped SELECT remains available.
REVOKE ALL ON public.products FROM anon, authenticated;
REVOKE ALL ON public.cuisines FROM anon, authenticated;
REVOKE ALL ON public.tables FROM anon, authenticated;
REVOKE ALL ON public.app_settings FROM anon, authenticated;
REVOKE SELECT ON public.restaurants FROM anon, authenticated;
GRANT SELECT ON public.products TO authenticated;
GRANT SELECT ON public.cuisines TO authenticated;
REVOKE SELECT (id,owner_id,name,slug,icon_url,logo_url,background_color,foreground_color,created_at,updated_at,admin_pin_hash,admin_pin) ON public.restaurants FROM anon, authenticated;
GRANT SELECT (id,owner_id,name,slug,icon_url,logo_url,background_color,foreground_color,created_at,updated_at) ON public.restaurants TO authenticated;
REVOKE SELECT ON public.tables FROM anon, authenticated;
REVOKE SELECT (id,table_no,capacity,qr_token,is_active,created_at,updated_at,restaurant_id,pin_salt,current_pin) ON public.tables FROM anon, authenticated;
GRANT SELECT (id,table_no,capacity,is_active,created_at,updated_at,restaurant_id) ON public.tables TO authenticated;
REVOKE SELECT (id,restaurant_name,upi_id,cgst_rate,sgst_rate,currency_symbol,receipt_footer,updated_at,updated_by,gst_number,restaurant_address,restaurant_id,razorpay_key,razorpay_secret,gateway_active,daily_pin) ON public.app_settings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.restaurants FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.orders FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.order_items FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.dining_sessions FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.app_settings_id_seq FROM anon, authenticated;

-- Tighten future grants only for roles the SQL Editor execution role can manage.
-- PostgreSQL denies ALTER DEFAULT PRIVILEGES for unrelated roles; that should not
-- abort the whole migration. A skipped role is reported as a NOTICE for follow-up.
DO $default_privileges$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      BEGIN
        IF v_role = current_user OR pg_has_role(current_user, v_role, 'MEMBER') THEN
          EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated',
            v_role
          );
          EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated',
            v_role
          );
        ELSE
          RAISE NOTICE 'Skipped default privileges for role % because current role % cannot manage it. Future objects created by that role need separate review.', v_role, current_user;
        END IF;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped default privileges for role % due to insufficient privileges. The migration will continue; handle this separately as a role administrator.', v_role;
      END;
    END IF;
  END LOOP;
END;
$default_privileges$;

-- Replace broad anonymous table reads with the scoped menu bootstrap RPC.
DROP POLICY IF EXISTS "Anon_Read_Products" ON public.products;
DROP POLICY IF EXISTS "Anon_Read_Tables" ON public.tables;
DROP POLICY IF EXISTS "Anon_Read_Cuisines" ON public.cuisines;
DROP POLICY IF EXISTS "Public_Read_Safe_Settings" ON public.app_settings;
DROP POLICY IF EXISTS "Public_Read_Branding" ON public.restaurants;
REVOKE SELECT ON public.products FROM anon;
REVOKE SELECT ON public.cuisines FROM anon;
REVOKE SELECT (id,name,slug,icon_url,logo_url,background_color,foreground_color) ON public.restaurants FROM anon;
REVOKE SELECT (id,table_no,capacity,is_active,restaurant_id) ON public.tables FROM anon;
REVOKE SELECT (restaurant_id,restaurant_name,cgst_rate,sgst_rate,currency_symbol,receipt_footer,gst_number,restaurant_address) ON public.app_settings FROM anon;
REVOKE ALL ON FUNCTION public.get_public_pos_data(uuid) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_pos_data(uuid) TO anon, authenticated;

-- Record a migration event for each existing tenant without exposing any PIN/token values.
INSERT INTO public.security_logs(restaurant_id,event_type,actor_id,metadata)
SELECT r.id,'master_migration_installed',auth.uid(),jsonb_build_object('migration','tableforge_master_2026_10','version',1)
FROM public.restaurants r
WHERE NOT EXISTS (
  SELECT 1 FROM public.security_logs l WHERE l.restaurant_id=r.id AND l.event_type='master_migration_installed'
    AND l.metadata->>'version'='1'
);

COMMIT;

-- Post-migration notes:
-- 1) Frontend must send p_panel_token for protected RPCs and p_session_token for customer cancellation.
-- 2) The old request_session_bill staff override and legacy direct table DML paths require the paired frontend patch.
-- 3) This file must be applied to a staging clone and all live post-migration checks must pass before production use.
