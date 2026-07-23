'use strict';
/* Integration — FC-B1: concurrency-safe GL journal numbering.
 *
 * Before the fix, POST /api/erp/gl/journals (and custody/work-order/vat/payroll
 * journals) derived the next JV-###### from `ORDER BY created_at DESC` on the
 * 1-second-resolution created_at TIMESTAMP; N creates in the same second tied
 * and computed the SAME number, which uq_journal_number then rejected (500) —
 * or worse, mis-parsed a coexisting dated JV-YYYYMMDD-NNNN number. Numbering is
 * now allocated atomically via lib/glPosting.nextFlatJournalNumber()
 * (gl_journal_seq + LAST_INSERT_ID, its own committed txn) guarded by
 * uq_journal_number.
 *
 * Proves: 50 concurrent authorized creates in the same instant → all succeed,
 * all-unique numbers, exactly 50 persisted, each balanced with its 2 entries
 * (no partial), zero 500s / dup-key errors; the generator alone is unique under
 * 50-way concurrency; and a mid-transaction failure rolls the journal back
 * (a consumed sequence number becoming a gap is acceptable, duplicates are not).
 *
 * Run: node tests/integration/glJournalConcurrency.api.test.js
 */
require('dotenv').config();
const harness = require('../helpers/testHarness');
harness.activate();
const http = require('http');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const glPosting = require('../../lib/glPosting');

const USER = 'itest_conc_maker';
const PW = 'Concurrency#Test!2026';
const N = 50;
const PARENT = 'ITEST-CONC-PARENT';
const CASH = 'ITEST-CONC-CASH';
const REV = 'ITEST-CONC-REV';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }

