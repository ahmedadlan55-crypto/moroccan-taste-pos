/**
 * close2/sales-security — integration test (REAL server, REAL MySQL).
 *
 * Proves the three gaps closed in routes/sales.js are enforced at the HTTP
 * surface itself, INDEPENDENT of ORDER_TO_CASH_ENABLE (the server is booted with
 * the flag OFF — the exact window in which middleware/o2cLegacyGate.creditSaleGate
 * does NOT run, so this route's own guard is the only thing standing between a
 * plain cashier and an un-approved credit sale):
 *
 *   Task 1 — credit-sale supervisor gate on POST /api/sales
 *     (1) cashier, single method 'credit'              → 403 PERMISSION_DENIED, NO row
 *     (2) cashier, splitDetails {kita, cash} object    → 403, NO row
 *     (2b) cashier, splitDetails [{method,amount}] array (pos-v2 legacyPayload shape) → 403, NO row
 *     (2c) cashier, structured payments [{method:'credit'}] array → 403, NO row
 *     (3) MANAGER, single method 'credit'              → 200 success, row EXISTS (gate not over-broad)
 *
 *   Task 2 — invoice ownership on GET /api/sales/invoice/:orderId
 *     (4) cashier B fetches cashier A's invoice        → 403 PERMISSION_DENIED
 *     (5) cashier A fetches their OWN invoice          → 200 full detail
 *     (6) MANAGER fetches cashier A's invoice          → 200 (elevated role passes)
 *
 *   Task 3 — server-side scoping on GET /api/sales
 *     (7) cashier A calls ?username=<manager>          → param IGNORED, only A's own rows
 *     (8) ?shiftId=X returns only that shift's rows    → two shifts stay disjoint
 *
 * Every fixture id is ITEST- prefixed; cleanup runs before the run AND in finally.
 * Run: node tests/integration/salesSecurity.api.test.js   (shared MySQL @ :3306)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.SALES_SEC_TEST_PORT || 3993);
const BASE = { host: '127.0.0.1', port: PORT };

const U_A   = 'ITEST-sec-cashA';  // cashier — owns the baseline cash sale
const U_B   = 'ITEST-sec-cashB';  // cashier — the "other" cashier (no access to A)
const U_MGR = 'ITEST-sec-mgr';    // manager — supervisor / view-all
const SH_A   = 'ITEST-sec-SHA';   // open shift owned by cashier A
const SH_MGR = 'ITEST-sec-SHMGR'; // open shift owned by the manager
const MENU   = 'ITEST-sec-MENU';  // a standard-rated menu item, no recipe

const P = (s) => `ITEST-sec-${s}`;
const ITEM = { id: MENU, name: 'ITEST sec item', qty: 1, price: 23.0 };

let _p = 0, _f = 0; const _fails = [];
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; _fails.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, text: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(20000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    const r = await req('GET', '/api/version');
    if (r.status) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}
function tok(id, username, role) {
  return jwt.sign({ id, username, role, isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function countByCO(clientOrderId) {
  const [r] = await db.query('SELECT COUNT(*) AS n FROM sales WHERE client_order_id = ?', [clientOrderId]);
  return Number(r[0].n);
}
function sale(overrides) {
  return Object.assign({
    items: [ITEM], total: 23, totalFinal: 23, shiftId: SH_A, clientOrderId: P('CO-' + Math.random().toString(36).slice(2, 8)),
  }, overrides);
}

async function cleanup() {
  const del = async (sql, p) => { try { await db.query(sql, p); } catch (_) { /* table variants — best effort */ } };
  // Resolve any sale ids our fixture users produced, then clear their children so
  // no gl/inventory/sales_items residue survives. sales.id is server-generated,
  // so we match on username, not a prefix.
  let ids = [];
  try {
    const [rows] = await db.query('SELECT id FROM sales WHERE username IN (?,?,?)', [U_A, U_B, U_MGR]);
    ids = rows.map((r) => r.id);
  } catch (_) {}
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    await del(`DELETE e FROM gl_entries e JOIN gl_journals jr ON jr.id = e.journal_id WHERE jr.reference_type IN ('Sale','ChannelCommission') AND jr.reference_id IN (${ph})`, ids);
    await del(`DELETE FROM gl_journals WHERE reference_type IN ('Sale','ChannelCommission') AND reference_id IN (${ph})`, ids);
    await del(`DELETE c FROM ar_document_line_components c JOIN ar_documents d ON d.id = c.document_id WHERE d.source_type='pos' AND d.source_id IN (${ph})`, ids);
    await del(`DELETE l FROM ar_document_lines l JOIN ar_documents d ON d.id = l.document_id WHERE d.source_type='pos' AND d.source_id IN (${ph})`, ids);
    await del(`DELETE FROM ar_documents WHERE source_type='pos' AND source_id IN (${ph})`, ids);
    await del(`DELETE FROM inventory_movements WHERE reference_id IN (${ph})`, ids);
    await del(`DELETE FROM sales_items WHERE order_id IN (${ph})`, ids);
    await del(`DELETE FROM sales WHERE id IN (${ph})`, ids);
  }
  await del('DELETE FROM sales WHERE username IN (?,?,?)', [U_A, U_B, U_MGR]);
  await del('DELETE FROM shifts WHERE id IN (?,?)', [SH_A, SH_MGR]);
  await del('DELETE FROM shifts WHERE username IN (?,?,?)', [U_A, U_B, U_MGR]);
  await del('DELETE FROM menu WHERE id = ?', [MENU]);
  await del('DELETE FROM users WHERE username IN (?,?,?)', [U_A, U_B, U_MGR]);
}

