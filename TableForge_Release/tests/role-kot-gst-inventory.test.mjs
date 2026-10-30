import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('workspace role cards keep the current 4:5 portrait design and role-only copy', async () => {
  const s = await read('src/components/panelDashboard.js');
  assert.match(s, /\.workspace-card\s*\{[\s\S]*?aspect-ratio:\s*4\s*\/\s*5/);
  assert.match(s, /\.workspace-card-icon i\s*\{[\s\S]*?font-size:\s*62px/);
  assert.match(s, /<span class="workspace-card-icon"[\s\S]*?<i class="ph-bold \$\{escapePanelText\(getRoleIcon\(panel\)\)\}"><\/i>[\s\S]*?<span class="workspace-card-name">[\s\S]*?\$\{escapePanelText\(panel.title\)\}/);
  assert.doesNotMatch(s, /<span class="workspace-card-copy">[\s\S]{0,220}<p>/);
  assert.doesNotMatch(s, /class="workspace-card-arrow"|workspace-card-description/);
});

test('panel PIN screen uses 6:7 boxes and legacy Admin lock inputs use 5:6 boxes', async () => {
  const pin = await read('src/components/panelPinScreen.js');
  const css = await read('styles.css');
  assert.match(pin, /#panel-pin-container \.pin-box\s*\{[\s\S]*?aspect-ratio:\s*6\s*\/\s*7/);
  assert.match(pin, /#panel-pin-container \.pin-box\s*\{[\s\S]*?height:\s*49px/);
  assert.match(css, /#admin-pin-container \.pin-box\s*\{[\s\S]*?aspect-ratio:\s*5\s*\/\s*6/);
});

test('KOT ready-marker status remains active without conflating it with normally served items', async () => {
  const ui = await read('src/kot/index.js');
  assert.match(ui, /const ACTIVE_STATUSES = new Set\(\["pending", "preparing", "ready"\]\)/);
  assert.match(ui, /function isReadyMarked\(row\)[\s\S]*?serving_status \|\| ""\)\.toLowerCase\(\) === "served"[\s\S]*?kot_ready_previous_status/);
  assert.match(ui, /return ACTIVE_STATUSES\.has\(status\) \|\| isReadyMarked\(row\)/);
});

test('GSTIN is one-time set through the database guard, not just the disabled UI input', async () => {
  const admin = await read('src/admin/index.js');
  const sql = await read('sql/ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS.sql');
  assert.match(admin, /name="gst_number"[\s\S]*?\$\{String\(settings\.gst_number \|\| ""\)\.trim\(\) \? 'disabled aria-disabled="true"/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\._tableforge_guard_gst_number_once\(\)/);
  assert.match(sql, /GSTIN is locked after its first save/);
  assert.match(sql, /current_setting\('tableforge\.allow_gst_override', true\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\._tableforge_guard_gst_number_once\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /slug='four-flavours'/);
});

test('inventory seed marks costs and per-dish recipes as estimates and does not create fake opening stock', async () => {
  const sql = await read('sql/ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS.sql');
  const audit = await read('sql/AUDIT_KOT_GST_INVENTORY_ENHANCEMENTS.sql');
  assert.match(sql, /cost_is_estimate boolean NOT NULL DEFAULT false/);
  assert.match(sql, /INSERT INTO public\.inventory_ingredients\([\s\S]*?cost_is_estimate,cost_source_note\)[\s\S]*?true,[\s\S]*?Planning estimate in INR per base unit/);
  assert.match(sql, /INSERT INTO public\.product_recipes\([\s\S]*?is_estimate,source_note\)[\s\S]*?true,[\s\S]*?Estimated starter recipe based on menu name\/category/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM public\.product_recipes r WHERE r\.product_id=p\.id AND r\.restaurant_id=p\.restaurant_id\)/);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.inventory_movements\s*\([^;]*movement_type\s*,\s*quantity_delta\s*,\s*unit\s*,\s*reason\)[\s\S]*?\('opening_stock'/i);
  assert.match(sql, /Strict inventory cannot be enabled while estimated recipes remain/);
  assert.match(sql, /An Admin must verify the recipe before strict-inventory preparation can start/);
  assert.match(sql, /oi\.serving_status IN \('pending','preparing','ready'\)[\s\S]*?OR oi\.kot_ready_previous_status IS NOT NULL/);
  assert.match(audit, /dishes_missing_recipe/);
  assert.match(audit, /estimated_costs/);
  assert.match(audit, /recipe_product_tenant_mismatches/);
});

test('SQL structure checker includes the new enhancement and read-only audit scripts', async () => {
  const checker = await read('scripts/check-sql-structure.mjs');
  assert.match(checker, /ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS\.sql/);
  assert.match(checker, /AUDIT_KOT_GST_INVENTORY_ENHANCEMENTS\.sql/);
});

test('workflow settings audit call passes all required audit arguments', async () => {
  const sql = await read('sql/ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS.sql');
  assert.match(sql, /_tableforge_audit_event\(v_restaurant_id,'restaurant_workflow_settings_updated',[\s\S]*?jsonb_build_object\('method_count',cardinality\(v_methods\)\)\)/);
});


test('release safety patch requires discount reasons and blocks estimated or unavailable inventory recipes', async () => {
  const sql = await read('sql/TABLEFORGE_RELEASE_SAFETY_PATCH.sql');
  assert.match(sql, /BEGIN;/i);
  assert.match(sql, /DO \$preflight\$/i);
  assert.match(sql, /to_regprocedure\('public\.apply_admin_bill_discount\(uuid,uuid,text,numeric,text,text\)'\)/i);
  assert.match(sql, /v_value > 0 AND v_reason IS NULL/i);
  assert.match(sql, /Strict inventory cannot be enabled while estimated recipes remain/i);
  assert.match(sql, /missing, inactive, or cross-restaurant ingredient/i);
  assert.match(sql, /opening stock is recorded for every ingredient used by an active recipe/i);
  assert.match(sql, /m\.movement_type='opening_stock'/i);
  assert.match(sql, /coalesce\(r\.is_estimate,true\) OR i\.id IS NULL OR NOT i\.is_active/i);
  assert.match(sql, /IF NOT FOUND THEN\s+RAISE EXCEPTION 'Recipe ingredient % is no longer active/i);
  assert.match(sql, /COMMIT;/i);
});
