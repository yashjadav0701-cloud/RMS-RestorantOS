import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("Ingredient Usage report labels actual deductions and preserves expected/not-backfilled states", async () => {
  const ui = await read("src/admin/ingredientUsage.js");
  assert.match(ui, /when an order item first enters Preparing/);
  assert.doesNotMatch(ui, /consumption is recorded when an order item first reaches\s*Served/i);
  assert.match(ui, /Expected · not deducted/);
  assert.match(ui, /Not backfilled/);
  assert.match(ui, /Ingredient types with recorded net consumption/);
  assert.match(ui, /Order servings with recorded stock activity/);
  assert.match(ui, /item\.kind/);
  assert.match(ui, /item\.note/);
});

test("Ingredient Usage checks setup readiness and changes only inventory mode through Admin RPC", async () => {
  const ui = await read("src/admin/ingredientUsage.js");
  assert.match(ui, /get_inventory_setup_status/);
  assert.match(ui, /set_inventory_mode/);
  assert.match(ui, /productsWithEstimatedRecipe/);
  assert.match(ui, /recipeIngredientsMissingOpeningStock/);
  assert.match(ui, /invalidMovementUnits/);
  assert.match(ui, /invalidMovementQuantities/);
  assert.match(ui, /invalidStockBalances/);
  assert.match(ui, /invalidOpeningStockEntries/);
  assert.match(ui, /canEnableStrict/);
  assert.match(ui, /Strict mode is locked/);
  assert.match(ui, /Existing ledger movements and stock balances will remain unchanged/);
});

test("database patch is tenant-scoped and prevents strict mode until verified recipes and opening stock exist", async () => {
  const sql = await read("sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql");
  assert.match(sql, /_tableforge_validate_panel_token\(p_panel_token,ARRAY\['admin'\]\)/);
  assert.match(sql, /p\.restaurant_id=p_restaurant_id/);
  assert.match(sql, /coalesce\(r\.is_estimate,true\)/);
  assert.match(sql, /movement_type='opening_stock'/);
  assert.match(sql, /v_invalid_opening_stock bigint/);
  assert.match(sql, /v_invalid_movement_quantities bigint/);
  assert.match(sql, /v_invalid_stock_balances bigint/);
  assert.match(sql, /count\(DISTINCT m\.id\) FILTER \(WHERE m\.movement_type='opening_stock'\)>1/);
  assert.match(sql, /quantity_per_serving<>round\(r\.quantity_per_serving,3\)/);
  assert.match(sql, /productsWithEstimatedRecipe/);
  assert.match(sql, /recipeIngredientsMissingOpeningStock/);
  assert.match(sql, /canEnableStrict/);
  assert.match(sql, /coalesce\(v_status->>'inventoryMode','disabled'\)<>'strict'/);
  assert.match(sql, /ON CONFLICT \(restaurant_id\) DO UPDATE\s+SET inventory_mode=EXCLUDED\.inventory_mode/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_inventory_setup_status\(text\) TO authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.set_inventory_mode\(text,text\) TO authenticated/);
});

test("usage report separates permanent sale movements from expected and historical usage", async () => {
  const sql = await read("sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql");
  assert.match(sql, /'kind','recorded'/);
  assert.match(sql, /'kind','expected'/);
  assert.match(sql, /'not_backfilled'::text/);
  assert.match(sql, /Expected use from saved recipe rows for served items without a recorded deduction/);
  assert.match(sql, /Net recorded use from recipe deductions, after any linked cancellation reconciliation/);
  assert.match(sql, /sale\.quantity_delta\+coalesce\(recon\.delta,0\)/);
  assert.match(sql, /cancelled \(stock reconciled\)/);
  assert.match(sql, /'inventoryMode',coalesce\(v_inventory_mode,'disabled'\)/);
});

test("prepared-item cancellation reconciles actual usage through immutable stock movements", async () => {
  const sql = await read("sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql");
  const ui = await read("src/admin/index.js");
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.admin_cancel_order_item/);
  assert.match(sql, /inventory_recipe_snapshot/);
  assert.match(sql, /'adjustment_in' ELSE 'adjustment_out'/);
  assert.match(sql, /reference_order_id,reference_order_item_id/);
  assert.match(sql, /inventory_reconciled_at=CASE/);
  assert.match(sql, /stock-consumption timestamp and sale ledger do not agree/);
  assert.match(sql, /snapshot and stock deduction rows do not match/);
  assert.match(sql, /_tableforge_recalculate_order\(v_order\.id\)/);
  assert.match(sql, /_tableforge_audit_event/);
  assert.match(ui, /admin_cancel_order_item/);
  assert.match(ui, /data-actual-usage-ingredient/);
  assert.match(ui, /Reconcile & cancel/);
  assert.match(ui, /inventoryRecipeSnapshot/);
});


