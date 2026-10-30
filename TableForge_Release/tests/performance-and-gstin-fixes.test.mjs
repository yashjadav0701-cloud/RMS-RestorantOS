import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFile(path.join(root, file), "utf8");

test("POS state coalesces persistence without cloning the cart on every tap", async () => {
  const state = await read("src/core/posState.js");
  assert.match(state, /let pendingDraftKey = null/);
  assert.match(state, /const saveDraft = \(\) => \{\s*pendingDraftKey = getDraftKey\(\)/);
  assert.match(state, /const items = \[\.\.\.cart\.values\(\)\]\.map\(item => \(\{ \.\.\.item \}\)\)/);
  assert.match(state, /const current = snapshot\(\);\s*listeners\.forEach\(listener => listener\(current, change\)\)/);
  assert.match(state, /flushDraft\(\); \/\/ Flush under the old key before changing context\./);
});

test("POS quantity taps have a single-product fast path and constant-time menu lookup", async () => {
  const pos = await read("src/pos/index.js");
  assert.match(pos, /const productsById = new Map\(products\.map\(product => \[product\.id, product\]\)\)/);
  assert.match(pos, /productsById\.get\(add\.dataset\.productAdd\)/);
  assert.match(pos, /if \(!force && change\?\.productId\)/);
  assert.match(pos, /lastRenderedProductQuantities\.set\(productId, quantity\)/);
  assert.match(pos, /state\.subscribe\(\(current, change\) =>/);
  assert.match(pos, /duration: 90, easing: "cubic-bezier\(\.2,\.7,\.2,1\)"/);
});

test("Review quantity clicks update only the changed row, not the entire list", async () => {
  const pos = await read("src/pos/index.js");
  assert.match(pos, /data-review-item="\$\{item\.id\}"/);
  assert.match(pos, /function refreshReview\(root, changedProductId = null\)/);
  assert.match(pos, /if \(changedProductId\)[\s\S]*?row\.remove\(\)/);
  assert.match(pos, /value\.textContent !== String\(item\.quantity\)/);
});

test("Admin catalog quantity updates retain the footer button DOM during rapid taps", async () => {
  const admin = await read("src/admin/index.js");
  assert.match(admin, /data-round-count/);
  assert.match(admin, /data-round-total/);
  assert.match(admin, /countLabel\.textContent = String\(cartCount\)/);
  assert.match(admin, /totalLabel\.textContent = money\(cartTotal, settings\.currency_symbol\)/);
});

test("Settings save cannot be interrupted by the obsolete inline PIN handler", async () => {
  const admin = await read("src/admin/index.js");
  assert.doesNotMatch(admin, /panelPinForm/);
  assert.match(admin, /area\.querySelector\("#settings-form"\)\.addEventListener\("submit", async e => \{\s*e\.preventDefault\(\)/);
  assert.match(admin, /const confirmedSave = Array\.isArray\(saveResult\) \? saveResult\[0\] : saveResult/);
  assert.match(admin, /confirmedSave\?\.ok !== true/);
});

test("GSTIN is uppercased, format-checked and locked in the UI after first save", async () => {
  const admin = await read("src/admin/index.js");
  const patch = await read("sql/GSTIN_ONE_TIME_LOCK_PATCH.sql");
  assert.match(admin, /name="gst_number"[\s\S]*?maxlength="15"[\s\S]*?pattern="\[0-9\]\{2\}\[A-Z\]\{5\}\[0-9\]\{4\}/);
  assert.match(admin, /String\(settings\.gst_number \|\| ""\)\.trim\(\) \? 'disabled aria-disabled="true"'/);
  assert.match(admin, /const gstNumber = existingGstin \|\| enteredGstin/);
  assert.match(admin, /gstNumberInput\.disabled = true/);
  assert.match(patch, /CREATE TRIGGER trg_tableforge_gst_number_once/);
  assert.match(patch, /GSTIN is locked after its first save/);
  assert.match(patch, /REVOKE ALL ON FUNCTION public\._tableforge_guard_gst_number_once\(\) FROM PUBLIC, anon, authenticated/);
});

test("PIN fields use a single border with a restrained focus glow", async () => {
  const screen = await read("src/components/panelPinScreen.js");
  const manager = await read("src/admin/panelPinManager.js");
  assert.match(screen, /\.pin-box:focus\s*\{\s*outline: none;[\s\S]*?border-color: var\(--forest-700\)/);
  assert.match(screen, /\.pin-box\s*\{[\s\S]*?border: 1px solid var\(--line\)/);
  assert.match(manager, /\.pin-manager-verify-inputs input:focus,[\s\S]*?outline: none;[\s\S]*?border-color: var\(--forest-700\)/);
});
