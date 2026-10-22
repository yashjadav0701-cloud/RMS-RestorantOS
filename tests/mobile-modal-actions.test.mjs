import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Admin bill payment action uses the readable Paid label instead of a tick-only button", async () => {
  const admin = await read("src/admin/index.js");
  assert.match(admin, /label: "Paid"[\s\S]{0,180}className: "btn-primary paid-action-button"/);
  assert.doesNotMatch(admin, /label: "✓"/);
  assert.doesNotMatch(admin, /paid-icon-action/);
});

test("all modal action buttons fit mobile width and four bill actions form a two-column grid", async () => {
  const css = await read("styles.css");
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.app-modal \.modal-actions \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.app-modal \.modal-actions button,[\s\S]*?width: 100% !important;[\s\S]*?min-width: 0 !important;/);
  assert.match(css, /button:last-child:nth-child\(odd\)[\s\S]*?grid-column: 1 \/ -1/);
  assert.match(css, /overflow-wrap: anywhere/);
});
