/**
 * Phase 3A.1 — Empty-database bootstrap test.
 *
 * Creates a brand-new EMPTY database, boots server.js against it via the
 * official path (plain `npm start` → autoInitDB → schema.sql + runMigrations),
 * and proves the schema is complete with ZERO manual ALTER:
 *   • every required table exists (incl. gl_journals/gl_entries/gl_journal_seq),
 *   • the migration-added columns exist (gl_journals.posted_by/posted_at,
 *     stock_issues.version, idempotency_keys.request_hash),
 *   • the server actually started (answers /api/version).
 * Also boots a SECOND server against the same fresh DB concurrently to show two
 * migrations racing don't corrupt the schema. Drops the test DB at the end.
 *
 * Run: node tests/integration/bootstrap.empty-db.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const mysql = require('mysql2/promise');
const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.BOOT_TEST_PORT || 3221);
const PORT2 = PORT + 1;
const TEST_DB = 'mtpos_boot_test';
const ADMIN = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
};

const REQUIRED_TABLES = [
  'users', 'gl_accounts', 'gl_journals', 'gl_entries', 'gl_journal_seq',
  'accounting_periods', 'stock_issues', 'stock_issue_items', 'stock_issue_events', 'idempotency_keys',
  // Phase 3B — independent inventory transactions (receipts / issues / adjustments).
  'inv_receipts', 'inv_receipt_items', 'inv_issues', 'inv_issue_items',
  'inv_adjustments', 'inv_adjustment_items', 'inv_tx_events', 'inv_tx_counter',
  // Phase 3C — professional stocktake & reconciliation.
  'inv_stocktakes', 'inv_stocktake_items',
  // Phase 4A.
  'inventory_movements', 'inv_items', 'warehouse_item_rules',
  // Phase 4B — lots / expiry / FEFO / traceability core tables.
  'inventory_lots', 'warehouse_lot_balances', 'inventory_lot_movements',
  // Phase 4B — transfer + production lot genealogy.
  'lot_transfer_allocations', 'work_order_lot_consumption', 'production_output_lots',
];
const REQUIRED_COLUMNS = [
  ['gl_journals', 'posted_by'], ['gl_journals', 'posted_at'],
  ['stock_issues', 'version'], ['idempotency_keys', 'request_hash'],
  ['gl_journals', 'journal_number'],
  // Phase 3B — the columns the new lifecycle depends on.
  ['inv_receipts', 'version'], ['inv_receipt_items', 'posted_unit_cost'],
  ['inv_issues', 'reason'], ['inv_adjustment_items', 'counted_qty'],
  ['inv_adjustment_items', 'system_qty_snapshot'],
  // Phase 3C closure — receipt counter account + stocktake snapshot/theoretical.
  ['inv_receipts', 'counter_account_code'],
  ['inv_stocktakes', 'snapshot_at'], ['inv_stocktakes', 'scope_type'],
  ['inv_stocktake_items', 'counted_qty'], ['inv_stocktake_items', 'theoretical_qty'],
  // Phase 4A (3C closure) — monotonic movement seq window.
  ['inventory_movements', 'seq'],
  ['inv_stocktakes', 'snapshot_seq'], ['inv_stocktake_items', 'counted_seq'],
  // Phase 4A — item master + per-warehouse replenishment rules.
  ['inv_items', 'sku'], ['inv_items', 'version'],
  ['warehouse_item_rules', 'reorder_point'], ['warehouse_item_rules', 'version'],
  // Phase 4B — lots / expiry / FEFO / traceability.
  ['inv_items', 'tracking_mode'],
  ['inventory_lots', 'lot_norm'], ['inventory_lots', 'expiry_date'], ['inventory_lots', 'lifecycle_status'], ['inventory_lots', 'version'],
  ['warehouse_lot_balances', 'qty'], ['warehouse_lot_balances', 'item_id'],
  ['inventory_lot_movements', 'inventory_movement_seq'], ['inventory_lot_movements', 'signed_qty'],
];

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function ping(port) { return new Promise((r) => { const q = http.get({ host: '127.0.0.1', port, path: '/api/version' }, (s) => { s.resume(); r(true); }); q.on('error', () => r(false)); q.setTimeout(1000, () => { q.destroy(); r(false); }); }); }
async function waitUp(port, secs) { for (let i = 0; i < secs * 2; i++) { if (await ping(port)) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function bootServer(port, logBuf) {
  const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), DB_NAME: TEST_DB, DATABASE_URL: '', MYSQL_URL: '' } });
  if (logBuf) { child.stdout.on('data', (d) => logBuf.push(d.toString())); child.stderr.on('data', (d) => logBuf.push(d.toString())); }
  return child;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Empty-DB bootstrap (official path, no manual ALTER) ═══\n');
  let exitCode = 0;
  const admin = await mysql.createConnection(ADMIN);
  const servers = [];
  try {
    await admin.query('DROP DATABASE IF EXISTS ' + TEST_DB);
    await admin.query('CREATE DATABASE ' + TEST_DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    console.log('  • created empty database `' + TEST_DB + '`');

    // ── Phase A: a SINGLE `npm start` bootstraps the empty DB (the core proof:
    //    official path, zero manual ALTER). The initial schema.sql load is a
    //    one-process first-run step, so we don't race it.
    const log = [];
    servers.push(bootServer(PORT, log));
    const up = await waitUp(PORT, 90);
    check('server started on a brand-new empty DB (answers /api/version)', up, { port: PORT });

    // The listen callback runs autoInitDB ASYNCHRONOUSLY (the port binds before
    // migrations finish), so poll the schema until the LAST-created tables
    // appear (or time out) before asserting.
    const conn = await mysql.createConnection(Object.assign({}, ADMIN, { database: TEST_DB }));
    async function tableSet() {
      const [t] = await conn.query('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?', [TEST_DB]);
      return new Set(t.map((r) => r.TABLE_NAME || r.table_name));
    }
    let have = new Set();
    for (let i = 0; i < 120; i++) { have = await tableSet(); if (REQUIRED_TABLES.every((t) => have.has(t))) break; await new Promise((z) => setTimeout(z, 1000)); }
    for (const t of REQUIRED_TABLES) check('table created: ' + t, have.has(t), [...have].length + ' tables total');
    for (const [t, c] of REQUIRED_COLUMNS) {
      const [cols] = await conn.query(
        'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?', [TEST_DB, t, c]);
      check('column present: ' + t + '.' + c, cols.length === 1);
    }
    // The default admin user is seeded by the official path.
    const [[u]] = await conn.query('SELECT COUNT(*) AS n FROM users');
    check('default admin user seeded (no manual data step)', Number(u.n) >= 1, u);

    // ── Phase B: two MORE servers boot CONCURRENTLY against the now-bootstrapped
    //    DB → both run the idempotent runMigrations at once → schema must stay
    //    intact (no duplicate unique index, all tables still present).
    servers.push(bootServer(PORT2, null));
    servers.push(bootServer(PORT2 + 1, null));
    const raceA = await waitUp(PORT2, 60);
    const raceB = await waitUp(PORT2 + 1, 60);
    check('two concurrent re-migrations both start cleanly', raceA && raceB, { raceA, raceB });
    const [tbls2] = await conn.query('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?', [TEST_DB]);
    const have2 = new Set(tbls2.map((r) => r.TABLE_NAME || r.table_name));
    check('all required tables still present after concurrent migration', REQUIRED_TABLES.every((t) => have2.has(t)));
    const [[uq]] = await conn.query(
      "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='gl_journals' AND NON_UNIQUE=0 AND COLUMN_NAME='journal_number'", [TEST_DB]);
    check('gl_journals unique(journal_number) NOT duplicated by the race', Number(uq.n) === 1, uq);
    await conn.end();

    // ── Phase C: TWO servers boot CONCURRENTLY against a SECOND brand-new EMPTY
    //    DB → they race the FIRST-RUN schema.sql + migrations. With the Phase-4A
    //    boot-order fix (await autoInitDB BEFORE listen) + idempotent, race-tolerant
    //    DDL, both must come up with a complete schema and no duplicate index. This
    //    is the proof the migration-race GOTCHA is gone (no manual CREATE/ALTER).
    await admin.query('DROP DATABASE IF EXISTS ' + TEST_DB);
    await admin.query('CREATE DATABASE ' + TEST_DB + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    const cP = PORT2 + 2, cQ = PORT2 + 3;
    servers.push(bootServer(cP, null));
    servers.push(bootServer(cQ, null)); // both start NOW — racing the first run
    const cA = await waitUp(cP, 90);
    const cB = await waitUp(cQ, 90);
    check('two concurrent servers on a FRESH empty DB both start (race first-run migrations)', cA && cB, { cA, cB });
    const conn2 = await mysql.createConnection(Object.assign({}, ADMIN, { database: TEST_DB }));
    let have3 = new Set();
    for (let i = 0; i < 120; i++) { const [t] = await conn2.query('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?', [TEST_DB]); have3 = new Set(t.map((r) => r.TABLE_NAME || r.table_name)); if (REQUIRED_TABLES.every((x) => have3.has(x))) break; await new Promise((z) => setTimeout(z, 1000)); }
    check('schema complete after a CONCURRENT first-run (GOTCHA gone — zero manual ALTER)', REQUIRED_TABLES.every((t) => have3.has(t)), { missing: REQUIRED_TABLES.filter((t) => !have3.has(t)) });
    const [[seqU]] = await conn2.query("SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='inventory_movements' AND COLUMN_NAME='seq' AND NON_UNIQUE=0", [TEST_DB]);
    check('inventory_movements.seq single unique index after concurrent first-run', Number(seqU.n) === 1, seqU);
    await conn2.end();

    console.log('\n  ── boot log (excerpt) ──');
    const joined = log.join('');
    joined.split('\n').filter((l) => /First run|creating|Database ready|migration|ready|Migration: creating table (gl_journal_seq|stock_issue_events)/i.test(l)).slice(0, 8).forEach((l) => console.log('    ' + l.trim()));

    console.log('\n═══════════════════════════════════════════');
    console.log('Total: ' + (_p + _f) + ' | Passed: ' + _p + ' | Failed: ' + _f);
    console.log('═══════════════════════════════════════════');
    exitCode = _f > 0 ? 1 : 0;
  } catch (e) { console.error('FATAL', e); exitCode = 2; }
  finally {
    for (const s of servers) { try { s.kill(); } catch (_) {} }
    await new Promise((z) => setTimeout(z, 800));
    try { await admin.query('DROP DATABASE IF EXISTS ' + TEST_DB); } catch (_) {}
    try { await admin.end(); } catch (_) {}
  }
  process.exit(exitCode);
})();
