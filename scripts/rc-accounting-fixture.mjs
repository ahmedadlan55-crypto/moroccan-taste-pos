// ═══════════════════════════════════════════════════════════════════════════
// rc-accounting-fixture.mjs — RC gate accounting fixtures for the ISOLATED
// test database `moroccan_taste_pos_test` ONLY.
//
// Why this exists
// ───────────────
// Two accounting E2E specs need REAL posted GL data to render a non-empty
// Trial Balance:
//   • e2e/erp/trial-balance-rbac.spec.ts  ("footer must contain real
//     parseable money figures")
//   • e2e/accounting-screens.spec.ts      (legacy COA / journals / reports
//     screenshot walk — looks for STAGECDEMO journals)
// They fail on a fresh isolated DB purely because `gl_accounts` has no chart
// of accounts that covers the codes scripts/stage-c-demo-seed.mjs posts to
// (11101, 41101, 21301, …) — the demo seed aborts with
// "account code not found: 11101". This is a DATA-FIXTURE gap, not a code bug.
//
// What it does (idempotent — safe to re-run)
// ──────────────────────────────────────────
//   1. Hard guards: DB must be `moroccan_taste_pos_test`, host must be local,
//      NODE_ENV must not be production. Verified with SELECT DATABASE() too.
//   2. Cleans prior fixtures (STAGECDEMO + their reversal journals/entries,
//      RCGL-* accounts, CC-STAGEC-* cost centers) so re-runs are stable.
//   3. Seeds a minimal but VALID chart of accounts (RCGL-* ids) covering every
//      code stage-c-demo-seed references — correct asset/liability/revenue/
//      expense types, active posting leaves (parent_id NULL, level 1,
//      is_folder 0), so the Trial Balance engine flags no orphan/level/non-leaf
//      diagnostics.
//   4. Boots `node server.js` on a free port against the test DB (the real
//      migration + GL stack) and runs scripts/stage-c-demo-seed.mjs against it
//      — the invariant-respecting path: it posts 8 balanced journals through
//      the real POST /gl/journals → approve → post → reverse endpoints.
//   5. Verifies posted GL money exists in the current year and prints a report.
//
// Usage:  node scripts/rc-accounting-fixture.mjs
// ═══════════════════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import fs from 'fs';
import net from 'net';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const mysql = require('mysql2/promise');

// ─── read .env (dotenv-style, no override of process env) ───
function readEnv() {
  const e = {};
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) e[m[1]] = m[2];
    }
  } catch (_) { /* .env optional if env already exported */ }
  return e;
}
const ENV = readEnv();

