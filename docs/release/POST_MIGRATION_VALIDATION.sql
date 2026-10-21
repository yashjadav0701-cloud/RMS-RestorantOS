-- TableForge post-migration validation (read-only; safe to run in Supabase SQL Editor).
-- Review every row. This script does not expose PINs, hashes, tokens, or payment secrets.
WITH checks AS (
  SELECT 'REQUIRED_TABLE' AS section, x.object_name,
         CASE WHEN to_regclass('public.' || x.object_name) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status,
         'Expected table exists' AS details
  FROM (VALUES
    ('panel_pin_credentials'),('panel_access_tokens'),('panel_management_tokens'),
    ('panel_pin_attempts'),('operational_requests'),('dish_cancellation_requests'),
    ('inventory_ingredients'),('inventory_movements'),('product_recipes')
  ) AS x(object_name)
  UNION ALL
  SELECT 'REQUIRED_RPC', x.object_name,
         CASE WHEN to_regprocedure(x.signature) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END,
         x.signature
  FROM (VALUES
    ('verify_panel_pin','public.verify_panel_pin(text,text)'),
    ('authorize_panel_pin_management','public.authorize_panel_pin_management(uuid,text)'),
    ('get_panel_pin_statuses','public.get_panel_pin_statuses(text)'),
    ('admin_set_panel_pin','public.admin_set_panel_pin(text,text,text)'),
    ('get_kot_queue','public.get_kot_queue(text)'),
    ('set_kot_item_status','public.set_kot_item_status(text,uuid,text)'),
    ('request_captain','public.request_captain(uuid,text)'),
    ('generate_cashier_bill','public.generate_cashier_bill(text,uuid,uuid)'),
    ('generate_takeaway_bill','public.generate_takeaway_bill(uuid,text)'),
    ('complete_takeaway_payment','public.complete_takeaway_payment(uuid,text,text)'),
    ('cancel_order_item','public.cancel_order_item(uuid,text,text)'),
    ('request_dish_cancellation','public.request_dish_cancellation(uuid,text,text)'),
    ('get_admin_cancellation_requests','public.get_admin_cancellation_requests(uuid,text)'),
    ('decide_dish_cancellation','public.decide_dish_cancellation(uuid,uuid,text,text,text)'),
    ('get_public_pos_data','public.get_public_pos_data(uuid)'),
    ('admin_mutate_resource','public.admin_mutate_resource(text,text,text,uuid,jsonb)')
  ) AS x(object_name,signature)
  UNION ALL
  SELECT 'RLS', c.relname,
         CASE WHEN c.relrowsecurity THEN 'PASS' ELSE 'FAIL' END,
         'RLS enabled on new private table'
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (
    'panel_pin_credentials','panel_access_tokens','panel_management_tokens',
    'panel_pin_attempts','operational_requests','dish_cancellation_requests',
    'inventory_ingredients','inventory_movements','product_recipes'
  )
  UNION ALL
  SELECT 'ANON_PRIVILEGE', x.object_name,
         CASE WHEN NOT has_table_privilege('anon',x.object_name,'SELECT') THEN 'PASS' ELSE 'FAIL' END,
         'Anonymous direct SELECT should be revoked'
  FROM (VALUES ('public.products'),('public.cuisines'),('public.tables'),('public.app_settings'),('public.restaurants')) x(object_name)
  UNION ALL
  SELECT 'PUBLIC_RPC', 'get_public_pos_data',
         CASE WHEN has_function_privilege('anon','public.get_public_pos_data(uuid)','EXECUTE') THEN 'PASS' ELSE 'FAIL' END,
         'Anonymous menu access must use table-scoped RPC'
  UNION ALL
  SELECT 'PIN_SALT', 'tables.pin_salt_zero_count',
         CASE WHEN count(*) FILTER (WHERE COALESCE(pin_salt,0)=0)=0 THEN 'PASS' ELSE 'FAIL' END,
         jsonb_build_object('zero_salt_tables',count(*) FILTER (WHERE COALESCE(pin_salt,0)=0))::text
  FROM public.tables
  UNION ALL
  SELECT 'TENANT_INTEGRITY', 'orders_vs_tables',
         CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,
         jsonb_build_object('mismatches',count(*))::text
  FROM public.orders o JOIN public.tables t ON t.id=o.table_id WHERE o.restaurant_id<>t.restaurant_id
  UNION ALL
  SELECT 'TENANT_INTEGRITY', 'orders_vs_sessions',
         CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,
         jsonb_build_object('mismatches',count(*))::text
  FROM public.orders o JOIN public.dining_sessions s ON s.id=o.session_id WHERE o.restaurant_id<>s.restaurant_id
  UNION ALL
  SELECT 'TENANT_INTEGRITY', 'items_vs_orders',
         CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,
         jsonb_build_object('mismatches',count(*))::text
  FROM public.order_items i JOIN public.orders o ON o.id=i.order_id WHERE i.restaurant_id<>o.restaurant_id
  UNION ALL
  SELECT 'TENANT_INTEGRITY', 'items_vs_products',
         CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,
         jsonb_build_object('mismatches',count(*))::text
  FROM public.order_items i JOIN public.products p ON p.id=i.product_id WHERE i.restaurant_id<>p.restaurant_id
  UNION ALL
  SELECT 'TENANT_INTEGRITY', 'sessions_vs_tables',
         CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,
         jsonb_build_object('mismatches',count(*))::text
  FROM public.dining_sessions s JOIN public.tables t ON t.id=s.table_id WHERE s.restaurant_id<>t.restaurant_id
  UNION ALL
  SELECT 'AUDIT_LOG', 'migration_marker',
         CASE WHEN count(*)=(SELECT count(*) FROM public.restaurants) THEN 'PASS' ELSE 'WARN' END,
         jsonb_build_object('restaurants', (SELECT count(*) FROM public.restaurants), 'markers', count(*))::text
  FROM public.security_logs WHERE event_type='master_migration_installed' AND metadata->>'version'='1'
)
SELECT section, object_name, status, details FROM checks ORDER BY
  CASE status WHEN 'FAIL' THEN 1 WHEN 'WARN' THEN 2 ELSE 3 END, section, object_name;
