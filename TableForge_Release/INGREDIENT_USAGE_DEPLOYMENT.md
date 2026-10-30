# TableForge – Ingredient Usage reliability release

## What was corrected

This release aligns the Ingredient Usage screen, stock ledger, recipe validation, KOT preparation transitions and prepared-item cancellation reconciliation.

- The report distinguishes **recorded net consumption**, **expected usage that was not deducted**, and **historical items that cannot safely be reconstructed**.
- Automatic deductions happen once, when a dish first enters **Preparing**. The server checks a verified recipe, ingredient units and available stock before writing sale movements.
- The Admin Ingredient Usage page shows the current inventory mode and the exact reasons strict mode is still locked. It does not silently report an RPC failure as zero consumption.
- The strict-mode switch and the legacy workflow-settings RPC use the same readiness checks. Recipe changes are serialized against mode activation; omitted recipe-verification flags default to estimated.
- Ingredient base units cannot be changed after the ingredient is used by a recipe or stock movement.
- Stock and recipe RPCs reject non-finite quantities and invalid precision. The stock ledger cannot be driven below zero through the Admin movement RPC.
- Cancelling a dish after preparation requires an audit reason and actual ingredient usage. The system posts signed correction movements; it does not delete the original sale movements or the order line.
- The cancellation flow refuses to guess when the order-item timestamp, saved recipe snapshot and sale ledger disagree. Database triggers also block older customer/Captain/Admin cancellation RPCs and physical deletion from bypassing reconciliation; prepared-item approval requests must be resolved through the Admin Table Manager workflow.

## Database result from the live Four Flavours project

The audit on 30 October 2026 found:

| Check | Live value |
|---|---:|
| Active dishes | 231 |
| Active ingredients | 108 |
| Recipe lines | 1,911 |
| Active dishes with estimated recipe quantities | 231 |
| Distinct ingredients referenced by active-dish recipes | 70 |
| Those recipe ingredients without opening-stock entries | 70 |
| Existing stock movement rows | 2 |
| Sale/consumption movement rows | 0 |
| Inventory mode | `disabled` (no `restaurant_workflow_settings` rows currently exist, so the schema default applies) |

The two movement rows are an opening-stock entry of **4,000 g Almonds** and a receipt of **5,000 g Almonds**. They are not dish-consumption movements. The Almonds balance shown by the ledger is 9,000 g.

All 108 active ingredient cost records were also estimated or missing. This does not prevent quantity tracking after setup, but ingredient-cost and food-cost reports should not be treated as reliable until those costs are verified separately.

**Do not enable strict inventory immediately.** Every active dish recipe is still marked estimated, and all 70 ingredients currently referenced by active-dish recipes need opening stock. The database is correctly keeping automatic deduction disabled until these conditions are fixed.

## Deployment on the existing RMS Supabase project

1. Keep the existing production database and its current data. Do not rerun the master migration on an already-migrated live project.
2. In the Supabase Dashboard for the existing **RMS** project, open **SQL Editor**.
3. Open `sql/INGREDIENT_USAGE_RELIABILITY_PATCH.sql` from this release and run the entire file as one script. It includes a preflight and transaction. If a prerequisite is missing, it raises an error and rolls the patch back; do not remove the preflight checks to force it through.
4. Run `sql/VERIFY_INGREDIENT_USAGE_READINESS.sql`. This is read-only and should show inventory mode `disabled`, the current setup blockers, and the existing movement ledger.
5. Deploy the complete ZIP to the same GitHub/Vercel project as the current website. Keep the repository's existing Supabase URL and publishable/anon key configuration; do not add a service-role key to browser code.
6. Sign in to Admin → Ingredient Usage. The setup panel should show strict mode OFF and the blockers. If the page reports that setup status is unavailable, confirm that the SQL patch ran successfully and that the deployed website is using the intended Supabase project.

The SQL patch is designed for the existing TableForge schema. It adds no new tables or columns. It creates/replaces guarded functions and installs an ingredient-unit immutability trigger. It does not enable strict mode, create stock, mark recipes verified, modify existing movements, or backfill historical orders.

## Safe go-live sequence for stock deductions

1. In Admin → Inventory → Recipes, review the quantities for every active dish against the actual kitchen recipe. Do not bulk-clear the estimated flag. Mark a dish verified only after every line and serving quantity has been checked.
2. Confirm the base unit for each ingredient (`g`, `ml` or `pcs`). Once an ingredient has recipes or ledger movements, its base unit is intentionally immutable. Create a correctly-unitized ingredient and update recipes rather than silently reinterpreting old quantities.
3. Record the actual current opening stock for each of the 70 recipe-used ingredients in its base unit. Do not use market prices, recipe quantities or invented balances as opening stock.
4. Complete or reconcile active order items. The database readiness check will prevent enabling strict mode while eligible active order items remain.
5. When the Admin page reports no blockers, enable **Strict stock deduction** from Ingredient Usage.
6. Run one controlled test dish: verify that the first Preparing transition creates one sale movement per recipe ingredient and that repeated status changes do not deduct twice. Confirm insufficient stock rejects preparation without partial movements.
7. Test a prepared-item cancellation before using this in normal operation. Enter the quantities actually used. Check that unused stock is returned as `adjustment_in`, extra usage is recorded as `adjustment_out`, the original sale rows remain, and the order total is recalculated. A prepared-item request in the cancellation-approval queue cannot directly approve the cancellation; use Admin → Orders → Table Manager so the stock reconciliation is recorded first.

When strict mode is OFF, the report can show expected recipe usage for eligible served items, but that is explicitly labelled **Expected · not deducted** and it never changes stock balances. Historical items without a recipe that can be proven to have existed at the time are labelled not backfilled; no historic consumption is invented.

## Verification performed for this release

`npm run verify` passes all **99 automated tests**, JavaScript syntax checks, relative-import checks, PWA manifest/icon checks and SQL lexical-structure checks. The SQL checker explicitly does not parse or execute functions in PostgreSQL. The live Supabase inspection confirmed the schema prerequisites and the pre-existing unique index used to prevent duplicate sale movements.

The production patch has **not** been applied as part of this ZIP build, and no live data or inventory settings were changed during the audit. A final live browser workflow (Admin sign-in → preparation → ledger → cancellation) must be completed after deployment and SQL installation. This release should not be described as production-verified until that test is done.
