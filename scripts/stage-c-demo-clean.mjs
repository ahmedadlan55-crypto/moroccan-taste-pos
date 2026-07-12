// ═══════════════════════════════════════════════════════════════════
// stage-c-demo-clean.mjs — remove EVERYTHING seeded by stage-c-demo-seed.mjs
//
// Deletes (direct mysql2 connection, creds from .env):
//   • gl_entries + gl_journals where reference_type='STAGECDEMO'
//   • the reversal journals those seeds spawned
//     (reference_type='reversal' AND reference_id IN <seeded ids> —
//      that is how POST /gl/journals/:id/reverse marks them)
//   • demo cost centers: ids CC-STAGEC-% / codes STC-01..STC-06 with the
//     exact seeded Arabic name list (works on both old `name` and new
//     `name_ar` schemas)
//
// Before deleting, POSTED journals' gl_accounts.balance impact is undone
// (balance -= debit-credit per entry — the exact mirror of what
// POST /gl/journals/:id/post applied).
//
// NOT undone (documented): audit_log rows written by the seed API calls,
// and the accounting_periods.period_name column the seed added (it matches
// the canonical server.js schema and the table is empty — harmless).
//
// Usage:  node scripts/stage-c-demo-clean.mjs
// ═══════════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const mysql = require('mysql2/promise');

function readEnv() {
  const e = {};
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) e[m[1]] = m[2];
  }
  return e;
}
const ENV = readEnv();

// ─── SAFETY GUARD (review fix): direct-SQL deletions — local dev only. ───
const _dbHost = (ENV.DB_HOST || 'localhost').trim().toLowerCase();
const _localHosts = ['localhost', '127.0.0.1', '::1'];
if (!_localHosts.includes(_dbHost) ||
    (process.env.NODE_ENV || ENV.NODE_ENV || '').trim() === 'production') {
  console.error('[stage-c-demo-clean] REFUSED: non-local DB_HOST or NODE_ENV=production.');
  process.exit(2);
}

const CC_NAMES = [
  'الإدارة العامة', 'المطبخ المركزي', 'فرع العليا',
  'فرع النخيل', 'التسويق والتوصيل', 'مشروع التوسعة 2026',
];
const CC_CODES = ['STC-01', 'STC-02', 'STC-03', 'STC-04', 'STC-05', 'STC-06'];

const db = await mysql.createConnection({
  host: ENV.DB_HOST, port: Number(ENV.DB_PORT) || 3306,
  user: ENV.DB_USER, password: ENV.DB_PASSWORD || '', database: ENV.DB_NAME,
});

// 1. Collect seeded journals + the reversals they spawned
const [seeded] = await db.query(
  "SELECT id, journal_number, status FROM gl_journals WHERE reference_type = 'STAGECDEMO'"
);
const seededIds = seeded.map((r) => r.id);
let reversals = [];
if (seededIds.length) {
  const [rev] = await db.query(
    "SELECT id, journal_number, status FROM gl_journals WHERE reference_type = 'reversal' AND reference_id IN (?)",
    [seededIds]
  );
  reversals = rev;
}
const all = [...seeded, ...reversals];
const allIds = all.map((r) => r.id);
console.log(`found ${seeded.length} STAGECDEMO journals + ${reversals.length} linked reversal journals`);

// 2. Undo balance impact of POSTED journals (mirror of the /post endpoint)
let balanceFixes = 0;
for (const j of all) {
  if (j.status !== 'posted') continue;
  const [entries] = await db.query('SELECT account_id, debit, credit FROM gl_entries WHERE journal_id = ?', [j.id]);
  for (const e of entries) {
    if (!e.account_id) continue;
    const net = (Number(e.debit) || 0) - (Number(e.credit) || 0);
    await db.query('UPDATE gl_accounts SET balance = balance - ? WHERE id = ?', [net, e.account_id]);
    balanceFixes++;
  }
}
console.log(`reversed balance impact on ${balanceFixes} entry lines of posted journals`);

// 3. Delete entries then journals
if (allIds.length) {
  const [de] = await db.query('DELETE FROM gl_entries WHERE journal_id IN (?)', [allIds]);
  const [dj] = await db.query('DELETE FROM gl_journals WHERE id IN (?)', [allIds]);
  console.log(`deleted ${de.affectedRows} gl_entries rows, ${dj.affectedRows} gl_journals rows`);
  for (const j of all) console.log(`  removed ${j.journal_number} (${j.id})`);
} else {
  console.log('no seeded journals found — nothing to delete');
}

// 4. Delete demo cost centers (schema-aware: old `name` vs new `name_ar`)
const [ccCols] = await db.query('SHOW COLUMNS FROM cost_centers');
const nameCol = ccCols.some((c) => c.Field === 'name_ar') ? 'name_ar' : 'name';
const [dcc] = await db.query(
  `DELETE FROM cost_centers WHERE (id LIKE 'CC-STAGEC-%' OR code IN (?)) AND ${nameCol} IN (?)`,
  [CC_CODES, CC_NAMES]
);
console.log(`deleted ${dcc.affectedRows} demo cost centers`);

await db.end();
console.log('clean done. (audit_log rows from the seed API calls are intentionally left in place)');
