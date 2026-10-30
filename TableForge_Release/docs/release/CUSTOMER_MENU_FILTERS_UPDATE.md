# Customer Menu Filters Update

## Changes
- Removed the customer-facing cuisine landing page; customers now land directly on the dish list.
- Added independent Cuisine and Category filters. Both default to All.
- Normalized existing `Cuisine - Category` product values into shared category groups (for example, salads and soups) in the frontend; no database migration is required.
- When a cuisine is selected, category options are derived only from products available in that cuisine.
- Product cards show the normalized category and cuisine separately.
- Moved the current table indicator to the center of the top bar.
- The table indicator is deliberately QR-session locked: selecting a different table must require scanning that table's own QR code, preserving session isolation and remote-ordering deterrence.

## Verification
Run `npm run verify` from the project root. JavaScript syntax, SQL structural checks, and the existing 38 automated tests passed after this change. SQL structural checks are not a live PostgreSQL execution test.

## Database
No schema or data migration is included or required for this UI change.
