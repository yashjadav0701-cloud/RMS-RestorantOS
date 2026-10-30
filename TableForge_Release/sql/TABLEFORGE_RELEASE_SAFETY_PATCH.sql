-- TableForge Release Safety Patch
-- Narrow update for the currently audited production schema.
-- It intentionally preserves all historical orders, sessions, stock movements and recipes.
-- Run once in the Supabase SQL Editor. All changes are in a single transaction.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.apply_admin_bill_discount(uuid,uuid,text,numeric,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: apply_admin_bill_discount(uuid,uuid,text,numeric,text,text) does not exist. No changes committed.';
  END IF;
  IF to_regprocedure('public.save_restaurant_workflow_settings(text,boolean,text[],text)') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: save_restaurant_workflow_settings(text,boolean,text[],text) does not exist. No changes committed.';
  END IF;
  IF to_regprocedure('public._tableforge_consume_recipe_on_served()') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: the inventory-consumption trigger function does not exist. No changes committed.';
  END IF;
  IF to_regclass('public.dining_sessions') IS NULL OR to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_items') IS NULL OR to_regclass('public.product_recipes') IS NULL
     OR to_regclass('public.inventory_ingredients') IS NULL OR to_regclass('public.inventory_movements') IS NULL
     OR to_regclass('public.restaurant_workflow_settings') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: one or more required TableForge tables are missing. No changes committed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='order_items'
      AND t.tgname='trg_tableforge_consume_recipe_on_served' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Preflight failed: expected inventory consumption trigger is missing. No changes committed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='inventory_consumed_at')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='inventory_recipe_snapshot')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='product_recipes' AND column_name='is_estimate') THEN
    RAISE EXCEPTION 'Preflight failed: required inventory verification columns are missing. No changes committed.';
  END IF;
END;
$preflight$;

