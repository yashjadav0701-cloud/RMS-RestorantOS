import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pos = await readFile(path.join(root, 'src/pos/index.js'), 'utf8');
const admin = await readFile(path.join(root, 'src/admin/index.js'), 'utf8');
const sql = await readFile(path.join(root, 'sql/FOUR_FLAVOURS_MINIMUM_MENU_SECTIONS.sql'), 'utf8');

test('menu taxonomy is cuisine-independent and global sections survive cuisine filtering', () => {
  assert.match(pos, /String\(product\?\.cuisine\s*\|\|\s*""\)/);
  assert.match(pos, /productCuisine\s*!==\s*activeCuisine\s*&&\s*productCuisine\s*!==\s*"Global"/);
  assert.match(pos, /pCuisine\s*!==\s*activeCuisine\s*&&\s*pCuisine\s*!==\s*"Global"/);
  assert.match(admin, /cuisine:\s*mainCat/);
  assert.match(admin, /pCuisine\s*===\s*"Global"/);
});

test('menu migration scopes changes to Four Flavours and separates cuisine from section', () => {
  assert.match(sql, /ALTER TABLE public\.products ADD COLUMN IF NOT EXISTS cuisine text/i);
  assert.match(sql, /197ff1e2-dd53-47a4-a5d5-46b3896ac021/g);
  assert.match(sql, /'Papad'/);
  assert.match(sql, /'Salads'/);
  assert.match(sql, /'Desserts'/);
  assert.match(sql, /'Beverages'/);
  assert.match(sql, /price_review_required/);
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM public\.products/s);
  assert.match(sql, /'cuisine',p\.cuisine/i);
});
