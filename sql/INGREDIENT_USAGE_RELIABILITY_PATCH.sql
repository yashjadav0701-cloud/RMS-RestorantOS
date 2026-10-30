-- TableForge Ingredient Usage reliability patch
-- Run AFTER the existing TableForge master, workflow, release-safety,
-- KOT-ready alignment, and date-range report patches.
-- This patch is additive/idempotent: it adds guarded Admin RPCs and replaces
-- the usage report so recorded, expected, and not-backfilled data stay distinct.
-- It does NOT enable strict inventory, verify recipes, create opening stock,
-- backfill history, or modify existing stock movements.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.restaurants') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regclass('public.product_recipes') IS NULL
     OR to_regclass('public.inventory_ingredients') IS NULL
     OR to_regclass('public.inventory_movements') IS NULL
     OR to_regclass('public.restaurant_workflow_settings') IS NULL
     OR to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_items') IS NULL THEN
    RAISE EXCEPTION 'Ingredient Usage patch preflight failed: one or more required TableForge tables are missing.';
  END IF;
  IF to_regprocedure('public._tableforge_validate_panel_token(text,text[])') IS NULL
     OR to_regprocedure('public._tableforge_audit_event(uuid,text,text,text,text,jsonb,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public._tableforge_recalculate_order(uuid)') IS NULL
     OR to_regprocedure('public._tableforge_consume_recipe_on_served()') IS NULL
     OR to_regprocedure('public.admin_record_inventory_movement(text,uuid,text,numeric,text)') IS NULL
     OR to_regprocedure('public.admin_set_product_recipe(text,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.save_restaurant_workflow_settings(text,boolean,text[],text)') IS NULL THEN
    RAISE EXCEPTION 'Ingredient Usage patch preflight failed: required authorization, audit, or order-total helper is missing.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('restaurants','id'),
      ('products','id'),('products','restaurant_id'),('products','is_active'),
      ('product_recipes','is_estimate'),('product_recipes','created_at'),('product_recipes','updated_at'),
      ('product_recipes','restaurant_id'),('product_recipes','product_id'),('product_recipes','ingredient_id'),('product_recipes','quantity_per_serving'),('product_recipes','source_note'),
      ('order_items','id'),('order_items','restaurant_id'),('order_items','order_id'),('order_items','product_id'),
      ('order_items','name_snapshot'),('order_items','quantity'),('order_items','created_at'),('order_items','serving_status'),
      ('order_items','inventory_recipe_snapshot'),('order_items','inventory_consumed_at'),('order_items','inventory_reconciled_at'),
      ('order_items','cancellation_reason'),('order_items','cancelled_at'),('order_items','cancelled_by'),
      ('order_items','kot_ready_previous_status'),('order_items','kot_ready_at'),
      ('orders','id'),('orders','restaurant_id'),('orders','status'),('orders','payment_status'),('orders','billing_status'),('orders','order_number'),
      ('inventory_ingredients','id'),('inventory_ingredients','restaurant_id'),('inventory_ingredients','name'),('inventory_ingredients','base_unit'),('inventory_ingredients','is_active'),
      ('inventory_movements','id'),('inventory_movements','restaurant_id'),('inventory_movements','ingredient_id'),
      ('inventory_movements','movement_type'),('inventory_movements','quantity_delta'),('inventory_movements','unit'),
      ('inventory_movements','reason'),('inventory_movements','actor_id'),('inventory_movements','created_at'),
      ('inventory_movements','reference_order_id'),('inventory_movements','reference_order_item_id'),
      ('restaurant_workflow_settings','restaurant_id'),('restaurant_workflow_settings','inventory_mode'),
      ('restaurant_workflow_settings','allow_takeaway_prepayment'),('restaurant_workflow_settings','allowed_payment_methods'),('restaurant_workflow_settings','updated_at'),
      ('dish_cancellation_requests','restaurant_id'),('dish_cancellation_requests','order_item_id')
    ) AS required(table_name,column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=required.table_name AND c.column_name=required.column_name
    )
  ) THEN
    RAISE EXCEPTION 'Ingredient Usage patch preflight failed: one or more required inventory, order, cancellation, or audit columns are missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index idx
    JOIN pg_catalog.pg_class tbl ON tbl.oid=idx.indrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid=tbl.relnamespace
    WHERE ns.nspname='public' AND tbl.relname='inventory_movements'
      AND idx.indisunique AND idx.indisvalid AND idx.indislive
      AND pg_catalog.pg_get_indexdef(idx.indexrelid) ILIKE '%(reference_order_item_id, ingredient_id)%'
      AND pg_catalog.pg_get_expr(idx.indpred,idx.indrelid) ILIKE '%movement_type%sale%'
  ) THEN
    RAISE EXCEPTION 'Ingredient Usage patch preflight failed: the unique sale-movement index required for duplicate-safe stock deduction is missing.';
  END IF;
END;
$preflight$;

