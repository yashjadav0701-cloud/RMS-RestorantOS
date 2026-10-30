-- TableForge KOT Ready hotfix: correct the undeclared prior-snapshot marker in
-- the always-calculate recipe trigger. This is the direct cause of the live
-- PostgreSQL error: column "v_has_snapshot" does not exist.
-- Safe correction only: no order rows, inventory movements, or panel settings are changed.

BEGIN;

DO $hotfix$
DECLARE
  v_definition text;
  v_verified_definition text;
BEGIN
  IF to_regprocedure('public._tableforge_consume_recipe_on_served()') IS NULL
     OR to_regclass('public.order_items') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='order_items'
         AND column_name='inventory_usage_calculated_at'
     ) THEN
    RAISE EXCEPTION 'KOT Ready hotfix preflight failed: the always-calculate ingredient trigger/columns are not installed. Apply the Ingredient Usage migration first.';
  END IF;

  SELECT pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure)
  INTO v_definition;

  IF position('v_had_snapshot boolean' IN v_definition)=0 THEN
    RAISE EXCEPTION 'KOT Ready hotfix stopped: the live trigger does not match the expected always-calculate implementation. Do not force this patch; inspect the live function first.';
  END IF;

  IF position('v_has_snapshot' IN v_definition)>0 THEN
    v_definition := replace(v_definition,'v_has_snapshot','v_had_snapshot');
    EXECUTE v_definition;
  END IF;

  SELECT pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure)
  INTO v_verified_definition;

  IF position('v_has_snapshot' IN v_verified_definition)>0
     OR position('v_had_snapshot boolean' IN v_verified_definition)=0
     OR position('v_mode=''strict'' AND v_had_snapshot AND NEW.inventory_consumed_at IS NULL' IN v_verified_definition)=0 THEN
    RAISE EXCEPTION 'KOT Ready hotfix verification failed. The trigger definition was not corrected.';
  END IF;
END;
$hotfix$;

COMMIT;
