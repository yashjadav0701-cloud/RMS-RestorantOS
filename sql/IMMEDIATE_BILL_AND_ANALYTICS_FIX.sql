-- TableForge immediate bill-generation and reporting repair
-- Apply AFTER MASTER_MIGRATION_TABLEFORGE.sql and TABLEFORGE_WORKFLOW_FIX_PATCH.sql.
-- Incremental / idempotent. It does not delete or recreate business records.
-- Test on a staging clone before production. This file has not been executed on your live Supabase database.

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1) FIX THE SCREENSHOT ERROR: the existing set_bill_payment_method RPC writes
-- public.orders.payment_method but this column is missing in the live database.
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_method text;

-- Some earlier releases only allowed UPI/Cash. Rebuild the check constraint to
-- support the four staff-recorded payment methods shown in the current UI.
DO $drop_order_payment_checks$
DECLARE v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%payment_method%'
  LOOP
    EXECUTE format('ALTER TABLE public.orders DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$drop_order_payment_checks$;
ALTER TABLE public.orders
  ADD CONSTRAINT tableforge_orders_payment_method_supported_check
  CHECK (payment_method IS NULL OR payment_method IN ('upi_qr','cash','card','bank_transfer'));

-- Keep per-restaurant payment policy intact, but allow the methods that the UI
-- and payment-completion RPCs understand. If the policy table is absent, create
-- its baseline shape; existing rows and values are preserved.
CREATE TABLE IF NOT EXISTS public.restaurant_workflow_settings (
  restaurant_id uuid PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,
  inventory_mode text NOT NULL DEFAULT 'disabled' CHECK (inventory_mode IN ('disabled','strict')),
  allow_takeaway_prepayment boolean NOT NULL DEFAULT true,
  allowed_payment_methods text[] NOT NULL DEFAULT ARRAY['upi_qr','cash','card','bank_transfer']::text[],
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.restaurant_workflow_settings
  ADD COLUMN IF NOT EXISTS allowed_payment_methods text[] NOT NULL DEFAULT ARRAY['upi_qr','cash','card','bank_transfer']::text[];
ALTER TABLE public.restaurant_workflow_settings
  ADD COLUMN IF NOT EXISTS inventory_mode text NOT NULL DEFAULT 'disabled';
ALTER TABLE public.restaurant_workflow_settings
  ADD COLUMN IF NOT EXISTS allow_takeaway_prepayment boolean NOT NULL DEFAULT true;
ALTER TABLE public.restaurant_workflow_settings
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.restaurant_workflow_settings
  ALTER COLUMN allowed_payment_methods SET DEFAULT ARRAY['upi_qr','cash','card','bank_transfer']::text[];
-- Add the newly supported methods to existing tenant-specific lists, preserving
-- any additional ordering and without combining settings between restaurants.
UPDATE public.restaurant_workflow_settings s
SET allowed_payment_methods = ARRAY(
  SELECT DISTINCT method
  FROM unnest(COALESCE(s.allowed_payment_methods, ARRAY[]::text[]) || ARRAY['upi_qr','cash','card','bank_transfer']::text[]) AS method
  ORDER BY method
);
DO $drop_workflow_payment_checks$
DECLARE v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.restaurant_workflow_settings'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%allowed_payment_methods%'
  LOOP
    EXECUTE format('ALTER TABLE public.restaurant_workflow_settings DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$drop_workflow_payment_checks$;
ALTER TABLE public.restaurant_workflow_settings
  ADD CONSTRAINT tableforge_workflow_payment_methods_supported_check
  CHECK (
    cardinality(allowed_payment_methods) > 0
    AND allowed_payment_methods <@ ARRAY['upi_qr','cash','card','bank_transfer']::text[]
  );

-- Replace existing method-selection RPC with a version compatible with the actual
-- schema and matching frontend payload. Selecting/saving a method NEVER marks a bill paid.
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
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Cashier/Admin panel authorization expired or invalid.';
  END IF;

  IF v_method NOT IN ('upi_qr','cash','card','bank_transfer') THEN
    RAISE EXCEPTION 'Choose a supported payment method.';
  END IF;
  SELECT * INTO v_settings
  FROM public.restaurant_workflow_settings
  WHERE restaurant_id = v_restaurant_id;
  IF FOUND AND NOT (v_method = ANY(v_settings.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'This payment method is not enabled for this restaurant.';
  END IF;

  IF (p_order_id IS NULL) = (p_session_id IS NULL) THEN
    RAISE EXCEPTION 'Supply exactly one order ID or dining session ID.';
  END IF;

  IF p_order_id IS NOT NULL THEN
    SELECT * INTO v_order
    FROM public.orders
    WHERE id = p_order_id
      AND restaurant_id = v_restaurant_id
      AND order_type::text = 'takeaway'
    FOR UPDATE;
    IF v_order.id IS NULL THEN
      RAISE EXCEPTION 'Takeaway order not found for this restaurant.';
    END IF;
    IF v_order.payment_status = 'paid'::public.payment_status OR v_order.billing_status = 'closed' THEN
      RAISE EXCEPTION 'Paid or closed orders cannot change payment method.';
    END IF;
    IF v_order.billing_status::text NOT IN ('bill_ready','issued') THEN
      RAISE EXCEPTION 'Generate the bill before setting its payment method.';
    END IF;
    UPDATE public.orders
      SET payment_method = v_method, updated_at = now()
    WHERE id = v_order.id AND restaurant_id = v_restaurant_id;
  ELSE
    SELECT * INTO v_session
    FROM public.dining_sessions
    WHERE id = p_session_id
      AND restaurant_id = v_restaurant_id
      AND status = 'bill_ready'
    FOR UPDATE;
    IF v_session.id IS NULL THEN
      RAISE EXCEPTION 'Dining bill must be generated before setting its payment method.';
    END IF;
    IF v_session.payment_status = 'paid'::public.payment_status THEN
      RAISE EXCEPTION 'Paid sessions cannot change payment method.';
    END IF;
    UPDATE public.dining_sessions
      SET payment_method = v_method, updated_at = now()
    WHERE id = v_session.id AND restaurant_id = v_restaurant_id;
    UPDATE public.orders
      SET payment_method = v_method, updated_at = now()
    WHERE session_id = v_session.id
      AND restaurant_id = v_restaurant_id
      AND payment_status IS DISTINCT FROM 'paid'::public.payment_status;
  END IF;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id, 'bill_payment_method_selected',
    CASE WHEN p_order_id IS NOT NULL THEN 'orders' ELSE 'dining_sessions' END,
    coalesce(p_order_id,p_session_id)::text, NULL, NULL, NULL,
    jsonb_build_object('payment_method',v_method)
  );
  RETURN jsonb_build_object('ok',true,'payment_method',v_method);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_bill_payment_method(uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_bill_payment_method(uuid,uuid,text,text) TO authenticated;

-- Payment confirmation updates the same method field and only marks paid after
-- authorized staff explicitly confirms receipt.
CREATE OR REPLACE FUNCTION public.complete_session_payment(
  p_session_id uuid,
  p_payment_method text,
  p_panel_token text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_session public.dining_sessions%ROWTYPE;
  v_method text := lower(btrim(coalesce(p_payment_method,'')));
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Cashier/Admin panel authorization expired or invalid.'; END IF;
  IF v_method NOT IN ('upi_qr','cash','card','bank_transfer') THEN RAISE EXCEPTION 'Choose a supported payment method.'; END IF;
  PERFORM 1 FROM public.restaurant_workflow_settings s
   WHERE s.restaurant_id=v_restaurant_id AND NOT (v_method = ANY(s.allowed_payment_methods));
  IF FOUND THEN RAISE EXCEPTION 'This payment method is not enabled for this restaurant.'; END IF;

  SELECT ds.* INTO v_session
  FROM public.dining_sessions ds
  WHERE ds.id=p_session_id AND ds.restaurant_id=v_restaurant_id AND ds.status='bill_ready'
  FOR UPDATE;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'The bill must be ready before payment can be confirmed.'; END IF;
  IF v_session.payment_status='paid'::public.payment_status THEN RAISE EXCEPTION 'This session is already paid.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id
      AND o.status<>'cancelled'::public.order_status
  ) THEN RAISE EXCEPTION 'This session has no active orders.'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.orders o
    JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
    WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id
      AND o.status<>'cancelled'::public.order_status
      AND oi.serving_status NOT IN ('served','cancelled')
  ) THEN RAISE EXCEPTION 'All billable items must be served before payment.'; END IF;

  UPDATE public.dining_sessions
    SET status='closed', updated_at=now(), payment_status='paid'::public.payment_status,
        payment_method=v_method, closed_at=now()
  WHERE id=v_session.id AND restaurant_id=v_restaurant_id;
  UPDATE public.orders
    SET status='completed'::public.order_status,
        payment_status='paid'::public.payment_status,
        billing_status='closed', payment_method=v_method, updated_at=now()
  WHERE session_id=v_session.id AND restaurant_id=v_restaurant_id
    AND status<>'cancelled'::public.order_status;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'session_payment_confirmed','dining_sessions',v_session.id::text,
    NULL,to_jsonb(v_session),jsonb_build_object('payment_method',v_method,'payment_status','paid','status','closed'),'{}'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_takeaway_payment(
  p_order_id uuid,
  p_payment_method text,
  p_panel_token text
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_order public.orders%ROWTYPE;
  v_method text := lower(btrim(coalesce(p_payment_method,'')));
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['cashier','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Cashier/Admin panel authorization expired or invalid.'; END IF;
  IF v_method NOT IN ('upi_qr','cash','card','bank_transfer') THEN RAISE EXCEPTION 'Choose a supported payment method.'; END IF;
  PERFORM 1 FROM public.restaurant_workflow_settings s
   WHERE s.restaurant_id=v_restaurant_id AND NOT (v_method = ANY(s.allowed_payment_methods));
  IF FOUND THEN RAISE EXCEPTION 'This payment method is not enabled for this restaurant.'; END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id=p_order_id AND o.restaurant_id=v_restaurant_id
    AND o.order_type::text='takeaway'
    AND o.billing_status::text='bill_ready'
    AND o.status<>'cancelled'::public.order_status
  FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Takeaway bill must be ready before payment can be confirmed.'; END IF;
  IF v_order.payment_status='paid'::public.payment_status OR v_order.billing_status::text='closed' THEN
    RAISE EXCEPTION 'This takeaway order is already paid and closed.';
  END IF;
  UPDATE public.orders
    SET status='completed'::public.order_status,
        payment_status='paid'::public.payment_status,
        billing_status='closed', payment_method=v_method, updated_at=now()
  WHERE id=v_order.id AND restaurant_id=v_restaurant_id
  RETURNING * INTO v_order;
  PERFORM public._tableforge_audit_event(v_restaurant_id,'takeaway_payment_confirmed','orders',v_order.id::text,
    NULL,to_jsonb(v_order),jsonb_build_object('payment_method',v_method,'payment_status','paid','billing_status','closed'),'{}'::jsonb);
  RETURN v_order;
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_session_payment(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_session_payment(uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.complete_takeaway_payment(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_takeaway_payment(uuid,text,text) TO authenticated;

-- Preserve the existing workflow policy validations while expanding its payment allowlist.
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
  ) THEN RAISE EXCEPTION 'Select at least one supported payment method.'; END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1 FROM public.products p WHERE p.restaurant_id=v_restaurant_id AND p.is_active
      AND NOT EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.restaurant_id=v_restaurant_id AND r.product_id=p.id)
  ) THEN RAISE EXCEPTION 'Strict inventory cannot be enabled until every active product has a recipe or an explicit not-tracked classification.'; END IF;
  IF p_inventory_mode='strict' AND EXISTS (
    SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
    WHERE o.restaurant_id=v_restaurant_id AND o.status::text NOT IN ('completed','cancelled')
      AND o.payment_status::text IS DISTINCT FROM 'paid' AND o.billing_status::text IS DISTINCT FROM 'closed'
      AND oi.serving_status IN ('pending','preparing','ready')
  ) THEN RAISE EXCEPTION 'Finish or reconcile all active order items before enabling strict inventory.'; END IF;
  INSERT INTO public.restaurant_workflow_settings(restaurant_id,inventory_mode,allow_takeaway_prepayment,allowed_payment_methods,updated_at)
  VALUES(v_restaurant_id,p_inventory_mode,coalesce(p_allow_takeaway_prepayment,true),v_methods,now())
  ON CONFLICT (restaurant_id) DO UPDATE SET inventory_mode=excluded.inventory_mode,
    allow_takeaway_prepayment=excluded.allow_takeaway_prepayment,
    allowed_payment_methods=excluded.allowed_payment_methods,updated_at=now();
  PERFORM public._tableforge_audit_event(v_restaurant_id,'restaurant_workflow_settings_updated','restaurant_workflow_settings',v_restaurant_id::text,
    NULL,NULL,jsonb_build_object('inventory_mode',p_inventory_mode,'allow_takeaway_prepayment',coalesce(p_allow_takeaway_prepayment,true),'allowed_payment_methods',v_methods),'{}'::jsonb);
  RETURN jsonb_build_object('ok',true,'inventory_mode',p_inventory_mode,'allow_takeaway_prepayment',coalesce(p_allow_takeaway_prepayment,true),'allowed_payment_methods',v_methods);
END;
$function$;
REVOKE ALL ON FUNCTION public.save_restaurant_workflow_settings(text,boolean,text[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_restaurant_workflow_settings(text,boolean,text[],text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) Reporting data source for Revenue, Product Analytics and Top Products.
-- Only paid bills contribute to revenue; open balances are shown separately.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_reporting_data(
  p_panel_token text,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_result jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF p_period_start IS NOT NULL AND p_period_end IS NOT NULL AND p_period_end <= p_period_start THEN
    RAISE EXCEPTION 'Reporting end must be after reporting start.';
  END IF;
  IF (p_period_start IS NULL) <> (p_period_end IS NULL) THEN
    RAISE EXCEPTION 'Provide both reporting bounds or neither for all time.';
  END IF;

  WITH bills AS MATERIALIZED (
    SELECT
      ('session:' || ds.id::text) AS bill_key,
      ds.restaurant_id,
      'dine_in'::text AS bill_type,
      COALESCE(ds.bill_grand_total, 0)::numeric AS amount,
      ds.payment_status::text AS payment_status,
      NULLIF(btrim(ds.payment_method),'') AS payment_method,
      COALESCE(ds.closed_at, ds.updated_at, ds.created_at) AS relevant_at,
      COALESCE(ds.bill_ready_at, ds.closed_at, ds.updated_at, ds.created_at) AS issue_at,
      ds.status::text AS source_status,
      (ds.status IN ('bill_ready','closed') AND ds.bill_grand_total IS NOT NULL) AS is_issued,
      (ds.status = 'bill_ready' AND ds.payment_status::text IS DISTINCT FROM 'paid') AS is_open
    FROM public.dining_sessions ds
    WHERE ds.restaurant_id = v_restaurant_id
      AND (ds.status IN ('bill_ready','closed') OR ds.payment_status::text IN ('paid','refunded'))
      AND EXISTS (
        SELECT 1 FROM public.orders o
        WHERE o.session_id=ds.id AND o.restaurant_id=v_restaurant_id
          AND o.status<>'cancelled'::public.order_status
      )
    UNION ALL
    SELECT
      ('order:' || o.id::text) AS bill_key,
      o.restaurant_id,
      'takeaway'::text AS bill_type,
      COALESCE(o.grand_total, 0)::numeric AS amount,
      o.payment_status::text AS payment_status,
      NULLIF(btrim(o.payment_method),'') AS payment_method,
      COALESCE(o.updated_at, o.created_at) AS relevant_at,
      COALESCE(o.bill_ready_at, o.updated_at, o.created_at) AS issue_at,
      o.billing_status::text AS source_status,
      (o.billing_status::text IN ('bill_ready','issued','closed')) AS is_issued,
      (o.billing_status::text IN ('bill_ready','issued') AND o.payment_status::text IS DISTINCT FROM 'paid') AS is_open
    FROM public.orders o
    WHERE o.restaurant_id = v_restaurant_id
      AND o.order_type::text='takeaway'
      AND o.session_id IS NULL
      AND o.status<>'cancelled'::public.order_status
      AND (o.billing_status::text IN ('bill_ready','issued','closed') OR o.payment_status::text IN ('paid','refunded'))
  ), paid_bills AS (
    SELECT * FROM bills
    WHERE payment_status='paid'
      AND (p_period_start IS NULL OR relevant_at >= p_period_start)
      AND (p_period_end IS NULL OR relevant_at < p_period_end)
  ), issued_bills AS (
    SELECT * FROM bills
    WHERE is_issued
      AND (p_period_start IS NULL OR issue_at >= p_period_start)
      AND (p_period_end IS NULL OR issue_at < p_period_end)
  ), open_bills AS (
    SELECT * FROM bills
    WHERE is_open
      AND (p_period_start IS NULL OR issue_at >= p_period_start)
      AND (p_period_end IS NULL OR issue_at < p_period_end)
  ), refunded_bills AS (
    SELECT * FROM bills
    WHERE payment_status='refunded'
      AND (p_period_start IS NULL OR relevant_at >= p_period_start)
      AND (p_period_end IS NULL OR relevant_at < p_period_end)
  ), item_sales AS (
    SELECT
      oi.name_snapshot AS name,
      COALESCE(NULLIF(p.category,''),'Uncategorized') AS category,
      SUM(oi.quantity)::bigint AS quantity_sold,
      SUM(oi.line_total)::numeric AS revenue
    FROM public.orders o
    JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
    LEFT JOIN public.dining_sessions ds ON ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
    LEFT JOIN public.products p ON p.id=oi.product_id AND p.restaurant_id=o.restaurant_id
    WHERE o.restaurant_id=v_restaurant_id
      AND o.payment_status::text='paid'
      AND o.status<>'cancelled'::public.order_status
      AND oi.serving_status IS DISTINCT FROM 'cancelled'
      AND (p_period_start IS NULL OR COALESCE(ds.closed_at,o.updated_at,o.created_at) >= p_period_start)
      AND (p_period_end IS NULL OR COALESCE(ds.closed_at,o.updated_at,o.created_at) < p_period_end)
    GROUP BY oi.name_snapshot, COALESCE(NULLIF(p.category,''),'Uncategorized')
  ), cancelled_items AS (
    SELECT COALESCE(SUM(oi.quantity),0)::bigint AS units
    FROM public.orders o
    JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
    LEFT JOIN public.dining_sessions ds ON ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
    WHERE o.restaurant_id=v_restaurant_id
      AND oi.serving_status='cancelled'
      AND (p_period_start IS NULL OR COALESCE(oi.cancelled_at,oi.created_at) >= p_period_start)
      AND (p_period_end IS NULL OR COALESCE(oi.cancelled_at,oi.created_at) < p_period_end)
  )
  SELECT jsonb_build_object(
    'metrics', (
      SELECT jsonb_build_object(
        'paid_revenue', COALESCE(SUM(amount) FILTER (WHERE payment_status='paid'),0),
        'bills_issued', (SELECT COUNT(*) FROM issued_bills),
        'outstanding_amount', COALESCE((SELECT SUM(amount) FROM open_bills),0),
        'outstanding_bills', (SELECT COUNT(*) FROM open_bills),
        'refunded_amount', COALESCE((SELECT SUM(amount) FROM refunded_bills),0),
        'refunded_bills', (SELECT COUNT(*) FROM refunded_bills),
        'paid_bills', COUNT(*) FILTER (WHERE payment_status='paid')
      ) FROM paid_bills
    ),
    'trend', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('label',label,'revenue',revenue,'bills',bill_count) ORDER BY bucket)
      FROM (
        SELECT
          date_trunc(CASE WHEN p_period_start IS NULL AND p_period_end IS NULL THEN 'month' ELSE 'day' END,
            relevant_at AT TIME ZONE 'Asia/Kolkata') AS bucket,
          to_char(date_trunc(CASE WHEN p_period_start IS NULL AND p_period_end IS NULL THEN 'month' ELSE 'day' END,
            relevant_at AT TIME ZONE 'Asia/Kolkata'),
            CASE WHEN p_period_start IS NULL AND p_period_end IS NULL THEN 'Mon YYYY' ELSE 'DD Mon' END) AS label,
          SUM(amount)::numeric AS revenue,
          COUNT(*)::bigint AS bill_count
        FROM paid_bills
        GROUP BY 1,2
        ORDER BY 1 DESC
        LIMIT 120
      ) trend_rows
    ),'[]'::jsonb),
    'payment_breakdown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('method',method,'amount',amount,'bills',bill_count) ORDER BY amount DESC)
      FROM (
        SELECT COALESCE(payment_method,'Unrecorded') AS method, SUM(amount)::numeric AS amount, COUNT(*)::bigint AS bill_count
        FROM paid_bills GROUP BY COALESCE(payment_method,'Unrecorded')
      ) payment_rows
    ),'[]'::jsonb),
    'sales_by_hour', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('hour',hour,'amount',amount,'bills',bill_count) ORDER BY hour)
      FROM (
        SELECT EXTRACT(HOUR FROM (relevant_at AT TIME ZONE 'Asia/Kolkata'))::integer AS hour,
          SUM(amount)::numeric AS amount, COUNT(*)::bigint AS bill_count
        FROM paid_bills GROUP BY 1
      ) hourly_rows
    ),'[]'::jsonb),
    'top_products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name',name,'category',category,'quantity_sold',quantity_sold,'revenue',revenue) ORDER BY quantity_sold DESC,revenue DESC,name)
      FROM (SELECT * FROM item_sales ORDER BY quantity_sold DESC,revenue DESC,name LIMIT 500) product_rows
    ),'[]'::jsonb),
    'top_categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category',category,'quantity_sold',quantity_sold,'revenue',revenue) ORDER BY revenue DESC,category)
      FROM (SELECT category,SUM(quantity_sold)::bigint AS quantity_sold,SUM(revenue)::numeric AS revenue FROM item_sales GROUP BY category ORDER BY SUM(revenue) DESC LIMIT 25) category_rows
    ),'[]'::jsonb),
    'cancelled_units', (SELECT units FROM cancelled_items)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_admin_reporting_data(text,timestamptz,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_reporting_data(text,timestamptz,timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) Audit view data source. security_logs is already required by the master
-- migration; ensure the columns used by the existing audit writer are present.
-- ---------------------------------------------------------------------------
ALTER TABLE public.security_logs
  ADD COLUMN IF NOT EXISTS restaurant_id uuid,
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS actor_id uuid,
  ADD COLUMN IF NOT EXISTS target_table text,
  ADD COLUMN IF NOT EXISTS target_id text,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS before_state jsonb,
  ADD COLUMN IF NOT EXISTS after_state jsonb,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS security_logs_tenant_time_idx
  ON public.security_logs(restaurant_id,created_at DESC);
REVOKE ALL ON public.security_logs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_audit_dashboard(
  p_panel_token text,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL,
  p_category text DEFAULT 'all',
  p_search text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_payload jsonb; v_search text := lower(btrim(coalesce(p_search,''))); v_category text := lower(btrim(coalesce(p_category,'all')));
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF p_period_start IS NOT NULL AND p_period_end IS NOT NULL AND p_period_end <= p_period_start THEN
    RAISE EXCEPTION 'Reporting end must be after reporting start.';
  END IF;
  IF (p_period_start IS NULL) <> (p_period_end IS NULL) THEN
    RAISE EXCEPTION 'Provide both reporting bounds or neither for all time.';
  END IF;

  WITH filtered AS MATERIALIZED (
    SELECT sl.created_at,sl.event_type,sl.actor_id,sl.target_table,sl.target_id,sl.reason,sl.metadata
    FROM public.security_logs sl
    WHERE sl.restaurant_id=v_restaurant_id
      AND (p_period_start IS NULL OR sl.created_at >= p_period_start)
      AND (p_period_end IS NULL OR sl.created_at < p_period_end)
      AND (
        v_category='all'
        OR (v_category='orders' AND lower(coalesce(sl.event_type,'')) LIKE '%order%')
        OR (v_category='billing' AND (lower(coalesce(sl.event_type,'')) LIKE '%bill%' OR lower(coalesce(sl.event_type,'')) LIKE '%payment%'))
        OR (v_category='inventory' AND (lower(coalesce(sl.event_type,'')) LIKE '%inventory%' OR lower(coalesce(sl.event_type,'')) LIKE '%stock%' OR lower(coalesce(sl.event_type,'')) LIKE '%recipe%'))
        OR (v_category='security' AND (lower(coalesce(sl.event_type,'')) LIKE '%pin%' OR lower(coalesce(sl.event_type,'')) LIKE '%auth%' OR lower(coalesce(sl.event_type,'')) LIKE '%token%' OR lower(coalesce(sl.event_type,'')) LIKE '%security%'))
      )
      AND (v_search='' OR concat_ws(' ',sl.event_type,sl.target_table,sl.target_id,sl.reason,sl.metadata::text)::text ILIKE '%'||v_search||'%')
  )
  SELECT jsonb_build_object(
    'metrics',jsonb_build_object(
      'recorded_actions',(SELECT COUNT(*) FROM filtered),
      'exceptions',(SELECT COUNT(*) FROM filtered WHERE lower(coalesce(event_type,'')) LIKE '%fail%' OR lower(coalesce(event_type,'')) LIKE '%cancel%' OR lower(coalesce(event_type,'')) LIKE '%reject%' OR lower(coalesce(event_type,'')) LIKE '%exception%' OR lower(coalesce(event_type,'')) LIKE '%adjustment%'),
      'security_events',(SELECT COUNT(*) FROM filtered WHERE lower(coalesce(event_type,'')) LIKE '%pin%' OR lower(coalesce(event_type,'')) LIKE '%auth%' OR lower(coalesce(event_type,'')) LIKE '%token%' OR lower(coalesce(event_type,'')) LIKE '%security%')
    ),
    'events',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('created_at',created_at,'event_type',event_type,'actor_id',actor_id,'target_table',target_table,'target_id',target_id,'reason',reason,'metadata',COALESCE(metadata,'{}'::jsonb)) ORDER BY created_at DESC)
      FROM (SELECT * FROM filtered ORDER BY created_at DESC LIMIT 250) event_rows
    ),'[]'::jsonb)
  ) INTO v_payload;
  RETURN v_payload;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_admin_audit_dashboard(text,timestamptz,timestamptz,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_audit_dashboard(text,timestamptz,timestamptz,text,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
