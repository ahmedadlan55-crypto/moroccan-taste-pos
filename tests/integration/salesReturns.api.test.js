'use strict';
/* Integration — sales returns: credit note, per-line restock, COGS (real server + DB).
 *
 * What was wrong, proven live before this suite existed:
 *   · sales_return_lines had NO warehouse_id column, yet SalesReturnService.post
 *     tested `!l.warehouse_id` to decide whether to restock → it `continue`d on
 *     EVERY line of EVERY return. Restock and the COGS reversal were unreachable
 *     dead code. Evidence: 3 posted returns, all cost_total=0.00, ZERO
 *     inventory_movements with reference_type='SalesReturn', ZERO SalesReturnCOGS
 *     journals. create() computed a warehouseId at :89 and never inserted it.
 *   · Every credit note was a header with a total and NO LINES (live: 3 credit
 *     notes at LINES=0 while every invoice had 1-2) — unprintable, un-auditable.
 *   · No credit note was ever ZATCA-stamped: zatca_status='pending' with no
 *     uuid/hash/QR on 9/9 documents. InvoiceService.issue calls
 *     ZatcaDocumentService.stamp; SalesReturnService.post never did.
 *   · postCreditNote debited ALL revenue to one default account while postInvoice
 *     splits by line revenue_account_code → a split-revenue invoice never nets to
 *     zero on a full return.
 *   · reverse() reversed only the revenue journal. Now that COGS actually posts as
 *     a second journal, that would re-deduct stock while leaving Dr Inventory /
 *     Cr COGS standing.
 *
 * A POS line sells a MENU item (a burger); what left the shelf were its recipe
 * COMPONENTS (bun, patty). So restock reads ar_document_line_components, snapshot
 * at checkout — never the live recipe, which may since have been reformulated.
 *
 * Run: node tests/integration/salesReturns.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3988;
const CASHIER = 'itest_ret_cashier';
const MANAGER = 'itest_ret_manager';
const PW = 'Return#Test!2026';
const WH = 'ITEST-WH-RET';
const WH2 = 'ITEST-WH-RET2';
const BUN = 'ITEST-ITEM-BUN';
const PATTY = 'ITEST-ITEM-PATTY';
const POTATO = 'ITEST-ITEM-POTATO';
const INV = 'ITEST-ARDOC-INV';
const LINE_A = 'ITEST-ARL-BURGER';      // menu line, has components, WILL be restocked
const LINE_B = 'ITEST-ARL-FRIES';       // menu line, has components, will NOT be restocked
const RET_DATE = '2029-06-15';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }

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

const stockOf = async (wh, item) => {
  const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [wh, item]);
  return r.length ? Number(r[0].qty) : null;
};
const movesOf = async (item) => {
  const [r] = await db.query("SELECT COUNT(*) c FROM inventory_movements WHERE item_id=? AND reference_type LIKE 'SalesReturn%'", [item]);
  return Number(r[0].c);
};
const journalsRef = async (type) => {
  const [r] = await db.query('SELECT COUNT(*) c FROM gl_journals WHERE reference_type=?', [type]);
  return Number(r[0].c);
};
const retStatus = async (id) => { const [r] = await db.query('SELECT status FROM sales_returns WHERE id=?', [id]); return r.length ? r[0].status : null; };
const retCount = async () => { const [r] = await db.query('SELECT COUNT(*) c FROM sales_returns WHERE original_ar_document_id=?', [INV]); return Number(r[0].c); };

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  for (const u of [CASHIER, MANAGER]) await del('DELETE FROM users WHERE username=?', [u]);
  // returns + their credit notes + every journal either produced
  const [rets] = await db.query('SELECT id, credit_note_id FROM sales_returns WHERE original_ar_document_id=?', [INV]).catch(() => [[]]);
  for (const r of rets) {
    for (const t of ['SalesReturn', 'SalesReturnCOGS', 'SalesReturnReversal', 'SalesReturnCOGSReversal']) {
      const [js] = await db.query('SELECT id FROM gl_journals WHERE reference_type=? AND reference_id=?', [t, r.id]).catch(() => [[]]);
      for (const j of js) {
        await del('DELETE FROM gl_entries WHERE journal_id=?', [j.id]);
        await del('DELETE FROM gl_journals WHERE id=?', [j.id]);
      }
    }
    await del('DELETE FROM sales_return_line_components WHERE return_id=?', [r.id]);
    await del('DELETE FROM sales_return_lines WHERE return_id=?', [r.id]);
    if (r.credit_note_id) {
      await del('DELETE FROM ar_document_line_components WHERE document_id=?', [r.credit_note_id]);
      await del('DELETE FROM ar_document_lines WHERE document_id=?', [r.credit_note_id]);
      await del('DELETE FROM ar_documents WHERE id=?', [r.credit_note_id]);
    }
    await del('DELETE FROM ar_events WHERE entity_id=?', [r.id]);
  }
  await del('DELETE FROM sales_returns WHERE original_ar_document_id=?', [INV]);
  await del('DELETE FROM ar_document_line_components WHERE document_id=?', [INV]);
  await del('DELETE FROM ar_document_lines WHERE document_id=?', [INV]);
  await del('DELETE FROM ar_documents WHERE id=?', [INV]);
  for (const w of [WH, WH2]) {
    await del('DELETE FROM inventory_movements WHERE warehouse_id=?', [w]);
    await del('DELETE FROM warehouse_stock WHERE warehouse_id=?', [w]);
  }
  for (const i of [BUN, PATTY, POTATO]) await del('DELETE FROM inv_items WHERE id=?', [i]);
  for (const w of [WH, WH2]) await del('DELETE FROM warehouses WHERE id=?', [w]);
}

async function fixtures() {
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  // warehouses.code is NOT NULL with no default.
  await db.query("INSERT INTO warehouses (id, name, code) VALUES (?, 'ITEST Ret WH', 'ITSTR')", [WH]);
  await db.query("INSERT INTO warehouses (id, name, code) VALUES (?, 'ITEST Ret WH2', 'ITSTR2')", [WH2]);
  await db.query("INSERT INTO inv_items (id, name, unit, cost, stock) VALUES (?, 'ITEST bun', 'PCS', 5, 100)", [BUN]);
  await db.query("INSERT INTO inv_items (id, name, unit, cost, stock) VALUES (?, 'ITEST patty', 'PCS', 15, 100)", [PATTY]);
  await db.query("INSERT INTO inv_items (id, name, unit, cost, stock) VALUES (?, 'ITEST potato', 'KG', 10, 100)", [POTATO]);
  // warehouse_stock.id is NOT NULL with no default (not auto-increment).
  // The patty sits in a SECOND warehouse: one menu line's components can span
  // warehouses, which is why the COGS reversal splits its inventory leg.
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,100)', [`WS-${WH}-${BUN}`, WH, BUN]);
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,100)', [`WS-${WH2}-${PATTY}`, WH2, PATTY]);
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,100)', [`WS-${WH}-${POTATO}`, WH, POTATO]);

  // An issued POS invoice: 2 menu lines, no item_id (a menu id is not an inv_item).
  await db.query(
    `INSERT INTO ar_documents (id, document_number, document_type, source_type, source_id, customer_name,
       warehouse_id, issue_date, currency, subtotal, discount_amount, vat_amount, total_amount,
       paid_amount, balance_amount, status, zatca_status, version, created_by)
     VALUES (?, 'ITEST-SI-0001', 'invoice', 'pos', 'ITEST-SALE-1', 'ITEST customer',
       ?, ?, 'SAR', 150, 0, 22.50, 172.50, 0, 172.50, 'issued', 'pending', 1, 'itest')`,
    [INV, WH, RET_DATE]);
  // Line A — burger x2: net 100, vat 15, cost 40. Revenue account 4100.
  await db.query(
    `INSERT INTO ar_document_lines (id, document_id, source_line_id, item_id, menu_id, description,
       entered_qty, conversion_factor_snapshot, base_qty, unit_price, discount_amount, vat_category, vat_rate,
       net_amount, vat_amount, gross_amount, revenue_account_code, warehouse_id, cost_snapshot, projection_version)
     VALUES (?, ?, '0', NULL, 'ITEST-MENU-BURGER', 'ITEST burger', 2, 1, 2, 50, 0, 'S', 15, 100, 15, 115, '4100', ?, 40, 1)`,
    [LINE_A, INV, WH]);
  // Line B — fries x2: net 50, vat 7.5, cost 20.
  await db.query(
    `INSERT INTO ar_document_lines (id, document_id, source_line_id, item_id, menu_id, description,
       entered_qty, conversion_factor_snapshot, base_qty, unit_price, discount_amount, vat_category, vat_rate,
       net_amount, vat_amount, gross_amount, revenue_account_code, warehouse_id, cost_snapshot, projection_version)
     VALUES (?, ?, '1', NULL, 'ITEST-MENU-FRIES', 'ITEST fries', 2, 1, 2, 25, 0, 'S', 15, 50, 7.50, 57.50, '4100', ?, 20, 1)`,
    [LINE_B, INV, WH]);
  // Components actually deducted at checkout.
  const comp = (id, line, seq, item, name, wh, q, unitCost, total) => db.query(
    `INSERT INTO ar_document_line_components (id, document_id, document_line_id, component_seq, source,
       inv_item_id, inv_item_name, warehouse_id, deducted_base_qty, unit_code, conversion_factor,
       unit_cost_snapshot, total_cost, projection_version)
     VALUES (?, ?, ?, ?, 'recipe', ?, ?, ?, ?, 'PCS', 1, ?, ?, 1)`,
    [id, INV, line, seq, item, name, wh, q, unitCost, total]);
  await comp('ITEST-ARLC-1', LINE_A, 1, BUN, 'ITEST bun', WH, 2, 5, 10);
  await comp('ITEST-ARLC-2', LINE_A, 2, PATTY, 'ITEST patty', WH2, 2, 15, 30);
  await comp('ITEST-ARLC-3', LINE_B, 1, POTATO, 'ITEST potato', WH, 2, 10, 20);
}

(async () => {
  await cleanup();
  await fixtures();

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const cashier = await login(CASHIER);
    const manager = await login(MANAGER);
    check('cashier + manager both got a JWT', !!cashier && !!manager);

    // ── schema: the columns whose absence made restock dead code ──────────────
    console.log('\n▶ schema');
    const [sc] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_return_lines' AND COLUMN_NAME IN ('restock','warehouse_id')");
    check('sales_return_lines now HAS restock + warehouse_id (both were missing)', sc.length === 2, sc.map((x) => x.COLUMN_NAME));
    const [dflt] = await db.query(
      "SELECT COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales_return_lines' AND COLUMN_NAME='restock'");
    check('restock DEFAULTs to 0 — preserves what already-posted returns really did', String(dflt[0].COLUMN_DEFAULT) === '0', dflt[0]);
    const [qrc] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ar_documents' AND COLUMN_NAME='zatca_qr_base64'");
    check('ar_documents can persist the stamped QR', qrc.length === 1);

    // ── create ────────────────────────────────────────────────────────────────
    console.log('\n▶ create (cashier)');
    const mkBody = (lines) => ({ originalArDocumentId: INV, returnDate: RET_DATE, refundMethod: 'ar_reduction', reason: 'itest', lines });

    const over = await call('POST', '/api/order-to-cash/returns', cashier, mkBody([{ originalLineId: LINE_A, returnQty: 3, restock: true }]));
    check('over-return (3 of a sold 2) is REJECTED', over.status >= 400, over.body);
    check('  …and no return row was created by the rejected attempt', (await retCount()) === 0);

    const created = await call('POST', '/api/order-to-cash/returns', cashier,
      mkBody([
        { originalLineId: LINE_A, returnQty: 1, restock: true },    // half of 2 → fraction 0.5
        { originalLineId: LINE_B, returnQty: 2, restock: false },   // all of 2 → fraction 1.0
      ]));
    check('cashier CAN create a return (returns.create)', created.status === 201, created.body);
    const RET = created.body?.data?.id;
    check('  …and it came back with an id', !!RET);

    const [rl] = await db.query('SELECT id, restock, warehouse_id, net_amount, vat_amount, cost_snapshot FROM sales_return_lines WHERE return_id=? ORDER BY id', [RET]);
    check('warehouse_id is PERSISTED (create() used to compute it and drop it)', rl.every((l) => !!l.warehouse_id), rl.map((l) => l.warehouse_id));
    check('restock flags round-trip: one 1, one 0', rl.filter((l) => Number(l.restock) === 1).length === 1 && rl.filter((l) => Number(l.restock) === 0).length === 1, rl.map((l) => l.restock));

    const [snap] = await db.query('SELECT * FROM sales_return_line_components WHERE return_id=? ORDER BY return_line_id, component_seq', [RET]);
    check('components were SNAPSHOTTED onto the return (3 rows)', snap.length === 3, snap.length);
    const bunSnap = snap.find((c) => c.inv_item_id === BUN);
    const pattySnap = snap.find((c) => c.inv_item_id === PATTY);
    const potatoSnap = snap.find((c) => c.inv_item_id === POTATO);
    check('bun scaled to the returned fraction: 2 × 0.5 = 1', Number(bunSnap.restored_base_qty) === 1, bunSnap && bunSnap.restored_base_qty);
    check('bun cost scaled too: 10 × 0.5 = 5', Number(bunSnap.total_cost) === 5, bunSnap && bunSnap.total_cost);
    check('patty keeps its OWN warehouse (components can span warehouses)', pattySnap.warehouse_id === WH2, pattySnap && pattySnap.warehouse_id);
    check('potato (the no_restock line) is snapshotted at full fraction: 2 × 1.0 = 2', Number(potatoSnap.restored_base_qty) === 2, potatoSnap && potatoSnap.restored_base_qty);

    const [hdr] = await db.query('SELECT subtotal, vat_amount, total_amount, cost_total FROM sales_returns WHERE id=?', [RET]);
    check('header money is proportional: net 100×0.5 + 50×1 = 100', Number(hdr[0].subtotal) === 100, hdr[0]);
    check('header vat: 15×0.5 + 7.5×1 = 15', Number(hdr[0].vat_amount) === 15, hdr[0]);
    check('header total = 115', Number(hdr[0].total_amount) === 115, hdr[0]);
    check('document cost_total (40×0.5 + 20×1 = 40) is INDEPENDENT of what restocks', Number(hdr[0].cost_total) === 40, hdr[0]);

    // ── authz: the cashier must not approve or post its own return ────────────
    console.log('\n▶ authz');
    const cashApprove = await call('POST', `/api/order-to-cash/returns/${RET}/approve`, cashier, {});
    check('cashier is DENIED approve (403)', cashApprove.status === 403, cashApprove.body);
    check('  …and the return is genuinely still draft', (await retStatus(RET)) === 'draft');
    const cashPost = await call('POST', `/api/order-to-cash/returns/${RET}/post`, cashier, {});
    check('cashier is DENIED post (403)', cashPost.status === 403, cashPost.body);
    const postDraft = await call('POST', `/api/order-to-cash/returns/${RET}/post`, manager, {});
    check('even a manager cannot post a DRAFT — approve comes first', postDraft.status >= 400, postDraft.body);
    check('  …and it is still draft', (await retStatus(RET)) === 'draft');
    // cancel used to be guarded by returns.create, so a cashier could cancel a
    // return a manager had already approved.
    const cashCancel = await call('POST', `/api/order-to-cash/returns/${RET}/cancel`, cashier, {});
    check('cashier is DENIED cancel (403) — it was allowed via returns.create', cashCancel.status === 403, cashCancel.body);
    check('  …and the return genuinely still exists as draft', (await retStatus(RET)) === 'draft');
    const [capRow] = await db.query("SELECT COUNT(*) c FROM role_permissions WHERE role='cashier' AND permission_id='returns.cancel'");
    check('  …the server does not grant cashier returns.cancel (UI mirrors this)', Number(capRow[0].c) === 0);

    // ── approve → post ───────────────────────────────────────────────────────
    console.log('\n▶ approve → post (manager)');
    const bunBefore = await stockOf(WH, BUN);
    const pattyBefore = await stockOf(WH2, PATTY);
    const potatoBefore = await stockOf(WH, POTATO);
    const cogsBefore = await journalsRef('SalesReturnCOGS');

    const appr = await call('POST', `/api/order-to-cash/returns/${RET}/approve`, manager, {});
    check('manager CAN approve (returns.approve)', appr.status === 200, appr.body);
    check('  …status is approved', (await retStatus(RET)) === 'approved');
    check('approve alone moves NO stock', (await stockOf(WH, BUN)) === bunBefore);

    const posted = await call('POST', `/api/order-to-cash/returns/${RET}/post`, manager, {});
    check('manager CAN post (returns.post)', posted.status === 200, posted.body);
    check('  …status is posted', (await retStatus(RET)) === 'posted');

    // ── the credit note ──────────────────────────────────────────────────────
    console.log('\n▶ credit note');
    const [ret2] = await db.query('SELECT credit_note_id, journal_id FROM sales_returns WHERE id=?', [RET]);
    const CN = ret2[0].credit_note_id;
    check('a credit note was created', !!CN);
    const [cnl] = await db.query('SELECT * FROM ar_document_lines WHERE document_id=? ORDER BY id', [CN]);
    check('the credit note HAS LINES (every CN ever posted had zero)', cnl.length === 2, cnl.length);
    check('  …CN line net sums to the header net (100)', cnl.reduce((s, l) => s + Number(l.net_amount), 0) === 100);
    check('  …CN lines carry the ORIGINAL revenue account (4100), not a guess', cnl.every((l) => l.revenue_account_code === '4100'), cnl.map((l) => l.revenue_account_code));
    check('  …CN lines have a stable source_line_id (uq_arl_doc_srcline is inert on NULLs)', cnl.every((l) => !!l.source_line_id));

    const [cn] = await db.query('SELECT zatca_uuid, zatca_hash, zatca_status, zatca_qr_base64, document_type FROM ar_documents WHERE id=?', [CN]);
    check('the credit note is ZATCA-STAMPED: uuid present (was always NULL)', !!cn[0].zatca_uuid, cn[0].zatca_uuid);
    check('  …hash present', !!cn[0].zatca_hash);
    check('  …a real Phase-1 QR is persisted and decodes as TLV tag 1', (() => {
      if (!cn[0].zatca_qr_base64) return false;
      const b = Buffer.from(cn[0].zatca_qr_base64, 'base64');
      return b.length > 4 && b[0] === 1;
    })(), cn[0].zatca_qr_base64 && String(cn[0].zatca_qr_base64).slice(0, 24));
    check('  …status is honestly pending, not a green lie', cn[0].zatca_status === 'pending', cn[0].zatca_status);
    check('  …document_type is credit_note (ZATCA 381)', cn[0].document_type === 'credit_note');

    // ── restock = 1 : stock moved EXACTLY once ───────────────────────────────
    console.log('\n▶ restock = 1');
    check(`bun restocked exactly once: ${bunBefore} + 1 = ${bunBefore + 1}`, (await stockOf(WH, BUN)) === bunBefore + 1, await stockOf(WH, BUN));
    check(`patty restocked in its OWN warehouse: ${pattyBefore} + 1`, (await stockOf(WH2, PATTY)) === pattyBefore + 1, await stockOf(WH2, PATTY));
    check('one inventory movement per restocked component', (await movesOf(BUN)) === 1 && (await movesOf(PATTY)) === 1);
    const [mv] = await db.query("SELECT item_name, type, qty FROM inventory_movements WHERE item_id=? AND reference_type='SalesReturn'", [BUN]);
    check('the movement carries a real item_name (the waste bug, not repeated)', !!mv[0] && !!mv[0].item_name, mv[0]);
    check('  …and it is an IN movement of 1', mv[0].type === 'in' && Number(mv[0].qty) === 1, mv[0]);

    // ── restock = 0 : nothing moved, no COGS ─────────────────────────────────
    console.log('\n▶ restock = 0');
    check('potato stock is UNCHANGED — a no_restock line touches no stock', (await stockOf(WH, POTATO)) === potatoBefore, await stockOf(WH, POTATO));
    check('  …and wrote NO inventory movement at all', (await movesOf(POTATO)) === 0);

    // ── the GL ───────────────────────────────────────────────────────────────
    console.log('\n▶ GL');
    check('a SalesReturnCOGS journal was posted (there had NEVER been one)', (await journalsRef('SalesReturnCOGS')) === cogsBefore + 1);
    const [cogsJ] = await db.query("SELECT id FROM gl_journals WHERE reference_type='SalesReturnCOGS' AND reference_id=?", [RET]);
    const [cogsE] = await db.query('SELECT account_code, debit, credit, warehouse_id FROM gl_entries WHERE journal_id=?', [cogsJ[0].id]);
    const invDr = cogsE.filter((e) => Number(e.debit) > 0);
    const cogsCr = cogsE.filter((e) => Number(e.credit) > 0);
    check('COGS reversal = ONLY what physically returned (5 + 15 = 20), not the document cost 40',
      cogsCr.reduce((s, e) => s + Number(e.credit), 0) === 20, cogsE);
    check('  …inventory debits are SPLIT per warehouse (two legs)', invDr.length === 2, invDr.map((e) => `${e.warehouse_id}:${e.debit}`));
    check('  …and each leg carries its own warehouse dimension', invDr.some((e) => e.warehouse_id === WH) && invDr.some((e) => e.warehouse_id === WH2), invDr.map((e) => e.warehouse_id));
    check('  …the COGS journal balances', cogsE.reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0) === 0);

    const [revE] = await db.query('SELECT account_code, debit, credit FROM gl_entries WHERE journal_id=?', [ret2[0].journal_id]);
    check('revenue reversal debits 4100 by the full net 100', revE.some((e) => e.account_code === '4100' && Number(e.debit) === 100), revE);
    check('  …VAT reversal debits output VAT by 15', revE.some((e) => Number(e.debit) === 15), revE);
    check('  …the revenue journal balances', revE.reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0) === 0);

    // ── double-post ──────────────────────────────────────────────────────────
    console.log('\n▶ double-post');
    const bunAfter = await stockOf(WH, BUN);
    const rePost = await call('POST', `/api/order-to-cash/returns/${RET}/post`, manager, {});
    check('posting an already-posted return is REJECTED', rePost.status >= 400, rePost.body);
    check('  …and stock did NOT move a second time', (await stockOf(WH, BUN)) === bunAfter, await stockOf(WH, BUN));
    check('  …and no second COGS journal appeared', (await journalsRef('SalesReturnCOGS')) === cogsBefore + 1);

    // ── double-return (the remaining qty is bounded by what already went back) ─
    console.log('\n▶ double-return');
    const dbl = await call('POST', '/api/order-to-cash/returns', cashier, mkBody([{ originalLineId: LINE_A, returnQty: 2, restock: true }]));
    check('returning 2 more of a line where 1 of 2 is already returned is REJECTED', dbl.status >= 400, dbl.body);
    const ok2 = await call('POST', '/api/order-to-cash/returns', cashier, mkBody([{ originalLineId: LINE_A, returnQty: 1, restock: true }]));
    check('  …but the remaining 1 IS allowed (a real success, not just a refusal)', ok2.status === 201, ok2.body);

    // The form can only offer the right max if the invoice publishes it. It didn't:
    // the server bounded returns by (sold − returned) and never exposed `returned`,
    // so the form capped at the full sold qty and invited a doomed request.
    const invDetail = await call('GET', `/api/order-to-cash/invoices/${INV}`, manager);
    const aLine = (invDetail.body?.data?.lines || []).find((l) => l.id === LINE_A);
    check('the invoice now publishes returned_qty per line', aLine && aLine.returned_qty != null, aLine && Object.keys(aLine || {}).length);
    check('  …and it equals what really went back (1 + 1 = 2 of 2)', aLine && Number(aLine.returned_qty) === 2, aLine && aLine.returned_qty);
    const bLine = (invDetail.body?.data?.lines || []).find((l) => l.id === LINE_B);
    check('  …the no_restock line still counts as returned (money moved, stock did not)', bLine && Number(bLine.returned_qty) === 2, bLine && bLine.returned_qty);

    // ── reverse ──────────────────────────────────────────────────────────────
    console.log('\n▶ reverse');
    const potatoPreRev = await stockOf(WH, POTATO);
    const rev = await call('POST', `/api/order-to-cash/returns/${RET}/reverse`, manager, {});
    check('manager CAN reverse a posted return', rev.status === 200, rev.body);
    check('  …bun is re-deducted back to where it started', (await stockOf(WH, BUN)) === bunBefore, await stockOf(WH, BUN));
    check('  …patty too', (await stockOf(WH2, PATTY)) === pattyBefore);
    check('  …potato is STILL untouched — reverse cannot un-restock what never restocked', (await stockOf(WH, POTATO)) === potatoPreRev);
    check('the COGS journal was reversed too (value and quantity move together)', (await journalsRef('SalesReturnCOGSReversal')) === 1, await journalsRef('SalesReturnCOGSReversal'));
    const [cnAfter] = await db.query('SELECT status FROM ar_documents WHERE id=?', [CN]);
    check('  …and the credit note is cancelled', cnAfter[0].status === 'cancelled', cnAfter[0]);

    console.log(`\n${fail === 0 ? '✅' : '❌'} salesReturns: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
