/**
 * tests/o2cLegacyGate.integration.test.js — boots the REAL server with
 * ORDER_TO_CASH_ENABLE=1 and proves the single-writer AR contract over HTTP:
 *   • the O2C module is reachable + RBAC-gated (admin 200, employee 403, no-token 401)
 *   • every legacy duplicate-AR mutation is blocked (409) while reads pass
 *   • the credit-sale gate rejects a credit sale without a customer (422)
 *   • a POS cash sale + non-customer treasury are NOT gated
 *   • ar_documents / customer_payments / gl_entries row counts don't change under
 *     the gated mutation attempts (zero dual-write)
 *
 * Run: node tests/o2cLegacyGate.integration.test.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const db = require('../db/connection');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const PORT = 3014;
const BASE = `http://127.0.0.1:${PORT}`;
let _p = 0, _f = 0;
function ok(c, m) { if (c) { _p++; console.log('  ✅', m); } else { _f++; console.log('  ❌', m); } }

function env() {
  const e = {};
  for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) e[m[1]] = m[2];
  }
  return e;
}

// [method, path, body, expectedStatus]
const GATED = [
  ['POST', '/api/ar-invoices', {}, 409],
  ['PUT', '/api/ar-invoices/X-none', {}, 409],
  ['DELETE', '/api/ar-invoices/X-none', null, 409],
  ['POST', '/api/cash/receipts', { source_type: 'customer', amount: 10 }, 409],
  ['POST', '/api/sales/X-none/void', {}, 409],
  ['POST', '/api/sales/X-none/return', {}, 409],
  ['DELETE', '/api/sales/X-none', null, 409],
  ['POST', '/api/sales', { payment_method: 'credit', total_final: 100 }, 422], // credit gate: no customer
];
const COUNT_TABLES = ['ar_documents', 'customer_payments', 'ar_payment_allocations', 'gl_entries'];

async function counts() {
  const out = {};
  for (const t of COUNT_TABLES) { const [[r]] = await db.query(`SELECT COUNT(*) c FROM \`${t}\``); out[t] = Number(r.c); }
  return out;
}

async function main() {
  const e = env();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, e, { ORDER_TO_CASH_ENABLE: '1', PORT: String(PORT), NODE_ENV: 'development' }),
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`${BASE}/api/version`); if (r.ok) { up = true; break; } } catch (_) {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    ok(up, 'server booted with ORDER_TO_CASH_ENABLE=1');
    if (!up) throw new Error('server did not boot');

    const v = await (await fetch(`${BASE}/api/version`)).json();
    ok(v.orderToCash === true, '/api/version orderToCash:true');
    ok(v.procurementP2P === false, 'procurementP2P flag untouched (false)');

    const admin = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, e.JWT_SECRET, { expiresIn: '1h' });
    const employee = jwt.sign({ id: 999, username: 'o2c_noperm', role: 'employee' }, e.JWT_SECRET, { expiresIn: '1h' });
    const AH = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const EH = { Authorization: `Bearer ${employee}`, 'content-type': 'application/json' };

    console.log('\n── RBAC on the new module ──');
    ok((await fetch(`${BASE}/api/order-to-cash/dashboard`)).status === 401, 'no token → 401');
    ok((await fetch(`${BASE}/api/order-to-cash/dashboard`, { headers: AH })).status === 200, 'admin → 200');
    ok((await fetch(`${BASE}/api/order-to-cash/dashboard`, { headers: EH })).status === 403, 'employee without o2c caps → 403');
    ok((await fetch(`${BASE}/api/order-to-cash/reconcile`, { headers: AH })).status === 200, 'admin reconcile → 200');

    const before = await counts();

    console.log('\n── legacy duplicate-AR mutations gated ──');
    for (const [method, p, body, exp] of GATED) {
      const r = await fetch(BASE + p, { method, headers: AH, body: body ? JSON.stringify(body) : undefined });
      ok(r.status === exp, `${method} ${p} → ${r.status} (expect ${exp})`);
    }

    console.log('\n── reads + POS create + non-customer treasury NOT gated ──');
    ok((await fetch(`${BASE}/api/ar-invoices`, { headers: AH })).status !== 409, 'GET /api/ar-invoices not 409');
    {
      const r = await fetch(`${BASE}/api/sales`, { method: 'POST', headers: AH, body: JSON.stringify({ payment_method: 'cash', total_final: 100 }) });
      ok(r.status !== 409 && r.status !== 422, `POS cash sale → ${r.status} (passes credit+reverse gates)`);
    }
    {
      const r = await fetch(`${BASE}/api/cash/receipts`, { method: 'POST', headers: AH, body: JSON.stringify({ source_type: 'income', amount: 5 }) });
      ok(r.status !== 409, `non-customer cash receipt → ${r.status} (not gated)`);
    }

    const after = await counts();
    console.log('\n── AR row counts unchanged under gated attempts (zero dual-write) ──');
    let unchanged = true;
    for (const t of COUNT_TABLES) { if (before[t] !== after[t]) { unchanged = false; console.log(`     ${t}: ${before[t]} → ${after[t]}`); } }
    ok(unchanged, 'no ar_documents/customer_payments/gl_entries row changed under gated mutation attempts');
  } finally {
    child.kill();
    await db.end();
  }
  console.log(`\no2cLegacyGate: ${_p} passed, ${_f} failed`);
  process.exit(_f ? 1 : 0);
}

main().catch((e) => { console.error('O2C GATE TEST ERROR:', e.stack || e.message); process.exit(1); });
