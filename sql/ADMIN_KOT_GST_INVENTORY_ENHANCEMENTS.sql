-- TableForge release enhancements for Four Flavours / KOT / GST / recipe inventory.
-- Run once in the correct Supabase project AFTER MASTER_MIGRATION_TABLEFORGE.sql
-- and TABLEFORGE_WORKFLOW_FIX_PATCH.sql. Safe to re-run: existing manual recipes,
-- ingredient costs, stock movements, orders and recipe rows are not overwritten.
-- IMPORTANT: Seeded quantities/costs are planning estimates and must be kitchen-reviewed.

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.restaurants WHERE slug='four-flavours') THEN
    RAISE EXCEPTION 'Four Flavours tenant (slug four-flavours) was not found; no enhancement was applied.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products p JOIN public.restaurants r ON r.id=p.restaurant_id WHERE r.slug='four-flavours' AND p.is_active) THEN
    RAISE EXCEPTION 'Four Flavours has no active menu products; verify the selected Supabase project before continuing.';
  END IF;
END;
$preflight$;

-- -----------------------------------------------------------------------------
-- 1. GSTIN is one-time-set for restaurant Admins. Developer override is SQL-only.
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS gst_number text,
  ADD COLUMN IF NOT EXISTS gst_number_locked_at timestamptz;

UPDATE public.app_settings
SET gst_number = upper(btrim(gst_number)),
    gst_number_locked_at = COALESCE(gst_number_locked_at, updated_at, now())
