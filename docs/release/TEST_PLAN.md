# TableForge / RMS — Complete Release Test Plan

**Purpose:** Release-gate checklist for the multi-restaurant restaurant management system. This plan covers source integrity, tenant isolation, role authentication and permissions, customer QR ordering, dine-in rounds, KOT, table operations, takeaway, billing/payments, inventory, analytics, realtime behavior, accessibility/responsive UI, security, performance, and deployment/rollback.

**Execution policy:** Mark a case `PASS` only after observing the expected result in the stated environment. Static source checks do not prove runtime or database behavior. Database-dependent cases remain `BLOCKED` until the live Supabase schema/RPC/RLS export and a safe test environment are available. Never run destructive tests against production data.

## Current validation snapshot (2026-10-19)

- `npm run verify`: PASS — JavaScript syntax/import/manifest checks, SQL lexical structure, and 30 source/unit tests for the current release package.
- SQL migration parsing: lexical structure only; no PostgreSQL server is available in this workspace, so the migration has **not** been executed against PostgreSQL or Supabase.
- Browser end-to-end tests: NOT RUN.
- Live Supabase post-migration checks: NOT RUN.
- Release status: **NOT CLEARED FOR PRODUCTION** until a restorable staging clone passes the migration and all blocked integration tests.

## Status definitions

- `PASS` — executed and evidence recorded.
- `FAIL` — executed and did not meet acceptance criteria; log defect and retest after fix.
- `BLOCKED` — required environment, credentials, schema, data, or external integration is unavailable.
- `NOT RUN` — not yet executed.

## A. Source, build, and release artifact

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| A01 | JavaScript syntax | Run `node --check` against every `.js` file. | No syntax errors. | PASS (local source check) |
| A02 | Relative imports | Resolve every relative static/dynamic import. | Every import points to an existing file. | PASS (unit test) |
| A03 | Protected route dispatch | Inspect route-to-module dispatch for Admin, Manager, Captain, KOT, Cashier. | Each route dispatches to the intended module. | PASS (source integrity test) |
| A04 | Missing browser dependencies | Load app with browser console open. | No uncaught ReferenceError/TypeError or missing asset. | NOT RUN |
| A05 | Clean production build | Run `npm run verify` in a clean checkout. | Source syntax, imports, manifest, SQL lexical structure, and unit/source-integrity tests pass. No bundler build is configured. | PASS (verification script; not a production build) |
| A06 | Test suite | Run `npm test`. | All current unit/source-integrity tests pass. | PASS (30 tests, 2026-10-19; source/static checks only) |
| A07 | No accidental secrets | Scan shipped source for hardcoded service-role credentials and scan Git history separately. | No service-role credential found in current shipped source; Git-history scan and external secret scanning remain outstanding. | PARTIAL (automated source test passed) |
| A08 | Asset integrity | Check every HTML/CSS/manifest/service-worker asset URL. | All required assets exist and return success. | NOT RUN |
| A09 | PWA manifest | Validate manifest JSON, icon MIME types and referenced paths. | Valid manifest; icons load with correct MIME type and dimensions. | NOT RUN |
| A10 | Service worker update | Deploy a version bump, load old client, then reload. | New version activates without leaving stale incompatible assets. | NOT RUN |
| A11 | Error logging | Force a handled API/network failure. | Useful safe message appears; no sensitive token or PIN is logged. | NOT RUN |
| A12 | Release archive | Extract final ZIP into a clean directory. | All required source/assets/tests/docs included; no machine-specific files. | NOT RUN |

## B. Tenant onboarding and isolation

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| B01 | Operator-only onboarding | Create a restaurant using the authorized backend/operator workflow. | Restaurant is created only by authorized operator; no public self-registration is exposed. | BLOCKED |
| B02 | Restaurant identity | Sign in as restaurant A and inspect active tenant context. | All requests and visible branding are scoped to A. | BLOCKED |
| B03 | Restaurant B isolation | Repeat for restaurant B. | B sees only B's tables, menu, orders, staff PIN config, settings and analytics. | BLOCKED |
| B04 | Cross-tenant read attempt | With A's session, request B's known row IDs directly. | Backend denies or returns no B data. | BLOCKED |
| B05 | Cross-tenant write attempt | Attempt to modify B's product/order/table using A's token. | Backend rejects write; no B data changes. | BLOCKED |
| B06 | Tenant switching | Sign out A, sign in B in the same browser. | No A state, cached records, open drawer, or branding leaks into B. | NOT RUN |
| B07 | Local storage isolation | Inspect browser storage across two tenant logins. | Tenant-specific state is keyed/scoped safely; no shared sensitive state. | NOT RUN |
| B08 | Realtime isolation | Create an order in A while B is open. | B receives no A order/notification; A receives its own update. | BLOCKED |
| B09 | Branding isolation | Change logo/colors for A and open B. | A's branding changes only for A; B remains unchanged. | BLOCKED |
| B10 | Disabled/deleted tenant | Disable a test tenant and attempt new login/actions. | Access is denied and active tokens are invalidated as designed. | BLOCKED |

