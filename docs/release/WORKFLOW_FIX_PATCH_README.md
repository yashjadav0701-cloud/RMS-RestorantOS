# TableForge workflow release patch

This release builds on the previously supplied `TableForge_Workflow_Fixed_Release.zip`. It adds a mandatory payment-method choice before a cashier can generate/open the receipt, stores that choice on the tenant's bill, displays the chosen method on the receipt, suppresses the UPI QR on Cash receipts, and makes the Admin Paid action compact.

## Install

1. Deploy the updated source.
2. Run `sql/TABLEFORGE_WORKFLOW_FIX_PATCH.sql` once in Supabase SQL Editor. It is incremental; do not rerun the master migration.
3. Test in a staging tenant before production.

## Tenant isolation

`restaurant_workflow_settings` stores inventory mode, takeaway prepayment policy, and allowed payment methods per restaurant. The settings RPC validates the Admin panel token and writes only the authenticated tenant's row. Defaults are conservative (`inventory_mode = disabled`, UPI QR + Cash allowed, takeaway prepayment allowed), so a tenant does not get unexpectedly blocked until its inventory is configured. The settings are intentionally not copied between restaurants.

## Inventory behavior

When a tenant is explicitly configured for `strict` inventory, the database trigger snapshots the recipe and deducts the full recipe on the first transition to `preparing`, checks stock atomically, and prevents duplicate consumption through the per-item marker and unique movement constraint. Strict mode cannot be enabled until every active product has a recipe; the current live audit showed 173 active products for one tenant and 1 for another, with no inventory ingredients, movements, or recipes. Configure real recipes and opening stock first. Do not invent recipe quantities.

## Validation limits / remaining operational rollout

`npm run verify` validates syntax, imports, SQL lexical structure, and source-level tests. It does not execute SQL against PostgreSQL or verify live Supabase permissions or browser workflows. The per-tenant settings RPC exists for secure configuration but is not yet exposed as a settings screen. The ingredient-usage cancellation modal and end-to-end cancellation reconciliation require a staging database test before strict inventory is enabled for live service. Do not enable strict mode in production until recipes/opening stock are configured and the full cancellation flow has been tested.
