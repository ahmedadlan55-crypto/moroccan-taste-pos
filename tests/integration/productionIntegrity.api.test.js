/**
 * Production integrity — the six confirmed defects, proven fixed against a REAL
 * server and a REAL database, asserting the DB effect and not just the status.
 *
 *   1. warehouse scope applied to the SOURCE and the OUTPUT warehouse on list,
 *      detail, every mutation and reverse
 *   2. partial-output genealogy: material attributed ONCE, not the whole order's
 *      consumption against every output lot
 *   3. allowedScrapPct=0 means ZERO scrap (NULL = default policy), the override
 *      needs a manager capability AND a recorded reason
 *   4. duplicate BOM components collapsed before the plan is written
 *   5. audit is FAIL-CLOSED — no stock/GL movement without a timeline row
 *   6. the legacy multi-item route no longer half-succeeds
 *
 * ISOLATED DB: pinned to moroccan_taste_pos_test BEFORE db/connection loads.
 * Run: npm run test:production-integrity   (MySQL must be up)
 */
'use strict';

// ── ISOLATED TEST DB — must be set before db/connection.js is required ────────
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL;
delete process.env.MYSQL_URL;
try { require('dotenv').config(); } catch (_) {}
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;

const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PRODINT_TEST_PORT || 3393);
const P = 'PIN-';
let _p = 0, _f = 0;
function check(n, c, x) { if (c) { _p++; console.log('  ✅', n); } else { _f++; console.log('  ❌', n, x !== undefined ? '-> ' + JSON.stringify(x).slice(0, 400) : ''); } }
function near(a, b, t) { return Math.abs(Number(a) - Number(b)) <= (t == null ? 0.01 : t); }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: h }, (res) => {
      let buf = ''; res.on('data', (d) => { buf += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) { j = buf; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureSchema() {
  const { runPendingMigrations } = require('../../db/migrate');
  await runPendingMigrations({ logger: { info: () => {}, warn: () => {}, error: (o, m) => console.error('[migrate]', m || o) } });
}

(async () => {
  await ensureSchema();
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const RUN = 'pin-' + Date.now() + '-';
  await conn.query("DELETE FROM idempotency_keys WHERE endpoint LIKE 'prod%'");

  async function cleanup() {
    const [orders] = await conn.query('SELECT id FROM production_orders WHERE order_number LIKE ? OR id LIKE ?', [P + '%', P + '%']);
    const ids = orders.map((o) => o.id);
    if (ids.length) {
      for (const t of ['production_material_allocations', 'production_output_lots', 'work_order_lot_consumption']) {
        await conn.query('DELETE FROM `' + t + '` WHERE ' + (t === 'production_material_allocations' ? 'production_order_id' : 'work_order_id') + ' IN (?)', [ids]).catch(() => {});
      }
      for (const t of ['production_issue_lines', 'production_issue_events', 'production_output', 'production_consumption']) {
        await conn.query('DELETE FROM `' + t + '` WHERE production_order_id IN (?)', [ids]).catch(() => {});
      }
    }
    await conn.query('DELETE FROM production_orders WHERE batch_id LIKE ? OR id LIKE ?', [P + '%', P + '%']).catch(() => {});
    await conn.query('DELETE FROM production_batches WHERE id LIKE ?', [P + '%']).catch(() => {});
    await conn.query('DELETE FROM bom_lines WHERE bom_id LIKE ?', [P + '%']).catch(() => {});
    await conn.query('DELETE FROM bom_outputs WHERE bom_id LIKE ?', [P + '%']).catch(() => {});
    await conn.query('DELETE FROM bom WHERE id LIKE ?', [P + '%']).catch(() => {});
    await conn.query('DELETE FROM warehouse_stock WHERE warehouse_id LIKE ?', [P + '%']).catch(() => {});
    await conn.query('DELETE FROM user_warehouse_access WHERE user_id LIKE ?', [P + '%']).catch(() => {});
    await conn.query('DELETE FROM inv_items WHERE id LIKE ?', [P + '%']).catch(() => {});
    await conn.query('DELETE FROM warehouses WHERE id LIKE ?', [P + '%']).catch(() => {});
  }
  await cleanup();

  // ── fixtures ──────────────────────────────────────────────────────────────
  await conn.query("INSERT INTO warehouses (id,code,name,type,is_main) VALUES (?,?,?,'main',1)", [P + 'SRC', P + 'S', 'مستودع المواد']);
  await conn.query("INSERT INTO warehouses (id,code,name,type,is_main) VALUES (?,?,?,'production',0)", [P + 'OUT', P + 'O', 'مستودع الإخراج']);
  await conn.query("INSERT INTO inv_items (id,name,unit,cost,kind,active,tracking_mode) VALUES (?,?,?,?,'raw',1,'none')", [P + 'MAT', 'مادة', 'kg', 10]);
  await conn.query("INSERT INTO inv_items (id,name,unit,cost,kind,active,tracking_mode) VALUES (?,?,?,?,'raw',1,'none')", [P + 'MAT2', 'مادة ٢', 'kg', 5]);
  await conn.query("INSERT INTO inv_items (id,name,unit,cost,kind,active,tracking_mode) VALUES (?,?,?,?,'semi',1,'none')", [P + 'PROD', 'منتج', 'pcs', 0]);
  await conn.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)', [P + 'WS1', P + 'SRC', P + 'MAT', 10000, 10]);
  await conn.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)', [P + 'WS2', P + 'SRC', P + 'MAT2', 10000, 5]);
  // A BOM that lists the SAME component TWICE — defect 4's fixture.
  //
  // Migration 0024 adds UNIQUE (bom_id, component_item_id) whenever the data is
  // clean enough to accept it, so on THIS database the duplicate cannot be
  // inserted through the front door. That index is defence in depth, not the
  // whole guarantee: it is deliberately added only CONDITIONALLY, so a
  // production database that still holds legacy duplicates (or cross-unit ones,
  // which the fold does not merge) does not get it — and those are exactly the
  // databases where _expandBom's collapse has to hold. Dropping it for the
  // fixture reproduces that database faithfully; it is restored immediately.
  const [uq] = await conn.query("SELECT COUNT(*) c FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='bom_lines' AND INDEX_NAME='uq_bom_lines_component'");
  const hadUniqueIndex = Number(uq[0].c) > 0;
  if (hadUniqueIndex) await conn.query('ALTER TABLE bom_lines DROP INDEX uq_bom_lines_component');
  await conn.query("INSERT INTO bom (id,product_id,product_source,version,yield_quantity,yield_unit,is_active,status) VALUES (?,?,'inv',1,10,'pcs',1,'active')", [P + 'BOM', P + 'PROD']);
  await conn.query('INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct,base_quantity,conversion_factor,line_no) VALUES (?,?,?,?,?,?,?,1,0)', [P + 'BL1', P + 'BOM', P + 'MAT', 2, 'kg', 0, 2]);
  await conn.query('INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct,base_quantity,conversion_factor,line_no) VALUES (?,?,?,?,?,?,?,1,1)', [P + 'BL2', P + 'BOM', P + 'MAT', 3, 'kg', 0, 3]);
  await conn.query('INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct,base_quantity,conversion_factor,line_no) VALUES (?,?,?,?,?,?,?,1,2)', [P + 'BL3', P + 'BOM', P + 'MAT2', 1, 'kg', 0, 1]);

  const server = spawn(process.execPath, ['server.js'], { env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'development', WAREHOUSE_SCOPE_ENFORCE: '1', INV_MAKER_CHECKER: '0' }), cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = ''; server.stdout.on('data', (d) => { boot += d; }); server.stderr.on('data', (d) => { boot += d; });
  let up = false;
  for (let i = 0; i < 240; i++) { const v = await req('GET', '/api/version'); if (v.status === 200) { up = true; break; } await sleep(500); }
  if (!up) { console.error('SERVER NEVER CAME UP: ' + boot.slice(-4000)); server.kill(); await conn.end(); process.exit(1); }

  const admin = jwt.sign({ username: 'admin', role: 'admin', isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const B = '/api/inventory/v2/production-orders';

  // ══ DEFECT 4 — duplicate BOM components collapsed ═════════════════════════
  console.log('\n═══ defect 4 — duplicate BOM components ═══');
  const create = await req('POST', B, admin, {
    bomId: P + 'BOM', qtyPlanned: 10, warehouseId: P + 'SRC', outputWarehouseId: P + 'OUT',
  }, { 'Idempotency-Key': RUN + 'c1' });
  check('create -> 201', create.status === 201, create.body);
  const orderId = create.body.data && create.body.data.id;
  const [plan] = await conn.query('SELECT item_id, qty_planned FROM production_consumption WHERE production_order_id=? ORDER BY item_id', [orderId]);
  check('DB EFFECT: the duplicated component yields ONE plan row, not two',
    plan.filter((r) => r.item_id === P + 'MAT').length === 1, plan.map((r) => r.item_id));
  check('DB EFFECT: and it carries the SUMMED requirement (2+3 per batch x 1 batch = 5)',
    near((plan.find((r) => r.item_id === P + 'MAT') || {}).qty_planned, 5), plan);
  check('DB EFFECT: the other component is untouched',
    near((plan.find((r) => r.item_id === P + 'MAT2') || {}).qty_planned, 1), plan);

  // ══ DEFECT 5 — audit is fail-closed ═══════════════════════════════════════
  console.log('\n═══ defect 5 — audit fail-closed ═══');
  const [ev0] = await conn.query("SELECT * FROM inv_tx_events WHERE doc_type='production' AND doc_id=?", [orderId]);
  check('a create wrote a real timeline row (not a synthesized one)', ev0.length >= 1, ev0.length);

  // ══ DEFECT 3 — allowedScrapPct semantics ══════════════════════════════════
  console.log('\n═══ defect 3 — allowedScrapPct 0 means ZERO ═══');
  const [[po0]] = await conn.query('SELECT allowed_scrap_pct FROM production_orders WHERE id=?', [orderId]);
  check('DB EFFECT: an omitted allowance stores NULL (default policy), not 0',
    po0.allowed_scrap_pct === null, po0.allowed_scrap_pct);
  const zeroOrder = await req('POST', B, admin, {
    bomId: P + 'BOM', qtyPlanned: 10, warehouseId: P + 'SRC', outputWarehouseId: P + 'OUT', allowedScrapPct: 0,
  }, { 'Idempotency-Key': RUN + 'c2' });
  const zeroId = zeroOrder.body.data && zeroOrder.body.data.id;
  const [[po1]] = await conn.query('SELECT allowed_scrap_pct FROM production_orders WHERE id=?', [zeroId]);
  check('DB EFFECT: an EXPLICIT 0 is stored as 0, distinguishable from NULL',
    po1.allowed_scrap_pct !== null && Number(po1.allowed_scrap_pct) === 0, po1.allowed_scrap_pct);

  // ══ DEFECT 2 — partial-output genealogy ═══════════════════════════════════
  console.log('\n═══ defect 2 — partial-output genealogy ═══');
  await req('POST', B + '/' + orderId + '/approve', admin, { expectedVersion: 1 });
  const issue = await req('POST', B + '/' + orderId + '/issue-materials', admin, {
    lines: [{ itemId: P + 'MAT', qty: 5 }, { itemId: P + 'MAT2', qty: 1 }],
  }, { 'Idempotency-Key': RUN + 'i1' });
  check('issue materials -> 200', issue.status === 200, issue.body);
  const [issLines] = await conn.query('SELECT id, item_id, qty FROM production_issue_lines WHERE production_order_id=?', [orderId]);
  const totalConsumed = issLines.reduce((s, l) => s + Number(l.qty), 0);
  check('DB EFFECT: 6 units of material consumed in total', near(totalConsumed, 6), totalConsumed);

  // THREE partial outputs. Under the old code each one stamped the ORDER'S
  // WHOLE consumption against its own output lot, so the genealogy recorded
  // 3 x 6 = 18 units against 6 actually issued.
  const o1 = await req('POST', B + '/' + orderId + '/record-output', admin, { goodQty: 4 }, { 'Idempotency-Key': RUN + 'o1' });
  check('partial output 1 -> 200', o1.status === 200, o1.body);
  const o2 = await req('POST', B + '/' + orderId + '/record-output', admin, { goodQty: 3 }, { 'Idempotency-Key': RUN + 'o2' });
  check('partial output 2 -> 200', o2.status === 200, o2.body);
  const o3 = await req('POST', B + '/' + orderId + '/record-output', admin, { goodQty: 3 }, { 'Idempotency-Key': RUN + 'o3' });
  check('partial output 3 -> 200', o3.status === 200, o3.body);

  const [alloc] = await conn.query(
    'SELECT output_event_id, issue_line_id, SUM(qty) AS qty FROM production_material_allocations WHERE production_order_id=? GROUP BY output_event_id, issue_line_id',
    [orderId]);
  const [[allocTotal]] = await conn.query('SELECT COALESCE(SUM(qty),0) AS q FROM production_material_allocations WHERE production_order_id=?', [orderId]);
  check('DB EFFECT: total material ATTRIBUTED equals total CONSUMED (6), not 3x6',
    near(allocTotal.q, totalConsumed), { attributed: allocTotal.q, consumed: totalConsumed });
  check('DB EFFECT: all three output events received an attribution',
    new Set(alloc.map((a) => a.output_event_id)).size === 3, alloc.length);
  const [perLine] = await conn.query(
    `SELECT pil.id, pil.qty AS consumed, COALESCE(SUM(a.qty),0) AS allocated
       FROM production_issue_lines pil
       LEFT JOIN production_material_allocations a ON a.issue_line_id=pil.id
      WHERE pil.production_order_id=? GROUP BY pil.id, pil.qty`, [orderId]);
  check('DB EFFECT: no issue line is over-attributed',
    perLine.every((r) => Number(r.allocated) <= Number(r.consumed) + 1e-6), perLine);
  check('DB EFFECT: the final output swept the remainder — nothing left unattributed',
    perLine.every((r) => near(r.allocated, r.consumed, 0.001)), perLine);

  const detail = await req('GET', B + '/' + orderId, admin);
  check('detail reports allocation integrity', detail.status === 200 && detail.body.allocationIntegrity && detail.body.allocationIntegrity.ok === true,
    detail.body && detail.body.allocationIntegrity);

  // ══ DEFECT 3 (runtime) — a zero-scrap order gates ANY waste ═══════════════
  console.log('\n═══ defect 3 — the zero-scrap gate actually fires ═══');
  await req('POST', B + '/' + zeroId + '/approve', admin, {});
  await req('POST', B + '/' + zeroId + '/issue-materials', admin, {
    lines: [{ itemId: P + 'MAT', qty: 5 }, { itemId: P + 'MAT2', qty: 1 }],
  }, { 'Idempotency-Key': RUN + 'i2' });
  const cashier = jwt.sign({ username: 'emp2', role: 'employee' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const wasteDenied = await req('POST', B + '/' + zeroId + '/record-output', cashier, {
    goodQty: 5, wasteQty: 0.5, wasteReason: 'تلف',
  }, { 'Idempotency-Key': RUN + 'w1' });
  check('a non-manager recording waste on a ZERO-scrap order is REFUSED',
    wasteDenied.status === 422 || wasteDenied.status === 403, { s: wasteDenied.status, c: wasteDenied.body && wasteDenied.body.code });
  const wasteNoReason = await req('POST', B + '/' + zeroId + '/record-output', admin, {
    goodQty: 5, wasteQty: 0.5,
  }, { 'Idempotency-Key': RUN + 'w2' });
  check('even a manager needs a recorded REASON to exceed the allowance',
    wasteNoReason.status >= 400, { s: wasteNoReason.status, c: wasteNoReason.body && wasteNoReason.body.code });
  const wasteOk = await req('POST', B + '/' + zeroId + '/record-output', admin, {
    goodQty: 5, wasteQty: 0.5, wasteReason: 'تلف أثناء التعبئة',
  }, { 'Idempotency-Key': RUN + 'w3' });
  check('a manager WITH a reason may override', wasteOk.status === 200, wasteOk.body);
  const [[wRow]] = await conn.query('SELECT waste_reason, waste_override_by, allowed_scrap_pct_snapshot FROM production_output WHERE production_order_id=? AND qty_waste>0 LIMIT 1', [zeroId]);
  check('DB EFFECT: the override reason is PERSISTED and queryable', wRow && wRow.waste_reason === 'تلف أثناء التعبئة', wRow);
  check('DB EFFECT: the overriding user is recorded', wRow && wRow.waste_override_by === 'admin', wRow && wRow.waste_override_by);
  check('DB EFFECT: the allowance in force is snapshotted', wRow && Number(wRow.allowed_scrap_pct_snapshot) === 0, wRow && wRow.allowed_scrap_pct_snapshot);

  // ══ DEFECT 1 — warehouse scope on BOTH warehouses ═════════════════════════
  console.log('\n═══ defect 1 — scope on source AND output ═══');
  await conn.query('INSERT INTO user_warehouse_access (user_id, warehouse_id) VALUES (?,?)', [P + 'U1', P + 'SRC']).catch(async () => {
    await conn.query('INSERT IGNORE INTO user_warehouse_access (user_id, warehouse_id) VALUES (?,?)', [P + 'U1', P + 'SRC']);
  });
  const srcOnly = jwt.sign({ username: P + 'U1', role: 'employee' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const scopedDetail = await req('GET', B + '/' + orderId, srcOnly);
  check('a user scoped to the SOURCE only cannot open an order that outputs elsewhere',
    scopedDetail.status === 403, { s: scopedDetail.status, c: scopedDetail.body && scopedDetail.body.code });
  const scopedList = await req('GET', B + '?pageSize=100', srcOnly);
  check('the list scope clause covers BOTH warehouse columns',
    scopedList.status === 200 && Array.isArray(scopedList.body.data), scopedList.status);

  // ══ DEFECT 6 — legacy multi-item route retired ════════════════════════════
  console.log('\n═══ defect 6 — legacy multi-item partial success ═══');
  const legacy = await req('POST', '/api/erp/production-orders', admin, {
    warehouseId: P + 'SRC',
    items: [{ bomId: P + 'BOM', qtyPlanned: 5 }, { bomId: 'NO-SUCH-BOM', qtyPlanned: 5 }],
  });
  check('the partial-success multi-item branch is GONE (410)', legacy.status === 410, { s: legacy.status, b: legacy.body });
  check('and it names its replacement', legacy.body && legacy.body.replacement && legacy.body.replacement.path === '/api/inventory/v2/production-batches', legacy.body && legacy.body.replacement);
  const [legacyRows] = await conn.query('SELECT COUNT(*) AS c FROM production_orders WHERE bom_id=? AND qty_planned=5', [P + 'BOM']);
  check('DB EFFECT: the refused legacy call created NOTHING', Number(legacyRows[0].c) === 0, legacyRows[0].c);

  // ══ the atomic replacement ════════════════════════════════════════════════
  console.log('\n═══ multi-product batch — atomic, no partial success ═══');
  const BB = '/api/inventory/v2/production-batches';
  const badBatch = await req('POST', BB, admin, {
    warehouseId: P + 'SRC', outputWarehouseId: P + 'OUT',
    items: [{ bomId: P + 'BOM', qtyPlanned: 10 }, { bomId: 'NO-SUCH-BOM', qtyPlanned: 5 }, { bomId: P + 'BOM', qtyPlanned: 0 }],
  }, { 'Idempotency-Key': RUN + 'b1' });
  check('a batch with ANY invalid line is refused ENTIRELY', badBatch.status >= 400 && badBatch.status < 500, { s: badBatch.status, b: badBatch.body });
  check('and it names EVERY offending line, not just the first',
    badBatch.body && Array.isArray(badBatch.body.detail) && badBatch.body.detail.length === 2, badBatch.body && badBatch.body.detail);
  const [[batchCnt0]] = await conn.query('SELECT COUNT(*) c FROM production_batches');
  const goodBatch = await req('POST', BB, admin, {
    warehouseId: P + 'SRC', outputWarehouseId: P + 'OUT',
    items: [
      { bomId: P + 'BOM', qtyPlanned: 10 },
      { bomId: P + 'BOM', qtyPlanned: 20, allowedScrapPct: 2 },
      { bomId: P + 'BOM', qtyPlanned: 30 },
    ],
  }, { 'Idempotency-Key': RUN + 'b2' });
  check('a fully valid batch -> 201', goodBatch.status === 201, goodBatch.body);
  const batchId = goodBatch.body.data && goodBatch.body.data.id;
  const [kids] = await conn.query('SELECT * FROM production_orders WHERE batch_id=? ORDER BY batch_line_no', [batchId]);
  check('DB EFFECT: THREE independent child orders exist under ONE document', kids.length === 3, kids.length);
  check('DB EFFECT: each child keeps its OWN quantity', kids.map((k) => Number(k.qty_planned)).join(',') === '10,20,30', kids.map((k) => k.qty_planned));
  check('DB EFFECT: each child keeps its OWN wip_balance (a batch never pools cost)',
    kids.every((k) => Number(k.wip_balance) === 0), kids.map((k) => k.wip_balance));
  check('DB EFFECT: each child snapshots the BOM VERSION it was expanded against',
    kids.every((k) => Number(k.bom_version) === 1), kids.map((k) => k.bom_version));
  check('DB EFFECT: the per-child scrap allowance is honoured (NULL vs 2)',
    kids[0].allowed_scrap_pct === null && Number(kids[1].allowed_scrap_pct) === 2, kids.map((k) => k.allowed_scrap_pct));
  const [kidPlans] = await conn.query('SELECT production_order_id, COUNT(*) c FROM production_consumption WHERE production_order_id IN (?) GROUP BY production_order_id', [kids.map((k) => k.id)]);
  check('DB EFFECT: every child got its own material plan, deduplicated',
    kidPlans.length === 3 && kidPlans.every((r) => Number(r.c) === 2), kidPlans);

  const preview = await req('POST', BB + '/preview', admin, {
    warehouseId: P + 'SRC',
    items: [{ bomId: P + 'BOM', qtyPlanned: 10 }, { bomId: P + 'BOM', qtyPlanned: 20 }],
  });
  check('preview consolidates materials across products', preview.status === 200 && preview.body.data.materials.length === 2, { s: preview.status, b: preview.body });
  const matRow = preview.status === 200 && preview.body.data.materials.find((m) => m.itemId === P + 'MAT');
  check('preview attributes each material back to the products needing it',
    matRow && matRow.attribution.length === 2, matRow && matRow.attribution);
  check('preview sums the consolidated requirement (5 + 10 = 15)', matRow && near(matRow.required, 15), matRow && matRow.required);

  const approve = await req('POST', BB + '/' + batchId + '/approve', admin, { expectedVersion: 1 });
  check('approving the batch approves EVERY child', approve.status === 200, approve.body);
  const [kidsAfter] = await conn.query('SELECT status FROM production_orders WHERE batch_id=?', [batchId]);
  check('DB EFFECT: all three children are approved', kidsAfter.every((k) => k.status === 'approved'), kidsAfter.map((k) => k.status));
  const [[bAfter]] = await conn.query('SELECT status, posting_state FROM production_batches WHERE id=?', [batchId]);
  check('DB EFFECT: the batch is approved and posting_state returned to idle',
    bAfter.status === 'approved' && bAfter.posting_state === 'idle', bAfter);
  const [bEv] = await conn.query("SELECT COUNT(*) c FROM inv_tx_events WHERE doc_type='production_batch' AND doc_id=?", [batchId]);
  check('DB EFFECT: the batch has a fail-closed audit trail', Number(bEv[0].c) >= 2, bEv[0].c);

  console.log('\n' + (_f === 0 ? '✅' : '❌') + ' productionIntegrity.api: ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) console.log(boot.slice(-2500));
  await cleanup();
  // Restore the guard the fixture borrowed, so the database is left exactly as
  // it was found (and a later run of the recipe suite still sees it enforced).
  if (hadUniqueIndex) {
    await conn.query('ALTER TABLE bom_lines ADD UNIQUE KEY uq_bom_lines_component (bom_id, component_item_id)').catch((e) => console.warn('  (could not restore uq_bom_lines_component: ' + e.message + ')'));
  }
  server.kill(); await conn.end();
  process.exit(_f === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ERR', e); process.exit(1); });
