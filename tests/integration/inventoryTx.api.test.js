/**
 * Phase 3B — Independent inventory transactions integration test (ENFORCE=1).
 *
 * Boots server.js with WAREHOUSE_SCOPE_ENFORCE=1 and exercises receipts, issues
 * and adjustments end-to-end against /api/inventory/v2:
 *   • the canonical numeric chain: open 100@5 → receipt 50@7 (qty150/val850/WAC5.6667
 *     /GL350) → issue 30 (qty120/WAC stable/val30·WAC) → adjust counted110
 *     (delta−10/GL10·WAC); GL balanced & equals the value at every step.
 *   • lifecycle: create → approve(no stock) → post → reverse(frozen cost).
 *   • draft edit keeps the number + version guard; no edit/delete after post.
 *   • COST_REQUIRED, INSUFFICIENT_STOCK (block + rollback), QUANTITY_CONFLICT.
 *   • idempotency replay + same-key/different-payload → IDEMPOTENCY_CONFLICT.
 *   • two concurrent posts → one 200 / one 409; stock moved exactly once.
 *   • RBAC (employee can't approve), scope (out-of-scope → 403), actor from JWT.
 *   • Maker–Checker: creator can't approve own adjustment; another approver can.
 *   • no double-counting: movements carry inv_* reference_types, never 'transfer'.
 *
 * Run: node tests/integration/inventoryTx.api.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.INVTX_TEST_PORT || 3207);
const BASE = { host: '127.0.0.1', port: PORT };
const WA = 'WH-3B-A', WC = 'WH-3B-C';
const ITEM = 'INVTX-ITEM';
const U_A = 'invtx_a', U_B = 'invtx_b', U_EMP = 'invtx_emp', U_OUT = 'invtx_out';

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

async function qty(wh) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [wh, ITEM]); return r.length ? Number(r[0].qty) : 0; }
async function wac(wh) { const [r] = await db.query('SELECT avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [wh, ITEM]); return r.length ? Number(r[0].avg_cost) : 0; }
async function glTotals(journalId) { const [r] = await db.query('SELECT total_debit, total_credit FROM gl_journals WHERE id=?', [journalId]); return r.length ? { d: Number(r[0].total_debit), c: Number(r[0].total_credit) } : null; }
async function movesFor(refId) { const [r] = await db.query('SELECT type, qty, reference_type FROM inventory_movements WHERE reference_id=? ORDER BY id', [refId]); return r; }
async function ensureGl() {
  await db.query("CREATE TABLE IF NOT EXISTS gl_journals (id VARCHAR(50) PRIMARY KEY, journal_number VARCHAR(20), journal_date DATE, reference_type VARCHAR(50), reference_id VARCHAR(100), description TEXT, total_debit DECIMAL(14,2) DEFAULT 0, total_credit DECIMAL(14,2) DEFAULT 0, period_id VARCHAR(50), status ENUM('posted','draft') DEFAULT 'posted', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(100), posted_by VARCHAR(100) DEFAULT '', posted_at DATETIME, brand_id VARCHAR(50) NULL, branch_id VARCHAR(50) NULL, project_id VARCHAR(50) NULL, cost_center_id VARCHAR(50) NULL, UNIQUE KEY uq_journal_number (journal_number)) ENGINE=InnoDB");
}

async function cleanup() {
  const sqls = [
    ['DELETE e FROM inv_tx_events e JOIN inv_receipts d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)', [WA, WC]],
    ['DELETE e FROM inv_tx_events e JOIN inv_issues d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)', [WA, WC]],
    ['DELETE e FROM inv_tx_events e JOIN inv_adjustments d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)', [WA, WC]],
    ['DELETE i FROM inv_receipt_items i JOIN inv_receipts d ON d.id=i.receipt_id WHERE d.warehouse_id IN (?,?)', [WA, WC]],
    ['DELETE i FROM inv_issue_items i JOIN inv_issues d ON d.id=i.issue_id WHERE d.warehouse_id IN (?,?)', [WA, WC]],
    ['DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id IN (?,?)', [WA, WC]],
    ['DELETE FROM inv_receipts WHERE warehouse_id IN (?,?)', [WA, WC]],
    ['DELETE FROM inv_issues WHERE warehouse_id IN (?,?)', [WA, WC]],
    ['DELETE FROM inv_adjustments WHERE warehouse_id IN (?,?)', [WA, WC]],
    ["DELETE FROM inventory_movements WHERE reference_type LIKE 'inv\\_%' AND warehouse_id IN (?,?)", [WA, WC]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [WA, WC]],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type LIKE 'inv\\_%' AND (j.reference_id LIKE 'RCV-%' OR j.reference_id LIKE 'ISU-%' OR j.reference_id LIKE 'ADV-%')", []],
    ["DELETE FROM gl_journals WHERE reference_type LIKE 'inv\\_%' AND (reference_id LIKE 'RCV-%' OR reference_id LIKE 'ISU-%' OR reference_id LIKE 'ADV-%')", []],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?,?,?)', [U_A, U_B, U_EMP, U_OUT]],
    ['DELETE FROM idempotency_keys WHERE username=?', ['invtx_admin']],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?,?,?)', [U_A, U_B, U_EMP, U_OUT]],
    ['DELETE FROM inv_items WHERE id=?', [ITEM]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WA, WC]],
    ['DELETE FROM users WHERE username IN (?,?,?,?)', [U_A, U_B, U_EMP, U_OUT]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  await ensureGl();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WA, '3BA', 'مستودع رئيسي', 'main']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [WC, '3BC', 'مستودع بعيد', 'branch']);
  await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [ITEM, 'صنف اختبار', 'خام', 'كجم', 5, 2]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-3BA', WA, ITEM, 100, 5]);
  const ids = {};
  for (const [u, role] of [[U_A, 'manager'], [U_B, 'manager'], [U_EMP, 'employee'], [U_OUT, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  for (const u of [U_A, U_B, U_EMP]) await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[u], WA, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_OUT], WC, 'test']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Independent inventory transactions — integration (ENFORCE=1) ═══\n');
  const ids = await seed();
  const admin = tok(0, 'invtx_admin', 'admin', true);
  const ua = tok(ids[U_A], U_A, 'manager');
  const ub = tok(ids[U_B], U_B, 'manager');
  const uemp = tok(ids[U_EMP], U_EMP, 'employee');
  const uout = tok(ids[U_OUT], U_OUT, 'manager');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', INV_MAKER_CHECKER: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  const R = '/api/inventory/v2/receipts', I = '/api/inventory/v2/issues', A = '/api/inventory/v2/adjustments';
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ─────────────────────────────────────────────────────────────────────
    // RECEIPT — create → approve → post (50 @ 7)
    // ─────────────────────────────────────────────────────────────────────
    const rc = await req('POST', R, admin, { warehouseId: WA, sourceRef: 'فتح رصيد', items: [{ itemId: ITEM, qty: 50, unitCost: 7 }] }, { 'Idempotency-Key': 'rcv-create' });
    check('receipt create → draft v1 + RCV number', rc.status === 201 && rc.body.status === 'draft' && rc.body.version === 1 && /^RCV-/.test(rc.body.documentNumber || ''), rc.body);
    const rid = rc.body && rc.body.id;
    const rnum = rc.body && rc.body.documentNumber;

    // cost required
    const rcNoCost = await req('POST', R, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 5 }] });
    check('receipt without cost → 422 COST_REQUIRED', rcNoCost.status === 422 && rcNoCost.body.code === 'COST_REQUIRED', rcNoCost.body && rcNoCost.body.code);

    // draft edit keeps number + needs expectedVersion
    const rPatchNoV = await req('PATCH', `${R}/${rid}`, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 50, unitCost: 7 }] });
    check('receipt PATCH without expectedVersion → 422', rPatchNoV.status === 422, rPatchNoV.status);
    const rPatch = await req('PATCH', `${R}/${rid}`, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 50, unitCost: 7 }], notes: 'محدّث', expectedVersion: 1 });
    check('receipt PATCH keeps number, version→2', rPatch.status === 200 && rPatch.body.documentNumber === rnum && rPatch.body.version === 2, rPatch.body);

    const rApprove = await req('POST', `${R}/${rid}/approve`, admin, { expectedVersion: 2 });
    check('receipt approve → approved v3, NO stock moved', rApprove.status === 200 && rApprove.body.status === 'approved' && (await qty(WA)) === 100, { st: rApprove.body && rApprove.body.status, qty: await qty(WA) });

    const rPost = await req('POST', `${R}/${rid}/post`, admin, { expectedVersion: 3 }, { 'Idempotency-Key': 'rcv-post' });
    const wac1 = await wac(WA);
    const glr = rPost.body && rPost.body.journalId ? await glTotals(rPost.body.journalId) : null;
    check('receipt post → posted, qty 150', rPost.status === 200 && rPost.body.status === 'posted' && (await qty(WA)) === 150, { st: rPost.body && rPost.body.status, qty: await qty(WA) });
    check('receipt WAC = 5.6667', near(wac1, 5.6667, 0.0002), wac1);
    check('receipt affectedValue = 350', near(rPost.body && rPost.body.affectedValue, 350), rPost.body && rPost.body.affectedValue);
    check('receipt GL balanced & = 350', glr && near(glr.d, glr.c, 0.01) && near(glr.d, 350), glr);
    const rmoves = await movesFor(rid);
    check('receipt movement: 1 IN of 50, reference_type inv_receipt', rmoves.length === 1 && rmoves[0].type === 'in' && Number(rmoves[0].qty) === 50 && rmoves[0].reference_type === 'inv_receipt', rmoves);

    // idempotent post replay (same key) → no double stock
    const rPostReplay = await req('POST', `${R}/${rid}/post`, admin, { expectedVersion: 3 }, { 'Idempotency-Key': 'rcv-post' });
    check('receipt post replay (same key) → no double, qty still 150', (await qty(WA)) === 150, await qty(WA));

    // idempotency conflict: same create key, different payload
    const rConf = await req('POST', R, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 99, unitCost: 7 }] }, { 'Idempotency-Key': 'rcv-create' });
    check('same key + different payload → 409 IDEMPOTENCY_CONFLICT', rConf.status === 409 && rConf.body.code === 'IDEMPOTENCY_CONFLICT', rConf.body && rConf.body.code);

    // no edit/delete after post
    const rEditPosted = await req('PATCH', `${R}/${rid}`, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 1, unitCost: 7 }], expectedVersion: 4 });
    check('PATCH posted receipt → 422 INVALID_STATE_TRANSITION', rEditPosted.status === 422 && rEditPosted.body.code === 'INVALID_STATE_TRANSITION', rEditPosted.body && rEditPosted.body.code);
    const rDelPosted = await req('DELETE', `${R}/${rid}`, admin);
    check('DELETE posted receipt → 422', rDelPosted.status === 422, rDelPosted.status);

    // ─────────────────────────────────────────────────────────────────────
    // ISSUE — create → approve → post (30)
    // ─────────────────────────────────────────────────────────────────────
    const icNoReason = await req('POST', I, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 5 }] });
    check('issue without reason → 422', icNoReason.status === 422, icNoReason.body && icNoReason.body.code);
    const ic = await req('POST', I, admin, { warehouseId: WA, reason: 'صرف للمطبخ', items: [{ itemId: ITEM, qty: 30 }] });
    check('issue create → draft', ic.status === 201 && ic.body.status === 'draft' && /^ISU-/.test(ic.body.documentNumber || ''), ic.body);
    const iid = ic.body && ic.body.id;
    await req('POST', `${I}/${iid}/approve`, admin, {});
    const iPost = await req('POST', `${I}/${iid}/post`, admin, {}, { 'Idempotency-Key': 'isu-post' });
    const wac2 = await wac(WA);
    const gli = iPost.body && iPost.body.journalId ? await glTotals(iPost.body.journalId) : null;
    check('issue post → qty 120', iPost.status === 200 && (await qty(WA)) === 120, { st: iPost.status, qty: await qty(WA) });
    check('issue WAC unchanged = 5.6667', near(wac2, 5.6667, 0.0002), wac2);
    check('issue value = 30 × WAC ≈ 170', near(iPost.body && iPost.body.affectedValue, 170), iPost.body && iPost.body.affectedValue);
    check('issue GL balanced & = value', gli && near(gli.d, gli.c, 0.01) && near(gli.d, 170), gli);
    const imoves = await movesFor(iid);
    check('issue movement: 1 OUT of 30, inv_issue', imoves.length === 1 && imoves[0].type === 'out' && Number(imoves[0].qty) === 30 && imoves[0].reference_type === 'inv_issue', imoves);

    // insufficient stock blocks + rollback (try to issue 100000)
    const qBefore = await qty(WA);
    const iBig = await req('POST', I, admin, { warehouseId: WA, reason: 'صرف ضخم', items: [{ itemId: ITEM, qty: 100000 }] });
    const iBigPost = iBig.body && iBig.body.id ? (await req('POST', `${I}/${iBig.body.id}/approve`, admin, {}), await req('POST', `${I}/${iBig.body.id}/post`, admin, {})) : { status: 0 };
    check('over-issue → 422 INSUFFICIENT_STOCK, stock unchanged (rollback)', iBigPost.status === 422 && iBigPost.body.code === 'INSUFFICIENT_STOCK' && (await qty(WA)) === qBefore, { st: iBigPost.status, code: iBigPost.body && iBigPost.body.code, qty: await qty(WA) });

    // ─────────────────────────────────────────────────────────────────────
    // ADJUSTMENT — countedQty 110 (system 120) → delta −10
    // ─────────────────────────────────────────────────────────────────────
    const ac = await req('POST', A, ua, { warehouseId: WA, reason: 'جرد دوري', items: [{ itemId: ITEM, countedQty: 110 }] });
    check('adjustment create (server computes delta −10)', ac.status === 201 && /^ADV-/.test(ac.body.documentNumber || ''), ac.body);
    const aid = ac.body && ac.body.id;
    const [aLine] = await db.query('SELECT system_qty_snapshot, counted_qty, delta FROM inv_adjustment_items WHERE adjustment_id=?', [aid]);
    check('adjustment snapshot 120, counted 110, delta −10 (backend)', aLine.length === 1 && Number(aLine[0].system_qty_snapshot) === 120 && Number(aLine[0].counted_qty) === 110 && Number(aLine[0].delta) === -10, aLine[0]);

    // Maker–Checker: creator (U_A) cannot approve own adjustment
    const akSelf = await req('POST', `${A}/${aid}/approve`, ua, {});
    check('maker–checker: creator approve own → 403 PERMISSION_DENIED', akSelf.status === 403 && akSelf.body.code === 'PERMISSION_DENIED', akSelf.body && akSelf.body.code);
    // a DIFFERENT manager (U_B) can approve
    const akOther = await req('POST', `${A}/${aid}/approve`, ub, {});
    check('maker–checker: another approver → 200', akOther.status === 200 && akOther.body.status === 'approved', akOther.body);

    const aPost = await req('POST', `${A}/${aid}/post`, ua, {}, { 'Idempotency-Key': 'adv-post' });
    const wac3 = await wac(WA);
    const gla = aPost.body && aPost.body.journalId ? await glTotals(aPost.body.journalId) : null;
    check('adjustment post → qty 110', aPost.status === 200 && (await qty(WA)) === 110, { st: aPost.status, qty: await qty(WA) });
    check('adjustment WAC unchanged = 5.6667', near(wac3, 5.6667, 0.0002), wac3);
    check('adjustment GL balanced & = 10×WAC ≈ 56.67', gla && near(gla.d, gla.c, 0.01) && near(gla.d, 56.67), gla);
    const amoves = await movesFor(aid);
    check('adjustment movement: 1 OUT of 10, inv_adjustment', amoves.length === 1 && amoves[0].type === 'out' && Number(amoves[0].qty) === 10 && amoves[0].reference_type === 'inv_adjustment', amoves);

    // QUANTITY_CONFLICT: snapshot a NEW adjustment, then move stock, then post → conflict
    const ac2 = await req('POST', A, ua, { warehouseId: WA, reason: 'جرد ثانٍ', items: [{ itemId: ITEM, countedQty: 100 }] }); // snapshot 110
    await req('POST', `${A}/${ac2.body.id}/approve`, ub, {});
    // move stock underneath via a quick posted receipt (+5)
    const bump = await req('POST', R, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 5, unitCost: 7 }] });
    await req('POST', `${R}/${bump.body.id}/approve`, admin, {});
    await req('POST', `${R}/${bump.body.id}/post`, admin, {});
    const ac2Post = await req('POST', `${A}/${ac2.body.id}/post`, ua, {});
    check('adjustment post after balance changed → 409 QUANTITY_CONFLICT', ac2Post.status === 409 && ac2Post.body.code === 'QUANTITY_CONFLICT', ac2Post.body && ac2Post.body.code);

    // ─────────────────────────────────────────────────────────────────────
    // REVERSE — receipt reverse (frozen cost), then issue reverse
    // ─────────────────────────────────────────────────────────────────────
    const qPreRev = await qty(WA);
    const rRev = await req('POST', `${R}/${rid}/reverse`, admin, { reason: 'إلغاء استلام خاطئ' }, { 'Idempotency-Key': 'rcv-rev' });
    check('receipt reverse → reversed, qty −50', rRev.status === 200 && rRev.body.status === 'reversed' && (await qty(WA)) === qPreRev - 50, { st: rRev.status, qty: await qty(WA) });
    const qAfterRev = await qty(WA);
    const rRevDup = await req('POST', `${R}/${rid}/reverse`, admin, { reason: 'مكرر' });
    check('duplicate reverse blocked (409/422) + no further stock move', (rRevDup.status === 409 || rRevDup.status === 422) && (await qty(WA)) === qAfterRev, { st: rRevDup.status, qty: await qty(WA) });

    const qPreIrev = await qty(WA);
    const iRev = await req('POST', `${I}/${iid}/reverse`, admin, { reason: 'إرجاع صرف' });
    check('issue reverse → qty +30 (frozen cost)', iRev.status === 200 && (await qty(WA)) === qPreIrev + 30, { st: iRev.status, qty: await qty(WA) });

    // ─────────────────────────────────────────────────────────────────────
    // CONCURRENCY — two posts of one approved receipt → one 200 / one 409
    // ─────────────────────────────────────────────────────────────────────
    const rcC = await req('POST', R, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 8, unitCost: 6 }] });
    await req('POST', `${R}/${rcC.body.id}/approve`, admin, { expectedVersion: 1 });
    const qBeforeC = await qty(WA);
    const [p1, p2] = await Promise.all([
      req('POST', `${R}/${rcC.body.id}/post`, admin, { expectedVersion: 2 }),
      req('POST', `${R}/${rcC.body.id}/post`, admin, { expectedVersion: 2 }),
    ]);
    const wins = [p1, p2].filter((x) => x.status === 200).length;
    const conflicts = [p1, p2].filter((x) => x.status === 409).length;
    check('concurrent post → exactly one 200 / one 409', wins === 1 && conflicts === 1, { s1: p1.status, s2: p2.status });
    check('concurrent post moved stock exactly once (+8)', (await qty(WA)) === qBeforeC + 8, { before: qBeforeC, after: await qty(WA) });

    // ─────────────────────────────────────────────────────────────────────
    // RBAC + scope + actor
    // ─────────────────────────────────────────────────────────────────────
    const rcEmp = await req('POST', R, admin, { warehouseId: WA, items: [{ itemId: ITEM, qty: 1, unitCost: 7 }] });
    const empApprove = await req('POST', `${R}/${rcEmp.body.id}/approve`, uemp, {});
    check('employee approve → 403 (RBAC)', empApprove.status === 403, empApprove.status);
    const outCreate = await req('POST', R, uout, { warehouseId: WA, items: [{ itemId: ITEM, qty: 1, unitCost: 7 }] });
    check('out-of-scope create in WA → 403 WAREHOUSE_ACCESS_DENIED', outCreate.status === 403, outCreate.status);
    const outDetail = await req('GET', `${R}/${rid}`, uout);
    check('out-of-scope GET detail → 403 (no leak)', outDetail.status === 403, outDetail.status);

    // ─────────────────────────────────────────────────────────────────────
    // No double-counting: every movement for the item is an inv_* type (never 'transfer')
    // ─────────────────────────────────────────────────────────────────────
    const [mref] = await db.query("SELECT DISTINCT reference_type FROM inventory_movements WHERE item_id=? AND warehouse_id=?", [ITEM, WA]);
    const [allref] = await db.query("SELECT reference_type, COUNT(*) n FROM inventory_movements WHERE item_id=? AND warehouse_id=? GROUP BY reference_type", [ITEM, WA]);
    const noTransfer = allref.every((r) => /^inv_/.test(r.reference_type || ''));
    check('no double-count: all movements are inv_* (never transfer)', noTransfer, allref);

    // list + KPIs + detail timeline
    const list = await req('GET', `${R}?status=reversed`, admin);
    check('receipts list returns data + kpis + pagination', list.status === 200 && Array.isArray(list.body.data) && list.body.kpis && list.body.pagination, { st: list.status });
    const detail = await req('GET', `${R}/${rid}`, admin);
    check('receipt detail → header + lines + timeline + movements + journals', detail.status === 200 && detail.body.data && Array.isArray(detail.body.lines) && Array.isArray(detail.body.timeline) && Array.isArray(detail.body.movements) && Array.isArray(detail.body.journals), { st: detail.status });
    check('detail timeline has create→post→reverse', detail.status === 200 && detail.body.timeline.some((e) => e.action === 'post') && detail.body.timeline.some((e) => e.action === 'reverse'), detail.body && detail.body.timeline && detail.body.timeline.map((e) => e.action));

  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
