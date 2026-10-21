# TableForge workflow fix patch

This release updates the frontend workflow and includes `sql/TABLEFORGE_WORKFLOW_FIX_PATCH.sql` for an existing database that has already had `MASTER_MIGRATION_TABLEFORGE.sql` and `DATE_RANGE_REPORT_PATCH.sql` applied.

## Apply order

1. Deploy the updated website source.
2. In Supabase SQL Editor, run `sql/TABLEFORGE_WORKFLOW_FIX_PATCH.sql` once.
3. Test on a test table/order before using the workflow for real payments.

Do **not** rerun the master migration just to apply this workflow patch.

## What changed

- Captain cancellation event binding is disabled; Captain no longer calls the customer-session cancellation RPCs.
- Admin can remove pending, preparing, ready, or served items from an editable/unpaid order. The SQL function preserves an audit snapshot, deletes legacy cancellation requests for that item, physically deletes the order item, and recalculates the order totals.
- Paid/completed/cancelled/closed orders are protected from item removal.
- The legacy Captain cancellation and Admin approval RPCs are no longer executable by normal client roles. The Admin Approvals navigation entry was already absent from this release.
- Cashier and Admin payment confirmation offer UPI QR or Cash.
- The selected payment mode is stored on the dining session and on all dine-in orders in that session, or on the takeaway order.

## Validation limits

`npm run verify` checks JavaScript syntax/imports, SQL lexical structure, and automated source-level tests. It does not execute SQL against PostgreSQL or verify the live Supabase schema, RLS, credentials, payment behavior, printers, or browser interactions. Run the provided test plan against a staging restaurant before production deployment.
