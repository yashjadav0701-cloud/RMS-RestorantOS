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

COMMIT;
