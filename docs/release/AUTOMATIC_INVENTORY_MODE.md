# Automatic non-blocking inventory mode

## Purpose

TableForge must calculate recipe usage independently of stock availability. For Four Flavours, the recommended operating mode is **Automatic**:

- The first Preparing transition snapshots the dish's saved recipe and creates one `sale` ledger movement per ingredient.
- Estimated recipes are deducted too, but every movement is tagged `recipe_is_estimated=true` and the report labels it **Deducted · estimated recipe**. This makes provisional quantities visible instead of silently treating them as verified.
- Stock shortage never rejects the Kitchen/Ready action in Automatic mode. If the balance becomes negative, Ingredient Usage displays the shortage.
- Deductions are idempotent per order-item/ingredient. Re-entering Preparing does not deduct twice.
- Historical items whose recipe was already snapshotted while deductions were OFF are not retroactively deducted.
- `Strict` remains an optional hard-control mode that requires verified recipes, valid opening balances and enough stock. `Disabled` calculates usage but makes no future sale movements.

## Deployment

### Existing Four Flavours production project

The automatic-inventory database migration was applied successfully to the connected RMS Supabase project on **30 October 2026 at approximately 13:05 IST**. The live mode is `automatic` for `four-flavours`; the other tenant remains `disabled`. **Do not run `sql/AUTOMATIC_NONBLOCKING_INVENTORY_PATCH.sql` again on this production database.** Run `sql/VERIFY_AUTOMATIC_INVENTORY_MODE.sql` as a read-only check, then deploy this release ZIP to the existing GitHub/Vercel project so the UI exposes the mode and status labels.

### Another/new Supabase project

1. Confirm the target schema already has the Ingredient Usage reliability and always-calculate migrations, plus the KOT snapshot-variable hotfix. The automatic migration checks these prerequisites and aborts transactionally if they are missing.
2. Run `sql/AUTOMATIC_NONBLOCKING_INVENTORY_PATCH.sql` once in SQL Editor as one complete script. It adds the estimated-recipe flag, updates the Preparing trigger and usage report, extends both inventory-mode RPCs, makes Admin adjustments/cancellation reconciliation respect Automatic mode, and enables Automatic only for the Four Flavours tenant.
3. Run `sql/VERIFY_AUTOMATIC_INVENTORY_MODE.sql`. It is read-only.
4. Deploy the complete website ZIP.
5. In Admin → Ingredient Usage, confirm **Automatic deductions ON**.
6. Start a new test dish. Confirm the first Preparing transition adds one negative `sale` movement per recipe ingredient, with `recipe_is_estimated=true` for estimated recipe lines. Confirm stock decreases and the report says **Deducted · estimated recipe**.
7. In a controlled/staging tenant, test a dish with zero/insufficient stock. Automatic must allow preparation and show the negative balance as a shortage. Do not artificially create a production shortage for testing.
8. Confirm repeated Ready/Undo Ready operations do not duplicate movements. Confirm prepared-item cancellation uses Admin actual-use reconciliation and preserves the original sale rows.

### Production smoke-test result (30 October 2026)

A rollback-only database smoke test used an existing recipe-backed historical order item. Inside a rolled-back subtransaction it temporarily forced an ingredient balance below zero, invoked the real Preparing trigger, verified that one `sale` movement was created for every saved recipe line and that each was tagged as estimated, then intentionally rolled the test back. A follow-up read confirmed the original order remained Served, its usage snapshot remained unset, the test sale-row count was zero, and the original stock balance was unchanged. The Ingredient Usage report function was also invoked through its expected Admin-token authorization guard to confirm it parses/compiles; no credentials were bypassed.

No real order was backfilled and no production stock was changed by the smoke test. The next real dish prepared after deployment will be the first persistent Automatic deduction.

## Existing history

The migration deliberately does not backfill prior usage. At migration time, Four Flavours had historical served items with usage snapshots created while deductions were disabled. Those rows continue to show **Calculated · not deducted** because the opening stock was entered later and there is no trustworthy basis for applying old consumption against the new opening balance. New preparation transitions use Automatic mode.

## Safety boundaries

- No estimated recipe is marked verified by this migration.
- No stock balance is manually adjusted by the migration.
- No historical order, recipe or existing movement is rewritten.
- Only the Four Flavours tenant is switched to Automatic. The second tenant and future tenants remain in their current/default mode.
- Automatic mode allows negative balances intentionally; negative is an operational shortage, not a SQL error. Admin should replenish stock and review the underlying recipe quantities.
- Strict mode remains optional and is still gated by recipe, ingredient, opening-stock and active-order readiness.

## Verification performed

The source package includes regression tests for the Automatic/Strict/Disabled distinction and the estimated-deduction badge. Local `npm run verify` checks source syntax, SQL structure and unit/source tests. It does not replace the post-deployment live order test above.

## Historical usage label refinement (30 October 2026)

Four Flavours is in Automatic mode. Prepared items that were completed before Automatic mode and before the current opening-stock period must not reduce today's opening balance. In the Admin Ingredient Usage UI, such legacy `calculated`/`expected` rows are now labelled **Historical · before opening stock** with a neutral grey pill and an explicit explanatory note. The label remains **Calculated · not deducted** for restaurants whose inventory mode is Disabled, where calculated usage genuinely has no stock deduction. No database migration is required for this frontend-only clarification.
