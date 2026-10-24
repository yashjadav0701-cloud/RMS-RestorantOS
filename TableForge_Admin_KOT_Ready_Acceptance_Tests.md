# TableForge — Admin Table Open and KOT Ready Acceptance Tests

## Before testing

- Back up Supabase.
- Apply `sql/ADMIN_KOT_READY_ALIGNMENT_PATCH.sql` after the existing master and workflow migrations.
- Run `sql/ADMIN_KOT_READY_ALIGNMENT_AUDIT.sql` and `sql/POST_MIGRATION_VALIDATION.sql`.
- Deploy the matching website source.
- Keep strict inventory disabled until kitchen recipes and opening quantities are verified.

## Required tests

1. **Admin Table Open — single dish:** open an active table. A pending/preparing dish should show `READY`, not `START PREPARING`. Clicking Ready marks it served for bill eligibility and retains a reversible Ready marker.
2. **KOT position stability:** click Ready on a dish in the middle of a queue. The card must remain in the same relative position; queue sorting is based on creation time/round, not status.
3. **Undo Ready:** click Undo Ready. The item returns to preparing, its KOT marker is cleared and no duplicate stock movement is inserted.
4. **Table-wide Ready:** on a table with multiple pending/preparing/ready dishes, click Ready table. All eligible items must be updated atomically. If strict inventory checks fail for any dish, the transaction must reject as a whole rather than partially marking the table ready.
5. **Table-wide Undo Ready:** undo only items marked ready through this workflow. Ordinary served items must not be included.
6. **Bill gate:** while the table is open or bill-requested, Ready/Undo Ready controls are available. After the bill is generated (`bill_ready`), KOT queue no longer shows the ticket and Admin's Table Open no longer allows Ready-state changes.
7. **Tenant isolation:** a panel token from one restaurant cannot change an item or table belonging to another restaurant.
8. **Inventory disabled:** the Ready flow should not fail solely because inventory mode is disabled.
9. **Strict inventory (only after recipe/stock verification):** missing or estimated recipes and insufficient stock must reject Ready without partial deduction; repeated Ready/Undo actions must not duplicate sale movements.
10. **PIN aspect ratio:** verify all six PIN boxes on Captain, KOT, Cashier, Manager and Admin screens at 320px, 360px, 390px and desktop widths. Each should be 5:6 and remain within the card.

## Database audit expected results

- All five order-item marker columns exist.
- `set_kot_item_status`, `set_kot_table_ready`, and `get_kot_queue` exist with the signatures in the patch.
- Anonymous execution is revoked for the operational RPCs.
- `order_items_restaurant_mismatch` and `ready_marker_without_served_status` return zero.
- `actionable_items_on_prepared_bills` returns zero. Investigate any non-zero result before production use.

Automated tests do not replace these browser tests against the deployed website and live Supabase database.
