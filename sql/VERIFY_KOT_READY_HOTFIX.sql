-- Read-only verification for the KOT Ready snapshot-marker hotfix.
SELECT
  to_regprocedure('public._tableforge_consume_recipe_on_served()') IS NOT NULL AS trigger_function_exists,
  EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='order_items'
      AND t.tgname='trg_tableforge_consume_recipe_on_served' AND NOT t.tgisinternal
  ) AS preparing_trigger_exists,
  position('v_had_snapshot boolean' IN pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure))>0 AS declared_snapshot_marker_exists,
  position('v_has_snapshot' IN pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure))=0 AS stale_undeclared_marker_absent,
  position('v_mode=''strict'' AND v_had_snapshot AND NEW.inventory_consumed_at IS NULL' IN pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure))>0 AS strict_retroactive_deduction_guard_exists;

-- Operational panel authorization contract (all data-changing operations remain token-gated).
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_can_call,
       has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous_can_call
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('get_kot_queue','set_kot_item_status','set_kot_table_ready',
    'create_pos_order','get_operational_settings','get_cashier_bill_queue',
    'generate_cashier_bill','complete_session_payment','complete_takeaway_payment',
    'admin_cancel_order_item','get_inventory_dashboard','get_inventory_usage_report')
ORDER BY p.proname,pg_get_function_identity_arguments(p.oid);

-- Confirm no user order or stock data was modified by the hotfix itself.
SELECT
  (SELECT count(*) FROM public.inventory_movements m
   JOIN public.restaurants r ON r.id=m.restaurant_id WHERE r.slug='four-flavours') AS stock_movement_rows,
  (SELECT inventory_mode FROM public.restaurant_workflow_settings w
   JOIN public.restaurants r ON r.id=w.restaurant_id WHERE r.slug='four-flavours') AS inventory_mode;


-- Configured PIN credential coverage (hashes are never selected).
SELECT panel_id,count(*) AS configured_pin_credentials
FROM public.panel_pin_credentials
WHERE restaurant_id=(SELECT id FROM public.restaurants WHERE slug='four-flavours')
GROUP BY panel_id
ORDER BY panel_id;