## C. Authentication, panel PINs, and authorization

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| C01 | Restaurant email/password | Enter valid account credentials. | Correct tenant/account session opens. | BLOCKED |
| C02 | Invalid password | Enter incorrect password. | Access denied with generic error; no account enumeration. | BLOCKED |
| C03 | Role selection | Open panel dashboard after login. | Captain, KOT, Cashier, Manager, Admin options are clear and correctly routed. | NOT RUN |
| C04 | Valid role PIN | Enter a configured PIN for each panel. | Only the selected panel is unlocked and receives a short-lived scoped grant. | BLOCKED |
| C05 | Invalid role PIN | Enter a wrong PIN. | No access token; inputs clear/reset with consistent animation. | BLOCKED |
| C06 | PIN length/input | Enter 1–5 digits, letters, paste, and a sixth digit. | Exactly six numeric digits accepted; keyboard/paste behavior is safe and consistent. | NOT RUN |
| C07 | PIN brute force | Repeatedly submit invalid PINs in a test tenant. | Rate limiting/backoff/lockout works at the backend; no frontend-only protection. | BLOCKED |
| C08 | PIN not retrievable | Open Admin PIN manager. | Only configured/masked status is shown; plaintext/hash is never returned. | BLOCKED |
| C09 | Change panel PIN | Admin verifies current Admin PIN, sets a new PIN for each role. | Only valid six-digit PINs are accepted; success status updates; no PIN is exposed in logs. | BLOCKED |
| C10 | Wrong Admin verification | Try to open PIN manager with incorrect Admin PIN. | Management token is not issued; no PIN changes can be made. | BLOCKED |
| C11 | PIN management token expiry | Wait until token expires and attempt save. | Backend rejects expired token; UI asks to reauthorize. | BLOCKED |
| C12 | Role boundary enforcement | Call privileged RPCs with a lower-role token. | Backend denies unauthorized operations regardless of UI hiding. | BLOCKED |
| C13 | Session expiry | Let staff grant/auth session expire. | Protected operations stop; user is returned to an appropriate lock screen. | BLOCKED |
| C14 | Logout/tenant change | Log out or switch tenant while panel is open. | Panel grants and sensitive in-memory state are cleared. | NOT RUN |
| C15 | Admin override scope | Attempt Admin-only action as Manager/Cashier/Captain. | Only explicitly authorized Admin actions succeed. | BLOCKED |

## D. Customer QR access and table sessions

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| D01 | Valid printed QR | Scan a QR generated by TableForge. | Correct table and restaurant menu open with explicit scan marker. | NOT RUN |
| D02 | Direct URL without scan marker | Open occupied-table URL without `scan=true`. | Existing session token cannot silently reopen a customer ordering session; existing scan guidance/expiry behavior is shown. | PASS (source-level unit test only) |
| D03 | Invalid table ID | Open malformed/nonexistent table URL. | Safe unavailable/invalid-table page; no unrelated table data. | BLOCKED |
| D04 | Inactive table | Scan a disabled table QR. | Ordering is denied and user sees clear guidance. | BLOCKED |
| D05 | Table occupied by another session | Open QR for occupied table on a fresh device. | Behavior follows approved policy; no unauthorized session takeover. | BLOCKED |
| D06 | Expired session | Reopen a QR after session closure/expiry. | Existing session-expired screen appears, centered and aligned. | NOT RUN |
| D07 | Customer refresh/back | Refresh and use browser back during menu/review/thank-you. | No duplicate order/payment; closed sessions remain closed. | BLOCKED |
| D08 | Public access boundary | Open customer menu without staff login. | Customer ordering works without staff authentication, but staff/admin APIs remain inaccessible. | BLOCKED |
| D09 | Customer sees linked tables | Open a linked/group table session. | Customer can view permitted group orders but cannot order for another table. | BLOCKED |
| D10 | Customer call Captain | Tap Call Captain. | A table/session-scoped request appears to staff once and can be acknowledged. | BLOCKED |
| D11 | No remote order bypass | Attempt direct API submission without valid active table/session proof. | Backend rejects request. | BLOCKED |
| D12 | Session concurrency | Two devices order on same active table. | Orders serialize safely; no lost/duplicated line items or sessions. | BLOCKED |