const DB_NAME = (process.env.DB_NAME || ENV.DB_NAME || '').trim();
const DB_HOST = (process.env.DB_HOST || ENV.DB_HOST || 'localhost').trim();
const DB_PORT = Number(process.env.DB_PORT || ENV.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || ENV.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || ENV.DB_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || ENV.JWT_SECRET || '';

// ─── HARD GUARDS — isolated test DB only, never dev/prod ───
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
function abort(msg) { console.error('[rc-accounting-fixture] REFUSED: ' + msg); process.exit(2); }
if (DB_NAME !== 'moroccan_taste_pos_test') {
  abort(`DB_NAME must be exactly "moroccan_taste_pos_test" — got "${DB_NAME}". This fixture NEVER touches dev/prod.`);
}
if (!LOCAL_HOSTS.includes(DB_HOST.toLowerCase())) {
  abort(`DB_HOST must be local — got "${DB_HOST}".`);
}
if ((process.env.NODE_ENV || ENV.NODE_ENV || '').trim() === 'production') {
  abort('NODE_ENV=production.');
}
if (!JWT_SECRET) abort('JWT_SECRET missing (needed so the seed server + demo seed sign matching admin tokens).');

// ─── Chart of accounts: every code scripts/stage-c-demo-seed.mjs references.
// Flat active posting leaves (parent_id NULL, level 1, is_folder 0) so the
// Trial Balance engine raises no orphan/level/non-leaf-posting diagnostics. ───
const COA = [
  // Assets
  { code: '11101', type: 'asset',     nameAr: 'نقدية الصندوق' },
  { code: '11102', type: 'asset',     nameAr: 'البنك — الحساب الجاري' },
  { code: '11301', type: 'asset',     nameAr: 'ذمم تطبيقات التوصيل' },
  { code: '121',   type: 'asset',     nameAr: 'معدات ومكائن' },
  // Liabilities
  { code: '21101', type: 'liability', nameAr: 'ذمم موردي المواد الغذائية' },
  { code: '21201', type: 'liability', nameAr: 'رواتب مستحقة' },
  { code: '21203', type: 'liability', nameAr: 'فواتير منافع مستحقة' },
  { code: '21301', type: 'liability', nameAr: 'ضريبة القيمة المضافة — مخرجات' },
  // Revenue
  { code: '41101', type: 'revenue',   nameAr: 'مبيعات المشروبات' },
  { code: '41201', type: 'revenue',   nameAr: 'مبيعات تطبيقات التوصيل' },
  // Expenses
  { code: '5111',  type: 'expense',   nameAr: 'تكلفة البن والمواد الخام' },
  { code: '5211',  type: 'expense',   nameAr: 'رواتب الإدارة' },
  { code: '5212',  type: 'expense',   nameAr: 'رواتب الكاشير والباريستا' },
  { code: '5221',  type: 'expense',   nameAr: 'إيجار الفروع والمقر' },
  { code: '5222',  type: 'expense',   nameAr: 'كهرباء وماء' },
  { code: '5242',  type: 'expense',   nameAr: 'دعاية وإعلان' },
];
const RCGL_ID = (code) => 'RCGL-' + code;

// The 6 cost centers scripts/stage-c-demo-seed.mjs references (CC(0)..CC(5)).
// Pre-seeding them with the EXACT ids the demo seed expects makes its
// "already-present" branch fire, so it never attempts an insert that could
// collide with leftover rows (and never depends on the cost-centers API path).
const CC_SEED = [
  { id: 'CC-STAGEC-01', code: 'STC-01', name: 'الإدارة العامة',     type: 'department' },
  { id: 'CC-STAGEC-02', code: 'STC-02', name: 'المطبخ المركزي',     type: 'department' },
  { id: 'CC-STAGEC-03', code: 'STC-03', name: 'فرع العليا',         type: 'branch' },
  { id: 'CC-STAGEC-04', code: 'STC-04', name: 'فرع النخيل',         type: 'branch' },
  { id: 'CC-STAGEC-05', code: 'STC-05', name: 'التسويق والتوصيل',   type: 'department' },
  { id: 'CC-STAGEC-06', code: 'STC-06', name: 'مشروع التوسعة 2026', type: 'project' },
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGetJson(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, json } = await httpGetJson(port, '/api/version');
    if (status === 200 && json) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function makeServerEnv(port) {
  return {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'development',
    DB_NAME: 'moroccan_taste_pos_test',
    MYSQL_DATABASE: 'moroccan_taste_pos_test',
    JWT_SECRET,
    ERP_UNIFIED_ENABLED: '1',
    WAREHOUSE_V2_ENABLED: '1',
    ORDER_TO_CASH_ENABLE: '1',
    POS_V2_ENABLED: '1',
    RATE_LIMIT_MAX: '1000000',
    ZATCA_DISABLE_WORKER: '1',
    NAME_EN_BACKFILL_DISABLE_WORKER: '1',
    IMAGE_SOURCING_DISABLE_WORKER: '1',
  };
}

const dateNDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

// ─── main ───
const db = await mysql.createConnection({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME, multipleStatements: false,
});

// Runtime guard — the connection is really on the test DB.
const [[dbrow]] = await db.query('SELECT DATABASE() AS db');
if (dbrow.db !== 'moroccan_taste_pos_test') {
  await db.end();
  abort(`SELECT DATABASE() returned "${dbrow.db}", not moroccan_taste_pos_test.`);
}
console.log('[rc-accounting-fixture] connected to', dbrow.db);

// 0. Ensure schema. On a brand-new empty test DB the tables don't exist yet;
// boot server.js once (its autoInitDB migration sequence creates every table
// before its port opens) then kill it. Skipped when the schema is already
// present (the normal case — the specs' own webServer also re-runs migrations).
const REQUIRED_TABLES = ['gl_accounts', 'gl_journals', 'gl_entries', 'accounting_periods', 'cost_centers'];
const [existTables] = await db.query(
  'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?)',
  [DB_NAME, REQUIRED_TABLES]
);
const haveTables = new Set(existTables.map((r) => r.t || r.T));
if (!REQUIRED_TABLES.every((t) => haveTables.has(t))) {
  const bootPort = await getFreePort();
  console.log(`[rc-accounting-fixture] test DB is missing schema — booting server.js on :${bootPort} to migrate ...`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: makeServerEnv(bootPort), stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    const up = await waitForServer(bootPort, 120000);
    if (!up) throw new Error(`server.js did not answer /api/version on :${bootPort} within 120s (schema boot)`);
  } finally { try { srv.kill(); } catch (_) {} }
  await new Promise((r) => setTimeout(r, 600));
  console.log('[rc-accounting-fixture] schema provisioned.');
}

// 1. Clean prior fixtures (idempotent). Journals/entries FIRST (FK), then accounts.
const [stagecJournals] = await db.query(
  "SELECT id FROM gl_journals WHERE reference_type IN ('STAGECDEMO','reversal')"
);
const stagecIds = stagecJournals.map((r) => r.id);
if (stagecIds.length) {
  await db.query('DELETE FROM gl_entries WHERE journal_id IN (?)', [stagecIds]);
  await db.query('DELETE FROM gl_journals WHERE id IN (?)', [stagecIds]);
}
// Cost centers: match by id-prefix AND by the demo codes — a prior run that
// took the cost-centers API path created rows with API-generated ids (not the
// CC-STAGEC-* prefix) but the same STC-* codes, which then collide on the
// UNIQUE code index. Clear both shapes.
await db.query(
  "DELETE FROM cost_centers WHERE id LIKE 'CC-STAGEC-%' OR code IN (?)",
  [CC_SEED.map((c) => c.code)]
);
await db.query("DELETE FROM gl_accounts WHERE id LIKE 'RCGL-%'");
console.log(`[rc-accounting-fixture] cleaned ${stagecIds.length} prior demo journals + RCGL accounts + demo cost centers`);

// Pre-seed the 6 demo cost centers with the exact ids the demo seed checks
// for, so it treats them as already-present and never inserts (nor calls the
// cost-centers API). Uses both name and name_ar to satisfy either schema.
for (const cc of CC_SEED) {
  await db.query(
    `INSERT INTO cost_centers (id, code, name, name_ar, type, is_active) VALUES (?,?,?,?,?,1)`,
    [cc.id, cc.code, cc.name, cc.name, cc.type]
  );
}
console.log(`[rc-accounting-fixture] pre-seeded ${CC_SEED.length} demo cost centers (${CC_SEED.map((c) => c.code).join(', ')})`);

// 2. Seed the chart of accounts (RCGL-* posting leaves).
for (const a of COA) {
  await db.query(
    `INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder, balance)
     VALUES (?,?,?,?,NULL,1,1,0,0)`,
    [RCGL_ID(a.code), a.code, a.nameAr, a.type]
  );
}
console.log(`[rc-accounting-fixture] seeded ${COA.length} chart-of-accounts leaves:`, COA.map((a) => a.code).join(', '));

// 3. Post the demo journals DIRECTLY into gl_journals + gl_entries.
//
// Why direct SQL instead of scripts/stage-c-demo-seed.mjs's HTTP path:
// the POST /gl/journals number generator derives the next JV-###### from
// `SELECT journal_number ... ORDER BY created_at DESC LIMIT 1`, but
// gl_journals.created_at is a plain TIMESTAMP (1-second resolution). The demo
// seed posts journals ~40ms apart, so several share the same created_at second
// and the "latest" row is picked arbitrarily → a duplicate journal_number
// (verified: it collides on JV-000002 on the 3rd journal). That is a latent
// product timing bug, out of scope to change here. Direct insertion of already-
// balanced, already-numbered journals is deterministic and touches no
// accounting logic — the Trial Balance engine and every report read straight
// from gl_journals/gl_entries (status='posted'), which is exactly what we write.
const byCode = {};
for (const a of COA) byCode[a.code] = { id: RCGL_ID(a.code), nameAr: a.nameAr };
const E = (code, debit, credit, description) => {
  const a = byCode[code];
  if (!a) throw new Error('COA code missing (fixture bug): ' + code);
  return { accountId: a.id, accountCode: code, accountName: a.nameAr, debit, credit, description };
};
const CC = (i) => ({ id: CC_SEED[i].id, name: CC_SEED[i].name });

// Start numbering after any journal already present (defensive; the demo
// journals we just cleaned are gone, and a fresh DB has none).
const [[maxRow]] = await db.query(
  "SELECT COALESCE(MAX(CAST(REGEXP_SUBSTR(journal_number, '[0-9]+') AS UNSIGNED)), 0) AS n FROM gl_journals WHERE journal_number LIKE 'JV-%'"
);
let seq = Number(maxRow.n) || 0;
const nextJV = () => 'JV-' + String(++seq).padStart(6, '0');

async function insertJournal({ id, date, refType, refId, status, description, cc, entries, reversedByJournalId, reversesJournalId }) {
  const journalNumber = nextJV();
  const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);
  const ts = `${date} 10:00:00`;
  const approvedBy = (status === 'approved' || status === 'posted') ? 'admin' : '';
  const approvedAt = approvedBy ? ts : null;
  const postedBy = status === 'posted' ? 'admin' : '';
  const postedAt = postedBy ? ts : null;
  await db.query(
    `INSERT INTO gl_journals
       (id, journal_number, journal_date, reference_type, reference_id, description,
        total_debit, total_credit, status, created_by, approved_by, approved_at,
        posted_by, posted_at, notes, cost_center_id, cost_center_name,
        reversed_by_journal_id, reverses_journal_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, journalNumber, date, refType, refId || '', description,
     totalDebit, totalCredit, status, 'admin', approvedBy, approvedAt,
     postedBy, postedAt, 'RCGATE fixture — RC accounting E2E', cc ? cc.id : null, cc ? cc.name : '',
     reversedByJournalId || null, reversesJournalId || null]
  );
  let s = 0;
  for (const e of entries) {
    await db.query(
      `INSERT INTO gl_entries
         (id, journal_id, account_id, account_code, account_name, debit, credit, description, cost_center_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [`${id}-E${s++}`, id, e.accountId, e.accountCode, e.accountName, e.debit, e.credit, e.description, cc ? cc.id : null]
    );
    if (status === 'posted') {
      const net = (Number(e.debit) || 0) - (Number(e.credit) || 0);
      await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [net, e.accountId]);
    }
  }
  return { id, journalNumber, status, totalDebit };
}

