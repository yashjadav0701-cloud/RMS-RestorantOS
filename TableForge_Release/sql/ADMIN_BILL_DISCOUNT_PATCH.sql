-- TableForge Admin bill-discount support.
-- Apply AFTER MASTER_MIGRATION_TABLEFORGE.sql, TABLEFORGE_WORKFLOW_FIX_PATCH.sql,
-- and IMMEDIATE_BILL_AND_ANALYTICS_FIX.sql. This is incremental and non-destructive.
BEGIN;

ALTER TABLE public.dining_sessions
  ADD COLUMN IF NOT EXISTS bill_discount_type text,
  ADD COLUMN IF NOT EXISTS bill_discount_value numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bill_discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bill_discount_reason text;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS discount_type text,
  ADD COLUMN IF NOT EXISTS discount_value numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_reason text;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.dining_sessions'::regclass AND conname='dining_sessions_bill_discount_type_check') THEN
    ALTER TABLE public.dining_sessions ADD CONSTRAINT dining_sessions_bill_discount_type_check
      CHECK (bill_discount_type IS NULL OR bill_discount_type IN ('amount','percent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.dining_sessions'::regclass AND conname='dining_sessions_bill_discount_value_check') THEN
    ALTER TABLE public.dining_sessions ADD CONSTRAINT dining_sessions_bill_discount_value_check
      CHECK (bill_discount_value >= 0 AND (bill_discount_type IS DISTINCT FROM 'percent' OR bill_discount_value <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.dining_sessions'::regclass AND conname='dining_sessions_bill_discount_amount_check') THEN
    ALTER TABLE public.dining_sessions ADD CONSTRAINT dining_sessions_bill_discount_amount_check
      CHECK (bill_discount_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.dining_sessions'::regclass AND conname='dining_sessions_bill_discount_reason_check') THEN
    ALTER TABLE public.dining_sessions ADD CONSTRAINT dining_sessions_bill_discount_reason_check
      CHECK (bill_discount_reason IS NULL OR length(bill_discount_reason) <= 300);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='orders_discount_type_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_discount_type_check
      CHECK (discount_type IS NULL OR discount_type IN ('amount','percent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='orders_discount_value_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_discount_value_check
      CHECK (discount_value >= 0 AND (discount_type IS DISTINCT FROM 'percent' OR discount_value <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='orders_discount_amount_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_discount_amount_check CHECK (discount_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='orders_discount_reason_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_discount_reason_check
      CHECK (discount_reason IS NULL OR length(discount_reason) <= 300);
  END IF;
END;
$constraints$;

-- Only an Admin PIN-backed panel grant may apply or remove a discount.
-- Only unpaid, open bills are editable. The reason is retained in the audit log.
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


-- Preserve Admin discounts when Cashier opens/reprints a session bill.
CREATE OR REPLACE FUNCTION public.generate_cashier_bill(p_panel_token text,p_order_id uuid DEFAULT NULL,p_session_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid; v_order public.orders%ROWTYPE; v_session public.dining_sessions%ROWTYPE;
  v_settings jsonb; v_order_json jsonb; v_items jsonb; v_tables jsonb; v_table_label text;
  v_subtotal numeric(12,2); v_cgst numeric(12,2); v_sgst numeric(12,2); v_rounding numeric(12,2); v_total numeric(12,2);
  v_base_cgst numeric(12,2); v_base_sgst numeric(12,2); v_base_rounding numeric(12,2); v_base_total numeric(12,2);
  v_discount_amount numeric(12,2); v_discount_ratio numeric; v_pre_round numeric(12,2);
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
    INTO v_subtotal,v_base_cgst,v_base_sgst,v_base_rounding,v_base_total,v_order_number,v_created_at
    FROM public.orders o WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id AND o.status <> 'cancelled'::public.order_status;

    -- Session discount persists across Cashier reprints. The order rows stay as
    -- source snapshots; this consolidated session is the authoritative bill.
    IF coalesce(v_session.bill_discount_type,'')='percent' THEN
      v_discount_amount := round(v_subtotal * v_session.bill_discount_value / 100.0, 2);
    ELSIF coalesce(v_session.bill_discount_type,'')='amount' THEN
      v_discount_amount := least(v_subtotal, coalesce(v_session.bill_discount_value,0));
    ELSE
      v_discount_amount := 0;
    END IF;

    IF v_discount_amount > 0 AND v_subtotal > 0 THEN
      v_discount_ratio := (v_subtotal-v_discount_amount)/v_subtotal;
      SELECT coalesce(sum(round(x.taxable_subtotal*v_discount_ratio*x.cgst_rate/100.0,2)),0),
             coalesce(sum(round(x.taxable_subtotal*v_discount_ratio*x.sgst_rate/100.0,2)),0)
      INTO v_cgst,v_sgst
      FROM (
        SELECT o.id,o.cgst_rate,o.sgst_rate,
               coalesce(sum(oi.unit_price*oi.quantity) FILTER (
                 WHERE NOT coalesce(oi.tax_exempt_snapshot,false) AND oi.serving_status <> 'cancelled'
               ),0) AS taxable_subtotal
        FROM public.orders o
        LEFT JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
        WHERE o.session_id=v_session.id AND o.restaurant_id=v_restaurant_id
          AND o.status <> 'cancelled'::public.order_status
        GROUP BY o.id,o.cgst_rate,o.sgst_rate
      ) x;
      v_pre_round := round(v_subtotal-v_discount_amount+v_cgst+v_sgst,2);
      v_total := round(v_pre_round);
      v_rounding := round(v_total-v_pre_round,2);
    ELSE
      v_discount_amount := 0;
      v_cgst := v_base_cgst;
      v_sgst := v_base_sgst;
      v_rounding := v_base_rounding;
      v_total := v_base_total;
    END IF;

    SELECT t.table_no INTO v_table_label FROM public.tables t WHERE t.id=v_session.table_id AND t.restaurant_id=v_restaurant_id;
    UPDATE public.dining_sessions SET
      bill_subtotal=v_subtotal,bill_cgst=v_cgst,bill_sgst=v_sgst,bill_rounding=v_rounding,bill_grand_total=v_total,
      bill_discount_amount=v_discount_amount,
      bill_cgst_rate=COALESCE((v_settings->>'cgst_rate')::numeric,0),
      bill_sgst_rate=COALESCE((v_settings->>'sgst_rate')::numeric,0),updated_at=now()
    WHERE id=v_session.id AND restaurant_id=v_restaurant_id RETURNING * INTO v_session;
    v_type := 'dine_in'; v_table_string := 'Dine-in · Table '||COALESCE(v_table_label,'—');
    v_order_json := jsonb_build_object('id',v_session.id,'order_number',v_order_number,'order_type','dine_in','table_id',v_session.table_id,'session_id',v_session.id,'created_at',v_created_at,'subtotal',v_subtotal,'cgst',v_cgst,'sgst',v_sgst,'rounding',v_rounding,'grand_total',v_total,'bill_discount_type',v_session.bill_discount_type,'bill_discount_value',v_session.bill_discount_value,'bill_discount_amount',v_session.bill_discount_amount,'bill_discount_reason',v_session.bill_discount_reason,'billing_status','bill_ready','payment_status',v_session.payment_status);
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

REVOKE ALL ON FUNCTION public.generate_cashier_bill(text,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_cashier_bill(text,uuid,uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';

COMMIT;
