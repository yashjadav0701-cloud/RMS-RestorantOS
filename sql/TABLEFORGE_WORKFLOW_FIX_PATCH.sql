-- TableForge workflow patch
-- Apply AFTER the previously installed MASTER_MIGRATION_TABLEFORGE.sql.
-- This is incremental and intentionally does not rebuild or truncate data.
BEGIN;

-- Persist payment mode on each order, including dine-in orders linked to a session.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_method text;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND conname = 'orders_payment_method_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('upi_qr', 'cash'));
  END IF;
END;
$constraint$;

-- Admin can physically remove any serving-status item from an editable order.
-- Paid/completed/cancelled/closed history is immutable.
CREATE OR REPLACE FUNCTION public.remove_order_item(p_item_id uuid,p_panel_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_order public.orders%ROWTYPE;
  v_item public.order_items%ROWTYPE;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['admin']) x;

  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Admin panel authorization expired or invalid.';
  END IF;

  SELECT oi.* INTO v_item
  FROM public.order_items oi
  WHERE oi.id = p_item_id
    AND oi.restaurant_id = v_restaurant_id
  FOR UPDATE;

  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Order item not found in this restaurant.';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = v_item.order_id
    AND o.restaurant_id = v_restaurant_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Parent order not found in this restaurant.';
  END IF;

  IF v_order.status IN ('completed'::public.order_status, 'cancelled'::public.order_status)
     OR v_order.payment_status = 'paid'::public.payment_status
     OR v_order.billing_status = 'closed' THEN
    RAISE EXCEPTION 'Paid, completed, cancelled, or closed order history cannot be edited.';
  END IF;

  -- The requests table has ON DELETE RESTRICT for order_item_id, so remove related
  -- legacy approval rows before physically deleting the order item.
  DELETE FROM public.dish_cancellation_requests
  WHERE restaurant_id = v_restaurant_id
    AND order_item_id = v_item.id;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,
    'admin_item_removed',
    'order_items',
    v_item.id::text,
    'Removed by Admin from active order',
    to_jsonb(v_item),
    jsonb_build_object(
      'item_id', v_item.id,
      'order_id', v_item.order_id,
      'dish', v_item.name_snapshot,
      'quantity', v_item.quantity,
      'previous_status', v_item.serving_status,
      'action', 'physical_delete'
    )
  );

  DELETE FROM public.order_items
  WHERE id = v_item.id
    AND order_id = v_order.id
    AND restaurant_id = v_restaurant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The item was not removed. Refresh and try again.';
  END IF;

  PERFORM public._tableforge_recalculate_order(v_order.id);

  RETURN jsonb_build_object(
    'ok', true,
    'item_id', p_item_id,
    'order_id', v_order.id,
    'status', 'removed'
  );
END;
$function$;

