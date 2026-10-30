# Four Flavours — Premium Restaurant POS v2

Vanilla JavaScript + Supabase restaurant ordering and management SPA.

## v2 architecture

This version is built around a single restaurant/table dining-session concept.
A table visit has one `dining_sessions` row. Every customer/POS ordering round
is an `orders` row linked to that session. The final bill is calculated once for
the complete session.

### Customer flow

```text
Scan QR
  ↓
Menu only
  ↓
Add dishes
  ↓
Next
  ↓
Review
  ↓
Confirm order
  ↓
Order received
  ├── Order more → menu → another round
  └── Bill → request final bill
              ↓
        staff prepares bill
              ↓
          View final bill
```

The customer never sees a running bill on the menu. Bill totals/details are
only returned after the session reaches `bill_ready` or `closed`.

### Main UI changes

- No page-level horizontal scrolling.
- Product images use one `4:3` media ratio across devices.
- Main POS has no permanent cart/bill pane.
- POS order review appears only after **Next**.
- Customer cart/order review appears only after **Next**.
- Long products, tables and session lists live inside vertical scroll containers.
- The Four Flavours logo/icon is centered at the top of each interface.
- Forest green / olive / warm cream / subtle gold palette is based on the
  supplied green cutlery icon.
- Phosphor icons are used for actions instead of repeated text labels.
- Desktop, tablet and mobile breakpoints have intentionally different density.
- No browser `alert()`, `confirm()` or `prompt()` is used anywhere.
- Table add/edit/delete uses branded in-site modals.

## File tree

```text
four-flavours-pos/
├── assets/
│   ├── images/
│   │   ├── website_icon.svg
│   │   └── website_logo.svg
│   └── icons/
├── src/
│   ├── core/
│   │   ├── config.js
│   │   ├── supabase.js
│   │   ├── posState.js
│   │   └── router.js
│   ├── components/
│   │   ├── navigation.js
│   │   └── lockScreen.js
│   ├── pos/
│   │   └── index.js
│   ├── customer/
│   │   └── index.js
│   └── admin/
│       └── index.js
├── sql/
│   └── schema.sql
├── index.html
├── styles.css
├── app.js
└── README.md
```

## Database upgrade

Run `sql/schema.sql` in Supabase SQL Editor.

It is designed to preserve the existing menu/data and add the new dining
session layer. It also upgrades `orders` and `order_items` with the fields
needed for consolidated billing.

After running the schema, verify that these tables/functions exist:

```text
public.dining_sessions
public.ensure_customer_session(...)
public.get_customer_session_state(...)
public.place_customer_order(...)
public.request_session_bill(...)
public.mark_session_bill_ready(...)
public.get_customer_session_bill(...)
public.complete_session_payment(...)
```

## Supabase configuration

The supplied project already contains the latest browser-safe Supabase URL
and publishable/anon key from the uploaded codebase. Do not replace it with a
service-role/secret key.

## Admin account

Create an Auth user in Supabase:

```text
Authentication → Users → Add user
```

Then set that user's profile role and PIN:

```sql
update public.profiles
set
  role = 'admin',
  pin_hash = extensions.crypt(
    'YOUR_REAL_6_DIGIT_PIN',
    extensions.gen_salt('bf')
  )
where id = 'YOUR-AUTH-USER-UUID';
```

The web UI then requests:

```text
Email + Supabase password + 6-digit PIN
```

## Routes

```text
Staff POS:
/

Admin:
#/4

Customer table menu:
https://tff.vercel.app/?table=<TABLE_UUID>
```

`Ctrl+F` routes staff/admin users to `#/4`. The customer QR experience does
not expose the app drawer/navigation.

## Table management

Admin → Tables supports:

- Add table
- Edit table number
- Edit capacity
- Activate/deactivate table
- Delete table
- View/print table QR

The interface does not use browser prompts or confirmations.

Deletion keeps historical order rows safe through `ON DELETE SET NULL` on
historical table references. An active dining session should be closed before
deleting a table; the final production version can enforce that rule via an
additional delete RPC if required.

## Realtime

The POS subscribes to `orders` inserts and `dining_sessions` changes. This is
used to surface:

- new QR orders
- bill requests
- bill readiness changes

For higher-scale realtime fan-out, Supabase Broadcast can later replace or
supplement the Postgres Changes subscription.

## APP_VERSION cache busting

Current version:

```js
export const APP_VERSION = "2.0.0";
```

For a release, change it to e.g.:

```js
export const APP_VERSION = "2.0.1";
```

Then globally Find/Replace in `index.html`:

```text
Find:    v=2.0.0
Replace: v=2.0.1
```

Dynamic JavaScript-created asset URLs use:

```js
versionedAsset("assets/images/website_icon.svg")
```

so they automatically receive the current version query string.

## Local development

Do not use `file://`.

Use Python:

```bash
cd four-flavours-pos
python -m http.server 5173
```

Open:

```text
http://localhost:5173/
```

## Production next steps

For a complete enterprise rollout, add:

```text
Kitchen Display System
Inventory / stock ledger
Purchasing
Shift management
Cash drawer
Payment gateway/webhooks
Audit trail
Role/permission matrix
Offline/PWA POS queue
Multi-branch architecture
Automated migrations
Automated tests
Observability/error tracking
```

