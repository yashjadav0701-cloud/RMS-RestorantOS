-- Read-only verification for the always-calculate Ingredient Usage patch.
-- Run after INGREDIENT_USAGE_ALWAYS_CALCULATE_PATCH.sql.

SELECT
  to_regprocedure('public.get_inventory_usage_report(text,text)') IS NOT NULL AS usage_report_rpc_exists,
  to_regprocedure('public._tableforge_consume_recipe_on_served()') IS NOT NULL AS preparing_trigger_function_exists,
  to_regprocedure('public.admin_cancel_order_item(uuid,jsonb,text,text)') IS NOT NULL AS admin_cancel_rpc_exists,
  (SELECT count(*)=1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='order_items' AND column_name='inventory_usage_calculated_at') AS usage_calculation_timestamp_column_exists,
  (SELECT count(*)=1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='order_items' AND column_name='inventory_actual_usage_snapshot') AS actual_usage_snapshot_column_exists,
  EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='order_items'
      AND t.tgname='trg_tableforge_consume_recipe_on_served'
      AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
  ) AS preparing_usage_trigger_enabled;

-- Restaurant-level mode remains unchanged by this patch.
SELECT r.name,coalesce(w.inventory_mode,'disabled') AS inventory_mode,
       count(i.id) FILTER (WHERE i.serving_status='preparing') AS currently_preparing_items,
       count(i.id) FILTER (WHERE i.serving_status='ready') AS currently_ready_items,
       count(i.id) FILTER (WHERE i.serving_status='served') AS served_items,
       count(i.id) FILTER (WHERE i.inventory_usage_calculated_at IS NOT NULL) AS items_with_usage_snapshot,
       count(i.id) FILTER (WHERE i.inventory_consumed_at IS NOT NULL) AS items_with_stock_deduction
FROM public.restaurants r
LEFT JOIN public.restaurant_workflow_settings w ON w.restaurant_id=r.id
LEFT JOIN public.order_items i ON i.restaurant_id=r.id
WHERE r.slug='four-flavours'
GROUP BY r.id,r.name,w.inventory_mode;

-- Preview the historical recipe rows that can/cannot be reconstructed without
-- fabricating quantities. Existing orders are not automatically backfilled.
WITH prepared AS (
  SELECT oi.id,oi.product_id,oi.name_snapshot,oi.quantity,oi.created_at,oi.restaurant_id,
         oi.inventory_recipe_snapshot,oi.inventory_usage_calculated_at
  FROM public.order_items oi
  JOIN public.restaurants r ON r.id=oi.restaurant_id
  WHERE r.slug='four-flavours' AND oi.serving_status IN ('preparing','ready','served')
), coverage AS (
  SELECT p.id,
    (p.inventory_recipe_snapshot IS NOT NULL AND jsonb_typeof(p.inventory_recipe_snapshot)='array'
      AND jsonb_array_length(p.inventory_recipe_snapshot)>0) AS has_saved_usage_snapshot,
    EXISTS (
      SELECT 1 FROM public.product_recipes pr
      WHERE pr.restaurant_id=p.restaurant_id AND pr.product_id=p.product_id
        AND pr.created_at<=p.created_at
    ) AND NOT EXISTS (
      SELECT 1 FROM public.product_recipes later
      WHERE later.restaurant_id=p.restaurant_id AND later.product_id=p.product_id
        AND later.created_at>p.created_at
    ) AS has_historical_recipe
  FROM prepared p
)
SELECT count(*) AS prepared_items,
       count(*) FILTER (WHERE has_saved_usage_snapshot) AS snapshot_calculations,
       count(*) FILTER (WHERE NOT has_saved_usage_snapshot AND has_historical_recipe) AS historically_reconstructable,
       count(*) FILTER (WHERE NOT has_saved_usage_snapshot AND NOT has_historical_recipe) AS not_backfilled_no_recipe_at_item_time
FROM coverage;