WHERE NULLIF(btrim(gst_number), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public._tableforge_guard_gst_number_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
  v_old text := NULLIF(upper(btrim(COALESCE(OLD.gst_number,''))), '');
  v_new text := NULLIF(upper(btrim(COALESCE(NEW.gst_number,''))), '');
  v_override text := COALESCE(current_setting('tableforge.allow_gst_override', true), '');
BEGIN
  NEW.gst_number := v_new;

  IF v_old IS NOT NULL AND v_new IS DISTINCT FROM v_old AND v_override <> 'on' THEN
    RAISE EXCEPTION 'GSTIN is locked after its first save. Contact the developer for an authorized change or removal.';
  END IF;

  IF v_new IS NOT NULL
     AND v_new !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
     AND (TG_OP <> 'UPDATE' OR v_new IS DISTINCT FROM v_old) THEN
    RAISE EXCEPTION 'Enter a valid 15-character GSTIN before saving.';
  END IF;

  IF v_new IS NULL THEN
    NEW.gst_number_locked_at := NULL;
  ELSIF v_old IS NULL OR v_override = 'on' THEN
    NEW.gst_number_locked_at := COALESCE(NEW.gst_number_locked_at, now());
  ELSE
    NEW.gst_number_locked_at := COALESCE(OLD.gst_number_locked_at, NEW.gst_number_locked_at, now());
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tableforge_gst_number_once ON public.app_settings;
CREATE TRIGGER trg_tableforge_gst_number_once
BEFORE INSERT OR UPDATE OF gst_number ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public._tableforge_guard_gst_number_once();
REVOKE ALL ON FUNCTION public._tableforge_guard_gst_number_once() FROM PUBLIC, anon, authenticated;
COMMENT ON COLUMN public.app_settings.gst_number IS 'One-time-set GSTIN. Restaurant Admin cannot alter/remove it after initial save; authorized developer maintenance only.';
COMMENT ON COLUMN public.app_settings.gst_number_locked_at IS 'Timestamp when this GSTIN was first saved or developer-authorized change was made.';

-- Developer-only maintenance procedure (DO NOT expose as a frontend RPC):
-- BEGIN;
-- SET LOCAL tableforge.allow_gst_override = 'on';
-- UPDATE public.app_settings SET gst_number = '<REPLACE_WITH_VERIFIED_15_CHAR_GSTIN>' WHERE restaurant_id = '<REPLACE_WITH_RESTAURANT_UUID>'::uuid;
-- -- To clear it for a replacement: SET gst_number = NULL instead.
-- COMMIT;

-- -----------------------------------------------------------------------------
-- 2. KOT state: Ready is displayed as Ready while stored as served; reversible.
--    A ready-marked item stays in the same queue position and remains on KOT
--    until Cashier generates the bill (session/order becomes bill_ready).
-- -----------------------------------------------------------------------------
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS kot_ready_previous_status text,
  ADD COLUMN IF NOT EXISTS kot_ready_at timestamptz;

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_kot_ready_previous_status_check;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_kot_ready_previous_status_check
  CHECK (kot_ready_previous_status IS NULL OR kot_ready_previous_status IN ('pending','preparing'));

CREATE OR REPLACE FUNCTION public.get_kot_queue(p_panel_token text)
RETURNS TABLE(
  item_id uuid, order_id uuid, order_number bigint, order_type text,
  table_label text, round_number integer, order_note text,
  order_created_at timestamptz, item_name text, quantity integer,
  serving_status text, cancellation_reason text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['kot','manager']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'KOT panel authorization expired or invalid.'; END IF;

  RETURN QUERY
  SELECT oi.id, o.id, o.order_number, o.order_type::text, t.table_no,
         o.round_number, o.note, o.created_at, oi.name_snapshot, oi.quantity,
         CASE
           WHEN oi.serving_status='served' AND oi.kot_ready_previous_status IS NOT NULL THEN 'ready'
           ELSE oi.serving_status
         END::text,
         oi.cancellation_reason
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
  LEFT JOIN public.tables t ON t.id=o.table_id AND t.restaurant_id=o.restaurant_id
  WHERE o.restaurant_id=v_restaurant_id
    AND o.status <> 'cancelled'::public.order_status
    AND (
      (o.order_type::text='takeaway' AND o.billing_status NOT IN ('bill_ready','closed'))
      OR
      (o.order_type::text='dine_in' AND o.session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.dining_sessions ds
        WHERE ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
          AND ds.status IN ('open','bill_requested')
      ))
    )
    AND (
      oi.serving_status IN ('pending','preparing','ready','served','cancelled')
    )
  ORDER BY o.created_at ASC, o.round_number ASC NULLS FIRST, oi.created_at ASC;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_kot_queue(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kot_queue(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_kot_item_status(
  p_panel_token text,
  p_item_id uuid,
  p_new_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
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
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['kot','manager']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'KOT panel authorization expired or invalid.'; END IF;
  IF v_target NOT IN ('preparing','ready','served','undo_ready') THEN
    RAISE EXCEPTION 'Unsupported KOT status action. Use Ready or Undo ready.';
  END IF;

  SELECT oi.* INTO v_item
  FROM public.order_items oi
  JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
  WHERE oi.id=p_item_id AND oi.restaurant_id=v_restaurant_id
    AND o.status <> 'cancelled'::public.order_status
    AND (
      (o.order_type::text='takeaway' AND o.billing_status NOT IN ('bill_ready','closed'))
      OR (o.order_type::text='dine_in' AND o.session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.dining_sessions ds WHERE ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
          AND ds.status IN ('open','bill_requested')
      ))
    )
  FOR UPDATE OF oi;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Order item not found, or its bill has already been prepared.'; END IF;

  SELECT o.* INTO v_order FROM public.orders o WHERE o.id=v_item.order_id AND o.restaurant_id=v_restaurant_id;
  v_before := jsonb_build_object('serving_status',v_item.serving_status,'kot_ready_previous_status',v_item.kot_ready_previous_status);

  IF v_target='preparing' THEN
    IF v_item.serving_status <> 'pending' THEN RAISE EXCEPTION 'Only pending dishes can start preparation.'; END IF;
    UPDATE public.order_items SET serving_status='preparing' WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
    v_new_status := 'preparing';
  ELSIF v_target IN ('ready','served') THEN
    IF v_item.serving_status='pending' THEN
      -- Make inventory consumption run exactly at the first Preparing transition.
      UPDATE public.order_items SET serving_status='preparing' WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      SELECT * INTO v_item FROM public.order_items WHERE id=p_item_id AND restaurant_id=v_restaurant_id;
    ELSIF v_item.serving_status NOT IN ('preparing','ready') THEN
      IF v_item.serving_status='served' AND v_item.kot_ready_previous_status IS NOT NULL THEN
        RETURN jsonb_build_object('ok',true,'item_id',v_item.id,'serving_status','ready','already_ready',true);
      END IF;
      RAISE EXCEPTION 'Only a pending, preparing or legacy-ready dish can be marked ready.';
    END IF;
    UPDATE public.order_items
    SET serving_status='served',
        kot_ready_previous_status=CASE WHEN v_item.serving_status='pending' THEN 'preparing'
                                       WHEN v_item.serving_status='preparing' THEN 'preparing'
                                       ELSE 'preparing' END,
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
      SELECT serving_status INTO v_new_status FROM public.order_items WHERE id=v_item.id;
    ELSIF v_item.serving_status='ready' THEN
      -- Backward-compatible path for a legacy ready row created before this patch.
      UPDATE public.order_items SET serving_status='preparing',kot_ready_previous_status=NULL,kot_ready_at=NULL
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      v_new_status := 'preparing';
    ELSE
      RAISE EXCEPTION 'This dish has no reversible Ready action.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported KOT status action.';
  END IF;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,
    CASE WHEN v_target='undo_ready' THEN 'kot_item_ready_undone' WHEN v_new_status='ready' THEN 'kot_item_marked_ready' ELSE 'kot_item_status_changed' END,
    'order_items',v_item.id::text,NULL,v_before,
    jsonb_build_object('serving_status',v_new_status,'order_id',v_order.id,'order_number',v_order.order_number),
    jsonb_build_object('action',v_target)
  );
  RETURN jsonb_build_object('ok',true,'item_id',v_item.id,'serving_status',v_new_status);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_kot_item_status(text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_kot_item_status(text,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_kot_table_ready(
  p_panel_token text,
  p_item_ids uuid[],
  p_action text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
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
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['kot','manager']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'KOT panel authorization expired or invalid.'; END IF;
  IF lower(btrim(COALESCE(p_action,''))) NOT IN ('ready','undo_ready') THEN RAISE EXCEPTION 'Table action must be ready or undo_ready.'; END IF;
  IF p_item_ids IS NULL OR cardinality(p_item_ids)=0 OR cardinality(p_item_ids)>200 THEN RAISE EXCEPTION 'Choose one table with between 1 and 200 items.'; END IF;

  SELECT count(*) INTO v_requested_count FROM (SELECT DISTINCT unnest(p_item_ids) AS item_id) ids;
  SELECT count(DISTINCT oi.id),count(DISTINCT o.session_id),count(DISTINCT o.table_id)
  INTO v_matched_count,v_session_count,v_table_count
  FROM public.order_items oi
  JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
  JOIN public.dining_sessions ds ON ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
  WHERE oi.id=ANY(p_item_ids) AND oi.restaurant_id=v_restaurant_id
    AND o.order_type::text='dine_in' AND o.status <> 'cancelled'::public.order_status
    AND ds.status IN ('open','bill_requested')
    AND oi.serving_status <> 'cancelled';

  IF v_matched_count <> v_requested_count OR v_session_count <> 1 OR v_table_count <> 1 THEN
    RAISE EXCEPTION 'All selected dishes must belong to the same open table in this restaurant.';
  END IF;

  SELECT o.session_id,o.table_id INTO v_session_id,v_table_id
  FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
  WHERE oi.id=ANY(p_item_ids) AND oi.restaurant_id=v_restaurant_id
  ORDER BY o.created_at,oi.created_at LIMIT 1;

  FOR v_item IN
    SELECT oi.id,oi.serving_status,oi.kot_ready_previous_status,oi.kot_ready_at,oi.inventory_consumed_at,
           o.id AS order_id, o.order_number
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id AND o.restaurant_id=oi.restaurant_id
    WHERE oi.id=ANY(p_item_ids) AND oi.restaurant_id=v_restaurant_id
    ORDER BY oi.id
    FOR UPDATE OF oi
  LOOP
    v_before := jsonb_build_object('serving_status',v_item.serving_status,'kot_ready_previous_status',v_item.kot_ready_previous_status);

    IF lower(p_action)='ready' THEN
      IF v_item.serving_status='served' AND v_item.kot_ready_previous_status IS NOT NULL THEN
        CONTINUE;
      END IF;
      IF v_item.serving_status='cancelled' THEN CONTINUE; END IF;
      IF v_item.serving_status='pending' THEN
        -- Trigger snapshots the recipe and consumes stock at Preparing in strict-inventory mode.
        UPDATE public.order_items SET serving_status='preparing' WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      ELSIF v_item.serving_status NOT IN ('preparing','ready') THEN
        RAISE EXCEPTION 'A dish has an unsupported status; refresh the KOT queue.';
      END IF;
      UPDATE public.order_items SET serving_status='served',kot_ready_previous_status='preparing',kot_ready_at=now()
      WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
      v_after_status := 'ready';
    ELSE
      IF v_item.serving_status='served' AND v_item.kot_ready_previous_status IS NOT NULL THEN
        UPDATE public.order_items SET serving_status=kot_ready_previous_status,kot_ready_previous_status=NULL,kot_ready_at=NULL
        WHERE id=v_item.id AND restaurant_id=v_restaurant_id;
        SELECT serving_status INTO v_after_status FROM public.order_items WHERE id=v_item.id;
      ELSIF v_item.serving_status='ready' THEN
        UPDATE public.order_items SET serving_status='preparing',kot_ready_previous_status=NULL,kot_ready_at=NULL
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

  RETURN jsonb_build_object('ok',true,'table_id',v_table_id,'session_id',v_session_id,'action',lower(p_action),'updated_count',v_updated);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_kot_table_ready(text,uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_kot_table_ready(text,uuid[],text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Persist and label provisional Indian ingredient cost estimates.
--    Costs are INR per base unit (g/ml/pcs); no opening stock is created.
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_ingredients
  ADD COLUMN IF NOT EXISTS cost_is_estimate boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cost_source_note text NOT NULL DEFAULT '';

ALTER TABLE public.product_recipes
  ADD COLUMN IF NOT EXISTS is_estimate boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_note text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION public.get_inventory_dashboard(p_panel_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE v_restaurant_id uuid; v_ingredients jsonb; v_movements jsonb; v_recipes jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',i.id,'name',i.name,'category',i.category,'baseUnit',i.base_unit,'reorderLevel',i.reorder_level,
    'costPerUnit',i.cost_per_unit,'costIsEstimate',i.cost_is_estimate,'costSourceNote',i.cost_source_note,
    'currentStock',COALESCE(m.balance,0),'isActive',i.is_active
  ) ORDER BY i.name),'[]'::jsonb) INTO v_ingredients
  FROM public.inventory_ingredients i
  LEFT JOIN LATERAL (SELECT sum(im.quantity_delta) AS balance FROM public.inventory_movements im WHERE im.ingredient_id=i.id AND im.restaurant_id=i.restaurant_id) m ON true
  WHERE i.restaurant_id=v_restaurant_id AND i.is_active=true;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',m.id,'ingredientId',m.ingredient_id,'movementType',m.movement_type,
    'label',CASE m.movement_type WHEN 'opening_stock' THEN 'Opening stock' WHEN 'received' THEN 'Stock received' WHEN 'waste' THEN 'Wastage' WHEN 'adjustment_in' THEN 'Correction (+)' WHEN 'sale' THEN 'Dish consumption' ELSE 'Correction (−)' END,
    'quantityDelta',m.quantity_delta,'unit',m.unit,'reason',m.reason,'createdAt',extract(epoch FROM m.created_at)*1000,'orderId',m.reference_order_id,'orderItemId',m.reference_order_item_id
  ) ORDER BY m.created_at DESC),'[]'::jsonb) INTO v_movements
  FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id',r.product_id,'ingredient_id',r.ingredient_id,
    'quantity_per_serving',r.quantity_per_serving,
    'is_estimate',r.is_estimate,'source_note',r.source_note
  ) ORDER BY r.product_id, r.ingredient_id),'[]'::jsonb)
  INTO v_recipes FROM public.product_recipes r WHERE r.restaurant_id=v_restaurant_id;
  RETURN jsonb_build_object('ok',true,'ingredients',COALESCE(v_ingredients,'[]'::jsonb),'movements',COALESCE(v_movements,'[]'::jsonb),'recipes',COALESCE(v_recipes,'[]'::jsonb));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_inventory_dashboard(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_dashboard(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_save_ingredient(p_panel_token text,p_ingredient_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_id uuid;
  v_name text;
  v_category text;
  v_unit text;
  v_reorder numeric;
  v_cost numeric;
  v_old_cost numeric;
  v_old_is_estimate boolean;
  v_old_source_note text;
  v_confirm_cost boolean := COALESCE((p_payload->>'confirmCost')::boolean,false);
  v_record jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;

  v_name:=btrim(COALESCE(p_payload->>'name',''));
  v_category:=COALESCE(NULLIF(p_payload->>'category',''),'other');
  v_unit:=p_payload->>'baseUnit';
  v_reorder:=COALESCE(NULLIF(p_payload->>'reorderLevel','')::numeric,0);
  v_cost:=NULLIF(p_payload->>'costPerUnit','')::numeric;
  IF v_name='' OR length(v_name)>120 OR v_unit NOT IN ('g','ml','pcs') OR v_reorder<0 OR (v_cost IS NOT NULL AND v_cost<0) THEN
    RAISE EXCEPTION 'Ingredient name, unit, reorder level or cost is invalid.';
  END IF;

  IF p_ingredient_id IS NULL THEN
    INSERT INTO public.inventory_ingredients(
      restaurant_id,name,category,base_unit,reorder_level,cost_per_unit,cost_is_estimate,cost_source_note
    ) VALUES (
      v_restaurant_id,v_name,v_category,v_unit,v_reorder,v_cost,(v_cost IS NOT NULL AND NOT v_confirm_cost),
      CASE WHEN v_cost IS NULL THEN 'Cost not entered'
           WHEN v_confirm_cost THEN 'Confirmed by Admin against a supplier invoice'
           ELSE 'Entered by Admin; estimate until verified against a supplier invoice' END
    ) RETURNING id,to_jsonb(inventory_ingredients) INTO v_id,v_record;
  ELSE
    SELECT i.cost_per_unit,i.cost_is_estimate,i.cost_source_note
    INTO v_old_cost,v_old_is_estimate,v_old_source_note
    FROM public.inventory_ingredients i
    WHERE i.id=p_ingredient_id AND i.restaurant_id=v_restaurant_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingredient not found in this restaurant.'; END IF;

    UPDATE public.inventory_ingredients
    SET name=v_name,category=v_category,base_unit=v_unit,reorder_level=v_reorder,cost_per_unit=v_cost,
        cost_is_estimate=CASE
          WHEN v_cost IS NULL THEN false
          WHEN v_confirm_cost THEN false
          WHEN v_cost IS DISTINCT FROM v_old_cost THEN true
          ELSE COALESCE(v_old_is_estimate,false)
        END,
        cost_source_note=CASE
          WHEN v_cost IS NULL THEN 'Cost not entered'
          WHEN v_confirm_cost THEN 'Confirmed by Admin against a supplier invoice'
          WHEN v_cost IS DISTINCT FROM v_old_cost THEN 'Changed by Admin; estimate until verified against a supplier invoice'
          ELSE COALESCE(v_old_source_note,'')
        END,
        updated_at=now()
    WHERE id=p_ingredient_id AND restaurant_id=v_restaurant_id
    RETURNING id,to_jsonb(inventory_ingredients) INTO v_id,v_record;
  END IF;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,'inventory_ingredient_saved','inventory_ingredients',v_id::text,NULL,NULL,v_record,
    jsonb_build_object('cost_is_estimate',COALESCE((v_record->>'cost_is_estimate')::boolean,false),'cost_confirmed',v_confirm_cost)
  );
  RETURN jsonb_build_object('ok',true,'ingredient',v_record);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_save_ingredient(text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_ingredient(text,uuid,jsonb) TO authenticated;


CREATE OR REPLACE FUNCTION public.admin_set_product_recipe(p_panel_token text,p_product_id uuid,p_recipe jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
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
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token,ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.products p WHERE p.id=p_product_id AND p.restaurant_id=v_restaurant_id) THEN
    RAISE EXCEPTION 'Product not found in this restaurant.';
  END IF;
  IF p_recipe IS NULL OR jsonb_typeof(p_recipe)<>'array' THEN RAISE EXCEPTION 'Recipe must be an array.'; END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_recipe) LOOP
    v_ingredient_id:=NULLIF(v_row->>'ingredient_id','')::uuid;
    v_qty:=NULLIF(v_row->>'quantity_per_serving','')::numeric;
    IF v_ingredient_id IS NULL OR v_qty IS NULL OR v_qty<=0 OR NOT EXISTS(
      SELECT 1 FROM public.inventory_ingredients i
      WHERE i.id=v_ingredient_id AND i.restaurant_id=v_restaurant_id AND i.is_active
    ) THEN
      RAISE EXCEPTION 'Every recipe row must reference an active ingredient in this restaurant and a positive quantity.';
    END IF;
    v_count:=v_count+1;
  END LOOP;

  DELETE FROM public.product_recipes WHERE product_id=p_product_id AND restaurant_id=v_restaurant_id;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_recipe) LOOP
    v_estimate:=COALESCE((v_row->>'is_estimate')::boolean,false);
    v_source_note:=COALESCE(NULLIF(v_row->>'source_note',''),
      CASE WHEN v_estimate THEN 'Estimated starter recipe; review against actual kitchen quantities.' ELSE 'Reviewed by Admin.' END);
    INSERT INTO public.product_recipes(
      restaurant_id,product_id,ingredient_id,quantity_per_serving,is_estimate,source_note
    ) VALUES (
      v_restaurant_id,p_product_id,(v_row->>'ingredient_id')::uuid,
      (v_row->>'quantity_per_serving')::numeric,v_estimate,v_source_note
    );
    IF v_estimate THEN v_estimated_count:=v_estimated_count+1; END IF;
  END LOOP;

  PERFORM public._tableforge_audit_event(
    v_restaurant_id,'product_recipe_saved','product_recipes',p_product_id::text,NULL,NULL,
    jsonb_build_object('ingredient_count',v_count,'estimated_ingredient_count',v_estimated_count),
    jsonb_build_object('recipe_estimated',v_estimated_count>0)
  );
  RETURN jsonb_build_object('ok',true,'product_id',p_product_id,'ingredient_count',v_count,
    'estimated_ingredient_count',v_estimated_count,'is_estimate',v_estimated_count>0);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_set_product_recipe(text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_product_recipe(text,uuid,jsonb) TO authenticated;


-- Strict inventory is opt-in and must not consume provisional recipe estimates.
-- Enabling strict mode is rejected until every active product has a fully reviewed recipe.
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



-- Ensure direct database updates cannot consume stock against estimated recipes.
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
    IF EXISTS (
      SELECT 1 FROM public.product_recipes r
      WHERE r.product_id=NEW.product_id AND r.restaurant_id=NEW.restaurant_id AND r.is_estimate
    ) THEN
      RAISE EXCEPTION 'This dish still has estimated recipe quantities. An Admin must verify the recipe before strict-inventory preparation can start.';
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
REVOKE ALL ON FUNCTION public._tableforge_consume_recipe_on_served() FROM PUBLIC, anon, authenticated;

-- Seed estimated INR procurement costs. These are NOT verified supplier quotes.
-- Preserve any existing ingredient/cost record with the same normalized name.
WITH target AS (
  SELECT id AS restaurant_id FROM public.restaurants WHERE slug='four-flavours'
), seed(name,category,base_unit,cost_per_unit,reorder_level) AS (VALUES
  ('Onion','Vegetables','g',0.0400,1000),('Tomatoes','Vegetables','g',0.0400,1000),('Garlic','Vegetables','g',0.1800,250),
  ('Cabbage','Vegetables','g',0.0550,700),('Carrot','Vegetables','g',0.0600,500),('Spinach','Leafy greens','g',0.0800,300),
  ('Ginger','Vegetables','g',0.1200,250),('Ginger Garlic Paste','Prepared ingredients','g',0.1000,500),('Green Chillies','Vegetables','g',0.1000,100),
  ('Capsicum','Vegetables','g',0.0900,500),('Cucumber','Vegetables','g',0.0450,500),('Lettuce','Vegetables','g',0.1500,300),('Lemon Juice','Prepared ingredients','ml',0.1000,200),
  ('Coriander Leaves','Herbs','g',0.1200,150),('Mint Leaves','Herbs','g',0.1200,100),('Spring Onion','Vegetables','g',0.1100,250),('Potatoes','Vegetables','g',0.0350,1000),
  ('Mixed Vegetables','Vegetables','g',0.0750,1000),('Mushrooms','Vegetables','g',0.2000,500),('Paneer','Dairy','g',0.3400,1000),('Soya Chaap','Plant protein','g',0.1600,1000),
  ('Sweet Corn','Vegetables','g',0.1200,500),('Broccoli','Vegetables','g',0.1600,500),('Green Peas','Vegetables','g',0.1100,500),('Chickpeas','Pulses','g',0.1000,500),
  ('Mixed Lentils','Pulses','g',0.1050,500),('Wheat Flour','Grains and flour','g',0.0450,1000),('Refined Flour','Grains and flour','g',0.0450,1000),('Gram Flour','Grains and flour','g',0.0800,500),
  ('Basmati Rice','Grains','g',0.1100,1000),('Hakka Noodles','Grains','g',0.0750,1000),('Pasta','Grains','g',0.1200,500),('Tortillas','Bakery','pcs',12.0000,20),
  ('Tortilla Chips','Prepared ingredients','g',0.2200,300),('Spring Roll Wrapper','Prepared ingredients','pcs',3.0000,30),('Papad','Prepared ingredients','pcs',5.0000,50),
  ('Pizza Dough','Bakery','g',0.0800,1000),('Pizza Sauce','Sauces','g',0.1000,500),('Tomato Sauce','Sauces','g',0.1000,500),('Salsa','Sauces','g',0.1400,300),
  ('Mixed Berry Crush','Fruit preparations','ml',0.1800,250),('Strawberry Crush','Fruit preparations','ml',0.1600,250),('Mango Pulp','Fruit preparations','g',0.1200,500),
  ('Guava Pulp','Fruit preparations','g',0.1300,300),('Pineapple Pulp','Fruit preparations','g',0.1200,300),('Banana','Fruit','g',0.0650,500),('Cocoa Powder','Baking','g',0.3000,200),
  ('Brownie Base','Baking','g',0.2000,500),('Gulab Jamun Base','Sweets','g',0.2200,500),('Ice Cream Mix','Dairy / frozen','g',0.2100,1000),
  ('Moong Dal','Pulses','g',0.1250,500),('Semolina','Grains and flour','g',0.0600,500),('Milk','Dairy','ml',0.0750,2000),('Curd','Dairy','g',0.0750,1000),
  ('Cream','Dairy','ml',0.2700,500),('Butter','Dairy','g',0.5500,500),('Ghee','Dairy','g',0.6500,250),('Mozzarella Cheese','Dairy','g',0.4200,500),('Cheddar Cheese','Dairy','g',0.4200,500),
  ('Cooking Oil','Oils and fats','ml',0.1500,2000),('Olive Oil','Oils and fats','ml',0.6500,250),('Salt','Seasoning','g',0.0120,500),('Black Pepper','Spices','g',0.6500,100),
  ('Cumin Seeds','Spices','g',0.3000,100),('Turmeric Powder','Spices','g',0.2200,100),('Indian Curry Spice Mix','Spices','g',0.3000,200),('Tandoori Masala','Spices','g',0.3500,200),
  ('Biryani Masala','Spices','g',0.4000,150),('Coriander Powder','Spices','g',0.2200,200),('Garam Masala','Spices','g',0.4000,100),('Chaat Masala','Spices','g',0.3000,150),('Cornflour','Grains and flour','g',0.0600,300),
  ('Soy Sauce','Sauces','ml',0.1800,250),('Chilli Sauce','Sauces','ml',0.2000,250),('Vinegar','Condiments','ml',0.0800,250),('Sugar','Pantry','g',0.0450,500),('Sugar Syrup','Beverage ingredients','ml',0.0900,500),
  ('Chocolate Syrup','Beverage ingredients','ml',0.1800,250),('Coffee Powder','Beverages','g',0.5500,100),('Tea Leaves','Beverages','g',0.3000,100),('Flavour Syrup','Beverage ingredients','ml',0.1600,250),
  ('Water','Utilities','ml',0.0010,5000),('Soda Water','Beverages','ml',0.0250,1000),('Ice','Utilities','g',0.0100,1000),('Cardamom','Spices','g',1.2000,30),
  ('Cashews','Nuts','g',0.8500,150),('Almonds','Nuts','g',0.9000,150),('Coconut Milk','Dairy alternatives','ml',0.1800,250),('Chocolate Hazelnut Spread','Prepared ingredients','g',0.5000,200),
  ('Biscuit Crumb','Prepared ingredients','g',0.2400,200),('Mint Syrup','Beverage ingredients','ml',0.1800,250),('Caramel Syrup','Beverage ingredients','ml',0.1800,250),('Blue Curacao Syrup','Beverage ingredients','ml',0.2200,250),
  ('Betel Flavour Mix','Beverage ingredients','g',0.6000,50),('Sizzler Sauce','Sauces','g',0.1800,300),('Pesto Sauce','Sauces','g',0.2800,200),('Oregano','Spices','g',0.4500,50),('Chilli Flakes','Spices','g',0.2500,50),
  ('Bread','Bakery','pcs',8.0000,20),('Vegetable Seekh Kebab Base','Prepared ingredients','pcs',18.0000,30),('Packaged Mineral Water','Beverages','pcs',10.0000,24),('Tea Masala','Spices','g',0.5000,50),('Mango Syrup','Beverage ingredients','ml',0.1500,250),('Strawberry Syrup','Beverage ingredients','ml',0.1500,250),
  ('Ketchup','Sauces','g',0.1000,300),('Coriander-Mint Chutney','Sauces','g',0.1300,250),('Lemon','Fruit','pcs',4.0000,30),('Yogurt Marinade','Prepared ingredients','g',0.1000,500)
)
INSERT INTO public.inventory_ingredients(restaurant_id,name,category,base_unit,reorder_level,cost_per_unit,cost_is_estimate,cost_source_note)
SELECT t.restaurant_id,s.name,s.category,s.base_unit,s.reorder_level,s.cost_per_unit,true,
       'Planning estimate in INR per base unit; replace with actual supplier invoice cost.'
FROM target t CROSS JOIN seed s
WHERE NOT EXISTS (
  SELECT 1 FROM public.inventory_ingredients i
  WHERE i.restaurant_id=t.restaurant_id AND lower(i.name)=lower(s.name)
);

-- Attach a starter recipe to every active Four Flavours product that has no
-- recipe at all. Existing curated recipes are left untouched. Quantities are
-- per saleable serving, estimates for kitchen review, not certified production cards.
WITH target AS (
  SELECT id AS restaurant_id FROM public.restaurants WHERE slug='four-flavours'
), menu_products AS (
  SELECT p.id AS product_id,p.restaurant_id,p.name,p.category,
    CASE
      WHEN p.category ILIKE '%papad%' OR p.name ILIKE '%papad%' THEN 'papad'
      WHEN p.name ILIKE 'Ice Cream' THEN 'ice_cream'
      WHEN p.category ILIKE '%dessert%' OR p.name ILIKE '%kheer%' OR p.name ILIKE '%halva%' OR p.name ILIKE '%halwa%' OR p.name ILIKE '%gulab jamun%' OR p.name ILIKE '%brownie%' THEN 'dessert'
      WHEN p.category ILIKE '%shake%' OR p.category ILIKE '%frappe%' OR p.name ILIKE '%cold coffee%' THEN 'shake'
      WHEN p.category ILIKE '%mocktail%' OR p.category ILIKE '%cooler%' OR p.category ILIKE '%iced tea%' THEN 'mocktail'
      WHEN p.category ILIKE '%tea & coffee%' OR p.name ILIKE '%special tea%' OR p.name ILIKE '%hot coffee%' THEN 'tea_coffee'
      WHEN p.category ILIKE '%traditional drinks%' OR p.name ILIKE '%buttermilk%' OR p.name ILIKE '%lassi%' THEN 'traditional_drink'
      WHEN p.category ILIKE '%soft drinks%' OR p.category ILIKE '%water%' OR p.name ILIKE '%mineral water%' THEN 'soft_drink'
      WHEN p.category ILIKE '%soup%' THEN 'soup'
      WHEN p.category ILIKE '%salad%' THEN 'salad'
      WHEN p.category ILIKE '%dal & lentils%' OR p.name ILIKE '%dal %' OR p.name ILIKE 'dal%' THEN 'dal'
      WHEN p.category ILIKE '%breads%' OR p.name ILIKE '%naan%' OR p.name ILIKE '%roti%' OR p.name ILIKE '%chapatti%' OR p.name ILIKE '%kulcha%' OR p.name ILIKE '%paratha%' THEN 'bread'
      WHEN p.category ILIKE '%noodles & rice%' AND p.name ILIKE '%noodle%' THEN 'noodles'
      WHEN p.category ILIKE '%noodles & rice%' THEN 'chinese_rice'
      WHEN p.category ILIKE '%rice & biryani%' OR p.name ILIKE '%biryani%' THEN 'rice'
      WHEN p.category ILIKE '%pasta%' THEN 'pasta'
      WHEN p.category ILIKE '%pizza%' THEN 'pizza'
      WHEN p.category ILIKE '%baked dishes%' THEN 'baked'
      WHEN p.category ILIKE '%sizzler%' THEN 'sizzler'
      WHEN p.category ILIKE '%platter%' THEN 'platter'
      WHEN p.category ILIKE '%quick bites%' THEN 'quick'
      WHEN p.category ILIKE '%mexican%' AND p.category ILIKE '%mains%' THEN 'mexican_main'
      WHEN p.category ILIKE '%mexican%' THEN 'mexican_starter'
      WHEN p.category ILIKE '%chinese%' AND p.category ILIKE '%starters%' THEN 'chinese_starter'
      WHEN p.category ILIKE '%main course%' THEN 'indian_curry'
      WHEN p.category ILIKE '%starters%' OR p.category ILIKE '%tandoor%' THEN 'indian_starter'
      ELSE 'indian_starter'
    END AS profile
  FROM public.products p JOIN target t ON t.restaurant_id=p.restaurant_id
  WHERE p.is_active=true
    AND NOT EXISTS (SELECT 1 FROM public.product_recipes r WHERE r.product_id=p.id AND r.restaurant_id=p.restaurant_id)
), profile_components(profile,ingredient_name,qty) AS (VALUES
  ('soup','Water',250),('soup','Onion',25),('soup','Garlic',3),('soup','Cooking Oil',5),('soup','Salt',2),('soup','Black Pepper',0.25),('soup','Cornflour',6),
  ('salad','Cucumber',35),('salad','Tomatoes',35),('salad','Onion',15),('salad','Lettuce',25),('salad','Lemon Juice',8),('salad','Salt',1),('salad','Olive Oil',5),
  ('papad','Papad',1),('papad','Cooking Oil',3),('papad','Chaat Masala',2),('papad','Lemon Juice',3),
  ('indian_starter','Cooking Oil',12),('indian_starter','Curd',40),('indian_starter','Ginger Garlic Paste',8),('indian_starter','Tandoori Masala',5),('indian_starter','Lemon Juice',5),('indian_starter','Salt',3),('indian_starter','Onion',25),('indian_starter','Capsicum',25),
  ('chinese_starter','Cooking Oil',15),('chinese_starter','Garlic',6),('chinese_starter','Soy Sauce',10),('chinese_starter','Chilli Sauce',8),('chinese_starter','Cornflour',12),('chinese_starter','Spring Onion',8),('chinese_starter','Cabbage',35),('chinese_starter','Carrot',20),('chinese_starter','Salt',2),
  ('quick','Cooking Oil',10),('quick','Salt',2),('quick','Black Pepper',0.25),
  ('dal','Mixed Lentils',100),('dal','Water',250),('dal','Cooking Oil',10),('dal','Onion',20),('dal','Tomatoes',25),('dal','Garlic',4),('dal','Cumin Seeds',1.5),('dal','Turmeric Powder',1),('dal','Salt',3),('dal','Ghee',5),
  ('indian_curry','Onion',65),('indian_curry','Tomatoes',90),('indian_curry','Cooking Oil',15),('indian_curry','Ginger Garlic Paste',8),('indian_curry','Indian Curry Spice Mix',6),('indian_curry','Coriander Powder',2),('indian_curry','Turmeric Powder',1),('indian_curry','Salt',4),('indian_curry','Water',100),
  ('bread','Curd',15),('bread','Cooking Oil',4),('bread','Salt',2),
  ('rice','Basmati Rice',120),('rice','Onion',25),('rice','Cooking Oil',10),('rice','Biryani Masala',4),('rice','Coriander Leaves',3),('rice','Mint Leaves',2),('rice','Salt',3),
  ('chinese_rice','Basmati Rice',150),('chinese_rice','Mixed Vegetables',70),('chinese_rice','Cabbage',25),('chinese_rice','Carrot',20),('chinese_rice','Cooking Oil',10),('chinese_rice','Garlic',5),('chinese_rice','Soy Sauce',10),('chinese_rice','Spring Onion',8),('chinese_rice','Salt',2),
  ('noodles','Hakka Noodles',160),('noodles','Mixed Vegetables',70),('noodles','Cabbage',25),('noodles','Carrot',20),('noodles','Cooking Oil',10),('noodles','Garlic',5),('noodles','Soy Sauce',10),('noodles','Chilli Sauce',6),('noodles','Spring Onion',8),('noodles','Salt',2),
  ('pasta','Pasta',120),('pasta','Tomato Sauce',80),('pasta','Garlic',4),('pasta','Olive Oil',7),('pasta','Cheddar Cheese',20),('pasta','Salt',2),('pasta','Black Pepper',0.2),
  ('pizza','Pizza Dough',180),('pizza','Pizza Sauce',45),('pizza','Mozzarella Cheese',55),('pizza','Onion',20),('pizza','Capsicum',20),('pizza','Oregano',1),('pizza','Olive Oil',3),
  ('baked','Mixed Vegetables',140),('baked','Cream',45),('baked','Butter',10),('baked','Cheddar Cheese',35),('baked','Salt',2),('baked','Black Pepper',0.25),
  ('sizzler','Basmati Rice',100),('sizzler','Mixed Vegetables',100),('sizzler','Onion',20),('sizzler','Sizzler Sauce',35),('sizzler','Cooking Oil',12),('sizzler','Salt',3),
  ('platter','Onion',25),('platter','Capsicum',25),('platter','Curd',25),('platter','Ginger Garlic Paste',6),('platter','Tandoori Masala',4),('platter','Cooking Oil',10),('platter','Salt',2),
  ('mexican_main','Tortillas',2),('mexican_main','Black Pepper',0.2),('mexican_main','Sweet Corn',45),('mexican_main','Salsa',50),('mexican_main','Mozzarella Cheese',30),('mexican_main','Lettuce',20),('mexican_main','Cooking Oil',5),
  ('mexican_starter','Tortilla Chips',80),('mexican_starter','Salsa',40),('mexican_starter','Cheddar Cheese',25),('mexican_starter','Sweet Corn',25),('mexican_starter','Salt',1),
  ('dessert','Milk',80),('dessert','Sugar',25),('dessert','Ghee',8),('dessert','Cardamom',0.2),
  ('shake','Milk',220),('shake','Ice Cream Mix',70),('shake','Sugar',15),('shake','Ice',80),('shake','Flavour Syrup',25),
  ('mocktail','Water',150),('mocktail','Soda Water',100),('mocktail','Ice',100),('mocktail','Sugar Syrup',25),('mocktail','Lemon Juice',10),('mocktail','Mint Leaves',4),
  ('tea_coffee','Water',120),('tea_coffee','Milk',80),('tea_coffee','Sugar',8),
  ('traditional_drink','Water',80),('traditional_drink','Curd',150),('traditional_drink','Cumin Seeds',0.8),('traditional_drink','Salt',1.5),
  ('soft_drink','Packaged Mineral Water',1)
), primary_components AS (
  SELECT m.product_id,
    CASE
      WHEN m.name ILIKE '%gulab jamun%' THEN 'Gulab Jamun Base'
      WHEN m.name ILIKE '%mungdal%' OR m.name ILIKE '%moong dal%' THEN 'Moong Dal'
      WHEN m.name ILIKE '%suji halva%' OR m.name ILIKE '%suji halwa%' THEN 'Semolina'
      WHEN m.name ILIKE '%kheer%' THEN 'Basmati Rice'
      WHEN m.name ILIKE '%brownie%' THEN 'Brownie Base'
      WHEN m.name ILIKE '%paneer%' THEN 'Paneer'
      WHEN m.name ILIKE '%chaap%' THEN 'Soya Chaap'
      WHEN m.name ILIKE '%mushroom%' THEN 'Mushrooms'
      WHEN m.name ILIKE '%broccoli%' THEN 'Broccoli'
      WHEN m.name ILIKE '%hara bhara%' THEN 'Spinach'
      WHEN m.name ILIKE '%corn%' THEN 'Sweet Corn'
      WHEN m.name ILIKE '%dal %' OR m.name ILIKE 'dal%' THEN 'Mixed Lentils'
      WHEN m.name ILIKE '%chole%' OR m.name ILIKE '%chickpea%' THEN 'Chickpeas'
      WHEN m.name ILIKE '%matar%' OR m.name ILIKE '%peas%' THEN 'Green Peas'
      WHEN m.name ILIKE '%potato%' OR m.name ILIKE '%aloo%' OR m.name ILIKE '%fries%' THEN 'Potatoes'
      WHEN m.name ILIKE '%biryani%' OR m.name ILIKE '%fried rice%' OR m.name ILIKE '%steamed rice%' OR m.name ILIKE '%jeera rice%' THEN 'Basmati Rice'
      WHEN m.name ILIKE '%noodle%' THEN 'Hakka Noodles'
      WHEN m.name ILIKE '%pasta%' OR m.name ILIKE '%spaghetti%' OR m.name ILIKE '%lasagna%' OR m.name ILIKE '%mac and cheese%' THEN 'Pasta'
      WHEN m.name ILIKE '%pizza%' THEN 'Pizza Dough'
      WHEN m.name ILIKE '%papad%' THEN 'Papad'
      WHEN m.name ILIKE '%spring roll%' THEN 'Spring Roll Wrapper'
      WHEN m.name ILIKE '%nachos%' THEN 'Tortilla Chips'
      WHEN m.name ILIKE '%quesadilla%' OR m.name ILIKE '%burrito%' THEN 'Tortillas'
      WHEN m.name ILIKE '%bruschetta%' OR m.name ILIKE '%garlic bread%' OR m.name ILIKE '%bun%' THEN 'Bread'
      WHEN m.name ILIKE '%ice cream%' THEN 'Ice Cream Mix'
      WHEN m.name ILIKE '%lotus biscoff%' OR m.name ILIKE '%cookie%' OR m.name ILIKE '%oreo%' THEN 'Biscuit Crumb'
      WHEN m.name ILIKE '%ferrero%' OR m.name ILIKE '%nutella%' THEN 'Chocolate Hazelnut Spread'
      WHEN m.name ILIKE '%mango%' OR m.name ILIKE '%king of fruits%' THEN 'Mango Pulp'
      WHEN m.name ILIKE '%strawberry%' THEN 'Strawberry Crush'
      WHEN m.name ILIKE '%guava%' THEN 'Guava Pulp'
      WHEN m.name ILIKE '%pina colada%' THEN 'Pineapple Pulp'
      WHEN m.name ILIKE '%coffee%' OR m.name ILIKE '%frappe%' THEN 'Coffee Powder'
      WHEN m.name ILIKE '%tea%' OR m.name ILIKE '%iced tea%' THEN 'Tea Leaves'
      WHEN m.name ILIKE '%tortilla%' THEN 'Tortillas'
      ELSE CASE m.profile
        WHEN 'soup' THEN 'Mixed Vegetables'
        WHEN 'salad' THEN 'Cucumber'
        WHEN 'papad' THEN 'Papad'
        WHEN 'bread' THEN CASE WHEN m.name ILIKE '%roti%' OR m.name ILIKE '%chapatti%' THEN 'Wheat Flour' ELSE 'Refined Flour' END
        WHEN 'dal' THEN 'Mixed Lentils'
        WHEN 'rice' THEN 'Basmati Rice'
        WHEN 'chinese_rice' THEN 'Basmati Rice'
        WHEN 'noodles' THEN 'Hakka Noodles'
        WHEN 'pasta' THEN 'Pasta'
        WHEN 'pizza' THEN 'Pizza Dough'
        WHEN 'dessert' THEN 'Gulab Jamun Base'
        WHEN 'shake' THEN 'Ice Cream Mix'
        WHEN 'mocktail' THEN 'Lemon Juice'
        WHEN 'tea_coffee' THEN CASE WHEN m.name ILIKE '%coffee%' THEN 'Coffee Powder' ELSE 'Tea Leaves' END
        WHEN 'traditional_drink' THEN 'Curd'
        WHEN 'soft_drink' THEN 'Packaged Mineral Water'
        WHEN 'mexican_main' THEN 'Tortillas'
        WHEN 'mexican_starter' THEN 'Tortilla Chips'
        WHEN 'sizzler' THEN 'Mixed Vegetables'
        WHEN 'platter' THEN 'Mixed Vegetables'
        WHEN 'quick' THEN 'Mixed Vegetables'
        WHEN 'indian_curry' THEN 'Mixed Vegetables'
        ELSE 'Mixed Vegetables'
      END
    END AS ingredient_name,
    CASE
      WHEN m.name ILIKE '%bruschetta%' OR m.name ILIKE '%garlic bread%' OR m.name ILIKE '%masala garlic bun%' THEN 2
      WHEN m.name ILIKE '%quesadilla%' OR m.name ILIKE '%burrito%' THEN 2
      WHEN m.name ILIKE '%spring roll%' THEN 4
      WHEN m.name ILIKE '%papad%' OR m.name ILIKE '%mineral water%' THEN 1
      WHEN m.profile='bread' THEN 100
      WHEN m.profile IN ('soup','salad') THEN 70
      WHEN m.profile IN ('rice','chinese_rice') THEN 100
      WHEN m.profile='noodles' THEN 100
      WHEN m.profile='pasta' THEN 80
      WHEN m.profile='pizza' THEN 40
      WHEN m.profile IN ('indian_curry','dal') THEN 150
      WHEN m.profile IN ('indian_starter','chinese_starter','platter','sizzler','quick','mexican_main','mexican_starter') THEN 100
      WHEN m.profile='papad' THEN 1
      WHEN m.profile='dessert' THEN 70
      WHEN m.profile='shake' THEN 25
      WHEN m.profile='mocktail' THEN 20
      WHEN m.profile='tea_coffee' THEN 2.5
      WHEN m.profile='traditional_drink' THEN 100
      WHEN m.profile='soft_drink' THEN 1
      WHEN m.profile='ice_cream' THEN 100
      ELSE 80
    END::numeric AS qty
  FROM menu_products m
), special_lines AS (
  SELECT m.product_id,'Cream'::text AS ingredient_name,30::numeric AS qty FROM menu_products m
   WHERE m.name ILIKE '%malai%' OR m.name ILIKE '%butter masala%' OR m.name ILIKE '%shahi%' OR m.name ILIKE '%alfredo%'
  UNION ALL
  SELECT m.product_id,'Cashews',15 FROM menu_products m WHERE m.name ILIKE '%kaju%' OR m.name ILIKE '%shahi%' OR m.name ILIKE '%royal%'
  UNION ALL
  SELECT m.product_id,'Cheddar Cheese',25 FROM menu_products m WHERE m.name ILIKE '%cheese%' OR m.name ILIKE '%mac and cheese%' OR m.name ILIKE '%lasagna%'
  UNION ALL
  SELECT m.product_id,'Chocolate Syrup',25 FROM menu_products m WHERE m.profile IN ('shake','dessert') AND (m.name ILIKE '%chocolate%' OR m.name ILIKE '%choco%' OR m.name ILIKE '%brownie%' OR m.name ILIKE '%oreo%')
  UNION ALL
  SELECT m.product_id,'Mango Pulp',40 FROM menu_products m WHERE m.profile IN ('shake','mocktail') AND (m.name ILIKE '%mango%' OR m.name ILIKE '%king of fruits%')
  UNION ALL
  SELECT m.product_id,'Strawberry Crush',25 FROM menu_products m WHERE m.profile IN ('shake','mocktail') AND m.name ILIKE '%strawberry%'
  UNION ALL
  SELECT m.product_id,'Mint Syrup',10 FROM menu_products m WHERE m.profile IN ('shake','mocktail') AND m.name ILIKE '%mint%'
  UNION ALL
  SELECT m.product_id,'Biscuit Crumb',20 FROM menu_products m WHERE m.profile='shake' AND (m.name ILIKE '%biscoff%' OR m.name ILIKE '%cookie%' OR m.name ILIKE '%oreo%')
  UNION ALL
  SELECT m.product_id,'Chocolate Hazelnut Spread',20 FROM menu_products m WHERE m.profile='shake' AND (m.name ILIKE '%nutella%' OR m.name ILIKE '%ferrero%')
  UNION ALL
  SELECT m.product_id,'Pineapple Pulp',35 FROM menu_products m WHERE m.profile IN ('shake','mocktail') AND m.name ILIKE '%pina colada%'
  UNION ALL
  SELECT m.product_id,'Guava Pulp',40 FROM menu_products m WHERE m.profile IN ('shake','mocktail') AND m.name ILIKE '%guava%'
  UNION ALL
  SELECT m.product_id,'Blue Curacao Syrup',20 FROM menu_products m WHERE m.profile='mocktail' AND (m.name ILIKE '%blue lagoon%' OR m.name ILIKE '%blue sky%')
  UNION ALL
  SELECT m.product_id,'Ghee',12 FROM menu_products m WHERE m.name ILIKE '%halva%' OR m.name ILIKE '%halwa%'
  UNION ALL
  SELECT m.product_id,'Cardamom',0.2 FROM menu_products m WHERE m.name ILIKE '%kheer%' OR m.name ILIKE '%halva%' OR m.name ILIKE '%halwa%' OR m.name ILIKE '%gulab jamun%'
  UNION ALL
  SELECT m.product_id,'Ice Cream Mix',60 FROM menu_products m
    WHERE m.name ILIKE '%with ice cream%' OR m.name ILIKE '%with ice-cream%'
  UNION ALL
  SELECT m.product_id,'Butter',12 FROM menu_products m
    WHERE m.name ILIKE '%butter naan%' OR m.name ILIKE '%butter chapatti%' OR m.name ILIKE '%butter tandoori roti%' OR m.name ILIKE '%dal makhani%' OR m.name ILIKE '%butter masala%'
  UNION ALL
  SELECT m.product_id,'Cream',25 FROM menu_products m WHERE m.name ILIKE '%dal makhani%'
  UNION ALL
  SELECT m.product_id,'Soya Chaap',40 FROM menu_products m
    WHERE m.name ILIKE '%paneer%chaap%' OR m.name ILIKE '%chaap%paneer%' OR (m.name ILIKE '%sizzler%' AND m.name ILIKE '%chaap%')
  UNION ALL
  SELECT m.product_id,'Vegetable Seekh Kebab Base',2 FROM menu_products m WHERE m.name ILIKE '%seekh%'
  UNION ALL
  SELECT m.product_id,'Green Peas',25 FROM menu_products m WHERE m.name ILIKE '%hara bhara kebab%'
  UNION ALL
  SELECT m.product_id,'Potatoes',25 FROM menu_products m WHERE m.name ILIKE '%hara bhara kebab%'
  UNION ALL
  SELECT m.product_id,'Coffee Powder',4 FROM menu_products m
    WHERE (m.name ILIKE '%coffee%' OR m.name ILIKE '%frappe%') AND m.profile IN ('shake','mocktail','tea_coffee')
  UNION ALL
  SELECT m.product_id,'Papad',1 FROM menu_products m WHERE m.name ILIKE '%biryani sizzler%'
  UNION ALL
  SELECT m.product_id,'Cashews',12 FROM menu_products m WHERE m.name ILIKE '%biryani sizzler%'
  UNION ALL
  SELECT m.product_id,'Refined Flour',80 FROM menu_products m WHERE m.name ILIKE '%biryani sizzler%'
  UNION ALL
  SELECT m.product_id,'Butter',10 FROM menu_products m WHERE m.name ILIKE '%biryani sizzler%'
  UNION ALL
  SELECT m.product_id,'Sugar',15 FROM menu_products m WHERE m.name ILIKE '%lassi%'
  UNION ALL
  SELECT m.product_id,'Gram Flour',50 FROM menu_products m WHERE m.name ILIKE '%missi roti%'
  UNION ALL
  SELECT m.product_id,'Curd',70 FROM menu_products m WHERE m.name ILIKE '%kadhi%'
  UNION ALL
  SELECT m.product_id,'Gram Flour',25 FROM menu_products m WHERE m.name ILIKE '%kadhi%'
  UNION ALL
  SELECT m.product_id,'Green Peas',35 FROM menu_products m WHERE m.name ILIKE '%matar mushroom%' OR m.name ILIKE '%mutter mushroom%'
  UNION ALL
  SELECT m.product_id,'Cream',25 FROM menu_products m WHERE m.name ILIKE '%dal bukhara%'
  UNION ALL
  SELECT m.product_id,'Butter',12 FROM menu_products m WHERE m.name ILIKE '%dal bukhara%'
), recipe_lines AS (
  SELECT m.product_id,c.ingredient_name,c.qty
  FROM menu_products m JOIN profile_components c ON c.profile=m.profile
  UNION ALL
  SELECT pc.product_id,pc.ingredient_name,pc.qty
  FROM primary_components pc
  WHERE NOT EXISTS (
    SELECT 1 FROM menu_products m JOIN profile_components c ON c.profile=m.profile
    WHERE m.product_id=pc.product_id AND lower(c.ingredient_name)=lower(pc.ingredient_name)
  )
  UNION ALL
  SELECT product_id,ingredient_name,qty FROM special_lines
), resolved AS (
  SELECT rl.product_id, i.id AS ingredient_id, sum(rl.qty)::numeric(14,4) AS qty
  FROM recipe_lines rl
  JOIN menu_products m ON m.product_id=rl.product_id
  JOIN public.inventory_ingredients i ON i.restaurant_id=m.restaurant_id AND lower(i.name)=lower(rl.ingredient_name) AND i.is_active
  GROUP BY rl.product_id,i.id
)
INSERT INTO public.product_recipes(restaurant_id,product_id,ingredient_id,quantity_per_serving,is_estimate,source_note)
SELECT m.restaurant_id,r.product_id,r.ingredient_id,r.qty,true,
       'Estimated starter recipe based on menu name/category. Confirm ingredients and quantities with the kitchen before relying on stock or food-cost results.'
FROM resolved r JOIN menu_products m ON m.product_id=r.product_id
WHERE r.qty>0
ON CONFLICT (product_id,ingredient_id) DO NOTHING;

-- The seed does not create opening stock or fictional stock receipts. Stock remains
-- zero until Admin records an opening balance and subsequent received/waste movements.
-- It also does not enable strict inventory mode automatically.

NOTIFY pgrst, 'reload schema';
COMMIT;
