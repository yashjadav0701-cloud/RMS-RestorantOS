-- TableForge: Always calculate recipe usage independently of stock deduction.
-- Run after INGREDIENT_USAGE_RELIABILITY_PATCH.sql.
-- Safe/additive: adds two order-item snapshots and replaces the Preparing trigger,
-- report RPC and Admin cancellation RPC. It does NOT enable strict inventory,
-- add stock movements for calculated-only usage, or rewrite historical orders.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.order_items') IS NULL
     OR to_regclass('public.product_recipes') IS NULL
     OR to_regclass('public.inventory_ingredients') IS NULL
     OR to_regclass('public.inventory_movements') IS NULL
     OR to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'Always-calculate preflight failed: required TableForge inventory/order tables are missing.';
  END IF;
  IF to_regprocedure('public._tableforge_validate_panel_token(text,text[])') IS NULL
     OR to_regprocedure('public._tableforge_audit_event(uuid,text,text,text,text,jsonb,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public._tableforge_recalculate_order(uuid)') IS NULL
     OR to_regprocedure('public._tableforge_consume_recipe_on_served()') IS NULL THEN
    RAISE EXCEPTION 'Always-calculate preflight failed: required inventory authorization, audit, order or trigger helper is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='order_items'
      AND t.tgname='trg_tableforge_consume_recipe_on_served' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Always-calculate preflight failed: expected Preparing-transition trigger is missing.';
  END IF;
END;
$preflight$;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS inventory_usage_calculated_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_actual_usage_snapshot jsonb;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.order_items'::regclass AND conname='order_items_inventory_actual_usage_array_check') THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_inventory_actual_usage_array_check
      CHECK (inventory_actual_usage_snapshot IS NULL OR jsonb_typeof(inventory_actual_usage_snapshot)='array') NOT VALID;
  END IF;
END;
$constraints$;

-- Old strict deductions already have a snapshot. Mark those as calculated too;
-- no stock movement or historical usage is created by this backfill.
UPDATE public.order_items
SET inventory_usage_calculated_at = inventory_consumed_at
WHERE inventory_usage_calculated_at IS NULL
  AND inventory_consumed_at IS NOT NULL
  AND inventory_recipe_snapshot IS NOT NULL
  AND jsonb_typeof(inventory_recipe_snapshot)='array'
  AND jsonb_array_length(inventory_recipe_snapshot)>0;

-- Snapshot recipe quantities on the first Preparing transition in BOTH modes.
-- Strict mode additionally validates and deducts stock; disabled mode only stores
-- the recipe snapshot and calculation timestamp. This keeps usage independent
-- from whether the restaurant has stock recorded or enables deduction.
CREATE OR REPLACE FUNCTION public._tableforge_consume_recipe_on_served()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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
  v_had_snapshot boolean := false;
