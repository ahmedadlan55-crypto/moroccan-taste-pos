'use strict';
/* Integration — royalty runs (real server + DB, synthesized fixtures).
 *
 * royalty_runs was EMPTY on this install — not because franchising is unused,
 * but because compute has been broken since it shipped: it selected
 * sales.total_amount and sales.vat_amount, columns the sales table has never
 * had (they belong to sales_returns). Every compute threw ER_BAD_FIELD_ERROR
 * and the catch dressed it as a polite failure. It also dated sales by
 * created_at instead of the business date (order_date), filtered voids on
 * deleted_at — a column nothing writes (0 rows live) — and subtracted returns
 * never.
 *
 * The fix computes from what IS recorded: gross = SUM(total_final); net =
 * Σ tax_subtotals_json[*].net (the per-category ex-VAT amounts — never /1.15,
 * which would tax zero-rated lines at 15%); voids excluded by zatca_type;
 * credit notes (ar_documents — the legacy credit_notes table is empty and
 * retired) reduce the month they were ISSUED in, per the business decision
 * that an approved period is never recomputed.
 *
 * Run: node tests/integration/royaltyRuns.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3990;
const MANAGER = 'itest_roy_manager';
const CASHIER = 'itest_roy_cashier';
const PW = 'Roy#Test!2026';
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-ROY-${SFX}-${s}`;
const BRAND_G = P('BRG');   // 5% of GROSS
const BRAND_N = P('BRN');   // 5% of NET — refuses over unparseable VAT blobs
const SHIFT = P('SH');
const PER_START = '2029-03-01', PER_END = '2029-03-31';
const CLOSED_PERIOD = P('CLOSEDPER');
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
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

const runCount = async () => { const [r] = await db.query('SELECT COUNT(*) c FROM royalty_runs WHERE brand_id IN (?,?)', [BRAND_G, BRAND_N]); return Number(r[0].c); };
const journalsFor = async (id) => { const [r] = await db.query("SELECT COUNT(*) c FROM gl_journals WHERE reference_type='RoyaltyRun' AND reference_id=?", [id]); return Number(r[0].c); };

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  for (const u of [MANAGER, CASHIER]) await del('DELETE FROM users WHERE username=?', [u]);
  const [runs] = await db.query('SELECT id FROM royalty_runs WHERE brand_id IN (?,?)', [BRAND_G, BRAND_N]).catch(() => [[]]);
  for (const r of runs) {
    const [js] = await db.query("SELECT id FROM gl_journals WHERE reference_type='RoyaltyRun' AND reference_id=?", [r.id]).catch(() => [[]]);
    for (const j of js) { await del('DELETE FROM gl_entries WHERE journal_id=?', [j.id]); await del('DELETE FROM gl_journals WHERE id=?', [j.id]); }
  }
  await del('DELETE FROM royalty_runs WHERE brand_id IN (?,?)', [BRAND_G, BRAND_N]);
  await del("DELETE FROM ar_documents WHERE id LIKE 'ITEST-ROY-%'");
  await del("DELETE FROM sales WHERE id LIKE 'ITEST-ROY-%'");
  await del("DELETE FROM shifts WHERE id LIKE 'ITEST-ROY-%'");
  await del('DELETE FROM brands WHERE id IN (?,?)', [BRAND_G, BRAND_N]);
  await del('DELETE FROM accounting_periods WHERE id = ?', [CLOSED_PERIOD]);
}

async function fixtures() {
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query("INSERT INTO shifts (id, username, status, start_time) VALUES (?,?,'OPEN',NOW())", [SHIFT, MANAGER]);
  await db.query(
    "INSERT INTO brands (id, name, royalty_type, royalty_value, royalty_base, royalty_fixed_component) VALUES (?,?,?,?,?,0)",
    [BRAND_G, 'ITEST gross brand', 'percentage', 5, 'gross_sales']);
  await db.query(
    "INSERT INTO brands (id, name, royalty_type, royalty_value, royalty_base, royalty_fixed_component) VALUES (?,?,?,?,?,0)",
    [BRAND_N, 'ITEST net brand', 'percentage', 5, 'net_sales']);

  const sale = (id, brand, ymd, total, json, zatcaType) => db.query(
    `INSERT INTO sales (id, order_date, total_final, payment_method, username, shift_id, brand_id, zatca_type, tax_subtotals_json)
     VALUES (?, ?, ?, 'Cash', ?, ?, ?, ?, ?)`,
    [id, ymd + ' 12:00:00', total, MANAGER, SHIFT, brand, zatcaType, json]);

  // Brand G — the arithmetic brand. 115 + 57.50 sold, one 115 VOID that must
  // not count, one sale dated OUTSIDE the period that must not count.
  await sale(P('S1'), BRAND_G, '2029-03-05', 115.00, '{"S":{"net":100.00,"vat":15.00,"rate":15}}', 'simplified');
  await sale(P('S2'), BRAND_G, '2029-03-20', 57.50, '{"S":{"net":50.00,"vat":7.50,"rate":15}}', 'simplified');
  await sale(P('SV'), BRAND_G, '2029-03-10', 115.00, '{"S":{"net":100.00,"vat":15.00,"rate":15}}', 'cancellation');
  await sale(P('SO'), BRAND_G, '2029-04-02', 115.00, '{"S":{"net":100.00,"vat":15.00,"rate":15}}', 'simplified');
  // May sale for brand G — gives the closed-period run a real amount, so its
  // approve actually reaches the GL gate (a 0-amount run posts nothing and
  // would sail past a closed period without ever testing it).
  await sale(P('S5'), BRAND_G, '2029-05-10', 115.00, '{"S":{"net":100.00,"vat":15.00,"rate":15}}', 'simplified');
  // Brand N — one sale whose recorded VAT breakdown is GARBAGE: its net is
  // indeterminable, and a net-based royalty must refuse, not guess.
  await sale(P('S3'), BRAND_N, '2029-03-06', 115.00, 'NOT-JSON{{{', 'simplified');
  await sale(P('S4'), BRAND_N, '2029-03-07', 57.50, '{"S":{"net":50.00,"vat":7.50,"rate":15}}', 'simplified');

  // A credit note ISSUED inside March reduces March — 23.00 gross / 20.00 net.
  await db.query(
    `INSERT INTO ar_documents (id, document_number, document_type, source_type, brand_id, issue_date, currency,
       subtotal, discount_amount, vat_amount, total_amount, paid_amount, balance_amount, status, zatca_status, version, created_by)
     VALUES (?, ?, 'credit_note', 'manual', ?, '2029-03-15', 'SAR', 20.00, 0, 3.00, 23.00, 0, 0, 'issued', 'pending', 1, 'itest-roy')`,
    [P('CN1'), P('CN1'), BRAND_G]);
  // A CANCELLED credit note is not money and must not reduce anything.
  await db.query(
    `INSERT INTO ar_documents (id, document_number, document_type, source_type, brand_id, issue_date, currency,
       subtotal, discount_amount, vat_amount, total_amount, paid_amount, balance_amount, status, zatca_status, version, created_by)
     VALUES (?, ?, 'credit_note', 'manual', ?, '2029-03-16', 'SAR', 100.00, 0, 15.00, 115.00, 0, 0, 'cancelled', 'pending', 1, 'itest-roy')`,
    [P('CN2'), P('CN2'), BRAND_G]);
}

(async () => {
  await cleanup();
  await fixtures();

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const manager = await login(MANAGER);
    const cashier = await login(CASHIER);
    check('manager + cashier both got a JWT', !!manager && !!cashier);

    const body = { brandId: BRAND_G, periodStart: PER_START, periodEnd: PER_END };

    // ── authz ────────────────────────────────────────────────────────────────
    console.log('\n▶ authz');
    const denied = await call('POST', '/api/erp/royalty-runs/compute', cashier, body);
    check('cashier is DENIED compute (royalty.manage)', denied.status === 403, denied.status);
    check('  …and no run row appeared', (await runCount()) === 0);

    // ── preview: the numbers, with NOTHING written ───────────────────────────
    console.log('\n▶ preview');
    const prev = await call('POST', '/api/erp/royalty-runs/compute', manager, { ...body, preview: true });
    check('preview succeeds — the old compute could NEVER succeed (phantom columns)', prev.status === 200 && prev.body?.success === true, prev.body);
    check('gross = 115 + 57.50 − CN 23 = 149.50 (void and out-of-period sales excluded)', prev.body?.grossSales === 149.5, prev.body?.grossSales);
    check('net = 100 + 50 − CN 20 = 130.00 — from the RECORDED subtotals, not /1.15', prev.body?.netSales === 130, prev.body?.netSales);
    check('royalty = 5% × 149.50 = 7.48', prev.body?.royaltyAmount === 7.48, prev.body?.royaltyAmount);
    check('the cancelled credit note reduced NOTHING (only 1 CN counted)', prev.body?.creditNotes?.count === 1, prev.body?.creditNotes);
    check('preview wrote NO row', (await runCount()) === 0);

    // ── create + duplicate-period protection ─────────────────────────────────
    console.log('\n▶ create');
    const created = await call('POST', '/api/erp/royalty-runs/compute', manager, body);
    check('create succeeds with the same numbers', created.status === 200 && created.body?.success === true && created.body?.royaltyAmount === 7.48, created.body);
    const RUN = created.body?.id;
    check('  …and exactly one draft row exists', (await runCount()) === 1);

    const dupExact = await call('POST', '/api/erp/royalty-runs/compute', manager, body);
    check('the SAME period is refused (double-billing)', dupExact.status === 200 && dupExact.body?.success === false, dupExact.body);
    const dupOverlap = await call('POST', '/api/erp/royalty-runs/compute', manager, { brandId: BRAND_G, periodStart: '2029-03-25', periodEnd: '2029-04-30' });
    check('an OVERLAPPING period is refused too — a shared day bills twice', dupOverlap.body?.success === false, dupOverlap.body);
    check('  …still exactly one row', (await runCount()) === 1);

    // ── net-based royalty over indeterminable VAT ────────────────────────────
    console.log('\n▶ net_sales over a corrupt VAT blob');
    const netRefuse = await call('POST', '/api/erp/royalty-runs/compute', manager, { brandId: BRAND_N, periodStart: PER_START, periodEnd: PER_END, preview: true });
    check('REFUSED — the net is indeterminable, and a guess is not a royalty', netRefuse.body?.success === false && Number(netRefuse.body?.netUnknownCount) === 1, netRefuse.body);

    // ── approve: JWT actor + atomic with the accrual journal ─────────────────
    console.log('\n▶ approve');
    const appr = await call('POST', '/api/erp/royalty-runs/' + RUN + '/approve', manager, { username: 'haxor_from_body' });
    check('approve succeeds and posts the accrual', appr.status === 200 && appr.body?.success === true && !!appr.body?.journalId, appr.body);
    const [run1] = await db.query('SELECT status, approved_by, gl_journal_id FROM royalty_runs WHERE id=?', [RUN]);
    check('approved_by is the TOKEN identity, not the body\'s "haxor_from_body"', run1[0].approved_by === MANAGER, run1[0].approved_by);
    const [je] = await db.query('SELECT account_code, debit, credit, brand_id FROM gl_entries WHERE journal_id=?', [run1[0].gl_journal_id]);
    check('journal: Dr 6100 (franchise fee) 7.48', je.some((e) => e.account_code === '6100' && Number(e.debit) === 7.48), je);
    check('  …Cr 2310 (royalty payable) 7.48, carrying the brand dimension', je.some((e) => e.account_code === '2310' && Number(e.credit) === 7.48 && e.brand_id === BRAND_G), je);

    const reApprove = await call('POST', '/api/erp/royalty-runs/' + RUN + '/approve', manager, {});
    check('approving twice is refused (409) and posts NO second journal', reApprove.status === 409 && (await journalsFor(RUN)) === 1, { status: reApprove.status });

    // ── approve into a CLOSED period rolls the whole thing back ──────────────
    console.log('\n▶ closed period');
    const c2 = await call('POST', '/api/erp/royalty-runs/compute', manager, { brandId: BRAND_G, periodStart: '2029-05-01', periodEnd: '2029-05-31' });
    const RUN2 = c2.body?.id;
    check('second run (different period) created', !!RUN2, c2.body);
    // The accrual posts on run_date (today) — pin it to a date we can close
    // without touching any real period.
    await db.query("UPDATE royalty_runs SET run_date='2029-06-15' WHERE id=?", [RUN2]);
    await db.query(
      "INSERT INTO accounting_periods (id, period_label, start_date, end_date, status) VALUES (?, 'ITEST closed', '2029-06-01', '2029-06-30', 'closed')",
      [CLOSED_PERIOD]);
    const apprClosed = await call('POST', '/api/erp/royalty-runs/' + RUN2 + '/approve', manager, {});
    check('approve into a closed period is REFUSED', apprClosed.status >= 400 || apprClosed.body?.success === false, apprClosed.body);
    const [run2] = await db.query('SELECT status, gl_journal_id FROM royalty_runs WHERE id=?', [RUN2]);
    check('  …and the status flip ROLLED BACK with it (still draft — the old code left it approved)', run2[0].status === 'draft', run2[0]);
    check('  …no journal exists for it', (await journalsFor(RUN2)) === 0);

    // ── honest state answers ─────────────────────────────────────────────────
    console.log('\n▶ honest responses');
    const payDraft = await call('POST', '/api/erp/royalty-runs/' + RUN2 + '/mark-paid', manager, {});
    check('mark-paid on a DRAFT answers 409, not success (it used to say success)', payDraft.status === 409, payDraft.status);
    const payReal = await call('POST', '/api/erp/royalty-runs/' + RUN + '/mark-paid', manager, {});
    check('mark-paid on the APPROVED run succeeds', payReal.status === 200 && payReal.body?.success === true, payReal.body);
    const delApproved = await call('DELETE', '/api/erp/royalty-runs/' + RUN, manager, null);
    check('deleting a non-draft answers 409', delApproved.status === 409, delApproved.status);
    const delDraft = await call('DELETE', '/api/erp/royalty-runs/' + RUN2, manager, null);
    check('deleting the draft succeeds', delDraft.status === 200 && delDraft.body?.success === true, delDraft.body);
    const delAgain = await call('DELETE', '/api/erp/royalty-runs/' + RUN2, manager, null);
    check('  …and deleting it AGAIN answers 409, not a hollow success', delAgain.status === 409, delAgain.status);

    console.log(`\n${fail === 0 ? '✅' : '❌'} royaltyRuns: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
