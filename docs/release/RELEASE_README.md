# TableForge release handoff

## Included

- `sql/MASTER_MIGRATION_TABLEFORGE.sql` — coordinated, transactional migration for a fresh/staging installation based on the supplied schema snapshot. Do not rerun it on a database where it has already succeeded.
- `sql/POST_MIGRATION_VALIDATION.sql` — read-only post-migration checks.
- `sql/DATE_RANGE_REPORT_PATCH.sql` — idempotent `CREATE OR REPLACE` patch for custom-range support in the existing inventory usage report RPC. Apply this one patch to an existing database after deploying this frontend; do not rerun the master migration just for date-range support.
- `sql/RESET_ADMIN_PIN.sql` — owner/tenant-specific hashed PIN reset, only after the master migration completed successfully.
- `docs/release/TEST_PLAN.md` — full release test plan, status definitions, and this release's focused regression checklist.
- `docs/release/RPC_CONTRACT_INVENTORY.json` — frontend RPC call inventory.
- Source modules, local static/source-integrity tests, and scripts.

## Current local verification

Run from the project root:

```sh
npm run verify
```

Verified in this workspace on 2026-10-19:

- JavaScript syntax: PASS (26 files).
- Relative JavaScript imports: PASS.
- PWA manifest and icon paths: PASS.
- SQL lexical structure: PASS (40 function definitions, 233 top-level statements).
- Source/unit tests: PASS (30 tests).

These are local static/source tests. They are **not** proof that PostgreSQL accepted the migration or that Supabase authentication, RLS, realtime, printing, QR sessions, and browser workflows work end-to-end.

## Changes in this package

- Added Captain workspace route dispatch to the Captain module.
- Removed the redundant order-type Takeaway selector when creating a Cashier takeaway order.
- Added a common panel-only Sign out control and a confirmation guard when navigating out of an unlocked workspace.
- Added the same date-range control to Orders/Bill History, Top Products, Ingredient Usage, and Audit Dashboard: Today, Yesterday, last 7/30/90 days, This month, All time, and a custom inclusive start/end date range.
- Orders/Bill History sends custom date boundaries using Asia/Kolkata day starts and an exclusive next-day boundary.
- Top Products and Audit Dashboard data sources remain explicitly marked as not connected in the current source. Their date controls are unified, but these screens must not be treated as live data reports until their data sources are implemented and tested.

## Safe rollout sequence

1. Create a restorable backup and prepare a staging clone of the live Supabase database.
2. For a new/staging database that has not had the master migration applied, apply `sql/MASTER_MIGRATION_TABLEFORGE.sql`. If it has already succeeded on the target database, do not rerun it; instead apply only the relevant idempotent patch files listed for this release. If any execution errors, stop and verify transaction rollback.
3. Run `sql/POST_MIGRATION_VALIDATION.sql`. Resolve all `FAIL` results and investigate warnings.
4. Run `npm run verify` from this project root.
   - If the Admin PIN is unknown after a successful migration, first get the target restaurant UUID, then edit and run `sql/RESET_ADMIN_PIN.sql` in Supabase SQL Editor. The script requires the master migration to be installed and revokes existing Admin panel tokens.
5. If upgrading an already-migrated database for this release, apply `sql/DATE_RANGE_REPORT_PATCH.sql` once, then run `sql/POST_MIGRATION_VALIDATION.sql`. Run the database/browser integration tests in `docs/release/TEST_PLAN.md`, including customer QR ordering and each of the five staff panels. Record actual evidence; do not mark blocked cases as passed.
6. Deploy the matching frontend and database release together. Do not deploy only one side because RPC contracts and table permissions change together.
7. Run the validation query and compare data counts with a saved pre-migration snapshot after the approved production deployment.

## Important data-preservation notes

- The migration is written to preserve existing restaurant/menu/order/session rows and uses a transaction with preflight checks.
- It changes `pin_salt` for tables whose salt is currently zero. This intentionally changes the derived daily table PIN; retrieve/display the new PIN through the protected Admin flow after deployment and verify the customer QR flow before reopening service.
- New panel PINs for Captain, KOT, Cashier, and Manager must be configured by Admin after the migration. No default PINs are inserted.
- Existing completed-but-unpaid orders are not automatically marked paid. Their status must be reviewed as operational history, not normalized blindly.
- If production cannot be cloned, do not treat a direct production run as a substitute for staging validation.

## Release status

**Not production-cleared yet.** No PostgreSQL/Supabase execution or browser end-to-end test was available in the local workspace. This handoff is ready for a staging migration and integration-validation pass, not a guarantee of flawless live behavior.
