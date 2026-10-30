# TableForge immediate repair and acceptance test plan

## Required order of work

1. Back up the correct Supabase project and confirm the restaurant tenant.
2. Apply `sql/IMMEDIATE_BILL_AND_ANALYTICS_FIX.sql` once in Supabase SQL Editor. It is incremental and assumes the TableForge master and workflow migrations already exist. Do not run against an unrelated project.
3. Check the SQL Editor result and inspect the Functions list. If any statement fails, stop; a failed transaction should roll back. Do not continue testing payment confirmation after a migration error.
4. Deploy the included code to the Vercel project connected to the intended Git repository. Hard-refresh after deployment.

## Customer/POS menu

- Open the menu fresh: it must open directly to the dish grid, with cuisine `All` and category `All`.
- Choose category `Starters` while cuisine is `All`: items from every cuisine should appear.
- Choose cuisine `Indian`: only categories that exist for Indian products should be offered.
- Choose `Indian` + `Starters`: only Indian starters should appear.
- Reset to `All` and verify no dish is hidden by a stale URL hash.
- Select Dine-in and choose a table; verify only the intended active table/session can receive orders.
- As Captain, verify Takeaway is not offered. As Cashier, verify the POS order-type/table selector is not offered and takeaway-only controls remain.

## Cashier bill generation (use an unpaid test table/order)

- Submit/serve a test order and request a bill only after all billable dine-in items are served.
- Select a payment method deliberately: UPI QR, Cash, Card or Bank transfer.
- Click `Open / Reprint Bill`. Confirm the receipt total and item list match the server-generated bill and payment method is the selected value.
- Confirm bill generation does **not** mark the bill paid.
- Re-open/reprint the same bill. Verify no duplicate bill/order is created.
- Confirm payment only after manually verifying the payment. Verify session/order becomes paid/closed once and subsequent confirmation is rejected as already paid.
- For an invalid/unavailable method, verify a visible, actionable error; never mark payment paid to bypass an RPC error.

## Admin reporting

- Revenue: test Today, Last 7 days, custom From/To and All time. Paid revenue includes only paid bills; issued and outstanding bills are displayed separately.
- Product Analytics: paid quantities, sales totals, category totals and cancelled quantities should load. Product profitability remains unavailable until recipes and ingredient costs are present and validated.
- Top Products: switch between quantity and revenue ordering; change the reporting period.
- Activity & Audit: filter categories and date ranges, search a known stored event, and verify the results are tenant-scoped.
- If a report reports a missing RPC/permission/schema error, record the exact RPC error and stop; do not replace missing data with sample values.

## Tenant isolation and roles

- Repeat report and bill smoke tests for a second test restaurant. No product, bill, inventory, audit row or aggregate should cross restaurant boundaries.
- Confirm Admin can access all Admin reports, Manager only sees allowed operational sections, Cashier can issue bills and confirm verified payments, and Captain cannot generate takeaway bills or perform Admin-only actions.
- Test PIN/session expiry and sign-out; a stale panel token should fail closed.

## Scope and limitations

`npm run verify` performs JavaScript syntax checks, SQL lexical/structure checks, and source regression tests. It does not execute SQL against PostgreSQL, simulate the browser, or verify the production Supabase/Vercel deployment. Always perform the manual acceptance tests above on staging before production use.
