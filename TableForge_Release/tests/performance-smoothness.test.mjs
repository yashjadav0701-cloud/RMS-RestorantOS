import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("POS quantity controls update only changed product IDs", async () => {
  const pos = await source("src/pos/index.js");
  assert.match(pos, /productControlMap\s*=\s*new Map/);
  assert.match(pos, /lastRenderedProductQuantities/);
  assert.match(pos, /if\s*\(!force\s*&&\s*quantity\s*===\s*previousQuantity\)\s*continue/);
  assert.match(pos, /renderProductQuantities\(state\.getState\(\),\s*true\)/);
});

test("quantity triplets have three equal compact cells in every UI variant", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.premium-qty-wrapper\.is-active\s*\{[^}]*width:\s*84px/s);
  assert.match(css, /\.premium-qty-btn\s*\{[^}]*width:\s*28px;[^}]*flex:\s*0\s+0\s+28px/s);
  assert.match(css, /\.detail-action-container\.is-active\s+\.detail-qty-ui\s*\{[^}]*flex:\s*0\s+0\s+108px/s);
  assert.match(css, /\.detail-qty-btn\s*\{[^}]*flex:\s*0\s+0\s+36px/s);
  assert.match(css, /#detail-qty-val\s*\{[^}]*flex:\s*0\s+0\s+36px/s);
  assert.match(css, /\.review-item-actions>strong\s*\{[^}]*flex:\s*0\s+0\s+29px/s);
});

test("Admin section changes provide an accessible loading lock and entrance transition", async () => {
  const admin = await source("src/admin/index.js");
  const css = await source("styles.css");
  assert.match(admin, /id="admin-section-loader"/);
  assert.match(admin, /nav\?\.setAttribute\("aria-busy",\s*"true"\)/);
  assert.match(admin, /area\.inert\s*=\s*true/);
  assert.match(admin, /button\.disabled\s*=\s*true/);
  assert.match(admin, /finishAdminSectionTransition\("top-products"\)/);
  assert.match(css, /\.admin-tab-content\s*\{[^}]*animation:\s*adminTabEnter/s);
  assert.match(css, /\.admin-area-exit\s*\{[^}]*transition:/s);
});

test("cart draft writes are coalesced but flushed on page exit and draft switches", async () => {
  const state = await source("src/core/posState.js");
  assert.match(state, /draftSaveTimer\s*=\s*setTimeout\(flushDraft,\s*120\)/);
  assert.match(state, /window\.addEventListener\("pagehide",\s*flushDraft\)/);
  assert.match(state, /document\.visibilityState\s*===\s*"hidden"\)\s*flushDraft\(\)/);
  assert.match(state, /const loadDraft\s*=\s*\(\)\s*=>\s*\{\s*\/\/ Commit the previous cart[\s\S]*?flushDraft\(\)/);
});

test("quantity and menu animations avoid forced synchronous reflow", async () => {
  const pos = await source("src/pos/index.js");
  const admin = await source("src/admin/index.js");
  assert.doesNotMatch(pos, /void\s+\w+\.offsetWidth/);
  assert.doesNotMatch(pos, /void\s+grid\.offsetWidth/);
  assert.doesNotMatch(admin, /void\s+\w+\.offsetWidth/);
});
