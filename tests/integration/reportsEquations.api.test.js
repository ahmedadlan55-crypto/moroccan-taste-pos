'use strict';
/* Integration — report equations (real server + DB, synthesized fixtures).
 *
 * Four endpoints, one doctrine: every figure is a sum over RECORDED data,
 * every unknown is COUNTED and surfaced, every DB fault is a 500.
 *
 *  · /api/erp/reports/sales-analytics — net/vat come from each sale's
 *    tax_subtotals_json (never gross ÷ 1.15); voids excluded by zatca_type
 *    (deleted_at is written by nothing); a corrupt blob counts into
 *    netUnknownCount instead of being guessed; a product name with no menu
 *    row counts into costUnknownCount instead of ||0 minting a 100% margin.
 *  · /api/erp/reports/equity-changes — NEW statement of changes in equity.
 *    The mandatory invariant: its closing total equity must EQUAL the
 *    balance sheet's totEq at ?to — asserted here against a live
 *    /reports/balance-sheet-ifrs call, with a capital journal, a revenue
 *    journal, a drawings journal AND a closing entry in play.
 *  · /api/erp/reports/profitability — margin ≡ profit/revenue over GL sums.
 *  · /api/erp/reports/inventory-valuation — names its cost basis.
 *
 * Fixtures are ITEST-RQ-* prefixed, created in far-future periods
 * (2031-03 sales / 2031-07 GL) so nothing real is touched; cleanup runs
 * before AND in finally — zero residue.
 *
 * Run: node tests/integration/reportsEquations.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3996;
const MANAGER = 'itest_rq_manager';
const CASHIER = 'itest_rq_cashier';
const PW = 'Rq#Test!2026';
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-RQ-${SFX}-${s}`;
const CODE = (s) => `IT${SFX}${s}`;          // gl_accounts.code is varchar(20)
const BRAND = P('BR');
const SHIFT = P('SH');
const BURGER = P('Burger');
const MYSTERY = P('Mystery');                 // deliberately NOT in menu
// Sales window (analytics) and GL window (equity/profitability) are disjoint
// far-future months so real data can never leak into the exact asserts.
const ANA_FROM = '2031-03-01', ANA_TO = '2031-03-31';
const EQ_FROM = '2031-07-01', EQ_TO = '2031-07-31';

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  for (const u of [MANAGER, CASHIER]) await del('DELETE FROM users WHERE username=?', [u]);
  await del("DELETE FROM sales_items WHERE order_id LIKE 'ITEST-RQ-%'");
  await del("DELETE FROM sales WHERE id LIKE 'ITEST-RQ-%'");
  await del("DELETE FROM menu WHERE id LIKE 'ITEST-RQ-%'");
  await del("DELETE FROM shifts WHERE id LIKE 'ITEST-RQ-%'");
  await del("DELETE FROM brands WHERE id LIKE 'ITEST-RQ-%'");
  await del("DELETE FROM gl_entries WHERE journal_id LIKE 'ITEST-RQ-%'");
  await del("DELETE FROM gl_journals WHERE id LIKE 'ITEST-RQ-%'");
  await del("DELETE FROM gl_accounts WHERE id LIKE 'ITEST-RQ-%'");
}

async function fixtures() {
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query("INSERT INTO shifts (id, username, status, start_time) VALUES (?,?,'OPEN',NOW())", [SHIFT, MANAGER]);
  await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [BRAND, 'ITEST reports brand']);

  // ── sales-analytics fixtures ──────────────────────────────────────────
  // Menu carries a cost for "Burger" only; "Mystery" has no menu row at all
  // (the rename scenario that used to become a 100%-margin product).
  await db.query('INSERT INTO menu (id, name, price, cost, active) VALUES (?,?,?,?,1)', [P('M1'), BURGER, 57.5, 10.0]);

  const sale = (id, ymd, total, json, zatcaType) => db.query(
    `INSERT INTO sales (id, order_date, total_final, payment_method, username, shift_id, brand_id, zatca_type, tax_subtotals_json)
     VALUES (?, ?, ?, 'Cash', ?, ?, ?, ?, ?)`,
    [id, ymd + ' 12:00:00', total, MANAGER, SHIFT, BRAND, zatcaType, json]);
  // S1 — MIXED S+Z sale: 100 net @15% + 15 net @0% ⇒ gross 130, net 115, vat 15.
  await sale(P('S1'), '2031-03-05', 130.00, '{"S":{"net":100.00,"vat":15.00,"rate":15},"Z":{"net":15.00,"vat":0.00,"rate":0}}', 'simplified');
  // S2 — CORRUPT blob: gross counts (recorded), net/vat indeterminable.
  await sale(P('S2'), '2031-03-20', 57.50, 'NOT-JSON{{{', 'simplified');
  // SV — VOID: must not count anywhere (zatca_type, not deleted_at).
  await sale(P('SV'), '2031-03-10', 115.00, '{"S":{"net":100.00,"vat":15.00,"rate":15}}', 'cancellation');

  const item = (orderId, ymd, name, qty, total) => db.query(
    `INSERT INTO sales_items (order_id, order_date, item_name, qty, price, total, payment_method, username, shift_id)
     VALUES (?, ?, ?, ?, ?, ?, 'Cash', ?, ?)`,
    [orderId, ymd + ' 12:00:00', name, qty, qty ? total / qty : 0, total, MANAGER, SHIFT]);
  await item(P('S1'), '2031-03-05', BURGER, 2, 115.00);
  await item(P('S1'), '2031-03-05', MYSTERY, 1, 15.00);
  await item(P('S2'), '2031-03-20', BURGER, 1, 57.50);
  await item(P('SV'), '2031-03-10', BURGER, 1, 115.00);   // rides a void — excluded

  // ── GL fixtures (equity-changes + profitability) ──────────────────────
  // Leaf accounts: root-level (parent_id NULL), active, not folders — they
  // satisfy the exact leaf predicate balance-sheet-ifrs uses.
  const acc = (id, code, nameAr, type, reportSection) => db.query(
    `INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_active, is_folder, account_class, report_section)
     VALUES (?, ?, ?, ?, ?, NULL, 1, 1, 0, 'detail', ?)`,
    [id, code, nameAr, nameAr, type, reportSection]);
  await acc(P('A-CASH'), CODE('1001'), 'ITEST نقدية', 'asset', null);
  await acc(P('A-CAP'), CODE('3001'), 'ITEST رأس المال', 'equity', 'capital');
  await acc(P('A-RET'), CODE('3002'), 'ITEST أرباح محتجزة', 'equity', 'retained');
  await acc(P('A-DRW'), CODE('3005'), 'ITEST مسحوبات', 'equity', 'drawings');
  await acc(P('A-REV'), CODE('4001'), 'ITEST إيراد', 'revenue', null);
  await acc(P('A-EXP'), CODE('5001'), 'ITEST مصروف', 'expense', null);

  let eSeq = 0;
  const journal = async (id, ymd, isClosing, lines) => {
    const tot = lines.reduce((s, l) => s + (l.d || 0), 0);
    await db.query(
      `INSERT INTO gl_journals (id, journal_number, journal_date, description, total_debit, total_credit, status, is_closing_entry, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?)`,
      [id, CODE('J' + (++eSeq)), ymd, 'ITEST reports fixture', tot, tot, isClosing ? 1 : 0, MANAGER]);
    for (const l of lines) {
      await db.query(
        `INSERT INTO gl_entries (id, journal_id, account_id, account_code, debit, credit, description, brand_id)
         VALUES (?, ?, ?, ?, ?, ?, 'ITEST', ?)`,
        [P('E' + (++eSeq)), id, l.acc, l.code, l.d || 0, l.c || 0, l.brand || null]);
    }
  };
  const CASH = { acc: P('A-CASH'), code: CODE('1001') };
  const CAP = { acc: P('A-CAP'), code: CODE('3001') };
  const RET = { acc: P('A-RET'), code: CODE('3002') };
  const DRW = { acc: P('A-DRW'), code: CODE('3005') };
  const REV = { acc: P('A-REV'), code: CODE('4001') };
  const EXP = { acc: P('A-EXP'), code: CODE('5001') };
  // Opening (BEFORE the period): capital 50,000.
  await journal(P('J0'), '2031-06-15', false, [{ ...CASH, d: 50000 }, { ...CAP, c: 50000 }]);
  // In-period: +50,000 capital → closing capital 100,000.
  await journal(P('J1'), '2031-07-05', false, [{ ...CASH, d: 50000 }, { ...CAP, c: 50000 }]);
  // In-period P&L (brand-dimensioned for the profitability equation):
  // revenue 5,000 − expense 2,000 ⇒ net income 3,000, margin 60%.
  await journal(P('J2'), '2031-07-10', false, [{ ...CASH, d: 5000 }, { ...REV, c: 5000, brand: BRAND }]);
  await journal(P('J3'), '2031-07-11', false, [{ ...EXP, d: 2000, brand: BRAND }, { ...CASH, c: 2000 }]);
  // In-period drawings 1,000 (the contra-equity bucket).
  await journal(P('J4'), '2031-07-12', false, [{ ...DRW, d: 1000 }, { ...CASH, c: 1000 }]);
  // CLOSING ENTRY (is_closing_entry=1): revenue → retained. Its effect must
  // appear on closingEntriesLine, NOT inside netIncomeLine — and retained
  // must still reconcile with the balance sheet across it.
  await journal(P('J5'), '2031-07-31', true, [{ ...REV, d: 5000 }, { ...RET, c: 5000 }]);
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

    // ── authn/authz — all four endpoints refuse anonymous callers ─────────
    console.log('\n▶ auth');
    for (const p of [
      `/api/erp/reports/sales-analytics?from=${ANA_FROM}&to=${ANA_TO}`,
      `/api/erp/reports/profitability?from=${EQ_FROM}&to=${EQ_TO}&dimension=brand`,
      '/api/erp/reports/inventory-valuation',
      `/api/erp/reports/equity-changes?from=${EQ_FROM}&to=${EQ_TO}`
    ]) {
      const anon = await call('GET', p, null);
      check(`anonymous is 401 on ${p.split('?')[0].split('/').pop()}`, anon.status === 401, anon.status);
    }
    const denied = await call('GET', `/api/erp/reports/equity-changes?from=${EQ_FROM}&to=${EQ_TO}`, cashier);
    check('cashier is DENIED equity-changes (finance.reports.view)', denied.status === 403, denied.status);
    const badRange = await call('GET', '/api/erp/reports/equity-changes?from=2031-07-31&to=2031-07-01', manager);
    check('inverted period answers 400, not an empty statement', badRange.status === 400, badRange.status);

    // ── sales-analytics — known-equation fixtures ──────────────────────────
    console.log('\n▶ sales-analytics');
    const sa = await call('GET', `/api/erp/reports/sales-analytics?from=${ANA_FROM}&to=${ANA_TO}&brand=${encodeURIComponent(BRAND)}&groupBy=all`, manager);
    check('analytics answers 200 success', sa.status === 200 && sa.body?.success === true, sa.body);
    const rev = sa.body?.revenue || {};
    check('gross = 130 + 57.50 = 187.50 (the void NEVER counted — zatca_type, not deleted_at)', rev.grossInclVat === 187.5, rev.grossInclVat);
    check('net = 115 from the RECORDED S+Z subtotals (not 187.50 ÷ 1.15 = 163.04)', rev.net === 115, rev.net);
    check('vat = 15 from the recorded subtotals', rev.vat === 15, rev.vat);
    check('the corrupt blob is COUNTED (netUnknownCount = 1), not guessed into the sums', rev.netUnknownCount === 1, rev.netUnknownCount);
    check('invoiceCount = 2 (void excluded)', rev.invoiceCount === 2, rev.invoiceCount);
    check('cost = 3 × 10 = 30 (Burger only)', rev.cost === 30, rev.cost);
    check('the renamed product is COUNTED (costUnknownCount = 1), not priced at 0', rev.costUnknownCount === 1, rev.costUnknownCount);
    check('profit = net − known cost = 115 − 30 = 85', rev.profit === 85, rev.profit);
    check('headline.total matches gross', sa.body?.headline?.total === 187.5, sa.body?.headline);
    const burger = (sa.body?.byProduct || []).find((x) => x.name === BURGER);
    const mystery = (sa.body?.byProduct || []).find((x) => x.name === MYSTERY);
    check('byProduct Burger: qty 3, gross 172.50, cost 30', !!burger && burger.qty === 3 && burger.gross === 172.5 && burger.cost === 30, burger);
    check('byProduct Mystery: cost is null (unknown), NOT 0/100% margin', !!mystery && mystery.cost === null && mystery.margin === null, mystery);
    check('byProduct net is null — the tax split is per sale, a per-line net would be invented', !!burger && burger.net === null, burger);
    const daily = sa.body?.daily || [];
    // (dates JSON-serialize as TZ-shifted ISO strings, so assert by count +
    // sum: 2 days totalling 187.50 means the void's 115.00 day is absent.)
    check('daily has 2 days summing to 187.50 (the void\'s day is absent)', daily.length === 2 && r2(daily.reduce((s, d) => s + (Number(d.total) || 0), 0)) === 187.5, daily);

    // ── equity-changes — the reconciliation invariant ──────────────────────
    console.log('\n▶ equity-changes');
    const eq = await call('GET', `/api/erp/reports/equity-changes?from=${EQ_FROM}&to=${EQ_TO}`, manager);
    check('equity-changes answers 200 success', eq.status === 200 && eq.body?.success === true, eq.body);
    const buckets = eq.body?.buckets || [];
    check('buckets are the balance sheet\'s five, in IFRS order', buckets.map((b) => b.key).join(',') === 'capital,retained,drawings,reserves,zakat', buckets.map((b) => b.key));
    const cap = buckets.find((b) => b.key === 'capital');
    const capAcc = (cap?.accounts || []).find((a) => a.id === P('A-CAP'));
    check('capital account: opening 50,000 / periodCredit 50,000 / closing 100,000', !!capAcc && capAcc.opening === 50000 && capAcc.periodCredit === 50000 && capAcc.periodDebit === 0 && capAcc.closing === 100000, capAcc);
    const ret = buckets.find((b) => b.key === 'retained');
    const retAcc = (ret?.accounts || []).find((a) => a.id === P('A-RET'));
    check('retained account: opening 0 → closing 5,000 (fed by the closing entry)', !!retAcc && retAcc.opening === 0 && retAcc.closing === 5000, retAcc);
    const drw = buckets.find((b) => b.key === 'drawings');
    const drwAcc = (drw?.accounts || []).find((a) => a.id === P('A-DRW'));
    check('drawings account present with periodDebit 1,000 and the bucket flagged contra', !!drwAcc && drwAcc.periodDebit === 1000 && drw.isContra === true, drwAcc);
    const nil = eq.body?.netIncomeLine || {};
    check('netIncomeLine: revenue 5,000 − expense 2,000 = 3,000 (closing entry EXCLUDED)', nil.revenue === 5000 && nil.expense === 2000 && nil.netIncome === 3000, nil);
    const cel = eq.body?.closingEntriesLine || {};
    check('closingEntriesLine: the close shows as its own row (revenueEffect −5,000, 1 journal)', cel.revenueEffect === -5000 && cel.netEffect === -5000 && cel.journalCount === 1, cel);
    // Movement identity — independent of whatever pre-2031 income the live
    // ledger carries (it sits in BOTH opening and closing):
    //   Δequity = Δcapital(+50,000) + Δretained(+5,000) + Δdrawings(bs-signed +1,000)
    //           + netIncome(+3,000) + closingEffect(−5,000) = +54,000
    const delta = r2((eq.body?.totals?.closing || 0) - (eq.body?.totals?.opening || 0));
    check('Δ total equity over the period = +54,000 exactly', delta === 54000, delta);

    // THE INVARIANT: closing total equity === balance-sheet-ifrs totEq at ?to.
    const bs = await call('GET', `/api/erp/reports/balance-sheet-ifrs?asOfDate=${EQ_TO}`, manager);
    check('balance-sheet-ifrs answered', bs.status === 200 && bs.body && 'totEq' in bs.body, bs.status);
    const totEq = Number(bs.body?.totEq) || 0;
    check('INVARIANT: statement closing == balance sheet totEq (|Δ| < 0.01)', Math.abs((eq.body?.totals?.closing || 0) - totEq) < 0.01, { closing: eq.body?.totals?.closing, totEq });
    check('  …and the endpoint\'s own reconciliation says so (matches:true, same figure)', eq.body?.reconciliation?.matches === true && eq.body?.reconciliation?.bsTotEq === r2(totEq), eq.body?.reconciliation);

    // ── profitability — the margin equation over GL sums ──────────────────
    console.log('\n▶ profitability');
    const pf = await call('GET', `/api/erp/reports/profitability?from=${EQ_FROM}&to=${EQ_TO}&dimension=brand`, manager);
    check('profitability answers 200 success', pf.status === 200 && pf.body?.success === true, pf.body);
    const row = (pf.body?.rows || []).find((x) => x.id === BRAND);
    check('brand row: revenue 5,000 / expenses 2,000 / profit 3,000', !!row && row.revenue === 5000 && row.expenses === 2000 && row.profit === 3000, row);
    check('margin ≡ profit/revenue = 60%', !!row && row.margin === 60, row && row.margin);

    // ── inventory-valuation — names its cost basis ─────────────────────────
    console.log('\n▶ inventory-valuation');
    const iv = await call('GET', '/api/erp/reports/inventory-valuation', manager);
    check('valuation answers 200 success', iv.status === 200 && iv.body?.success === true, iv.status);
    check('costBasis is declared: item_cost (not a silent pseudo-WAC)', iv.body?.costBasis === 'item_cost', iv.body?.costBasis);
    check('  …with a human note saying so', typeof iv.body?.note === 'string' && iv.body.note.length > 0, iv.body?.note);

    console.log(`\n${fail === 0 ? '✅' : '❌'} reportsEquations: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
