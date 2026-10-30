# Admin Table Open + KOT Ready Alignment

This release makes Admin > Table Open and the KOT/Kitchen screen use the same Ready/Undo Ready state machine. It also standardizes all six-digit PIN boxes to a 5:6 portrait ratio.

## Key behavior changes

- Admin no longer advances dishes through a separate `set_order_item_status` status cycle. Individual Ready/Undo Ready actions call `set_kot_item_status`.
- The table-level Ready/Undo Ready action calls `set_kot_table_ready` and is constrained to a single open table/session.
- A KOT Ready item is stored as `serving_status = 'served'` plus `kot_ready_previous_status = 'preparing'` and a timestamp. That lets bill eligibility treat the dish as served while the ticket remains visible in KOT until the bill becomes `bill_ready`.
- Undo Ready restores the previous status and clears the KOT marker. It does not reverse a stock movement; stock reconciliation must remain its own audited workflow.
- Once a dining session is `bill_ready` or `closed`, Admin's table-open UI disables dish and table Ready actions. The database RPC also rejects mutations for those sessions.
- Queue sorting remains by order creation time, round number, and item creation time—not status—so changing an item does not send it to the bottom.
- All protected panel PIN screens use portrait 5:6 PIN boxes on desktop and mobile.

## Database audit findings at time of implementation

The connected `RMS` Supabase schema was read-only audited. `public.order_items` was missing `inventory_recipe_snapshot`, `inventory_consumed_at`, and `inventory_reconciled_at`, even though the existing inventory trigger referenced `NEW.inventory_consumed_at` and the table Ready RPC selected `oi.inventory_consumed_at`. Those missing columns explain the previous `42703` errors. Four Flavours' `inventory_mode` was observed as `disabled`; do not enable strict inventory until recipes and real opening stock have been verified.

## Apply database changes

1. Back up the database.
2. In the correct Supabase project, apply `sql/ADMIN_KOT_READY_ALIGNMENT_PATCH.sql` once, after `MASTER_MIGRATION_TABLEFORGE.sql` and `TABLEFORGE_WORKFLOW_FIX_PATCH.sql`.
3. Run `sql/ADMIN_KOT_READY_ALIGNMENT_AUDIT.sql` and `sql/POST_MIGRATION_VALIDATION.sql`.
4. Deploy this project ZIP after the migration succeeds.

The migration is additive for data columns, but it replaces the KOT queue and Ready RPC definitions. It should not be run against an unverified project. This package's automated tests and SQL checks do not constitute live PostgreSQL execution.