## E. Customer menu, cart, and order lifecycle

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| E01 | Menu loads | Open active customer menu. | Correct tenant's active products, prices, images and categories display. | BLOCKED |
| E02 | Unavailable product | Mark a product inactive in test data. | It cannot be ordered from stale UI or direct API. | BLOCKED |
| E03 | Add/increment/decrement | Add product, increment, decrement, remove. | Quantities and totals remain valid; zero quantity removes item. | PASS (unit test for state logic) |
| E04 | Quantity bounds | Attempt zero, negative, decimal and extreme quantities. | Values are normalized/rejected by both UI and backend. | PASS (unit test for normalization) |
| E05 | Cart persistence | Navigate between menu and review. | Current draft remains as intended; no cross-tenant/table bleed. | NOT RUN |
| E06 | Review before submit | Tap Next and inspect order review. | Review shows correct item, quantity, notes and total before final submit. | NOT RUN |
| E07 | Submit customer order | Confirm valid order. | Exactly one order/round is created and linked to active session/table. | BLOCKED |
| E08 | Double tap/retry | Rapidly submit twice or retry after network timeout. | Idempotency prevents duplicate orders/charges. | BLOCKED |
| E09 | Network lost on submit | Disconnect network, submit, reconnect. | Clear retry status; no duplicate or falsely confirmed order. | BLOCKED |
| E10 | Order received animation | Confirm order. | Minimal premium steam/message animation lasts approximately five seconds, then advances correctly. | NOT RUN |
| E11 | Order more | Place round 1 then add another round. | New round is created; previous items remain visible and immutable. | BLOCKED |
| E12 | Customer order history | Open current live order view. | All rounds and item statuses display without limiting to one order. | BLOCKED |
| E13 | Customer bill request | Request physical bill. | Bill request is registered once and appears in Cashier/Admin queue. | BLOCKED |
| E14 | Thank-you after payment | Complete payment through staff flow. | Customer sees animated thank-you; refresh/back then shows session-expired page. | BLOCKED |
| E15 | Tax/rounding | Use known taxable and exempt items. | Tax and grand total match server-calculated expected amounts. | PASS (unit test for calculations only) |

## F. Captain panel

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| F01 | Captain PIN access | Unlock Captain. | Captain panel opens, no Admin-only settings exposed. | BLOCKED |
| F02 | Table overview | Open occupied/free tables. | Status, occupancy, order/bill alerts and table identity are accurate. | BLOCKED |
| F03 | Start dine-in order | Create a Captain order. | Dine-in is forced; table is required. | PASS (source-level check only) |
| F04 | Prevent takeaway | Try to switch Captain order to takeaway. | Takeaway selector is unavailable and backend rejects bypass. | NOT RUN |
| F05 | New table/order alert | Generate customer order/table event. | Relevant table highlights; clicking marks seen without creating an extra notification center. | BLOCKED |
| F06 | Bill request to Cashier | Request bill for table. | Request appears in Cashier queue and retains correct session/table. | BLOCKED |
| F07 | Cancel pending item | Cancel item before kitchen preparation. | Cancellation reason/audit is recorded and item is cancelled. | BLOCKED |
| F08 | Cancel preparing/ready item | Request cancellation after preparation starts. | Cancellation waits for Admin approval; item remains active until decision. | BLOCKED |
| F09 | Multi-round visibility | View table with several rounds. | All rounds/statuses visible; no old round disappears. | BLOCKED |
| F10 | Table close/expiry | Close paid table. | Session is closed once; future QR access is denied. | BLOCKED |

## G. KOT / kitchen

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| G01 | Empty kitchen | Open KOT with no active items. | Calm empty state; no fabricated/old tickets. | NOT RUN |
| G02 | Live new order | Submit customer/POS order while KOT is open. | New item appears without full-page reload. | BLOCKED |
| G03 | New → Preparing | Change status. | Status updates once and is reflected in all relevant views. | BLOCKED |
| G04 | Preparing → Ready | Change status. | Ready state is visually distinct and persisted. | BLOCKED |
| G05 | Ready → Served | Mark served. | Served state is distinct from Ready and persisted. | PASS (source test confirms control exists only) |
| G06 | Undo status | Undo each valid transition. | Only prior valid state is restored; no invalid transition accepted. | BLOCKED |
| G07 | Duplicate clicks | Double-click status action. | No duplicate events or inconsistent status. | BLOCKED |
| G08 | Cross-table grouping | Multiple tables and rounds active. | Tickets/items are grouped and labelled correctly. | BLOCKED |
| G09 | Kitchen permissions | Attempt to edit product/menu/bill from KOT. | Disallowed actions are absent and backend-denied. | BLOCKED |
| G10 | Realtime reconnect | Disconnect/reconnect KOT. | Queue recovers current state without duplicate tickets. | BLOCKED |

