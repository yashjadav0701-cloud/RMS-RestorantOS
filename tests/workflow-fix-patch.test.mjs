import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('Captain cancellation handler is not attached and controls remain disabled', async () => {
  const source = await read('src/pos/index.js');
  assert.doesNotMatch(source, /modal\.root\.addEventListener\("click",\s*handleCaptainCancellationClick\)/);
  assert.match(source, /const captainCanCancel = false;/);
  assert.match(source, /const captainNeedsAdmin = false;/);
});

test('Cashier and Admin expose actual payment method selection', async () => {
  const cashier = await read('src/cashier/index.js');
  const admin = await read('src/admin/index.js');
  assert.match(cashier, /data-cashier-payment-method/);
  assert.match(cashier, /p_payment_method:\s*method/);
  assert.match(admin, /data-admin-receipt-payment-method/);
  assert.match(admin, /data-admin-close-payment-method/);
});

test('incremental workflow patch physically deletes items and stores payment method', async () => {
  const sql = await read('sql/TABLEFORGE_WORKFLOW_FIX_PATCH.sql');
  assert.match(sql, /ALTER TABLE public\.orders\s+ADD COLUMN IF NOT EXISTS payment_method text/i);
  assert.match(sql, /DELETE FROM public\.order_items/i);
  assert.match(sql, /_tableforge_recalculate_order\(v_order\.id\)/i);
  assert.match(sql, /payment_method = v_method/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.request_dish_cancellation/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.decide_dish_cancellation/i);
});
