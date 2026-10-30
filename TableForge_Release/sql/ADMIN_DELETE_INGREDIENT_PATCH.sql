
CREATE OR REPLACE FUNCTION public.admin_delete_ingredient(
  p_panel_token text,
  p_ingredient_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_ingredient public.inventory_ingredients%ROWTYPE;
BEGIN
  SELECT x.restaurant_id
  INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(
    p_panel_token,
    ARRAY['admin']
  ) x;

  IF v_restaurant_id IS NULL THEN
    RAISE EXCEPTION 'Admin panel authorization expired or invalid.';
  END IF;

  SELECT i.*
  INTO v_ingredient
  FROM public.inventory_ingredients i
  WHERE i.id = p_ingredient_id
    AND i.restaurant_id = v_restaurant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ingredient not found in this restaurant.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_recipes r
    WHERE r.ingredient_id = p_ingredient_id
      AND r.restaurant_id = v_restaurant_id
  ) THEN
    RAISE EXCEPTION
      'This ingredient is used in one or more dish recipes. Remove it from those recipes before deleting it.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_movements m
    WHERE m.ingredient_id = p_ingredient_id
      AND m.restaurant_id = v_restaurant_id
  ) THEN
    RAISE EXCEPTION
      'This ingredient has stock history. It cannot be permanently deleted because that would damage inventory records.';
  END IF;

  DELETE FROM public.inventory_ingredients
  WHERE id = p_ingredient_id
    AND restaurant_id = v_restaurant_id;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_id', p_ingredient_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION
  public.admin_delete_ingredient(text, uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.admin_delete_ingredient(text, uuid)
  TO authenticated;