BEGIN
  IF NEW.serving_status IS DISTINCT FROM 'preparing'
     OR OLD.serving_status IS NOT DISTINCT FROM 'preparing' THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM public.restaurants r WHERE r.id=NEW.restaurant_id FOR SHARE;

  SELECT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.restaurant_id=NEW.restaurant_id
      AND m.reference_order_item_id=NEW.id AND m.movement_type='sale'
  ) INTO v_has_sale;

  IF (NEW.inventory_consumed_at IS NOT NULL) IS DISTINCT FROM v_has_sale THEN
    RAISE EXCEPTION 'This order item has inconsistent stock-consumption markers and ledger rows. Admin must reconcile it before preparation.';
  END IF;

  v_had_snapshot := NEW.inventory_usage_calculated_at IS NOT NULL;
  IF v_had_snapshot AND (
      NEW.inventory_recipe_snapshot IS NULL
      OR jsonb_typeof(NEW.inventory_recipe_snapshot)<>'array'
      OR jsonb_array_length(NEW.inventory_recipe_snapshot)=0
  ) THEN
    RAISE EXCEPTION 'This order item has a usage timestamp but no valid recipe snapshot. Admin must investigate before preparation.';
  END IF;
  IF NOT v_had_snapshot AND NEW.inventory_recipe_snapshot IS NOT NULL THEN
    IF jsonb_typeof(NEW.inventory_recipe_snapshot)<>'array' OR jsonb_array_length(NEW.inventory_recipe_snapshot)>0 THEN
      RAISE EXCEPTION 'This order item has an old recipe snapshot without a calculation timestamp. Admin must investigate before preparation.';
    END IF;
  END IF;

  SELECT coalesce(w.inventory_mode,'disabled') INTO v_mode
  FROM (SELECT 1) seed
  LEFT JOIN public.restaurant_workflow_settings w ON w.restaurant_id=NEW.restaurant_id;

  IF NEW.inventory_usage_calculated_at IS NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'ingredient_id',r.ingredient_id,
      'quantity_per_serving',r.quantity_per_serving,
      'quantity',round(r.quantity_per_serving*NEW.quantity,3),
      'unit',coalesce(i.base_unit,'unknown'),
      'name',coalesce(i.name,'Unavailable ingredient'),
      'is_estimate',coalesce(r.is_estimate,true),
      'ingredient_active',coalesce(i.is_active,false),
      'source_note',r.source_note
    ) ORDER BY coalesce(i.name,'Unavailable ingredient'),r.ingredient_id),'[]'::jsonb)
    INTO v_recipe
    FROM public.product_recipes r
    LEFT JOIN public.inventory_ingredients i
      ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id
    WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id;

    IF jsonb_array_length(v_recipe)=0 THEN
      IF v_mode='strict' THEN
        RAISE EXCEPTION 'This restaurant requires a saved recipe before preparation can start.';
      END IF;
      -- Tracking disabled: do not block kitchen operation for a menu item with
      -- no recipe. The report will identify it as not reconstructable.
      RETURN NEW;
    END IF;

    NEW.inventory_recipe_snapshot := v_recipe;
    NEW.inventory_usage_calculated_at := now();
  ELSE
    v_recipe := NEW.inventory_recipe_snapshot;
  END IF;

  -- Re-entering Preparing after an Undo Ready action must never deduct the
  -- same item twice; the unique ledger index is a backstop, not the workflow.
  IF v_has_sale THEN
    RETURN NEW;
  END IF;

  -- A recipe snapshot made while deductions were disabled is usage history, not
  -- permission to deduct stock later. Strict mode cannot be enabled with active
  -- order items; this guard protects legacy/direct RPC paths as well.
  IF v_mode='strict' AND v_had_snapshot AND NEW.inventory_consumed_at IS NULL THEN
    RAISE EXCEPTION 'This dish already has a calculated usage snapshot but no stock deduction. Do not retroactively deduct it; Admin must reconcile the item first.';
  END IF;

  IF v_mode<>'strict' THEN
    RETURN NEW;
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id=NEW.order_id AND o.restaurant_id=NEW.restaurant_id
  FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found for inventory deduction.'; END IF;

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

  FOR v_row IN
    SELECT (x->>'ingredient_id')::uuid AS ingredient_id,
      (x->>'quantity')::numeric AS quantity,
      x->>'unit' AS unit,
      x->>'name' AS name
    FROM jsonb_array_elements(v_recipe) x
    ORDER BY (x->>'ingredient_id')::uuid
  LOOP
    PERFORM 1 FROM public.inventory_ingredients
    WHERE id=v_row.ingredient_id AND restaurant_id=NEW.restaurant_id AND is_active FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recipe ingredient % is missing or inactive.',v_row.name; END IF;

    IF EXISTS (
      SELECT 1 FROM public.inventory_movements m
      WHERE m.ingredient_id=v_row.ingredient_id AND m.restaurant_id=NEW.restaurant_id
        AND m.unit IS DISTINCT FROM v_row.unit
    ) THEN
      RAISE EXCEPTION 'Stock ledger unit mismatch for %. Reconcile the ingredient ledger first.',v_row.name;
    END IF;

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
  END LOOP;

  FOR v_row IN
    SELECT (x->>'ingredient_id')::uuid AS ingredient_id,
      (x->>'quantity')::numeric AS quantity,
      x->>'unit' AS unit,
      x->>'name' AS name
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

  NEW.inventory_consumed_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._tableforge_consume_recipe_on_served() FROM PUBLIC,anon,authenticated;

