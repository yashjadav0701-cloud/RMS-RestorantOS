-- TableForge non-blocking automatic inventory deductions.
-- Apply after INGREDIENT_USAGE_ALWAYS_CALCULATE_PATCH.sql and the KOT snapshot hotfix.
-- Automatic mode deducts saved recipe quantities at first Preparing, including
-- estimated recipes. A shortage may make stock negative but never blocks Kitchen.
-- Strict remains an optional verified-recipe/stock-availability hard-control mode.
-- Historical calculated-only items are never retroactively deducted.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public._tableforge_consume_recipe_on_served()') IS NULL
     OR to_regprocedure('public.get_inventory_usage_report(text,text)') IS NULL
     OR to_regprocedure('public.set_inventory_mode(text,text)') IS NULL
     OR to_regprocedure('public.save_restaurant_workflow_settings(text,boolean,text[],text)') IS NULL
     OR to_regprocedure('public._tableforge_validate_panel_token(text,text[])') IS NULL
     OR to_regprocedure('public._tableforge_audit_event(uuid,text,text,text,text,jsonb,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public.admin_record_inventory_movement(text,uuid,text,numeric,text)') IS NULL
     OR to_regprocedure('public.admin_cancel_order_item(uuid,jsonb,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Automatic inventory preflight failed: apply the Ingredient Usage reliability, always-calculate and KOT snapshot hotfix migrations first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='order_items'
      AND t.tgname='trg_tableforge_consume_recipe_on_served' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Automatic inventory preflight failed: the Preparing-transition trigger is missing.';
  END IF;
END;
$preflight$;

ALTER TABLE public.restaurant_workflow_settings
  DROP CONSTRAINT IF EXISTS restaurant_workflow_settings_inventory_mode_check;
ALTER TABLE public.restaurant_workflow_settings
  ADD CONSTRAINT restaurant_workflow_settings_inventory_mode_check
  CHECK (inventory_mode IN ('disabled','automatic','strict'));

ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS recipe_is_estimated boolean NOT NULL DEFAULT false;

-- Upgrade the already-installed trigger without replacing unrelated guards.
DO $trigger_patch$
DECLARE
  v_definition text;
  v_old text;
BEGIN
  SELECT pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition,chr(13),'');

  v_old := $old$
  IF v_mode='strict' AND v_had_snapshot AND NEW.inventory_consumed_at IS NULL THEN
    RAISE EXCEPTION 'This dish already has a calculated usage snapshot but no stock deduction. Do not retroactively deduct it; Admin must reconcile the item first.';
  END IF;

  IF v_mode<>'strict' THEN
    RETURN NEW;
  END IF;
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic inventory trigger patch stopped: the expected snapshot/strict-mode block was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
  -- Never retroactively deduct an item that was snapshotted while deductions
  -- were disabled. A new first-Preparing transition has v_had_snapshot=false.
  IF v_had_snapshot THEN
    IF v_mode='strict' THEN
      RAISE EXCEPTION 'This dish already has calculated usage without a stock deduction. Do not deduct it retroactively; Admin must reconcile the item first.';
    END IF;
    RETURN NEW;
  END IF;

  IF v_mode='disabled' THEN
    RETURN NEW;
  END IF;
