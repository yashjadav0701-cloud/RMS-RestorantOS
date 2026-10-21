import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

async function allFiles(dir, suffix) {
  const out = [];
  async function walk(current) {
    for (const e of await readdir(current, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(current, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && suffix.some(s => e.name.endsWith(s))) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

test('manifest JSON is valid and has expected PWA metadata', async () => {
  const m = JSON.parse(await read('manifest.json'));
  assert.ok(m.name || m.short_name);
  assert.ok(Array.isArray(m.icons) && m.icons.length > 0);
});

test('all local module imports resolve', async () => {
  const files = await allFiles(path.join(root, 'src'), ['.js']);
  const re = /(?:\bfrom\s*|\bimport\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g;
  const missing = [];
  for (const file of files) {
    const s = await readFile(file, 'utf8');
    for (const m of s.matchAll(re)) {
      const resolved = path.resolve(path.dirname(file), m[1]);
      try { await readFile(resolved); } catch { missing.push(`${path.relative(root,file)} -> ${m[1]}`); }
    }
  }
  assert.deepEqual(missing, []);
});

test('all five intended panels are registered', async () => {
  const s = await read('src/core/panelRegistry.js');
  for (const id of ['captain', 'kot', 'cashier', 'manager', 'admin']) {
    assert.match(s, new RegExp(`id:\\s*["']${id}["']`));
  }
});

test('panel PIN screen never persists the raw PIN', async () => {
  const s = await read('src/components/panelPinScreen.js');
  assert.match(s, /window\.__RMS_PANEL_ACCESS__\s*=\s*\{/);
  assert.match(s, /Never persist the PIN/i);
  assert.doesNotMatch(s, /localStorage\.setItem\([^\n]*pin/i);
});

test('router documents that UI guards are not a security boundary', async () => {
  const s = await read('src/core/router.js');
  assert.match(s, /not a substitute for database authorization/i);
});

test('public customer ordering uses server-side order RPC', async () => {
  const s = await read('src/pos/index.js');
  assert.match(s, /rpc\("submit_customer_order"/);
  assert.match(s, /p_session_token:\s*token/);
});

test('cashier bill generation validates the returned bill shape', async () => {
  const s = await read('src/cashier/index.js');
  assert.match(s, /rpc\(\s*["']generate_cashier_bill["']/);
  assert.match(s, /Array\.isArray\(bill\.items\)/);
  assert.match(s, /bill\.settings/);
});

test('KOT status changes go through a server RPC', async () => {
  const s = await read('src/kot/index.js');
  assert.match(s, /rpc\("set_kot_item_status"/);
  assert.match(s, /p_panel_token:\s*currentAccess\.token/);
});

test('cancellation approval UI requires a reason', async () => {
  const s = await read('src/admin/cancellationApprovals.js');
  assert.match(s, /if \(!reason\.trim\(\)\)/);
  assert.match(s, /rpc\(\s*["']decide_dish_cancellation["']/);
});

test('RPC inventory clearly records all frontend calls', async () => {
  const inventory = JSON.parse(await read('docs/release/RPC_CONTRACT_INVENTORY.json'));
  assert.ok(inventory.frontend_distinct_rpc_names >= 25);
  assert.ok(inventory.database_routines >= 35);
  assert.ok(inventory.rpc_calls.verify_panel_pin);
  assert.ok(inventory.rpc_calls.cancel_order_item);
  assert.ok(inventory.rpc_calls.request_dish_cancellation);
});


test('Admin configuration writes use the panel-token RPC rather than direct table DML', async () => {
  const s = await read('src/admin/index.js');
  for (const table of ['products', 'cuisines', 'tables', 'app_settings', 'restaurants']) {
    const directWrite = new RegExp(`supabase\\s*\\.from\\([\\"']${table}[\\"']\\)[\\s\\S]{0,220}?\\.(?:insert|update|upsert|delete)\\s*\\(`, 'i');
    assert.doesNotMatch(s, directWrite, `Direct write remains for ${table}`);
  }
  assert.match(s, /rpc\("admin_mutate_resource"/);
});

test('inventory UI persists ingredients, stock movements, recipes and usage reports', async () => {
  const admin = await read('src/admin/index.js');
  const usage = await read('src/admin/ingredientUsage.js');
  for (const rpc of ['get_inventory_dashboard', 'admin_save_ingredient', 'admin_record_inventory_movement', 'admin_set_product_recipe']) {
    assert.ok(admin.includes(`rpc("${rpc}"`), `Missing ${rpc} frontend call`);
  }
  assert.match(usage, /rpc\("get_inventory_usage_report"/);
});

test('Admin direct routes require the panel PIN route', async () => {
  const s = await read('src/core/router.js');
  assert.match(s, /location\.hash === "#\/admin"[\s\S]{0,140}name: "panel-pin"/);
  assert.match(s, /panelMatch[\s\S]{0,220}name: "panel-pin"/);
});

test('no server-side service-role credential is hardcoded in shipped source', async () => {
  const files = await allFiles(root, ['.js', '.html', '.json', '.css']);
  const hits = [];
  const secretPatterns = [/\bsb_secret_[A-Za-z0-9_-]{20,}/, /\bservice_role\s*[:=]\s*["'][^"']{20,}/i, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
  for (const file of files) {
    if (file.includes(`${path.sep}.git${path.sep}`) || file.includes(`${path.sep}tests${path.sep}`)) continue;
    const s = await readFile(file, 'utf8');
    if (secretPatterns.some(re => re.test(s))) hits.push(path.relative(root, file));
  }
  assert.deepEqual(hits, []);
});


test('Admin workspace consumes the already-verified Admin panel grant without a second legacy PIN prompt', async () => {
  const s = await read('src/admin/index.js');
  assert.match(s, /hasValidAdminGrant[\s\S]{0,600}renderAdminWorkspace\(mount\)/);
  assert.doesNotMatch(s, /renderAdminLock\(/);
  assert.doesNotMatch(s, /supabase\.rpc\(\s*[\"']rms_verify_pin_v2[\"']/);
});

test('Admin PIN reset script hashes the new PIN and synchronizes both credential stores', async () => {
  const s = await read('sql/RESET_ADMIN_PIN.sql');
  assert.match(s, /public\._tableforge_hash_pin\(v_new_pin\)/);
  assert.match(s, /UPDATE public\.restaurants[\s\S]*admin_pin_hash = v_pin_hash[\s\S]*admin_pin = NULL/);
  assert.match(s, /INSERT INTO public\.panel_pin_credentials[\s\S]*'admin'[\s\S]*v_pin_hash/);
  assert.match(s, /UPDATE public\.panel_access_tokens[\s\S]*revoked_at = now\(\)/);
  assert.match(s, /UPDATE public\.panel_management_tokens[\s\S]*revoked_at = now\(\)/);
  assert.doesNotMatch(s, /SET admin_pin\s*=\s*v_new_pin/i);
});