-- Enforce a meaningful reason in the RPC as well as the existing table triggers.
CREATE OR REPLACE FUNCTION public.apply_admin_bill_discount(
  p_session_id uuid,
  p_order_id uuid,
  p_discount_type text,
  p_discount_value numeric,
  p_reason text,
  p_panel_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_type text := lower(btrim(coalesce(p_discount_type,'')));
  v_reason text := nullif(btrim(coalesce(p_reason,'')), '');
  v_value numeric(12,2) := round(coalesce(p_discount_value,0),2);
  v_subtotal numeric(12,2);
  v_taxable_subtotal numeric(12,2);
  v_discount_amount numeric(12,2);
  v_ratio numeric;
  v_cgst numeric(12,2);
  v_sgst numeric(12,2);
  v_rounding numeric(12,2);
  v_pre_round numeric(12,2);
  v_grand_total numeric(12,2);
  v_base_cgst numeric(12,2);
  v_base_sgst numeric(12,2);
  v_base_rounding numeric(12,2);
  v_base_total numeric(12,2);
  v_session public.dining_sessions%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_before jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Valid Admin panel authorization is required to discount a bill.';
  END IF;
  IF (p_session_id IS NULL) = (p_order_id IS NULL) THEN
    RAISE EXCEPTION 'Supply exactly one dining session ID or takeaway order ID.';
  END IF;
  IF v_type NOT IN ('amount','percent') THEN
    RAISE EXCEPTION 'Discount type must be amount or percent.';
  END IF;
  IF p_discount_value IS NULL THEN
    RAISE EXCEPTION 'Discount value is required.';
  END IF;
  IF v_value < 0 OR (v_type='percent' AND v_value > 100) THEN
    RAISE EXCEPTION 'Percentage must be between 0 and 100; discount cannot be negative.';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 300 THEN
    RAISE EXCEPTION 'Discount reason must be 300 characters or fewer.';
  END IF;
  IF v_value > 0 AND v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required for a non-zero discount.';
  END IF;

  IF p_session_id IS NOT NULL THEN
    SELECT ds.* INTO v_session
    FROM public.dining_sessions ds
    WHERE ds.id=p_session_id
      AND ds.restaurant_id=v_restaurant_id
      AND ds.status='bill_ready'
      AND ds.closed_at IS NULL
      AND ds.payment_status IS DISTINCT FROM 'paid'::public.payment_status
    FOR UPDATE;
    IF v_session.id IS NULL THEN
      RAISE EXCEPTION 'Only an unpaid, open bill-ready dining session can be discounted.';
    END IF;

    PERFORM 1 FROM public.orders o
    WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id
    FOR UPDATE;
    v_before := to_jsonb(v_session);

    SELECT coalesce(sum(o.subtotal),0), coalesce(sum(o.cgst),0),
           coalesce(sum(o.sgst),0), coalesce(sum(o.rounding),0),
           coalesce(sum(o.grand_total),0)
    INTO v_subtotal, v_base_cgst, v_base_sgst, v_base_rounding, v_base_total
    FROM public.orders o
    WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id
      AND o.status <> 'cancelled'::public.order_status;

    -- Preserve the session snapshot when present, but fall back to its source
    -- orders if an older bill has a zero/uninitialised session subtotal.
    v_subtotal := coalesce(nullif(v_session.bill_subtotal, 0), v_subtotal, 0);
    IF v_subtotal <= 0 THEN RAISE EXCEPTION 'This bill has no positive subtotal.'; END IF;
    IF v_type='amount' AND v_value > v_subtotal THEN
      RAISE EXCEPTION 'Fixed discount cannot exceed the bill subtotal.';
    END IF;

    IF v_value=0 THEN
      v_discount_amount := 0;
    ELSIF v_type='percent' THEN
      v_discount_amount := round(v_subtotal * v_value / 100.0, 2);
    ELSE
      v_discount_amount := v_value;
    END IF;
    v_ratio := CASE WHEN v_subtotal > 0 THEN (v_subtotal-v_discount_amount)/v_subtotal ELSE 1 END;

    IF v_discount_amount > 0 THEN
      SELECT coalesce(sum(round(x.taxable_subtotal * v_ratio * x.cgst_rate / 100.0, 2)),0),
             coalesce(sum(round(x.taxable_subtotal * v_ratio * x.sgst_rate / 100.0, 2)),0)
      INTO v_cgst, v_sgst
      FROM (
        SELECT o.id, o.cgst_rate, o.sgst_rate,
               coalesce(sum(oi.unit_price * oi.quantity) FILTER (
                 WHERE NOT coalesce(oi.tax_exempt_snapshot,false)
                   AND oi.serving_status <> 'cancelled'
               ),0) AS taxable_subtotal
        FROM public.orders o
        LEFT JOIN public.order_items oi
          ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
        WHERE o.session_id=v_session.id
          AND o.restaurant_id=v_restaurant_id
          AND o.status <> 'cancelled'::public.order_status
        GROUP BY o.id, o.cgst_rate, o.sgst_rate
      ) x;
      v_pre_round := round(v_subtotal-v_discount_amount+v_cgst+v_sgst,2);
      v_grand_total := round(v_pre_round);
      v_rounding := round(v_grand_total-v_pre_round,2);
    ELSE
      v_cgst := v_base_cgst;
      v_sgst := v_base_sgst;
      v_rounding := v_base_rounding;
      v_grand_total := v_base_total;
    END IF;

    UPDATE public.dining_sessions
    SET bill_subtotal=v_subtotal,
        bill_cgst=v_cgst,
        bill_sgst=v_sgst,
        bill_rounding=v_rounding,
        bill_grand_total=v_grand_total,
        bill_discount_type=CASE WHEN v_value=0 THEN NULL ELSE v_type END,
        bill_discount_value=CASE WHEN v_value=0 THEN 0 ELSE v_value END,
        bill_discount_amount=v_discount_amount,
        bill_discount_reason=CASE WHEN v_value=0 THEN NULL ELSE v_reason END,
        updated_at=now()
    WHERE id=v_session.id AND restaurant_id=v_restaurant_id
    RETURNING * INTO v_session;

    PERFORM public._tableforge_audit_event(
      v_restaurant_id,'admin_bill_discount_updated','dining_sessions',v_session.id::text,
      v_reason,v_before,
      jsonb_build_object('discount_type',v_session.bill_discount_type,
                         'discount_value',v_session.bill_discount_value,
                         'discount_amount',v_session.bill_discount_amount,
                         'subtotal',v_session.bill_subtotal,
                         'cgst',v_session.bill_cgst,'sgst',v_session.bill_sgst,
                         'rounding',v_session.bill_rounding,'grand_total',v_session.bill_grand_total),
      jsonb_build_object('reason',v_reason)
    );

    RETURN jsonb_build_object(
      'ok',true,'bill_kind','session','id',v_session.id,'status',v_session.status,
      'payment_status',v_session.payment_status,'discount_type',v_session.bill_discount_type,
      'discount_value',v_session.bill_discount_value,'discount_amount',v_session.bill_discount_amount,
      'discount_reason',v_session.bill_discount_reason,'subtotal',v_session.bill_subtotal,
      'cgst',v_session.bill_cgst,'sgst',v_session.bill_sgst,
      'rounding',v_session.bill_rounding,'grand_total',v_session.bill_grand_total
    );
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id=p_order_id AND o.restaurant_id=v_restaurant_id
    AND o.order_type::text='takeaway'
    AND o.billing_status::text IN ('bill_ready','issued')
    AND o.billing_status::text <> 'closed'
    AND o.status NOT IN ('completed'::public.order_status,'cancelled'::public.order_status)
    AND o.payment_status IS DISTINCT FROM 'paid'::public.payment_status
  FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Only an unpaid, open, bill-ready takeaway bill can be discounted.';
  END IF;

  v_before := to_jsonb(v_order);
  v_subtotal := coalesce(v_order.subtotal,0);
  IF v_subtotal <= 0 THEN RAISE EXCEPTION 'This bill has no positive subtotal.'; END IF;
  IF v_type='amount' AND v_value > v_subtotal THEN
    RAISE EXCEPTION 'Fixed discount cannot exceed the bill subtotal.';
  END IF;
  SELECT coalesce(sum(oi.unit_price*oi.quantity) FILTER (
           WHERE NOT coalesce(oi.tax_exempt_snapshot,false)
             AND oi.serving_status <> 'cancelled'
         ),0)
  INTO v_taxable_subtotal
  FROM public.order_items oi
  WHERE oi.order_id=v_order.id AND oi.restaurant_id=v_restaurant_id;

  IF v_value=0 THEN
    v_discount_amount := 0;
  ELSIF v_type='percent' THEN
    v_discount_amount := round(v_subtotal*v_value/100.0,2);
  ELSE
    v_discount_amount := v_value;
  END IF;
  v_ratio := CASE WHEN v_subtotal > 0 THEN (v_subtotal-v_discount_amount)/v_subtotal ELSE 1 END;
  v_cgst := round(v_taxable_subtotal*v_ratio*v_order.cgst_rate/100.0,2);
  v_sgst := round(v_taxable_subtotal*v_ratio*v_order.sgst_rate/100.0,2);
  v_pre_round := round(v_subtotal-v_discount_amount+v_cgst+v_sgst,2);
  v_grand_total := round(v_pre_round);
  v_rounding := round(v_grand_total-v_pre_round,2);

  UPDATE public.orders
  SET discount_type=CASE WHEN v_value=0 THEN NULL ELSE v_type END,
      discount_value=CASE WHEN v_value=0 THEN 0 ELSE v_value END,
      discount_amount=v_discount_amount,
      discount_reason=CASE WHEN v_value=0 THEN NULL ELSE v_reason END,
      cgst=v_cgst,sgst=v_sgst,rounding=v_rounding,grand_total=v_grand_total,updated_at=now()
  WHERE id=v_order.id AND restaurant_id=v_restaurant_id
  RETURNING * INTO v_order;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,'admin_bill_discount_updated','orders',v_order.id::text,
    v_reason,v_before,
    jsonb_build_object('discount_type',v_order.discount_type,
                       'discount_value',v_order.discount_value,
                       'discount_amount',v_order.discount_amount,
                       'subtotal',v_order.subtotal,'cgst',v_order.cgst,'sgst',v_order.sgst,
                       'rounding',v_order.rounding,'grand_total',v_order.grand_total),
    jsonb_build_object('reason',v_reason)
  );

  RETURN jsonb_build_object(
    'ok',true,'bill_kind','order','id',v_order.id,'status',v_order.status,
    'payment_status',v_order.payment_status,'discount_type',v_order.discount_type,
    'discount_value',v_order.discount_value,'discount_amount',v_order.discount_amount,
    'discount_reason',v_order.discount_reason,'subtotal',v_order.subtotal,
    'cgst',v_order.cgst,'sgst',v_order.sgst,'rounding',v_order.rounding,
    'grand_total',v_order.grand_total
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_admin_bill_discount(uuid,uuid,text,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_admin_bill_discount(uuid,uuid,text,numeric,text,text) TO authenticated;

-- Strict mode must not be enabled while recipes still contain estimates or unavailable ingredients.
CREATE OR REPLACE FUNCTION public.save_restaurant_workflow_settings(
  p_inventory_mode text,
  p_allow_takeaway_prepayment boolean,
  p_allowed_payment_methods text[],
  p_panel_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_methods text[];
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF p_inventory_mode NOT IN ('disabled','strict') THEN RAISE EXCEPTION 'Inventory mode must be disabled or strict.'; END IF;
  SELECT array_agg(DISTINCT lower(btrim(x))) INTO v_methods
  FROM unnest(coalesce(p_allowed_payment_methods,ARRAY[]::text[])) x;
  IF coalesce(cardinality(v_methods),0)=0 OR EXISTS(
    SELECT 1 FROM unnest(v_methods) x WHERE x NOT IN ('upi_qr','cash','card','bank_transfer')
  ) THEN
    RAISE EXCEPTION 'Select at least one supported payment method: UPI QR, Cash, Card, or Bank transfer.';
  END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1 FROM public.products p WHERE p.restaurant_id=v_restaurant_id AND p.is_active
      AND NOT EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.restaurant_id=v_restaurant_id AND r.product_id=p.id)
  ) THEN
    RAISE EXCEPTION 'Strict inventory cannot be enabled until every active product has a recipe.';
  END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1 FROM public.product_recipes r
    JOIN public.products p ON p.id=r.product_id AND p.restaurant_id=r.restaurant_id
    WHERE r.restaurant_id=v_restaurant_id AND p.is_active AND r.is_estimate
  ) THEN
    RAISE EXCEPTION 'Strict inventory cannot be enabled while estimated recipes remain. Review each recipe in Admin → Inventory → Recipes first.';
  END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1
    FROM public.product_recipes r
    JOIN public.products p ON p.id=r.product_id AND p.restaurant_id=r.restaurant_id
    LEFT JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id
    WHERE r.restaurant_id=v_restaurant_id AND p.is_active
      AND (i.id IS NULL OR NOT i.is_active)
  ) THEN
    RAISE EXCEPTION 'Strict inventory cannot be enabled while an active recipe references a missing, inactive, or cross-restaurant ingredient.';
  END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1
    FROM public.product_recipes r
    JOIN public.products p ON p.id=r.product_id AND p.restaurant_id=r.restaurant_id AND p.is_active
    JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id AND i.is_active
    WHERE r.restaurant_id=v_restaurant_id
      AND NOT EXISTS (
        SELECT 1 FROM public.inventory_movements m
        WHERE m.restaurant_id=v_restaurant_id AND m.ingredient_id=r.ingredient_id
          AND m.movement_type='opening_stock'
      )
  ) THEN
    RAISE EXCEPTION 'Strict inventory cannot be enabled until opening stock is recorded for every ingredient used by an active recipe.';
  END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
    WHERE o.restaurant_id=v_restaurant_id AND o.status::text NOT IN ('completed','cancelled')
      AND o.payment_status::text IS DISTINCT FROM 'paid' AND o.billing_status::text IS DISTINCT FROM 'closed'
      AND (
        oi.serving_status IN ('pending','preparing','ready')
        OR oi.kot_ready_previous_status IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Finish or reconcile all active order items before enabling strict inventory.';
  END IF;
  INSERT INTO public.restaurant_workflow_settings(restaurant_id,inventory_mode,allow_takeaway_prepayment,allowed_payment_methods,updated_at)
  VALUES(v_restaurant_id,p_inventory_mode,coalesce(p_allow_takeaway_prepayment,true),v_methods,now())
  ON CONFLICT (restaurant_id) DO UPDATE SET inventory_mode=excluded.inventory_mode,
    allow_takeaway_prepayment=excluded.allow_takeaway_prepayment,
    allowed_payment_methods=excluded.allowed_payment_methods,updated_at=now();
  PERFORM public._tableforge_audit_event(v_restaurant_id,'restaurant_workflow_settings_updated',
    'restaurant_workflow_settings',v_restaurant_id::text,NULL,NULL,
    jsonb_build_object('inventory_mode',p_inventory_mode,'allow_takeaway_prepayment',coalesce(p_allow_takeaway_prepayment,true),'allowed_payment_methods',v_methods),
    jsonb_build_object('method_count',cardinality(v_methods)));
  RETURN jsonb_build_object('ok',true,'inventory_mode',p_inventory_mode,
    'allow_takeaway_prepayment',coalesce(p_allow_takeaway_prepayment,true),'allowed_payment_methods',v_methods);
END;
$function$;
REVOKE ALL ON FUNCTION public.save_restaurant_workflow_settings(text,boolean,text[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_restaurant_workflow_settings(text,boolean,text[],text) TO authenticated;

-- Direct transitions into Preparing also validate every recipe ingredient before stock changes.
CREATE OR REPLACE FUNCTION public._tableforge_consume_recipe_on_served()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_mode text;
  v_recipe jsonb;
  v_row record;
  v_balance numeric(14,3);
BEGIN
  IF NEW.serving_status='preparing'
     AND OLD.serving_status IS DISTINCT FROM 'preparing'
     AND NEW.serving_status <> 'cancelled'
     AND NEW.inventory_consumed_at IS NULL THEN
    SELECT inventory_mode INTO v_mode FROM public.restaurant_workflow_settings
      WHERE restaurant_id=NEW.restaurant_id;
    IF coalesce(v_mode,'disabled') <> 'strict' THEN RETURN NEW; END IF;

    SELECT o.* INTO v_order FROM public.orders o
      WHERE o.id=NEW.order_id AND o.restaurant_id=NEW.restaurant_id FOR UPDATE;
    IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found for inventory deduction.'; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.product_recipes r
      WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id
    ) THEN
      RAISE EXCEPTION 'This restaurant requires a complete recipe before preparation can start.';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.product_recipes r
      LEFT JOIN public.inventory_ingredients i
        ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id
      WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id
        AND (coalesce(r.is_estimate,true) OR i.id IS NULL OR NOT i.is_active)
    ) THEN
      RAISE EXCEPTION 'This dish has estimated recipe quantities or an unavailable ingredient. An Admin must verify the recipe and activate every ingredient before strict-inventory preparation can start.';
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'ingredient_id',r.ingredient_id,'quantity_per_serving',r.quantity_per_serving,
      'quantity',r.quantity_per_serving*NEW.quantity,'unit',i.base_unit,'name',i.name
    ) ORDER BY i.name),'[]'::jsonb) INTO v_recipe
    FROM public.product_recipes r
    JOIN public.inventory_ingredients i ON i.id=r.ingredient_id AND i.restaurant_id=r.restaurant_id AND i.is_active
    WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id;

    IF jsonb_array_length(v_recipe)=0 THEN
      RAISE EXCEPTION 'This restaurant requires a complete recipe before preparation can start.';
    END IF;

    -- Lock each ingredient and validate the full recipe before inserting any movements.
    FOR v_row IN SELECT (x->>'ingredient_id')::uuid AS ingredient_id,
                        (x->>'quantity')::numeric AS quantity,
                        x->>'unit' AS unit, x->>'name' AS name
                 FROM jsonb_array_elements(v_recipe) x ORDER BY (x->>'ingredient_id')::uuid
    LOOP
      PERFORM 1 FROM public.inventory_ingredients
        WHERE id=v_row.ingredient_id AND restaurant_id=NEW.restaurant_id AND is_active FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Recipe ingredient % is no longer active. Recheck the recipe before preparation.',v_row.name;
      END IF;
      SELECT coalesce(sum(quantity_delta),0) INTO v_balance FROM public.inventory_movements
        WHERE ingredient_id=v_row.ingredient_id AND restaurant_id=NEW.restaurant_id;
      IF v_balance < v_row.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for %: available %, required % %.',v_row.name,v_balance,v_row.quantity,v_row.unit;
      END IF;
    END LOOP;

    FOR v_row IN SELECT (x->>'ingredient_id')::uuid AS ingredient_id,
                        (x->>'quantity')::numeric AS quantity, x->>'unit' AS unit, x->>'name' AS name
                 FROM jsonb_array_elements(v_recipe) x
    LOOP
      INSERT INTO public.inventory_movements(restaurant_id,ingredient_id,movement_type,quantity_delta,unit,reason,actor_id,reference_order_id,reference_order_item_id)
      VALUES(NEW.restaurant_id,v_row.ingredient_id,'sale',-v_row.quantity,v_row.unit,
        'Recipe consumption when preparation started: '||NEW.name_snapshot,auth.uid(),v_order.id,NEW.id)
      ON CONFLICT (reference_order_item_id,ingredient_id) WHERE movement_type='sale' AND reference_order_item_id IS NOT NULL DO NOTHING;
    END LOOP;

    NEW.inventory_recipe_snapshot := v_recipe;
    NEW.inventory_consumed_at := now();
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_tableforge_consume_recipe_on_served ON public.order_items;
CREATE TRIGGER trg_tableforge_consume_recipe_on_served
BEFORE UPDATE OF serving_status ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public._tableforge_consume_recipe_on_served();
REVOKE ALL ON FUNCTION public._tableforge_consume_recipe_on_served() FROM PUBLIC, anon, authenticated;

COMMIT;
