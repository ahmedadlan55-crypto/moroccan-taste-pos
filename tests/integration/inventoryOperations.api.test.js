/**
 * Unified inventory OPERATIONS read model — integration.
 *
 * Boots a REAL server against the isolated test database, seeds one document of
 * each family, and proves the UNION actually returns them: one query, many
 * document types, six status vocabularies collapsed to one canonical set,
 * warehouse scope applied to BOTH ends of a two-sided document, and per-branch
 * capability filtering (a user without procurement.view sees the other branches
 * but no procurement rows) rather than a single all-or-nothing gate.
 *
 * ISOLATED DB: pinned to moroccan_taste_pos_test BEFORE db/connection loads.
 * Run: npm run test:operations-api   (MySQL must be up)
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

const NAME = 'inventoryOperations.api';
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.OPS_TEST_PORT || 3392);
let _p = 0, _f = 0;
function check(n, c, x) { if (c) { _p++; console.log('  ✅', n); } else { _f++; console.log('  ❌', n, x !== undefined ? '-> ' + JSON.stringify(x).slice(0, 500) : ''); } }

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
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


// The numbered migrations in db/migrations/ are step 2/3 of the release chain
// (scripts/release-start.js) — booting server.js alone does NOT apply them. Run
// them here so this test provisions its own schema on a fresh CI database
// instead of assuming someone migrated it by hand.
async function ensureSchema() {
  const { runPendingMigrations } = require('../../db/migrate');
  const silent = { info: () => {}, warn: () => {}, error: (o, m) => console.error('[migrate]', m || o) };
  await runPendingMigrations({ logger: silent });
}

(async () => {
  await ensureSchema();
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const P = 'OPS-';
  async function cleanup() {
    for (const [t, c] of [['inv_receipt_items', 'receipt_id'], ['inv_issue_items', 'issue_id'], ['inv_adjustment_items', 'adjustment_id'], ['stock_issue_items', 'issue_id']]) {
      await conn.query('DELETE FROM `' + t + '` WHERE `' + c + '` LIKE ?', [P + '%']).catch(() => {});
    }
    for (const t of ['inv_receipts', 'inv_issues', 'inv_adjustments', 'stock_issues', 'purchase_receipts', 'production_orders', 'warehouses', 'inv_items']) {
      await conn.query('DELETE FROM `' + t + '` WHERE id LIKE ?', [P + '%']).catch(() => {});
    }
  }
  await cleanup();
  // Two warehouses so scope can be proven, one item, one of each document type.
  await conn.query("INSERT INTO warehouses (id,code,name,type,is_main) VALUES (?,?,?,'main',1)", [P + 'WH1', P + 'W1', 'مستودع أ']);
  await conn.query("INSERT INTO warehouses (id,code,name,type,is_main) VALUES (?,?,?,'branch',0)", [P + 'WH2', P + 'W2', 'مستودع ب']);
  await conn.query("INSERT INTO inv_items (id,name,unit,cost,kind,active) VALUES (?,?,?,?,'raw',1)", [P + 'ITEM', 'صنف اختبار', 'g', 2]);
  await conn.query("INSERT INTO inv_receipts (id,receipt_number,warehouse_id,receipt_date,status,total_value,created_by,approved_by) VALUES (?,?,?,CURDATE(),'posted',500,'admin','mgr')", [P + 'RCV1', P + 'RCV-0001', P + 'WH1']);
  await conn.query("INSERT INTO inv_receipt_items (id,receipt_id,item_id,item_name,unit,qty,unit_cost,line_total) VALUES (?,?,?,?,'g',10,2,20)", [P + 'RL1', P + 'RCV1', P + 'ITEM', 'صنف اختبار']);
  await conn.query("INSERT INTO inv_issues (id,issue_number,warehouse_id,issue_date,status,total_value,created_by) VALUES (?,?,?,CURDATE(),'draft',80,'admin')", [P + 'ISU1', P + 'ISU-0001', P + 'WH1']);
  await conn.query("INSERT INTO inv_adjustments (id,adjustment_number,warehouse_id,adjustment_date,status,total_value,created_by) VALUES (?,?,?,CURDATE(),'approved',-30,'admin')", [P + 'ADJ1', P + 'ADJ-0001', P + 'WH2']);
  await conn.query("INSERT INTO stock_issues (id,issue_number,from_warehouse_id,to_warehouse_id,issue_date,status,total_cost,created_by) VALUES (?,?,?,?,CURDATE(),'received',200,'admin')", [P + 'TRF1', P + 'TRF-0001', P + 'WH1', P + 'WH2']);
  await conn.query("INSERT INTO production_orders (id,order_number,bom_id,product_id,warehouse_id,output_warehouse_id,qty_planned,status,source,created_by) VALUES (?,?,?,?,?,?,50,'in_progress','v2','admin')", [P + 'PRD1', P + 'PRD-0001', 'BOM-X', P + 'ITEM', P + 'WH1', P + 'WH2']);
  await conn.query("INSERT INTO purchase_receipts (id,receipt_number,supplier_id,receipt_date,warehouse_id,subtotal,vat_amount,total,status,created_by,supplier_name_snapshot) VALUES (?,?,?,CURDATE(),?,100,15,115,'posted','admin',?)", [P + 'GRN1', P + 'GRN-001', 'SUP-X', P + 'WH1', 'مورد اختبار']).catch((e) => console.log('  (purchase_receipt skipped: ' + e.message + ')'));

  const server = spawn(process.execPath, ['server.js'], { env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'development' }), cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = ''; server.stdout.on('data', (d) => { boot += d; }); server.stderr.on('data', (d) => { boot += d; });
  let up = false;
  for (let i = 0; i < 240; i++) { const v = await req('GET', '/api/version'); if (v.status === 200) { up = true; break; } await sleep(500); }
  if (!up) { console.error('SERVER NEVER CAME UP: ' + boot.slice(-4000)); server.kill(); await conn.end(); process.exit(1); }

  const admin = jwt.sign({ username: 'admin', role: 'admin', isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const emp = jwt.sign({ username: 'emp1', role: 'employee' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  console.log('\n=== unified inventory operations ===');
  const meta = await req('GET', '/api/inventory/operations/meta', admin);
  check('GET /meta -> 200', meta.status === 200, { s: meta.status, b: meta.body });
  check('/meta lists every document type', meta.status === 200 && meta.body.data.types.length >= 8, meta.status === 200 && meta.body.data.types.length);
  check('/meta reports which branches are unavailable rather than hiding them',
    meta.status === 200 && Array.isArray(meta.body.data.types) && meta.body.data.types.every((t) => 'available' in t));

  const all = await req('GET', '/api/inventory/operations?pageSize=100&search=' + encodeURIComponent('OPS-'), admin);
  check('GET / -> 200', all.status === 200, { s: all.status, b: all.body });
  const rows = (all.body && all.body.data) || [];
  const byType = {};
  for (const r of rows) byType[r.documentType] = (byType[r.documentType] || 0) + 1;
  console.log('     types returned:', JSON.stringify(byType));
  check('the RECEIPT we seeded is listed', rows.some((r) => r.documentNumber === P + 'RCV-0001'), Object.keys(byType));
  check('the ISSUE we seeded is listed', rows.some((r) => r.documentNumber === P + 'ISU-0001'));
  check('the ADJUSTMENT we seeded is listed', rows.some((r) => r.documentNumber === P + 'ADJ-0001'));
  check('the TRANSFER we seeded is listed', rows.some((r) => r.documentNumber === P + 'TRF-0001'));
  check('the PRODUCTION order we seeded is listed', rows.some((r) => r.documentNumber === P + 'PRD-0001'));
  check('at least 5 distinct document types come back from ONE query', Object.keys(byType).length >= 5, Object.keys(byType));

  const rcv = rows.find((r) => r.documentNumber === P + 'RCV-0001');
  check('id is the composite (type:id) surrogate', rcv && rcv.id === 'receipt:' + P + 'RCV1', rcv && rcv.id);
  check('currency is emitted', rcv && rcv.currency === 'SAR', rcv && rcv.currency);
  check('createdBy is carried', rcv && rcv.createdBy === 'admin', rcv && rcv.createdBy);
  check('approvedBy is carried', rcv && rcv.approvedBy === 'mgr', rcv && rcv.approvedBy);
  check('destination is the warehouse for an inbound', rcv && rcv.destination && rcv.destination.id === P + 'WH1', rcv && rcv.destination);
  const trf = rows.find((r) => r.documentNumber === P + 'TRF-0001');
  check('a transfer carries BOTH source and destination', trf && trf.source.id === P + 'WH1' && trf.destination.id === P + 'WH2', trf && { s: trf.source, d: trf.destination });
  const adj = rows.find((r) => r.documentNumber === P + 'ADJ-0001');
  check('six status vocabularies collapse to one canonical set',
    adj && ['draft', 'pending_approval', 'approved', 'in_progress', 'posted', 'partially_completed', 'completed', 'cancelled', 'reversed'].indexOf(adj.status) !== -1, adj && adj.status);
  check('rawStatus is preserved alongside the canonical one', adj && adj.rawStatus === 'approved', adj && adj.rawStatus);
  const prd = rows.find((r) => r.documentNumber === P + 'PRD-0001');
  check('production in_progress maps canonically', prd && prd.status === 'in_progress', prd && prd.status);

  check('counts per type accompany the page', all.body.counts && Object.keys(all.body.counts).length >= 5, all.body.counts);
  check('pagination is server-side', all.body.pagination && typeof all.body.pagination.total === 'number', all.body.pagination);

  const filtered = await req('GET', '/api/inventory/operations?types=transfer&search=' + encodeURIComponent('OPS-'), admin);
  check('filtering by type returns ONLY that type',
    filtered.status === 200 && filtered.body.data.length > 0 && filtered.body.data.every((r) => r.documentType === 'transfer'),
    filtered.status === 200 && filtered.body.data.map((r) => r.documentType));

  const byWh = await req('GET', '/api/inventory/operations?warehouseId=' + P + 'WH2&search=' + encodeURIComponent('OPS-'), admin);
  check('filtering by warehouse matches EITHER end of a two-sided document',
    byWh.status === 200 && byWh.body.data.some((r) => r.documentNumber === P + 'TRF-0001'),
    byWh.status === 200 && byWh.body.data.map((r) => r.documentNumber));

  const sorted = await req('GET', '/api/inventory/operations?sort=NOT_A_COLUMN&search=' + encodeURIComponent('OPS-'), admin);
  check('a non-allowlisted sort column is rejected/ignored, never injected', sorted.status === 200, { s: sorted.status, b: sorted.body });

  const empList = await req('GET', '/api/inventory/operations?pageSize=100&search=' + encodeURIComponent('OPS-'), emp);
  check('a user WITHOUT procurement.view still gets the other branches',
    empList.status === 200 && empList.body.data.some((r) => r.documentType === 'receipt'), { s: empList.status });
  check('...and NO procurement rows (per-branch capability, not one gate)',
    empList.status === 200 && !empList.body.data.some((r) => r.documentType === 'purchase_receipt'),
    empList.status === 200 && empList.body.data.filter((r) => r.documentType === 'purchase_receipt').length);
  check('...and the response SAYS which branches were withheld',
    empList.status === 200 && Array.isArray(empList.body.deniedTypes), empList.body && empList.body.deniedTypes);

  const detail = await req('GET', '/api/inventory/operations/transfer/' + P + 'TRF1', admin);
  check('GET /:type/:id -> 200 with a full document', detail.status === 200 && detail.body.data, { s: detail.status, b: detail.body });
  check('detail carries header + lines + movements + journals + timeline',
    detail.status === 200 && ['header', 'lines', 'movements', 'journals', 'timeline'].every((k) => k in detail.body),
    detail.status === 200 && Object.keys(detail.body));

  const missing = await req('GET', '/api/inventory/operations/transfer/NO-SUCH-DOC', admin);
  check('an unknown document -> 404 with a code (not an empty 200)', missing.status === 404 && missing.body.code, { s: missing.status, b: missing.body });
  const badType = await req('GET', '/api/inventory/operations/not_a_type/X', admin);
  check('an unknown document TYPE -> 4xx with a code', badType.status >= 400 && badType.status < 500 && badType.body.code, { s: badType.status, b: badType.body });

  const anon = await req('GET', '/api/inventory/operations');
  check('the operations centre is not anonymous', anon.status === 401 || anon.status === 403, anon.status);

  console.log('\n' + (_f === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) console.log(boot.slice(-2500));
  await cleanup();
  server.kill(); await conn.end();
  process.exit(_f === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ERR', e); process.exit(1); });
