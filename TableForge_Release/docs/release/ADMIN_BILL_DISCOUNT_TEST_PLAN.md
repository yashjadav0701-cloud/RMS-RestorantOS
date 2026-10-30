# TableForge Admin Bill Discount — Release Test Plan

## Scope and business rules

- Admin only: the RPC validates the signed, unexpired Admin panel token and resolves the restaurant from that token. IDs from another tenant must be rejected.
- Eligible bills: bill-ready dine-in sessions that are not closed or paid, and bill-ready/issued takeaway orders that are not completed, cancelled, closed or paid.
- Discount types: percentage (0–100) or fixed currency amount (0 through subtotal). Entering zero removes a previous discount.
- Tax and rounding are recalculated on the server, not trusted from the browser.
- Every update records an audit event. A paid/closed bill is never changed by this RPC.
- Dine-in discounts are stored on the consolidated dining session, not copied into every round; takeaway discounts are stored on that order.
- The shared bill renderer shows the discount as a separate line between subtotal and GST. Cashier reprints recalculate from the authoritative session discount.

## Deployment order

1. Back up the target Supabase project.
2. Confirm the project's schema already has `MASTER_MIGRATION_TABLEFORGE.sql`, `TABLEFORGE_WORKFLOW_FIX_PATCH.sql` and `IMMEDIATE_BILL_AND_ANALYTICS_FIX.sql` applied. Do not rerun the master migration solely to add discounts.
3. Run `sql/ADMIN_BILL_DISCOUNT_PATCH.sql` in the correct project's Supabase SQL Editor. If any SQL statement fails, stop and capture the exact error; do not bypass it or mark a bill as paid as a workaround.
4. Deploy the updated project to the Vercel-connected Git repository.
5. Hard-refresh the site and sign in again to obtain a fresh Admin panel token.

## Manual acceptance tests

Use an unpaid test session/order in a non-customer-facing test setup.

1. Open a bill-ready dine-in bill in Admin. The Discount action is visible only in the Admin panel; it is not shown in Manager/Cashier views.
2. Apply 10% to a subtotal of ₹1,000. Expected discount: ₹100. GST is recalculated server-side against the discounted taxable base; the final rounded total is shown on the shared receipt.
3. Change the same bill to a fixed ₹75 discount. Expected discount: ₹75, not ₹175. The value is replaced, not stacked.
4. Enter `0` to remove the discount. Base tax, rounding and grand total return to the undiscounted values derived from the source orders.
5. Apply a ₹75 fixed discount to an unpaid takeaway bill, then reopen/reprint it in Cashier. Both Admin and Cashier must show the same discount line and total.
6. Verify a reason supplied by Admin appears in the corresponding security/audit event.
7. Try a negative amount, a percentage above 100, a fixed amount above subtotal and a null value. All must fail without changing the bill.
8. Try a different restaurant's session/order ID with the current Admin token. It must be rejected without revealing data.
9. Try with Manager or Cashier panel token. It must be rejected.
10. Try to change an already paid or closed bill. It must be rejected. Do not use a real customer bill for this test.
11. Confirm that generating/reprinting a bill does not mark it as paid, and explicit payment confirmation still records payment only once.
12. Check mobile and desktop receipt/PDF output: Discount line between Subtotal and GST, accurate taxes and grand total.

## Automated verification

From the project directory, run:

```bash
npm run verify
```

This checks JavaScript syntax, local imports, static SQL structure and regression tests. It does **not** execute SQL in PostgreSQL and does not replace the live acceptance tests above.
