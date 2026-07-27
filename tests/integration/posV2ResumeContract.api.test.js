'use strict';
/* Integration — the pos-v2 RESUME contract + the combo-option wire payload,
 * live through the real server + DB.
 *
 * DEFECT A (W0-A #3): `_publicOrder` in routes/pos-v2.js echoed only
 * {id, menuId, name, qty, unitPrice, lineDiscount, vatCategory, notes, sort,
 *  comboChoices} per line. Everything a RESUMED line needs to rebuild itself
 * identically was missing:
 *   • name_en — the client had no English label for a held line;
 *   • entered_unit_code / entered_qty / conversion_factor_snapshot — the line
 *     was stored in BASE units (`qty` IS the base qty), so a "2 كرتون" line
 *     came back as a bare 24 with no way to show, or re-enter, the carton;
 *   • is_tax_inclusive — it lives on `menu`, never on pos_order_lines, so the
 *     resumed cart re-priced a tax-INCLUSIVE line as exclusive and the whole
 *     checkout was then rejected by the `total_mismatch` guard in
 *     routes/sales.js (the money-safety check that refuses to charge a total
 *     the customer was not shown).
 * The fix is purely ADDITIVE — an older client ignores the extra keys.
 *
 * DEFECT B (W0-A #5): GET /catalog comments that inactive combo options ship
 * with `active:false` "the client hides them". This suite VERIFIES that claim
 * on the wire (it holds — no code change was needed) and pins it, along with
 * the per-option `qty`, so a future refactor cannot quietly drop either and
 * leave the chooser selling a disabled component.
 *
 * Fixtures: ITEST-PRC-* prefixed; cleanup runs before AND in finally.
 * PORT 3985. Run: node tests/integration/posV2ResumeContract.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = 3985;
const API = '/api/pos/v2';
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-PRC-${SFX}-${s}`;
const CASHIER = 'w0a_prc_cash';
const WH = P('WH');
const M_INC = P('MI');      // tax-INCLUSIVE, sold by carton
const M_EXC = P('ME');      // tax-EXCLUSIVE (proves the flag is READ, not fixed)
const M_COMBO = P('MC');
const OPT_ON = P('OON');    // active combo option,   qty 1
const OPT_OFF = P('OOFF');  // INACTIVE combo option, qty 2
const GRP = P('G1');
const SHIFT = P('SH');
const ORDER = ('PRC' + SFX + Math.random().toString(36).slice(2, 10)).toUpperCase();

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra !== undefined ? '→ ' + JSON.stringify(extra).slice(0, 320) : ''); }
}

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c));
      s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    r.setTimeout(20000, () => { r.destroy(); res({ status: 0 }); });
    if (d) r.write(d); r.end();
  });
}
async function waitUp() {
  for (let i = 0; i < 300; i++) {
    const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)));
    if (ok) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}
const tok = (id) => jwt.sign({ id, username: CASHIER, role: 'cashier' }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  await del("DELETE FROM pos_payments WHERE order_id LIKE 'PRC%'");
  await del("DELETE l FROM pos_order_lines l JOIN pos_orders o ON o.id = l.order_id WHERE o.username = ?", [CASHIER]);
  await del('DELETE FROM pos_orders WHERE username = ?', [CASHIER]);
  await del("DELETE FROM combo_group_items WHERE group_id LIKE 'ITEST-PRC-%'");
  await del("DELETE FROM combo_groups WHERE id LIKE 'ITEST-PRC-%' OR menu_id LIKE 'ITEST-PRC-%'");
  await del("DELETE FROM item_units WHERE item_id LIKE 'ITEST-PRC-%'");
  await del("DELETE FROM warehouse_stock WHERE warehouse_id LIKE 'ITEST-PRC-%'");
  await del("DELETE FROM menu WHERE id LIKE 'ITEST-PRC-%'");
  await del("DELETE FROM warehouses WHERE id LIKE 'ITEST-PRC-%'");
  await del("DELETE FROM shifts WHERE id LIKE 'ITEST-PRC-%'");
  await del('DELETE FROM users WHERE username = ?', [CASHIER]);
}

async function fixtures() {
  await db.query("INSERT INTO users (username,password,role,active) VALUES (?,'disabled','cashier',1)", [CASHIER]);
  const [u] = await db.query('SELECT id FROM users WHERE username=?', [CASHIER]);
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,'main',1,0)", [WH, 'PRC' + SFX, 'مستودع PRC']);
  await db.query("INSERT INTO shifts (id, username, status, start_time, opening_float) VALUES (?,?,'OPEN',NOW(),0)", [SHIFT, CASHIER]);

  // tax-INCLUSIVE item sold by the carton (1 CTN = 12 PCS)
  await db.query(
    "INSERT INTO menu (id,name,name_en,price,cost,active,tax_category,is_tax_inclusive,production_method,stock) VALUES (?,?,?,?,?,1,'S',1,'imported',500)",
    [M_INC, 'شاي بالنعناع PRC', 'PRC Mint Tea', 10, 3]);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())", [P('WS1'), WH, M_INC, 500, 3]);
  await db.query(
    "INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base,allow_sale,is_active) VALUES (?,?,'حبة','PCS',1,1,1,1),(?,?,'كرتون','CTN',0,12,1,1)",
    [P('IU-B'), M_INC, P('IU-C'), M_INC]);
  // tax-EXCLUSIVE item — same shape, opposite flag
  await db.query(
    "INSERT INTO menu (id,name,name_en,price,cost,active,tax_category,is_tax_inclusive,production_method,stock) VALUES (?,?,?,?,?,1,'S',0,'imported',500)",
    [M_EXC, 'قهوة PRC', 'PRC Coffee', 20, 6]);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())", [P('WS2'), WH, M_EXC, 500, 6]);

  // Combo with ONE choice group holding an ACTIVE and an INACTIVE option.
  await db.query("INSERT INTO menu (id,name,name_en,price,cost,active,tax_category,is_combo) VALUES (?,?,?,?,?,1,'S',1)",
    [M_COMBO, 'عرض PRC', 'PRC Combo', 45, 12]);
  await db.query("INSERT INTO menu (id,name,name_en,price,cost,active,tax_category) VALUES (?,?,?,?,?,1,'S')",
    [OPT_ON, 'خيار متاح PRC', 'PRC Available Option', 5, 1]);
  await db.query("INSERT INTO menu (id,name,name_en,price,cost,active,tax_category) VALUES (?,?,?,?,?,0,'S')",
    [OPT_OFF, 'خيار موقوف PRC', 'PRC Disabled Option', 5, 1]);
  await db.query("INSERT INTO combo_groups (id,menu_id,group_type,name,min_select,max_select,sort_order) VALUES (?,?,'choice',?,1,1,1)",
    [GRP, M_COMBO, 'اختر مشروبك']);
  await db.query("INSERT INTO combo_group_items (id,group_id,menu_item_id,qty,sort_order) VALUES (?,?,?,1,1),(?,?,?,2,2)",
    [P('CGI-ON'), GRP, OPT_ON, P('CGI-OFF'), GRP, OPT_OFF]);
  return u[0].id;
}

function lineOf(order, menuId) {
  return ((order && order.lines) || []).find((l) => l.menuId === menuId) || null;
}

(async () => {
  await cleanup();
  const uid = await fixtures();

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '0' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const cashier = tok(uid);

  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }

    // ── build a held order with a CARTON line + a tax-exclusive line ────────
    console.log('\n▶ HOLD — a carton line and a tax-exclusive line');
    const up = await call('POST', API + '/orders', cashier, {
      id: ORDER, shiftId: SHIFT, warehouseId: WH,
      lines: [
        // the client sends the ENTERED qty + the unit it was entered in;
        // the server expands to base (2 × 12 = 24) and snapshots the factor.
        { menuId: M_INC, qty: 2, unitFactor: 12, enteredUnitCode: 'CTN' },
        { menuId: M_EXC, qty: 3 },
      ],
    });
    check('upsert → 200/201', up.status === 201 || up.status === 200, { status: up.status, body: up.body });
    const held = await call('POST', API + `/orders/${ORDER}/hold`, cashier, { expectedVersion: up.body && up.body.data && up.body.data.version });
    check('hold → 200', held.status === 200, { status: held.status, body: held.body });

    // ── (3) GET /orders/:id — the resume read ──────────────────────────────
    console.log('\n▶ RESUME — GET /orders/:id echoes what a rebuild needs');
    const got = await call('GET', API + `/orders/${ORDER}`, cashier);
    check('GET /orders/:id → 200', got.status === 200, { status: got.status, body: got.body });
    const o = got.body && got.body.data;
    const li = lineOf(o, M_INC);
    const le = lineOf(o, M_EXC);
    check('both lines came back', !!li && !!le, o && o.lines);

    check('qty IS the stored BASE quantity (2 CTN × 12 = 24)', !!li && Number(li.qty) === 24, li && li.qty);
    check('baseQty echoes the same 24 explicitly', !!li && Number(li.baseQty) === 24, li && li.baseQty);
    check('enteredQty is the 2 the cashier actually typed', !!li && Number(li.enteredQty) === 2, li && li.enteredQty);
    check('enteredUnitCode is CTN', !!li && li.enteredUnitCode === 'CTN', li && li.enteredUnitCode);
    check('conversionFactorSnapshot is 12', !!li && Number(li.conversionFactorSnapshot) === 12, li && li.conversionFactorSnapshot);
    check('nameEn is the menu English name', !!li && li.nameEn === 'PRC Mint Tea', li && li.nameEn);
    check('taxInclusive is TRUE for the tax-inclusive item', !!li && li.taxInclusive === true, li && li.taxInclusive);
    check('taxInclusive is FALSE for the tax-exclusive item (read, not hardcoded)',
      !!le && le.taxInclusive === false, le && le.taxInclusive);
    check('base-unit line reports factor 1 / entered qty 3',
      !!le && Number(le.conversionFactorSnapshot) === 1 && Number(le.enteredQty) === 3, le);
    check('the historical keys are all still there (purely additive change)',
      !!li && ['id', 'menuId', 'name', 'qty', 'unitPrice', 'lineDiscount', 'vatCategory', 'notes', 'sort', 'comboChoices']
        .every((k) => Object.prototype.hasOwnProperty.call(li, k)), li && Object.keys(li));

    // ── the held-orders LIST is where a resume actually starts ──────────────
    console.log('\n▶ RESUME — GET /orders (the held-orders list) ships the same shape');
    const list = await call('GET', API + '/orders?status=HELD', cashier);
    check('GET /orders → 200', list.status === 200, { status: list.status, body: list.body });
    const listed = ((list.body && list.body.data) || []).find((x) => x.id === ORDER);
    const lli = lineOf(listed, M_INC);
    check('the held order is listed', !!listed, (list.body && list.body.data || []).map((x) => x.id));
    check('list line carries nameEn + entered unit + factor + taxInclusive',
      !!lli && lli.nameEn === 'PRC Mint Tea' && lli.enteredUnitCode === 'CTN'
        && Number(lli.enteredQty) === 2 && Number(lli.conversionFactorSnapshot) === 12 && lli.taxInclusive === true, lli);

    // ── (5) combo options on the wire ──────────────────────────────────────
    console.log('\n▶ CATALOG — combo options ship active + qty');
    const cat = await call('GET', API + '/catalog', cashier);
    check('GET /catalog → 200', cat.status === 200, { status: cat.status, body: cat.body && cat.body.error });
    const combo = ((cat.body && cat.body.data && cat.body.data.combos) || []).find((c) => String(c.id) === M_COMBO);
    check('the combo is in the catalog', !!combo, (cat.body && cat.body.data && cat.body.data.combos || []).map((c) => c.id));
    const grp = combo && (combo.groups || []).find((g) => String(g.id) === GRP);
    check('its choice group is present with min/max', !!grp && grp.min === 1 && grp.max === 1, grp);
    const optOn = grp && (grp.options || []).find((x) => String(x.menuId) === OPT_ON);
    const optOff = grp && (grp.options || []).find((x) => String(x.menuId) === OPT_OFF);
    check('the INACTIVE option is SHIPPED (not filtered away server-side)', !!optOff, grp && grp.options);
    check('…and it carries active:false — the flag the client filters on',
      !!optOff && optOff.active === false, optOff);
    check('the active option carries active:true', !!optOn && optOn.active === true, optOn);
    check('per-option qty is echoed (1 and 2)',
      !!optOn && Number(optOn.qty) === 1 && !!optOff && Number(optOff.qty) === 2, { optOn, optOff });
    check('options also carry menuId/name/priceDelta',
      !!optOn && optOn.name === 'خيار متاح PRC' && optOn.priceDelta === 0, optOn);

    // The wire says active:false AND the server refuses it at upsert — belt and
    // braces, so a client that ignores the flag still cannot sell a dead option.
    const badCombo = await call('POST', API + '/orders', cashier, {
      id: ORDER + 'X', shiftId: SHIFT, warehouseId: WH,
      lines: [{ menuId: M_COMBO, qty: 1, comboChoices: { [GRP]: [OPT_OFF] } }],
    });
    check('an inactive option is still REJECTED server-side at upsert',
      badCombo.status >= 400 && badCombo.body && badCombo.body.code === 'VALIDATION_ERROR',
      { status: badCombo.status, body: badCombo.body });

    console.log(`\n${fail === 0 ? '✅' : '❌'} posV2ResumeContract: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