-- Internal, tenant-scoped readiness calculation. It never reads another tenant.
CREATE OR REPLACE FUNCTION public._tableforge_inventory_setup_status(p_restaurant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_mode text;
  v_active_products bigint := 0;
  v_missing_recipes bigint := 0;
  v_estimated_products bigint := 0;
  v_invalid_recipe_rows bigint := 0;
  v_invalid_movement_units bigint := 0;
  v_invalid_movement_quantities bigint := 0;
  v_invalid_stock_balances bigint := 0;
  v_invalid_opening_stock bigint := 0;
  v_used_ingredients bigint := 0;
  v_missing_opening_stock bigint := 0;
  v_active_order_items bigint := 0;
BEGIN
  SELECT coalesce(w.inventory_mode,'disabled') INTO v_mode
  FROM (SELECT 1) seed
  LEFT JOIN public.restaurant_workflow_settings w ON w.restaurant_id=p_restaurant_id;

  SELECT count(*) INTO v_active_products
  FROM public.products p
  WHERE p.restaurant_id=p_restaurant_id AND p.is_active;

  SELECT count(*) INTO v_missing_recipes
  FROM public.products p
  WHERE p.restaurant_id=p_restaurant_id AND p.is_active
    AND NOT EXISTS (
      SELECT 1 FROM public.product_recipes r
      WHERE r.restaurant_id=p.restaurant_id AND r.product_id=p.id
    );

  SELECT count(DISTINCT p.id) INTO v_estimated_products
  FROM public.products p
  JOIN public.product_recipes r ON r.product_id=p.id AND r.restaurant_id=p.restaurant_id
  WHERE p.restaurant_id=p_restaurant_id AND p.is_active
    AND coalesce(r.is_estimate,true);

  SELECT count(*) INTO v_invalid_recipe_rows
  FROM public.product_recipes r
  JOIN public.products p ON p.id=r.product_id AND p.restaurant_id=r.restaurant_id AND p.is_active
  LEFT JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id
  WHERE r.restaurant_id=p_restaurant_id
    AND (i.id IS NULL OR NOT i.is_active OR r.quantity_per_serving<=0
      OR r.quantity_per_serving::text IN ('NaN','Infinity','-Infinity')
      OR r.quantity_per_serving<>round(r.quantity_per_serving,3));

  SELECT count(*) INTO v_invalid_movement_units
  FROM public.inventory_movements m
  JOIN public.inventory_ingredients i ON i.id=m.ingredient_id AND i.restaurant_id=m.restaurant_id
  WHERE m.restaurant_id=p_restaurant_id AND m.unit IS DISTINCT FROM i.base_unit;

  SELECT count(*) INTO v_invalid_movement_quantities
  FROM public.inventory_movements m
  WHERE m.restaurant_id=p_restaurant_id
    AND (m.quantity_delta=0 OR m.quantity_delta::text IN ('NaN','Infinity','-Infinity'));

  SELECT count(*) INTO v_invalid_stock_balances
  FROM (
    SELECT r.ingredient_id,sum(m.quantity_delta) AS balance
    FROM public.product_recipes r
    JOIN public.products p ON p.id=r.product_id AND p.restaurant_id=r.restaurant_id AND p.is_active
    JOIN public.inventory_movements m ON m.restaurant_id=r.restaurant_id AND m.ingredient_id=r.ingredient_id
    WHERE r.restaurant_id=p_restaurant_id
    GROUP BY r.ingredient_id
    HAVING sum(m.quantity_delta)<0 OR sum(m.quantity_delta)::text IN ('NaN','Infinity','-Infinity')
  ) invalid_balances;

  -- A used ingredient must have exactly one positive opening-stock entry.
  -- Duplicate or negative legacy openings can inflate/poison its balance.
  SELECT count(*) INTO v_invalid_opening_stock
  FROM (
    SELECT r.ingredient_id
    FROM public.product_recipes r
    JOIN public.products p ON p.id=r.product_id AND p.restaurant_id=r.restaurant_id AND p.is_active
    LEFT JOIN public.inventory_movements m
      ON m.restaurant_id=r.restaurant_id AND m.ingredient_id=r.ingredient_id
      AND m.movement_type='opening_stock'
    WHERE r.restaurant_id=p_restaurant_id
    GROUP BY r.ingredient_id
    HAVING count(DISTINCT m.id) FILTER (WHERE m.movement_type='opening_stock')>1
      OR coalesce(bool_or(m.movement_type='opening_stock' AND (
        m.quantity_delta<=0 OR m.quantity_delta::text IN ('NaN','Infinity','-Infinity')
      )),false)
  ) opening_anomalies;

  SELECT count(DISTINCT r.ingredient_id) INTO v_used_ingredients
  FROM public.product_recipes r
  JOIN public.products p ON p.id=r.product_id AND p.restaurant_id=r.restaurant_id AND p.is_active
  WHERE r.restaurant_id=p_restaurant_id;

  SELECT count(DISTINCT r.ingredient_id) INTO v_missing_opening_stock
  FROM public.product_recipes r
  JOIN public.products p ON p.id=r.product_id AND p.restaurant_id=r.restaurant_id AND p.is_active
  WHERE r.restaurant_id=p_restaurant_id
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_movements m
      WHERE m.restaurant_id=r.restaurant_id
        AND m.ingredient_id=r.ingredient_id
        AND m.movement_type='opening_stock'
    );

  SELECT count(*) INTO v_active_order_items
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
  WHERE o.restaurant_id=p_restaurant_id
    AND o.status::text NOT IN ('completed','cancelled')
    AND o.payment_status::text IS DISTINCT FROM 'paid'
    AND o.billing_status::text IS DISTINCT FROM 'closed'
    AND (
      oi.serving_status IN ('pending','preparing','ready')
      OR oi.kot_ready_previous_status IS NOT NULL
    );

  RETURN jsonb_build_object(
    'inventoryMode',coalesce(v_mode,'disabled'),
    'activeProducts',v_active_products,
    'productsMissingRecipe',v_missing_recipes,
    'productsWithEstimatedRecipe',v_estimated_products,
    'invalidRecipeIngredients',v_invalid_recipe_rows,
    'invalidMovementUnits',v_invalid_movement_units,
    'invalidMovementQuantities',v_invalid_movement_quantities,
    'invalidStockBalances',v_invalid_stock_balances,
    'invalidOpeningStockEntries',v_invalid_opening_stock,
    'distinctRecipeIngredients',v_used_ingredients,
    'recipeIngredientsMissingOpeningStock',v_missing_opening_stock,
    'activeOrderItems',v_active_order_items,
    'canEnableStrict',(
      v_active_products>0
      AND v_missing_recipes=0
      AND v_estimated_products=0
      AND v_invalid_recipe_rows=0
      AND v_invalid_movement_units=0
      AND v_invalid_movement_quantities=0
      AND v_invalid_stock_balances=0
      AND v_invalid_opening_stock=0
      AND v_missing_opening_stock=0
      AND v_active_order_items=0
    )
  );
END;
$function$;
REVOKE ALL ON FUNCTION public._tableforge_inventory_setup_status(uuid) FROM PUBLIC, anon, authenticated;

