# TableForge – Ingredient Usage reliability release

## What was corrected

This release aligns the Ingredient Usage screen, stock ledger, recipe validation, KOT preparation transitions and prepared-item cancellation reconciliation.

- The report distinguishes **recorded stock deductions**, **calculated recipe usage that was not deducted**, **Admin-confirmed actual use from prepared-item cancellation**, and **historical items that cannot safely be reconstructed**.
- Recipe usage is calculated when a dish first enters **Preparing**, regardless of inventory mode or on-hand stock. Automatic deductions remain a separate operation and happen once, when strict mode is active and a verified recipe passes stock checks.
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
| Recipe-used ingredients | 70 |
| Active ingredients with opening-stock entries | 108 / 108 |
| Opening-stock entries | 108 (one per active ingredient) |
| Total stock movement rows | 109 (including the original Almonds receipt) |
| Sale/consumption movement rows | 0 |
| Inventory mode | `disabled` |
| Served order items in history | 10 |
| Items with a provable recipe at order time | 4 |
| Items that cannot safely be backfilled | 6 |

The original Almonds entries are **4,000 g opening stock** plus **5,000 g received**, for a 9,000 g ledger balance. The existing Black Pepper opening balance is 5,000 g. The weekly-stock seed added one opening-stock entry for each active ingredient without overwriting those original entries. These are recorded opening balances; they must still be checked against the actual physical quantities on the shelves.

All 108 active ingredient cost records were also estimated or missing. This does not prevent quantity tracking after setup, but ingredient-cost and food-cost reports should not be treated as reliable until those costs are verified separately.

**Do not enable strict inventory immediately.** Every active dish recipe is still marked estimated. All 108 active ingredients now have one opening-stock entry, but the physical balances must be checked before relying on them. In particular, physically verify the 70 ingredients used by active-dish recipes. The database is correctly keeping automatic deduction disabled until recipes and stock readiness are genuinely verified.

## Deployment on the existing RMS Supabase project

1. Keep the existing production database and its current data. Do not rerun the master migration on an already-migrated live project.
2. In the Supabase Dashboard for the existing **RMS** project, open **SQL Editor**.
3. The connected RMS database already has the Ingredient Usage reliability functions. Run `sql/INGREDIENT_USAGE_ALWAYS_CALCULATE_PATCH.sql` as one complete script. It includes preflight checks and a transaction. If a prerequisite is missing, it raises an error and rolls back; do not remove the preflight checks to force it through.
4. Run `sql/VERIFY_INGREDIENT_USAGE_ALWAYS_CALCULATE.sql` and `sql/VERIFY_INGREDIENT_USAGE_READINESS.sql`. Both are read-only. The first confirms the new snapshot columns and trigger; the second confirms the existing stock-readiness state.
5. Deploy the complete ZIP to the same GitHub/Vercel project as the current website. Keep the repository's existing Supabase URL and publishable/anon key configuration; do not add a service-role key to browser code.
6. Sign in to Admin → Ingredient Usage. The setup panel should show strict mode OFF and the blockers. If the page reports that setup status is unavailable, confirm that the SQL patch ran successfully and that the deployed website is using the intended Supabase project.

The always-calculate patch adds two order-item columns (`inventory_usage_calculated_at` and `inventory_actual_usage_snapshot`) and replaces guarded trigger/report/cancellation functions. It does not enable strict mode, create stock movements, mark recipes verified, change existing stock balances or invent historical usage.

## Safe go-live sequence for stock deductions

1. In Admin → Inventory → Recipes, review the quantities for every active dish against the actual kitchen recipe. Do not bulk-clear the estimated flag. Mark a dish verified only after every line and serving quantity has been checked.
2. Confirm the base unit for each ingredient (`g`, `ml` or `pcs`). Once an ingredient has recipes or ledger movements, its base unit is intentionally immutable. Create a correctly-unitized ingredient and update recipes rather than silently reinterpreting old quantities.
3. Record the actual current opening stock for each of the 70 recipe-used ingredients in its base unit. Do not use market prices, recipe quantities or invented balances as opening stock.
4. Complete or reconcile active order items. The database readiness check will prevent enabling strict mode while eligible active order items remain.
5. When the Admin page reports no blockers, enable **Strict stock deduction** from Ingredient Usage.
6. Run one controlled test dish: verify that the first Preparing transition creates one sale movement per recipe ingredient and that repeated status changes do not deduct twice. Confirm insufficient stock rejects preparation without partial movements.
7. Test a prepared-item cancellation before using this in normal operation. Enter the quantities actually used. Check that unused stock is returned as `adjustment_in`, extra usage is recorded as `adjustment_out`, the original sale rows remain, and the order total is recalculated. A prepared-item request in the cancellation-approval queue cannot directly approve the cancellation; use Admin → Orders → Table Manager so the stock reconciliation is recorded first.

