/**
 * bankRecon.api.test.js — FC-P3 bank reconciliation + cash-drawer closing.
 *
 * Greenfield backend (routes/bank-reconciliation.js). Drives the full flow
 * against a spawned server + the .env DB:
 *   • create a bank account + post a book deposit to its GL account
 *   • import a statement (deposit + fee lines)
 *   • auto-match the deposit, adjust the fee (posts a real journal), close
 *   • cash-drawer closing: create → approve (posts the difference journal,
 *     resets the cashbox to the counted amount)
 * Plus: /api/bank-recon is admin/manager-only (a cashier is refused).
 *
 * PORT 3244. Self-cleaning best-effort.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const ENV = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2];
}
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const PORT = 3244;
const BASE = `http://127.0.0.1:${PORT}`;
const T = {
  admin:   jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
  cashier: jwt.sign({ id: 900401, username: 'brec_cash', role: 'cashier', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
};
let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
async function waitUp(s) { for (let i = 0; i < s; i++) { try { const r = await fetch(BASE + '/api/version'); if (r.ok) return true; } catch (_) {} await new Promise(z => setTimeout(z, 1000)); } return false; }
function api(method, p, tok, body) { return fetch(BASE + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body != null ? JSON.stringify(body) : undefined }); }
async function j(method, p, tok, body) { const r = await api(method, p, tok, body); let data = null; try { data = await r.json(); } catch (_) {} return { status: r.status, data }; }

async function main() {
  console.log('\n═══ Bank reconciliation + cash-closing ═══\n');
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  const accts = []; const jrns = [];
  try {
    check('server up', await waitUp(240));
    const sfx = String(Date.now()).slice(-5);
    const BANK = 'BR-BANK-' + sfx, cBANK = '1102' + sfx;
    const OTHER = 'BR-OTH-' + sfx, cOTHER = '9O' + sfx;
    const FEE = 'BR-FEE-' + sfx, cFEE = '9F' + sfx;
    const CASH = 'BR-CASH-' + sfx, cCASH = '1101' + sfx;
    for (const [id, code, type] of [[BANK, cBANK, 'asset'], [OTHER, cOTHER, 'revenue'], [FEE, cFEE, 'expense'], [CASH, cCASH, 'asset']]) {
      await j('POST', '/erp/gl/accounts', T.admin, { id, code, nameAr: id, type, parentId: null });
      accts.push(id);
    }
    // bank account linked to BANK gl
    const ba = await j('POST', '/cash/bank-accounts', T.admin, { bankName: 'BR Bank ' + sfx, glAccountId: BANK });
    const baId = ba.data && ba.data.id;
    check('bank account created', !!baId, ba.data);

    // post a book deposit: Dr BANK 500 / Cr OTHER 500
    const jc = await j('POST', '/erp/gl/journals', T.admin, { journalDate: '2026-02-05', description: 'book deposit',
      entries: [{ accountId: BANK, accountCode: cBANK, accountName: BANK, debit: 500, credit: 0 }, { accountId: OTHER, accountCode: cOTHER, accountName: OTHER, debit: 0, credit: 500 }] });
    const jid = jc.data && jc.data.id; if (jid) jrns.push(jid);
    await j('POST', `/erp/gl/journals/${jid}/approve`, T.admin, {});
    const posted = await j('POST', `/erp/gl/journals/${jid}/post`, T.admin, {});
    check('book deposit posted', posted.data && posted.data.success === true, posted.data);

    // cashier cannot reach bank-recon (admin/manager only)
    const cashList = await j('GET', '/bank-recon/statements', T.cashier);
    check('cashier bank-recon → 403', cashList.status === 403, { status: cashList.status });

    // import a statement: deposit +500 (matches book) + fee -20 (adjust)
    const st = await j('POST', '/bank-recon/statements', T.admin, {
      bankAccountId: baId, periodFrom: '2026-02-01', periodTo: '2026-02-28', openingBalance: 0, closingBalance: 480,
      lines: [{ lineDate: '2026-02-05', description: 'deposit', amount: 500 }, { lineDate: '2026-02-10', description: 'bank fee', amount: -20 }] });
    const stId = st.data && st.data.id;
    check('statement created', !!stId, st.data);

    const det1 = await j('GET', `/bank-recon/statements/${stId}`, T.admin);
    check('detail shows 2 lines + 1 book entry', det1.data && det1.data.lines.length === 2 && det1.data.book.length >= 1, det1.data && { lines: det1.data.lines.length, book: det1.data.book.length });

    const am = await j('POST', `/bank-recon/statements/${stId}/auto-match`, T.admin, {});
    check('auto-match matched the deposit', am.data && am.data.matched === 1, am.data);

    // close should fail — the fee line is still unmatched
    const earlyClose = await j('POST', `/bank-recon/statements/${stId}/close`, T.admin, {});
    check('close blocked while a line is unmatched', earlyClose.status === 409, { status: earlyClose.status });

    const feeLine = det1.data.lines.find(l => l.amount === -20);
    const adj = await j('POST', `/bank-recon/statements/${stId}/adjust`, T.admin, { lineId: feeLine.id, contraAccountId: FEE, kind: 'fee', amount: 20, description: 'رسوم' });
    check('fee adjustment posted a journal', adj.data && adj.data.success === true && !!adj.data.journalId, adj.data);
    if (adj.data && adj.data.journalId) jrns.push(adj.data.journalId);

    const close = await j('POST', `/bank-recon/statements/${stId}/close`, T.admin, {});
    check('statement closes once all lines resolved', close.data && close.data.success === true, close.data);

    // ── cash-drawer closing ──
    const box = await j('POST', '/cash/cash-boxes', T.admin, { name: 'BR Box ' + sfx, glAccountId: CASH });
    const boxId = box.data && box.data.id;
    check('cashbox created', !!boxId, box.data);
    const cc = await j('POST', '/bank-recon/cash-closings', T.admin, { cashboxId: boxId, closingDate: '2026-02-28', countedAmount: 100, notes: 'test' });
    check('cash-closing created (expected 0, diff 100)', cc.data && cc.data.difference === 100, cc.data);
    const ccApprove = await j('POST', `/bank-recon/cash-closings/${cc.data.id}/approve`, T.admin, { differenceAccountId: FEE });
    check('cash-closing approved + journal posted', ccApprove.data && ccApprove.data.success === true && !!ccApprove.data.journalId, ccApprove.data);
    if (ccApprove.data && ccApprove.data.journalId) jrns.push(ccApprove.data.journalId);
    const boxes = await j('GET', '/cash/cash-boxes', T.admin);
    const cb = Array.isArray(boxes.data) ? boxes.data.find(b => b.id === boxId) : null;
    check('cashbox reset to counted amount (100)', !!cb && Number(cb.balance) === 100, cb && { balance: cb.balance });
    try { await api('DELETE', '/cash/cash-boxes/' + boxId, T.admin); } catch (_) {}
  } catch (e) {
    check('no exception', false, e && e.message); console.log(log.slice(-2000));
  } finally {
    for (const id of jrns) { try { await api('DELETE', '/erp/gl/journals/' + id, T.admin); } catch (_) {} }
    for (const id of accts.reverse()) { try { await api('DELETE', '/erp/gl/accounts/' + id, T.admin); } catch (_) {} }
    child.kill('SIGKILL');
  }
  console.log(`\n─── ${_p} passed, ${_f} failed ───\n`);
  process.exit(_f ? 1 : 0);
}
main();
