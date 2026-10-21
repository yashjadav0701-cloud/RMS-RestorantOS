import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsFiles = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) jsFiles.push(full);
  }
}
await walk(root);
let failed = false;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`SYNTAX FAIL: ${path.relative(root, file)}\n${result.stderr || result.stdout}\n`);
  }
}
if (!failed) process.stdout.write(`JavaScript syntax: PASS (${jsFiles.length} files)\n`);

const sourceFiles = [];
for (const dir of ['.', 'src']) {
  const base = path.join(root, dir);
  try { await access(base); } catch { continue; }
  async function collect(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await collect(full);
      else if (entry.isFile() && /\.(?:js|html|css)$/.test(entry.name)) sourceFiles.push(full);
    }
  }
  await collect(base);
}
const missing = [];
const importPattern = /(?:\bfrom\s*|\bimport\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g;
for (const file of new Set(sourceFiles)) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const resolved = path.resolve(path.dirname(file), specifier);
    try { await access(resolved); }
    catch { missing.push(`${path.relative(root, file)} -> ${specifier}`); }
  }
}
if (missing.length) {
  failed = true;
  process.stderr.write(`Relative imports/assets unresolved:\n${missing.map(x => ` - ${x}`).join('\n')}\n`);
} else {
  process.stdout.write('Relative JavaScript imports: PASS\n');
}

try {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (!manifest.name || !Array.isArray(manifest.icons)) throw new Error('name or icons array missing');
  for (const icon of manifest.icons) {
    if (!icon.src) throw new Error('icon entry missing src');
    const iconPath = path.resolve(root, icon.src.replace(/^\//, '').split('?')[0].split('#')[0]);
    try { await access(iconPath); } catch { throw new Error(`manifest icon not found: ${icon.src}`); }
  }
  process.stdout.write('PWA manifest and icon paths: PASS\n');
} catch (error) {
  failed = true;
  process.stderr.write(`PWA manifest: FAIL: ${error.message}\n`);
}

if (failed) process.exitCode = 1;