-- Usage report. Calculated recipe usage starts at Preparing and remains visible
-- while Preparing, Ready or Served, whether or not stock exists or deduction is
-- enabled. Recorded ledger deductions and actual no-stock cancellation usage
-- remain separate from calculated-only usage.
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
    IF split_part(p_period,':',2)::date>split_part(p_period,':',3)::date THEN
      RAISE EXCEPTION 'The reporting end date must be on or after the start date.';
    END IF;
    v_since:=split_part(p_period,':',2)::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until:=(split_part(p_period,':',3)::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period='today' THEN
    v_since:=(now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until:=((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period IN ('7','30','90') THEN
    v_since:=((now() AT TIME ZONE 'Asia/Kolkata')::date-(p_period::integer-1))::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until:=((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period='all' THEN
    v_since:=NULL; v_until:=NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported reporting period.';
  END IF;

  SELECT coalesce(s.inventory_mode,'disabled') INTO v_inventory_mode
  FROM (SELECT 1) seed
  LEFT JOIN public.restaurant_workflow_settings s ON s.restaurant_id=v_restaurant_id;

  WITH stock_balance AS (
    SELECT m.ingredient_id,CASE WHEN sum(m.quantity_delta)::text IN ('NaN','Infinity','-Infinity') THEN 0 ELSE round(sum(m.quantity_delta),3) END AS balance
    FROM public.inventory_movements m
    WHERE m.restaurant_id=v_restaurant_id
    GROUP BY m.ingredient_id
  ), sale_rows AS (
    SELECT sale.ingredient_id,i.name,i.base_unit,
      round(sum(-(sale.quantity_delta+coalesce(recon.delta,0))),3) AS quantity
    FROM public.inventory_movements sale
    JOIN public.inventory_ingredients i ON i.id=sale.ingredient_id AND i.restaurant_id=sale.restaurant_id
    LEFT JOIN LATERAL (
      SELECT sum(a.quantity_delta) AS delta
      FROM public.inventory_movements a
      WHERE a.restaurant_id=sale.restaurant_id AND a.ingredient_id=sale.ingredient_id
        AND a.reference_order_item_id=sale.reference_order_item_id
        AND a.movement_type IN ('adjustment_in','adjustment_out')
    ) recon ON true
    WHERE sale.restaurant_id=v_restaurant_id AND sale.movement_type='sale'
      AND (v_since IS NULL OR sale.created_at>=v_since)
      AND (v_until IS NULL OR sale.created_at<v_until)
    GROUP BY sale.ingredient_id,i.name,i.base_unit
    HAVING sum(-(sale.quantity_delta+coalesce(recon.delta,0)))>0
  ), untracked_actual_rows AS (
    SELECT (x.value->>'ingredient_id')::uuid AS ingredient_id,
      coalesce(i.name,x.value->>'name','Unavailable ingredient') AS name,
      coalesce(i.base_unit,x.value->>'unit','unknown') AS base_unit,
      round(sum((x.value->>'actual_quantity')::numeric),3) AS quantity
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(oi.inventory_actual_usage_snapshot,'[]'::jsonb)) x(value)
    LEFT JOIN public.inventory_ingredients i ON i.id=(x.value->>'ingredient_id')::uuid AND i.restaurant_id=oi.restaurant_id
    WHERE oi.restaurant_id=v_restaurant_id AND oi.serving_status='cancelled'
      AND oi.inventory_reconciled_at IS NOT NULL
      AND oi.inventory_consumed_at IS NULL
      AND o.status<>'cancelled'::public.order_status
      AND (v_since IS NULL OR coalesce(oi.inventory_reconciled_at,oi.created_at)>=v_since)
      AND (v_until IS NULL OR coalesce(oi.inventory_reconciled_at,oi.created_at)<v_until)
      AND NOT EXISTS (SELECT 1 FROM public.inventory_movements sold WHERE sold.restaurant_id=oi.restaurant_id
        AND sold.reference_order_item_id=oi.id AND sold.movement_type='sale')
    GROUP BY (x.value->>'ingredient_id')::uuid,coalesce(i.name,x.value->>'name','Unavailable ingredient'),coalesce(i.base_unit,x.value->>'unit','unknown')
    HAVING sum((x.value->>'actual_quantity')::numeric)>0
  ), prepared_items AS (
    SELECT oi.id,oi.product_id,oi.name_snapshot,oi.quantity,oi.created_at,oi.restaurant_id,
      coalesce(oi.inventory_usage_calculated_at,oi.created_at) AS usage_at,
      oi.inventory_recipe_snapshot
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    WHERE oi.restaurant_id=v_restaurant_id
      AND oi.serving_status IN ('preparing','ready','served')
      AND o.status<>'cancelled'::public.order_status
      AND (v_since IS NULL OR coalesce(oi.inventory_usage_calculated_at,oi.created_at)>=v_since)
      AND (v_until IS NULL OR coalesce(oi.inventory_usage_calculated_at,oi.created_at)<v_until)
      AND NOT EXISTS (SELECT 1 FROM public.inventory_movements sold
        WHERE sold.restaurant_id=oi.restaurant_id AND sold.reference_order_item_id=oi.id AND sold.movement_type='sale')
  ), snapshot_lines AS (
    SELECT p.id AS item_id,p.name_snapshot,p.quantity AS servings,
      (x.value->>'ingredient_id')::uuid AS ingredient_id,
      coalesce(i.name,x.value->>'name','Unavailable ingredient') AS ingredient,
      coalesce(i.base_unit,x.value->>'unit','unknown') AS unit,
      coalesce((x.value->>'quantity')::numeric,
        (x.value->>'quantity_per_serving')::numeric*p.quantity) AS used_quantity,
      coalesce((x.value->>'is_estimate')::boolean,true) AS is_estimate,
      coalesce((x.value->>'ingredient_active')::boolean,i.is_active,false) AS ingredient_active
    FROM prepared_items p
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.inventory_recipe_snapshot)='array'
        THEN p.inventory_recipe_snapshot ELSE '[]'::jsonb END
    ) x(value)
    LEFT JOIN public.inventory_ingredients i ON i.id=(x.value->>'ingredient_id')::uuid AND i.restaurant_id=p.restaurant_id
  ), legacy_recipe_lines AS (
    SELECT p.id AS item_id,p.name_snapshot,p.quantity AS servings,
      r.ingredient_id,i.name AS ingredient,i.base_unit AS unit,
      r.quantity_per_serving*p.quantity AS used_quantity,
      coalesce(r.is_estimate,true) AS is_estimate,
      i.is_active AS ingredient_active
    FROM prepared_items p
    JOIN public.product_recipes r ON r.product_id=p.product_id AND r.restaurant_id=p.restaurant_id
      AND r.created_at<=p.created_at
    JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id
    WHERE (p.inventory_recipe_snapshot IS NULL OR jsonb_typeof(p.inventory_recipe_snapshot)<>'array'
      OR jsonb_array_length(p.inventory_recipe_snapshot)=0)
      AND NOT EXISTS (
        SELECT 1 FROM public.product_recipes later
        WHERE later.product_id=p.product_id AND later.restaurant_id=p.restaurant_id AND later.created_at>p.created_at
      )
  ), calculated_lines AS (
    SELECT * FROM snapshot_lines
    UNION ALL
    SELECT * FROM legacy_recipe_lines
  ), calculated_ingredients AS (
    SELECT cl.ingredient_id,cl.ingredient,cl.unit,
      round(sum(cl.used_quantity),3) AS quantity,
      bool_or(cl.is_estimate) AS has_estimated_recipe,
      bool_or(NOT cl.ingredient_active) AS has_unavailable_ingredient
    FROM calculated_lines cl
    WHERE cl.used_quantity IS NOT NULL AND cl.used_quantity>0
      AND cl.used_quantity::text NOT IN ('NaN','Infinity','-Infinity')
    GROUP BY cl.ingredient_id,cl.ingredient,cl.unit
  ), recorded_items AS (
    SELECT m.reference_order_item_id,min(m.created_at) AS sale_at
    FROM public.inventory_movements m
    WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale'
      AND m.reference_order_item_id IS NOT NULL
      AND (v_since IS NULL OR m.created_at>=v_since)
      AND (v_until IS NULL OR m.created_at<v_until)
    GROUP BY m.reference_order_item_id
  ), recorded_dishes AS (
    SELECT oi.name_snapshot AS dish,sum(oi.quantity)::numeric AS servings,'recorded'::text AS kind
    FROM recorded_items ri
    JOIN public.order_items oi ON oi.id=ri.reference_order_item_id AND oi.restaurant_id=v_restaurant_id
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    WHERE oi.serving_status<>'cancelled' AND o.status<>'cancelled'::public.order_status
    GROUP BY oi.name_snapshot
  ), recorded_cancelled_dishes AS (
    SELECT oi.name_snapshot||' · cancelled after preparation' AS dish,sum(oi.quantity)::numeric AS servings,'recorded'::text AS kind
    FROM recorded_items ri
    JOIN public.order_items oi ON oi.id=ri.reference_order_item_id AND oi.restaurant_id=v_restaurant_id
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    WHERE oi.serving_status='cancelled' AND oi.inventory_reconciled_at IS NOT NULL
      AND oi.inventory_consumed_at IS NOT NULL AND o.status<>'cancelled'::public.order_status
    GROUP BY oi.name_snapshot
  ), calculated_dishes AS (
    SELECT p.name_snapshot AS dish,sum(p.quantity)::numeric AS servings,'calculated'::text AS kind
    FROM prepared_items p
    WHERE EXISTS (SELECT 1 FROM calculated_lines cl WHERE cl.item_id=p.id)
    GROUP BY p.name_snapshot
  ), actual_untracked_dishes AS (
    SELECT oi.name_snapshot||' · cancelled after preparation' AS dish,sum(oi.quantity)::numeric AS servings,'actual_untracked'::text AS kind
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    WHERE oi.restaurant_id=v_restaurant_id AND oi.serving_status='cancelled'
      AND oi.inventory_reconciled_at IS NOT NULL AND oi.inventory_consumed_at IS NULL
      AND jsonb_typeof(oi.inventory_actual_usage_snapshot)='array'
      AND jsonb_array_length(oi.inventory_actual_usage_snapshot)>0
      AND o.status<>'cancelled'::public.order_status
      AND (v_since IS NULL OR oi.inventory_reconciled_at>=v_since)
      AND (v_until IS NULL OR oi.inventory_reconciled_at<v_until)
    GROUP BY oi.name_snapshot
  ), not_backfilled_dishes AS (
    SELECT p.name_snapshot||' · recipe unavailable at preparation' AS dish,
      sum(p.quantity)::numeric AS servings,'not_backfilled'::text AS kind
    FROM prepared_items p
    WHERE NOT EXISTS (SELECT 1 FROM calculated_lines cl WHERE cl.item_id=p.id)
    GROUP BY p.name_snapshot
  ), ingredient_rows AS (
    SELECT jsonb_build_object('ingredient',s.name,'unit',s.base_unit,'quantity',s.quantity,
      'currentStock',coalesce(b.balance,0),'kind','recorded','estimated',false,
      'note','Actual net quantity from stock deduction movements after linked cancellation reconciliation.') AS row_data,
      s.name AS sort_name,0 AS sort_kind
    FROM sale_rows s LEFT JOIN stock_balance b ON b.ingredient_id=s.ingredient_id
    UNION ALL
    SELECT jsonb_build_object('ingredient',u.name,'unit',u.base_unit,'quantity',u.quantity,
      'currentStock',coalesce(b.balance,0),'kind','actual_untracked','estimated',false,
      'note','Admin-confirmed actual use for a prepared dish cancelled while automatic stock deduction was off; stock ledger was not changed.') AS row_data,
      u.name AS sort_name,1 AS sort_kind
    FROM untracked_actual_rows u LEFT JOIN stock_balance b ON b.ingredient_id=u.ingredient_id
    UNION ALL
    SELECT jsonb_build_object('ingredient',e.ingredient,'unit',e.unit,'quantity',e.quantity,
      'currentStock',coalesce(b.balance,0),'kind','calculated','estimated',e.has_estimated_recipe,
      'recipeEstimate',e.has_estimated_recipe,'unavailableIngredient',e.has_unavailable_ingredient,
      'note',CASE WHEN e.has_unavailable_ingredient THEN 'Calculated from the saved recipe snapshot, but an ingredient is now inactive or unavailable; this usage was not deducted.'
        WHEN e.has_estimated_recipe THEN 'Calculated from recipe quantities marked estimated; this usage was not deducted from stock.'
        ELSE 'Calculated from the saved recipe snapshot; this usage was not deducted from stock.' END) AS row_data,
      e.ingredient AS sort_name,2 AS sort_kind
    FROM calculated_ingredients e LEFT JOIN stock_balance b ON b.ingredient_id=e.ingredient_id
  ), dish_rows AS (
    SELECT * FROM recorded_dishes
    UNION ALL SELECT * FROM recorded_cancelled_dishes
    UNION ALL SELECT * FROM calculated_dishes
    UNION ALL SELECT * FROM actual_untracked_dishes
    UNION ALL SELECT * FROM not_backfilled_dishes
  )
  SELECT
    coalesce((SELECT jsonb_agg(row_data ORDER BY sort_name,sort_kind) FROM ingredient_rows),'[]'::jsonb),
    coalesce((SELECT jsonb_agg(jsonb_build_object('dish',d.dish,'servings',d.servings,'kind',d.kind)
      ORDER BY d.dish,d.kind) FROM dish_rows d),'[]'::jsonb),
    jsonb_build_object(
      'ingredientsConsumed',coalesce((SELECT count(DISTINCT ingredient_id) FROM sale_rows),0),
      'eligibleServings',coalesce((SELECT sum(oi.quantity) FROM recorded_items ri
        JOIN public.order_items oi ON oi.id=ri.reference_order_item_id AND oi.restaurant_id=v_restaurant_id),0),
      'calculatedIngredientTypes',coalesce((SELECT count(DISTINCT ingredient_id) FROM calculated_ingredients),0),
      'calculatedServings',coalesce((SELECT sum(qty) FROM (
        SELECT DISTINCT p.id,p.quantity AS qty FROM prepared_items p
        WHERE EXISTS (SELECT 1 FROM calculated_lines cl WHERE cl.item_id=p.id)
      ) calculated_item_servings),0),
      'actualUntrackedIngredientTypes',coalesce((SELECT count(DISTINCT ingredient_id) FROM untracked_actual_rows),0),
      'movementCount',coalesce((SELECT count(*) FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id
        AND (v_since IS NULL OR m.created_at>=v_since) AND (v_until IS NULL OR m.created_at<v_until)),0),
      'notBackfilledServings',coalesce((SELECT sum(p.quantity) FROM prepared_items p
        WHERE NOT EXISTS (SELECT 1 FROM calculated_lines cl WHERE cl.item_id=p.id)),0),
      'inventoryMode',coalesce(v_inventory_mode,'disabled')
    )
  INTO v_ingredients,v_dishes,v_metrics;

  -- Keep the Stock adjustments tab functional; it is a separate view of all
  -- non-sale ledger entries (opening balances, receipts, wastage and corrections).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'ingredient',i.name,'unit',m.unit,'movement_type',m.movement_type,
    'quantity_delta',m.quantity_delta,'reason',m.reason,'created_at',m.created_at
  ) ORDER BY m.created_at DESC),'[]'::jsonb)
  INTO v_adjustments
  FROM public.inventory_movements m
  JOIN public.inventory_ingredients i ON i.id=m.ingredient_id AND i.restaurant_id=m.restaurant_id
  WHERE m.restaurant_id=v_restaurant_id AND m.movement_type<>'sale'
    AND (v_since IS NULL OR m.created_at>=v_since)
    AND (v_until IS NULL OR m.created_at<v_until);

  RETURN jsonb_build_object(
    'ok',true,'period',p_period,'since',v_since,'until',v_until,
    'metrics',v_metrics,'ingredients',coalesce(v_ingredients,'[]'::jsonb),
    'dishes',coalesce(v_dishes,'[]'::jsonb),'adjustments',coalesce(v_adjustments,'[]'::jsonb),
    'reportSemantics',jsonb_build_object(
      'recorded','Actual net stock deductions from the permanent movement ledger, adjusted for Admin-confirmed prepared-item cancellation.',
      'calculated','Recipe quantities are calculated as soon as an item enters Preparing, regardless of current stock or inventory mode. Calculated usage does not change stock balances.',
      'actual_untracked','Actual usage entered by Admin for a prepared dish cancelled while stock deduction was disabled. It is retained for usage reporting but does not change stock balances.',
      'not_backfilled','Prepared items without a reconstructable recipe at preparation time; no quantities are invented.'
    )
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_inventory_usage_report(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_usage_report(text,text) TO authenticated;

-- Admin cancellation reconciliation also works when stock deduction is OFF.
-- In that case actual use is saved on the order item for reporting, but no
-- artificial stock movement is posted. When stock was deducted, only the delta
-- between issued recipe quantity and Admin-entered actual use is posted.
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
  v_has_usage_snapshot boolean := false;
  v_actual_usage_snapshot jsonb := '[]'::jsonb;
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

  SELECT * INTO v_item FROM public.order_items oi
  WHERE oi.id=p_item_id AND oi.restaurant_id=v_restaurant_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Order item not found in this restaurant.'; END IF;
  SELECT * INTO v_order FROM public.orders o
  WHERE o.id=v_item.order_id AND o.restaurant_id=v_restaurant_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Parent order not found in this restaurant.'; END IF;
  IF v_order.status IN ('completed'::public.order_status,'cancelled'::public.order_status)
     OR v_order.payment_status='paid'::public.payment_status OR v_order.billing_status='closed' THEN
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
    RAISE EXCEPTION 'The stock-consumption timestamp and sale ledger do not agree for this item. Keep it unchanged and investigate before cancellation.';
  END IF;

  IF v_item.inventory_usage_calculated_at IS NOT NULL
     AND jsonb_typeof(v_item.inventory_recipe_snapshot)='array'
     AND jsonb_array_length(v_item.inventory_recipe_snapshot)>0 THEN
    v_has_usage_snapshot := true;
  END IF;

  IF v_has_sale OR v_has_usage_snapshot THEN
    v_snapshot:=v_item.inventory_recipe_snapshot;
    IF v_snapshot IS NULL OR jsonb_typeof(v_snapshot)<>'array' OR jsonb_array_length(v_snapshot)=0 THEN
      RAISE EXCEPTION 'This prepared item has no valid recipe snapshot. Keep it unchanged and investigate before cancellation.';
    END IF;

    IF v_has_sale AND (
      (SELECT count(*) FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id
        AND m.reference_order_item_id=v_item.id AND m.movement_type='sale')<>jsonb_array_length(v_snapshot)
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_snapshot) snap(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.inventory_movements m
          WHERE m.restaurant_id=v_restaurant_id AND m.reference_order_item_id=v_item.id
            AND m.movement_type='sale' AND m.ingredient_id=(snap.value->>'ingredient_id')::uuid
            AND m.quantity_delta=-(snap.value->>'quantity')::numeric AND m.unit=snap.value->>'unit'
        )
      )
    ) THEN
      RAISE EXCEPTION 'Saved recipe snapshot and stock deduction rows do not match. Keep the item unchanged and investigate.';
    END IF;

    SELECT count(*),count(DISTINCT value->>'ingredient_id')
    INTO v_input_count,v_unique_input_count FROM jsonb_array_elements(p_actual_usage);
    IF v_input_count<>jsonb_array_length(v_snapshot) OR v_input_count<>v_unique_input_count THEN
      RAISE EXCEPTION 'Enter exactly one actual-use quantity for every ingredient in the saved recipe snapshot.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_actual_usage) supplied(value)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) snap(value)
        WHERE snap.value->>'ingredient_id'=supplied.value->>'ingredient_id')
    ) THEN
      RAISE EXCEPTION 'Actual-use entries must match the original recipe ingredients exactly.';
    END IF;

    FOR v_snapshot_row IN
      SELECT value FROM jsonb_array_elements(v_snapshot) ORDER BY (value->>'ingredient_id')::uuid
    LOOP
      v_ingredient_id:=NULLIF(v_snapshot_row->>'ingredient_id','')::uuid;
      v_issued:=NULLIF(v_snapshot_row->>'quantity','')::numeric;
      IF v_ingredient_id IS NULL OR v_issued IS NULL OR v_issued<0
         OR v_issued::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'Saved recipe snapshot is invalid; stock reconciliation has been stopped.';
      END IF;

      SELECT count(*),min(NULLIF(supplied.value->>'actual_quantity','')::numeric)
      INTO v_input_count,v_actual FROM jsonb_array_elements(p_actual_usage) supplied(value)
      WHERE supplied.value->>'ingredient_id'=v_ingredient_id::text;
      IF v_input_count<>1 OR v_actual IS NULL OR v_actual<0
         OR v_actual::text IN ('NaN','Infinity','-Infinity') OR v_actual<>round(v_actual,3) THEN
        RAISE EXCEPTION 'Actual usage must be finite, non-negative and limited to 3 decimal places for %.',coalesce(v_snapshot_row->>'name',v_ingredient_id::text);
      END IF;

      SELECT * INTO v_ingredient FROM public.inventory_ingredients i
      WHERE i.id=v_ingredient_id AND i.restaurant_id=v_restaurant_id FOR UPDATE;
      IF v_ingredient.id IS NULL THEN
        RAISE EXCEPTION 'Original recipe ingredient % is missing from this restaurant.',coalesce(v_snapshot_row->>'name',v_ingredient_id::text);
      END IF;
      IF v_snapshot_row->>'unit' IS DISTINCT FROM v_ingredient.base_unit THEN
        RAISE EXCEPTION 'Base unit for % changed after preparation. Reconcile manually.',v_ingredient.name;
      END IF;

      v_actual_usage_snapshot:=v_actual_usage_snapshot||jsonb_build_array(jsonb_build_object(
        'ingredient_id',v_ingredient_id,'name',v_ingredient.name,'unit',v_ingredient.base_unit,
        'actual_quantity',v_actual,'issued_quantity',v_issued
      ));

      IF v_has_sale THEN
        v_delta:=round(v_issued-v_actual,3);
        IF v_delta<>0 THEN
          SELECT coalesce(sum(m.quantity_delta),0) INTO v_balance
          FROM public.inventory_movements m
          WHERE m.restaurant_id=v_restaurant_id AND m.ingredient_id=v_ingredient_id;
          IF v_balance::text IN ('NaN','Infinity','-Infinity') THEN
            RAISE EXCEPTION 'Stock balance for % is invalid. Reconcile the ledger first.',v_ingredient.name;
          END IF;
          IF v_delta<0 AND v_balance+v_delta<0 THEN
            RAISE EXCEPTION 'Actual usage for % exceeds remaining stock. Record a verified receipt/correction before reconciliation.',v_ingredient.name;
          END IF;
          INSERT INTO public.inventory_movements(
            restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id,reference_order_id,reference_order_item_id
          ) VALUES (
            v_restaurant_id,v_ingredient_id,CASE WHEN v_delta>0 THEN 'adjustment_in' ELSE 'adjustment_out' END,
            v_delta,v_ingredient.base_unit,left('Prepared item cancellation reconciliation: '||btrim(p_reason),300),
            auth.uid(),v_order.id,v_item.id
          );
          v_adjustment_count:=v_adjustment_count+1;
        END IF;
      END IF;
    END LOOP;
  ELSE
    IF v_item.inventory_recipe_snapshot IS NOT NULL
       AND (jsonb_typeof(v_item.inventory_recipe_snapshot)<>'array' OR jsonb_array_length(v_item.inventory_recipe_snapshot)>0) THEN
      RAISE EXCEPTION 'The item has an unmarked recipe snapshot. Keep it unchanged and investigate before cancellation.';
    END IF;
    IF jsonb_array_length(p_actual_usage)<>0 THEN
      RAISE EXCEPTION 'No preparation usage snapshot exists; actual-use rows cannot be submitted for this item.';
    END IF;
  END IF;

  DELETE FROM public.dish_cancellation_requests
  WHERE restaurant_id=v_restaurant_id AND order_item_id=v_item.id;

  IF v_has_sale OR v_has_usage_snapshot THEN
    PERFORM pg_catalog.set_config('tableforge.inventory_reconciliation_item_id',v_item.id::text,true);
  END IF;

  UPDATE public.order_items
  SET serving_status='cancelled',
      cancellation_reason=left('Admin cancellation: '||btrim(p_reason),300),
      cancelled_at=now(),cancelled_by=auth.uid(),
      inventory_reconciled_at=CASE WHEN v_has_sale OR v_has_usage_snapshot THEN now() ELSE inventory_reconciled_at END,
      inventory_actual_usage_snapshot=CASE WHEN v_has_usage_snapshot AND NOT v_has_sale THEN v_actual_usage_snapshot ELSE inventory_actual_usage_snapshot END,
      kot_ready_previous_status=NULL,kot_ready_at=NULL
  WHERE id=v_item.id AND restaurant_id=v_restaurant_id;

  PERFORM public._tableforge_recalculate_order(v_order.id);
  PERFORM public._tableforge_audit_event(
    v_restaurant_id,'admin_order_item_cancelled','order_items',v_item.id::text,btrim(p_reason),
    to_jsonb(v_item),
    jsonb_build_object('serving_status','cancelled','inventory_adjustments',v_adjustment_count,
      'inventory_reconciled',(v_has_sale OR v_has_usage_snapshot),
      'stock_deduction_was_recorded',v_has_sale),
    jsonb_build_object('order_id',v_order.id,'order_number',v_order.order_number,'actual_usage',p_actual_usage)
  );

  RETURN jsonb_build_object('ok',true,'item_id',v_item.id,'order_id',v_order.id,
    'status','cancelled','inventory_reconciled',(v_has_sale OR v_has_usage_snapshot),
    'stock_deduction_was_recorded',v_has_sale,'adjustment_count',v_adjustment_count);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_cancel_order_item(uuid,jsonb,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_order_item(uuid,jsonb,text,text) TO authenticated;

COMMIT;
