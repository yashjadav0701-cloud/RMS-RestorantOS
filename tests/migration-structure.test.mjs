import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('master migration is transactional and avoids destructive table rebuilds', async () => {
  const sql = await read('sql/MASTER_MIGRATION_TABLEFORGE.sql');
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /COMMIT;\s*(?:--[^\n]*\s*)*$/);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b|\bTRUNCATE\s+TABLE\b|\bDROP\s+SCHEMA\b/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.orders\b/i);
});

test('all frontend RPCs missing from the audited database have migration definitions', async () => {
  const inventory = JSON.parse(await read('docs/release/RPC_CONTRACT_INVENTORY.json'));
  const catalog = JSON.parse(await read('tests/fixtures/live-public-rpc-catalog.json'));
  const sql = await read('sql/MASTER_MIGRATION_TABLEFORGE.sql');
  const missing = Object.entries(inventory.rpc_calls)
    .filter(([name]) => !catalog.functions.includes(name))
    .map(([name]) => name);
  const uncovered = missing.filter(name => !new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, 'i').test(sql));
  assert.deepEqual(uncovered, [], `Missing RPC migration definitions: ${uncovered.join(', ')}`);
});

test('panel PIN tokens are hashed at rest and have expiry/revocation checks', async () => {
  const sql = await read('sql/MASTER_MIGRATION_TABLEFORGE.sql');
  assert.match(sql, /digest\(v_token,'sha256'\)/i);
  assert.match(sql, /expires_at\s*>\s*now\(\)/i);
  assert.match(sql, /revoked_at\s+IS\s+NULL/i);
  assert.match(sql, /interval '20 minutes'/i);
  assert.match(sql, /interval '5 minutes'/i);
});

test('customer cancellation RPCs require the session token and a reason', async () => {
  const sql = await read('sql/MASTER_MIGRATION_TABLEFORGE.sql');
  assert.match(sql, /FUNCTION public\.cancel_order_item\(p_item_id uuid,p_reason text,p_session_token text\)/i);
  assert.match(sql, /FUNCTION public\.request_dish_cancellation\(p_item_id uuid,p_reason text,p_session_token text\)/i);
  assert.match(sql, /ds\.session_token::text=p_session_token/i);
  assert.match(sql, /A cancellation reason of 1–300 characters is required/i);
});

test('public menu bootstrap is table-scoped and anonymous direct reads are revoked', async () => {
  const sql = await read('sql/MASTER_MIGRATION_TABLEFORGE.sql');
  assert.match(sql, /FUNCTION public\.get_public_pos_data\(p_table_id uuid\)/i);
  assert.match(sql, /WHERE t\.id=p_table_id AND t\.is_active=true/i);
  assert.match(sql, /REVOKE SELECT ON public\.products FROM anon/i);
  assert.match(sql, /REVOKE SELECT ON public\.cuisines FROM anon/i);
  assert.match(sql, /FUNCTION public\.admin_mutate_resource\(/i);
  assert.match(sql, /FUNCTION public\.get_inventory_dashboard\(/i);
  assert.match(sql, /FUNCTION public\.admin_save_ingredient\(/i);
  assert.match(sql, /FUNCTION public\.admin_record_inventory_movement\(/i);
  assert.match(sql, /FUNCTION public\.admin_set_product_recipe\(/i);
  assert.match(sql, /FUNCTION public\.get_inventory_usage_report\(/i);
  assert.match(sql, /restaurant_provisioning_allowlist/i);
});

test('payment confirmation requires a ready bill and a valid staff panel token', async () => {
  const sql = await read('sql/MASTER_MIGRATION_TABLEFORGE.sql');
  assert.match(sql, /FUNCTION public\.complete_session_payment\(p_session_id uuid,p_payment_method text,p_panel_token text\)/i);
  assert.match(sql, /status='bill_ready' FOR UPDATE/i);
  assert.match(sql, /ARRAY\['cashier','manager','admin'\]/i);
  assert.match(sql, /'upi_qr','cash'/i);
  assert.match(sql, /FUNCTION public\.complete_takeaway_payment\(p_order_id uuid,p_payment_method text,p_panel_token text\)/i);
});
