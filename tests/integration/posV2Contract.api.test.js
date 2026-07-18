'use strict';
/* Integration — Cashier-V2 contract extensions (REAL server + DB, ITEST fixtures).
 *
 * The three legacy capabilities the React POS could not sell without:
 *   1. COMBOS — catalog ships data.combos (fixed components + choice groups);
 *      upsert validates comboChoices ({groupId: [menuId]}) server-side; /submit
 *      flows the LEGACY [{groupId, menuItemId}] shape into /api/sales so the
 *      recipe deduction runs per CHOSEN option (and only the chosen one).
 *   2. CHANNELS — ?channelId= resolves prices through the ERP chain
 *      (override > price-list > base) with priceSource provenance; orders
 *      validate the channel and checkout totals use the channel price.
 *   3. OWNER PAYMENT METHODS — catalog paymentMethods from payment_methods;
 *      a custom method checks out and records its configured Arabic name;
 *      'other'-group methods refuse to submit without a ≥3-char payment note.
 *
 * Harness pattern: tests/integration/wasteEntries.api.test.js — spawn
 * server.js, real bcrypt login via /api/auth/login, ITEST- fixtures, cleanup
 * before + finally.
 *
 * Run: node tests/integration/posV2Contract.api.test.js   (MySQL on .env)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 4000;
const API = '/api/pos/v2';
const CASHIER = 'itest_posc_cashier';
const MANAGER = 'itest_posc_manager';
const PW = 'PosC#Test!2026';

// Menu + combo definition
const SAND1 = 'ITEST-POSC-SAND1';   // choice option A (price 20, recipe: ING_A × 2)
const SAND2 = 'ITEST-POSC-SAND2';   // choice option B (price 22, recipe: ING_B × 3)
const JUICE = 'ITEST-POSC-JUICE';   // fixed component  (price 8,  recipe: ING_J × 1)
const COMBO = 'ITEST-POSC-COMBO';   // is_combo=1, price 25
const PLAIN = 'ITEST-POSC-PLAIN';   // plain item, price 30
const CG_FIX = 'ITEST-POSC-CG-FIX';
const CG_CHOICE = 'ITEST-POSC-CG-CHOICE';
const ING_A = 'ITEST-POSC-ING-A';
const ING_B = 'ITEST-POSC-ING-B';
const ING_J = 'ITEST-POSC-ING-J';

// Channel + price list
const CH = 'ITEST-POSC-CH';
const CH_NAME = 'قناة اختبار V2';
const PL = 'ITEST-POSC-PL';
const PL_NAME = 'قائمة أسعار اختبار V2';

// Owner payment methods (payment_methods.id is AUTO_INCREMENT — match by name)
const PM_VOUCH = 'ITESTVOUCH';
const PM_VOUCH_AR = 'قسيمة اختبار';
const PM_OTHER = 'ITESTOTHER';
const PM_OTHER_AR = 'طريقة أخرى اختبار';
const PM_OFF = 'ITESTOFF';

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 260) : ''); } }
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.02;
function oid(tag) { return 'ITESTPOSC' + tag + Math.random().toString(36).slice(2, 8).toUpperCase(); }

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j, headers: s.headers }); });
    });
    r.on('error', () => res({ status: 0 }));
    r.setTimeout(20000, () => { r.destroy(); res({ status: 0, error: 'timeout' }); });
    if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

const ingStock = async (id) => { const [r] = await db.query('SELECT stock FROM inv_items WHERE id=?', [id]); return r.length ? Number(r[0].stock) : null; };
const orderRows = async (id) => { const [r] = await db.query('SELECT COUNT(*) c FROM pos_orders WHERE id=?', [id]); return Number(r[0].c); };
const lineRows = async (id) => { const [r] = await db.query('SELECT COUNT(*) c FROM pos_order_lines WHERE order_id=?', [id]); return Number(r[0].c); };

async function cleanup() {
  const sqls = [
    // ── legacy sale side-effects (sales POSTed with clientOrderId ITESTPOSC…) ──
    ["DELETE c FROM ar_document_line_components c JOIN ar_document_lines l ON l.id=c.document_line_id JOIN ar_documents d ON d.id=l.document_id JOIN sales s ON s.id=d.source_id WHERE s.client_order_id LIKE 'ITESTPOSC%'", []],
    ["DELETE l FROM ar_document_lines l JOIN ar_documents d ON d.id=l.document_id JOIN sales s ON s.id=d.source_id WHERE s.client_order_id LIKE 'ITESTPOSC%'", []],
    ["DELETE d FROM ar_documents d JOIN sales s ON s.id=d.source_id WHERE s.client_order_id LIKE 'ITESTPOSC%'", []],
    ["DELETE si FROM sales_items si JOIN sales s ON s.id=si.order_id WHERE s.client_order_id LIKE 'ITESTPOSC%'", []],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id JOIN sales s ON s.id=j.reference_id WHERE s.client_order_id LIKE 'ITESTPOSC%'", []],
    ["DELETE j FROM gl_journals j JOIN sales s ON s.id=j.reference_id WHERE s.client_order_id LIKE 'ITESTPOSC%'", []],
    ["DELETE FROM sales WHERE client_order_id LIKE 'ITESTPOSC%'", []],
    ["DELETE FROM inventory_movements WHERE item_id LIKE 'ITEST-POSC-%'", []],
    // ── V2 order rows ──
    ["DELETE p FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.id LIKE 'ITESTPOSC%'", []],
    ["DELETE l FROM pos_order_lines l JOIN pos_orders o ON o.id=l.order_id WHERE o.id LIKE 'ITESTPOSC%'", []],
    ["DELETE FROM pos_orders WHERE id LIKE 'ITESTPOSC%'", []],
    ['DELETE FROM shifts WHERE username IN (?,?)', [CASHIER, MANAGER]],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?)', [CASHIER, MANAGER]],
    // ── fixtures ──
    ["DELETE FROM recipe WHERE menu_id LIKE 'ITEST-POSC-%'", []],
    ["DELETE FROM combo_group_items WHERE group_id LIKE 'ITEST-POSC-%'", []],
    ["DELETE FROM combo_groups WHERE menu_id LIKE 'ITEST-POSC-%'", []],
    ['DELETE FROM channel_menu_items WHERE channel_id=?', [CH]],
    ['DELETE FROM price_list_items WHERE price_list_id=?', [PL]],
    ['DELETE FROM price_lists WHERE id=?', [PL]],
    ['DELETE FROM sales_channels WHERE id=?', [CH]],
    ["DELETE FROM payment_methods WHERE name LIKE 'ITEST%'", []],
    ["DELETE FROM inv_items WHERE id LIKE 'ITEST-POSC-%'", []],
    ["DELETE FROM menu WHERE id LIKE 'ITEST-POSC-%'", []],
    ['DELETE FROM users WHERE username IN (?,?)', [CASHIER, MANAGER]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);

  // Menu: components + combo + plain item (prices are tax-inclusive, S=15%).
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'S')", [SAND1, 'ITEST سندوتش أ', 20, 'ITEST']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'S')", [SAND2, 'ITEST سندوتش ب', 22, 'ITEST']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'S')", [JUICE, 'ITEST عصير', 8, 'ITEST']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category, is_combo) VALUES (?,?,?,?,1,'S',1)", [COMBO, 'ITEST عرض سندوتش وعصير', 25, 'ITEST']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'S')", [PLAIN, 'ITEST صنف عادي', 30, 'ITEST']);

  // Combo definition: fixed juice + choose exactly 1 of the two sandwiches.
  await db.query("INSERT INTO combo_groups (id, menu_id, group_type, name, min_select, max_select, sort_order) VALUES (?,?,'fixed','مكوّن ثابت',0,0,0)", [CG_FIX, COMBO]);
  await db.query("INSERT INTO combo_groups (id, menu_id, group_type, name, min_select, max_select, sort_order) VALUES (?,?,'choice','اختر سندوتش',1,1,1)", [CG_CHOICE, COMBO]);
  await db.query('INSERT INTO combo_group_items (id, group_id, menu_item_id, qty, sort_order) VALUES (?,?,?,1,0)', [CG_FIX + '-J', CG_FIX, JUICE]);
  await db.query('INSERT INTO combo_group_items (id, group_id, menu_item_id, qty, sort_order) VALUES (?,?,?,1,0)', [CG_CHOICE + '-1', CG_CHOICE, SAND1]);
  await db.query('INSERT INTO combo_group_items (id, group_id, menu_item_id, qty, sort_order) VALUES (?,?,?,1,1)', [CG_CHOICE + '-2', CG_CHOICE, SAND2]);

  // Ingredients + recipes (legacy `recipe` table; no warehouse on the order →
  // /api/sales deducts inv_items.stock directly).
  await db.query("INSERT INTO inv_items (id, name, unit, cost, stock) VALUES (?, 'ITEST مكوّن أ', 'PCS', 2, 100)", [ING_A]);
  await db.query("INSERT INTO inv_items (id, name, unit, cost, stock) VALUES (?, 'ITEST مكوّن ب', 'PCS', 2, 100)", [ING_B]);
  await db.query("INSERT INTO inv_items (id, name, unit, cost, stock) VALUES (?, 'ITEST مكوّن ج', 'PCS', 1, 100)", [ING_J]);
  await db.query('INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used) VALUES (?,?,?,?,2)', [SAND1, 'ITEST سندوتش أ', ING_A, 'ITEST مكوّن أ']);
  await db.query('INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used) VALUES (?,?,?,?,3)', [SAND2, 'ITEST سندوتش ب', ING_B, 'ITEST مكوّن ب']);
  await db.query('INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used) VALUES (?,?,?,?,1)', [JUICE, 'ITEST عصير', ING_J, 'ITEST مكوّن ج']);

  // Channel (independent menu) + price list: PLAIN priced 27 via the list,
  // COMBO overridden to 24 per-channel. Base prices stay 30 / 25.
  await db.query("INSERT INTO price_lists (id, name, is_active) VALUES (?,?,1)", [PL, PL_NAME]);
  await db.query('INSERT INTO price_list_items (id, price_list_id, item_id, price) VALUES (?,?,?,27)', [PL + '-PLAIN', PL, PLAIN]);
  await db.query(
    "INSERT INTO sales_channels (id, code, name, channel_type, price_list_id, is_active, use_full_menu, display_order) VALUES (?,?,?,?,?,1,0,900)",
    [CH, 'ITESTCH', CH_NAME, 'app', PL]);
  await db.query("INSERT INTO channel_menu_items (id, channel_id, menu_item_id, is_available, override_price) VALUES (?,?,?,1,NULL)", [CH + '-CMI-PLAIN', CH, PLAIN]);
  await db.query("INSERT INTO channel_menu_items (id, channel_id, menu_item_id, is_available, override_price) VALUES (?,?,?,1,24)", [CH + '-CMI-COMBO', CH, COMBO]);

  // Owner payment methods: an active voucher, an active 'other' (note-required),
  // and an INACTIVE one that must be refused.
  await db.query("INSERT INTO payment_methods (name, name_ar, is_active, group_type, sort_order) VALUES (?,?,1,'voucher',901)", [PM_VOUCH, PM_VOUCH_AR]);
  await db.query("INSERT INTO payment_methods (name, name_ar, is_active, group_type, sort_order) VALUES (?,?,1,'other',902)", [PM_OTHER, PM_OTHER_AR]);
  await db.query("INSERT INTO payment_methods (name, name_ar, is_active, group_type, sort_order) VALUES (?,?,0,'electronic',903)", [PM_OFF, 'موقوفة اختبار']);
}

(async () => {
  await seed();
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ Cashier-V2 contract: combos + channels + owner payment methods ═══');

    const cashier = await login(CASHIER);
    const manager = await login(MANAGER);
    check('users authenticate (real /api/auth/login)', !!cashier && !!manager);

    // ── 1) catalog: combos + payment methods + channels ─────────────────────
    console.log('▸ catalog contract');
    let r = await call('GET', API + '/catalog', cashier);
    check('catalog 200', r.status === 200 && r.body && r.body.success === true, r.status);
    const cat = (r.body && r.body.data) || {};
    const comboDef = (cat.combos || []).find((c) => c.id === COMBO);
    check('combos[] carries the combo definition', !!comboDef, cat.combos && cat.combos.length);
    check('combo fixedComponents = [juice ×1]',
      !!comboDef && comboDef.fixedComponents.length === 1 && comboDef.fixedComponents[0].menuId === JUICE && comboDef.fixedComponents[0].qty === 1, comboDef && comboDef.fixedComponents);
    const chGroup = comboDef && comboDef.groups.find((g) => g.id === CG_CHOICE);
    check('combo choice group min=1 max=1 with 2 options',
      !!chGroup && chGroup.min === 1 && chGroup.max === 1 && chGroup.options.length === 2
      && chGroup.options.some((o) => o.menuId === SAND1) && chGroup.options.some((o) => o.menuId === SAND2), chGroup);
    const comboItem = (cat.items || []).find((i) => i.id === COMBO);
    check('menu item flagged isCombo:true', !!comboItem && comboItem.isCombo === true, comboItem);
    check('plain item flagged isCombo:false', ((cat.items || []).find((i) => i.id === PLAIN) || {}).isCombo === false);
    const pmV = (cat.paymentMethods || []).find((p) => p.name === PM_VOUCH);
    const pmO = (cat.paymentMethods || []).find((p) => p.name === PM_OTHER);
    check('paymentMethods carries the active voucher method (requiresNote:false)',
      !!pmV && pmV.nameAr === PM_VOUCH_AR && pmV.groupType === 'voucher' && pmV.requiresNote === false, pmV);
    check("paymentMethods flags the 'other'-group method requiresNote:true", !!pmO && pmO.requiresNote === true, pmO);
    check('INACTIVE method is NOT in the catalog', !(cat.paymentMethods || []).some((p) => p.name === PM_OFF), cat.paymentMethods && cat.paymentMethods.length);
    check('channels[] lists the active channel', (cat.channels || []).some((c) => c.id === CH && c.name === CH_NAME), cat.channels);

    // ── 2) catalog under the channel: price chain + provenance ──────────────
    console.log('▸ channel catalog');
    r = await call('GET', API + '/catalog?channelId=' + CH, cashier);
    const chCat = (r.body && r.body.data) || {};
    check('channel catalog 200 + echo of the channel', r.status === 200 && chCat.channel && chCat.channel.id === CH && chCat.channel.priceListName === PL_NAME, chCat.channel);
    check('independent channel shows ONLY its configured items (2)', (chCat.items || []).length === 2, (chCat.items || []).map((i) => i.id));
    const chPlain = (chCat.items || []).find((i) => i.id === PLAIN);
    check('price-list price applied: PLAIN 30 → 27, priceSource = list name',
      !!chPlain && near(chPlain.price, 27) && near(chPlain.basePrice, 30) && chPlain.priceSource === PL_NAME, chPlain);
    const chCombo = (chCat.items || []).find((i) => i.id === COMBO);
    check("override price applied: COMBO 25 → 24, priceSource='override'",
      !!chCombo && near(chCombo.price, 24) && chCombo.priceSource === 'override', chCombo);
    check('combos[] under the channel carries the override price too',
      near(((chCat.combos || []).find((c) => c.id === COMBO) || {}).price, 24), chCat.combos);
    r = await call('GET', API + '/catalog?channelId=NO-SUCH-CH', cashier);
    check('unknown channel → 422 Arabic (no silent full-menu fallback)', r.status === 422 && /قناة/.test((r.body && r.body.error) || ''), { status: r.status, body: r.body });

    // ── open a real shift (legacy endpoint) ─────────────────────────────────
    r = await call('POST', '/api/shifts/open', cashier, { device: { ua: 'posv2-contract-test' } });
    const shiftId = r.body && (r.body.shiftId || (r.body.data && r.body.data.shiftId));
    check('legacy shift opened', !!shiftId, r.body);

    // ── 3) combo checkout: the chosen option (and ONLY it) deducts ──────────
    console.log('▸ combo checkout + recipe deductions');
    const A = oid('CMB');
    r = await call('POST', API + '/orders', cashier, {
      id: A, shiftId, lines: [{ menuId: COMBO, qty: 1, comboChoices: { [CG_CHOICE]: [SAND1] } }],
    });
    check('combo upsert with valid choices → 201, total 25', r.status === 201 && near(r.body.data.totals.total, 25), r.body);
    r = await call('POST', API + `/orders/${A}/submit`, cashier, { payments: [{ method: 'cash', amount: 25 }] }, { 'Idempotency-Key': 'itest-posc-sub-A' });
    check('combo submit → legacyPayload', r.status === 200 && r.body.data && r.body.data.legacyPayload, r.body);
    const payloadA = r.body.data.legacyPayload;
    const lineChoices = payloadA && payloadA.items && payloadA.items[0] && payloadA.items[0].comboChoices;
    check('legacyPayload item carries comboChoices EXACTLY as legacy sent them ([{groupId, menuItemId}])',
      Array.isArray(lineChoices) && lineChoices.length === 1 && lineChoices[0].groupId === CG_CHOICE && lineChoices[0].menuItemId === SAND1, lineChoices);
    r = await call('POST', '/api/sales', cashier, payloadA);
    check('legacy /api/sales accepts the combo payload', r.status === 200 || r.status === 201, { status: r.status, err: r.body && r.body.error });
    const saleA = r.body && (r.body.orderId || r.body.id);
    r = await call('POST', API + `/orders/${A}/complete`, cashier, { saleId: saleA });
    check('combo order completes', r.status === 200 && r.body.status === 'completed', r.body);
    check('CHOSEN option recipe deducted: ING_A 100 − 2 = 98', (await ingStock(ING_A)) === 98, await ingStock(ING_A));
    check('fixed component recipe deducted: ING_J 100 − 1 = 99', (await ingStock(ING_J)) === 99, await ingStock(ING_J));
    check('UNCHOSEN option did NOT deduct: ING_B stays 100', (await ingStock(ING_B)) === 100, await ingStock(ING_B));
    const [movA] = await db.query("SELECT COUNT(*) c FROM inventory_movements WHERE item_id=? AND reason LIKE '%عرض%'", [ING_A]);
    const [movB] = await db.query('SELECT COUNT(*) c FROM inventory_movements WHERE item_id=?', [ING_B]);
    check('movement log: chosen ingredient has a combo movement, unchosen has none', Number(movA[0].c) === 1 && Number(movB[0].c) === 0, { a: movA[0].c, b: movB[0].c });

    // ── 4) invalid choices → 422 + ZERO rows written ────────────────────────
    console.log('▸ combo validation');
    const BAD1 = oid('BAD1');
    r = await call('POST', API + '/orders', cashier, { id: BAD1, shiftId, lines: [{ menuId: COMBO, qty: 1, comboChoices: { [CG_CHOICE]: [PLAIN] } }] });
    check('a pick that is NOT a configured option → 422', r.status === 422 && r.body && r.body.success === false, { status: r.status, body: r.body });
    check('…and NO order row was written', (await orderRows(BAD1)) === 0 && (await lineRows(BAD1)) === 0);
    const BAD2 = oid('BAD2');
    r = await call('POST', API + '/orders', cashier, { id: BAD2, shiftId, lines: [{ menuId: COMBO, qty: 1, comboChoices: {} }] });
    check('missing required choice (min 1) → 422', r.status === 422, { status: r.status, body: r.body });
    check('…zero rows again', (await orderRows(BAD2)) === 0 && (await lineRows(BAD2)) === 0);
    const BAD3 = oid('BAD3');
    r = await call('POST', API + '/orders', cashier, { id: BAD3, shiftId, lines: [{ menuId: COMBO, qty: 1, comboChoices: { [CG_CHOICE]: [SAND1, SAND2] } }] });
    check('too many picks (max 1) → 422', r.status === 422, { status: r.status, body: r.body });
    const BAD4 = oid('BAD4');
    r = await call('POST', API + '/orders', cashier, { id: BAD4, shiftId, lines: [{ menuId: PLAIN, qty: 1, comboChoices: { [CG_CHOICE]: [SAND1] } }] });
    check('comboChoices on a NON-combo item → 422 (no silent drop)', r.status === 422, { status: r.status, body: r.body });
    check('invalid attempts left every ingredient untouched',
      (await ingStock(ING_A)) === 98 && (await ingStock(ING_B)) === 100 && (await ingStock(ING_J)) === 99);

    // ── 5) channel order: checkout total uses the channel price ─────────────
    console.log('▸ channel checkout');
    const B = oid('CHN');
    r = await call('POST', API + '/orders', cashier, { id: B, shiftId, channelId: CH, lines: [{ menuId: PLAIN, qty: 2 }] });
    check('channel order: omitted unitPrice resolves to the CHANNEL price (2×27=54)', r.status === 201 && near(r.body.data.totals.total, 54), r.body && r.body.data);
    r = await call('POST', API + `/orders/${B}/submit`, cashier, { payments: [{ method: 'cash', amount: 54 }] }, { 'Idempotency-Key': 'itest-posc-sub-B' });
    check('channel submit → legacyPayload carries channelId + server-resolved name + total 54',
      r.status === 200 && r.body.data.legacyPayload.channelId === CH && r.body.data.legacyPayload.channelName === CH_NAME && near(r.body.data.legacyPayload.totalFinal, 54), r.body && r.body.data);
    r = await call('POST', '/api/sales', cashier, r.body.data.legacyPayload);
    check('legacy sale accepted for the channel order', r.status === 200 || r.status === 201, { status: r.status, err: r.body && r.body.error });
    const saleB = r.body && (r.body.orderId || r.body.id);
    await call('POST', API + `/orders/${B}/complete`, cashier, { saleId: saleB });
    const [saleRowB] = await db.query('SELECT channel_id, channel_name, total_final FROM sales WHERE id=?', [saleB]);
    check('sales row records channel_id + channel_name + channel-priced total',
      saleRowB.length === 1 && saleRowB[0].channel_id === CH && saleRowB[0].channel_name === CH_NAME && near(saleRowB[0].total_final, 54), saleRowB[0]);
    const BADCH = oid('BADCH');
    r = await call('POST', API + '/orders', cashier, { id: BADCH, shiftId, channelId: 'NO-SUCH-CH', lines: [{ menuId: PLAIN, qty: 1 }] });
    check('unknown channelId on upsert → 422 + no row', r.status === 422 && (await orderRows(BADCH)) === 0, { status: r.status, body: r.body });

    // ── 6) owner payment methods at checkout ────────────────────────────────
    console.log('▸ owner payment methods');
    const C = oid('PMV');
    await call('POST', API + '/orders', cashier, { id: C, shiftId, lines: [{ menuId: PLAIN, qty: 1 }] });
    r = await call('POST', API + `/orders/${C}/submit`, cashier, { payments: [{ method: PM_VOUCH, amount: 30 }] }, { 'Idempotency-Key': 'itest-posc-sub-C' });
    check('custom ACTIVE method accepted; legacy paymentMethod = its configured Arabic name',
      r.status === 200 && r.body.data.legacyPayload.paymentMethod === PM_VOUCH_AR, r.body && (r.body.error || r.body.data));
    r = await call('POST', '/api/sales', cashier, r.body.data.legacyPayload);
    check('legacy sale accepted with the custom method', r.status === 200 || r.status === 201, { status: r.status, err: r.body && r.body.error });
    const saleC = r.body && (r.body.orderId || r.body.id);
    await call('POST', API + `/orders/${C}/complete`, cashier, { saleId: saleC });
    const [saleRowC] = await db.query('SELECT payment_method FROM sales WHERE id=?', [saleC]);
    check('sales.payment_method records the custom method name', saleRowC.length === 1 && saleRowC[0].payment_method === PM_VOUCH_AR, saleRowC[0]);

    const D = oid('PMO');
    await call('POST', API + '/orders', cashier, { id: D, shiftId, lines: [{ menuId: PLAIN, qty: 1 }] });
    r = await call('POST', API + `/orders/${D}/submit`, cashier, { payments: [{ method: PM_OTHER, amount: 30 }] });
    check("'other'-group method WITHOUT a note → 422 Arabic", r.status === 422 && /ملاحظة/.test((r.body && r.body.error) || ''), { status: r.status, body: r.body });
    r = await call('POST', API + `/orders/${D}/submit`, cashier, { payments: [{ method: PM_OTHER, amount: 30 }], paymentNotes: 'تحويل بنكي خاص' }, { 'Idempotency-Key': 'itest-posc-sub-D' });
    check("'other'-group method WITH a ≥3-char note → accepted, note in the payload",
      r.status === 200 && r.body.data.legacyPayload.paymentNotes === 'تحويل بنكي خاص', r.body && (r.body.error || r.body.data));
    r = await call('POST', '/api/sales', cashier, r.body.data.legacyPayload);
    const saleD = r.body && (r.body.orderId || r.body.id);
    check('legacy sale accepted', !!saleD, { status: r.status, err: r.body && r.body.error });
    await call('POST', API + `/orders/${D}/complete`, cashier, { saleId: saleD });
    const [saleRowD] = await db.query('SELECT payment_notes FROM sales WHERE id=?', [saleD]);
    check('sales.payment_notes records the note', saleRowD.length === 1 && saleRowD[0].payment_notes === 'تحويل بنكي خاص', saleRowD[0]);

    const E = oid('PMX');
    await call('POST', API + '/orders', cashier, { id: E, shiftId, lines: [{ menuId: PLAIN, qty: 1 }] });
    r = await call('POST', API + `/orders/${E}/submit`, cashier, { payments: [{ method: 'bitcoin', amount: 30 }] });
    check('unknown method → 422', r.status === 422, { status: r.status, body: r.body });
    r = await call('POST', API + `/orders/${E}/submit`, cashier, { payments: [{ method: PM_OFF, amount: 30 }] });
    check('INACTIVE owner method → 422', r.status === 422, { status: r.status, body: r.body });

    console.log(`\n${fail === 0 ? '✅' : '❌'} posV2Contract: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
