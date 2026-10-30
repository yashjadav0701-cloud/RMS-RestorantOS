# TableForge brand and Captain menu polish

## Changes

- Receipt header now uses the restaurant's square `icon_url` instead of its landscape `logo_url`.
- Bills whose saved payment method is UPI QR always retain the UPI QR and square restaurant icon on the receipt, including after payment is marked received. Non-UPI methods do not display the QR. Reopened/reprinted bills use the same shared receipt renderer and saved bill amount/method, instead of changing the printed content when payment status changes.
- Receipt restaurant name is styled in Bebas Neue with local system fallbacks, suitable for the Four Flavours wordmark treatment. The display text remains tenant-configured rather than hard-coded for every tenant.
- The Captain cuisine pill reads `Cuisines` while all cuisines are selected, and the category pill reads `Categories` while all categories are selected. Specific selections continue to display their selected name.
- The `All cuisines` chooser card uses a 2×2 collage based on the actual cuisine image URLs, with neutral tiles as fallbacks when fewer than four images are available.
- Cache-busting versions were updated so deployed clients load the revised CSS and JavaScript.

## Database

No SQL migration is required; these changes affect receipt rendering and menu-filter presentation only.

## Verification

Run `npm run verify` from this folder. At the time of packaging, JavaScript syntax checks, import checks, static SQL structural checks and all 50 automated tests passed. Static checks are not a substitute for a live browser and live Supabase verification.


## Paid receipt QR persistence

The receipt renderer no longer hides the UPI QR based on payment status. The saved payment method and configured UPI ID decide whether a QR is rendered. This intentionally keeps the receipt reproducible after payment confirmation. Because a paid receipt still contains a payable QR, staff should mark/hand out paid receipts clearly and avoid directing customers to scan a bill already paid.
