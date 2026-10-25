import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("KOT uses one Ready action and a reversible Ready marker", async () => {
  const kot = await read("src/kot/index.js");
  assert.doesNotMatch(kot, /Start preparing/i);
  assert.match(kot, /data-kot-action="ready"/);
  assert.match(kot, /data-kot-action="undo_ready"/);
  assert.match(kot, /set_kot_table_ready/);
  assert.match(kot, /row\.session_id/);
});

test("Admin Table Open uses the same Ready RPC rather than a separate status cycle", async () => {
  const admin = await read("src/admin/index.js");
  assert.doesNotMatch(admin, /rpc\("set_order_item_status"/);
  assert.match(admin, /rpc\("set_kot_item_status"/);
  assert.match(admin, /rpc\("set_kot_table_ready"/);
  assert.match(admin, /data-ready-action/);
  assert.match(admin, /kotReadyPreviousStatus/);
  assert.match(admin, /canChangeKOTStatus = \["open", "bill_requested"\]/);
  assert.match(admin, /Bill already prepared/);
});

test("panel PIN screen uses responsive 6:7 boxes and legacy Admin lock keeps 5:6 boxes", async () => {
  const pin = await read("src/components/panelPinScreen.js");
  const styles = await read("styles.css");
  assert.match(pin, /aspect-ratio:\s*6\s*\/\s*7/);
  assert.match(pin, /height:\s*49px/);
  assert.match(pin, /height:\s*42px/);
  assert.match(pin, /height:\s*37\.333px/);
  assert.match(styles, /#admin-pin-container \.pin-box[\s\S]*?aspect-ratio:\s*5\s*\/\s*6/);
  assert.match(styles, /#admin-pin-container \.pin-box[\s\S]*?height:\s*60px/);
  assert.match(styles, /#admin-pin-container \.pin-box[\s\S]*?height:\s*43\.2px/);
});

test("KOT SQL patch adds trigger marker columns and keeps ready items visible until bill-ready", async () => {
  const sql = await read("sql/ADMIN_KOT_READY_ALIGNMENT_PATCH.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS inventory_consumed_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS inventory_recipe_snapshot/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS kot_ready_previous_status/);
  assert.match(sql, /o\.billing_status NOT IN \('bill_ready','closed'\)/);
  assert.match(sql, /ds\.status IN \('open','bill_requested'\)/);
  assert.match(sql, /_tableforge_validate_panel_token\(p_panel_token, ARRAY\['kot','manager','admin'\]\)/);
  assert.match(sql, /v_item\.serving_status IN \('pending','ready'\) AND v_item\.inventory_consumed_at IS NULL/);
  assert.match(sql, /v_item\.serving_status='preparing' AND v_item\.inventory_consumed_at IS NULL/);
});
