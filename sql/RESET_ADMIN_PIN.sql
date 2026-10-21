-- TableForge: safely reset a restaurant's Admin 6-digit PIN.
-- RUN ONLY AFTER sql/MASTER_MIGRATION_TABLEFORGE.sql completed successfully.
-- Replace BOTH placeholders below before running.
-- This script never writes the PIN in plaintext to a table. The PIN is bcrypt-hashed
-- by the existing database helper and synced to both Admin credential locations.
-- Use a temporary PIN; after login, choose a strong unique Admin PIN and keep it private.

BEGIN;

DO $reset_admin_pin$
DECLARE
  -- Replace with the exact restaurant UUID from:
  -- SELECT id, name, slug FROM public.restaurants ORDER BY created_at;
  v_restaurant_id uuid := 'REPLACE_WITH_RESTAURANT_UUID'::uuid;

  -- Replace with your chosen temporary six-digit PIN. Do not share this query.
  v_new_pin text := 'REPLACE_WITH_NEW_SIX_DIGIT_PIN';

  v_owner_id uuid;
  v_pin_hash text;
  v_updated integer;
BEGIN
  IF v_new_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'PIN reset stopped: replace the PIN placeholder with exactly six digits.';
  END IF;

  IF to_regclass('public.panel_pin_credentials') IS NULL
     OR to_regclass('public.panel_access_tokens') IS NULL
     OR to_regclass('public.panel_management_tokens') IS NULL
     OR to_regprocedure('public._tableforge_hash_pin(text)') IS NULL
     OR to_regprocedure('public._tableforge_verify_pin_hash(text,text)') IS NULL THEN
    RAISE EXCEPTION 'PIN reset stopped: the master migration is not fully installed. Run and validate the master migration first.';
  END IF;

  SELECT r.owner_id
    INTO v_owner_id
  FROM public.restaurants r
  WHERE r.id = v_restaurant_id
  FOR UPDATE;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'PIN reset stopped: no restaurant exists for the supplied UUID.';
  END IF;

  -- Enforce the migration's rule that each panel uses a different PIN.
  IF EXISTS (
    SELECT 1
    FROM public.panel_pin_credentials c
    WHERE c.restaurant_id = v_restaurant_id
      AND c.panel_id <> 'admin'
      AND public._tableforge_verify_pin_hash(v_new_pin, c.pin_hash)
  ) THEN
    RAISE EXCEPTION 'PIN reset stopped: choose a PIN not used by another staff panel.';
  END IF;

  v_pin_hash := public._tableforge_hash_pin(v_new_pin);

  UPDATE public.restaurants
  SET admin_pin_hash = v_pin_hash,
      admin_pin = NULL,
      updated_at = now()
  WHERE id = v_restaurant_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'PIN reset stopped: expected to update exactly one restaurant.';
  END IF;

  INSERT INTO public.panel_pin_credentials
    (restaurant_id, panel_id, pin_hash, updated_by)
  VALUES
    (v_restaurant_id, 'admin', v_pin_hash, v_owner_id)
  ON CONFLICT (restaurant_id, panel_id)
  DO UPDATE SET
    pin_hash = EXCLUDED.pin_hash,
    updated_at = now(),
    updated_by = EXCLUDED.updated_by;

  -- Revoke previously issued grants so the new PIN must be entered.
  UPDATE public.panel_access_tokens
  SET revoked_at = now()
  WHERE restaurant_id = v_restaurant_id
    AND panel_id = 'admin'
    AND revoked_at IS NULL;

  UPDATE public.panel_management_tokens
  SET revoked_at = now()
  WHERE restaurant_id = v_restaurant_id
    AND revoked_at IS NULL;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,
    'admin_pin_reset_by_database_operator',
    'panel_pin_credentials',
    'admin',
    'Admin PIN reset through Supabase SQL Editor',
    NULL,
    jsonb_build_object('configured', true, 'reset_via', 'supabase_sql_editor')
  );
END;
$reset_admin_pin$;

COMMIT;
