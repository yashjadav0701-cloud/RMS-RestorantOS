import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFile(path.join(root, file), "utf8");

test("Cashier workspace keeps takeaway mode after POS event wiring", async () => {
  const pos = await read("src/pos/index.js");
  const initStart = pos.indexOf("const state = createPOSState({ settings });");
  const searchWiringStart = pos.indexOf("const searchInput = mount.querySelector(\"#pos-search\");");
  const liveTabBlockStart = pos.indexOf("if (isCustomerMode) {", searchWiringStart);
  const nextButtonWiring = pos.indexOf("mount.querySelector(\"#pos-next\")", liveTabBlockStart);

  assert.ok(initStart >= 0 && searchWiringStart > initStart && liveTabBlockStart > searchWiringStart && nextButtonWiring > liveTabBlockStart);

  const initialization = pos.slice(initStart, searchWiringStart);
  const eventWiring = pos.slice(liveTabBlockStart, nextButtonWiring);

  assert.match(initialization, /else if \(isCaptainPanel\)[\s\S]*?state\.setOrderType\("dine_in"\)/);
  assert.match(initialization, /else if \(isCashierPanel\)[\s\S]*?state\.setOrderType\("takeaway"\)/);
  assert.match(eventWiring, /if \(isCustomerMode\) \{[\s\S]*?customer-live-tab/);
  assert.doesNotMatch(eventWiring, /state\.setOrderType\("dine_in"\)/);
  assert.match(pos, /if \(isCashierPanel && current\.orderType !== "takeaway"\)/);
});

test("role registry keeps each operational workspace separate", async () => {
  const registry = await read("src/core/panelRegistry.js");
  const master = await read("sql/MASTER_MIGRATION_TABLEFORGE.sql");
  const rolePatch = await read("sql/ADMIN_KOT_READY_ALIGNMENT_PATCH.sql");

  for (const panelId of ["captain", "kot", "cashier", "manager", "admin"]) {
    assert.match(registry, new RegExp(`id: \\"${panelId}\\"`));
  }
  assert.doesNotMatch(registry, /id: "pos"/);
  assert.match(master, /_tableforge_validate_panel_token\(p_panel_token,\s*ARRAY\[\s*'kot',\s*'manager'\s*\]\)/);
  assert.match(rolePatch, /_tableforge_validate_panel_token\(p_panel_token,\s*ARRAY\[\s*'kot',\s*'manager',\s*'admin'\s*\]\)/);
  assert.match(master, /_tableforge_validate_panel_token\(p_panel_token,\s*ARRAY\[\s*'cashier',\s*'manager'\s*\]\)/);
  assert.match(master, /_tableforge_validate_panel_token\(p_panel_token,\s*ARRAY\[\s*'captain',\s*'cashier',\s*'manager',\s*'admin'\s*\]\)/);
});