## H. Cashier and takeaway

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| H01 | Cashier PIN access | Unlock Cashier. | Cashier home opens with New Takeaway and Bill Requests. | NOT RUN |
| H02 | New takeaway mode | Open New Takeaway Order. | Takeaway remains selected; no table is required. | PASS (source test only) |
| H03 | Takeaway submit | Add products and submit. | Takeaway order is saved and sent to KOT without dining session dependency. | BLOCKED |
| H04 | Dine-in validation isolation | Open Captain and Cashier flows in sequence. | Cashier does not inherit Captain's table requirement or mode. | PASS (source test only) |
| H05 | Bill request queue | Customer/Captain requests a bill. | Correct table/session/order appears once with current status. | BLOCKED |
| H06 | Generate bill | Generate a bill for takeaway and dine-in. | Correct items, quantities, prices, taxes and table/session label appear. | BLOCKED |
| H07 | Print/download | Print and download bill. | Correct readable bill is produced with restaurant branding and no clipped content. | NOT RUN |
| H08 | Mark paid | Record payment using approved method. | Payment state changes once with actor/time/reference; session closes only when policy allows. | BLOCKED |
| H09 | Duplicate payment | Repeat payment action after success/timeout. | Duplicate payment is prevented or safely reconciled. | BLOCKED |
| H10 | Manager bill action | Use Manager grant to perform permitted Cashier action. | Allowed operating actions work; Admin-only actions remain denied. | PASS (source-level unit test only) |
| H11 | Queue refresh | New request arrives while queue open. | Queue updates live and preserves in-progress work. | BLOCKED |
| H12 | No table on takeaway | Generate/print takeaway bill. | Bill does not require or invent a dine-in table. | BLOCKED |

## I. Manager and Admin permissions

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| I01 | Manager access | Unlock Manager. | Manager dashboard opens with operating actions. | NOT RUN |
| I02 | Manager navigation | Open Captain/KOT/Cashier workspaces from Manager. | Manager grant remains valid and role context remains Manager. | BLOCKED |
| I03 | Manager forbidden settings | Try menu, tenant branding, security/PIN management, user/tenant config. | Denied in UI and backend. | BLOCKED |
| I04 | Manager cancellation approval | Attempt approval of preparing/ready cancellation. | Denied; Admin approval is required. | BLOCKED |
| I05 | Admin full access | Unlock Admin. | Admin operational/configuration sections are available. | BLOCKED |
| I06 | Admin settings save | Change supported setting and reload. | Valid values persist to database and are tenant-scoped. | BLOCKED |
| I07 | Menu CRUD | Add/edit/deactivate/delete product according to rules. | Changes persist; historic orders retain original price/item snapshot. | BLOCKED |
| I08 | Table CRUD | Add/edit/activate/deactivate table. | Validation works and QR is generated for correct table. | BLOCKED |
| I09 | Open-session deletion guard | Attempt to delete a table with an active session. | Delete is prevented; history remains intact. | BLOCKED |
| I10 | Admin cancellation queue | Submit cancellation request from Captain. | Admin sees request with item, table, reason and timestamp. | BLOCKED |
| I11 | Approve cancellation | Approve valid request. | Item/session/bill totals update consistently and audit is stored. | BLOCKED |
| I12 | Reject cancellation | Reject request with reason. | Item remains active and rejection reason/audit is recorded. | BLOCKED |
| I13 | Audit trail | Perform privileged edits. | Before/after, actor, action, reason and timestamp are recorded. | BLOCKED |

