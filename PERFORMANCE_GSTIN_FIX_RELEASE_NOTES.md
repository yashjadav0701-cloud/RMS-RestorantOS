# TableForge performance and GSTIN fix release

This release is based on the uploaded `TableForge_Release(2).zip` source tree. Existing application files, SQL scripts, tenant routing, and repository metadata are retained.

## Interaction performance
- Quantity changes carry changed-product metadata, allowing the POS to update one quantity control instead of rebuilding quantity maps and sets for every tap.
- Product id lookup uses a prebuilt map rather than scanning the menu for each add action.
- POS state creates one snapshot per update for all listeners. Cart-draft cloning and JSON/localStorage writes are deferred to the coalesced draft flush and flushed before switching table/order context or leaving the page.
- Product detail modal no longer manually repeats the shared state refresh after each quantity action.
- Review modal quantity actions update one row in place instead of rebuilding the entire review list.
- Admin catalog count/total labels update in place, preserving the round-confirm button DOM and its click listener during fast quantity changes.
- Quantity transitions are shorter and avoid repeatedly restarting an in-flight pulse. Main, review, and Admin compact +/-/value controls keep equal 28px cells; the detail modal keeps equal 36px cells.

## Admin settings and GSTIN
- Removed the obsolete inline PIN-submit handler that referenced undeclared variables and could throw before the billing Settings submit handler registered.
- GSTIN input is normalized to uppercase A-Z / 0-9, restricted to 15 characters, and checked against the standard GSTIN format.
- A successfully saved GSTIN is disabled in the UI and retained in subsequent billing-settings saves even though disabled controls are omitted from FormData.
- Added `sql/GSTIN_ONE_TIME_LOCK_PATCH.sql` for server-side one-time locking. Run it in the correct Supabase project after the existing master migration. It is tenant-neutral and rerunnable.
- Existing GSTINs are preserved unchanged even if a legacy value is malformed, so unrelated settings can still be updated. A new value must pass the format check.

## PIN styling
- PIN focus removes the extra outline and uses a single border with a restrained focus glow on the panel lock screen and Admin PIN manager.

## Verification
- `npm run check:syntax`: passed.
- `npm run check:sql`: passed lexical/structural checks; this is not a live PostgreSQL execution test.
- `npm test`: 77 tests passed.
- Browser frame rate was not measured on a physical 60Hz/120Hz device; actual FPS remains device-dependent.
