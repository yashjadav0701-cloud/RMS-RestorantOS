# TableForge mobile modal button fix

## Changes
- Replaced the Admin receipt's check-only payment action with the explicit **Paid** label.
- Removed the fixed 44px width so the action can share the footer layout.
- Updated the shared modal action footer: desktop buttons wrap naturally; on screens up to 520px all modal action footers use two equal columns. Four receipt actions (Save PDF, Print Bill, Discount, Paid) display in a 2 × 2 grid. An unmatched final button spans the full row.
- Added a regression test for the Paid label and mobile layout rules.

## Database
No SQL migration is required.

## Manual QA
1. Open Admin on a mobile viewport and open an unpaid bill-ready receipt.
2. Confirm the four actions show as a 2 × 2 grid with no clipped labels or horizontal scrolling.
3. Confirm the fourth action reads **Paid**, then verify its confirmation flow still works.
4. Open another modal with two or three actions and confirm its footer buttons remain inside the modal.
5. Test at 320px, 375px, 390px and 520px viewport widths.