$new$);

  -- Estimated/unverified recipes remain disallowed only in Strict mode.
  v_old := $old$
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_recipe) AS recipe_row(value)
    WHERE coalesce((recipe_row.value->>'is_estimate')::boolean,true)
       OR coalesce((recipe_row.value->>'ingredient_active')::boolean,false)=false
       OR coalesce(recipe_row.value->>'unit','unknown')='unknown'
       OR coalesce((recipe_row.value->>'quantity')::numeric,0)<=0
       OR coalesce((recipe_row.value->>'quantity')::numeric,0)::text IN ('NaN','Infinity','-Infinity')
       OR coalesce((recipe_row.value->>'quantity')::numeric,0)<>round((recipe_row.value->>'quantity')::numeric,3)
  ) THEN
    RAISE EXCEPTION 'This dish has an estimated or invalid recipe ingredient. Verify its recipe and activate every ingredient before strict-inventory preparation.';
  END IF;
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic inventory trigger patch stopped: the expected Strict recipe-validation block was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,replace(v_old,'  IF EXISTS (','  IF v_mode=''strict'' AND EXISTS ('));

  -- Invalid quantities/units and missing ingredient rows remain data-integrity
  -- errors; an ordinary shortage is not. Lock rows in stable UUID order.
  v_old := $old$
  LOOP
    PERFORM 1 FROM public.inventory_ingredients
    WHERE id=v_row.ingredient_id AND restaurant_id=NEW.restaurant_id AND is_active FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recipe ingredient % is missing or inactive.',v_row.name; END IF;
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic inventory trigger patch stopped: the expected ingredient-lock block was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
  LOOP
    IF v_row.ingredient_id IS NULL OR v_row.quantity IS NULL OR v_row.quantity<=0
       OR v_row.quantity::text IN ('NaN','Infinity','-Infinity')
       OR v_row.quantity<>round(v_row.quantity,3)
       OR v_row.unit NOT IN ('g','ml','pcs') THEN
      RAISE EXCEPTION 'The saved recipe contains an invalid ingredient quantity or unit. Admin must correct the recipe before this dish can be recorded.';
    END IF;
    PERFORM 1 FROM public.inventory_ingredients
    WHERE id=v_row.ingredient_id AND restaurant_id=NEW.restaurant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recipe ingredient % is missing from this restaurant.',v_row.name; END IF;
$new$);

  -- Opening-balance and enough-stock checks belong only to Strict mode.
  v_old := $old$
    SELECT count(*),coalesce(sum(m.quantity_delta),0)
    INTO v_opening_count,v_opening_qty
    FROM public.inventory_movements m
    WHERE m.ingredient_id=v_row.ingredient_id AND m.restaurant_id=NEW.restaurant_id
      AND m.movement_type='opening_stock';
    IF v_opening_count<>1 OR v_opening_qty<=0 OR v_opening_qty::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Ingredient % must have exactly one positive opening-stock entry before preparation.',v_row.name;
    END IF;

    SELECT coalesce(sum(m.quantity_delta),0) INTO v_balance
    FROM public.inventory_movements m
    WHERE m.ingredient_id=v_row.ingredient_id AND m.restaurant_id=NEW.restaurant_id;
    IF v_balance::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'The stock balance for % is invalid.',v_row.name;
    END IF;
    IF v_balance<v_row.quantity THEN
      RAISE EXCEPTION 'Insufficient stock for %: available %, required % %.',v_row.name,v_balance,v_row.quantity,v_row.unit;
    END IF;
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic inventory trigger patch stopped: the expected stock-availability checks were not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
    IF v_mode='strict' THEN
      SELECT count(*),coalesce(sum(m.quantity_delta),0)
      INTO v_opening_count,v_opening_qty
      FROM public.inventory_movements m
      WHERE m.ingredient_id=v_row.ingredient_id AND m.restaurant_id=NEW.restaurant_id
        AND m.movement_type='opening_stock';
      IF v_opening_count<>1 OR v_opening_qty<=0 OR v_opening_qty::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'Ingredient % must have exactly one positive opening-stock entry before preparation.',v_row.name;
      END IF;

      SELECT coalesce(sum(m.quantity_delta),0) INTO v_balance
      FROM public.inventory_movements m
      WHERE m.ingredient_id=v_row.ingredient_id AND m.restaurant_id=NEW.restaurant_id;
      IF v_balance::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'The stock balance for % is invalid.',v_row.name;
      END IF;
      IF v_balance<v_row.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for %: available %, required % %.',v_row.name,v_balance,v_row.quantity,v_row.unit;
      END IF;
    END IF;
