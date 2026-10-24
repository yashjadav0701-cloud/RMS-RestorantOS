# Four Flavours — Minimum Menu Sections

This release separates the `cuisine` value from `category`/menu section, while retaining a compatibility fallback for legacy product rows. Global items are stored with `cuisine = 'Global'`, so Salads, Papad, Desserts and Beverages remain available regardless of the selected cuisine.

## Canonical sections

1. Soups
2. Salads (Global)
3. Starters & Tandoor
4. Platters & Sizzlers
5. Main Course
6. Breads & Rice
7. Noodles & Fried Rice
8. Pasta, Pizza & Bakes
9. Papad (Global)
10. Desserts (Global)
11. Beverages (Global)

## Apply in this order

1. Back up the Supabase project.
2. Run `sql/FOUR_FLAVOURS_MINIMUM_MENU_SECTIONS.sql` in the SQL Editor for the `RMS` project. It is scoped to Four Flavours only.
3. Deploy this project build to Vercel after the migration succeeds.
4. Hard refresh, then test All cuisines, each cuisine, and the four global categories.

The migration is idempotent by case-insensitive product name. It updates existing products in place, retains product IDs/images/recipe foreign keys, inserts only menu items that are missing from the approved two-sheet workbook, and records a `price_review_required` flag for entries whose workbook notes identified estimated prices or names for confirmation. A final query lists those entries.

Automated verification: `npm run verify` passed. This does not replace executing the migration in a disposable or production Supabase database and exercising the actual menu after deployment.