## J. Billing, tax, and payment integrity

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| J01 | Multi-round final bill | Create two or more rounds for one session. | Final bill merges all rounds while preserving round/item detail. | BLOCKED |
| J02 | Item snapshot integrity | Change product price after an order is placed. | Historical line item retains its recorded price/tax policy. | BLOCKED |
| J03 | Tax breakdown | Test CGST/SGST and exempt items with known values. | Correct per-line and aggregate tax, rounded per defined policy. | PASS (unit tests for calculation only) |
| J04 | Bill total reconciliation | Compare line totals, tax, discount and grand total. | Display, database, print and payment amount match. | BLOCKED |
| J05 | Paid bill immutability | Try editing a paid bill. | Original bill remains immutable; use adjustment/refund flow. | BLOCKED |
| J06 | Refund/adjustment | Apply permitted adjustment/refund in test environment. | Original payment remains auditable and net balance is correct. | BLOCKED |
| J07 | Concurrent bill request | Two staff members prepare the same bill. | Single authoritative bill state; no duplicate closure/payment. | BLOCKED |
| J08 | Payment failure | Simulate rejected/cancelled payment. | Bill remains unpaid; customer is not shown successful thank-you. | BLOCKED |
| J09 | Bill print branding | Print with configured restaurant logo/icon/colors. | Correct tenant identity and readable invoice details. | NOT RUN |
| J10 | Bill request/paid state machine | Attempt invalid state jumps directly through API. | Backend rejects invalid transitions. | BLOCKED |

## K. Inventory and stock

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| K01 | Ingredient CRUD | Add/edit/deactivate ingredient. | Valid units/costs persist and tenant scope is enforced. | BLOCKED |
| K02 | Recipe mapping | Link products to ingredient quantities. | Recipe validation rejects invalid units/negative quantities. | BLOCKED |
| K03 | Opening stock | Enter initial stock. | Opening movement is recorded once and on-hand stock matches. | BLOCKED |
| K04 | Stock receipt/adjustment | Record incoming stock or adjustment with reason. | Movement ledger records actor, quantity, cost, timestamp and reason. | BLOCKED |
| K05 | Order consumption | Complete an order containing recipe-linked products. | Correct ingredient quantities are consumed once according to approved lifecycle. | BLOCKED |
| K06 | Cancelled order reversal | Cancel item before/after preparation according to policy. | Stock reversal/consumption follows policy and is not duplicated. | BLOCKED |
| K07 | Unit conversion | Use supported compatible units. | Conversion is accurate; incompatible units are rejected. | BLOCKED |
| K08 | Low-stock threshold | Move stock below threshold. | Correct warning appears for that tenant only. | BLOCKED |
| K09 | Forecast | Generate usage/forecast view. | Forecast labels data window and avoids misleading output for insufficient data. | NOT RUN |
| K10 | Concurrent stock changes | Two users update stock simultaneously. | No lost updates or negative stock unless explicitly allowed. | BLOCKED |

## L. Reports, analytics, and audit

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| L01 | Revenue totals | Compare report with known paid orders. | Revenue includes/excludes states exactly as documented. | BLOCKED |
| L02 | Date boundaries | Query daily/monthly reports around midnight and month end. | Restaurant-local timezone boundaries are correct. | BLOCKED |
| L03 | Product analytics | Compare top products to known line items. | Ranking/quantity/revenue use consistent definitions and date filters. | BLOCKED |
| L04 | Ingredient usage | Compare ingredient usage to recipes and completed orders. | Usage totals reconcile with stock ledger. | BLOCKED |
| L05 | Audit dashboard | Perform several actions and filter audit. | Correct action, actor, time, tenant and details appear. | BLOCKED |
| L06 | Empty datasets | Open analytics with no orders/data. | Helpful empty state, no NaN/invalid charts. | NOT RUN |
| L07 | Large dataset | Test realistic high-volume data. | Pagination/aggregation is accurate and responsive. | BLOCKED |
| L08 | Report access | Attempt report APIs as lower role/other tenant. | Backend denies unauthorized data. | BLOCKED |

## M. Realtime, alerts, and concurrency

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| M01 | Order insert realtime | Add order from another device. | Relevant panel updates without reload. | BLOCKED |
| M02 | Status realtime | Change KOT status. | Captain/customer/admin views reflect the same persisted state. | BLOCKED |
| M03 | Bill request realtime | Request bill from customer and Captain. | Cashier/Admin receive one current request. | BLOCKED |
| M04 | Alert seen state | Click highlighted table/alert. | Seen state persists and highlight clears as intended. | BLOCKED |
| M05 | Tenant-scoped channel | Inspect realtime channel naming/policies. | Channels and payloads cannot leak across tenants. | BLOCKED |
| M06 | Reconnect/resubscribe | Drop network, reconnect. | Subscriptions recover without duplicate processing. | BLOCKED |
| M07 | Simultaneous edits | Two staff update the same item/session. | Locking/version/state rules prevent silent overwrites. | BLOCKED |

