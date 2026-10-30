-- TableForge: align KOT and Admin table-open actions to one Ready / Undo Ready workflow.
-- Run after MASTER_MIGRATION_TABLEFORGE.sql and TABLEFORGE_WORKFLOW_FIX_PATCH.sql.
-- This migration is additive for columns and preserves existing orders and stock movements.

BEGIN;

-- These fields are already referenced by the live inventory trigger and ready RPCs.
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS inventory_recipe_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS inventory_consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS kot_ready_previous_status text,
  ADD COLUMN IF NOT EXISTS kot_ready_at timestamptz;

COMMENT ON COLUMN public.order_items.inventory_recipe_snapshot IS
  'Recipe snapshot captured when this item first enters preparation and consumes stock.';
COMMENT ON COLUMN public.order_items.inventory_consumed_at IS
  'Timestamp of the first successful recipe inventory consumption for this order item.';
COMMENT ON COLUMN public.order_items.inventory_reconciled_at IS
  'Timestamp when ingredient usage was reconciled after an approved cancellation.';
COMMENT ON COLUMN public.order_items.kot_ready_previous_status IS
  'Previous serving status saved for a reversible KOT Ready action; NULL means not KOT-ready.';
COMMENT ON COLUMN public.order_items.kot_ready_at IS
  'Timestamp when KOT marked this item Ready.';

-- Single-item workflow used by both KOT and Admin > Table Open.
-- Ready is one action: first transition through Preparing (invoking inventory exactly once),
-- then record the item as served with a reversible KOT-ready marker.
CREATE OR REPLACE FUNCTION public.set_kot_item_status(
  p_panel_token text,
  p_item_id uuid,
  p_new_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_item public.order_items%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_before jsonb;
  v_new_status text;
  v_target text := lower(btrim(COALESCE(p_new_status,'')));
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['kot','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'KOT/Admin panel authorization expired or invalid.';
  END IF;

  IF v_target NOT IN ('preparing','ready','served','undo_ready') THEN
    RAISE EXCEPTION 'Unsupported KOT status action. Use Ready or Undo Ready.';
  END IF;

  SELECT oi.* INTO v_item
  FROM public.order_items oi
  JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
  WHERE oi.id=p_item_id
    AND oi.restaurant_id=v_restaurant_id
    AND o.status <> 'cancelled'::public.order_status
    AND (
      (o.order_type::text='takeaway' AND o.billing_status NOT IN ('bill_ready','closed'))
      OR (o.order_type::text='dine_in' AND o.session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.dining_sessions ds
        WHERE ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
          AND ds.status IN ('open','bill_requested')
      ))
    )
  FOR UPDATE OF oi;

  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Order item not found, or its bill has already been prepared.';
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id=v_item.order_id AND o.restaurant_id=v_restaurant_id;

  v_before := jsonb_build_object(
    'serving_status',v_item.serving_status,
    'kot_ready_previous_status',v_item.kot_ready_previous_status,
    'inventory_consumed_at',v_item.inventory_consumed_at
  );

  IF v_target='preparing' THEN
    IF v_item.serving_status <> 'pending' THEN
      RAISE EXCEPTION 'Only pending dishes can start preparation.';
    END IF;
    UPDATE public.order_items
    SET serving_status='preparing'
    WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
    v_new_status := 'preparing';

  ELSIF v_target='ready' THEN
    IF v_item.serving_status='served' AND v_item.kot_ready_previous_status IS NOT NULL THEN
      RETURN jsonb_build_object('ok',true,'item_id',v_item.id,'serving_status','ready','already_ready',true);
    END IF;

    IF v_item.serving_status='preparing' AND v_item.inventory_consumed_at IS NULL THEN
      -- Re-enter Preparing inside this transaction so older items, or items first
      -- prepared while inventory mode was disabled, can safely run the trigger if strict mode is now active.
      UPDATE public.order_items SET serving_status='pending'
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      UPDATE public.order_items SET serving_status='preparing'
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      SELECT * INTO v_item FROM public.order_items WHERE id=p_item_id AND restaurant_id=v_restaurant_id;
    ELSIF v_item.serving_status IN ('pending','ready') AND v_item.inventory_consumed_at IS NULL THEN
      -- This invokes the recipe-consumption trigger before the item is served.
      UPDATE public.order_items
      SET serving_status='preparing'
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      SELECT * INTO v_item FROM public.order_items WHERE id=p_item_id AND restaurant_id=v_restaurant_id;
    ELSIF v_item.serving_status NOT IN ('pending','preparing','ready') THEN
      RAISE EXCEPTION 'Only a pending, preparing or legacy-ready dish can be marked ready.';
    END IF;

    UPDATE public.order_items
    SET serving_status='served',
        kot_ready_previous_status='preparing',
        kot_ready_at=now()
    WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
    v_new_status := 'ready';

  ELSIF v_target='undo_ready' THEN
    IF v_item.serving_status='served' AND v_item.kot_ready_previous_status IS NOT NULL THEN
      UPDATE public.order_items
      SET serving_status=kot_ready_previous_status,
          kot_ready_previous_status=NULL,
          kot_ready_at=NULL
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      SELECT serving_status INTO v_new_status
      FROM public.order_items WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
    ELSIF v_item.serving_status='ready' THEN
      -- Legacy-ready records are moved through Preparing so strict-inventory checks still run.
      UPDATE public.order_items
      SET serving_status='preparing',kot_ready_previous_status=NULL,kot_ready_at=NULL
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      v_new_status := 'preparing';
    ELSE
      RAISE EXCEPTION 'This dish has no reversible Ready action.';
    END IF;

  ELSIF v_target='served' THEN
    -- Compatibility for older clients that explicitly finalize a Ready dish.
    IF v_item.serving_status IN ('pending','ready') AND v_item.inventory_consumed_at IS NULL THEN
      UPDATE public.order_items SET serving_status='preparing'
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      SELECT * INTO v_item FROM public.order_items WHERE id=p_item_id AND restaurant_id=v_restaurant_id;
    ELSIF v_item.serving_status NOT IN ('pending','preparing','ready') THEN
      RAISE EXCEPTION 'Only active dishes can be marked served.';
    END IF;
    UPDATE public.order_items
    SET serving_status='served',kot_ready_previous_status=NULL,kot_ready_at=NULL
    WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
    v_new_status := 'served';
  END IF;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,
    CASE WHEN v_target='undo_ready' THEN 'kot_item_ready_undone'
         WHEN v_new_status='ready' THEN 'kot_item_marked_ready'
         ELSE 'kot_item_status_changed' END,
    'order_items',v_item.id::text,NULL,v_before,
    jsonb_build_object('serving_status',v_new_status,'order_id',v_order.id,'order_number',v_order.order_number),
    jsonb_build_object('action',v_target,'source_panel',
      CASE WHEN position('admin' in current_setting('request.jwt.claims', true)) > 0 THEN 'admin' ELSE 'operational' END)
  );

  RETURN jsonb_build_object('ok',true,'item_id',v_item.id,'serving_status',v_new_status);
