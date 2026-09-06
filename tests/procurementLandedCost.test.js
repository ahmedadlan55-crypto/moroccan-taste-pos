#!/usr/bin/env node
'use strict';
/**
 * tests/procurementLandedCost.test.js — landed cost on goods receipts, end to
 * end against the live DB, through the REAL /api/procurement router behind
 * the REAL warehouse-scope middleware.
 *
 * WHAT WAS MISSING
 *   A receipt knew only the supplier's price. Freight, customs, insurance and
 *   handling — the money it takes to get imported goods onto the shelf — went
 *   nowhere near the inventory value, so every WAC, every lot cost and every
 *   later COGS figure understated what the goods actually cost, and the
 *   charge vendors' bills had no accrual to clear.
 *
 * WHAT THIS FILE PINS
 *   1. Charges given at create are allocated over the lines (by value / by
 *      qty), persisted, and sum EXACTLY to the charge total; a receipt with
 *      no charges carries NULL landed fields — never a 0.
 *   2. PUT /:id/charges replaces the whole set while draft/approved; after
 *      post it answers 409 RECEIPT_CHARGES_LOCKED.
 *   3. Post: the LANDED unit cost enters warehouse_stock.avg_cost, the item
 *      cost roll-up and purchase_lots.unit_cost; the journal is Dr Inventory
 *      (landed) / Cr GRNI goods / Cr GRNI charges — two credits, balanced.
 *   4. GET /reports/landed-cost lists POSTED receipts only, with the charge
 *      split by type, uplift_pct, and the accrued/invoiced split; ?format=csv.
 *   5. A charge vendor's invoice line naming receiptChargeId clears GRNI at
 *      the accrued value (Dr GRNI 'تصفية مصاريف استيراد مستحقة' + Input VAT /
 *      Cr AP, PPV for the difference) and flips the charge to 'invoiced'; a
 *      non-stock invoice with a charge line does the same; a receipt whose
 *      charges are invoiced cannot be reversed; a credit note releases them;
 *      a reversal then mirrors the landed values back out.
 */

process.env.PROCUREMENT_P2P_ENABLE = '1';
process.env.WAREHOUSE_SCOPE_ENFORCE = '1';

const express = require('express');
const db = require('../db/connection');
const { loadWarehouseScope } = require('../middleware/warehouseScope');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve().then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const num = (v) => Math.round(Number(v) * 10000) / 10000;
const brief = (j) => JSON.stringify(j).slice(0, 220);

// ── fixtures (prefix LC-) ─────────────────────────────────────────────────────
const WH = 'WH-LC-MAIN', WH_OTHER = 'WH-LC-OTHER';
const ITEM1 = 'LC-ITEM-1', ITEM2 = 'LC-ITEM-2';
const SUP_GOODS = 'SUP-LC-GOODS', SUP_FREIGHT = 'SUP-LC-FREIGHT', SUP_CUSTOMS = 'SUP-LC-CUSTOMS';
const SUPPLIERS = [SUP_GOODS, SUP_FREIGHT, SUP_CUSTOMS];
const MAKER = { id: 990701, username: 'lc_maker', role: 'admin' };
const CHECKER = { id: 990702, username: 'lc_checker', role: 'admin' };
const RUN = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: Number(req.headers['x-test-uid']), username: String(req.headers['x-test-user']), role: String(req.headers['x-test-role']) };
    next();
  });
  app.use('/api/procurement', loadWarehouseScope);
  app.use('/api/procurement', require('../routes/procurement'));
  return app;
}

async function seed() {
  // The additive procurement schema (purchase_receipt_charges + the landed_*
  // columns of 0045) is what the release chain applies; a test that boots only
  // the router has to apply it the same way.
  await require('../db/migrations/procurement/schema').apply(db, () => {});
  for (const [id, code, name] of [[WH, 'LCM', 'مستودع التكلفة الواصلة'], [WH_OTHER, 'LCO', 'مستودع آخر']]) {
    await db.query('INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name), is_active=1', [id, code, name]);
  }
  for (const [id, name] of [[ITEM1, 'صنف مستورد ١'], [ITEM2, 'صنف مستورد ٢']]) {
    await db.query("INSERT INTO inv_items (id,name,kind,unit,cost,stock,tracking_mode) VALUES (?,?,?,?,0,0,'none') ON DUPLICATE KEY UPDATE name=VALUES(name), stock=0, cost=0",
      [id, name, 'raw', 'حبة']);
  }
  for (const [id, name] of [[SUP_GOODS, 'مورد البضاعة'], [SUP_FREIGHT, 'مورد الشحن'], [SUP_CUSTOMS, 'مخلّص جمركي']]) {
    await db.query('INSERT INTO suppliers (id, name, is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name), is_active=1', [id, name]);
  }
  for (const u of [MAKER, CHECKER]) {
    await db.query('INSERT INTO users (id, username, password, role, active) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE role=VALUES(role), active=1',
      [u.id, u.username, 'x', u.role]);
  }
}

