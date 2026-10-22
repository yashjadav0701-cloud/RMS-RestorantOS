import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('Admin bill discounts are persisted with separate session and takeaway fields', async () => {
  const sql = await read('sql/ADMIN_BILL_DISCOUNT_PATCH.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS bill_discount_type text/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS bill_discount_amount numeric/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS discount_type text/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS discount_amount numeric/i);
  assert.match(sql, /FUNCTION public\.apply_admin_bill_discount\(/i);
  assert.match(sql, /ARRAY\['admin'\]/i);
  assert.match(sql, /Only an unpaid, open bill-ready dining session can be discounted/i);
  assert.match(sql, /Only an unpaid, open, bill-ready takeaway bill can be discounted/i);
  assert.match(sql, /p_discount_value IS NULL THEN/i);
  assert.match(sql, /nullif\(v_session\.bill_subtotal, 0\)/i);
  assert.match(sql, /fixed discount cannot exceed the bill subtotal/i);
  assert.match(sql, /admin_bill_discount_updated/i);
  assert.match(sql, /FUNCTION public\.generate_cashier_bill\(p_panel_token text,p_order_id uuid DEFAULT NULL,p_session_id uuid DEFAULT NULL\)/i);
  assert.match(sql, /Session discount persists across Cashier reprints/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.apply_admin_bill_discount\(uuid,uuid,text,numeric,text,text\) FROM PUBLIC, anon/i);
});

test('Admin can apply or clear discounts only from an Admin grant and the receipt shows them', async () => {
  const admin = await read('src/admin/index.js');
  const receipt = await read('src/components/navigation.js');
  assert.match(admin, /const canApplyBillDiscount = isAdminPanel && \(isEditableSessionBill \|\| isEditableTakeawayBill\)/);
  assert.match(admin, /rpc\("apply_admin_bill_discount"/);
  assert.match(admin, /p_discount_type: type/);
  assert.match(admin, /p_discount_value: value/);
  assert.match(admin, /p_reason: reason/);
  assert.match(receipt, /discountLineHtml/);
  assert.match(receipt, /Discount \(/);
  assert.match(receipt, /thermal-discount/);
});
