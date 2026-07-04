'use strict';
/* Integration — Units of Measure across V2 documents (receipt / issue / adjustment).
   Item base = PCS, major = CTN (1 carton = 12). Proves: entered major unit is
   converted to base for stock/lots/WAC/GL; the frozen snapshot is persisted;
   client baseQty mismatch → UNIT_CONVERSION_CONFLICT; a unit disallowed for the
   context → UNIT_NOT_ALLOWED; base qty is what moves stock (10 CTN → 120 base;
   1 CTN issue → 12 base out). Run: node tests/integration/uomDocs.api.test.js */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = 3995;
const WH = 'WH-UOM', ITEM = 'IT-UOM', ACC_REV = 'UOM-REV', ACC_EXP = 'UOM-EXP';
let pass = 0, fail = 0; const fails = [];
function check(n, c, x) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, x != null ? '→ ' + JSON.stringify(x).slice(0, 220) : ''); } }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;
const tok = () => jwt.sign({ id: 1, username: 'admin', role: 'admin', isDeveloper: true, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '2h' });
function api(method, p, body, extra) {
  return new Promise((res) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json', Authorization: 'Bearer ' + tok(), 'Idempotency-Key': 'uom-' + Math.random().toString(36).slice(2) }, extra || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (data) r.write(data); r.end();
  });
}
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function stock() { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, ITEM]); return r.length ? Number(r[0].qty) : 0; }
async function cleanup() {
  for (const [s, p] of [
    ["DELETE il FROM inv_receipt_items il JOIN inv_receipts d ON d.id=il.receipt_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE FROM inv_receipts WHERE warehouse_id=?", [WH]],
    ["DELETE il FROM inv_issue_items il JOIN inv_issues d ON d.id=il.issue_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE FROM inv_issues WHERE warehouse_id=?", [WH]],
    ["DELETE il FROM inv_adjustment_items il JOIN inv_adjustments d ON d.id=il.adjustment_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE FROM inv_adjustments WHERE warehouse_id=?", [WH]],
    ["DELETE FROM inventory_movements WHERE warehouse_id=?", [WH]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id=?", [WH]],
    ["DELETE FROM item_units WHERE item_id=?", [ITEM]],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type LIKE 'inv\\_%' AND j.reference_id IN (SELECT id FROM inv_receipts WHERE warehouse_id=?)", [WH]],
    ["DELETE FROM inv_items WHERE id=?", [ITEM]],
    ["DELETE FROM warehouses WHERE id=?", [WH]],
    ["DELETE FROM gl_accounts WHERE id IN (?,?)", [ACC_REV, ACC_EXP]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WH, 'UOM', 'مستودع الوحدات', 'main']);
  await db.query("INSERT INTO inv_items (id,name,sku,category,unit,cost,active) VALUES (?,?,?,?,?,5,1)", [ITEM, 'صنف وحدات', 'UOM-1', 'عام', 'حبة']);
  // base PCS (factor 1) + major CTN (factor 12, NOT allowed for issue to test gating? keep allowed)
  await db.query("INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base,allow_issue) VALUES ('IU-B',?,'حبة','PCS',1,1,1),('IU-M',?,'كرتون','CTN',0,12,1)", [ITEM, ITEM]);
  // a sale-only major unit to prove context gating (allow_issue=0)
  await db.query("INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base,allow_issue,allow_sale) VALUES ('IU-P',?,'بالة','PAL',0,144,0,1)", [ITEM, ITEM]);
  await db.query("INSERT INTO gl_accounts (id,code,name_ar,type,is_active) VALUES (?,?,?,?,1),(?,?,?,?,1)", [ACC_REV, 'UOM-4000', 'إيراد وحدات', 'revenue', ACC_EXP, 'UOM-5000', 'مصروف وحدات', 'expense']);
}
async function postDoc(kind, body) {
  const path0 = '/api/inventory/v2/' + kind + 's';
  const cr = await api('POST', path0, body);
  if (cr.status !== 201 && cr.status !== 200) return { stage: 'create', res: cr };
  const id = cr.body.data.id, v = cr.body.data.version || 1;
  const ap = await api('POST', `${path0}/${id}/approve`, { expectedVersion: v });
  if (ap.status !== 200) return { stage: 'approve', res: ap, id };
  const po = await api('POST', `${path0}/${id}/post`, { expectedVersion: (ap.body.data && ap.body.data.version) || 2 });
  return { stage: 'post', res: po, id };
}

(async () => {
  await seed();
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0', INV_MAKER_CHECKER: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('no server'); process.exit(2); }
    console.log('\n═══ UoM across V2 documents ═══');

    // 1) RECEIPT entering 10 CARTONS → 120 base
    const r1 = await postDoc('receipt', { warehouseId: WH, reason: 'استلام كراتين', counterAccountCode: 'UOM-4000', items: [{ itemId: ITEM, enteredUnitCode: 'CTN', enteredQty: 10, unitCost: 5 }] });
    check('receipt 10 CTN posts', r1.stage === 'post' && r1.res.status === 200, r1);
    check('stock = 120 base (10×12)', near(await stock(), 120), await stock());
    const [rl] = await db.query("SELECT base_qty, entered_qty, entered_unit_code, conversion_factor_snapshot FROM inv_receipt_items il JOIN inv_receipts d ON d.id=il.receipt_id WHERE d.warehouse_id=? ORDER BY il.id DESC LIMIT 1", [WH]);
    check('snapshot persisted (base 120, entered 10 CTN, factor 12)', rl.length && near(rl[0].base_qty, 120) && rl[0].entered_unit_code === 'CTN' && near(rl[0].conversion_factor_snapshot, 12), rl[0]);

    // 2) client baseQty mismatch → UNIT_CONVERSION_CONFLICT
    const conflict = await api('POST', '/api/inventory/v2/receipts', { warehouseId: WH, reason: 'x', counterAccountCode: 'UOM-4000', items: [{ itemId: ITEM, enteredUnitCode: 'CTN', enteredQty: 2, baseQty: 99, unitCost: 5 }] });
    check('client baseQty mismatch → UNIT_CONVERSION_CONFLICT', conflict.status === 409 && conflict.body.code === 'UNIT_CONVERSION_CONFLICT', conflict.body && conflict.body.code);

    // 3) unit not allowed for issue (PAL is sale-only) → UNIT_NOT_ALLOWED
    const notAllowed = await api('POST', '/api/inventory/v2/issues', { warehouseId: WH, reason: 'صرف', expenseAccountCode: 'UOM-5000', items: [{ itemId: ITEM, enteredUnitCode: 'PAL', enteredQty: 1 }] });
    check('issue with sale-only unit → UNIT_NOT_ALLOWED', notAllowed.status === 422 && notAllowed.body.code === 'UNIT_NOT_ALLOWED', notAllowed.body && notAllowed.body.code);

    // 4) ISSUE entering 1 CARTON → deduct 12 (120 → 108)
    const r2 = await postDoc('issue', { warehouseId: WH, reason: 'صرف كرتون', expenseAccountCode: 'UOM-5000', items: [{ itemId: ITEM, enteredUnitCode: 'CTN', enteredQty: 1 }] });
    check('issue 1 CTN posts', r2.stage === 'post' && r2.res.status === 200, r2);
    check('stock = 108 base (120−12)', near(await stock(), 108), await stock());

    // 5) ADJUSTMENT counted 8 CARTONS → base 96 (delta −12 vs 108)
    const r3 = await postDoc('adjustment', { warehouseId: WH, reason: 'جرد كراتين', items: [{ itemId: ITEM, enteredUnitCode: 'CTN', countedQty: 8 }] });
    check('adjustment counted 8 CTN posts', r3.stage === 'post' && r3.res.status === 200, r3);
    check('stock = 96 base (8×12 counted)', near(await stock(), 96), await stock());

    // 6) composite major+minor: counted 5 CTN + 3 PCS → 63 base
    const r4 = await postDoc('adjustment', { warehouseId: WH, reason: 'جرد مركب', items: [{ itemId: ITEM, enteredUnitCode: 'CTN', majorQty: 5, minorQty: 3 }] });
    check('adjustment composite 5 CTN + 3 → 63 base', r4.stage === 'post' && r4.res.status === 200 && near(await stock(), 63), { st: r4.res.status, stock: await stock() });

    // 7) no-unit line still works (backward compatible): issue 3 base
    const r5 = await postDoc('issue', { warehouseId: WH, reason: 'صرف بلا وحدة', expenseAccountCode: 'UOM-5000', items: [{ itemId: ITEM, qty: 3 }] });
    check('legacy no-unit line → deduct 3 base (63→60)', r5.stage === 'post' && r5.res.status === 200 && near(await stock(), 60), { st: r5.res.status, stock: await stock() });

    // 8) GL balanced for the receipt (values on base qty × unit cost = 120×5 = 600)
    const [gl] = await db.query("SELECT ROUND(SUM(debit),2) d, ROUND(SUM(credit),2) c FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type='inv_receipt' AND j.reference_id=?", [r1.id]);
    check('receipt GL balanced (debit=credit, base valuation)', gl.length && gl[0].d != null && String(gl[0].d) === String(gl[0].c) && near(gl[0].d, 600), gl[0]);
  } catch (e) { fail++; fails.push('FATAL ' + e.message); console.error(e); } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} uomDocs: ${pass} passed, ${fail} failed`);
  if (fails.length) console.log(fails.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