function call(port, method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (port, u) => (await call(port, 'POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';

async function cleanup() {
  try { await db.query('DELETE FROM users WHERE username=?', [USER]); } catch (_) {}
  try { await db.query("DELETE FROM gl_entries WHERE journal_id IN (SELECT id FROM gl_journals WHERE reference_id LIKE 'ITEST-CONC-%')"); } catch (_) {}
  try { await db.query("DELETE FROM gl_journals WHERE reference_id LIKE 'ITEST-CONC-%'"); } catch (_) {}
  for (const id of [CASH, REV, PARENT]) { try { await db.query('DELETE FROM gl_accounts WHERE id=?', [id]); } catch (_) {} }
  try { await db.query("DELETE FROM gl_journal_seq WHERE period_key IN ('JV6','JE5')"); } catch (_) {}
}
async function scaffold() {
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,NULL,1,1,1)', [PARENT, 'ITEST900050', 'مجلّد (ITEST-CONC)', 'asset']);
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)', [CASH, 'ITEST900051', 'صندوق (ITEST-CONC)', 'asset', PARENT]);
  await db.query('INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, is_folder) VALUES (?,?,?,?,?,2,1,0)', [REV, 'ITEST900052', 'إيراد (ITEST-CONC)', 'revenue', PARENT]);
}
function payload(i) {
  return {
    journalDate: '2026-06-15', description: 'concurrency ' + i, referenceType: 'manual', referenceId: 'ITEST-CONC-' + i,
    entries: [
      { accountId: CASH, accountCode: 'ITEST900051', accountName: 'cash', debit: 10, credit: 0, description: 'dr' },
      { accountId: REV, accountCode: 'ITEST900052', accountName: 'rev', debit: 0, credit: 10, description: 'cr' },
    ],
  };
}

(async () => {
  let server = null;
  try {
    await harness.ensureSchema();
    await cleanup();
    console.log('\n═══ FC-B1 GL journal numbering concurrency (isolated test DB) ═══');
    const hash = await bcrypt.hash(PW, 12);
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [USER, hash, 'finance']);
    await scaffold();
    server = await harness.spawnServer();
    const port = server.port;
    const token = await login(port, USER);
    check('finance user authenticates', !!token);

    // ── 1) 50 concurrent creates in the same instant ──────────────────────────
    const t0 = Date.now();
    const resps = await Promise.all(Array.from({ length: N }, (_, i) => call(port, 'POST', '/api/erp/gl/journals', token, payload(i))));
    console.log('  (fired ' + N + ' concurrent creates in ' + (Date.now() - t0) + 'ms)');
    const okResps = resps.filter((r) => r.status === 200 && r.body && r.body.success && r.body.journalNumber);
    check('all ' + N + ' creates returned 200 + success + a journalNumber', okResps.length === N, { ok: okResps.length, sample: resps.find((r) => !(r.status === 200 && r.body && r.body.success)) });
    check('zero HTTP 500s', resps.every((r) => r.status !== 500), resps.filter((r) => r.status === 500).length);
    const nums = okResps.map((r) => r.body.journalNumber);
    check('returned journal numbers are all unique', new Set(nums).size === nums.length, { count: nums.length, unique: new Set(nums).size });
    check('every returned number matches ^JV-\\d{6,}$', nums.every((x) => /^JV-\d{6,}$/.test(x)), nums.slice(0, 3));

    // ── persisted state: exactly N, unique, each balanced with 2 entries ──
    const [rows] = await db.query(
      "SELECT j.journal_number, j.total_debit, j.total_credit, " +
      "(SELECT COUNT(*) FROM gl_entries e WHERE e.journal_id=j.id) AS ecount " +
      "FROM gl_journals j WHERE j.reference_id LIKE 'ITEST-CONC-%'");
    check('exactly ' + N + ' journals persisted (no loss/overwrite)', rows.length === N, rows.length);
    check('persisted journal_numbers all unique', new Set(rows.map((r) => r.journal_number)).size === rows.length, new Set(rows.map((r) => r.journal_number)).size);
    check('every persisted journal has exactly 2 entries (no partial write)', rows.every((r) => Number(r.ecount) === 2), rows.filter((r) => Number(r.ecount) !== 2).length);
    check('every persisted journal is balanced (10=10)', rows.every((r) => Number(r.total_debit) === 10 && Number(r.total_credit) === 10), rows.filter((r) => Number(r.total_debit) !== 10).length);

    // ── 2) the generator alone under 50-way concurrency ──
    const gnums = await Promise.all(Array.from({ length: N }, () => glPosting.nextFlatJournalNumber()));
    check('nextFlatJournalNumber(): ' + N + ' concurrent allocations all unique', new Set(gnums).size === gnums.length, { unique: new Set(gnums).size });

    // ── 3) mid-transaction failure rolls the journal back (gap OK, no dup) ──
    const gapNumber = await glPosting.nextFlatJournalNumber();
    let rolledBack = false;
    try {
      await db.withTransaction(async (conn) => {
        await conn.query(
          "INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by) VALUES (?,?,?,?,?,?,?,?, 'draft', ?)",
          ['ITEST-CONC-ROLLBACK', gapNumber, '2026-06-15', 'manual', 'ITEST-CONC-ROLLBACK', 'will roll back', 10, 10, USER]);
        throw new Error('SIMULATED mid-transaction failure');
      });
    } catch (e) { rolledBack = /SIMULATED/.test(e.message); }
    check('a mid-transaction failure threw as expected', rolledBack);
    const [[gapRow]] = await db.query('SELECT COUNT(*) AS n FROM gl_journals WHERE journal_number=?', [gapNumber]);
    check('the rolled-back journal left NO row (number ' + gapNumber + ' is a harmless gap, not a partial)', Number(gapRow.n) === 0, gapRow);

    await cleanup();
    console.log('\nFC-B1 concurrency: ' + pass + ' passed, ' + fail + ' failed' + (fail ? ' → ' + fails.join('; ') : ''));
    if (server && server.close) await server.close().catch(() => {});
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('FATAL', e);
    try { await cleanup(); } catch (_) {}
    if (server && server.close) try { await server.close(); } catch (_) {}
    process.exit(1);
  }
})();
