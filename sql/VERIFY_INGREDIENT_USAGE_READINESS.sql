-- Read-only verification for the Ingredient Usage reliability patch.
-- Run AFTER sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql.
-- This script performs SELECT statements only.

-- 1) Confirm restaurant setup status and inventory mode.
SELECT
  r.name,
  r.slug,
  public._tableforge_inventory_setup_status(r.id) AS inventory_setup
FROM public.restaurants r
WHERE r.slug = 'four-flavours';

-- 2) Confirm required RPCs and the unique sale-movement idempotency index exist.
SELECT
  to_regprocedure('public.get_inventory_setup_status(text)') IS NOT NULL AS get_inventory_setup_status_exists,
  to_regprocedure('public.set_inventory_mode(text,text)') IS NOT NULL AS set_inventory_mode_exists,
  to_regprocedure('public.get_inventory_usage_report(text,text)') IS NOT NULL AS get_inventory_usage_report_exists,
  to_regprocedure('public.admin_cancel_order_item(uuid,jsonb,text,text)') IS NOT NULL AS admin_cancel_order_item_exists,
  to_regclass('public.inventory_sale_item_ingredient_uq') IS NOT NULL AS sale_movement_idempotency_index_exists;

-- 3) Confirm the order-item trigger remains enabled and points to the guarded function.
SELECT
  t.tgname,
  t.tgenabled,
  pg_get_triggerdef(t.oid) AS trigger_definition
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'order_items'
  AND t.tgname = 'trg_tableforge_consume_recipe_on_served'
  AND NOT t.tgisinternal;

-- 4) Show all current stock movements for Four Flavours, without editing them.
SELECT
  i.name AS ingredient,
  i.base_unit,
  m.movement_type,
  m.quantity_delta,
  m.unit,
  m.reason,
  m.created_at,
  m.reference_order_id,
  m.reference_order_item_id
FROM public.inventory_movements m
JOIN public.inventory_ingredients i
  ON i.id = m.ingredient_id
 AND i.restaurant_id = m.restaurant_id
JOIN public.restaurants r ON r.id = m.restaurant_id
WHERE r.slug = 'four-flavours'
ORDER BY m.created_at, i.name;

-- 5) Count estimated recipe lines and active products that still lack a recipe.
SELECT
  count(*) FILTER (WHERE p.is_active) AS active_products,
  count(*) FILTER (WHERE p.is_active AND r.product_id IS NULL) AS active_products_missing_recipe,
  count(*) FILTER (WHERE p.is_active AND coalesce(r.is_estimate, true)) AS estimated_recipe_lines
FROM public.products p
JOIN public.restaurants restaurant ON restaurant.id = p.restaurant_id
LEFT JOIN public.product_recipes r
  ON r.product_id = p.id
 AND r.restaurant_id = p.restaurant_id
WHERE restaurant.slug = 'four-flavours';
