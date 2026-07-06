/**
 * Dual-write elimination proof — boots the REAL server with PROCUREMENT_P2P_ENABLE=1
 * and asserts that EVERY legacy stock/AP mutation endpoint is blocked (409) while
 * reads still pass, and that no stock/AP table row count changes.
 *
 * Run: node tests/procurementLegacyGate.integration.test.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const db = require('../db/connection');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const PORT = 3013;
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

const MUTATIONS = [
  ['POST', '/api/purchases', {}],
  ['POST', '/api/purchases/receive/X-none', {}],
  ['POST', '/api/purchases/receive/X-none/revert', {}],
  ['DELETE', '/api/purchases/X-none', null],
  ['POST', '/api/purchases/orders', {}],
  ['PUT', '/api/purchases/orders/X-none', {}],
  ['POST', '/api/purchases/orders/X-none/approve', {}],
  ['POST', '/api/purchases/orders/X-none/revert', {}],
  ['DELETE', '/api/purchases/orders/X-none', null],
  ['POST', '/api/ap-invoices', {}],
  ['PUT', '/api/ap-invoices/X-none', {}],
  ['POST', '/api/ap-invoices/X-none/lines', {}],
  ['DELETE', '/api/ap-invoices/lines/X-none', null],
  ['POST', '/api/ap-invoices/X-none/approve', {}],
  ['POST', '/api/ap-invoices/X-none/cancel', {}],
  ['POST', '/api/ap-invoices/X-none/pay', { amount: 1 }],
  ['POST', '/api/erp/payments', { referenceType: 'SupplierPayment', direction: 'out', amount: 1 }],
];
const COUNT_TABLES = ['warehouse_stock', 'purchase_lots', 'inventory_movements', 'supplier_invoices', 'payment_records', 'gl_entries', 'purchases', 'purchase_orders'];

async function counts() {
  const out = {};
  for (const t of COUNT_TABLES) { const [[r]] = await db.query(`SELECT COUNT(*) c FROM \`${t}\``); out[t] = Number(r.c); }
  return out;
}

async function main() {
  const e = env();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, e, { PROCUREMENT_P2P_ENABLE: '1', PORT: String(PORT), NODE_ENV: 'development' }),
    stdio: 'ignore',
  });
  try {
    // wait for listen
    let up = false;
    for (let i = 0; i < 45; i++) {
      try { const r = await fetch(`${BASE}/api/version`); if (r.ok) { up = true; break; } } catch (_) {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    ok(up, 'server booted with PROCUREMENT_P2P_ENABLE=1');
    if (!up) throw new Error('server did not boot');

    const tok = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, e.JWT_SECRET, { expiresIn: '1h' });
    const H = { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' };

    const before = await counts();

    console.log('\n── every legacy stock/AP mutation returns 409 ──');
    for (const [method, p, body] of MUTATIONS) {
      const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
      ok(r.status === 409, `${method} ${p} → ${r.status} (expect 409)`);
    }

    console.log('\n── reads still pass (not gated) ──');
    for (const p of ['/api/purchases', '/api/purchases/orders', '/api/ap-invoices']) {
      const r = await fetch(BASE + p, { headers: H });
      ok(r.status !== 409, `GET ${p} → ${r.status} (not 409)`);
    }

    console.log('\n── non-supplier treasury payment is NOT gated (selective) ──');
    {
      // an expense-directed payment with a deliberately empty body: the gate must
      // let it through (→ handled/rejected by the real handler, NOT a 409 gate).
      const r = await fetch(BASE + '/api/erp/payments', { method: 'POST', headers: H, body: JSON.stringify({ referenceType: 'Expense', direction: 'out' }) });
      ok(r.status !== 409, `POST /api/erp/payments (Expense) → ${r.status} (gate passed, not 409)`);
    }

    const after = await counts();
    console.log('\n── stock/AP row counts unchanged (zero dual-write) ──');
    let unchanged = true;
    for (const t of COUNT_TABLES) { if (before[t] !== after[t]) { unchanged = false; console.log(`     ${t}: ${before[t]} → ${after[t]}`); } }
    ok(unchanged, 'no stock/AP table row count changed under legacy mutation attempts');
  } finally {
    child.kill();
    await db.end();
  }
  console.log(`\nLegacy dual-write gate: ${_p} passed, ${_f} failed`);
  process.exit(_f ? 1 : 0);
}

main().catch((e) => { console.error('GATE TEST ERROR:', e.stack || e.message); process.exit(1); });
