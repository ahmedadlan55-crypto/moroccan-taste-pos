/**
 * Phase 2B — Analytics + Reports integration test (real API, ENFORCE=1).
 *
 * Boots server.js with WAREHOUSE_SCOPE_ENFORCE=1, seeds 2 warehouses + 2 scoped
 * users + 1 admin (one item name is a CSV-injection probe), and asserts:
 * value reconciliation (analytics == dashboard for a scope), totals == Σ rows,
 * scope isolation on analytics/reports/counts, forbidden-warehouse 403,
 * admin-only data-quality gate, and CSV BOM + formula neutralization.
 *
 * Run: node tests/integration/reports.api.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.REPORTS_TEST_PORT || 3197);
const BASE = { host: '127.0.0.1', port: PORT };
const WH_A = 'WH-RPT-A', WH_B = 'WH-RPT-B';
const ITEM1 = 'RPT-ITEM-1', ITEM2 = 'RPT-ITEM-2';
const EVIL = '=cmd()|calc'; // CSV formula-injection probe (item name)
const USERS = { a: 'rpt_a', b: 'rpt_b' };

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }

function req(method, path, token, opts) {
  return new Promise((resolve) => {
    const headers = { Accept: '*/*' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ ...BASE, method, path, headers }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; if (!(opts && opts.raw)) { try { j = JSON.parse(b); } catch (_) {} } resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 80; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role) { return jwt.sign({ id, username, role, isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM user_warehouse_access WHERE warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM inv_items WHERE id IN (?,?)', [ITEM1, ITEM2]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM users WHERE username IN (?,?)', [USERS.a, USERS.b]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [WH_A, 'RA', 'تقارير ألفا', 'branch']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [WH_B, 'RB', 'تقارير بيتا', 'branch']);
  await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [ITEM1, EVIL, 'خام', 'كجم', 5, 2]);
  await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [ITEM2, 'صنف عادي', 'تغليف', 'علبة', 3, 5]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-RA1', WH_A, ITEM1, 10, 5]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-RA2', WH_A, ITEM2, 20, 3]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-RB1', WH_B, ITEM1, 100, 5]);
  const ids = {};
  for (const key of ['a', 'b']) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [USERS[key], 'disabled', 'manager']);
    const [r] = await db.query('SELECT id FROM users WHERE username = ?', [USERS[key]]);
    ids[key] = r[0].id;
  }
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids.a, WH_A, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids.b, WH_B, 'test']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Analytics + Reports — integration (ENFORCE=1) ═══\n');
  const ids = await seed();
  const tokenA = tok(ids.a, USERS.a, 'manager');
  const tokenAdmin = tok(0, 'rpt_admin', 'admin');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // A's WH-A value = 10*5 + 20*3 = 110.
    const an = await req('GET', '/api/inventory/analytics/summary', tokenA);
    const dash = await req('GET', '/api/inventory/dashboard-summary', tokenA);
    const anVal = an.body && an.body.data && an.body.data.kpis.inventoryValueWac;
    const dashVal = dash.body && dash.body.kpis && dash.body.kpis.inventoryValue;
    check('analytics value == dashboard value (same scope)', anVal === dashVal, { anVal, dashVal });
    check('A analytics value = WH-A only (110, excludes WH-B 500)', anVal === 110, anVal);
    check('A analytics envelope has the contract keys', an.body && ['data', 'totals', 'filters', 'scope', 'generatedAt', 'dataQualityWarnings'].every((k) => k in an.body));

    // Report: totals == Σ rows; rows only WH-A.
    const sb = await req('GET', '/api/inventory/reports/stock-balance?pageSize=200', tokenA);
    const rows = (sb.body && sb.body.data) || [];
    const sumRows = Math.round(rows.reduce((s, r) => s + (r.value || 0), 0) * 100) / 100;
    check('stock-balance totals == Σ rows', sb.body && sb.body.totals.totalValue === sumRows, { total: sb.body && sb.body.totals.totalValue, sumRows });
    check('stock-balance rows only from WH-A', rows.length > 0 && rows.every((r) => r.warehouseId === WH_A), rows.map((r) => r.warehouseId));
    check('stock-balance total == 110 (excludes WH-B)', sb.body && sb.body.totals.totalValue === 110, sb.body && sb.body.totals.totalValue);

    // Pagination does not change totals.
    const sbP = await req('GET', '/api/inventory/reports/stock-balance?pageSize=1&page=1', tokenA);
    check('pagination keeps totals stable (totalValue unchanged)', sbP.body && sbP.body.totals.totalValue === 110, sbP.body && sbP.body.totals.totalValue);
    check('pagination total count reflects FULL set, not the page', sbP.body && sbP.body.pagination.total === rows.length && sbP.body.data.length === 1, sbP.body && sbP.body.pagination);

    // Forbidden warehouse on a report → 403.
    const forb = await req('GET', '/api/inventory/reports/stock-balance?warehouseId=' + WH_B, tokenA);
    check('A report ?warehouseId=WH-B → 403', forb.status === 403, { status: forb.status });

    // data-quality is admin/global only.
    const dqA = await req('GET', '/api/inventory/reports/data-quality', tokenA);
    check('A (scoped) data-quality → 403', dqA.status === 403, { status: dqA.status });
    const dqAdmin = await req('GET', '/api/inventory/reports/data-quality', tokenAdmin);
    check('admin data-quality → 200 with metrics', dqAdmin.status === 200 && (dqAdmin.body.data || []).length > 0, { status: dqAdmin.status });

    // admin (global) sees BOTH seeded warehouses (the DB may hold others too,
    // so assert presence of WH-A and WH-B rather than an exact grand total).
    const anAdmin = await req('GET', '/api/inventory/analytics/summary', tokenAdmin);
    const adminWh = (anAdmin.body && anAdmin.body.data && anAdmin.body.data.valueByWarehouse || []).map((w) => w.id);
    check('admin analytics includes BOTH WH-A and WH-B', adminWh.includes(WH_A) && adminWh.includes(WH_B), adminWh);
    check('A analytics excludes WH-B from valueByWarehouse', (an.body.data.valueByWarehouse || []).every((w) => w.id !== WH_B));

    // CSV export: BOM + formula injection neutralized.
    const csv = await req('GET', '/api/inventory/reports/stock-balance/export', tokenA, { raw: true });
    check('CSV export status 200', csv.status === 200, { status: csv.status });
    check('CSV starts with UTF-8 BOM', csv.raw && csv.raw.charCodeAt(0) === 0xFEFF);
    check('CSV neutralizes the =formula cell (prefixes a quote)', csv.raw && csv.raw.includes("'" + EVIL) && !csv.raw.includes(',' + EVIL + ','), { has: csv.raw && csv.raw.indexOf("'" + EVIL) >= 0 });

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('Total: ' + (_p + _f) + ' | Passed: ' + _p + ' | Failed: ' + _f);
    console.log('═══════════════════════════════════════════════════════════');
    exitCode = _f > 0 ? 1 : 0;
  } catch (e) { console.error('FATAL', e); exitCode = 2; }
  finally { try { server.kill(); } catch (_) {} await cleanup(); }
  process.exit(exitCode);
})();
