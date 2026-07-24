#!/usr/bin/env node
'use strict';
/**
 * Gate guard — fail if any BACKEND SQL string calls a MySQL built-in that the
 * PRODUCTION MySQL major version has removed.
 *
 * WHY THIS EXISTS
 *   Production MySQL is 9.6, which removed the `SHA1()` and `MD5()` built-ins
 *   (`SELECT SHA1(0x61)` → "FUNCTION <db>.SHA1 does not exist"). The local/gate
 *   MySQL is 8.4, where they still exist — so a query using them passes every
 *   local test yet 500s in production the moment the row is read. The menu list,
 *   POS catalog, and product-images list all went down this way after a deploy
 *   that was fully green on 8.4. A gate on 8.4 cannot catch a 9.x-only removal at
 *   runtime; this static scan catches the whole class regardless of the local
 *   server version.
 *
 * WHAT IT MATCHES
 *   The SQL call form `NAME(` for each removed function. It deliberately does NOT
 *   flag Node's crypto (`crypto.createHash('sha1')` writes `'sha1')`, never
 *   `SHA1(`), and any line calling create{Hash,Hmac,Sign,Verify} is skipped).
 *   Use `SHA2(x,256)` in SQL instead of `SHA1(x)`/`MD5(x)`; Node crypto is fine.
 *
 *   Add to REMOVED as new prod/local incompatibilities are found.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REMOVED = ['SHA1', 'MD5']; // removed in MySQL 9.x, present in 8.4
const DIRS = ['routes', 'lib', 'db', 'middleware'];
const EXTRA_FILES = ['server.js'];
const EXT = /\.(js|sql)$/;

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (EXT.test(e.name)) out.push(p);
  }
}

const files = [];
for (const d of DIRS) walk(path.join(ROOT, d), files);
for (const f of EXTRA_FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p)) files.push(p); }

// Case-SENSITIVE, UPPERCASE only: the SQL these queries send writes the built-in
// as `SHA1(`/`MD5(` (SQL convention here), while Node helpers and prose write
// lowercase `sha1(` — matching uppercase avoids flagging comments/helpers. `\b`
// also excludes `_sha1(` (no word boundary after `_`).
const re = new RegExp('\\b(' + REMOVED.join('|') + ')\\s*\\(', 'g');
const violations = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (/^(\/\/|\*|\/\*|--|#)/.test(trimmed)) return; // whole-line comment (JS/SQL)
    if (/create(Hash|Hmac|Sign|Verify)\s*\(/.test(line)) return; // Node crypto — fine
    const code = line.replace(/\/\/.*$/, '').replace(/--.*$/, ''); // strip trailing comments
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) {
      violations.push({ file: path.relative(ROOT, f), line: i + 1, fn: m[1], text: trimmed.slice(0, 120) });
    }
  });
}

if (violations.length) {
  console.error(`❌ ${violations.length} SQL use(s) of a MySQL-9-removed built-in (${REMOVED.join('/')}) — these throw in production:`);
  for (const v of violations) console.error(`   ${v.file}:${v.line}  ${v.fn}(  ->  ${v.text}`);
  console.error('\nReplace SHA1(x)/MD5(x) with SHA2(x,256) in SQL. (Node crypto.createHash is unaffected.)');
  process.exit(1);
}
console.log(`✅ sql-removed-functions: no ${REMOVED.join('/')}() in SQL across ${files.length} backend files`);
process.exit(0);
