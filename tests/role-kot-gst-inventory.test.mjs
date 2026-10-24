import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('workspace role cards are 3:4 on every breakpoint and contain only a large icon plus role name', async () => {
  const s = await read('src/components/panelDashboard.js');
  assert.match(s, /\.workspace-card\s*\{[\s\S]*?aspect-ratio:\s*3\s*\/\s*4/);
  assert.match(s, /\.workspace-card-icon i\s*\{[\s\S]*?font-size:\s*clamp\(40px,\s*4vw,\s*54px\)/);
  assert.match(s, /<span class="workspace-card-icon">[\s\S]*?<i class="ph-bold \$\{panel\.icon\}"><\/i>[\s\S]*?<h3>\$\{panel\.title\}<\/h3>/);
  assert.doesNotMatch(s, /<span class="workspace-card-copy">[\s\S]{0,220}<p>/);
  assert.doesNotMatch(s, /class="workspace-card-arrow"|workspace-card-description/);
});

test('all workspace and Admin PIN inputs use portrait 3:4 boxes at phone and desktop sizes', async () => {
  const pin = await read('src/components/panelPinScreen.js');
  const css = await read('styles.css');
  assert.match(pin, /#panel-pin-container \.pin-box\s*\{[\s\S]*?aspect-ratio:\s*3\s*\/\s*4/);
  assert.match(css, /\.pin-box\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*4/s);
  assert.match(css, /#admin-pin-container \.pin-box\s*\{[\s\S]*?aspect-ratio:\s*3\s*\/\s*4/);
});

test('KOT uses one Ready action and an explicit reversible table-level Ready action', async () => {
  const ui = await read('src/kot/index.js');
  const sql = await read('sql/ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS.sql');
  assert.match(ui, /const ACTIVE_STATUSES = new Set\(\["pending", "preparing", "ready", "served"\]\)/);
  assert.match(ui, /data-kot-action="ready"[\s\S]*?Ready/);
  assert.match(ui, /data-kot-table-action="\$\{allReady \? "undo_ready" : "ready"\}"[\s\S]*?\$\{allReady \? "Undo ready" : "Ready table"\}/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.set_kot_item_status\(/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.set_kot_table_ready\(/);
  assert.match(sql, /kot_ready_previous_status=CASE[\s\S]*?kot_ready_at=now\(\)/);
  assert.match(sql, /ds\.status IN \('open','bill_requested'\)/);
  assert.match(sql, /o\.created_at ASC, o\.round_number ASC NULLS FIRST, oi\.created_at ASC/);
  assert.match(sql, /inventory_consumed_at IS NULL/);
  assert.match(sql, /trg_tableforge_consume_recipe_on_served/);
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