-- Read-only Admin RPC for the currently authenticated panel token.
CREATE OR REPLACE FUNCTION public.get_inventory_setup_status(p_panel_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_restaurant_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Admin panel authorization expired or invalid.';
  END IF;
  RETURN jsonb_build_object('ok',true,'setup',public._tableforge_inventory_setup_status(v_restaurant_id));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_inventory_setup_status(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_setup_status(text) TO authenticated;

-- Dedicated mode RPC: changes only inventory_mode, preserving payment policy
-- and takeaway settings stored in the same row.
CREATE OR REPLACE FUNCTION public.set_inventory_mode(p_inventory_mode text,p_panel_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_status jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Admin panel authorization expired or invalid.';
  END IF;
  PERFORM 1 FROM public.restaurants r WHERE r.id=v_restaurant_id FOR UPDATE;
  IF p_inventory_mode IS NULL OR p_inventory_mode NOT IN ('disabled','automatic','strict') THEN
    RAISE EXCEPTION 'Inventory mode must be disabled, automatic, or strict.';
  END IF;

  v_status := public._tableforge_inventory_setup_status(v_restaurant_id);
  IF p_inventory_mode='strict' AND coalesce(v_status->>'inventoryMode','disabled')<>'strict' THEN
    IF coalesce((v_status->>'canEnableStrict')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Strict inventory is locked. Active products: %, missing recipes: %, products with estimated recipes: %, invalid recipe rows: %, recipe ingredients missing opening stock: %, active order items: %. Resolve every blocker before enabling stock deductions.',
        coalesce((v_status->>'activeProducts')::bigint,0),
        coalesce((v_status->>'productsMissingRecipe')::bigint,0),
        coalesce((v_status->>'productsWithEstimatedRecipe')::bigint,0),
        coalesce((v_status->>'invalidRecipeIngredients')::bigint,0),
        coalesce((v_status->>'recipeIngredientsMissingOpeningStock')::bigint,0),
        coalesce((v_status->>'activeOrderItems')::bigint,0);
    END IF;
  END IF;

  INSERT INTO public.restaurant_workflow_settings(restaurant_id,inventory_mode,updated_at)
  VALUES(v_restaurant_id,p_inventory_mode,now())
  ON CONFLICT (restaurant_id) DO UPDATE
    SET inventory_mode=EXCLUDED.inventory_mode,updated_at=now();

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,
    'inventory_mode_changed',
    'restaurant_workflow_settings',
    v_restaurant_id::text,
    NULL,
    coalesce(v_status,jsonb_build_object('inventory_mode','disabled')),
    jsonb_build_object('inventory_mode',p_inventory_mode),
    jsonb_build_object('source','ingredient_usage_dashboard')
  );

  RETURN jsonb_build_object('ok',true,'inventory_mode',p_inventory_mode,
    'setup',public._tableforge_inventory_setup_status(v_restaurant_id));
END;
$function$;
REVOKE ALL ON FUNCTION public.set_inventory_mode(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_inventory_mode(text,text) TO authenticated;

-- Keep the legacy workflow-settings RPC aligned with the same strict-mode gate,
-- so callers cannot bypass the new readiness checks through an older endpoint.
CREATE OR REPLACE FUNCTION public.save_restaurant_workflow_settings(
  p_inventory_mode text,
  p_allow_takeaway_prepayment boolean,
  p_allowed_payment_methods text[],
  p_panel_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_methods text[];
  v_status jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  PERFORM 1 FROM public.restaurants r WHERE r.id=v_restaurant_id FOR UPDATE;
  IF p_inventory_mode IS NULL OR p_inventory_mode NOT IN ('disabled','automatic','strict') THEN
    RAISE EXCEPTION 'Inventory mode must be disabled, automatic, or strict.';
  END IF;
  SELECT array_agg(DISTINCT lower(btrim(x))) INTO v_methods
  FROM unnest(coalesce(p_allowed_payment_methods,ARRAY[]::text[])) x
  WHERE coalesce(length(btrim(x)),0)>0;
  IF coalesce(cardinality(v_methods),0)=0 OR EXISTS (
    SELECT 1 FROM unnest(v_methods) x WHERE x NOT IN ('upi_qr','cash','card','bank_transfer')
  ) THEN
    RAISE EXCEPTION 'Select at least one supported payment method: UPI QR, Cash, Card, or Bank transfer.';
  END IF;

  v_status:=public._tableforge_inventory_setup_status(v_restaurant_id);
  IF p_inventory_mode='strict' AND coalesce(v_status->>'inventoryMode','disabled')<>'strict'
     AND NOT coalesce((v_status->>'canEnableStrict')::boolean,false) THEN
    RAISE EXCEPTION 'Strict inventory is locked. Resolve the recipe, ingredient-unit, opening-stock and active-order blockers shown in Admin → Ingredient Usage before enabling it.';
  END IF;

  INSERT INTO public.restaurant_workflow_settings(
    restaurant_id,inventory_mode,allow_takeaway_prepayment,allowed_payment_methods,updated_at
  ) VALUES (
    v_restaurant_id,p_inventory_mode,coalesce(p_allow_takeaway_prepayment,true),v_methods,now()
  )
  ON CONFLICT (restaurant_id) DO UPDATE SET
    inventory_mode=EXCLUDED.inventory_mode,
    allow_takeaway_prepayment=EXCLUDED.allow_takeaway_prepayment,
    allowed_payment_methods=EXCLUDED.allowed_payment_methods,
    updated_at=now();

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,'restaurant_workflow_settings_updated','restaurant_workflow_settings',v_restaurant_id::text,NULL,NULL,
    jsonb_build_object('inventory_mode',p_inventory_mode,
      'allow_takeaway_prepayment',coalesce(p_allow_takeaway_prepayment,true),
      'allowed_payment_methods',v_methods),
    jsonb_build_object('method_count',cardinality(v_methods))
  );
  RETURN jsonb_build_object('ok',true,'inventory_mode',p_inventory_mode,
    'allow_takeaway_prepayment',coalesce(p_allow_takeaway_prepayment,true),
    'allowed_payment_methods',v_methods);
END;
$function$;
REVOKE ALL ON FUNCTION public.save_restaurant_workflow_settings(text,boolean,text[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_restaurant_workflow_settings(text,boolean,text[],text) TO authenticated;

-- Prevent silent unit reinterpretation after an ingredient is in recipes or the ledger.
CREATE OR REPLACE FUNCTION public._tableforge_guard_inventory_base_unit_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.base_unit IS DISTINCT FROM OLD.base_unit AND (
    EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.restaurant_id=OLD.restaurant_id AND r.ingredient_id=OLD.id)
    OR EXISTS (SELECT 1 FROM public.inventory_movements m WHERE m.restaurant_id=OLD.restaurant_id AND m.ingredient_id=OLD.id)
  ) THEN
    RAISE EXCEPTION 'An ingredient unit cannot be changed after it is used by a recipe or stock movement. Create a new ingredient with the correct unit and update recipes instead.';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_tableforge_inventory_unit_immutable ON public.inventory_ingredients;
CREATE TRIGGER trg_tableforge_inventory_unit_immutable
BEFORE UPDATE OF base_unit ON public.inventory_ingredients
FOR EACH ROW EXECUTE FUNCTION public._tableforge_guard_inventory_base_unit_change();
REVOKE ALL ON FUNCTION public._tableforge_guard_inventory_base_unit_change() FROM PUBLIC, anon, authenticated;

-- Reject non-finite quantities at the RPC boundary; numeric NaN compares greater
-- than ordinary numbers in PostgreSQL and must never be treated as valid stock.
CREATE OR REPLACE FUNCTION public.admin_record_inventory_movement(
  p_panel_token text,p_ingredient_id uuid,p_movement_type text,p_quantity numeric,p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_ingredient public.inventory_ingredients%ROWTYPE;
  v_delta numeric(14,3);
  v_balance numeric(14,3);
  v_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF p_movement_type IS NULL OR p_movement_type NOT IN ('opening_stock','received','waste','adjustment_in','adjustment_out')
     OR p_quantity IS NULL OR p_quantity<=0 OR p_quantity::text IN ('NaN','Infinity','-Infinity')
     OR p_quantity<>round(p_quantity,3)
     OR coalesce(length(btrim(p_reason)),0)=0 OR length(p_reason)>300 THEN
    RAISE EXCEPTION 'Movement type, positive quantity (up to 3 decimal places) and reason are required.';
  END IF;
  SELECT i.* INTO v_ingredient
  FROM public.inventory_ingredients i
  WHERE i.id=p_ingredient_id AND i.restaurant_id=v_restaurant_id AND i.is_active
  FOR UPDATE;
  IF v_ingredient.id IS NULL THEN RAISE EXCEPTION 'Ingredient not found.'; END IF;
  IF p_movement_type='opening_stock' AND EXISTS (
    SELECT 1 FROM public.inventory_movements m WHERE m.ingredient_id=p_ingredient_id AND m.restaurant_id=v_restaurant_id AND m.movement_type='opening_stock'
  ) THEN RAISE EXCEPTION 'Opening stock has already been recorded for this ingredient.'; END IF;
  IF p_movement_type<>'opening_stock' AND NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m WHERE m.ingredient_id=p_ingredient_id AND m.restaurant_id=v_restaurant_id AND m.movement_type='opening_stock'
  ) THEN RAISE EXCEPTION 'Record opening stock before other movements.'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.ingredient_id=p_ingredient_id AND m.restaurant_id=v_restaurant_id AND m.unit IS DISTINCT FROM v_ingredient.base_unit
  ) THEN RAISE EXCEPTION 'The existing stock ledger contains a unit mismatch. Reconcile it before recording more stock.'; END IF;
  v_delta:=CASE WHEN p_movement_type IN ('waste','adjustment_out') THEN -p_quantity ELSE p_quantity END;
  SELECT coalesce(sum(m.quantity_delta),0) INTO v_balance
  FROM public.inventory_movements m
  WHERE m.ingredient_id=p_ingredient_id AND m.restaurant_id=v_restaurant_id;
  IF v_balance::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'The current stock balance is invalid; do not add another movement.'; END IF;
  IF v_balance+v_delta<0 THEN RAISE EXCEPTION 'This movement would create negative stock.'; END IF;
  INSERT INTO public.inventory_movements(restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id)
  VALUES(v_restaurant_id,p_ingredient_id,p_movement_type,v_delta,v_ingredient.base_unit,btrim(p_reason),auth.uid())
  RETURNING id INTO v_id;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'inventory_movement_recorded','inventory_movements',v_id::text,btrim(p_reason),
    jsonb_build_object('balance',v_balance),jsonb_build_object('movement_type',p_movement_type,'quantity_delta',v_delta,'balance',v_balance+v_delta));
  RETURN jsonb_build_object('ok',true,'movement_id',v_id,'quantity_delta',v_delta,'balance',v_balance+v_delta);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_record_inventory_movement(text,uuid,text,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_record_inventory_movement(text,uuid,text,numeric,text) TO authenticated;

-- Recipe replacement preserves the original RPC but rejects NaN/infinite/invalid quantities.
CREATE OR REPLACE FUNCTION public.admin_set_product_recipe(p_panel_token text,p_product_id uuid,p_recipe jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_row jsonb;
  v_ingredient_id uuid;
  v_qty numeric;
  v_estimate boolean;
  v_source_note text;
  v_count integer:=0;
  v_estimated_count integer:=0;
  v_inventory_mode text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  -- Serialize recipe replacement with strict-mode activation and the stock trigger.
  PERFORM 1 FROM public.restaurants r WHERE r.id=v_restaurant_id FOR UPDATE;
  SELECT coalesce(w.inventory_mode,'disabled') INTO v_inventory_mode
  FROM (SELECT 1) seed
  LEFT JOIN public.restaurant_workflow_settings w ON w.restaurant_id=v_restaurant_id;
  IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id=p_product_id AND p.restaurant_id=v_restaurant_id) THEN
    RAISE EXCEPTION 'Product not found in this restaurant.';
  END IF;
  IF p_recipe IS NULL OR jsonb_typeof(p_recipe)<>'array' THEN
    RAISE EXCEPTION 'A recipe must be a JSON array.';
  END IF;
  IF jsonb_array_length(p_recipe)=0 AND v_inventory_mode='strict' AND EXISTS (
    SELECT 1 FROM public.products p WHERE p.id=p_product_id AND p.restaurant_id=v_restaurant_id AND p.is_active
  ) THEN
    RAISE EXCEPTION 'An active dish cannot lose its recipe while strict inventory is enabled. Disable strict inventory first or save a complete verified recipe.';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_recipe) LOOP
    v_ingredient_id:=NULLIF(v_row->>'ingredient_id','')::uuid;
    v_qty:=NULLIF(v_row->>'quantity_per_serving','')::numeric;
    v_estimate:=coalesce((v_row->>'is_estimate')::boolean,true);
    IF v_ingredient_id IS NULL OR v_qty IS NULL OR v_qty<=0
       OR v_qty::text IN ('NaN','Infinity','-Infinity') OR v_qty<>round(v_qty,3) THEN
      RAISE EXCEPTION 'Every recipe row must reference an active ingredient in this restaurant and a finite positive quantity with at most 3 decimal places.';
    END IF;
    IF v_inventory_mode='strict' AND v_estimate THEN
      RAISE EXCEPTION 'Strict inventory is active. A recipe cannot be saved as estimated until strict mode is disabled.';
    END IF;
    PERFORM 1 FROM public.inventory_ingredients i
    WHERE i.id=v_ingredient_id AND i.restaurant_id=v_restaurant_id AND i.is_active
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Every recipe row must reference an active ingredient in this restaurant and a finite positive quantity.';
    END IF;
    IF v_inventory_mode='strict' AND NOT EXISTS (
      SELECT 1 FROM public.inventory_movements m
      WHERE m.restaurant_id=v_restaurant_id AND m.ingredient_id=v_ingredient_id AND m.movement_type='opening_stock'
    ) THEN
      RAISE EXCEPTION 'Strict inventory is active. Record opening stock for each ingredient before adding it to a recipe.';
    END IF;
    v_count:=v_count+1;
  END LOOP;
  DELETE FROM public.product_recipes WHERE product_id=p_product_id AND restaurant_id=v_restaurant_id;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_recipe) LOOP
    -- Missing verification flags are treated as estimated, never as Admin-verified.
    v_estimate:=coalesce((v_row->>'is_estimate')::boolean,true);
    v_source_note:=nullif(btrim(v_row->>'source_note'),'');
    IF NOT v_estimate AND (v_source_note IS NULL OR length(v_source_note)>300) THEN
      RAISE EXCEPTION 'A verified recipe requires an Admin verification source/note of 1 to 300 characters.';
    END IF;
    IF v_estimate THEN
      v_source_note:=coalesce(v_source_note,'Estimated starter recipe; review against actual kitchen quantities.');
    END IF;
    INSERT INTO public.product_recipes(restaurant_id,product_id,ingredient_id,quantity_per_serving,is_estimate,source_note)
    VALUES(v_restaurant_id,p_product_id,(v_row->>'ingredient_id')::uuid,
      (v_row->>'quantity_per_serving')::numeric,v_estimate,v_source_note);
    IF v_estimate THEN v_estimated_count:=v_estimated_count+1; END IF;
  END LOOP;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'product_recipe_saved','product_recipes',p_product_id::text,NULL,NULL,
    jsonb_build_object('ingredient_count',v_count,'estimated_ingredient_count',v_estimated_count),
    jsonb_build_object('recipe_estimated',v_estimated_count>0));
  RETURN jsonb_build_object('ok',true,'product_id',p_product_id,'ingredient_count',v_count,
    'estimated_ingredient_count',v_estimated_count,'is_estimate',v_estimated_count>0);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_set_product_recipe(text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_product_recipe(text,uuid,jsonb) TO authenticated;

-- Strict consumption is a BEFORE transition into Preparing. It locks ingredients,
-- rejects invalid units/numbers/estimates and writes a stable recipe snapshot once.
CREATE OR REPLACE FUNCTION public._tableforge_consume_recipe_on_served()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_mode text;
  v_recipe jsonb;
  v_row record;
  v_balance numeric(14,3);
  v_opening_count bigint;
  v_opening_qty numeric(14,3);
  v_has_sale boolean;
BEGIN
  IF NEW.serving_status='preparing' AND OLD.serving_status IS DISTINCT FROM 'preparing' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.inventory_movements m
      WHERE m.restaurant_id=NEW.restaurant_id AND m.reference_order_item_id=NEW.id AND m.movement_type='sale'
    ) INTO v_has_sale;
    IF (NEW.inventory_consumed_at IS NOT NULL) IS DISTINCT FROM v_has_sale THEN
      RAISE EXCEPTION 'This order item has inconsistent stock-consumption markers and ledger rows. Stop the transition and have Admin reconcile the item before continuing.';
    END IF;
    IF NEW.inventory_consumed_at IS NULL AND NEW.inventory_recipe_snapshot IS NOT NULL THEN
      IF jsonb_typeof(NEW.inventory_recipe_snapshot)<>'array' THEN
        RAISE EXCEPTION 'This order item has an old recipe snapshot without matching stock-consumption markers. Stop and investigate before preparation.';
      ELSIF jsonb_array_length(NEW.inventory_recipe_snapshot)>0 THEN
        RAISE EXCEPTION 'This order item has an old recipe snapshot without matching stock-consumption markers. Stop and investigate before preparation.';
      END IF;
    END IF;
  END IF;

  IF NEW.serving_status='preparing'
     AND OLD.serving_status IS DISTINCT FROM 'preparing'
     AND NEW.serving_status<>'cancelled'
     AND NEW.inventory_consumed_at IS NULL THEN
    PERFORM 1 FROM public.restaurants r WHERE r.id=NEW.restaurant_id FOR SHARE;
    SELECT w.inventory_mode INTO v_mode
    FROM public.restaurant_workflow_settings w
    WHERE w.restaurant_id=NEW.restaurant_id;
    IF coalesce(v_mode,'disabled')<>'strict' THEN RETURN NEW; END IF;

    SELECT o.* INTO v_order
    FROM public.orders o
    WHERE o.id=NEW.order_id AND o.restaurant_id=NEW.restaurant_id
    FOR UPDATE;
    IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found for inventory deduction.'; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.product_recipes r
      WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id
    ) THEN RAISE EXCEPTION 'This restaurant requires a complete recipe before preparation can start.'; END IF;
    IF EXISTS (
      SELECT 1
      FROM public.product_recipes r
      LEFT JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id
      WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id
        AND (coalesce(r.is_estimate,true) OR i.id IS NULL OR NOT i.is_active
          OR r.quantity_per_serving<=0 OR r.quantity_per_serving::text IN ('NaN','Infinity','-Infinity')
          OR r.quantity_per_serving<>round(r.quantity_per_serving,3))
    ) THEN RAISE EXCEPTION 'This dish has an unverified recipe or invalid ingredient quantity. An Admin must correct and verify the recipe before preparation.'; END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'ingredient_id',r.ingredient_id,'quantity_per_serving',r.quantity_per_serving,
      'quantity',round(r.quantity_per_serving*NEW.quantity,3),'unit',i.base_unit,'name',i.name
    ) ORDER BY i.name),'[]'::jsonb) INTO v_recipe
    FROM public.product_recipes r
    JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id AND i.is_active
    WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id;
    IF jsonb_array_length(v_recipe)=0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_recipe) AS recipe_row(value)
      WHERE (recipe_row.value->>'quantity')::numeric<=0
        OR (recipe_row.value->>'quantity')::numeric::text IN ('NaN','Infinity','-Infinity')
    ) THEN RAISE EXCEPTION 'The recipe contains a quantity below the supported stock precision.'; END IF;

    FOR v_row IN
      SELECT (x->>'ingredient_id')::uuid AS ingredient_id,(x->>'quantity')::numeric AS quantity,
        x->>'unit' AS unit,x->>'name' AS name
      FROM jsonb_array_elements(v_recipe) x
      ORDER BY (x->>'ingredient_id')::uuid
    LOOP
      PERFORM 1 FROM public.inventory_ingredients
      WHERE id=v_row.ingredient_id AND restaurant_id=NEW.restaurant_id AND is_active FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Recipe ingredient % is no longer active.',v_row.name; END IF;
      IF EXISTS (
        SELECT 1 FROM public.inventory_movements m
        WHERE m.ingredient_id=v_row.ingredient_id AND m.restaurant_id=NEW.restaurant_id
          AND m.unit IS DISTINCT FROM v_row.unit
      ) THEN RAISE EXCEPTION 'Stock ledger unit mismatch for %. Reconcile the ingredient ledger before preparation.',v_row.name; END IF;
      SELECT count(*),coalesce(sum(m.quantity_delta),0) INTO v_opening_count,v_opening_qty
      FROM public.inventory_movements m
      WHERE m.ingredient_id=v_row.ingredient_id AND m.restaurant_id=NEW.restaurant_id
        AND m.movement_type='opening_stock';
      IF v_opening_count<>1 OR v_opening_qty<=0 OR v_opening_qty::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'Ingredient % must have exactly one positive opening-stock entry before preparation.',v_row.name;
      END IF;
      SELECT coalesce(sum(m.quantity_delta),0) INTO v_balance
      FROM public.inventory_movements m
      WHERE m.ingredient_id=v_row.ingredient_id AND m.restaurant_id=NEW.restaurant_id;
      IF v_balance::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'The stock balance for % is invalid.',v_row.name; END IF;
      IF v_balance<v_row.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for %: available %, required % %.',v_row.name,v_balance,v_row.quantity,v_row.unit;
      END IF;
    END LOOP;

    FOR v_row IN
      SELECT (x->>'ingredient_id')::uuid AS ingredient_id,(x->>'quantity')::numeric AS quantity,
        x->>'unit' AS unit,x->>'name' AS name
      FROM jsonb_array_elements(v_recipe) x
    LOOP
      INSERT INTO public.inventory_movements(
        restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id,reference_order_id,reference_order_item_id
      ) VALUES (
        NEW.restaurant_id,v_row.ingredient_id,'sale',-v_row.quantity,v_row.unit,
        'Recipe consumption when preparation started: '||NEW.name_snapshot,auth.uid(),v_order.id,NEW.id
      ) ON CONFLICT (reference_order_item_id,ingredient_id)
        WHERE movement_type='sale' AND reference_order_item_id IS NOT NULL DO NOTHING;
    END LOOP;
    NEW.inventory_recipe_snapshot:=v_recipe;
    NEW.inventory_consumed_at:=now();
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._tableforge_consume_recipe_on_served() FROM PUBLIC, anon, authenticated;