async function cleanup() {
  const marks = SUPPLIERS.map(() => '?').join(',');
  // GL first (keyed off rows deleted below), then children, then parents.
  await db.query(`DELETE ge FROM gl_entries ge JOIN gl_journals gj ON gj.id=ge.journal_id WHERE gj.reference_id IN (SELECT id FROM purchase_receipts WHERE supplier_id IN (${marks}))`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE FROM gl_journals WHERE reference_id IN (SELECT id FROM purchase_receipts WHERE supplier_id IN (${marks}))`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE ge FROM gl_entries ge JOIN gl_journals gj ON gj.id=ge.journal_id WHERE gj.reference_id IN (SELECT id FROM supplier_invoices WHERE supplier_id IN (${marks}))`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE FROM gl_journals WHERE reference_id IN (SELECT id FROM supplier_invoices WHERE supplier_id IN (${marks}))`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE e FROM procurement_events e JOIN supplier_invoices si ON si.id=e.document_id WHERE si.supplier_id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE sim FROM supplier_invoice_matches sim JOIN supplier_invoices si ON si.id=sim.invoice_id WHERE si.supplier_id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE sil FROM supplier_invoice_lines sil JOIN supplier_invoices si ON si.id=sil.invoice_id WHERE si.supplier_id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE FROM supplier_invoices WHERE supplier_id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE e FROM procurement_events e JOIN purchase_receipts pr ON pr.id=e.document_id WHERE pr.supplier_id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE c FROM purchase_receipt_charges c JOIN purchase_receipts pr ON pr.id=c.receipt_id WHERE pr.supplier_id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE prl FROM purchase_receipt_lines prl JOIN purchase_receipts pr ON pr.id=prl.receipt_id WHERE pr.supplier_id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query(`DELETE FROM purchase_receipts WHERE supplier_id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query('DELETE FROM inventory_movements WHERE item_id IN (?,?) OR warehouse_id IN (?,?)', [ITEM1, ITEM2, WH, WH_OTHER]).catch(() => {});
  await db.query('DELETE FROM inventory_cost_history WHERE item_id IN (?,?)', [ITEM1, ITEM2]).catch(() => {});
  await db.query('DELETE FROM item_cost_history WHERE item_id IN (?,?)', [ITEM1, ITEM2]).catch(() => {});
  await db.query('DELETE FROM warehouse_stock WHERE item_id IN (?,?)', [ITEM1, ITEM2]).catch(() => {});
  await db.query('DELETE FROM purchase_lots WHERE inv_item_id IN (?,?)', [ITEM1, ITEM2]).catch(() => {});
  await db.query('DELETE FROM inv_items WHERE id IN (?,?)', [ITEM1, ITEM2]).catch(() => {});
  await db.query(`DELETE FROM suppliers WHERE id IN (${marks})`, SUPPLIERS).catch(() => {});
  await db.query('DELETE FROM warehouses WHERE id IN (?,?)', [WH, WH_OTHER]).catch(() => {});
  for (const u of [MAKER, CHECKER]) await db.query('DELETE FROM users WHERE id=?', [u.id]).catch(() => {});
}

async function main() {
  await cleanup();
  await seed();
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, body, u) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-uid': String(u.id), 'x-test-user': u.username, 'x-test-role': u.role },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) { /* csv */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const lineOf = (receipt, itemId) => receipt.lines.find((l) => l.item_id === itemId);
  const entriesOf = async (journalId) => (await db.query('SELECT account_code, debit, credit, description FROM gl_entries WHERE journal_id = ?', [journalId]))[0];
  const journalOf = async (journalId) => (await db.query('SELECT total_debit, total_credit FROM gl_journals WHERE id = ?', [journalId]))[0][0];
  const reportRow = async (receiptId, extra = '') => {
    const r = await call('GET', `/api/procurement/reports/landed-cost?from=${TODAY}&to=${TODAY}&supplierId=${SUP_GOODS}${extra}`, null, CHECKER);
    eq(r.status, 200, 'report ' + brief(r.json));
    return { r, row: r.json.data.find((x) => x.receipt_id === receiptId) };
  };
  const GOODS_LINES = [
    { itemId: ITEM1, enteredQty: 10, unitCost: 30 },   // 300
    { itemId: ITEM2, enteredQty: 10, unitCost: 10 },   // 100
  ];

  try {
    // ── 1. charges at create ─────────────────────────────────────────────
    console.log('\n1. charges given at create are allocated, persisted and sum exactly');
    let grnId;
    await test('create: 2 lines + freight 100 by value → 33.33% uplift spread 75 / 25', async () => {
      const r = await call('POST', '/api/procurement/receipts', {
        supplierId: SUP_GOODS, warehouseId: WH, receiptDate: TODAY, lines: GOODS_LINES,
        charges: [{ chargeType: 'freight', description: 'شحن بحري', supplierId: SUP_FREIGHT, amount: 100, vatAmount: 15, allocationMethod: 'value' }],
      }, MAKER);
      eq(r.status, 201, 'create ' + brief(r.json));
      grnId = r.json.data.id;
      const g = await call('GET', `/api/procurement/receipts/${grnId}`, null, MAKER);
      eq(g.status, 200);
      const d = g.json.data;
      eq(d.charges.length, 1, 'one charge');
      eq(d.charges[0].chargeType, 'freight');
      eq(d.charges[0].status, 'accrued');
      eq(d.charges[0].supplierName, 'مورد الشحن', 'vendor name frozen on the charge');
      eq(d.charges[0].supplierInvoiceId, null);
      eq(num(d.chargesTotal), 100);
      eq(num(d.landedTotal), 500, 'subtotal 400 + charges 100');
      eq(num(lineOf(d, ITEM1).landedChargeAmount), 75);
      eq(num(lineOf(d, ITEM2).landedChargeAmount), 25);
      eq(num(lineOf(d, ITEM1).landedUnitCost), 37.5, '(300 + 75) / 10');
      eq(num(lineOf(d, ITEM2).landedUnitCost), 12.5, '(100 + 25) / 10');
      eq(num(d.lines.reduce((s, l) => s + l.landedChargeAmount, 0)), num(d.chargesTotal), 'Σ line shares == charges total');
      const [[hdr]] = await db.query('SELECT charges_total, landed_total FROM purchase_receipts WHERE id=?', [grnId]);
      eq(num(hdr.charges_total), 100, 'header charges_total persisted');
      eq(num(hdr.landed_total), 500, 'header landed_total persisted');
      const [rows] = await db.query('SELECT landed_charge_amount, landed_unit_cost FROM purchase_receipt_lines WHERE receipt_id=?', [grnId]);
      eq(rows.length, 2);
      ok(rows.every((x) => x.landed_charge_amount != null && x.landed_unit_cost != null), 'line landed_* columns persisted');
    });
    await test('a malformed charge is a 422 before anything is written', async () => {
      const [[before]] = await db.query('SELECT COUNT(*) AS c FROM purchase_receipts WHERE supplier_id=?', [SUP_GOODS]);
      let r = await call('POST', '/api/procurement/receipts', { supplierId: SUP_GOODS, warehouseId: WH, lines: GOODS_LINES, charges: [{ chargeType: 'teleport', amount: 5 }] }, MAKER);
      eq(r.status, 422, 'unknown type ' + brief(r.json));
      eq(r.json.code, 'VALIDATION_ERROR');
      r = await call('POST', '/api/procurement/receipts', { supplierId: SUP_GOODS, warehouseId: WH, lines: GOODS_LINES, charges: [{ chargeType: 'freight', amount: 0 }] }, MAKER);
      eq(r.status, 422, 'zero amount');
      r = await call('POST', '/api/procurement/receipts', { supplierId: SUP_GOODS, warehouseId: WH, lines: GOODS_LINES, charges: [{ chargeType: 'freight', amount: 10, supplierId: 'SUP-LC-NOPE' }] }, MAKER);
      eq(r.status, 422, 'unknown charge vendor');
      const [[after]] = await db.query('SELECT COUNT(*) AS c FROM purchase_receipts WHERE supplier_id=?', [SUP_GOODS]);
      eq(Number(after.c), Number(before.c), 'nothing written');
    });

    // ── 2. PUT replaces ──────────────────────────────────────────────────
    console.log('\n2. PUT /:id/charges replaces the whole set');
    await test('freight 100 by value + customs 60 by qty → 105 / 55, landed 40.5 / 15.5', async () => {
      const r = await call('PUT', `/api/procurement/receipts/${grnId}/charges`, {
        charges: [
          { chargeType: 'freight', supplierId: SUP_FREIGHT, amount: 100, vatAmount: 15, allocationMethod: 'value' },
          { chargeType: 'customs', supplierId: SUP_CUSTOMS, amount: 60, vatAmount: 0, allocationMethod: 'qty' },
        ],
      }, MAKER);
      eq(r.status, 200, 'put ' + brief(r.json));
      const d = r.json.data;
      eq(d.charges.length, 2, 'the old set is gone, the new one is in');
      eq(num(d.chargesTotal), 160);
      eq(num(d.landedTotal), 560);
      eq(num(lineOf(d, ITEM1).landedChargeAmount), 105, '75 by value + 30 by qty');
      eq(num(lineOf(d, ITEM2).landedChargeAmount), 55, '25 by value + 30 by qty');
      eq(num(lineOf(d, ITEM1).landedUnitCost), 40.5);
      eq(num(lineOf(d, ITEM2).landedUnitCost), 15.5);
      const [[cnt]] = await db.query('SELECT COUNT(*) AS c FROM purchase_receipt_charges WHERE receipt_id=?', [grnId]);
      eq(Number(cnt.c), 2, 'exactly the new rows');
    });
    await test('PUT with an empty list clears the charges and the landed fields go back to NULL', async () => {
      const r = await call('PUT', `/api/procurement/receipts/${grnId}/charges`, { charges: [] }, MAKER);
      eq(r.status, 200, brief(r.json));
      eq(r.json.data.charges.length, 0);
      eq(r.json.data.chargesTotal, 0);
      eq(num(r.json.data.landedTotal), 400, 'landed == subtotal');
      eq(lineOf(r.json.data, ITEM1).landedChargeAmount, null, 'null, not 0');
      eq(lineOf(r.json.data, ITEM1).landedUnitCost, null, 'null, not the base cost');
      const [[hdr]] = await db.query('SELECT landed_total FROM purchase_receipts WHERE id=?', [grnId]);
      eq(hdr.landed_total, null, 'header landed_total NULL without charges');
      // put the real set back for the rest of the file
      const again = await call('PUT', `/api/procurement/receipts/${grnId}/charges`, {
        charges: [
          { chargeType: 'freight', supplierId: SUP_FREIGHT, amount: 100, vatAmount: 15, allocationMethod: 'value' },
          { chargeType: 'customs', supplierId: SUP_CUSTOMS, amount: 60, vatAmount: 0, allocationMethod: 'qty' },
        ],
      }, MAKER);
      eq(again.status, 200);
    });

    // ── 3. post ──────────────────────────────────────────────────────────
    console.log('\n3. post: the landed cost enters WAC, the lot, the item roll-up and the GL');
    let grnJournal;
    await test('approve → post answers with one balanced journal and the landed value', async () => {
      const a = await call('POST', `/api/procurement/receipts/${grnId}/approve`, {}, CHECKER);
      eq(a.status, 200, 'approve ' + brief(a.json));
      const p = await call('POST', `/api/procurement/receipts/${grnId}/post`, {}, CHECKER);
      eq(p.status, 200, 'post ' + brief(p.json));
      eq(p.json.status, 'posted');
      eq(p.json.journalIds.length, 1);
      grnJournal = p.json.journalIds[0];
      eq(num(p.json.affectedValue), 560, 'affectedValue is the LANDED value');
      const j = await journalOf(grnJournal);
      eq(num(j.total_debit), 560);
      eq(num(j.total_credit), 560);
    });
    await test('warehouse_stock.avg_cost / last_cost are the LANDED unit cost', async () => {
      const [[w1]] = await db.query('SELECT qty, avg_cost, last_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, ITEM1]);
      const [[w2]] = await db.query('SELECT qty, avg_cost, last_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, ITEM2]);
      eq(num(w1.qty), 10); eq(num(w1.avg_cost), 40.5); eq(num(w1.last_cost), 40.5);
      eq(num(w2.qty), 10); eq(num(w2.avg_cost), 15.5); eq(num(w2.last_cost), 15.5);
    });
    await test('purchase_lots.unit_cost and inv_items.cost are landed', async () => {
      const [[l1]] = await db.query('SELECT unit_cost FROM purchase_lots WHERE inv_item_id=? AND warehouse_id=? ORDER BY id DESC LIMIT 1', [ITEM1, WH]);
      const [[l2]] = await db.query('SELECT unit_cost FROM purchase_lots WHERE inv_item_id=? AND warehouse_id=? ORDER BY id DESC LIMIT 1', [ITEM2, WH]);
      eq(num(l1.unit_cost), 40.5); eq(num(l2.unit_cost), 15.5);
      const [[i1]] = await db.query('SELECT cost FROM inv_items WHERE id=?', [ITEM1]);
      eq(num(i1.cost), 40.5, 'item roll-up (single warehouse) = landed');
    });
    await test('journal: Dr Inventory 560 / Cr GRNI 400 (goods) / Cr GRNI 160 (charges, its own entry)', async () => {
      const e = await entriesOf(grnJournal);
      const inv = e.filter((x) => x.account_code === '1200');
      eq(num(inv.reduce((s, x) => s + Number(x.debit), 0)), 560, 'inventory debited the landed value');
      const grni = e.filter((x) => x.account_code === '2150' && Number(x.credit) > 0);
      eq(grni.length, 2, 'TWO GRNI credits');
      const goods = grni.find((x) => x.description === 'بضاعة مستلمة لم تُفوتر');
      const charges = grni.find((x) => x.description === 'مصاريف استيراد مستحقة');
      ok(goods && charges, 'each credit named: ' + JSON.stringify(grni.map((x) => x.description)));
      eq(num(goods.credit), 400); eq(num(charges.credit), 160);
      const [[hdr]] = await db.query('SELECT subtotal, charges_total, landed_total, status FROM purchase_receipts WHERE id=?', [grnId]);
      eq(hdr.status, 'posted'); eq(num(hdr.subtotal), 400); eq(num(hdr.charges_total), 160); eq(num(hdr.landed_total), 560);
    });
    await test('PUT charges after post → 409 RECEIPT_CHARGES_LOCKED', async () => {
      const r = await call('PUT', `/api/procurement/receipts/${grnId}/charges`, { charges: [{ chargeType: 'other', amount: 1 }] }, MAKER);
      eq(r.status, 409, brief(r.json));
      eq(r.json.code, 'RECEIPT_CHARGES_LOCKED');
      eq(r.json.success, false);
      const [[cnt]] = await db.query('SELECT COUNT(*) AS c FROM purchase_receipt_charges WHERE receipt_id=?', [grnId]);
      eq(Number(cnt.c), 2, 'the posted set is untouched');
    });

    // ── 4. the report ────────────────────────────────────────────────────
    console.log('\n4. GET /reports/landed-cost');
    let draftId;
    await test('a posted receipt is one row: goods 400, freight 100, customs 60, uplift 40%, all accrued', async () => {
      const { r, row } = await reportRow(grnId);
      ok(row, 'row for the posted receipt');
      eq(num(row.goods_value), 400); eq(num(row.freight), 100); eq(num(row.customs), 60);
      eq(num(row.insurance), 0); eq(num(row.handling), 0); eq(num(row.other), 0);
      eq(num(row.charges_total), 160); eq(num(row.landed_total), 560); eq(row.uplift_pct, 40);
      eq(num(row.charges_accrued), 160); eq(num(row.charges_invoiced), 0); eq(row.lines, 2);
      eq(row.receipt_date, TODAY); eq(row.supplier_name, 'مورد البضاعة'); eq(row.warehouse_name, 'مستودع التكلفة الواصلة');
      ok(row.receipt_number, 'receipt_number');
      const t = r.json.totals;
      eq(t.receipts, 1, 'totals over the supplier filter'); eq(num(t.goods_value), 400); eq(num(t.charges_total), 160);
      eq(num(t.landed_total), 560); eq(t.uplift_pct, 40); eq(num(t.charges_accrued), 160); eq(num(t.charges_invoiced), 0);
      ok(r.json.basis && /subtotal/.test(r.json.basis.goods_value), 'the report names its basis');
      eq(r.json.snapshot.complete, true);
    });
    await test('a DRAFT receipt with charges is NOT a row; a warehouse filter that misses is empty', async () => {
      const c = await call('POST', '/api/procurement/receipts', {
        supplierId: SUP_GOODS, warehouseId: WH, receiptDate: TODAY, lines: GOODS_LINES,
        charges: [{ chargeType: 'insurance', amount: 20 }],
      }, MAKER);
      eq(c.status, 201, brief(c.json));
      draftId = c.json.data.id;
      const { r } = await reportRow(grnId);
      eq(r.json.data.length, 1, 'still one row');
      const other = await call('GET', `/api/procurement/reports/landed-cost?from=${TODAY}&to=${TODAY}&supplierId=${SUP_GOODS}&warehouseId=${WH_OTHER}`, null, CHECKER);
      eq(other.status, 200); eq(other.json.data.length, 0);
    });
    await test('?format=csv is a BOM-prefixed CSV with the Arabic header and the receipt', async () => {
      // Raw bytes: fetch's text() strips a leading BOM per spec, so the BOM
      // the CSV contract promises Excel has to be checked on the wire.
      const res = await fetch(base + `/api/procurement/reports/landed-cost?from=${TODAY}&to=${TODAY}&supplierId=${SUP_GOODS}&format=csv`,
        { headers: { 'x-test-uid': String(CHECKER.id), 'x-test-user': CHECKER.username, 'x-test-role': CHECKER.role } });
      eq(res.status, 200);
      ok(/text\/csv/.test(String(res.headers.get('content-type'))), 'content-type ' + res.headers.get('content-type'));
      const bytes = Buffer.from(await res.arrayBuffer());
      eq(bytes.slice(0, 3).toString('hex'), 'efbbbf', 'UTF-8 BOM on the wire');
      const text = bytes.toString('utf8');
      ok(/نسبة الزيادة/.test(text), 'Arabic header');
      ok(/مورد البضاعة/.test(text) && /560/.test(text), 'the row');
      const en = await call('GET', `/api/procurement/reports/landed-cost?from=${TODAY}&to=${TODAY}&supplierId=${SUP_GOODS}&format=csv&lang=en`, null, CHECKER);
      ok(/Landed total/.test(en.text), 'English header on lang=en');
    });
    await test('a bad date is a 422, not a guess', async () => {
      const r = await call('GET', '/api/procurement/reports/landed-cost?from=2026-13-01', null, CHECKER);
      eq(r.status, 422, brief(r.json));
    });

    // ── 5. the charge vendor's invoice ───────────────────────────────────
    console.log('\n5. a charge vendor invoice clears the accrual');
    let freightChargeId, customsChargeId, draftChargeId, freightInv, customsInv;
    await test('receiptChargeId is vetted at create: unknown / unposted receipt / duplicate line', async () => {
      const [ch] = await db.query('SELECT id, charge_type FROM purchase_receipt_charges WHERE receipt_id=?', [grnId]);
      freightChargeId = ch.find((c) => c.charge_type === 'freight').id;
      customsChargeId = ch.find((c) => c.charge_type === 'customs').id;
      draftChargeId = (await db.query('SELECT id FROM purchase_receipt_charges WHERE receipt_id=?', [draftId]))[0][0].id;
      const mk = (chargeId, extra) => Object.assign({
        supplierId: SUP_FREIGHT, invoiceNo: 'LC-BAD-' + RUN + '-' + Math.random().toString(36).slice(2, 6), warehouseId: WH,
        lines: [{ description: 'شحن', enteredQty: 1, unitPriceEntered: 100, vatRate: 15, receiptChargeId: chargeId }],
      }, extra || {});
      let r = await call('POST', '/api/procurement/invoices', mk('GRC-LC-NOPE'), MAKER);
      eq(r.status, 422, 'unknown charge ' + brief(r.json));
      r = await call('POST', '/api/procurement/invoices', mk(draftChargeId), MAKER);
      eq(r.status, 422, 'charge on a DRAFT receipt ' + brief(r.json));
      r = await call('POST', '/api/procurement/invoices', mk(freightChargeId, {
        lines: [
          { description: 'شحن', enteredQty: 1, unitPriceEntered: 50, vatRate: 15, receiptChargeId: freightChargeId },
          { description: 'شحن', enteredQty: 1, unitPriceEntered: 50, vatRate: 15, receiptChargeId: freightChargeId },
        ],
      }), MAKER);
      eq(r.status, 422, 'same charge twice on one invoice ' + brief(r.json));
      const [[cnt]] = await db.query('SELECT COUNT(*) AS c FROM supplier_invoices WHERE supplier_id=?', [SUP_FREIGHT]);
      eq(Number(cnt.c), 0, 'nothing written');
    });
    await test('freight invoice 100 + VAT 15 (stock kind): Dr GRNI 100 "تصفية مصاريف استيراد مستحقة" + VAT 15 / Cr AP 115', async () => {
      const c = await call('POST', '/api/procurement/invoices', {
        supplierId: SUP_FREIGHT, invoiceNo: 'LC-FR-' + RUN, invoiceKind: 'stock', warehouseId: WH, issueDate: TODAY,
        lines: [{ description: 'شحن بحري', enteredQty: 1, unitPriceEntered: 100, vatRate: 15, receiptChargeId: freightChargeId }],
      }, MAKER);
      eq(c.status, 201, 'create ' + brief(c.json));
      freightInv = c.json.data.id;
      const [[line]] = await db.query('SELECT receipt_charge_id FROM supplier_invoice_lines WHERE invoice_id=?', [freightInv]);
      eq(line.receipt_charge_id, freightChargeId, 'receipt_charge_id stored');
      // a second live invoice naming the same accrual is refused
      const dup = await call('POST', '/api/procurement/invoices', {
        supplierId: SUP_FREIGHT, invoiceNo: 'LC-FR-DUP-' + RUN, warehouseId: WH,
        lines: [{ description: 'شحن', enteredQty: 1, unitPriceEntered: 100, vatRate: 15, receiptChargeId: freightChargeId }],
      }, MAKER);
      eq(dup.status, 409, 'claimed by another invoice ' + brief(dup.json));
      eq((await call('POST', `/api/procurement/invoices/${freightInv}/submit`, {}, MAKER)).status, 200, 'submit');
      const a = await call('POST', `/api/procurement/invoices/${freightInv}/approve`, {}, CHECKER);
      eq(a.status, 200, 'approve ' + brief(a.json));
      const e = await entriesOf(a.json.journalIds[0]);
      const grniDr = e.filter((x) => x.account_code === '2150' && Number(x.debit) > 0);
      eq(grniDr.length, 1, 'ONE GRNI debit (no goods line on a pure charge invoice)');
      eq(num(grniDr[0].debit), 100, 'Dr GRNI = the ACCRUED 100');
      eq(grniDr[0].description, 'تصفية مصاريف استيراد مستحقة');
      eq(num(e.filter((x) => x.account_code === '1290').reduce((s, x) => s + Number(x.debit), 0)), 15, 'input VAT 15');
      eq(num(e.filter((x) => x.account_code === '2100').reduce((s, x) => s + Number(x.credit), 0)), 115, 'AP 115');
      eq(e.filter((x) => x.account_code === '5350').length, 0, 'no PPV when billed == accrued');
      const j = await journalOf(a.json.journalIds[0]);
      eq(num(j.total_debit), num(j.total_credit), 'balanced');
      const [[ch]] = await db.query('SELECT status, supplier_invoice_id FROM purchase_receipt_charges WHERE id=?', [freightChargeId]);
      eq(ch.status, 'invoiced'); eq(ch.supplier_invoice_id, freightInv);
      const g = await call('GET', `/api/procurement/receipts/${grnId}`, null, MAKER);
      const fr = g.json.data.charges.find((x) => x.id === freightChargeId);
      eq(fr.status, 'invoiced'); eq(fr.supplierInvoiceId, freightInv);
    });
    await test('the report moves 100 from accrued to invoiced', async () => {
      const { row } = await reportRow(grnId);
      eq(num(row.charges_invoiced), 100); eq(num(row.charges_accrued), 60); eq(num(row.charges_total), 160);
    });
    await test('customs invoice billed 66 for an accrual of 60 (NON-stock kind): Dr GRNI 60 + PPV 6 / Cr AP 75.9', async () => {
      const c = await call('POST', '/api/procurement/invoices', {
        supplierId: SUP_CUSTOMS, invoiceNo: 'LC-CU-' + RUN, invoiceKind: 'non_stock', warehouseId: WH, issueDate: TODAY,
        lines: [{ description: 'رسوم جمركية', enteredQty: 1, unitPriceEntered: 66, vatRate: 15, receiptChargeId: customsChargeId }],
      }, MAKER);
      eq(c.status, 201, 'create ' + brief(c.json));
      customsInv = c.json.data.id;
      eq((await call('POST', `/api/procurement/invoices/${customsInv}/submit`, {}, MAKER)).status, 200, 'submit');
      const a = await call('POST', `/api/procurement/invoices/${customsInv}/approve`, {}, CHECKER);
      eq(a.status, 200, 'approve ' + brief(a.json));
      const e = await entriesOf(a.json.journalIds[0]);
      eq(num(e.filter((x) => x.account_code === '2150').reduce((s, x) => s + Number(x.debit), 0)), 60, 'GRNI cleared at the ACCRUED 60');
      eq(num(e.filter((x) => x.account_code === '5350').reduce((s, x) => s + Number(x.debit), 0)), 6, 'PPV 6');
      eq(num(e.filter((x) => x.account_code === '2100').reduce((s, x) => s + Number(x.credit), 0)), 75.9, 'AP 66 + 9.9');
      ok(!e.some((x) => x.description === 'مصروف/أصل'), 'no expense line — the charge is not an expense');
      const j = await journalOf(a.json.journalIds[0]);
      eq(num(j.total_debit), num(j.total_credit), 'balanced');
      const { row } = await reportRow(grnId);
      eq(num(row.charges_invoiced), 160); eq(num(row.charges_accrued), 0);
    });
    await test('a receipt whose charges are invoiced cannot be reversed (409 DOCUMENT_HAS_HISTORY)', async () => {
      const r = await call('POST', `/api/procurement/receipts/${grnId}/reverse`, {}, CHECKER);
      eq(r.status, 409, brief(r.json));
      eq(r.json.code, 'DOCUMENT_HAS_HISTORY');
    });
    await test('a credit note releases the accrual (status back to accrued, no invoice)', async () => {
      for (const id of [freightInv, customsInv]) {
        const r = await call('POST', `/api/procurement/invoices/${id}/credit-note`, {}, CHECKER);
        eq(r.status, 200, 'credit note ' + brief(r.json));
      }
      const [rows] = await db.query('SELECT status, supplier_invoice_id FROM purchase_receipt_charges WHERE receipt_id=?', [grnId]);
      ok(rows.every((x) => x.status === 'accrued' && x.supplier_invoice_id == null), JSON.stringify(rows));
      const { row } = await reportRow(grnId);
      eq(num(row.charges_accrued), 160); eq(num(row.charges_invoiced), 0);
    });
    await test('reversal mirrors the landed values back out of stock and the GL', async () => {
      const r = await call('POST', `/api/procurement/receipts/${grnId}/reverse`, {}, CHECKER);
      eq(r.status, 200, brief(r.json));
      eq(r.json.journalIds.length, 1);
      const e = await entriesOf(r.json.journalIds[0]);
      eq(num(e.filter((x) => x.account_code === '1200').reduce((s, x) => s + Number(x.credit), 0)), 560, 'inventory credited the landed value');
      eq(num(e.filter((x) => x.account_code === '2150').reduce((s, x) => s + Number(x.debit), 0)), 560, 'GRNI debited goods + charges');
      const [[w1]] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, ITEM1]);
      eq(num(w1.qty), 0, 'stock back to 0');
      const { row } = await reportRow(grnId);
      eq(row, undefined, 'a reversed receipt is no longer a landed-cost row');
    });

    // ── 6. no charges is NULL, not zero ──────────────────────────────────
    console.log('\n6. a receipt with no charges');
    await test('null landed fields, one GRNI credit, avg_cost = the supplier price', async () => {
      const c = await call('POST', '/api/procurement/receipts', { supplierId: SUP_GOODS, warehouseId: WH, receiptDate: TODAY, lines: GOODS_LINES }, MAKER);
      eq(c.status, 201, brief(c.json));
      const id = c.json.data.id;
      const g = await call('GET', `/api/procurement/receipts/${id}`, null, MAKER);
      eq(g.json.data.charges.length, 0); eq(g.json.data.chargesTotal, 0); eq(num(g.json.data.landedTotal), 400);
      eq(lineOf(g.json.data, ITEM1).landedChargeAmount, null); eq(lineOf(g.json.data, ITEM1).landedUnitCost, null);
      eq((await call('POST', `/api/procurement/receipts/${id}/approve`, {}, CHECKER)).status, 200);
      const p = await call('POST', `/api/procurement/receipts/${id}/post`, {}, CHECKER);
      eq(p.status, 200, brief(p.json));
      const e = await entriesOf(p.json.journalIds[0]);
      eq(e.filter((x) => x.account_code === '2150').length, 1, 'ONE GRNI credit');
      eq(num(e.filter((x) => x.account_code === '1200').reduce((s, x) => s + Number(x.debit), 0)), 400);
      const [[w1]] = await db.query('SELECT avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, ITEM1]);
      eq(num(w1.avg_cost), 30, 'no charges → the supplier price IS the landed price');
      const { row } = await reportRow(id);
      ok(row, 'row'); eq(num(row.charges_total), 0); eq(num(row.landed_total), 400); eq(row.uplift_pct, 0); eq(num(row.charges_accrued), 0);
    });
  } finally {
    server.close();
    await cleanup();
    await db.end?.().catch?.(() => {});
  }

  console.log(`\n${_passed}/${_total} passed${_failed ? `, ${_failed} failed` : ''}`);
  if (_failed) process.exit(1);
  console.log('  ✅ landed cost: exact allocation, locked after post, landed WAC/lot/GL, report split, charge invoices clear GRNI');
  process.exit(0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
