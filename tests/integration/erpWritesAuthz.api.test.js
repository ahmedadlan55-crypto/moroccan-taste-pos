'use strict';
/* Integration — ERP write authorization (real server + DB, synthesized fixtures).
 *
 * Locks in the close/g-erp hardening: the bare writes across routes/erp.js,
 * routes/erp-core.js, routes/warehouse-ops.js and routes/payments.js now carry
 * requireCapability / MGR / BACKOFFICE guards, and routes/erp/customers.js
 * moved from coarse requireRole to the customers.* capability model.
 *
 * The contract proven here:
 *   (a) a CASHIER is 403'd on GL-adjacent writes (accounting periods, GL seed,
 *       treasury payment request, stock-issue draft, price-list create) — and
 *       each denial provably left NO row behind (state-unchanged proof).
 *   (b) the till KEEPS WORKING: the cashier can create a customer and read its
 *       /summary — the exact pair the POS customer panel calls. A guard that
 *       stops the till is a worse bug than the hole it closes.
 *   (c) a CUSTODY token cannot soft-delete a customer (customers.deactivate is
 *       admin/manager) — and the row survives, still active.
 *   (d) a MANAGER still succeeds on a representative guarded write
 *       (finance.periods.manage → POST /accounting-periods) — the guard
 *       hardens the endpoint without taking the function from its users.
 *
 * Fixtures are ITEST- prefixed, cleaned up before AND in finally.
 *
 * Run: npm run test:erp-writes-authz   (MySQL on 127.0.0.1:3306)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3993;
const CASHIER = 'itest_gerp_cashier';
const CUSTODY = 'itest_gerp_custody';
const MANAGER = 'itest_gerp_manager';
const PW = 'GErp#Test!2026';
const CUST_KEEP = 'ITEST-GERP-CUST-KEEP';   // custody tries to delete this — it must survive
const CUST_NAME = 'ITEST GERP عميل الكاشير'; // cashier creates this via the API
const PERIOD_CASHIER = 'ITEST-GERP-DNY'; // ≤20 chars — period_name is varchar(20); cashier attempt, must never exist
const PERIOD_MANAGER = 'ITEST-GERP-ALW'; // ≤20 chars — manager attempt, must exist then cleaned
const PL_NAME = 'ITEST-GERP-PRICELIST-DENIED';
const PAY_NOTE = 'ITEST-GERP-PAYMENT-DENIED';

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

const count = async (sql, params) => { const [r] = await db.query(sql, params); return Number(r[0].c); };
const customerActive = async (id) => {
  const [r] = await db.query('SELECT is_active FROM customers WHERE id = ?', [id]);
  return r.length ? Number(r[0].is_active) : null;
};

let createdCustomerId = null; // the customer the cashier creates via the API

async function cleanup() {
  for (const u of [CASHIER, CUSTODY, MANAGER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try { await db.query('DELETE FROM customers WHERE id = ?', [CUST_KEEP]); } catch (_) {}
  try { await db.query('DELETE FROM customers WHERE name = ?', [CUST_NAME]); } catch (_) {}
  if (createdCustomerId) { try { await db.query('DELETE FROM customers WHERE id = ?', [createdCustomerId]); } catch (_) {} }
  try { await db.query('DELETE FROM accounting_periods WHERE period_name IN (?, ?)', [PERIOD_CASHIER, PERIOD_MANAGER]); } catch (_) {}
  try { await db.query('DELETE FROM price_lists WHERE name = ?', [PL_NAME]); } catch (_) {}
  try { await db.query('DELETE FROM payment_records WHERE notes = ?', [PAY_NOTE]); } catch (_) {}
  try { await db.query('DELETE FROM stock_issues WHERE created_by = ?', [CASHIER]); } catch (_) {}
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CUSTODY, hash, 'custody']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query('INSERT INTO customers (id, name, is_active) VALUES (?,?,1)', [CUST_KEEP, 'ITEST GERP عميل محمي']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ ERP write authorization (close/g-erp) ═══');

    const cashier = await login(CASHIER);
    const custody = await login(CUSTODY);
    const manager = await login(MANAGER);
    check('users authenticate', !!cashier && !!custody && !!manager);

    // ── (a) cashier is DENIED the GL-adjacent writes — with state proof ──
    const glAccountsBefore = await count('SELECT COUNT(*) c FROM gl_accounts');

    const pDeny = await call('POST', '/api/erp/accounting-periods', cashier,
      { periodName: PERIOD_CASHIER, startDate: '2031-01-01', endDate: '2031-01-31' });
    check('cashier POST /accounting-periods → 403 (finance.periods.manage)', pDeny.status === 403, { status: pDeny.status, body: pDeny.body });
    check('…and NO period row was written', (await count('SELECT COUNT(*) c FROM accounting_periods WHERE period_name = ?', [PERIOD_CASHIER])) === 0);

    const seedDeny = await call('POST', '/api/erp/gl/seed', cashier, {});
    check('cashier POST /gl/seed → 403 (finance.accounts.manage)', seedDeny.status === 403, { status: seedDeny.status });
    check('…and the chart of accounts is EXACTLY as it was', (await count('SELECT COUNT(*) c FROM gl_accounts')) === glAccountsBefore);

    const payDeny = await call('POST', '/api/erp/payments', cashier,
      { amount: 100, direction: 'out', paymentMethod: 'cash', notes: PAY_NOTE });
    check('cashier POST /payments → 403 (payments.request)', payDeny.status === 403, { status: payDeny.status, body: payDeny.body });
    check('…and NO payment record was written', (await count('SELECT COUNT(*) c FROM payment_records WHERE notes = ?', [PAY_NOTE])) === 0);

    const plDeny = await call('POST', '/api/erp/price-lists', cashier, { name: PL_NAME });
    check('cashier POST /price-lists → 403 (channels.manage)', plDeny.status === 403, { status: plDeny.status });
    check('…and NO price list was written', (await count('SELECT COUNT(*) c FROM price_lists WHERE name = ?', [PL_NAME])) === 0);

    const siDeny = await call('POST', '/api/erp/stock-issues', cashier,
      { fromWarehouseId: 'ITEST-NOPE-A', toWarehouseId: 'ITEST-NOPE-B', items: [{ itemId: 'ITEST-NOPE', qtyRequested: 1 }] });
    check('cashier POST /stock-issues → 403 (BACKOFFICE excludes the till)', siDeny.status === 403, { status: siDeny.status });
    check('…and NO stock-issue draft was written', (await count('SELECT COUNT(*) c FROM stock_issues WHERE created_by = ?', [CASHIER])) === 0);

    // ── (b) the till KEEPS WORKING: create a customer + read its summary ──
    const create = await call('POST', '/api/erp/customers', cashier,
      { name: CUST_NAME, phone: '0591234567', gender: 'male' });
    check('cashier CAN create a customer (customers.create — POS checkout parity)',
      create.status === 200 && create.body && create.body.success === true && !!create.body.id, { status: create.status, body: create.body });
    createdCustomerId = (create.body && create.body.id) || null;

    if (createdCustomerId) {
      check('…the row REALLY exists and is active', (await customerActive(createdCustomerId)) === 1);
      const summary = await call('GET', '/api/erp/customers/' + encodeURIComponent(createdCustomerId) + '/summary', cashier);
      check('cashier CAN read /customers/:id/summary (customers.view — POS history panel)',
        summary.status === 200 && summary.body && summary.body.success === true &&
        summary.body.customer && summary.body.customer.id === createdCustomerId,
        { status: summary.status, body: summary.body && summary.body.error });
      check('…summary carries the KPI block (a real read, not a stub)',
        summary.status === 200 && summary.body && summary.body.kpi && typeof summary.body.kpi.orderCount === 'number',
        summary.body && summary.body.kpi);
    } else {
      check('summary read (skipped — create failed)', false);
    }

    // ── (c) custody cannot delete a customer — and the row survives ──
    const delDeny = await call('DELETE', '/api/erp/customers/' + CUST_KEEP, custody);
    check('custody DELETE /customers/:id → 403 (customers.deactivate is admin/manager)',
      delDeny.status === 403, { status: delDeny.status, body: delDeny.body });
    check('…and the customer is STILL active (no side effect)', (await customerActive(CUST_KEEP)) === 1);
    const custodyList = await call('GET', '/api/erp/customers', custody);
    check('custody cannot even LIST customers (holds no customers.view)', custodyList.status === 403, { status: custodyList.status });

    // ── (d) manager still succeeds on a representative guarded write ──
    const pAllow = await call('POST', '/api/erp/accounting-periods', manager,
      { periodName: PERIOD_MANAGER, startDate: '2031-02-01', endDate: '2031-02-28' });
    check('manager POST /accounting-periods → success (finance.periods.manage held)',
      pAllow.status === 200 && pAllow.body && pAllow.body.success === true, { status: pAllow.status, body: pAllow.body });
    check('…and the period row REALLY exists', (await count('SELECT COUNT(*) c FROM accounting_periods WHERE period_name = ?', [PERIOD_MANAGER])) === 1);

    console.log(`\n${fail === 0 ? '✅' : '❌'} erpWritesAuthz: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