-- Report semantics are explicit:
-- recorded = permanent sale movement;
-- expected = estimated recipe quantity for an item served while deductions were off;
-- not_backfilled = historical served items for which no recipe existed at item time.
CREATE OR REPLACE FUNCTION public.get_inventory_usage_report(p_panel_token text,p_period text DEFAULT '7')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_since timestamptz;
  v_until timestamptz;
  v_ingredients jsonb;
  v_dishes jsonb;
  v_adjustments jsonb;
  v_metrics jsonb;
  v_inventory_mode text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;

  IF p_period LIKE 'range:%' THEN
    IF p_period !~ '^range:[0-9]{4}-[0-9]{2}-[0-9]{2}:[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Invalid reporting date range.';
    END IF;
    IF split_part(p_period,':',2)::date > split_part(p_period,':',3)::date THEN
      RAISE EXCEPTION 'The reporting end date must be on or after the start date.';
    END IF;
    v_since := split_part(p_period,':',2)::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := (split_part(p_period,':',3)::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period='today' THEN
    v_since := (now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := ((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period IN ('7','30','90') THEN
    v_since := ((now() AT TIME ZONE 'Asia/Kolkata')::date-(p_period::integer-1))::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := ((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period='all' THEN
    v_since := NULL; v_until := NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported reporting period.';
  END IF;

  SELECT coalesce(s.inventory_mode,'disabled') INTO v_inventory_mode
  FROM (SELECT 1) q LEFT JOIN public.restaurant_workflow_settings s ON s.restaurant_id=v_restaurant_id;

  WITH actual AS (
    -- Attribute reconciled consumption to the original preparation deduction.
    -- This nets out unused ingredients returned when a prepared dish is cancelled,
    -- without treating unrelated manual stock corrections as dish consumption.
    SELECT i.name,i.base_unit,round(sum(-(sale.quantity_delta+coalesce(recon.delta,0))),3) quantity
    FROM public.inventory_movements sale
    JOIN public.inventory_ingredients i ON i.id=sale.ingredient_id AND i.restaurant_id=sale.restaurant_id
    LEFT JOIN LATERAL (
      SELECT sum(a.quantity_delta) AS delta
      FROM public.inventory_movements a
      WHERE a.restaurant_id=sale.restaurant_id
        AND a.ingredient_id=sale.ingredient_id
        AND a.reference_order_item_id=sale.reference_order_item_id
        AND a.movement_type IN ('adjustment_in','adjustment_out')
    ) recon ON true
    WHERE sale.restaurant_id=v_restaurant_id AND sale.movement_type='sale'
      AND (v_since IS NULL OR sale.created_at>=v_since)
      AND (v_until IS NULL OR sale.created_at<v_until)
    GROUP BY i.name,i.base_unit
    HAVING sum(-(sale.quantity_delta+coalesce(recon.delta,0)))>0
  ), expected AS (
    SELECT i.name,i.base_unit,round(sum(r.quantity_per_serving*oi.quantity),3) quantity,
      bool_or(coalesce(r.is_estimate,true)) has_estimated_recipe
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    JOIN public.product_recipes r ON r.product_id=oi.product_id AND r.restaurant_id=oi.restaurant_id AND r.created_at<=oi.created_at
    JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id AND i.is_active
    WHERE oi.restaurant_id=v_restaurant_id AND oi.serving_status='served'
      AND o.status<>'cancelled'::public.order_status
      AND oi.inventory_consumed_at IS NULL
      AND (v_since IS NULL OR oi.created_at>=v_since)
      AND (v_until IS NULL OR oi.created_at<v_until)
      AND NOT EXISTS (
        SELECT 1 FROM public.product_recipes later
        WHERE later.product_id=oi.product_id AND later.restaurant_id=oi.restaurant_id AND later.created_at>oi.created_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.inventory_movements sold
        WHERE sold.restaurant_id=oi.restaurant_id AND sold.reference_order_item_id=oi.id AND sold.movement_type='sale'
      )
    GROUP BY i.name,i.base_unit
  )
  SELECT coalesce(jsonb_agg(row_data ORDER BY sort_name,sort_kind),'[]'::jsonb) INTO v_ingredients
  FROM (
    SELECT jsonb_build_object('ingredient',a.name,'unit',a.base_unit,'quantity',a.quantity,
      'kind','recorded','estimated',false,'note','Net recorded use from recipe deductions, after any linked cancellation reconciliation.') row_data,
      a.name sort_name,0 sort_kind FROM actual a
    UNION ALL
    SELECT jsonb_build_object('ingredient',e.name,'unit',e.base_unit,
      'quantity',e.quantity,'kind','expected','estimated',true,'recipeEstimate',e.has_estimated_recipe,
      'note','Expected from saved recipe rows; this quantity was not deducted from stock.') row_data,
      e.name sort_name,1 sort_kind FROM expected e
  ) usage_rows;

  WITH used AS (
    SELECT DISTINCT m.reference_order_item_id FROM public.inventory_movements m
    WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale' AND m.reference_order_item_id IS NOT NULL
      AND (v_since IS NULL OR m.created_at>=v_since)
      AND (v_until IS NULL OR m.created_at<v_until)
  ), consumed AS (
    -- Stock is deducted at Preparing, so active preparing/ready items belong here too.
    SELECT oi.id,oi.name_snapshot,oi.quantity
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    JOIN used u ON u.reference_order_item_id=oi.id
    WHERE oi.restaurant_id=v_restaurant_id AND oi.serving_status<>'cancelled'
      AND o.status<>'cancelled'::public.order_status
  ), served AS (
    SELECT oi.id,oi.product_id,oi.name_snapshot,oi.quantity,oi.created_at,oi.restaurant_id,oi.inventory_consumed_at
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    WHERE oi.restaurant_id=v_restaurant_id AND oi.serving_status='served'
      AND o.status<>'cancelled'::public.order_status
  ), dish_rows AS (
    -- Actual rows follow the deduction event timestamp, not the original order-entry time.
    SELECT c.name_snapshot dish,sum(c.quantity)::numeric servings,'recorded'::text kind,false estimated
    FROM consumed c GROUP BY c.name_snapshot
    UNION ALL
    SELECT oi.name_snapshot || ' · cancelled (stock reconciled)',sum(oi.quantity)::numeric,'recorded'::text,false
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    JOIN used u ON u.reference_order_item_id=oi.id
    WHERE oi.restaurant_id=v_restaurant_id AND oi.serving_status='cancelled'
      AND oi.inventory_reconciled_at IS NOT NULL AND o.status<>'cancelled'::public.order_status
    GROUP BY oi.name_snapshot
    UNION ALL
    SELECT s.name_snapshot || ' · expected (not deducted)',sum(s.quantity)::numeric,'expected'::text,true
    FROM served s
    WHERE s.inventory_consumed_at IS NULL
      AND (v_since IS NULL OR s.created_at>=v_since)
      AND (v_until IS NULL OR s.created_at<v_until)
      AND NOT EXISTS (SELECT 1 FROM used u WHERE u.reference_order_item_id=s.id)
      AND EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.product_id=s.product_id AND r.restaurant_id=s.restaurant_id AND r.created_at<=s.created_at)
      AND NOT EXISTS (SELECT 1 FROM public.product_recipes later WHERE later.product_id=s.product_id AND later.restaurant_id=s.restaurant_id AND later.created_at>s.created_at)
    GROUP BY s.name_snapshot
    UNION ALL
    SELECT s.name_snapshot || ' · not backfilled (recipe unavailable at sale)',sum(s.quantity)::numeric,'not_backfilled'::text,true
    FROM served s
    WHERE s.inventory_consumed_at IS NULL
      AND (v_since IS NULL OR s.created_at>=v_since)
      AND (v_until IS NULL OR s.created_at<v_until)
      AND NOT EXISTS (SELECT 1 FROM used u WHERE u.reference_order_item_id=s.id)
      AND NOT (
        EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.product_id=s.product_id AND r.restaurant_id=s.restaurant_id AND r.created_at<=s.created_at)
        AND NOT EXISTS (SELECT 1 FROM public.product_recipes later WHERE later.product_id=s.product_id AND later.restaurant_id=s.restaurant_id AND later.created_at>s.created_at)
      )
    GROUP BY s.name_snapshot
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('dish',d.dish,'servings',d.servings,'kind',d.kind,'estimated',d.estimated) ORDER BY d.dish),'[]'::jsonb)
  INTO v_dishes FROM dish_rows d;

  SELECT coalesce(jsonb_agg(jsonb_build_object('ingredient',i.name,'unit',m.unit,'movement_type',m.movement_type,
    'quantity_delta',m.quantity_delta,'reason',m.reason,'created_at',m.created_at) ORDER BY m.created_at DESC),'[]'::jsonb)
  INTO v_adjustments
  FROM public.inventory_movements m
  JOIN public.inventory_ingredients i ON i.id=m.ingredient_id AND i.restaurant_id=m.restaurant_id
  WHERE m.restaurant_id=v_restaurant_id AND m.movement_type<>'sale'
    AND (v_since IS NULL OR m.created_at>=v_since)
    AND (v_until IS NULL OR m.created_at<v_until);

  SELECT jsonb_build_object(
    'ingredientsConsumed',coalesce((SELECT count(*) FROM (
      SELECT sale.ingredient_id
      FROM public.inventory_movements sale
      LEFT JOIN LATERAL (
        SELECT sum(a.quantity_delta) AS delta
        FROM public.inventory_movements a
        WHERE a.restaurant_id=sale.restaurant_id AND a.ingredient_id=sale.ingredient_id
          AND a.reference_order_item_id=sale.reference_order_item_id
          AND a.movement_type IN ('adjustment_in','adjustment_out')
      ) recon ON true
      WHERE sale.restaurant_id=v_restaurant_id AND sale.movement_type='sale'
        AND (v_since IS NULL OR sale.created_at>=v_since) AND (v_until IS NULL OR sale.created_at<v_until)
      GROUP BY sale.ingredient_id
      HAVING sum(-(sale.quantity_delta+coalesce(recon.delta,0)))>0
    ) net_ingredients),0),
    'eligibleServings',coalesce((SELECT sum(oi.quantity) FROM (
      SELECT DISTINCT m.reference_order_item_id FROM public.inventory_movements m
      WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale'
        AND (v_since IS NULL OR m.created_at>=v_since) AND (v_until IS NULL OR m.created_at<v_until)
        AND m.reference_order_item_id IS NOT NULL
    ) u JOIN public.order_items oi ON oi.id=u.reference_order_item_id AND oi.restaurant_id=v_restaurant_id),0),
    'movementCount',coalesce((SELECT count(*) FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id
      AND (v_since IS NULL OR m.created_at>=v_since) AND (v_until IS NULL OR m.created_at<v_until)),0),
    'expectedServings',coalesce((SELECT sum(oi.quantity) FROM public.order_items oi
      JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
      WHERE oi.restaurant_id=v_restaurant_id AND oi.serving_status='served'
        AND o.status<>'cancelled'::public.order_status AND oi.inventory_consumed_at IS NULL
        AND (v_since IS NULL OR oi.created_at>=v_since) AND (v_until IS NULL OR oi.created_at<v_until)
        AND EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.product_id=oi.product_id AND r.restaurant_id=oi.restaurant_id AND r.created_at<=oi.created_at)
        AND NOT EXISTS (SELECT 1 FROM public.product_recipes later WHERE later.product_id=oi.product_id AND later.restaurant_id=oi.restaurant_id AND later.created_at>oi.created_at)
        AND NOT EXISTS (SELECT 1 FROM public.inventory_movements sold WHERE sold.restaurant_id=oi.restaurant_id AND sold.reference_order_item_id=oi.id AND sold.movement_type='sale')),0),
    'notBackfilledServings',coalesce((SELECT sum(oi.quantity) FROM public.order_items oi
      JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
      WHERE oi.restaurant_id=v_restaurant_id AND oi.serving_status='served'
        AND o.status<>'cancelled'::public.order_status AND oi.inventory_consumed_at IS NULL
        AND (v_since IS NULL OR oi.created_at>=v_since) AND (v_until IS NULL OR oi.created_at<v_until)
        AND NOT (
          EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.product_id=oi.product_id AND r.restaurant_id=oi.restaurant_id AND r.created_at<=oi.created_at)
          AND NOT EXISTS (SELECT 1 FROM public.product_recipes later WHERE later.product_id=oi.product_id AND later.restaurant_id=oi.restaurant_id AND later.created_at>oi.created_at)
        )
        AND NOT EXISTS (SELECT 1 FROM public.inventory_movements sold WHERE sold.restaurant_id=oi.restaurant_id AND sold.reference_order_item_id=oi.id AND sold.movement_type='sale')),0),
    'inventoryMode',coalesce(v_inventory_mode,'disabled')
  ) INTO v_metrics;

  RETURN jsonb_build_object(
    'ok',true,'period',p_period,'since',v_since,'until',v_until,
    'metrics',v_metrics,'ingredients',coalesce(v_ingredients,'[]'::jsonb),
    'dishes',coalesce(v_dishes,'[]'::jsonb),'adjustments',coalesce(v_adjustments,'[]'::jsonb),
    'reportSemantics',jsonb_build_object(
      'recorded','Net recipe consumption from permanent sale movements, reduced or increased by order-item-linked cancellation reconciliation; attributed to original deduction time.',
      'expected','Expected use from saved recipe rows for served items without a recorded deduction; item creation time is used because no stock event exists.',
      'notBackfilled','Historical served items without a reconstructable recipe at sale time; no consumption is invented.'
    )
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_inventory_usage_report(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_usage_report(text,text) TO authenticated;



-- Global guard for every legacy cancellation route. Prepared stock lines may
-- only be cancelled by admin_cancel_order_item after its per-ingredient
-- reconciliation has completed in this transaction. This protects old RPCs,
-- Captain approvals and direct deletes that bypass the visible Admin button.
CREATE OR REPLACE FUNCTION public._tableforge_guard_consumed_item_cancellation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_has_sale boolean;
  v_has_snapshot boolean := false;
BEGIN
  IF NEW.serving_status='cancelled' AND OLD.serving_status IS DISTINCT FROM 'cancelled' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.inventory_movements m
      WHERE m.restaurant_id=OLD.restaurant_id
        AND m.reference_order_item_id=OLD.id
        AND m.movement_type='sale'
    ) INTO v_has_sale;

    IF OLD.inventory_recipe_snapshot IS NOT NULL THEN
      IF jsonb_typeof(OLD.inventory_recipe_snapshot)='array' THEN
        v_has_snapshot := jsonb_array_length(OLD.inventory_recipe_snapshot)>0;
      ELSE
        v_has_snapshot := true;
      END IF;
    END IF;

    IF OLD.inventory_consumed_at IS NOT NULL OR v_has_sale OR v_has_snapshot THEN
      IF (OLD.inventory_consumed_at IS NOT NULL) IS DISTINCT FROM v_has_sale THEN
        RAISE EXCEPTION 'This item has inconsistent stock-consumption records. Do not cancel it until an Admin reconciles the stock ledger.';
      END IF;
      IF OLD.inventory_reconciled_at IS NOT NULL
         OR NEW.inventory_reconciled_at IS NULL
         OR pg_catalog.current_setting('tableforge.inventory_reconciliation_item_id',true) IS DISTINCT FROM OLD.id::text THEN
        RAISE EXCEPTION 'This dish has stock-consumption history. Use Admin Table Manager → Cancel dish and reconcile the actual ingredient quantities; legacy cancellation is blocked.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public._tableforge_guard_consumed_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_has_sale boolean;
  v_has_snapshot boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.restaurant_id=OLD.restaurant_id
      AND m.reference_order_item_id=OLD.id
      AND m.movement_type='sale'
  ) INTO v_has_sale;

  IF OLD.inventory_recipe_snapshot IS NOT NULL THEN
    IF jsonb_typeof(OLD.inventory_recipe_snapshot)='array' THEN
      v_has_snapshot := jsonb_array_length(OLD.inventory_recipe_snapshot)>0;
    ELSE
      v_has_snapshot := true;
    END IF;
  END IF;

  IF OLD.inventory_consumed_at IS NOT NULL OR v_has_sale OR v_has_snapshot THEN
    RAISE EXCEPTION 'An order item with stock-consumption history cannot be deleted. Use Admin Table Manager → Cancel dish and reconcile the actual ingredient quantities.';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tableforge_guard_consumed_item_cancellation ON public.order_items;
CREATE TRIGGER trg_tableforge_guard_consumed_item_cancellation
BEFORE UPDATE OF serving_status ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public._tableforge_guard_consumed_item_cancellation();

DROP TRIGGER IF EXISTS trg_tableforge_guard_consumed_item_delete ON public.order_items;
CREATE TRIGGER trg_tableforge_guard_consumed_item_delete
BEFORE DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public._tableforge_guard_consumed_item_delete();

REVOKE ALL ON FUNCTION public._tableforge_guard_consumed_item_cancellation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tableforge_guard_consumed_item_delete() FROM PUBLIC, anon, authenticated;

-- One audited cancellation path for pending and prepared items. For consumed
-- items, Admin enters actual quantities and the RPC posts signed adjustment
-- movements against the original order/item. It never deletes stock history.
CREATE OR REPLACE FUNCTION public.admin_cancel_order_item(
  p_item_id uuid,
  p_actual_usage jsonb,
  p_reason text,
  p_panel_token text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_item public.order_items%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_snapshot jsonb;
  v_snapshot_row jsonb;
  v_ingredient public.inventory_ingredients%ROWTYPE;
  v_ingredient_id uuid;
  v_issued numeric(14,3);
  v_actual numeric;
  v_delta numeric(14,3);
  v_balance numeric(14,3);
  v_input_count integer;
  v_unique_input_count integer;
  v_has_sale boolean;
  v_adjustment_count integer := 0;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF coalesce(length(btrim(p_reason)),0)=0 OR length(btrim(p_reason))>250 THEN
    RAISE EXCEPTION 'A cancellation reason of 1 to 250 characters is required.';
  END IF;
  IF p_actual_usage IS NULL OR jsonb_typeof(p_actual_usage)<>'array' THEN
    RAISE EXCEPTION 'Actual ingredient usage must be supplied as an array.';
  END IF;

  SELECT * INTO v_item
  FROM public.order_items oi
  WHERE oi.id=p_item_id AND oi.restaurant_id=v_restaurant_id
  FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Order item not found in this restaurant.'; END IF;

  SELECT * INTO v_order
  FROM public.orders o
  WHERE o.id=v_item.order_id AND o.restaurant_id=v_restaurant_id
  FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Parent order not found in this restaurant.'; END IF;
  IF v_order.status IN ('completed'::public.order_status,'cancelled'::public.order_status)
     OR v_order.payment_status='paid'::public.payment_status
     OR v_order.billing_status='closed' THEN
    RAISE EXCEPTION 'Paid, completed, cancelled or closed order history cannot be changed.';
  END IF;
  IF v_item.serving_status='served' THEN RAISE EXCEPTION 'Served dishes cannot be cancelled.'; END IF;
  IF v_item.serving_status='cancelled' THEN RAISE EXCEPTION 'This dish is already cancelled.'; END IF;
  IF v_item.serving_status NOT IN ('pending','preparing','ready') THEN
    RAISE EXCEPTION 'This dish is not in a cancellable preparation state.';
  END IF;
  IF v_item.inventory_reconciled_at IS NOT NULL THEN RAISE EXCEPTION 'This dish has already been reconciled.'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.restaurant_id=v_restaurant_id AND m.reference_order_item_id=v_item.id AND m.movement_type='sale'
  ) INTO v_has_sale;

  IF (v_item.inventory_consumed_at IS NOT NULL) IS DISTINCT FROM v_has_sale THEN
    RAISE EXCEPTION 'The stock-consumption timestamp and sale ledger do not agree for this item. Keep it unchanged and investigate the ledger before cancellation.';
  END IF;
  IF v_has_sale THEN
    v_snapshot := v_item.inventory_recipe_snapshot;
    IF v_snapshot IS NULL OR jsonb_typeof(v_snapshot)<>'array' THEN
      RAISE EXCEPTION 'This item has recorded stock deductions but no usable recipe snapshot. Keep it unchanged and reconcile it through an audited stock correction.';
    END IF;
    IF jsonb_array_length(v_snapshot)=0 THEN
      RAISE EXCEPTION 'This item has recorded stock deductions but an empty recipe snapshot. Keep it unchanged and reconcile it through an audited stock correction.';
    END IF;
    IF (SELECT count(*) FROM public.inventory_movements m
        WHERE m.restaurant_id=v_restaurant_id AND m.reference_order_item_id=v_item.id AND m.movement_type='sale')<>jsonb_array_length(v_snapshot)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_snapshot) AS snap(value)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.inventory_movements m
           WHERE m.restaurant_id=v_restaurant_id AND m.reference_order_item_id=v_item.id
             AND m.movement_type='sale' AND m.ingredient_id=(snap.value->>'ingredient_id')::uuid
             AND m.quantity_delta=-(snap.value->>'quantity')::numeric
             AND m.unit=snap.value->>'unit'
         )
       ) THEN
      RAISE EXCEPTION 'The saved recipe snapshot and stock deduction rows do not match. Keep the item unchanged and investigate the ledger before cancellation.';
    END IF;
    SELECT count(*),count(DISTINCT value->>'ingredient_id')
      INTO v_input_count,v_unique_input_count
    FROM jsonb_array_elements(p_actual_usage);
    IF v_input_count<>jsonb_array_length(v_snapshot) OR v_input_count<>v_unique_input_count THEN
      RAISE EXCEPTION 'Enter exactly one actual-use quantity for every ingredient in the original recipe snapshot.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_actual_usage) AS supplied(value)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_snapshot) AS snap(value)
        WHERE snap.value->>'ingredient_id'=supplied.value->>'ingredient_id'
      )
    ) THEN
      RAISE EXCEPTION 'Actual-use entries must match the original recipe ingredients exactly.';
    END IF;

    FOR v_snapshot_row IN SELECT value FROM jsonb_array_elements(v_snapshot) ORDER BY (value->>'ingredient_id')::uuid LOOP
      v_ingredient_id := NULLIF(v_snapshot_row->>'ingredient_id','')::uuid;
      v_issued := NULLIF(v_snapshot_row->>'quantity','')::numeric;
      IF v_ingredient_id IS NULL OR v_issued IS NULL OR v_issued<=0
         OR v_issued::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'The saved recipe snapshot is invalid; stock reconciliation has been stopped.';
      END IF;
      SELECT count(*),min(NULLIF(supplied.value->>'actual_quantity','')::numeric)
      INTO v_input_count,v_actual
      FROM jsonb_array_elements(p_actual_usage) AS supplied(value)
      WHERE supplied.value->>'ingredient_id'=v_ingredient_id::text;
      IF v_input_count<>1 OR v_actual IS NULL OR v_actual<0
         OR v_actual::text IN ('NaN','Infinity','-Infinity') OR v_actual<>round(v_actual,3) THEN
        RAISE EXCEPTION 'Actual usage must be a finite, non-negative quantity with at most 3 decimal places for ingredient %.',coalesce(v_snapshot_row->>'name',v_ingredient_id::text);
      END IF;
      SELECT * INTO v_ingredient
      FROM public.inventory_ingredients i
      WHERE i.id=v_ingredient_id AND i.restaurant_id=v_restaurant_id
      FOR UPDATE;
      IF v_ingredient.id IS NULL THEN
        RAISE EXCEPTION 'Original recipe ingredient % is missing from this restaurant.',coalesce(v_snapshot_row->>'name',v_ingredient_id::text);
      END IF;
      IF v_snapshot_row->>'unit' IS DISTINCT FROM v_ingredient.base_unit THEN
        RAISE EXCEPTION 'The base unit for % changed after the original deduction. Reconcile this item manually.',v_ingredient.name;
      END IF;

      v_delta := round(v_issued-v_actual,3);
      IF v_delta<>0 THEN
        SELECT coalesce(sum(m.quantity_delta),0) INTO v_balance
        FROM public.inventory_movements m
        WHERE m.restaurant_id=v_restaurant_id AND m.ingredient_id=v_ingredient_id;
        IF v_balance::text IN ('NaN','Infinity','-Infinity') THEN
          RAISE EXCEPTION 'The stock balance for % is invalid. Reconcile the ledger before cancelling this item.',v_ingredient.name;
        END IF;
        IF v_delta<0 AND v_balance+v_delta<0 THEN
          RAISE EXCEPTION 'Actual usage for % exceeds the remaining stock balance. Record a separate verified stock receipt/correction before completing this reconciliation.',v_ingredient.name;
        END IF;
        INSERT INTO public.inventory_movements(
          restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id,reference_order_id,reference_order_item_id
        ) VALUES (
          v_restaurant_id,v_ingredient_id,
          CASE WHEN v_delta>0 THEN 'adjustment_in' ELSE 'adjustment_out' END,
          v_delta,v_ingredient.base_unit,
          left('Prepared item cancellation reconciliation: '||btrim(p_reason),300),
          auth.uid(),v_order.id,v_item.id
        );
        v_adjustment_count:=v_adjustment_count+1;
      END IF;
    END LOOP;
  ELSE
    IF v_item.inventory_recipe_snapshot IS NOT NULL THEN
      IF jsonb_typeof(v_item.inventory_recipe_snapshot)<>'array' THEN
        RAISE EXCEPTION 'The item has an invalid recipe snapshot without a recorded deduction marker. Keep it unchanged and investigate the item before cancellation.';
      END IF;
      IF jsonb_array_length(v_item.inventory_recipe_snapshot)>0 THEN
        RAISE EXCEPTION 'The item has a recipe snapshot but no recorded deduction marker. Keep it unchanged and investigate the item before cancellation.';
      END IF;
    END IF;
    IF jsonb_array_length(p_actual_usage)<>0 THEN
      RAISE EXCEPTION 'No stock was deducted for this item; no actual-use rows should be submitted.';
    END IF;
  END IF;

  DELETE FROM public.dish_cancellation_requests
  WHERE restaurant_id=v_restaurant_id AND order_item_id=v_item.id;

  IF v_item.inventory_consumed_at IS NOT NULL OR v_has_sale THEN
    PERFORM pg_catalog.set_config('tableforge.inventory_reconciliation_item_id',v_item.id::text,true);
  END IF;

  UPDATE public.order_items
  SET serving_status='cancelled',
      cancellation_reason=left('Admin cancellation: '||btrim(p_reason),300),
      cancelled_at=now(),
      cancelled_by=auth.uid(),
      inventory_reconciled_at=CASE WHEN v_item.inventory_consumed_at IS NOT NULL OR v_has_sale THEN now() ELSE inventory_reconciled_at END,
      kot_ready_previous_status=NULL,
      kot_ready_at=NULL
  WHERE id=v_item.id AND restaurant_id=v_restaurant_id;

  PERFORM public._tableforge_recalculate_order(v_order.id);
  PERFORM public._tableforge_audit_event(
    v_restaurant_id,'admin_order_item_cancelled','order_items',v_item.id::text,btrim(p_reason),
    to_jsonb(v_item),
    jsonb_build_object('serving_status','cancelled','inventory_adjustments',v_adjustment_count,
      'inventory_reconciled',(v_item.inventory_consumed_at IS NOT NULL OR v_has_sale)),
    jsonb_build_object('order_id',v_order.id,'order_number',v_order.order_number,'actual_usage',p_actual_usage)
  );

  RETURN jsonb_build_object('ok',true,'item_id',v_item.id,'order_id',v_order.id,
    'status','cancelled','inventory_reconciled',(v_item.inventory_consumed_at IS NOT NULL OR v_has_sale),
    'adjustment_count',v_adjustment_count);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_cancel_order_item(uuid,jsonb,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_order_item(uuid,jsonb,text,text) TO authenticated;

COMMIT;
