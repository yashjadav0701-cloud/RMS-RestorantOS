-- Read-only post-migration audit for the unified KOT / Admin Ready workflow.
-- Run after ADMIN_KOT_READY_ALIGNMENT_PATCH.sql. No data is changed.

-- 1) Required inventory and reversible-Ready columns.
SELECT required.column_name,
       (actual.column_name IS NOT NULL) AS column_exists,
       actual.data_type
FROM (VALUES
  ('inventory_recipe_snapshot'),
  ('inventory_consumed_at'),
  ('inventory_reconciled_at'),
  ('kot_ready_previous_status'),
  ('kot_ready_at')
) AS required(column_name)
LEFT JOIN information_schema.columns actual
  ON actual.table_schema='public'
 AND actual.table_name='order_items'
 AND actual.column_name=required.column_name
ORDER BY required.column_name;

-- 2) Function definitions and expected markers/panel allow-lists.
SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       (position('inventory_consumed_at' IN pg_get_functiondef(p.oid)) > 0) AS references_inventory_consumption_marker,
       CASE WHEN p.proname IN ('set_kot_item_status','set_kot_table_ready')
            THEN position('admin' IN pg_get_functiondef(p.oid)) > 0
            ELSE NULL END AS admin_role_enabled_where_applicable,
       (position('kot_ready_previous_status' IN pg_get_functiondef(p.oid)) > 0) AS uses_ready_undo_marker,
       CASE WHEN p.proname IN ('get_kot_queue','set_kot_item_status','set_kot_table_ready')
            THEN NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            ELSE NULL END AS anon_execute_revoked_where_applicable,
       CASE WHEN p.prokind <> 'f' THEN NULL
            ELSE has_function_privilege('authenticated', p.oid, 'EXECUTE') END AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('_tableforge_consume_recipe_on_served','get_kot_queue','set_kot_item_status','set_kot_table_ready')
ORDER BY p.proname;

-- 3) Verify the installed trigger is attached to order_items and invokes the inventory trigger function.
SELECT t.tgname AS trigger_name,
       c.relname AS table_name,
       p.proname AS trigger_function,
       pg_get_triggerdef(t.oid) AS trigger_definition
FROM pg_trigger t
JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_proc p ON p.oid=t.tgfoid
WHERE n.nspname='public'
  AND c.relname='order_items'
  AND NOT t.tgisinternal
  AND p.proname='_tableforge_consume_recipe_on_served';

-- 4) Read-only status counts by restaurant. KOT-ready items are represented as
-- served + kot_ready_previous_status IS NOT NULL and should remain on open KOT queues.
SELECT r.name AS restaurant,
       COALESCE(w.inventory_mode,'disabled') AS inventory_mode,
       COUNT(oi.id) FILTER (WHERE oi.serving_status='pending') AS pending_items,
       COUNT(oi.id) FILTER (WHERE oi.serving_status='preparing') AS preparing_items,
       COUNT(oi.id) FILTER (WHERE oi.serving_status='ready') AS legacy_ready_items,
       COUNT(oi.id) FILTER (WHERE oi.serving_status='served'
                            AND oi.kot_ready_previous_status IS NOT NULL) AS reversible_kot_ready_items,
       COUNT(oi.id) FILTER (WHERE oi.serving_status='served'
                            AND oi.kot_ready_previous_status IS NULL) AS normally_served_items,
       COUNT(oi.id) FILTER (WHERE oi.serving_status='cancelled') AS cancelled_items
FROM public.restaurants r
LEFT JOIN public.restaurant_workflow_settings w ON w.restaurant_id=r.id
LEFT JOIN public.orders o ON o.restaurant_id=r.id
LEFT JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
GROUP BY r.name,w.inventory_mode
ORDER BY r.name;

-- 5) Bills already prepared must not leave unfinished dishes behind.
-- Reversible Ready markers may remain on served rows for historical/audit purposes;
-- only unfinished serving states are counted as anomalies here.
SELECT COUNT(*) AS actionable_items_on_prepared_bills
FROM public.orders o
JOIN public.order_items oi ON oi.order_id=o.id AND oi.restaurant_id=o.restaurant_id
LEFT JOIN public.dining_sessions ds ON ds.id=o.session_id AND ds.restaurant_id=o.restaurant_id
WHERE o.restaurant_id=oi.restaurant_id
  AND o.status <> 'cancelled'::public.order_status
  AND (
    (o.order_type::text='takeaway' AND o.billing_status IN ('bill_ready','closed'))
    OR (o.order_type::text='dine_in' AND ds.status IN ('bill_ready','closed'))
  )
  AND oi.serving_status IN ('pending','preparing','ready');

-- 6) Tenant integrity: must return zero.
SELECT 'order_items_restaurant_mismatch' AS check_name, COUNT(*) AS failures
FROM public.order_items oi
JOIN public.orders o ON o.id=oi.order_id
WHERE oi.restaurant_id <> o.restaurant_id
UNION ALL
SELECT 'ready_marker_without_served_status', COUNT(*)
FROM public.order_items oi
WHERE oi.kot_ready_previous_status IS NOT NULL
  AND oi.serving_status <> 'served';
