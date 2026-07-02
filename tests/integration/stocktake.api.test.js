/**
 * Phase 3C — professional stocktake integration test (ENFORCE=1).
 *
 * Boots server.js with WAREHOUSE_SCOPE_ENFORCE=1 + STOCKTAKE_MAKER_CHECKER=1 and
 * drives /api/inventory/v2/stocktakes end-to-end:
 *   • the canonical chain: snapshot 100 → issue 10 during count (theoretical 90)
 *     → counted 85 (variance −5) → receive 20 after count (current 110) → post ⇒ 105;
 *     proves the variance is applied to the CURRENT balance via the 3B Adjustment
 *     Engine (a real posted inv_adjustments + balanced GL + inv_adjustment movement).
 *   • all transitions; Maker–Checker (creator can't approve); request-recount;
 *     null-vs-zero counted; uncounted excluded at post; post-once; idempotency;
 *     rollback on a forced adjustment-insert failure (stock unchanged);
 *     warehouse scope; no edit/delete after start; evidence gate; blind flag;
 *     legacy stocktakes/stocktake_items untouched.
 *
 * Run: node tests/integration/stocktake.api.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.STK_TEST_PORT || 3231);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-STK', WC = 'WH-STK-C';
const I_MAIN = 'STK-MAIN', I_ZA = 'STK-ZA', I_ZB = 'STK-ZB', I_RB = 'STK-RB', I_RC = 'STK-RC';
const I_SQ = 'STK-SQ', I_SQ2 = 'STK-SQ2'; // movement-sequence window tests
const U_A = 'stk_a', U_B = 'stk_b', U_OUT = 'stk_out';
const S = '/api/inventory/v2/stocktakes';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.02 : tol); }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function qty(item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, item]); return r.length ? Number(r[0].qty) : 0; }
async function setQty(item, q) { await db.query('UPDATE warehouse_stock SET qty=? WHERE warehouse_id=? AND item_id=?', [q, WH, item]); }
async function injectMovement(item, type, q, secondsAgo) {
  await db.query(
    "INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, warehouse_id, reference_type, reference_id) VALUES (?, DATE_SUB(NOW(), INTERVAL ? SECOND), ?, '', ?, ?, 'simulate', 'test', ?, 'manual', 'SIM')",
    ['MVSIM-' + Math.random().toString(36).slice(2, 9), secondsAgo || 0, item, type, q, WH]
  );
}
async function glBalanced(jid) { const [r] = await db.query('SELECT total_debit, total_credit FROM gl_journals WHERE id=?', [jid]); return r.length ? near(r[0].total_debit, r[0].total_credit, 0.01) : false; }
async function legacyCounts() { const [a] = await db.query('SELECT COUNT(*) n FROM stocktakes'); const [b] = await db.query('SELECT COUNT(*) n FROM stocktake_items'); return { st: Number(a[0].n), sti: Number(b[0].n) }; }

async function cleanup() {
  const sqls = [
    ["DELETE e FROM inv_tx_events e JOIN inv_stocktakes d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", [WH, WC]],
    ["DELETE i FROM inv_stocktake_items i JOIN inv_stocktakes d ON d.id=i.stocktake_id WHERE d.warehouse_id IN (?,?)", [WH, WC]],
    ['DELETE FROM inv_stocktakes WHERE warehouse_id IN (?,?)', [WH, WC]],
    ["DELETE e FROM inv_tx_events e JOIN inv_adjustments d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", [WH, WC]],
    ['DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id IN (?,?)', [WH, WC]],
    ['DELETE FROM inv_adjustments WHERE warehouse_id IN (?,?)', [WH, WC]],
    ["DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)", [WH, WC]],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type LIKE 'inv\\_%' AND j.reference_id LIKE 'ADV-%'", []],
    ["DELETE FROM gl_journals WHERE reference_type LIKE 'inv\\_%' AND reference_id LIKE 'ADV-%'", []],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [WH, WC]],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?,?)', [U_A, U_B, U_OUT]],
    ['DELETE FROM idempotency_keys WHERE username=?', ['stk_admin']],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?,?)', [U_A, U_B, U_OUT]],
    ['DELETE FROM inv_items WHERE id IN (?,?,?,?,?,?,?)', [I_MAIN, I_ZA, I_ZB, I_RB, I_RC, I_SQ, I_SQ2]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WH, WC]],
    ['DELETE FROM users WHERE username IN (?,?,?)', [U_A, U_B, U_OUT]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, 'STK', 'مستودع الجرد', 'main']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [WC, 'STKC', 'مستودع آخر', 'branch']);
  for (const [it, q] of [[I_MAIN, 100], [I_ZA, 8], [I_ZB, 12], [I_RB, 50], [I_RC, 30], [I_SQ, 100], [I_SQ2, 100]]) {
    await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [it, 'صنف ' + it, 'خام', 'كجم', 5, 0]);
    await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-' + it, WH, it, q, 5]);
  }
  const ids = {};
  for (const [u, role] of [[U_A, 'manager'], [U_B, 'manager'], [U_OUT, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]); ids[u] = r[0].id;
  }
  for (const u of [U_A, U_B]) await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[u], WH, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_OUT], WC, 'test']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Professional stocktake — integration (ENFORCE=1) ═══\n');
  const ids = await seed();
  const legacyBefore = await legacyCounts();
  const admin = tok(0, 'stk_admin', 'admin', true);
  const ua = tok(ids[U_A], U_A, 'manager');
  const ub = tok(ids[U_B], U_B, 'manager');
  const uout = tok(ids[U_OUT], U_OUT, 'manager');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', STOCKTAKE_MAKER_CHECKER: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── CANONICAL CHAIN 100 → 90 → 85 → 110 → 105 ──────────────────────────
    const c = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [I_MAIN], reason: 'جرد دوري', blindCount: false }, { 'Idempotency-Key': 'stk-c1' });
    check('create → draft + STK number', c.status === 201 && c.body.status === 'draft' && /^STK-/.test(c.body.documentNumber || ''), c.body);
    const sid = c.body && c.body.id;
    // idempotent create replay (same key) → same id
    const cDup = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [I_MAIN], reason: 'جرد دوري', blindCount: false }, { 'Idempotency-Key': 'stk-c1' });
    check('create replay (same key) → same id', cDup.status === 201 && cDup.body.id === sid, { id: cDup.body && cDup.body.id });

    // no edit/delete forbidden states tested later; start now
    const st = await req('POST', `${S}/${sid}/start`, ua, {});
    check('start → counting, froze 1 line', st.status === 200 && st.body.status === 'counting' && st.body.lines === 1, st.body);
    // PATCH after start → blocked
    const patchAfter = await req('PATCH', `${S}/${sid}`, ua, { reason: 'x', expectedVersion: 2 });
    check('PATCH after start → 422 INVALID_STATE_TRANSITION', patchAfter.status === 422 && patchAfter.body.code === 'INVALID_STATE_TRANSITION', patchAfter.body && patchAfter.body.code);
    const delAfter = await req('DELETE', `${S}/${sid}`, admin);
    check('DELETE after start → 422', delAfter.status === 422, delAfter.status);

    // backdate snapshot, simulate an issue of 10 DURING the count
    await db.query('UPDATE inv_stocktakes SET snapshot_at = DATE_SUB(NOW(), INTERVAL 20 SECOND) WHERE id=?', [sid]);
    await injectMovement(I_MAIN, 'out', 10, 10); await setQty(I_MAIN, 90);
    // count 85
    const put = await req('PUT', `${S}/${sid}/counts`, ua, { counts: [{ itemId: I_MAIN, countedQty: 85 }] });
    check('counts saved (counting)', put.status === 200 && put.body.success, put.body);
    const [line] = await db.query('SELECT theoretical_qty, variance, counted_qty, net_movements FROM inv_stocktake_items WHERE stocktake_id=?', [sid]);
    check('theoretical 90 (snapshot 100 + net −10), variance −5', line.length === 1 && near(line[0].theoretical_qty, 90) && near(line[0].variance, -5) && near(line[0].net_movements, -10), line[0]);

    // simulate a receipt of 20 AFTER the count
    await injectMovement(I_MAIN, 'in', 20, 0); await setQty(I_MAIN, 110);
    check('current balance is now 110 (post-count receipt)', (await qty(I_MAIN)) === 110, await qty(I_MAIN));

    const sub = await req('POST', `${S}/${sid}/submit`, ua, {});
    check('submit → submitted', sub.status === 200 && sub.body.status === 'submitted', sub.body);
    // Maker–Checker: creator can't approve
    const apSelf = await req('POST', `${S}/${sid}/approve`, ua, {});
    check('maker–checker: creator approve own → 403', apSelf.status === 403 && apSelf.body.code === 'PERMISSION_DENIED', apSelf.body && apSelf.body.code);
    const ap = await req('POST', `${S}/${sid}/approve`, ub, {});
    check('another manager approves → approved', ap.status === 200 && ap.body.status === 'approved', ap.body);

    const post = await req('POST', `${S}/${sid}/post`, ua, {}, { 'Idempotency-Key': 'stk-p1' });
    check('post → posted', post.status === 200 && post.body.status === 'posted', post.body);
    check('CANONICAL: variance −5 applied to CURRENT 110 ⇒ qty 105', (await qty(I_MAIN)) === 105, await qty(I_MAIN));
    check('post linked an adjustment + journal', !!(post.body && post.body.adjustmentId) && !!post.body.journalId, { adj: post.body && post.body.adjustmentId, j: post.body && post.body.journalId });
    // proof: a real posted inv_adjustments + balanced GL + inv_adjustment movement
    const [adjRow] = await db.query('SELECT status FROM inv_adjustments WHERE id=?', [post.body.adjustmentId]);
    check('linked adjustment is a posted inv_adjustments row', adjRow.length === 1 && adjRow[0].status === 'posted', adjRow[0]);
    check('linked journal balanced (= |−5|×5 = 25)', await glBalanced(post.body.journalId), post.body.journalId);
    const [advMoves] = await db.query("SELECT type, qty, reference_type FROM inventory_movements WHERE reference_id=? AND reference_type='inv_adjustment'", [post.body.adjustmentId]);
    check('adjustment movement: OUT 5, reference_type inv_adjustment (single engine, no double-count)', advMoves.length === 1 && advMoves[0].type === 'out' && near(advMoves[0].qty, 5), advMoves);

    // post once only
    const postAgain = await req('POST', `${S}/${sid}/post`, ua, {}, { 'Idempotency-Key': 'stk-p1b' });
    check('post again → 409/422 (post once)', (postAgain.status === 409 || postAgain.status === 422) && (await qty(I_MAIN)) === 105, { st: postAgain.status, q: await qty(I_MAIN) });
    // idempotent replay (same key) → no double move
    const postReplay = await req('POST', `${S}/${sid}/post`, ua, {}, { 'Idempotency-Key': 'stk-p1' });
    check('post replay (same key) → no double, qty still 105', (await qty(I_MAIN)) === 105, await qty(I_MAIN));

    // ── NULL vs ZERO + uncounted excluded ──────────────────────────────────
    const c2 = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [I_ZA, I_ZB], reason: 'جرد جزئي' });
    const sid2 = c2.body.id;
    await req('POST', `${S}/${sid2}/start`, ua, {});
    // ZA counted to 0 (counted-empty → variance −8); ZB left uncounted (NULL)
    await req('PUT', `${S}/${sid2}/counts`, ua, { counts: [{ itemId: I_ZA, countedQty: 0 }] });
    await req('POST', `${S}/${sid2}/submit`, ua, {});
    await req('POST', `${S}/${sid2}/approve`, ub, {});
    const post2 = await req('POST', `${S}/${sid2}/post`, ua, {});
    check('null-vs-zero: ZA counted 0 → qty 0 (variance −8 applied)', post2.status === 200 && (await qty(I_ZA)) === 0, { st: post2.status, za: await qty(I_ZA) });
    check('uncounted ZB excluded → qty unchanged 12', (await qty(I_ZB)) === 12, await qty(I_ZB));
    const [adj2Items] = await db.query('SELECT COUNT(*) n FROM inv_adjustment_items WHERE adjustment_id=?', [post2.body.adjustmentId]);
    check('adjustment has exactly 1 line (only the counted ZA)', Number(adj2Items[0].n) === 1, adj2Items[0]);

    // ── REQUEST RECOUNT ────────────────────────────────────────────────────
    const c3 = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [I_RC], reason: 'إعادة عد' });
    const sid3 = c3.body.id;
    await req('POST', `${S}/${sid3}/start`, ua, {});
    await req('PUT', `${S}/${sid3}/counts`, ua, { counts: [{ itemId: I_RC, countedQty: 28 }] });
    await req('POST', `${S}/${sid3}/submit`, ua, {});
    const rr = await req('POST', `${S}/${sid3}/request-recount`, ub, { reason: 'الفرق يحتاج إعادة عد' });
    check('request-recount → back to counting', rr.status === 200 && rr.body.status === 'counting', rr.body);
    const rrNoReason = await req('POST', `${S}/${sid3}/request-recount`, ub, {});
    check('request-recount without reason (wrong state too) → rejected', rrNoReason.status >= 400, rrNoReason.status);

    // ── EVIDENCE GATE (large variance needs reference_evidence) ─────────────
    await db.query('UPDATE warehouse_stock SET qty=1000 WHERE warehouse_id=? AND item_id=?', [WH, I_RC]);
    const c4 = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [I_RC], reason: 'فرق كبير', evidenceThreshold: 100 });
    const sid4 = c4.body.id;
    await req('POST', `${S}/${sid4}/start`, ua, {});
    await req('PUT', `${S}/${sid4}/counts`, ua, { counts: [{ itemId: I_RC, countedQty: 500 }] }); // variance −500 × 5 = −2500
    const subBig = await req('POST', `${S}/${sid4}/submit`, ua, {});
    check('large variance submit without evidence → 422', subBig.status === 422 && subBig.body.code === 'VALIDATION_ERROR', subBig.body && subBig.body.code);
    // add evidence via PATCH (still draft? no — counting). evidence is on header; counting can't PATCH.
    // cancel this one (evidence flow proven by the block)
    await req('POST', `${S}/${sid4}/cancel`, ub, { reason: 'إغلاق اختبار الدليل' });

    // ── BLIND COUNT flag ───────────────────────────────────────────────────
    const cb = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [I_RB], reason: 'عد أعمى', blindCount: true });
    const [blindRow] = await db.query('SELECT blind_count FROM inv_stocktakes WHERE id=?', [cb.body.id]);
    check('blind_count flag stored', Number(blindRow[0].blind_count) === 1, blindRow[0]);

    // ── ROLLBACK on a forced adjustment-insert failure ─────────────────────
    await req('POST', `${S}/${cb.body.id}/start`, ua, {});
    await req('PUT', `${S}/${cb.body.id}/counts`, ua, { counts: [{ itemId: I_RB, countedQty: 40 }] }); // snapshot 50 → variance −10
    await req('POST', `${S}/${cb.body.id}/submit`, ua, {});
    await req('POST', `${S}/${cb.body.id}/approve`, ub, {});
    const rbBefore = await qty(I_RB);
    await db.query('RENAME TABLE inv_adjustment_items TO inv_adjustment_items_bak');
    const postFail = await req('POST', `${S}/${cb.body.id}/post`, ua, {});
    await db.query('RENAME TABLE inv_adjustment_items_bak TO inv_adjustment_items');
    check('forced failure during post → error + stock UNCHANGED (rollback)', postFail.status >= 400 && (await qty(I_RB)) === rbBefore, { st: postFail.status, q: await qty(I_RB), before: rbBefore });
    const [stillApproved] = await db.query('SELECT status FROM inv_stocktakes WHERE id=?', [cb.body.id]);
    check('forced failure left stocktake APPROVED (no partial post)', stillApproved[0].status === 'approved', stillApproved[0]);
    // recover: post succeeds now
    const postOk = await req('POST', `${S}/${cb.body.id}/post`, ua, {});
    check('recovery: post succeeds, qty 40 (50 − 10)', postOk.status === 200 && (await qty(I_RB)) === 40, { st: postOk.status, q: await qty(I_RB) });

    // ── 3C CLOSURE: movement-SEQUENCE window (not movement_date) ────────────
    // (a) movements at the EXACT snapshot second + multiple in one second are all
    // counted via seq (> snapshot_seq). The old `movement_date > snapshot_at`
    // window dropped same-second-as-snapshot movements (1s resolution).
    const sq = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [I_SQ], reason: 'تسلسل الحركات' });
    await req('POST', `${S}/${sq.body.id}/start`, ua, {});
    const [snapRow] = await db.query('SELECT snapshot_at FROM inv_stocktakes WHERE id=?', [sq.body.id]);
    for (let i = 0; i < 3; i++) {
      await db.query("INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, warehouse_id, reference_type, reference_id) VALUES (?, ?, ?, '', 'out', 5, 'seq', 'test', ?, 'manual', 'SEQ')",
        ['MVSEQ-' + i + '-' + Math.random().toString(36).slice(2, 6), snapRow[0].snapshot_at, I_SQ, WH]);
    }
    await setQty(I_SQ, 85);
    await req('PUT', `${S}/${sq.body.id}/counts`, ua, { counts: [{ itemId: I_SQ, countedQty: 85 }] });
    const [sqLine] = await db.query('SELECT theoretical_qty, variance, net_movements FROM inv_stocktake_items WHERE stocktake_id=?', [sq.body.id]);
    check('seq window: 3 same-second boundary movements all counted (net −15, theoretical 85, variance 0)', sqLine.length === 1 && near(sqLine[0].net_movements, -15) && near(sqLine[0].theoretical_qty, 85) && near(sqLine[0].variance, 0), sqLine[0]);

    // (b) an OFFLINE count whose observedSeq predates later movements → conflict
    // (returned for recount, NOT applied silently).
    const sq2 = await req('POST', S, ua, { warehouseId: WH, scopeType: 'items', itemIds: [I_SQ2], reason: 'عد دون اتصال' });
    await req('POST', `${S}/${sq2.body.id}/start`, ua, {});
    const det = await req('GET', `${S}/${sq2.body.id}`, ua);
    const observedSeq = det.body.currentSeq;
    await injectMovement(I_SQ2, 'out', 7, 0); await setQty(I_SQ2, 93); // a movement lands after the device counted
    const offline = await req('PUT', `${S}/${sq2.body.id}/counts`, ua, { counts: [{ itemId: I_SQ2, countedQty: 100, observedSeq }] });
    check('offline count + later movement → conflict (not applied silently)', offline.status === 200 && Array.isArray(offline.body.conflicts) && offline.body.conflicts.length === 1 && offline.body.conflicts[0].code === 'STALE_COUNT', offline.body && offline.body.conflicts);
    const [offLine] = await db.query('SELECT counted_qty FROM inv_stocktake_items WHERE stocktake_id=?', [sq2.body.id]);
    check('offline-stale line left UNCOUNTED (needs recount)', offLine.length === 1 && offLine[0].counted_qty === null, offLine[0]);
    const online = await req('PUT', `${S}/${sq2.body.id}/counts`, ua, { counts: [{ itemId: I_SQ2, countedQty: 93 }] });
    check('online recount applied (theoretical 93, variance 0)', online.body && online.body.applied === 1 && (await (async () => { const [r] = await db.query('SELECT theoretical_qty, variance FROM inv_stocktake_items WHERE stocktake_id=?', [sq2.body.id]); return near(r[0].theoretical_qty, 93) && near(r[0].variance, 0); })()), online.body);

    // ── WAREHOUSE SCOPE ────────────────────────────────────────────────────
    const outCreate = await req('POST', S, uout, { warehouseId: WH, scopeType: 'full', reason: 'خارج النطاق' });
    check('out-of-scope create in WH → 403', outCreate.status === 403, outCreate.status);
    const outDetail = await req('GET', `${S}/${sid}`, uout);
    check('out-of-scope GET detail → 403 (no leak)', outDetail.status === 403, outDetail.status);

    // ── LIST + DETAIL ──────────────────────────────────────────────────────
    const list = await req('GET', `${S}?status=posted`, admin);
    check('list → data + kpis + pagination', list.status === 200 && Array.isArray(list.body.data) && list.body.kpis && list.body.pagination, { st: list.status });
    const detail = await req('GET', `${S}/${sid}`, admin);
    check('detail → header + lines + timeline + movements + journals', detail.status === 200 && detail.body.data && Array.isArray(detail.body.lines) && Array.isArray(detail.body.timeline) && Array.isArray(detail.body.movements) && Array.isArray(detail.body.journals), { st: detail.status });
    check('detail timeline has start → submit → approve → post', detail.status === 200 && ['start', 'submit', 'approve', 'post'].every((a) => detail.body.timeline.some((e) => e.action === a)), detail.body && detail.body.timeline && detail.body.timeline.map((e) => e.action));

    // ── LEGACY UNTOUCHED ───────────────────────────────────────────────────
    const legacyAfter = await legacyCounts();
    check('legacy stocktakes/stocktake_items row counts UNCHANGED', legacyAfter.st === legacyBefore.st && legacyAfter.sti === legacyBefore.sti, { before: legacyBefore, after: legacyAfter });

  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e);
    try { await db.query('RENAME TABLE inv_adjustment_items_bak TO inv_adjustment_items'); } catch (_) {}
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
