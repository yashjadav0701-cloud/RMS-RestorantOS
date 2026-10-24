-- READ-ONLY AUDIT for ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS.sql
-- Run AFTER the enhancement migration. This file contains SELECT statements only.
-- All menu/inventory checks are scoped to the Four Flavours tenant.

-- 1) Tenant scope and live menu size.
WITH target AS (
  SELECT id, name, slug FROM public.restaurants WHERE slug = 'four-flavours'
)
SELECT t.id AS restaurant_id, t.name, t.slug,
       count(p.id) FILTER (WHERE p.is_active) AS active_products,
       count(p.id) FILTER (WHERE NOT p.is_active) AS inactive_products
FROM target t
LEFT JOIN public.products p ON p.restaurant_id = t.id
GROUP BY t.id, t.name, t.slug;

-- 2) Expected columns, functions and triggers exist.
WITH expected(object_kind, object_name, detail) AS (
  VALUES
    ('column','app_settings.gst_number_locked_at','One-time GST lock timestamp'),
    ('column','inventory_ingredients.cost_is_estimate','Estimated supplier-cost flag'),
    ('column','inventory_ingredients.cost_source_note','Cost provenance note'),
    ('column','product_recipes.is_estimate','Estimated recipe flag'),
    ('column','product_recipes.source_note','Recipe provenance note'),
    ('column','order_items.kot_ready_previous_status','Undo Ready marker'),
    ('column','order_items.kot_ready_at','Ready timestamp'),
    ('function','apply_admin_bill_discount','Admin bill discount RPC'),
    ('function','get_kot_queue','KOT queue RPC'),
    ('function','set_kot_item_status','Single-dish Ready / Undo Ready RPC'),
    ('function','set_kot_table_ready','Bulk table Ready / Undo Ready RPC'),
    ('function','admin_set_product_recipe','Recipe save RPC'),
    ('function','save_restaurant_workflow_settings','Strict inventory and payment-policy RPC'),
    ('function','_tableforge_guard_gst_number_once','One-time GST guard function'),
    ('trigger','trg_tableforge_gst_number_once','GST guard trigger'),
    ('trigger','trg_tableforge_consume_recipe_on_served','Inventory consume trigger')
), observed AS (
  SELECT 'column' AS object_kind, table_name || '.' || column_name AS object_name
  FROM information_schema.columns
  WHERE table_schema='public'
  UNION ALL
  SELECT 'function', p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'trigger', trg.tgname
  FROM pg_trigger trg JOIN pg_class c ON c.oid=trg.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT trg.tgisinternal
)
SELECT e.object_kind, e.object_name, e.detail,
       EXISTS (SELECT 1 FROM observed o WHERE o.object_kind=e.object_kind AND o.object_name=e.object_name) AS exists_ok
FROM expected e
ORDER BY e.object_kind, e.object_name;

-- 3) GSTIN state and trigger enablement for every tenant (no values are changed).
SELECT r.name AS restaurant_name, r.slug,
       (NULLIF(btrim(a.gst_number),'') IS NOT NULL) AS gstin_is_set,
       a.gst_number_locked_at,
       (a.gst_number IS NULL OR a.gst_number ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$') AS gstin_format_ok,
       EXISTS (
         SELECT 1 FROM pg_trigger tr
         WHERE tr.tgrelid='public.app_settings'::regclass
           AND tr.tgname='trg_tableforge_gst_number_once'
           AND tr.tgenabled <> 'D'
       ) AS gstin_guard_enabled
FROM public.restaurants r
LEFT JOIN public.app_settings a ON a.restaurant_id=r.id
ORDER BY r.name;

-- 4) Four Flavours recipe coverage, including estimated versus reviewed lines.
WITH target AS (SELECT id FROM public.restaurants WHERE slug='four-flavours')
SELECT count(DISTINCT p.id) FILTER (WHERE p.is_active) AS active_dishes,
       count(DISTINCT p.id) FILTER (WHERE p.is_active AND r.product_id IS NOT NULL) AS dishes_with_recipe,
       count(DISTINCT p.id) FILTER (WHERE p.is_active AND r.product_id IS NULL) AS dishes_missing_recipe,
       count(DISTINCT p.id) FILTER (WHERE p.is_active AND r.is_estimate) AS dishes_with_estimated_recipe,
       count(r.id) FILTER (WHERE p.is_active) AS recipe_lines,
       count(r.id) FILTER (WHERE p.is_active AND r.is_estimate) AS estimated_recipe_lines,
       count(r.id) FILTER (WHERE p.is_active AND NOT r.is_estimate) AS reviewed_recipe_lines
FROM target t
JOIN public.products p ON p.restaurant_id=t.id
LEFT JOIN public.product_recipes r ON r.restaurant_id=p.restaurant_id AND r.product_id=p.id;

-- 5) List any active Four Flavours dishes missing a recipe or still using estimate rows.
WITH target AS (SELECT id FROM public.restaurants WHERE slug='four-flavours')
SELECT p.id AS product_id, p.name, p.category,
       count(r.id) AS recipe_ingredient_count,
       count(r.id) FILTER (WHERE r.is_estimate) AS estimated_ingredient_count,
       CASE WHEN count(r.id)=0 THEN 'MISSING RECIPE'
            WHEN bool_or(r.is_estimate) THEN 'REVIEW ESTIMATED RECIPE'
            ELSE 'REVIEWED' END AS recipe_audit_status
FROM target t
JOIN public.products p ON p.restaurant_id=t.id AND p.is_active
LEFT JOIN public.product_recipes r ON r.product_id=p.id AND r.restaurant_id=p.restaurant_id
GROUP BY p.id,p.name,p.category
HAVING count(r.id)=0 OR bool_or(r.is_estimate)
ORDER BY recipe_audit_status,p.category,p.name;