$new$);

  -- Tag each automatic deduction with the recipe confidence used at the time.
  v_old := $old$
    INSERT INTO public.inventory_movements(
      restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id,reference_order_id,reference_order_item_id
    ) VALUES (
      NEW.restaurant_id,v_row.ingredient_id,'sale',-v_row.quantity,v_row.unit,
      'Recipe consumption when preparation started: '||NEW.name_snapshot,auth.uid(),v_order.id,NEW.id
    ) ON CONFLICT (reference_order_item_id,ingredient_id)
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic inventory trigger patch stopped: the expected sale-movement insert was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
    INSERT INTO public.inventory_movements(
      restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id,
      reference_order_id,reference_order_item_id,recipe_is_estimated
    ) VALUES (
      NEW.restaurant_id,v_row.ingredient_id,'sale',-v_row.quantity,v_row.unit,
      CASE WHEN v_mode='automatic' AND coalesce((v_row.recipe_is_estimated)::boolean,false)
        THEN 'Estimated recipe deduction when preparation started: '||NEW.name_snapshot
        ELSE 'Recipe deduction when preparation started: '||NEW.name_snapshot END,
      auth.uid(),v_order.id,NEW.id,
      (v_mode='automatic' AND coalesce((v_row.recipe_is_estimated)::boolean,false))
    ) ON CONFLICT (reference_order_item_id,ingredient_id)
$new$);

  -- The JSON snapshot record has is_estimate; expose it to both stock loops.
  v_old := $old$
      x->>'name' AS name
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic inventory trigger patch stopped: recipe-loop projection was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
      x->>'name' AS name,
      coalesce((x->>'is_estimate')::boolean,true) AS recipe_is_estimated