-- Remove old customer/Captain cancellation and Admin approval RPC access.
-- The revised workflow is Admin-only physical removal from the active order.
REVOKE ALL ON FUNCTION public.cancel_order_item(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_dish_cancellation(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_admin_cancellation_requests(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_dish_cancellation(uuid,uuid,text,text,text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.remove_order_item(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_order_item(uuid,text) TO authenticated;

-- Record the selected payment method on the session and all its orders.
CREATE OR REPLACE FUNCTION public.complete_session_payment(p_session_id uuid,p_payment_method text,p_panel_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_session public.dining_sessions%ROWTYPE;
  v_method text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Cashier/Admin panel authorization expired or invalid.';
  END IF;

  v_method := lower(btrim(COALESCE(p_payment_method,'')));
  IF v_method NOT IN ('upi_qr','cash') THEN
    RAISE EXCEPTION 'Payment method must be UPI QR or cash.';
  END IF;

  SELECT ds.* INTO v_session
  FROM public.dining_sessions ds
  WHERE ds.id = p_session_id
    AND ds.restaurant_id = v_restaurant_id
    AND ds.status = 'bill_ready'
  FOR UPDATE;
  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'The bill must be ready before payment can be confirmed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.session_id = v_session.id
      AND o.restaurant_id = v_restaurant_id
      AND o.status <> 'cancelled'::public.order_status
  ) THEN
    RAISE EXCEPTION 'This session has no active orders.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.orders o
    JOIN public.order_items oi
      ON oi.order_id = o.id AND oi.restaurant_id = o.restaurant_id
    WHERE o.session_id = v_session.id
      AND o.restaurant_id = v_restaurant_id
      AND o.status <> 'cancelled'::public.order_status
      AND oi.serving_status NOT IN ('served','cancelled')
  ) THEN
    RAISE EXCEPTION 'All billable items must be served before payment.';
  END IF;

  UPDATE public.dining_sessions ds
  SET status = 'closed',
      updated_at = now(),
      payment_status = 'paid'::public.payment_status,
      payment_method = v_method,
      closed_at = now()
  WHERE ds.id = v_session.id
    AND ds.restaurant_id = v_restaurant_id;

  UPDATE public.orders o
  SET status = 'completed'::public.order_status,
      payment_status = 'paid'::public.payment_status,
      billing_status = 'closed',
      payment_method = v_method,
      updated_at = now()
  WHERE o.session_id = v_session.id
    AND o.restaurant_id = v_restaurant_id
    AND o.status <> 'cancelled'::public.order_status;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,
    'session_payment_confirmed',
    'dining_sessions',
    v_session.id::text,
    NULL,
    to_jsonb(v_session),
    jsonb_build_object('payment_method',v_method,'payment_status','paid','status','closed')
  );
END;
$function$;

-- Record selected payment method directly on the takeaway order.
CREATE OR REPLACE FUNCTION public.complete_takeaway_payment(p_order_id uuid,p_payment_method text,p_panel_token text)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_order public.orders%ROWTYPE;
  v_method text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Cashier/Admin panel authorization expired or invalid.';
  END IF;

  v_method := lower(btrim(COALESCE(p_payment_method,'')));
  IF v_method NOT IN ('upi_qr','cash') THEN
    RAISE EXCEPTION 'Payment method must be UPI QR or cash.';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
    AND o.restaurant_id = v_restaurant_id
    AND o.order_type::text = 'takeaway'
    AND o.billing_status = 'bill_ready'
    AND o.status <> 'cancelled'::public.order_status
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Takeaway bill must be ready before payment can be confirmed.';
  END IF;
  IF v_order.payment_status = 'paid'::public.payment_status OR v_order.billing_status = 'closed' THEN
    RAISE EXCEPTION 'This takeaway order is already paid and closed.';
  END IF;

  UPDATE public.orders
  SET status = 'completed'::public.order_status,
      payment_status = 'paid'::public.payment_status,
      billing_status = 'closed',
      payment_method = v_method,
      updated_at = now()
  WHERE id = v_order.id
    AND restaurant_id = v_restaurant_id
  RETURNING * INTO v_order;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,
    'takeaway_payment_confirmed',
    'orders',
    v_order.id::text,
    NULL,
    to_jsonb(v_order),
    jsonb_build_object('payment_method',v_method,'payment_status','paid','billing_status','closed')
  );

  RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_session_payment(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_session_payment(uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.complete_takeaway_payment(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_takeaway_payment(uuid,text,text) TO authenticated;



-- Per-tenant operational policy. Defaults preserve existing behavior until each
-- restaurant explicitly configures inventory tracking; no tenant inherits another's policy.
CREATE TABLE IF NOT EXISTS public.restaurant_workflow_settings (
  restaurant_id uuid PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,
  inventory_mode text NOT NULL DEFAULT 'disabled'
    CHECK (inventory_mode IN ('disabled','automatic','strict')),
  allow_takeaway_prepayment boolean NOT NULL DEFAULT true,
  allowed_payment_methods text[] NOT NULL DEFAULT ARRAY['upi_qr','cash']::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(allowed_payment_methods) > 0),
  CHECK (allowed_payment_methods <@ ARRAY['upi_qr','cash']::text[])
);
ALTER TABLE public.restaurant_workflow_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.restaurant_workflow_settings FROM PUBLIC, anon, authenticated;

-- Recipe snapshot and consumption marker make preparation idempotent and keep
-- historical recipe values independent from later menu edits.
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS inventory_recipe_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS inventory_consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_reconciled_at timestamptz;

-- The cashier must deliberately choose a tenant-allowed payment method before
-- the receipt is saved/printed. This records the choice without marking payment paid.
CREATE OR REPLACE FUNCTION public.set_bill_payment_method(
  p_order_id uuid,
  p_session_id uuid,
  p_payment_method text,
  p_panel_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_method text := lower(btrim(coalesce(p_payment_method,'')));
  v_settings public.restaurant_workflow_settings%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_session public.dining_sessions%ROWTYPE;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Cashier/Admin panel authorization expired or invalid.'; END IF;
  SELECT * INTO v_settings FROM public.restaurant_workflow_settings WHERE restaurant_id=v_restaurant_id;
  IF FOUND AND NOT (v_method = ANY(v_settings.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'This payment method is not enabled for this restaurant.';
  END IF;
  IF v_method NOT IN ('upi_qr','cash') THEN RAISE EXCEPTION 'Choose UPI QR or Cash.'; END IF;
  IF (p_order_id IS NULL) = (p_session_id IS NULL) THEN
    RAISE EXCEPTION 'Supply exactly one order ID or dining session ID.';
  END IF;
  IF p_order_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.orders
    WHERE id=p_order_id AND restaurant_id=v_restaurant_id AND order_type::text='takeaway'
    FOR UPDATE;
    IF v_order.id IS NULL THEN RAISE EXCEPTION 'Takeaway order not found for this restaurant.'; END IF;
    IF v_order.payment_status='paid'::public.payment_status OR v_order.billing_status='closed' THEN
      RAISE EXCEPTION 'Paid or closed orders cannot change payment method.';
    END IF;
    IF v_order.billing_status NOT IN ('bill_ready','issued') THEN RAISE EXCEPTION 'Generate the bill before setting its payment method.'; END IF;
    UPDATE public.orders SET payment_method=v_method,updated_at=now()
    WHERE id=v_order.id AND restaurant_id=v_restaurant_id;
  ELSE
    SELECT * INTO v_session FROM public.dining_sessions
    WHERE id=p_session_id AND restaurant_id=v_restaurant_id AND status='bill_ready'
    FOR UPDATE;
    IF v_session.id IS NULL THEN RAISE EXCEPTION 'Dining bill must be generated before setting its payment method.'; END IF;
    IF v_session.payment_status='paid'::public.payment_status THEN RAISE EXCEPTION 'Paid sessions cannot change payment method.'; END IF;
    UPDATE public.dining_sessions SET payment_method=v_method,updated_at=now()
    WHERE id=v_session.id AND restaurant_id=v_restaurant_id;
    UPDATE public.orders SET payment_method=v_method,updated_at=now()
    WHERE session_id=v_session.id AND restaurant_id=v_restaurant_id
      AND payment_status IS DISTINCT FROM 'paid'::public.payment_status;
  END IF;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'bill_payment_method_selected',
    CASE WHEN p_order_id IS NOT NULL THEN 'orders' ELSE 'dining_sessions' END,
    coalesce(p_order_id,p_session_id)::text,NULL,NULL,jsonb_build_object('payment_method',v_method));
  RETURN jsonb_build_object('ok',true,'payment_method',v_method);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_bill_payment_method(uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_bill_payment_method(uuid,uuid,text,text) TO authenticated;

-- Admin-controlled per-tenant workflow policy. No global setting can leak between tenants.
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
  IF p_inventory_mode NOT IN ('disabled','automatic','strict') THEN RAISE EXCEPTION 'Inventory mode must be disabled, automatic, or strict.'; END IF;
  SELECT array_agg(DISTINCT lower(btrim(x))) INTO v_methods FROM unnest(coalesce(p_allowed_payment_methods,ARRAY[]::text[])) x;
  IF coalesce(cardinality(v_methods),0)=0 OR EXISTS(SELECT 1 FROM unnest(v_methods) x WHERE x NOT IN ('upi_qr','cash')) THEN
    RAISE EXCEPTION 'Select at least one supported payment method: UPI QR or Cash.';
  END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1 FROM public.products p WHERE p.restaurant_id=v_restaurant_id AND p.is_active
      AND NOT EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.restaurant_id=v_restaurant_id AND r.product_id=p.id)
  ) THEN
    RAISE EXCEPTION 'Strict inventory cannot be enabled until every active product has a recipe or an explicit not-tracked classification.';
  END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
    WHERE o.restaurant_id=v_restaurant_id AND o.status::text NOT IN ('completed','cancelled')
      AND o.payment_status::text IS DISTINCT FROM 'paid' AND o.billing_status::text IS DISTINCT FROM 'closed'
      AND oi.serving_status IN ('pending','preparing','ready')
  ) THEN
    RAISE EXCEPTION 'Finish or reconcile all active order items before enabling strict inventory.';
  END IF;
  INSERT INTO public.restaurant_workflow_settings(restaurant_id,inventory_mode,allow_takeaway_prepayment,allowed_payment_methods,updated_at)
  VALUES(v_restaurant_id,p_inventory_mode,coalesce(p_allow_takeaway_prepayment,true),v_methods,now())
  ON CONFLICT (restaurant_id) DO UPDATE SET inventory_mode=excluded.inventory_mode,
    allow_takeaway_prepayment=excluded.allow_takeaway_prepayment,
    allowed_payment_methods=excluded.allowed_payment_methods,updated_at=now();
  PERFORM public._tableforge_audit_event(v_restaurant_id,'restaurant_workflow_settings_updated','restaurant_workflow_settings',v_restaurant_id::text,NULL,NULL,
    jsonb_build_object('inventory_mode',p_inventory_mode,'allow_takeaway_prepayment',coalesce(p_allow_takeaway_prepayment,true),'allowed_payment_methods',v_methods));
  RETURN jsonb_build_object('ok',true,'inventory_mode',p_inventory_mode,'allow_takeaway_prepayment',coalesce(p_allow_takeaway_prepayment,true),'allowed_payment_methods',v_methods);
END;
$function$;
REVOKE ALL ON FUNCTION public.save_restaurant_workflow_settings(text,boolean,text[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_restaurant_workflow_settings(text,boolean,text[],text) TO authenticated;

-- Inventory consumption starts at Preparing, not Served. Strict inventory is
-- opt-in per tenant so an unconfigured restaurant is not unexpectedly blocked.
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

-- Final safety override: preserve history, prohibit served removal, and refuse
-- preparation-stage cancellation until actual ingredient usage can be reconciled.
CREATE OR REPLACE FUNCTION public.remove_order_item(p_item_id uuid,p_panel_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_order public.orders%ROWTYPE; v_item public.order_items%ROWTYPE;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
    FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  SELECT * INTO v_item FROM public.order_items WHERE id=p_item_id AND restaurant_id=v_restaurant_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Order item not found in this restaurant.'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=v_item.order_id AND restaurant_id=v_restaurant_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Parent order not found in this restaurant.'; END IF;
  IF v_order.status IN ('completed'::public.order_status,'cancelled'::public.order_status)
     OR v_order.payment_status='paid'::public.payment_status OR v_order.billing_status='closed' THEN
    RAISE EXCEPTION 'Paid, completed, cancelled, or closed order history cannot be edited.';
  END IF;
  IF v_item.serving_status='served' THEN RAISE EXCEPTION 'Served dishes cannot be removed.'; END IF;
  IF v_item.serving_status='preparing' THEN
    RAISE EXCEPTION 'This dish has started preparing. Use the ingredient-usage reconciliation workflow before cancelling it.';
  END IF;
  IF v_item.serving_status='cancelled' THEN RAISE EXCEPTION 'This dish is already cancelled.'; END IF;
  UPDATE public.order_items SET serving_status='cancelled', cancellation_reason='Removed by Admin',
    cancelled_at=now(),cancelled_by=auth.uid()
    WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'admin_item_cancelled','order_items',v_item.id::text,
    'Removed by Admin from active unpaid bill',to_jsonb(v_item),
    jsonb_build_object('serving_status','cancelled','inventory_recipe_snapshot',v_item.inventory_recipe_snapshot));
  DELETE FROM public.dish_cancellation_requests WHERE restaurant_id=v_restaurant_id AND order_item_id=v_item.id;
  PERFORM public._tableforge_recalculate_order(v_order.id);
  RETURN jsonb_build_object('ok',true,'item_id',v_item.id,'order_id',v_order.id,'status','cancelled');
END;
$function$;

COMMIT;