## N. Security and abuse resistance

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| N01 | RLS enabled | Inspect every tenant-owned table. | RLS enabled and correct policies exist; no public unrestricted writes. | BLOCKED |
| N02 | Anonymous RPC abuse | Call staff/admin RPCs anonymously. | Denied unless explicitly public customer RPC with strict session validation. | BLOCKED |
| N03 | Forged tenant ID | Replace restaurant/tenant ID in requests. | Backend derives/validates tenant from trusted context and denies cross-tenant access. | BLOCKED |
| N04 | Forged role token | Modify client panel ID or token payload. | Backend rejects untrusted client claims. | BLOCKED |
| N05 | SQL injection | Test string inputs in search/notes/reasons. | Parameterized SQL and validation prevent injection. | BLOCKED |
| N06 | XSS | Enter HTML/script-like product names, notes and reasons in test data. | Content renders as text; no script execution. | NOT RUN |
| N07 | PIN secrecy | Inspect network responses, console and local storage. | No plaintext PIN, secret key or long-lived management token leakage. | BLOCKED |
| N08 | CSRF/replay/idempotency | Replay sensitive requests in a test environment. | Auth/nonce/idempotency checks prevent unauthorized repeat effects. | BLOCKED |
| N09 | Public table discovery | Enumerate table UUIDs and tenant IDs. | Knowledge of an ID alone does not authorize session/order access. | BLOCKED |
| N10 | Error information | Force SQL/API errors. | Users see safe messages; internals/secrets are not exposed. | NOT RUN |
| N11 | Rate limits | Stress login, PIN, order submit and bill/payment endpoints. | Limits and safe throttling work at server edge/backend. | BLOCKED |
| N12 | Dependency/security scan | Run available dependency and static security scanners. | No unresolved release-blocking findings. | BLOCKED (no declared third-party dependencies or dependency-audit tool) |

## O. UX, accessibility, and responsive layout

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| O01 | Desktop layout | Test at 1440×900 and 1280×720. | No unintended page horizontal scroll; primary controls visible. | NOT RUN |
| O02 | Tablet layout | Test at 768×1024 and 1024×768. | Panels/cards fit and remain usable. | NOT RUN |
| O03 | Mobile layout | Test at 360×800, 390×844 and 430×932. | No clipped controls; intentional horizontal nav scrolling only. | NOT RUN |
| O04 | Light theme only | Inspect every route and dialog. | Consistent light theme; no unintended dark-mode rendering. | NOT RUN |
| O05 | Keyboard navigation | Navigate login, dialogs, menus and forms with keyboard. | Logical focus order and visible focus indicators. | NOT RUN |
| O06 | Screen reader labels | Inspect buttons/inputs/role selection. | Controls have accessible names and state descriptions. | NOT RUN |
| O07 | Modal behavior | Open/close every dialog with keyboard and pointer. | Focus is managed, escape/backdrop behavior is consistent, no stuck overlay. | NOT RUN |
| O08 | Form validation | Submit empty, malformed and boundary values. | Inline validation prevents invalid saves. | NOT RUN |
| O09 | Loading/error/empty states | Slow or fail requests. | Clear loading, retry and empty states; no frozen UI. | NOT RUN |
| O10 | Animations | Check order-sending, PIN error and thank-you animations. | Subtle, short, premium, motion-reduced alternative where appropriate. | NOT RUN |
| O11 | Printing | Print on common A4 and narrow receipt layouts. | Content fits and remains legible; no navigation/UI chrome in print. | NOT RUN |
| O12 | Browser coverage | Test current Chrome, Edge, Firefox and Safari where available. | Core workflows behave consistently. | NOT RUN |

## P. Performance and resilience

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| P01 | Initial load | Measure production first load on desktop/mobile network profiles. | Meets agreed performance budget; no avoidable large assets. | NOT RUN |
| P02 | Large menu | Load realistic large product/category dataset. | Search/filter/scroll remain responsive. | BLOCKED |
| P03 | Long order history | Load long session with many rounds/items. | No `.limit(1)` truncation; pagination/aggregation stays accurate. | BLOCKED |
| P04 | API timeout | Delay/fail Supabase requests. | UI recovers safely and offers retry without duplicate mutations. | NOT RUN |
| P05 | Repeated navigation | Navigate in/out of panels repeatedly. | No accumulating duplicate event handlers/subscriptions or runaway memory. | NOT RUN |
| P06 | Concurrent restaurant activity | Simulate multiple tables and staff users. | No lost events, duplicate bills, or inconsistent session state. | BLOCKED |
| P07 | Offline/poor network | Use browser offline/throttling. | Clear offline state; no false success; safe resynchronization. | NOT RUN |

