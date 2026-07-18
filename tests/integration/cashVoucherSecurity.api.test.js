/**
 * cashVoucherSecurity.api.test.js — FC-P1b cash-voucher approval contract.
 *
 * The receipt/payment approve routes previously read status='draft' then posted
 * the journal + moved the cashbox balance OUTSIDE any transaction/lock, so two
 * concurrent approves double-posted. FC-P1b wraps approval in withTransaction +
 * SELECT … FOR UPDATE on the voucher row.
 *
 * Proves:
 *   1. approval is protected (a cashier — outside the admin/manager mount — is
 *      refused).
 *   2. N concurrent approves of ONE draft receipt → exactly one succeeds and the
 *      cashbox balance moves by EXACTLY one voucher amount.
 *
 * Spawns its own server (PORT 3243) against the .env DB.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const db = require(path.join(ROOT, 'db', 'connection'));

const ENV = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2];
}
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const PORT = 3243;
const BASE = `http://127.0.0.1:${PORT}`;
const T = {
  admin:   jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
  manager: jwt.sign({ id: 900301, username: 'cashsec_mgr', role: 'manager', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
  cashier: jwt.sign({ id: 900302, username: 'cashsec_cash', role: 'cashier', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
};

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}
async function waitUp(secs) {
  for (let i = 0; i < secs; i++) {
    try { const r = await fetch(BASE + '/api/version'); if (r.ok) return true; } catch (_) {}
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}
function api(method, pathname, tok, body) {
  return fetch(BASE + '/api' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
async function j(method, pathname, tok, body) {
  const r = await api(method, pathname, tok, body);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

async function main() {
  console.log('\n═══ Cash voucher approval contract (protected · double-approve safe) ═══\n');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = ''; child.stdout.on('data', d => childLog += d); child.stderr.on('data', d => childLog += d);

  try {
    check('server up', await waitUp(240));

    // Fixtures (admin): two leaf accounts + a cashbox + a draft receipt.
    const sfx = String(Date.now()).slice(-5);
    const A = 'CVS-A-' + sfx, cA = '8A' + sfx;
    const B = 'CVS-B-' + sfx, cB = '8B' + sfx;
    await j('POST', '/erp/gl/accounts', T.admin, { id: A, code: cA, nameAr: A, type: 'asset', parentId: null, level: 1 });
    await j('POST', '/erp/gl/accounts', T.admin, { id: B, code: cB, nameAr: B, type: 'revenue', parentId: null, level: 1 });
    const box = await j('POST', '/cash/cash-boxes', T.admin, { name: 'CVS Box ' + sfx });
    const boxId = box.data && box.data.id;
    check('cashbox created', !!boxId, box.data);

    const receipt = await j('POST', '/cash/receipts', T.manager, {
      receiptDate: '2026-01-08', amount: 100, destinationType: 'cash', destinationId: boxId,
      sourceType: 'other', sourceName: 'probe', description: 'double-approve probe', username: 'HACKER',
      manualGlLines: [
        { accountId: A, accountCode: cA, debit: 100, credit: 0 },
        { accountId: B, accountCode: cB, debit: 0, credit: 100 },
      ],
    });
    const recId = receipt.data && receipt.data.id;
    check('receipt draft created', !!recId, receipt.data);

    // 1. cashier is refused (route is admin/manager only)
    const cashApprove = await j('POST', `/cash/receipts/${recId}/approve`, T.cashier, {});
    check('cashier approve → 403', cashApprove.status === 403, { status: cashApprove.status });

    // 2. N concurrent approves → exactly one succeeds
    const N = 15;
    const results = await Promise.all(Array.from({ length: N }, () => j('POST', `/cash/receipts/${recId}/approve`, T.manager, {})));
    const successes = results.filter(r => r.data && r.data.success === true).length;
    check('exactly one approve succeeded', successes === 1, { successes, of: N });

    // cashbox balance moved by EXACTLY one voucher (100)
    const boxes = await j('GET', '/cash/cash-boxes', T.admin);
    const cb = Array.isArray(boxes.data) ? boxes.data.find(b => b.id === boxId) : null;
    check('cashbox balance = exactly one voucher (100)', !!cb && Number(cb.balance) === 100, cb && { balance: cb.balance });

    // cleanup — the winning approve posted a real GL journal; leaving it (or
    // the accounts/receipt/box) behind pollutes the ledger for every test
    // that runs after this one on the same day (this is exactly what caused
    // the numbering bug this file exists to guard against to keep colliding
    // on reruns).
    try {
      const [recRow] = await db.query('SELECT journal_id FROM cash_receipts WHERE id=?', [recId]);
      const journalId = recRow.length ? recRow[0].journal_id : null;
      if (journalId) {
        await db.query('DELETE FROM gl_entries WHERE journal_id=?', [journalId]);
        await db.query('DELETE FROM gl_journals WHERE id=?', [journalId]);
      }
      await db.query('DELETE FROM cash_receipts WHERE id=?', [recId]);
      // /cash/cash-boxes/:id only soft-deletes (is_active=0) — correct for a
      // real admin action on a box with history, but it would leave this
      // run's disposable fixture box in the table forever. Hard-delete it
      // directly; its own GL cash-account row too (created by
      // ensureCashAccount the first time this box was credited).
      const [boxRow] = await db.query('SELECT gl_account_id FROM cash_boxes WHERE id=?', [boxId]);
      await db.query('DELETE FROM cash_boxes WHERE id=?', [boxId]);
      if (boxRow.length && boxRow[0].gl_account_id) await db.query('DELETE FROM gl_accounts WHERE id=?', [boxRow[0].gl_account_id]);
      await db.query('DELETE FROM gl_accounts WHERE id IN (?, ?)', [A, B]);
    } catch (_) {}
  } catch (e) {
    check('no exception', false, e && e.message);
    console.log(childLog.slice(-2000));
  } finally {
    child.kill('SIGKILL');
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n─── ${_p} passed, ${_f} failed ───\n`);
  process.exit(_f ? 1 : 0);
}
main();
