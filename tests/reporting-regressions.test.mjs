import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('Admin revenue/product reports call the tenant-scoped reporting RPC', () => {
  const admin = read('src/admin/index.js');
  const topProducts = read('src/admin/topProducts.js');
  assert.match(admin, /supabase\.rpc\("get_admin_reporting_data"/);
  assert.match(admin, /data-product-chart="products"/);
  assert.match(admin, /data-revenue-chart="trend"/);
  assert.match(topProducts, /supabase\.rpc\("get_admin_reporting_data"/);
  assert.match(topProducts, /p_panel_token: access\.token/);
});

test('audit dashboard reads real stored audit rows through the authorized RPC', () => {
  const audit = read('src/admin/auditDashboard.js');
  const sql = read('sql/IMMEDIATE_BILL_AND_ANALYTICS_FIX.sql');
  assert.match(audit, /supabase\.rpc\("get_admin_audit_dashboard"/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_admin_audit_dashboard/);
  assert.match(sql, /_tableforge_validate_panel_token\(p_panel_token, ARRAY\['admin'\]\)/);
});

test('inventory forecast matches the persisted sale movement type and shows saved recipe coverage', () => {
  const admin = read('src/admin/index.js');
  assert.match(admin, /item\.movementType === "sale"/);
  assert.match(admin, /data-inventory-metric="recipes"/);
  assert.match(admin, /Recipe coverage/);
});

test('non-UPI receipt methods do not display a UPI QR block', () => {
  const navigation = read('src/components/navigation.js');
  assert.match(navigation, /settings\.upi_id && normalizedPaymentMethod === "upi_qr"/);
  assert.match(navigation, /bank_transfer: 'BANK TRANSFER'/);
});