## Q. Deployment and rollback

| ID | Test | Steps | Expected result | Initial status |
|---|---|---|---|---|
| Q01 | Environment configuration | Verify production Supabase URL/public key and allowed origins. | Correct production config; no service-role secret in browser. | BLOCKED |
| Q02 | Database backup | Take/verify restorable backup before migration. | Recovery point is available and restoration procedure documented. | BLOCKED |
| Q03 | Migration dry run | Apply migration to staging copy first. | Migration is repeatable/safe as designed and preserves existing data. | BLOCKED |
| Q04 | Schema post-check | Compare tables/functions/policies before and after migration. | All required objects exist and constraints/policies are correct. | BLOCKED |
| Q05 | Existing data preservation | Compare row counts, key IDs, prices and order history. | Existing restaurant data and Four Flavours records remain intact. | BLOCKED |
| Q06 | Production deployment | Deploy approved commit through authorized Vercel workflow. | Deployment succeeds with expected commit and environment. | BLOCKED |
| Q07 | Live smoke test | Visit deployed URL and exercise login, customer QR, KOT, Cashier, bill and Admin. | Critical flows work against production safely. | BLOCKED |
| Q08 | Rollback rehearsal | Roll back app deployment; verify database compatibility. | Previous app can run safely or documented recovery path works. | BLOCKED |
| Q09 | Monitoring | Inspect deployment logs, browser errors and Supabase errors after release. | No unresolved release-blocking errors. | BLOCKED |
| Q10 | Release handover | Record version, migration version, known limitations and rollback steps. | Release notes and evidence are complete. | NOT RUN |

## Release acceptance criteria

A release is **not** approved merely because source syntax or unit tests pass. Before production approval:

1. All release-blocking source/runtime issues are fixed.
2. All required RPCs exist with matching signatures and return shapes.
3. Tenant isolation and role authorization are verified by backend tests, including negative cross-tenant tests.
4. Core customer, kitchen, Captain, Cashier, Manager and Admin workflows pass in a staging environment.
5. Bills, taxes, payments, session closure and stock movements reconcile against database records.
6. RLS, PIN security, rate limiting and audit trails are verified.
7. Production migration has a backup, a validated execution order and a rollback/recovery plan.
8. The deployed site passes a post-deployment smoke test.

## Current execution snapshot

- Automated Node tests: **30 passed, 0 failed** for the updated local release package.
- JavaScript syntax checks: **26 files passed**.
- Relative import integrity: **passed**.
- SQL lexical/static structure check: **passed**; this is not PostgreSQL execution.
- Browser end-to-end tests: **not run**.
- Live Supabase integration/security tests: **not run by this workspace**. The user supplied a prior post-migration validation result with all listed checks marked PASS, but the new frontend changes still need live workflow testing.
- Production deployment: **not attempted**.

## Defect register (initial)

| ID | Finding | Risk | Required action | Status |
|---|---|---|---|---|
| DEF-001 | The baseline `sql/schema.sql` does not by itself represent the entire live release migration and RPC set. | High: applying the baseline schema alone can leave frontend/database contracts incomplete. | For an existing migrated database use the release-specific idempotent patch; for a new staging database use the coordinated master migration, then validate. | MITIGATED BY RELEASE MIGRATION; live end-to-end verification still required |
| DEF-002 | A package manifest and source-integrity test runner are now present, but no bundler, browser automation, or dependency-audit configuration is included. | High: reproducible production build, browser automation and dependency auditing are not yet standardized. | Confirm intended static deployment workflow; add browser E2E and dependency-audit tooling if compatible with project. | OPEN |
| DEF-003 | Static tests prove source shape, not runtime correctness or database authorization. | High: integration and security behavior remains unverified. | Run staging browser and Supabase integration tests before release. | OPEN |


## Release execution order

1. Create/verify a restorable Supabase backup and use a staging clone first.
2. Apply `sql/MASTER_MIGRATION_TABLEFORGE.sql` to staging. If any statement fails, stop; because the script is transactional, confirm that the transaction rolled back before retrying.
3. Run `sql/POST_MIGRATION_VALIDATION.sql`. Investigate every `FAIL` or unexpected `WARN`; do not deploy on unresolved security or data-integrity failures.
4. Run `npm run verify` from the project root.
5. Execute all browser/database cases marked `BLOCKED` in a real browser against staging, including customer QR ordering and all five panel permissions. Record evidence and retest defects.
6. Deploy the matching frontend and database version together. Do not apply only the SQL or only the frontend because RPC signatures and direct table access were changed as a coordinated release.
7. Repeat the post-migration checks against production after the approved deployment window and confirm existing order/session counts against the saved pre-migration snapshot.

