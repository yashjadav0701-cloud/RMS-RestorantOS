# TableForge operational-role and KOT Ready audit

## Production issue found

The live `public._tableforge_consume_recipe_on_served()` trigger declared `v_had_snapshot` but referenced the undeclared `v_has_snapshot` variable in its strict-mode guard. PostgreSQL raised `column "v_has_snapshot" does not exist` while the `order_items` Preparing trigger ran. Both individual dish Ready and table-wide Ready use that transition, so both failed even though the frontend RPC calls and panel permissions were correct.

Corrective migration: `sql/KOT_READY_SNAPSHOT_VARIABLE_HOTFIX.sql`. It was applied directly to the connected RMS production database on 30 October 2026; the live trigger was verified afterward.

## Role routing and backend RPC checks

| Workspace | Responsibility | Relevant backend panel authorization |
|---|---|---|
| Captain | Dine-in tables, dine-in order rounds, bill request, pending-item cancellation / prepared-item cancellation request | `captain` for order creation and captain cancellation operations; operational settings also allow `captain` |
| KOT / Kitchen | Active preparation queue, individual Ready/Undo Ready, table-wide Ready/Undo Ready | `kot` for queue read and status updates |
| Cashier | Takeaway creation, bill-request queue, bill generation, payment confirmation | `cashier` for takeaway/order billing and payment |
| Manager | Operational supervision through Captain, KOT and Cashier workspaces; no Admin configuration | `manager` is explicitly accepted by the operational RPCs used by those workspaces |
| Admin | Configuration, inventory, reporting, discounts, cancellations, PIN management and operational override | `admin` on Admin-only RPCs; Admin shares the KOT Ready RPC for Table Manager status controls |

There is no separate `POS` panel in the current registry. Staff dine-in POS is the Captain workspace; takeaway entry is in Cashier. Customer QR ordering is a separate public/session-token flow.

## Additional checks completed

- Panel token validator binds the token to the signed-in owner, tenant, expiry, revocation state and allowed panel ID.
- KOT queue RPC accepts `kot` and `manager`; Ready RPCs accept `kot`, `manager` and `admin`.
- Cashier bill queue accepts `cashier`/`manager`; bill generation and payment accept `cashier`/`manager`/`admin`.
- Admin inventory and reporting RPCs are restricted to the `admin` panel token.
- Four Flavours has one configured PIN credential for each of the five workspaces. A panel access token is short-lived and is created only when that workspace is unlocked; no active Cashier/Manager token during an idle inspection is expected.
- The public QR/session RPCs remain callable anonymously by design; their protection is the table/session token and PIN/rate-limit checks, not an employee-panel token.
- RLS policies on owner-managed menu/order tables remain tenant-owner scoped. The private token, inventory-ledger, and audit tables intentionally do not expose direct anonymous table policies; application reads/writes go through server functions.

## Deployment

1. On the connected RMS production project, the hotfix has already been applied; do **not** rerun the migration there. On another/staging database with the same preflight prerequisites, apply `sql/KOT_READY_SNAPSHOT_VARIABLE_HOTFIX.sql` once.
2. Run `sql/VERIFY_KOT_READY_HOTFIX.sql` and require the five trigger checks to be true. Confirm all five panel PIN credential rows are present.
3. Deploy the updated website ZIP to the existing GitHub/Vercel project.
4. In the Kitchen workspace, test one pending dish with individual Ready; verify the UI refreshes and the ready marker appears.
5. Test Ready table on an open test table, then test Undo Ready from both KOT and Admin → Table Manager. Do not use a table with a customer waiting or an unpaid order that should remain in service for this test; do not pay or close the real Table 1 order as part of a smoke test.

The application regression suite validates source structure and contracts; the database hotfix verification and controlled browser smoke test are separate requirements. No Strict Inventory setting is enabled by this hotfix.


## Additional frontend role defect fixed

The Cashier POS initialized its new cart with `orderType='takeaway'`, but a later shared event-wiring block ran `state.setOrderType('dine_in')` for every non-customer panel. This silently converted the Cashier cart back to dine-in, while the Cashier UI correctly hid order-type selection and the submit handler correctly rejected non-takeaway carts. The unconditional reset has been removed. Captain remains dine-in, Cashier remains takeaway, and customer QR ordering remains dine-in. A regression test now guards this initialization path.

## Live database smoke test

A rollback-only transaction exercised the actual Preparing trigger on one pending item from open Table 1 / order #7. The trigger created a recipe usage snapshot inside the transaction, then the transaction intentionally rolled back. The item was verified to remain `pending`, both usage timestamps remained null, and no stock-sale movement was created. This validates the database trigger path without changing that open order or its stock balance. A final real browser check on the newly deployed ZIP is still required.