## Existing database workflow patch

If the database already has `MASTER_MIGRATION_TABLEFORGE.sql` and `DATE_RANGE_REPORT_PATCH.sql` applied, apply `sql/TABLEFORGE_WORKFLOW_FIX_PATCH.sql` once in Supabase SQL Editor. See `docs/release/WORKFLOW_FIX_PATCH_README.md` for the changed workflows and validation limits. Do not rerun the master migration merely to apply this patch.



## Latest workflow release

See `docs/release/WORKFLOW_FIX_PATCH_README.md`. The latest incremental patch adds per-restaurant workflow settings, a pre-bill payment-method requirement, and preparation-time inventory deduction when strict inventory is explicitly enabled. Never rerun the master migration for this patch.

## Immediate bill and analytics repair (2026-10-21)

The supplied current-release repair includes `sql/IMMEDIATE_BILL_AND_ANALYTICS_FIX.sql`.
Apply it once in the **correct Supabase project** after the existing
`MASTER_MIGRATION_TABLEFORGE.sql` and `TABLEFORGE_WORKFLOW_FIX_PATCH.sql` have
already been applied. It adds the missing `orders.payment_method` column seen
in the bill-generation error, updates payment-method functions/policy for UPI
QR, cash, card and bank transfer, and adds tenant-scoped reporting endpoints
for Revenue, Product Analytics, Top Products and Activity & Audit. It does not
mark a bill paid when a method is selected. Staff must still explicitly confirm
receipt of payment.

Do not run it against an unverified project. Back up the database first and
stop if SQL Editor reports an error. `npm run verify` checks JavaScript syntax,
SQL lexical structure and source regression tests, **not** PostgreSQL execution
or the production browser/deployment. Use `docs/release/IMMEDIATE_FIX_TEST_PLAN.md`
for a staged deployment and manual acceptance checklist. The SQL has not been
executed against the production database from this workspace.

## Admin bill discounts (incremental migration)

For an existing TableForge database, apply `sql/ADMIN_BILL_DISCOUNT_PATCH.sql` **after** `MASTER_MIGRATION_TABLEFORGE.sql`, `TABLEFORGE_WORKFLOW_FIX_PATCH.sql`, and `IMMEDIATE_BILL_AND_ANALYTICS_FIX.sql`. Do not rerun the master migration merely to add discounts. The patch stores discounts at the dining-session level for consolidated dine-in bills and at the order level for takeaway, restricts changes to Admin-token-authorized unpaid/open bills, logs the action and reason in the audit trail, recalculates tax/rounding, and preserves the discount through Cashier reprints.

Before production use, test: no discount, percent discount, fixed rupee discount, editing a discount, removing a discount with value `0`, invalid values, cross-tenant IDs, Manager/Cashier token rejection, paid bill rejection, closed bill rejection, same Admin and Cashier reprint totals, and correct printed/PDF discount lines. Automated source tests are not a substitute for running the SQL against the actual database.

## KOT and Admin Ready workflow alignment

After the master migration and workflow patch, run `sql/ADMIN_KOT_READY_ALIGNMENT_PATCH.sql` in Supabase. It adds the inventory-consumption marker columns used by the deployed trigger, installs the unified Ready/Undo Ready item and table RPCs, and updates the KOT queue response so marked-ready dishes remain visible until the bill reaches `bill_ready`. Then run `sql/ADMIN_KOT_READY_ALIGNMENT_AUDIT.sql` and `sql/POST_MIGRATION_VALIDATION.sql`. Do not enable strict inventory until affected recipes and opening stock are verified.


## Admin Table Open + KOT Ready alignment

See `docs/release/ADMIN_KOT_READY_ALIGNMENT_RELEASE.md`. The related migration is `sql/ADMIN_KOT_READY_ALIGNMENT_PATCH.sql`; its read-only audit is `sql/ADMIN_KOT_READY_ALIGNMENT_AUDIT.sql`. The patch fills missing inventory marker columns used by the existing trigger, uses one Ready/Undo Ready RPC path for Admin and KOT, keeps KOT-ready dishes in place until the bill is prepared, and disables Admin Ready controls after bill-ready. Apply the migration only after backing up and confirming the correct Supabase project. Strict inventory should remain disabled until recipe data and opening stock have been verified.


### Ingredient Usage calculation and automatic stock tracking

For an existing database that already has the Ingredient Usage reliability and always-calculate migrations, apply `sql/AUTOMATIC_NONBLOCKING_INVENTORY_PATCH.sql` once after the KOT snapshot hotfix. **It has already been applied to the connected RMS production project for Four Flavours; do not rerun it there.** Run `sql/VERIFY_AUTOMATIC_INVENTORY_MODE.sql` read-only to confirm. This provides three tenant modes: `disabled` (calculate only), `automatic` (deduct each saved recipe at first Preparing, including estimated recipes; never block the kitchen for low/zero stock; show negative balances as shortages), and `strict` (optional hard control requiring verified recipes and sufficient stock). Estimated deductions are tagged in the ledger and report as **Deducted · estimated recipe**. Only Four Flavours was switched to `automatic`; the second tenant remains disabled and future tenants default to disabled. Historical items calculated before activation are not retroactively deducted. See `docs/release/AUTOMATIC_INVENTORY_MODE.md`.
