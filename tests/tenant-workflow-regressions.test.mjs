import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cashier = readFileSync(new URL('../src/cashier/index.js', import.meta.url), 'utf8');
const navigation = readFileSync(new URL('../src/components/navigation.js', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../src/admin/index.js', import.meta.url), 'utf8');
const sql = readFileSync(new URL('../sql/TABLEFORGE_WORKFLOW_FIX_PATCH.sql', import.meta.url), 'utf8');

test('cashier must deliberately select a payment method before bill generation', () => {
  assert.match(cashier, /Choose payment method…/);
  assert.match(cashier, /Choose UPI QR or Cash before generating the bill/);
  assert.match(cashier, /set_bill_payment_method/);
});

test('receipt QR follows the selected method and shows method on the receipt', () => {
  assert.match(navigation, /settings\.upi_id && paymentMethod !== "cash"/);
  assert.match(navigation, /Payment method:/);
});

test('served items do not show the ordinary Admin delete control', () => {
  assert.match(admin, /item\.status === "served" \? "hidden disabled"/);
});

test('workflow configuration and inventory policy are scoped to a restaurant', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.restaurant_workflow_settings/);
  assert.match(sql, /PRIMARY KEY REFERENCES public\.restaurants\(id\)/);
  assert.match(sql, /_tableforge_validate_panel_token\(p_panel_token, ARRAY\['admin'\]\)/);
  assert.match(sql, /inventory_mode IN \('disabled','strict'\)/);
});

test('strict inventory snapshots and consumes recipes at first Preparing transition', () => {
  assert.match(sql, /inventory_recipe_snapshot jsonb/);
  assert.match(sql, /NEW\.serving_status='preparing'/);
  assert.match(sql, /Insufficient stock for/);
  assert.match(sql, /inventory_consumed_at IS NULL/);
});