END;
$function$;

-- Table-wide Ready / Undo Ready is the same state machine applied atomically to one open table.
CREATE OR REPLACE FUNCTION public.set_kot_table_ready(
  p_panel_token text,
  p_item_ids uuid[],
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_requested_count integer;
  v_matched_count integer;
  v_session_count integer;
  v_table_count integer;
  v_session_id uuid;
  v_table_id uuid;
  v_item record;
  v_before jsonb;
  v_after_status text;
  v_updated integer := 0;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['kot','manager','admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'KOT/Admin panel authorization expired or invalid.';
  END IF;
  IF lower(btrim(COALESCE(p_action,''))) NOT IN ('ready','undo_ready') THEN
    RAISE EXCEPTION 'Table action must be ready or undo_ready.';
  END IF;
  IF p_item_ids IS NULL OR cardinality(p_item_ids)=0 OR cardinality(p_item_ids)>200 THEN
    RAISE EXCEPTION 'Choose one table with between 1 and 200 eligible items.';
  END IF;

  SELECT count(*) INTO v_requested_count
  FROM (SELECT DISTINCT unnest(p_item_ids) AS item_id) ids;

  SELECT count(DISTINCT oi.id),count(DISTINCT o.session_id),count(DISTINCT o.table_id)
  INTO v_matched_count,v_session_count,v_table_count
  FROM public.order_items oi
  JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
  JOIN public.dining_sessions ds ON ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
  WHERE oi.id=ANY(p_item_ids)
    AND oi.restaurant_id=v_restaurant_id
    AND o.order_type::text='dine_in'
    AND o.status <> 'cancelled'::public.order_status
    AND ds.status IN ('open','bill_requested')
    AND oi.serving_status <> 'cancelled';

  IF v_matched_count <> v_requested_count OR v_session_count <> 1 OR v_table_count <> 1 THEN
    RAISE EXCEPTION 'All selected dishes must belong to the same open table in this restaurant.';
  END IF;

  SELECT o.session_id,o.table_id INTO v_session_id,v_table_id
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
  WHERE oi.id=ANY(p_item_ids) AND oi.restaurant_id=v_restaurant_id
  ORDER BY o.created_at,oi.created_at LIMIT 1;

  FOR v_item IN
    SELECT oi.id,oi.serving_status,oi.kot_ready_previous_status,oi.kot_ready_at,
           oi.inventory_consumed_at,o.id AS order_id,o.order_number
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    WHERE oi.id=ANY(p_item_ids) AND oi.restaurant_id=v_restaurant_id
    ORDER BY oi.id
    FOR UPDATE OF oi
  LOOP
    v_before := jsonb_build_object(
      'serving_status',v_item.serving_status,
      'kot_ready_previous_status',v_item.kot_ready_previous_status,
      'inventory_consumed_at',v_item.inventory_consumed_at
    );

    IF lower(p_action)='ready' THEN
      IF v_item.serving_status='served' AND v_item.kot_ready_previous_status IS NOT NULL THEN
        CONTINUE;
      END IF;
      IF v_item.serving_status='cancelled' THEN CONTINUE; END IF;

      IF v_item.serving_status='preparing' AND v_item.inventory_consumed_at IS NULL THEN
        -- Cycle through pending inside the same transaction to fire the trigger
        -- if this item was originally prepared while stock tracking was disabled.
        UPDATE public.order_items SET serving_status='pending'
        WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
        UPDATE public.order_items SET serving_status='preparing'
        WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      ELSIF v_item.serving_status IN ('pending','ready') AND v_item.inventory_consumed_at IS NULL THEN
        -- Trigger snapshots the recipe and consumes stock at the first Preparing transition.
        UPDATE public.order_items SET serving_status='preparing'
        WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      ELSIF v_item.serving_status NOT IN ('pending','preparing','ready') THEN
        RAISE EXCEPTION 'A dish has an unsupported status; refresh the KOT queue.';
      END IF;

      UPDATE public.order_items
      SET serving_status='served',kot_ready_previous_status='preparing',kot_ready_at=now()
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      v_after_status := 'ready';
    ELSE
      IF v_item.serving_status='served' AND v_item.kot_ready_previous_status IS NOT NULL THEN
        UPDATE public.order_items
        SET serving_status=kot_ready_previous_status,kot_ready_previous_status=NULL,kot_ready_at=NULL
        WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
        SELECT serving_status INTO v_after_status
        FROM public.order_items WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      ELSIF v_item.serving_status='ready' THEN
        UPDATE public.order_items
        SET serving_status='preparing',kot_ready_previous_status=NULL,kot_ready_at=NULL
        WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
        v_after_status := 'preparing';
      ELSE
        RAISE EXCEPTION 'Undo Ready is available only when all selected dishes are marked ready.';
      END IF;
    END IF;

    PERFORM public._tableforge_audit_event(
      v_restaurant_id,
      CASE WHEN lower(p_action)='ready' THEN 'kot_table_item_marked_ready' ELSE 'kot_table_item_ready_undone' END,
      'order_items',v_item.id::text,NULL,v_before,
      jsonb_build_object('serving_status',v_after_status,'session_id',v_session_id,'table_id',v_table_id),
      jsonb_build_object('action',p_action,'scope','table')
    );
    v_updated := v_updated+1;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'table_id',v_table_id,'session_id',v_session_id,
    'action',lower(p_action),'updated_count',v_updated);
END;
$function$;

-- KOT needs the reversible Ready marker in its queue response. It must hide tickets after
-- bill generation, but keep them visible while the dining session is open or bill-requested.
DROP FUNCTION IF EXISTS public.get_kot_queue(text);
CREATE FUNCTION public.get_kot_queue(p_panel_token text)
RETURNS TABLE(
  item_id uuid,
  order_id uuid,
  order_number bigint,
  order_type text,
  table_label text,
  round_number integer,
  order_note text,
  order_created_at timestamptz,
  item_name text,
  quantity integer,
  serving_status text,
  cancellation_reason text,
  session_id uuid,
  table_id uuid,
  kot_ready_previous_status text,
  kot_ready_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['kot','manager']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'KOT panel authorization expired or invalid.';
  END IF;

  RETURN QUERY
  SELECT oi.id,o.id,o.order_number,o.order_type::text,t.table_no,o.round_number,o.note,o.created_at,
         oi.name_snapshot,oi.quantity,oi.serving_status,oi.cancellation_reason,
         o.session_id,o.table_id,oi.kot_ready_previous_status,oi.kot_ready_at
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
  LEFT JOIN public.tables t ON t.id=o.table_id AND t.restaurant_id=o.restaurant_id
  WHERE o.restaurant_id=v_restaurant_id
    AND o.status <> 'cancelled'::public.order_status
    AND (
      oi.serving_status IN ('pending','preparing','ready','cancelled')
      OR (oi.serving_status='served' AND oi.kot_ready_previous_status IS NOT NULL)
    )
    AND (
      (o.order_type::text='takeaway' AND o.billing_status NOT IN ('bill_ready','closed'))
      OR (o.order_type::text='dine_in' AND o.session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.dining_sessions ds
        WHERE ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
          AND ds.status IN ('open','bill_requested')
      ))
    )
  ORDER BY o.created_at ASC,o.round_number ASC NULLS FIRST,oi.created_at ASC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_kot_queue(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kot_queue(text) TO authenticated;
REVOKE ALL ON FUNCTION public.set_kot_item_status(text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_kot_item_status(text,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.set_kot_table_ready(text,uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_kot_table_ready(text,uuid[],text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
