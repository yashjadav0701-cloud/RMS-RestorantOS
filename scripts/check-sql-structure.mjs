import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  path.join(root, 'sql', 'MASTER_MIGRATION_TABLEFORGE.sql'),
  path.join(root, 'sql', 'TABLEFORGE_WORKFLOW_FIX_PATCH.sql'),
  path.join(root, 'sql', 'IMMEDIATE_BILL_AND_ANALYTICS_FIX.sql'),
  path.join(root, 'sql', 'ADMIN_BILL_DISCOUNT_PATCH.sql'),
  path.join(root, 'sql', 'FOUR_FLAVOURS_MINIMUM_MENU_SECTIONS.sql'),
  path.join(root, 'sql', 'ADMIN_KOT_READY_ALIGNMENT_PATCH.sql'),
  path.join(root, 'sql', 'ADMIN_KOT_READY_ALIGNMENT_AUDIT.sql'),
  path.join(root, 'sql', 'ADMIN_KOT_GST_INVENTORY_ENHANCEMENTS.sql'),
  path.join(root, 'sql', 'AUDIT_KOT_GST_INVENTORY_ENHANCEMENTS.sql'),
  path.join(root, 'sql', 'GSTIN_ONE_TIME_LOCK_PATCH.sql'),
  path.join(root, 'sql', 'TABLEFORGE_RELEASE_SAFETY_PATCH.sql'),
  path.join(root, 'sql', 'DATE_RANGE_REPORT_PATCH.sql'),
  path.join(root, 'sql', 'POST_MIGRATION_VALIDATION.sql'),
  path.join(root, 'sql', 'INGREDIENT_USAGE_RELIABILITY_PATCH.sql'),
  path.join(root, 'sql', 'INGREDIENT_USAGE_ALWAYS_CALCULATE_PATCH.sql'),
  path.join(root, 'sql', 'KOT_READY_SNAPSHOT_VARIABLE_HOTFIX.sql'),
  path.join(root, 'sql', 'VERIFY_KOT_READY_HOTFIX.sql'),
  path.join(root, 'sql', 'VERIFY_INGREDIENT_USAGE_ALWAYS_CALCULATE.sql'),
  path.join(root, 'sql', 'VERIFY_INGREDIENT_USAGE_READINESS.sql')
];
const sources = await Promise.all(files.map(async (file) => ({ file, sql: await readFile(file, 'utf8') })));

function scan(source) {
  let i = 0;
  let state = 'normal';
  let dollarTag = null;
  let parens = 0;
  let topLevelSemicolons = 0;
  const errors = [];
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === 'line-comment') {
      if (c === '\n') state = 'normal';
      i++;
      continue;
    }
    if (state === 'block-comment') {
      if (c === '*' && n === '/') { state = 'normal'; i += 2; }
      else i++;
      continue;
    }
    if (state === 'single-quote') {
      if (c === "'" && n === "'") { i += 2; continue; }
      if (c === "'") state = 'normal';
      i++;
      continue;
    }
    if (state === 'double-quote') {
      if (c === '"' && n === '"') { i += 2; continue; }
      if (c === '"') state = 'normal';
      i++;
      continue;
    }
    if (state === 'dollar-quote') {
      if (source.startsWith(dollarTag, i)) { i += dollarTag.length; state = 'normal'; dollarTag = null; }
      else i++;
      continue;
    }
    if (c === '-' && n === '-') { state = 'line-comment'; i += 2; continue; }
    if (c === '/' && n === '*') { state = 'block-comment'; i += 2; continue; }
    if (c === "'") { state = 'single-quote'; i++; continue; }
    if (c === '"') { state = 'double-quote'; i++; continue; }
    if (c === '$') {
      const m = source.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (m) { dollarTag = m[0]; state = 'dollar-quote'; i += dollarTag.length; continue; }
    }
    if (c === '(') parens++;
    if (c === ')') {
      parens--;
      if (parens < 0) errors.push(`Unexpected closing parenthesis near character ${i}`);
    }
    if (c === ';' && parens === 0) topLevelSemicolons++;
    i++;
  }
  if (state === 'single-quote') errors.push('Unterminated single-quoted string');
  if (state === 'double-quote') errors.push('Unterminated double-quoted identifier');
  if (state === 'block-comment') errors.push('Unterminated block comment');
  if (state === 'dollar-quote') errors.push(`Unterminated dollar-quoted body: ${dollarTag}`);
  if (parens !== 0) errors.push(`Unbalanced parentheses: final depth ${parens}`);
  return { errors, topLevelSemicolons };
}

let failed = false;
let totalFunctions = 0;
let totalStatements = 0;
for (const { file, sql } of sources) {
  const result = scan(sql);
  if (result.errors.length) {
    failed = true;
    process.stderr.write(`SQL structure check failed for ${path.relative(root, file)}:\n${result.errors.map(e => ` - ${e}`).join('\n')}\n`);
  } else {
    totalFunctions += (sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION/gi) || []).length;
    totalStatements += result.topLevelSemicolons;
  }
}
if (failed) process.exitCode = 1;
else process.stdout.write(`SQL lexical structure: PASS (${sources.length} SQL files, ${totalFunctions} function definitions, ${totalStatements} top-level statements; not a PostgreSQL execution test)\n`);