-- 6) Ingredient count, estimate flags, missing prices, and ledger state.
WITH target AS (SELECT id FROM public.restaurants WHERE slug='four-flavours'), balances AS (
  SELECT i.id, i.restaurant_id, i.name, i.cost_per_unit, i.cost_is_estimate,
         coalesce(sum(m.quantity_delta),0) AS current_balance,
         count(m.id) AS movement_count,
         count(m.id) FILTER (WHERE m.movement_type='opening_stock') AS opening_rows
  FROM target t
  JOIN public.inventory_ingredients i ON i.restaurant_id=t.id AND i.is_active
  LEFT JOIN public.inventory_movements m ON m.ingredient_id=i.id AND m.restaurant_id=i.restaurant_id
  GROUP BY i.id,i.restaurant_id,i.name,i.cost_per_unit,i.cost_is_estimate
)
SELECT count(*) AS active_ingredients,
       count(*) FILTER (WHERE cost_is_estimate) AS estimated_costs,
       count(*) FILTER (WHERE cost_per_unit IS NULL) AS missing_costs,
       count(*) FILTER (WHERE NOT cost_is_estimate AND cost_per_unit IS NOT NULL) AS entered_costs,
       count(*) FILTER (WHERE opening_rows=0) AS no_opening_stock_record,
       count(*) FILTER (WHERE opening_rows>0) AS with_opening_stock_record,
       count(*) FILTER (WHERE current_balance<0) AS negative_balances,
       sum(movement_count) AS total_movement_rows
FROM balances;

-- 7) Ingredient/recipe tenant integrity and duplicate line audit.
WITH target AS (SELECT id FROM public.restaurants WHERE slug='four-flavours')
SELECT count(r.id) AS recipe_rows,
       count(r.id) FILTER (WHERE p.id IS NULL OR p.restaurant_id IS DISTINCT FROM r.restaurant_id) AS recipe_product_tenant_mismatches,
       count(r.id) FILTER (WHERE i.id IS NULL OR i.restaurant_id IS DISTINCT FROM r.restaurant_id) AS missing_or_cross_tenant_ingredients,
       count(r.id) FILTER (WHERE i.id IS NOT NULL AND i.base_unit NOT IN ('g','ml','pcs')) AS invalid_units,
       (SELECT count(*) FROM (
         SELECT r2.product_id,r2.ingredient_id
         FROM target t2 JOIN public.product_recipes r2 ON r2.restaurant_id=t2.id
         GROUP BY r2.product_id,r2.ingredient_id HAVING count(*)>1
       ) d) AS duplicate_product_ingredient_pairs
FROM target t
JOIN public.product_recipes r ON r.restaurant_id=t.id
LEFT JOIN public.products p ON p.id=r.product_id
LEFT JOIN public.inventory_ingredients i ON i.id=r.ingredient_id;

-- 8) KOT Ready markers are consistent; Ready-marked dishes are stored as served and reversible.
WITH target AS (SELECT id FROM public.restaurants WHERE slug='four-flavours')
SELECT count(*) FILTER (WHERE oi.kot_ready_previous_status IS NOT NULL) AS ready_marked_items,
       count(*) FILTER (WHERE oi.kot_ready_previous_status IS NOT NULL AND oi.serving_status='served') AS valid_ready_markers,
       count(*) FILTER (WHERE oi.kot_ready_previous_status IS NOT NULL AND oi.serving_status<>'served') AS inconsistent_ready_markers,
       count(*) FILTER (WHERE oi.serving_status='served' AND oi.kot_ready_previous_status IS NULL) AS physically_served_items
FROM target t
JOIN public.order_items oi ON oi.restaurant_id=t.id;

-- 9) Current per-tenant inventory mode. The migration must not auto-enable strict mode.
SELECT r.name, r.slug, coalesce(w.inventory_mode,'disabled') AS inventory_mode,
       coalesce(w.allowed_payment_methods, ARRAY['upi_qr','cash','card','bank_transfer']::text[]) AS allowed_payment_methods,
       EXISTS (
         SELECT 1 FROM public.products p
         WHERE p.restaurant_id=r.id AND p.is_active
           AND (NOT EXISTS (SELECT 1 FROM public.product_recipes pr WHERE pr.restaurant_id=p.restaurant_id AND pr.product_id=p.id)
             OR EXISTS (SELECT 1 FROM public.product_recipes pr WHERE pr.restaurant_id=p.restaurant_id AND pr.product_id=p.id AND pr.is_estimate))
       ) AS requires_recipe_review_before_strict_mode
FROM public.restaurants r
LEFT JOIN public.restaurant_workflow_settings w ON w.restaurant_id=r.id
ORDER BY r.name;

-- 10) Read-only sample: all estimated ingredient prices should be replaced with invoice prices.
WITH target AS (SELECT id FROM public.restaurants WHERE slug='four-flavours')
SELECT i.name, i.category, i.base_unit, i.cost_per_unit AS estimated_or_entered_cost_inr_per_unit,
       i.cost_is_estimate, i.cost_source_note,
       i.reorder_level, coalesce(sum(m.quantity_delta),0) AS current_stock
FROM target t
JOIN public.inventory_ingredients i ON i.restaurant_id=t.id
LEFT JOIN public.inventory_movements m ON m.ingredient_id=i.id AND m.restaurant_id=i.restaurant_id
WHERE i.cost_is_estimate OR i.cost_per_unit IS NULL
GROUP BY i.id,i.name,i.category,i.base_unit,i.cost_per_unit,i.cost_is_estimate,i.cost_source_note,i.reorder_level
ORDER BY i.cost_is_estimate DESC,i.category,i.name;