$new$);

  EXECUTE v_definition;

  SELECT pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition,chr(13),'');
  IF position('v_mode=''automatic''' IN v_definition)=0
     OR position('recipe_is_estimated' IN v_definition)=0
     OR position('IF v_mode=''strict'' THEN' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic inventory trigger verification failed.';
  END IF;
END;
$trigger_patch$;

-- Upgrade the report to distinguish actual ledger deductions made from verified
-- recipes and deductions made from estimated recipes.
DO $report_patch$
DECLARE
  v_definition text;
  v_old text;
BEGIN
  SELECT pg_get_functiondef('public.get_inventory_usage_report(text,text)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition,chr(13),'');

  v_old := $old$
    SELECT sale.ingredient_id,i.name,i.base_unit,
      round(sum(-(sale.quantity_delta+coalesce(recon.delta,0))),3) AS quantity
$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Usage report patch stopped: sale rows projection not found.'; END IF;
  v_definition := replace(v_definition,v_old,$new$
    SELECT sale.ingredient_id,i.name,i.base_unit,sale.recipe_is_estimated,
      round(sum(-(sale.quantity_delta+coalesce(recon.delta,0))),3) AS quantity
$new$);

  v_old := $old$
    GROUP BY sale.ingredient_id,i.name,i.base_unit
    HAVING sum(-(sale.quantity_delta+coalesce(recon.delta,0)))>0
$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Usage report patch stopped: sale rows grouping not found.'; END IF;
  v_definition := replace(v_definition,v_old,$new$
    GROUP BY sale.ingredient_id,i.name,i.base_unit,sale.recipe_is_estimated
    HAVING sum(-(sale.quantity_delta+coalesce(recon.delta,0)))>0
$new$);

  v_old := $old$
    SELECT m.reference_order_item_id,min(m.created_at) AS sale_at
$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Usage report patch stopped: recorded item summary not found.'; END IF;
  v_definition := replace(v_definition,v_old,$new$
    SELECT m.reference_order_item_id,min(m.created_at) AS sale_at,
      bool_or(m.recipe_is_estimated) AS recipe_estimated
$new$);

  v_old := $old$
    SELECT oi.name_snapshot AS dish,sum(oi.quantity)::numeric AS servings,'recorded'::text AS kind
$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Usage report patch stopped: recorded dish projection not found.'; END IF;
  v_definition := replace(v_definition,v_old,$new$
    SELECT oi.name_snapshot AS dish,sum(oi.quantity)::numeric AS servings,
      CASE WHEN bool_or(ri.recipe_estimated) THEN 'recorded_estimated' ELSE 'recorded' END::text AS kind
$new$);

  v_old := $old$
    SELECT oi.name_snapshot||' · cancelled after preparation' AS dish,sum(oi.quantity)::numeric AS servings,'recorded'::text AS kind
$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Usage report patch stopped: recorded cancelled-dish projection not found.'; END IF;
  v_definition := replace(v_definition,v_old,$new$
    SELECT oi.name_snapshot||' · cancelled after preparation' AS dish,sum(oi.quantity)::numeric AS servings,
      CASE WHEN bool_or(ri.recipe_estimated) THEN 'recorded_estimated' ELSE 'recorded' END::text AS kind
$new$);

  v_old := $old$
    SELECT jsonb_build_object('ingredient',s.name,'unit',s.base_unit,'quantity',s.quantity,
      'currentStock',coalesce(b.balance,0),'kind','recorded','estimated',false,
      'note','Actual net quantity from stock deduction movements after linked cancellation reconciliation.') AS row_data,
      s.name AS sort_name,0 AS sort_kind
$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Usage report patch stopped: recorded ingredient row projection not found.'; END IF;
  v_definition := replace(v_definition,v_old,$new$
    SELECT jsonb_build_object('ingredient',s.name,'unit',s.base_unit,'quantity',s.quantity,
      'currentStock',coalesce(b.balance,0),
      'kind',CASE WHEN s.recipe_is_estimated THEN 'recorded_estimated' ELSE 'recorded' END,
      'estimated',s.recipe_is_estimated,'recipeEstimate',s.recipe_is_estimated,
      'note',CASE WHEN s.recipe_is_estimated
        THEN 'Stock was deducted using an estimated recipe quantity. Verify the kitchen recipe to improve accuracy; any stock shortage remains visible.'
        ELSE 'Stock was deducted using a verified recipe quantity. Net usage includes linked cancellation reconciliation.' END) AS row_data,
      s.name AS sort_name,CASE WHEN s.recipe_is_estimated THEN 1 ELSE 0 END AS sort_kind
$new$);

  v_definition := replace(v_definition,
    '''recorded'',''Actual net stock deductions from the permanent movement ledger, adjusted for Admin-confirmed prepared-item cancellation.''',
    '''recorded'',''Stock quantities deducted from the permanent movement ledger and adjusted for Admin-confirmed prepared-item cancellation. The estimated flag identifies deductions sourced from provisional recipes.''');
  v_definition := replace(v_definition,
    '''calculated'',''Recipe quantities are calculated as soon as an item enters Preparing, regardless of current stock or inventory mode. Calculated usage does not change stock balances.''',
    '''calculated'',''Recipe quantities are calculated as soon as an item enters Preparing. Automatic mode records ledger deductions even for estimated recipes and allows negative balances; strict mode optionally requires verified recipes and sufficient stock; disabled mode only calculates usage.''');

  EXECUTE v_definition;

  SELECT pg_get_functiondef('public.get_inventory_usage_report(text,text)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition,chr(13),'');
  IF position('sale.recipe_is_estimated' IN v_definition)=0
     OR position('recorded_estimated' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Usage report automatic-estimate verification failed.';
  END IF;
END;
$report_patch$;

-- Extend both the dedicated Admin mode RPC and the legacy workflow-settings RPC.
DO $mode_functions$
DECLARE
  v_definition text;
  v_signature regprocedure;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.set_inventory_mode(text,text)'::regprocedure,
    'public.save_restaurant_workflow_settings(text,boolean,text[],text)'::regprocedure
  ] LOOP
    SELECT pg_get_functiondef(v_signature) INTO v_definition;
    v_definition := replace(v_definition,chr(13),'');
    IF position('p_inventory_mode NOT IN (''disabled'',''strict'')' IN v_definition)=0 THEN
      RAISE EXCEPTION 'Automatic-mode preflight failed: % does not contain the expected inventory-mode allowlist.',v_signature;
    END IF;
    v_definition := replace(v_definition,
      'p_inventory_mode NOT IN (''disabled'',''strict'')',
      'p_inventory_mode NOT IN (''disabled'',''automatic'',''strict'')');
    EXECUTE v_definition;
    SELECT pg_get_functiondef(v_signature) INTO v_definition;
    v_definition := replace(v_definition,chr(13),'');
    IF position('''automatic''' IN v_definition)=0 THEN
      RAISE EXCEPTION 'Automatic-mode verification failed for %.',v_signature;
    END IF;
  END LOOP;
END;
$mode_functions$;

-- Keep Admin stock adjustments and prepared-item reconciliation consistent:
-- in Automatic mode, real wastage/extra use may also leave a negative balance.
DO $automatic_shortage_adjustments$
DECLARE
  v_definition text;
  v_old text;
BEGIN
  SELECT pg_get_functiondef('public.admin_record_inventory_movement(text,uuid,text,numeric,text)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition,chr(13),'');

  v_old := $old$
  v_id uuid;
BEGIN
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic adjustment patch stopped: Admin movement function declaration was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
  v_id uuid;
  v_inventory_mode text := 'disabled';
BEGIN
$new$);

  v_old := $old$
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic adjustment patch stopped: Admin movement authorization block was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  SELECT coalesce(w.inventory_mode,'disabled') INTO v_inventory_mode
  FROM public.restaurant_workflow_settings w WHERE w.restaurant_id=v_restaurant_id;
$new$);

  v_old := $old$
  IF v_balance+v_delta<0 THEN RAISE EXCEPTION 'This movement would create negative stock.'; END IF;
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic adjustment patch stopped: negative-stock guard was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
  IF v_balance+v_delta<0 AND coalesce(v_inventory_mode,'disabled')<>'automatic' THEN
    RAISE EXCEPTION 'This movement would create negative stock.';
  END IF;
$new$);
  EXECUTE v_definition;

  SELECT pg_get_functiondef('public.admin_cancel_order_item(uuid,jsonb,text,text)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition,chr(13),'');

  v_old := $old$
  v_restaurant_id uuid;
  v_item public.order_items%ROWTYPE;
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic cancellation patch stopped: Admin cancellation declaration was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
  v_restaurant_id uuid;
  v_inventory_mode text := 'disabled';
  v_item public.order_items%ROWTYPE;
$new$);

  v_old := $old$
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic cancellation patch stopped: Admin cancellation authorization block was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  SELECT coalesce(w.inventory_mode,'disabled') INTO v_inventory_mode
  FROM public.restaurant_workflow_settings w WHERE w.restaurant_id=v_restaurant_id;
$new$);

  v_old := $old$
          IF v_delta<0 AND v_balance+v_delta<0 THEN
