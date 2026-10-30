# TableForge role, KOT, GSTIN and inventory acceptance checklist

## Before deployment

1. Back up the intended Supabase project.
2. Confirm `MASTER_MIGRATION_TABLEFORGE.sql` and `TABLEFORGE_WORKFLOW_FIX_PATCH.sql` were applied previously. Do not rerun the master migration.
3. If `FOUR_FLAVOURS_MINIMUM_MENU_SECTIONS.sql` is still pending, run it before the ingredient/recipe enhancement so the current active catalogue receives recipe templates.
4. Run `ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS.sql`. If any statement fails, stop and resolve the exact database error before continuing.
5. Run `AUDIT_KOT_GST_INVENTORY_ENHANCEMENTS.sql` (read-only) and inspect all result sets.
6. Deploy the updated `TableForge_Release` source through the connected Git repository and Vercel.

## Role cards and PIN entry

- At 320, 375, 425, 768 and 1440 CSS-pixel widths, verify each workspace tile keeps a portrait 3:4 ratio and contains only its role label and large role icon.
- Verify all six PIN fields have a 3:4 width:height ratio and fit without horizontal overflow. Test Captain, KOT, Cashier, Manager and Admin.

## KOT workflow

1. Use a test dine-in table with multiple items and at least two rounds. Note each item’s order/round position.
2. Press **Ready** on a pending dish. It should remain in the same order/round position and display Ready. There should be no separate Pending/Preparing button.
3. Press **Undo ready**. The dish should return to Preparing in the same position. In strict inventory mode, confirm the undo does not create a second sale movement for the same item.
4. Press **Ready table**, then **Undo ready**. The action must affect only that table/session; it must not modify any other table.
5. Leave all items Ready. The table remains on KOT with an awaiting-bill indicator. Generate the final bill from Cashier; only after the bill is prepared should the table leave KOT.
6. Check KOT ordering after every action. The order is based on order creation, round number and item creation, not current status.

## GSTIN one-time lock

- Only enter an actual, verified GSTIN. Once saved, the field should be disabled in Admin.
- Confirm an ordinary Admin settings save with the same GSTIN succeeds and a normal attempt to change or clear a non-empty value is rejected by the database trigger.
- For an approved correction, use the developer-only override comments in the migration from a trusted SQL console; never expose that override as a frontend RPC.

## Ingredients, prices and recipes

- The migration seeds an estimated cost catalogue (INR per g/ml/piece) and recipe templates for active Four Flavours dishes which do not already have recipe rows. It creates **no opening stock and no fictional purchase movements**.
- Review each recipe against the kitchen’s actual recipe card: exact ingredient, base unit, quantity per serving, sauces/marinades, garnish and serving yield. Mark **I've verified this recipe** only after review. Replace estimated costs with current supplier-invoice costs and check the cost confirmation box.
- Record actual opening stock and subsequent purchases/wastage before expecting meaningful stock balances or forecasts. The migration deliberately does not enable strict inventory.
- Try saving strict inventory while estimated or missing recipes remain. It should be rejected with a clear message. Do not enable strict mode until all active dishes and costs are reviewed and opening stock is recorded.

## Audit SQL expected findings

- Audit result 1 identifies only the Four Flavours tenant for menu counts.
- Result 2 should report all expected columns, functions and triggers as present.
- Result 3 shows GSTIN lock state and trigger status for each tenant.
- Results 4–5 show recipe coverage and list any missing/estimated recipe lines. Estimates are expected until reviewed.
- Results 6 and 10 show estimated/missing ingredient costs and opening-stock coverage. No opening stock is expected immediately after migration.
- Result 7 should show zero cross-tenant product/ingredient references and zero duplicate product/ingredient pairs.
- Result 8 should show no inconsistent Ready markers.
- Result 9 should show inventory mode still disabled unless it was already configured otherwise.

## Important limitation

Automated checks validate JavaScript syntax/imports, static SQL structure and source regression tests. They do not execute the migration in PostgreSQL or replace a manual browser test against your Supabase project. The seeded quantities and prices are explicitly estimates, not supplier quotations or verified Four Flavours kitchen recipe cards.