## Scope boundary

The automated tests in this repository are source-integrity and static contract checks. They do not simulate PostgreSQL execution, Supabase RLS, real authentication, realtime, printers, payment confirmation, or browser workflows. Those require staging/live integration tests and must not be marked PASS based only on source checks.


## P. Release-specific UI/navigation/date regressions

These cases were added for the 2026-10-19 TableForge source update. Static test coverage for route mapping, panel sign-out hooks, the navigation confirmation guard, shared date-picker adoption, and date-range serialization passes locally. Complete the browser cases in staging before production use.

| ID | Test | Steps | Expected result | Status |
|---|---|---|---|---|
| P01 | Captain route dispatch | Open `#/workspace/captain` using Live Server after a hard refresh. | Captain module loads; no `Unsupported route: captain` error. | STATIC PASS; BROWSER NOT RUN |
| P02 | Captain panel exit | Unlock Captain, select Sign out. | Confirmation appears; confirm returns to panel selection and clears the panel grant, not the restaurant's shared email/password session. | STATIC PASS; BROWSER NOT RUN |
| P03 | KOT panel exit | Unlock KOT and use top-right Sign out. | Same panel-only sign-out behavior. | STATIC PASS; BROWSER NOT RUN |
| P04 | Cashier home exit | Unlock Cashier and use top-right Sign out. | Same panel-only sign-out behavior. | STATIC PASS; BROWSER NOT RUN |
| P05 | Cashier takeaway creation | Open New takeaway order. | Order opens as takeaway without a redundant Takeaway dine-in toggle or table selection. | STATIC PASS; BROWSER/DB NOT RUN |
| P06 | Cashier bill requests exit | Open Bill requests and locate Sign out. | Sign out is available and returns to panel picker after confirmation. | STATIC PASS; BROWSER NOT RUN |
| P07 | Manager exit | Unlock Manager and use Sign out. | Confirmation appears and clears panel authorization only. | STATIC PASS; BROWSER NOT RUN |
| P08 | Admin exit | Unlock Admin and use top-right Sign out. | Admin panel authorization clears; shared restaurant account remains authenticated. | STATIC PASS; BROWSER NOT RUN |
| P09 | Browser Back guard | Unlock a panel, press browser Back or navigate away from workspace. Choose Cancel. | The workspace is restored and remains unlocked. | STATIC PASS; BROWSER NOT RUN |
| P10 | Confirm browser exit | Repeat P09 and choose OK. | Panel grant clears and user returns to panel selection. | STATIC PASS; BROWSER NOT RUN |
| P11 | Date range parity | Inspect Orders/Bill History, Top Products, Ingredient Usage, and Audit Dashboard. | All four use the same presets and custom Start/End date UI. | STATIC PASS; BROWSER NOT RUN |
| P12 | Invalid date range | Set End date earlier than Start date and click Apply. | Visible validation error; report does not run with invalid range. | STATIC PASS; BROWSER NOT RUN |
| P13 | Orders custom range | Apply a custom range and compare to known test orders using Asia/Kolkata boundaries. | Start day included from local midnight; end day fully included; next day excluded. | STATIC PASS; LIVE DATA NOT RUN |
| P14 | Inventory custom range RPC | Deploy frontend and apply `sql/DATE_RANGE_REPORT_PATCH.sql` in a safe database; query `range:YYYY-MM-DD:YYYY-MM-DD`. | Inventory RPC accepts range format and respects inclusive start/end dates. | PATCH STATIC CHECKED; POSTGRES NOT RUN |
| P15 | Reports without connected source | Open Top Products and Audit Dashboard. | UI clearly identifies data source as not connected; no fake ranking/audit data is presented. | STATIC SOURCE CHECK; BROWSER NOT RUN |

## Scope limitations for this update

The current source update fixes the known Captain route dispatch gap, removes the redundant Cashier Takeaway selector, provides panel-level sign-out/navigation prompts, and standardizes the date-range control across the four identified Admin reporting modules. It does **not** turn the Top Products or Audit Dashboard placeholders into live reports, does not prove Supabase workflows are correct, and does not replace browser-level QA. Do not mark these limitations as passed solely because the static suite is green.
