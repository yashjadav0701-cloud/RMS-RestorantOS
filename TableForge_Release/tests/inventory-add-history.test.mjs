import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/admin/index.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'sql/MASTER_MIGRATION_TABLEFORGE.sql'), 'utf8');

test('Add ingredient presents existing-stock and new-ingredient paths in a themed modal', () => {
  assert.match(source, /title: "Add ingredient"/);
  assert.match(source, /label: "Add to existing"/);
  assert.match(source, /label: "Add new ingredient"/);
  assert.match(source, /inventory-add-choice-grid/);
});

test('stock receipt accepts kg, litres and dozens, converts to canonical base units', () => {
  assert.match(source, /value: "kg", label: "Kilograms \(kg\)", factor: 1000/);
  assert.match(source, /value: "l", label: "Litres \(L\)", factor: 1000/);
  assert.match(source, /value: "dozen", label: "Dozen \(12 pcs\)", factor: 12/);
  assert.match(source, /const baseQuantity = Math\.round\(quantity \* factor \* 1000\) \/ 1000/);
  assert.match(source, /admin_record_inventory_movement/);
});

test('inventory history is a read-only view backed by persisted movement rows', () => {
  assert.match(source, /history: \{/);
  assert.match(source, /activeView === "history"/);
  assert.match(source, /History is read-only/);
  assert.match(source, /inventoryMovementDrafts[\s\S]*?Date & time[\s\S]*?Reason \/ reference/);
});

test('stock values normalize grams to kilograms and millilitres to litres in the UI', () => {
  assert.match(source, /if \(baseUnit === "g"\) \{[\s\S]*?kg/);
  assert.match(source, /if \(baseUnit === "ml"\) \{[\s\S]*?L/);
  assert.match(source, /Last added/);
  assert.match(source, /formatInventoryDate\(lastAdded\.createdAt\)/);
});

test('inventory ledger remains tenant-scoped and direct table writes stay revoked', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.inventory_movements/);
  assert.match(schema, /REVOKE ALL ON public\.inventory_movements FROM PUBLIC, anon, authenticated/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION public\.admin_record_inventory_movement/);
});

test('editing an ingredient opens a themed modal and never renders the edit form inline', () => {
  assert.match(source, /panel\.querySelectorAll\("\[data-edit-ingredient\]"\)[\s\S]*?openAppModal\(/);
  assert.match(source, /title: "Edit ingredient"/);
  assert.match(source, /data-edit-ingredient-form/);
  assert.doesNotMatch(source, /showIngredientForm/);
  assert.doesNotMatch(source, /Edit ingredient draft/);
});

test('ingredient editing uses kg, litres and pieces labels while preserving canonical base units and prices', () => {
  assert.match(source, /function getInventoryDisplayUnit\(baseUnit\)/);
  assert.match(source, /if \(baseUnit === "g" \|\| baseUnit === "kg"\) return "kg"/);
  assert.match(source, /if \(baseUnit === "ml" \|\| baseUnit === "L" \|\| baseUnit === "l"\) return "L"/);
  assert.match(source, /name="purchaseUnit" disabled/);
  assert.match(source, /baseUnit: ingredient\.baseUnit/);
  assert.match(source, /purchasePrice \/ unitFactor/);
  assert.match(source, /getInventoryDisplayUnit\(item\.baseUnit\)/);
});

test('ingredient category combo suggestions are derived from database-loaded tenant ingredients, not hard-coded choices', () => {
  assert.match(source, /function getDatabaseIngredientCategories\(currentValue = ""\)/);
  assert.match(source, /function renderDatabaseIngredientCategoryOptions\(listId, currentValue = ""\)/);
  assert.match(source, /for \(const ingredient of ingredientDrafts\)/);
  assert.match(source, /get_inventory_dashboard/);
  assert.match(source, /data-category-combobox id="inventory-create-category-combobox"/);
  assert.match(source, /data-category-combobox id="inventory-edit-category-combobox"/);
  assert.match(source, /bindInventoryCategoryCombobox\(createModal\.root\)/);
  assert.match(source, /bindInventoryCategoryCombobox\(editModal\.root\)/);
  assert.match(source, /data-category-options role="listbox"/);
  assert.doesNotMatch(source, /<option value="Vegetables">Vegetables<\/option>/);
});

test('ingredient categories accept typed values and normalize to Title Case before both create and edit saves', () => {
  assert.match(source, /function normalizeIngredientCategory\(value\)/);
  assert.match(source, /normalizeIngredientCategory\(form\.elements\.category\.value\)/);
  assert.match(source, /createCategoryInput\?\.addEventListener\("blur"/);
  assert.match(source, /editCategoryInput\?\.addEventListener\("blur"/);
});