When strict mode is OFF or stock is zero, the report still calculates usage for items in Preparing, Ready or Served. It is labelled **Calculated · not deducted** and it never changes stock balances. The current on-hand balance is shown separately, so zero stock does not hide or suppress the recipe calculation. Historical items without a recipe that can be proven to have existed at the time are labelled not backfilled; no historic consumption is invented.

## Verification performed for this release

`npm run verify` passes all **104 automated tests**, JavaScript syntax checks, relative-import checks, PWA manifest/icon checks and SQL lexical-structure checks. The SQL checker explicitly does not parse or execute functions in PostgreSQL. The live Supabase inspection confirmed the schema prerequisites and the pre-existing unique index used to prevent duplicate sale movements.

The always-calculate schema and reporting functions are present in the connected RMS production database. On 30 October 2026, the KOT Ready trigger variable mismatch was corrected directly in the live database with the guarded `sql/KOT_READY_SNAPSHOT_VARIABLE_HOTFIX.sql` migration. A transaction-only smoke test moved a pending test item through the Preparing trigger, confirmed its usage timestamp/snapshot was created, and intentionally rolled the transaction back. The item remained pending afterward and no stock sale movement was created. Strict inventory remains disabled.

The updated website ZIP still needs to be deployed to GitHub/Vercel for the frontend fixes, including the Cashier takeaway-mode correction and clearer KOT error display. A final real browser workflow on the deployed site is still required; the rollback-only database smoke test is not a substitute for clicking Ready in the browser or testing the other workspaces end to end.


## Always-calculate usage behaviour (this release)

The `sql/INGREDIENT_USAGE_ALWAYS_CALCULATE_PATCH.sql` migration must be applied after the existing Ingredient Usage reliability functions. It makes recipe usage calculation independent from strict stock deduction:

- The first transition into `Preparing` snapshots saved recipe quantities in either inventory mode.
- The report includes `Preparing`, `Ready`, and `Served` items even when stock is zero or inventory mode is disabled.
- A calculation is not a stock movement and never changes the on-hand balance. `Strict` mode is still the separate control for actual deductions.
- Admin cancellation of a prepared item asks for actual ingredient use. With deductions OFF, actual use is saved to the order item for reporting but no stock movement is fabricated. With deductions ON, the existing movement ledger is reconciled.
- Historical prepared/served items are calculated only when a recipe can be reconstructed from records that existed at the time. The migration does not invent missing historical recipe values. On the live Four Flavours dataset, 4 of the 10 older served items can be reconstructed from saved recipe history, yielding 8 ingredient types; the other 6 remain explicitly not backfilled.
- The Stock adjustments tab continues to show opening balances, receipts, wastage and manual corrections; these do not get mixed into dish consumption.
- Admin must deliberately enter actual quantities when cancelling a prepared item; the fields start blank rather than assuming the full recipe was consumed.

This patch adds `order_items.inventory_usage_calculated_at` and `order_items.inventory_actual_usage_snapshot`. It leaves `inventory_mode` unchanged.


## Operational roles and KOT Ready repair (30 October 2026)

- The live KOT trigger declared `v_had_snapshot` but referenced `v_has_snapshot`. This caused PostgreSQL `42703` on both individual Ready and Ready table. The live RMS trigger was hotfixed; its declaration, use, strict-mode guard and trigger attachment were read-only verified.
- The KOT single-item error panel now displays the returned server message instead of hiding it behind a generic error.
- The Cashier POS had a second, independent bug: after initializing the Cashier draft as `takeaway`, a later non-customer initialization branch reset it to `dine_in`. That reset has been removed; Captain remains `dine_in`, Cashier remains `takeaway`, and customer QR sessions remain `dine_in`.
- The backend allowlists were checked against the connected RMS database: KOT queue is `kot`/`manager`; Ready/Undo Ready accepts `kot`/`manager`/`admin`; POS order creation accepts `captain`/`cashier`/`manager`/`admin` with server-side order-type restrictions; Cashier bill queue accepts `cashier`/`manager`; bill generation/payment accepts `cashier`/`manager`/`admin`; Admin inventory/config/report functions require `admin`. Panel tokens are tied to the signed-in owner and tenant.
- Live Four Flavours has one PIN credential for each of the five workspaces: Captain, KOT, Cashier, Manager and Admin. Short-lived panel tokens are created only when a workspace is actively unlocked, so the absence of an active Cashier/Manager token at an idle inspection time is not a missing-PIN defect.

For the connected RMS production database, the live hotfix has already been applied; **do not rerun the master migration or the hotfix unnecessarily**. Run `sql/VERIFY_KOT_READY_HOTFIX.sql` for the read-only check. The hotfix script is included in the release for staging or another database that has the same verified preconditions.
