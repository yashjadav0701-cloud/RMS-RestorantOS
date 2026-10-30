# TableForge release: workspace cards, KOT Ready workflow, GST lock, inventory recipes

## Included changes

- Workspace role cards remain a 3:4 card ratio at desktop, tablet and phone breakpoints. The cards show only the role name and a larger icon; subtitles/arrows are not rendered.
- All six PIN fields use 3:4 boxes, including the separate Admin PIN screen.
- KOT displays one `Ready` action for a pending/preparing dish. The DB transitions a pending item through Preparing first (so a configured strict-inventory trigger still has the correct transition), then stores it as `served` with a reversible marker. The queue displays that marker as `Ready`, keeps its original creation/round position, and offers `Undo ready`.
- The table-level `Ready table` / `Undo ready` action applies only to one dine-in session. Real already-served dishes stay visible without being included in bulk undo. Tables disappear from KOT only after the bill is prepared (`bill_ready`) or the session is closed.
- GSTIN is validated and locks after the first non-empty save. The Admin input is disabled after that. Normal Admin settings RPC writes cannot change/delete a saved value. Developer-only SQL override instructions are in the migration comments.
- Inventory seed creates an ingredient catalogue and per-dish recipe templates only for Four Flavours. Unit costs and quantities are explicit estimates; recipe lines and cost estimates carry database flags/notes so they are not mistaken for chef-approved recipes or supplier invoices. New or edited costs remain estimates until the Admin explicitly confirms the cost against a current supplier invoice.
- The migration creates no opening-stock or received-stock movements and does not enable strict inventory. It adds a preflight guard so it fails instead of silently doing nothing if the Four Flavours tenant or active menu is absent. Strict inventory settings now reject estimated recipe rows until a chef/Admin has reviewed them. Inventory is tenant-scoped throughout.
- Saving an ingredient's name/category/reorder level does not accidentally mark the estimated cost as verified. New or changed costs remain estimates until the Admin checks the separate supplier-cost confirmation after verifying an invoice. A same-value existing estimate can also be explicitly confirmed.

## Database application

1. Back up the Supabase project.
2. Confirm `MASTER_MIGRATION_TABLEFORGE.sql` and `TABLEFORGE_WORKFLOW_FIX_PATCH.sql` have already been run. Keep the existing production workflow, reporting, bill-discount and menu migrations; do not rerun the master schema just for this feature.
3. If you still need to apply `sql/FOUR_FLAVOURS_MINIMUM_MENU_SECTIONS.sql`, run that menu migration first. Then run `sql/ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS.sql` in the intended Supabase project. The ingredient/recipe seed is safe to re-run after a menu import so newly added active dishes receive estimated starter recipes too.
4. Run `sql/AUDIT_KOT_GST_INVENTORY_ENHANCEMENTS.sql` and inspect every result set. The audit is read-only.
5. Do not switch inventory mode to `strict` until Admin has reviewed each recipe and replaced cost estimates with current supplier costs. The generic dish-name/category templates are review starters, not claims about the exact kitchen recipe; verify all ingredient quantities, marinades, garnishes and serving yields before stock deduction. Recipe amounts are planning starting points, not exact Four Flavours kitchen cards.

## Developer GSTIN override

The migration SQL contains a commented example using a transaction-local setting `tableforge.allow_gst_override = 'on'`. Only use it when deliberately changing/clearing a restaurant GSTIN through the developer's trusted SQL console. Never expose this setting as a browser RPC.

## Verification performed on this release

Verification completed for this release: JavaScript syntax and relative imports passed across 26 files, PWA icon paths passed, SQL lexical checks passed for 7 SQL files (66 function definitions / 389 top-level statements), and all 61 automated tests passed. These checks are not a PostgreSQL runtime test. The migration has not been executed against Supabase in this packaging step; run it yourself and use the accompanying read-only audit SQL.