test("inventory database patch freezes units after use and rejects non-finite stock quantities", async () => {
  const sql = await read("sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql");
  assert.match(sql, /trg_tableforge_inventory_unit_immutable/);
  assert.match(sql, /An ingredient unit cannot be changed after it is used/);
  assert.match(sql, /p_quantity::text IN \('NaN','Infinity','-Infinity'\)/);
  assert.match(sql, /v_qty::text IN \('NaN','Infinity','-Infinity'\)/);
  assert.match(sql, /v_actual::text IN \('NaN','Infinity','-Infinity'\)/);
  assert.match(sql, /invalidMovementUnits/);
  assert.match(sql, /exactly one positive opening-stock entry before preparation/);
  assert.match(sql, /SET search_path TO ''/);
});


test("strict-mode recipe edits are serialized and missing verification flags remain unverified", async () => {
  const sql = await read("sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql");
  const recipeRpc = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.admin_set_product_recipe"), sql.indexOf("-- Strict consumption"));
  assert.match(recipeRpc, /FROM public\.restaurants r WHERE r\.id=v_restaurant_id FOR UPDATE/);
  assert.match(recipeRpc, /jsonb_array_length\(p_recipe\)=0 AND v_inventory_mode='strict'/);
  assert.match(recipeRpc, /coalesce\(\(v_row->>'is_estimate'\)::boolean,true\)/);
  assert.match(recipeRpc, /A verified recipe requires an Admin verification source\/note/);
  assert.match(recipeRpc, /v_inventory_mode='strict' AND v_estimate/);
  assert.match(recipeRpc, /v_qty<>round\(v_qty,3\)/);
  assert.match(sql, /v_issued::text IN \('NaN','Infinity','-Infinity'\)/);
});

test("Admin cancellation UI refuses timestamp/snapshot disagreement instead of guessing", async () => {
  const ui = await read("src/admin/index.js");
  assert.match(ui, /const hasConsumptionMarker = Boolean\(item\.inventoryConsumedAt\)/);
  assert.match(ui, /const hasSnapshot = snapshot\.length > 0/);
  assert.match(ui, /const snapshotMissing = hasConsumptionMarker !== hasSnapshot/);
  assert.match(ui, /The item's stock-consumption timestamp and saved recipe snapshot do not agree/);
});


test("legacy cancellation and delete routes cannot bypass prepared-stock reconciliation", async () => {
  const sql = await read("sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql");
  assert.match(sql, /trg_tableforge_guard_consumed_item_cancellation/);
  assert.match(sql, /trg_tableforge_guard_consumed_item_delete/);
  assert.match(sql, /tableforge\.inventory_reconciliation_item_id/);
  assert.match(sql, /legacy cancellation is blocked/);
  assert.match(sql, /stock-consumption history cannot be deleted/);
  assert.match(sql, /set_config\('tableforge\.inventory_reconciliation_item_id',v_item\.id::text,true\)/);
});


test("prepared cancellation approval tells Admin to use the reconciliation workflow", async () => {
  const ui = await read("src/admin/cancellationApprovals.js");
  assert.match(ui, /This dish already has stock activity, so it cannot be approved from this queue/);
  assert.match(ui, /Cancel dish and enter the actual ingredient quantities/);
});

test("recipe-less dishes remain saveable while stock deductions are off, but strict mode protects active recipes", async () => {
  const sql = await read("sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql");
  const admin = await read("src/admin/index.js");
  assert.match(sql, /jsonb_array_length\(p_recipe\)=0 AND v_inventory_mode='strict' AND EXISTS/);
  assert.match(sql, /An active dish cannot lose its recipe while strict inventory is enabled/);
  assert.match(admin, /const savedRecipeVerified = productRecipeSelection\.length > 0 &&\s+productRecipeSelection\.every\(item => item\.is_estimate === false\)/);
  assert.match(admin, /const verified = recipe\.length > 0 &&\s+recipe\.every\(row => row\.is_estimate === false\)/);
  assert.match(admin, /Math\.abs\(quantity - Math\.round\(quantity \* 1000\) \/ 1000\) > 1e-9/);
});

test("stock trigger refuses legacy sale rows or recipe snapshots with missing consumption markers", async () => {
  const sql = await read("sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql");
  assert.match(sql, /inconsistent stock-consumption markers and ledger rows/);
  assert.match(sql, /old recipe snapshot without matching stock-consumption markers/);
});