async function seed() {
  await cleanup();
  const ids = {};
  for (const [u, role] of [[U_A, 'cashier'], [U_B, 'cashier'], [U_MGR, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  // Every sale must FK a REAL OPEN shift owned by the acting user (routes/sales.js).
  await db.query("INSERT INTO shifts (id, username, status, start_time) VALUES (?,?,'OPEN',NOW())", [SH_A, U_A]);
  await db.query("INSERT INTO shifts (id, username, status, start_time) VALUES (?,?,'OPEN',NOW())", [SH_MGR, U_MGR]);
  // Standard-rated, tax-inclusive, no recipe → cost 0, posts a clean journal.
  await db.query(
    'INSERT INTO menu (id, name, price, category, cost, stock, active, tax_category, is_tax_inclusive, production_method) VALUES (?,?,?,?,?,?,1,?,1,?)',
    [MENU, 'ITEST sec item', 23.0, 'ITEST', 0, 0, 'S', 'made_at_branch']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ close2/sales-security — credit gate / invoice ownership / server-side scoping ═══\n');
  const ids = await seed();
  const cashA = tok(ids[U_A], U_A, 'cashier');
  const cashB = tok(ids[U_B], U_B, 'cashier');
  const mgr   = tok(ids[U_MGR], U_MGR, 'manager');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    // Flag OFF on purpose: proves the guard is independent of the O2C gate.
    env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── Task 1 — credit-sale supervisor gate ──────────────────────────────────
    console.log('▸ Task 1 — credit-sale supervisor gate (POST /api/sales)');
    // (1) single method 'credit' by a cashier
    let co = P('CO-CREDIT1');
    let r = await req('POST', '/api/sales', cashA, sale({ paymentMethod: 'credit', clientOrderId: co }));
    check('(1) cashier credit sale → 403 PERMISSION_DENIED', r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED', { status: r.status, body: r.body });
    check('(1) NO sales row was inserted for the rejected credit sale', (await countByCO(co)) === 0);

    // (2) splitDetails OBJECT {label:amount} with a kita leg
    co = P('CO-CREDIT2');
    r = await req('POST', '/api/sales', cashA, sale({ paymentMethod: 'Split', splitDetails: { kita: 13, cash: 10 }, clientOrderId: co }));
    check('(2) cashier split OBJECT with kita leg → 403 PERMISSION_DENIED', r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED', { status: r.status, body: r.body });
    check('(2) NO sales row inserted', (await countByCO(co)) === 0);

    // (2b) splitDetails ARRAY [{method,amount}] — the pos-v2 legacyPayload shape
    co = P('CO-CREDIT2B');
    r = await req('POST', '/api/sales', cashA, sale({ paymentMethod: 'split', splitDetails: [{ method: 'كيتا', amount: 13 }, { method: 'كاش', amount: 10 }], clientOrderId: co }));
    check('(2b) cashier split ARRAY with كيتا leg → 403 PERMISSION_DENIED', r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED', { status: r.status, body: r.body });
    check('(2b) NO sales row inserted', (await countByCO(co)) === 0);

    // (2c) structured payments [{method:'credit'}] — the O2C contract shape
    co = P('CO-CREDIT2C');
    r = await req('POST', '/api/sales', cashA, sale({ paymentMethod: 'كيتا', payments: [{ method: 'credit', amount: 23 }], clientOrderId: co }));
    check('(2c) cashier structured payments credit leg → 403 PERMISSION_DENIED', r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED', { status: r.status, body: r.body });
    check('(2c) NO sales row inserted', (await countByCO(co)) === 0);

    // (3) MANAGER runs the SAME credit payload → succeeds (gate isn't over-broad)
    co = P('CO-MGR');
    r = await req('POST', '/api/sales', mgr, sale({ paymentMethod: 'credit', shiftId: SH_MGR, clientOrderId: co }));
    check('(3) manager credit sale → 200 success', r.status === 200 && r.body && r.body.success === true, { status: r.status, body: r.body });
    check('(3) sale row EXISTS for the manager credit sale', (await countByCO(co)) === 1);

    // ── baseline: cashier A creates a plain CASH sale (not gated) ──────────────
    const coA = P('CO-CASHA');
    r = await req('POST', '/api/sales', cashA, sale({ paymentMethod: 'Cash', clientOrderId: coA }));
    check('baseline: cashier A cash sale → 200 success', r.status === 200 && r.body && r.body.success === true, { status: r.status, body: r.body });
    const orderA = r.body && r.body.orderId;

    // ── Task 2 — invoice ownership (GET /api/sales/invoice/:orderId) ───────────
    console.log('▸ Task 2 — invoice ownership');
    r = await req('GET', `/api/sales/invoice/${encodeURIComponent(orderA)}`, cashB);
    check('(4) cashier B views cashier A invoice → 403 PERMISSION_DENIED', r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED', { status: r.status, body: r.body });
    r = await req('GET', `/api/sales/invoice/${encodeURIComponent(orderA)}`, cashA);
    check('(5) cashier A views OWN invoice → 200 with detail', r.status === 200 && r.body && r.body.orderId === orderA && r.body.username === U_A, { status: r.status, body: r.body && { orderId: r.body.orderId, username: r.body.username } });
    r = await req('GET', `/api/sales/invoice/${encodeURIComponent(orderA)}`, mgr);
    check('(6) manager views cashier A invoice → 200 (elevated role passes)', r.status === 200 && r.body && r.body.orderId === orderA, { status: r.status });

    // ── Task 3 — server-side scoping on GET /api/sales ─────────────────────────
    console.log('▸ Task 3 — server-side scoping (GET /api/sales)');
    r = await req('GET', `/api/sales?username=${encodeURIComponent(U_MGR)}`, cashA);
    let rows = Array.isArray(r.body) ? r.body : [];
    check('(7) cashier A ?username=<manager> → 200', r.status === 200 && Array.isArray(r.body), { status: r.status, body: r.body });
    check('(7) query param IGNORED — only cashier A’s own rows returned', rows.length > 0 && rows.every((x) => x.username === U_A) && !rows.some((x) => x.username === U_MGR), rows.map((x) => x.username));

    r = await req('GET', `/api/sales?shiftId=${encodeURIComponent(SH_A)}`, mgr);
    const rowsA = Array.isArray(r.body) ? r.body : [];
    check('(8) ?shiftId=SH_A returns only SH_A rows', rowsA.length > 0 && rowsA.every((x) => x.shiftId === SH_A), rowsA.map((x) => x.shiftId));
    r = await req('GET', `/api/sales?shiftId=${encodeURIComponent(SH_MGR)}`, mgr);
    const rowsM = Array.isArray(r.body) ? r.body : [];
    check('(8) ?shiftId=SH_MGR returns only SH_MGR rows', rowsM.length > 0 && rowsM.every((x) => x.shiftId === SH_MGR), rowsM.map((x) => x.shiftId));
    check('(8) the two shift filters return DISJOINT sales', !rowsA.some((a) => rowsM.find((m) => m.orderId === a.orderId)), { a: rowsA.map((x) => x.orderId), m: rowsM.map((x) => x.orderId) });
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${_f === 0 ? '✅' : '❌'} salesSecurity.api: ${_p} passed, ${_f} failed`);
  if (_f) console.log('FAILED:', _fails.join(' | '));
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exit(2); });