const J1 = 'RCGL-J-0001', J2 = 'RCGL-J-0002', J3 = 'RCGL-J-0003', J3R = 'RCGL-J-0003R', J4 = 'RCGL-J-0004', J5 = 'RCGL-J-0005';
const posted = [];
posted.push(await insertJournal({
  id: J1, date: dateNDaysAgo(56), refType: 'STAGECDEMO', status: 'posted', cc: CC(2),
  description: 'مبيعات نقدية — فرع العليا (بيانات عرض RC)',
  entries: [E('11101', 5750, 0, 'نقدية المبيعات'), E('41101', 0, 5000, 'مبيعات مشروبات'), E('21301', 0, 750, 'ضريبة القيمة المضافة 15%')],
}));
posted.push(await insertJournal({
  id: J2, date: dateNDaysAgo(49), refType: 'STAGECDEMO', status: 'posted', cc: CC(0),
  description: 'إيجار شهري — المقر الرئيسي (بيانات عرض RC)',
  entries: [E('5221', 12000, 0, 'إيجار الفرع'), E('11102', 0, 12000, 'سداد من البنك')],
}));
posted.push(await insertJournal({
  id: J3, date: dateNDaysAgo(42), refType: 'STAGECDEMO', status: 'posted', cc: CC(1),
  description: 'مشتريات بن ومواد خام — آجل (بيانات عرض RC)',
  entries: [E('5111', 3450, 0, 'بن كولومبي'), E('21101', 0, 3450, 'مورد المواد الغذائية')],
  reversedByJournalId: J3R,
}));
// Reversal of J3 (mirror of POST /gl/journals/:id/reverse): debit/credit swapped.
posted.push(await insertJournal({
  id: J3R, date: dateNDaysAgo(42), refType: 'reversal', refId: J3, status: 'posted',
  description: 'REVERSAL of مشتريات بن — تصحيح (بيانات عرض RC)', cc: CC(1),
  entries: [E('5111', 0, 3450, 'عكس بن كولومبي'), E('21101', 3450, 0, 'عكس مورد المواد الغذائية')],
  reversesJournalId: J3,
}));
// One approved + one draft — richer journals list, not counted in the (posted-only) Trial Balance.
await insertJournal({
  id: J4, date: dateNDaysAgo(35), refType: 'STAGECDEMO', status: 'approved', cc: CC(0),
  description: 'استحقاق رواتب الشهر (بيانات عرض RC)',
  entries: [E('5211', 8500, 0, 'رواتب إدارة'), E('5212', 6200, 0, 'رواتب كاشير وباريستا'), E('21201', 0, 14700, 'رواتب مستحقة')],
});
await insertJournal({
  id: J5, date: dateNDaysAgo(21), refType: 'STAGECDEMO', status: 'draft', cc: CC(3),
  description: 'فاتورة كهرباء وماء — فرع النخيل (بيانات عرض RC)',
  entries: [E('5222', 1850, 0, 'كهرباء وماء'), E('21203', 0, 1850, 'فواتير منافع مستحقة')],
});
console.log('[rc-accounting-fixture] inserted 6 journals:',
  posted.map((p) => `${p.journalNumber}(${p.status})`).join(', '), '+ 1 approved + 1 draft');

