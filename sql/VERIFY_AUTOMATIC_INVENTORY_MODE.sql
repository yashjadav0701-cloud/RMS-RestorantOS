-- Read-only verification for TableForge automatic non-blocking deductions.
SELECT
  (SELECT inventory_mode FROM public.restaurant_workflow_settings w
   JOIN public.restaurants r ON r.id=w.restaurant_id WHERE r.slug='four-flavours') AS inventory_mode,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
   AND table_name='inventory_movements' AND column_name='recipe_is_estimated') AS estimated_deduction_flag_column,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
   AND table_name='order_items' AND column_name='inventory_usage_calculated_at') AS usage_snapshot_column,
  (SELECT position('v_mode=''automatic''' IN pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure))>0) AS trigger_supports_automatic_mode,
  (SELECT position('v_mode=''strict''' IN pg_get_functiondef('public._tableforge_consume_recipe_on_served()'::regprocedure))>0) AS trigger_retains_optional_strict_mode,
  (SELECT position('sale.recipe_is_estimated' IN pg_get_functiondef('public.get_inventory_usage_report(text,text)'::regprocedure))>0) AS report_separates_estimated_deductions;

SELECT r.slug,w.inventory_mode,
  count(*) FILTER (WHERE m.movement_type='sale') AS sale_movements,
  count(*) FILTER (WHERE m.movement_type='sale' AND m.recipe_is_estimated) AS estimated_recipe_deductions,
  count(*) FILTER (WHERE m.movement_type='sale' AND NOT m.recipe_is_estimated) AS verified_recipe_deductions,
  count(DISTINCT m.ingredient_id) FILTER (WHERE m.movement_type='sale') AS ingredients_deducted,
  count(*) FILTER (WHERE m.movement_type='sale' AND coalesce(b.balance,0)<0) AS estimated_negative_balance_rows
FROM public.restaurants r
LEFT JOIN public.restaurant_workflow_settings w ON w.restaurant_id=r.id
LEFT JOIN public.inventory_movements m ON m.restaurant_id=r.id
LEFT JOIN LATERAL (
  SELECT sum(x.quantity_delta) AS balance
  FROM public.inventory_movements x
  WHERE x.restaurant_id=m.restaurant_id AND x.ingredient_id=m.ingredient_id
) b ON true
WHERE r.slug='four-flavours'
GROUP BY r.slug,w.inventory_mode;