$old$;
  IF position(v_old IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic cancellation patch stopped: prepared-item negative-stock guard was not found.';
  END IF;
  v_definition := replace(v_definition,v_old,$new$
          IF v_delta<0 AND v_balance+v_delta<0 AND coalesce(v_inventory_mode,'disabled')<>'automatic' THEN
$new$);
  EXECUTE v_definition;

  SELECT pg_get_functiondef('public.admin_record_inventory_movement(text,uuid,text,numeric,text)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition,chr(13),'');
  IF position('v_inventory_mode text := ''disabled''' IN v_definition)=0
     OR position('coalesce(v_inventory_mode,''disabled'')<>''automatic''' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic Admin movement verification failed.';
  END IF;

  SELECT pg_get_functiondef('public.admin_cancel_order_item(uuid,jsonb,text,text)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition,chr(13),'');
  IF position('v_inventory_mode text := ''disabled''' IN v_definition)=0
     OR position('coalesce(v_inventory_mode,''disabled'')<>''automatic''' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Automatic prepared-item reconciliation verification failed.';
  END IF;
END;
$automatic_shortage_adjustments$;

-- Activate the new mode for Four Flavours only. Do not change other tenants.
DO $seed_mode$
DECLARE v_restaurant_id uuid;
BEGIN
  SELECT id INTO v_restaurant_id FROM public.restaurants WHERE slug='four-flavours';
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Four Flavours tenant not found; no mode was changed.'; END IF;
  INSERT INTO public.restaurant_workflow_settings(restaurant_id,inventory_mode,updated_at)
  VALUES(v_restaurant_id,'automatic',now())
  ON CONFLICT (restaurant_id) DO UPDATE SET inventory_mode='automatic',updated_at=now();
  PERFORM public._tableforge_audit_event(
    v_restaurant_id,'inventory_mode_changed','restaurant_workflow_settings',v_restaurant_id::text,
    'Enabled non-blocking automatic recipe deductions. Estimated recipes are flagged; stock shortages do not block preparation.',
    jsonb_build_object('inventory_mode','disabled'),jsonb_build_object('inventory_mode','automatic'),
    jsonb_build_object('source','automatic_nonblocking_inventory_migration','estimated_recipe_deductions',true,'allow_negative_stock',true));
END;
$seed_mode$;

COMMIT;
