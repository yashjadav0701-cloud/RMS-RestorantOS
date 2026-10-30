-- Idempotent support patch for a database where the TableForge master migration
-- has already been applied. Run this once before deploying the new date-range UI.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_inventory_usage_report(p_panel_token text,p_period text DEFAULT '7')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_since timestamptz;
  v_until timestamptz;
  v_ingredients jsonb;
  v_dishes jsonb;
  v_adjustments jsonb;
  v_metrics jsonb;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Admin panel authorization expired or invalid.';
  END IF;

  -- All custom date-only ranges use India local calendar days and an exclusive end.
  IF p_period LIKE 'range:%' THEN
    IF p_period !~ '^range:[0-9]{4}-[0-9]{2}-[0-9]{2}:[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Invalid reporting date range.';
    END IF;
    IF split_part(p_period, ':', 2)::date > split_part(p_period, ':', 3)::date THEN
      RAISE EXCEPTION 'The reporting end date must be on or after the start date.';
    END IF;
    v_since := split_part(p_period, ':', 2)::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := (split_part(p_period, ':', 3)::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period = 'today' THEN
    v_since := (now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period IN ('7', '30', '90') THEN
    v_since := ((now() AT TIME ZONE 'Asia/Kolkata')::date - (p_period::integer - 1))::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_until := ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  ELSIF p_period = 'all' THEN
    v_since := NULL;
    v_until := NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported reporting period.';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('ingredient',x.name,'unit',x.base_unit,'quantity',x.consumed) ORDER BY x.name),'[]'::jsonb)
  INTO v_ingredients
  FROM (
    SELECT i.name,i.base_unit,round(sum(-m.quantity_delta),3) AS consumed
    FROM public.inventory_movements m
    JOIN public.inventory_ingredients i ON i.id=m.ingredient_id AND i.restaurant_id=m.restaurant_id
    WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale'
      AND (v_since IS NULL OR m.created_at >= v_since)
      AND (v_until IS NULL OR m.created_at < v_until)
    GROUP BY i.name,i.base_unit
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('dish',x.dish,'servings',x.servings) ORDER BY x.dish),'[]'::jsonb)
  INTO v_dishes
  FROM (
    SELECT oi.name_snapshot AS dish,sum(oi.quantity)::numeric AS servings
    FROM (
      SELECT DISTINCT m.reference_order_item_id
      FROM public.inventory_movements m
      WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale'
        AND (v_since IS NULL OR m.created_at >= v_since)
        AND (v_until IS NULL OR m.created_at < v_until)
        AND m.reference_order_item_id IS NOT NULL
    ) used
    JOIN public.order_items oi ON oi.id=used.reference_order_item_id AND oi.restaurant_id=v_restaurant_id
    GROUP BY oi.name_snapshot
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('ingredient',i.name,'unit',m.unit,'movement_type',m.movement_type,'quantity_delta',m.quantity_delta,'reason',m.reason,'created_at',m.created_at) ORDER BY m.created_at DESC),'[]'::jsonb)
  INTO v_adjustments
  FROM public.inventory_movements m
  JOIN public.inventory_ingredients i ON i.id=m.ingredient_id AND i.restaurant_id=m.restaurant_id
  WHERE m.restaurant_id=v_restaurant_id AND m.movement_type<>'sale'
    AND (v_since IS NULL OR m.created_at >= v_since)
    AND (v_until IS NULL OR m.created_at < v_until);

  SELECT jsonb_build_object(
    'ingredientsConsumed',COALESCE((SELECT count(DISTINCT m.ingredient_id) FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale' AND (v_since IS NULL OR m.created_at >= v_since) AND (v_until IS NULL OR m.created_at < v_until)),0),
    'eligibleServings',COALESCE((SELECT sum(oi.quantity) FROM (SELECT DISTINCT m.reference_order_item_id FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id AND m.movement_type='sale' AND (v_since IS NULL OR m.created_at >= v_since) AND (v_until IS NULL OR m.created_at < v_until) AND m.reference_order_item_id IS NOT NULL) u JOIN public.order_items oi ON oi.id=u.reference_order_item_id AND oi.restaurant_id=v_restaurant_id),0),
    'movementCount',COALESCE((SELECT count(*) FROM public.inventory_movements m WHERE m.restaurant_id=v_restaurant_id AND (v_since IS NULL OR m.created_at >= v_since) AND (v_until IS NULL OR m.created_at < v_until)),0)
  ) INTO v_metrics;

  RETURN jsonb_build_object('ok',true,'period',p_period,'since',v_since,'until',v_until,'metrics',v_metrics,'ingredients',COALESCE(v_ingredients,'[]'::jsonb),'dishes',COALESCE(v_dishes,'[]'::jsonb),'adjustments',COALESCE(v_adjustments,'[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.get_inventory_usage_report(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_usage_report(text,text) TO authenticated;

COMMIT;