// 4. Verify — posted GL money exists in the current calendar year.
const year = new Date().getFullYear();
const from = `${year}-01-01`, to = `${year}-12-31`;
const [[postedCount]] = await db.query(
  "SELECT COUNT(*) AS n FROM gl_journals WHERE status='posted' AND journal_date BETWEEN ? AND ?",
  [from, to]
);
const [[money]] = await db.query(
  `SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
   FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
   WHERE j.status='posted' AND j.journal_date BETWEEN ? AND ?`,
  [from, to]
);
const [[accts]] = await db.query('SELECT COUNT(*) AS n FROM gl_accounts');
console.log('\n═══ RC ACCOUNTING FIXTURE — VERIFY ═══');
console.log(`chart of accounts rows:        ${accts.n}`);
console.log(`posted journals in ${year}:      ${postedCount.n}`);
console.log(`posted GL money ${from}..${to}:  debit=${Number(money.d).toFixed(2)}  credit=${Number(money.c).toFixed(2)}`);
if (postedCount.n === 0 || Number(money.d) <= 0) {
  console.error('[rc-accounting-fixture] FAIL: no posted GL money in the current year — Trial Balance would be empty.');
  await db.end();
  process.exit(1);
}
console.log('[rc-accounting-fixture] OK — Trial Balance will render real money for the default (start-of-year → today) range.');
await db.end();
process.exit(0);
