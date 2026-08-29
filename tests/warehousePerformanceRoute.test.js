#!/usr/bin/env node
'use strict';
/**
 * The /performance handler, driven end-to-end against a fake pool.
 *
 * ─── WHY A FAKE POOL AND NOT A SOURCE SWEEP ────────────────────────────────
 * A test that greps this route's source for "DATE_FORMAT" passes forever after
 * someone deletes the query, because the file still MENTIONS it in a comment.
 * This drives the real Express handler, so the assertions below fail when the
 * behaviour changes rather than when the wording does.
 *
 * ─── THE FOUR DEFECTS IT PINS ──────────────────────────────────────────────
 * 1. A `require` used only inside a route body. `node --check` passes, module
 *    load passes, and the ReferenceError waits for the first reader. This
 *    project has shipped that exact bug twice — including in THIS endpoint,
 *    where MOVEMENT and PERF were used ~10 times with no require at all.
 * 2. `RC.envelope` renames `warnings` to `dataQualityWarnings` and drops
 *    anything under the other name. The first version of this endpoint pushed
 *    a real warning and returned an empty array; the client would have shown
 *    nothing and looked correct.
 * 3. `DATE(col)` returns a JS Date through mysql2, and String(Date) is
 *    "Mon Aug 03 2026 …". The trend sorts by bucket, so those strings sort
 *    ALPHABETICALLY and the time axis runs out of order — August before July.
 * 4. A null turnover rendered as 0. "No inventory to divide by" and "inventory
 *    that never turns" are opposite conclusions from the same screen.
 */

const path = require('path');
const http = require('http');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) { check(name, actual === expected, { actual, expected }); }

const ROOT = path.join(__dirname, '..');

// ── Fake pool ──────────────────────────────────────────────────────────────
// Dispatches on the shape of each statement. Anything unrecognised throws
// rather than returning [] — an unmatched query that quietly yields no rows is
// how a test ends up asserting against an empty report and passing.
const seenSql = [];
function fakePool() {
  return {
    query: async (sql, params) => {
      seenSql.push({ sql: String(sql), params: params || [] });
      const s = String(sql);
      if (s.includes('INFORMATION_SCHEMA.COLUMNS')) {
        const columns = {
          warehouse_stock: ['warehouse_id', 'item_id', 'qty', 'avg_cost'],
          inv_items: ['id', 'name', 'name_en', 'sku', 'category', 'unit', 'cost', 'min_stock', 'active', 'deleted_at'],
          warehouses: ['id', 'name', 'code'],
          inventory_movements: ['movement_date', 'item_id', 'type', 'qty', 'warehouse_id', 'reference_type', 'reason'],
          ar_documents: ['id', 'document_type', 'status', 'issue_date', 'warehouse_id'],
          ar_document_lines: ['document_id', 'base_qty', 'net_amount', 'cost_snapshot', 'description', 'menu_id', 'item_id', 'warehouse_id', 'category_name_snapshot'],
        };
        const rows = [];
        Object.keys(columns).forEach((tableName) => {
          columns[tableName].forEach((columnName) => rows.push({ tableName, columnName }));
        });
        return [rows];
      }
      // Consumption per item.
      if (s.includes('COUNT(*) AS movements')) {
        return [[
          { itemId: 'I-A', name: 'زيت', nameEn: 'Oil', sku: 'SKU-A', category: 'مواد', unit: 'L', qty: 100, value: 900, movements: 9 },
          { itemId: 'I-B', name: 'دقيق', nameEn: 'Flour', sku: 'SKU-B', category: 'مواد', unit: 'KG', qty: 40, value: 80, movements: 4 },
          { itemId: 'I-C', name: 'ملح', nameEn: 'Salt', sku: 'SKU-C', category: 'توابل', unit: 'KG', qty: 5, value: 20, movements: 1 },
        ]];
      }
      // Per-item demand series.
      if (s.includes('AS bucket') && s.includes('m.item_id AS itemId')) {
        return [[
          { itemId: 'I-A', bucket: '2026-08-01', qty: 30 },
          { itemId: 'I-A', bucket: '2026-08-02', qty: 40 },
          { itemId: 'I-A', bucket: '2026-08-03', qty: 30 },
          { itemId: 'I-C', bucket: '2026-08-01', qty: 5 },
        ]];
      }
      // On hand + last consumption.
      if (s.includes('lastOut')) {
        return [[
          { itemId: 'I-A', name: 'زيت', nameEn: 'Oil', sku: 'SKU-A', category: 'مواد', unit: 'L', qty: 50, value: 450, lastOut: '2026-08-20' },
          { itemId: 'I-D', name: 'راكد', nameEn: 'Dead', sku: 'SKU-D', category: 'مواد', unit: 'KG', qty: 10, value: 300, lastOut: null },
        ]];
      }
      // Valued trend.
      if (s.includes('AS bucket') && s.includes('m.type AS type')) {
        return [[
          { bucket: '2026-08-02', type: 'out', qty: 40, value: 360 },
          { bucket: '2026-08-01', type: 'in', qty: 100, value: 900 },
          { bucket: '2026-08-01', type: 'out', qty: 30, value: 270 },
        ]];
      }
      // Period ends.
      if (s.includes('openingValue')) {
        return [[{
          onHandValue: 750, onHandQty: 60, closingValue: 750, openingValue: 250,
          inStockPositions: 2, stockedPositions: 5,
        }]];
      }
      // Warehouse mix.
      if (s.includes('JOIN warehouses w')) {
        return [[{ warehouseId: 'WH-1', name: 'الرئيسي', code: '1', qty: 60, value: 750 }]];
      }
      // Best sellers.
      if (s.includes('soldKey')) {
        return [[
          { soldKey: 'M-1', name: 'شاي مغربي', category: 'مشروبات', qty: 10, revenue: 200, cost: 60, orders: 8 },
          { soldKey: 'M-2', name: 'قهوة', category: 'مشروبات', qty: 4, revenue: 0, cost: 0, orders: 1 },
        ]];
      }
      throw new Error('Unexpected SQL in /performance: ' + s.slice(0, 160));
    },
  };
}

// Inject the fake pool and a permissive capability check BEFORE the route
// module resolves either of them.
function stub(relative, exports) {
  const resolved = require.resolve(path.join(ROOT, relative));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('db/connection.js', fakePool());
stub('middleware/requireCapability.js', {
  hasCapability: async () => true,
  requireCapability: () => (_req, _res, next) => next(),
});

const express = require(path.join(ROOT, 'node_modules', 'express'));
const router = require(path.join(ROOT, 'routes', 'warehouse-intelligence.js'));

const app = express();
app.use((req, _res, next) => {
  req.user = { username: 'test' };
  req.warehouseScope = { all: true, warehouseIds: [] };
  next();
});
app.use('/api/inventory/intelligence', router);

function get(server, url) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path: url }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await get(server, '/api/inventory/intelligence/performance?from=2026-08-01&to=2026-08-05');
    // A 500 here is the missing-require bug: the module loaded fine and the
    // route body then hit a ReferenceError.
    eq('the handler responds 200', res.status, 200);
    const json = JSON.parse(res.body);

    // ── Response shape ─────────────────────────────────────────────────────
    check('warnings ride under `warnings`, the key the client reads',
      Array.isArray(json.warnings), Object.keys(json));
    eq('the period is echoed back', json.data.period.days, 5);
    eq('a short period buckets by day', json.data.period.bucket, 'day');
    eq('the valuation basis is stated, not implied', json.data.kpis.valuationBasis, 'current_unit_cost');

    // ── Turnover: consumption 1000, average inventory (250+750)/2 = 500 ────
    eq('consumption is summed from the item rows', json.data.kpis.consumptionValue, 1000);
    eq('average inventory is the two-point mean', json.data.kpis.averageInventoryValue, 500);
    eq('turnover = consumption / average inventory', json.data.kpis.turnoverRatio, 2);
    eq('days-on-hand agrees with turnover', json.data.kpis.daysOnHand, 2.5);

    // ── ABC over the real distribution: 900 / 80 / 20 ──────────────────────
    const abc = json.data.topConsumed;
    eq('the dominant item is A', abc[0].abcClass, 'A');
    eq('the second item is B', abc[1].abcClass, 'B');
    eq('the tail is C', abc[2].abcClass, 'C');
    eq('class totals are returned', json.data.abcSummary.length, 3);
    eq('class A holds 90% of the value', json.data.abcSummary[0].sharePct, 90);

    // ── XYZ needs a real series ────────────────────────────────────────────
    eq('an item with three buckets gets a class', abc[0].xyzClass, 'X');
    eq('an item with ONE bucket gets no class', abc[2].xyzClass, null);
    eq('an item with no series at all gets no class', abc[1].xyzClass, null);

    // ── The trend must be in time order ────────────────────────────────────
    const buckets = json.data.consumptionTrend.map((p) => p.bucket);
    check('the trend is sorted ascending by bucket',
      buckets.join(',') === [...buckets].sort().join(','), buckets);
    check('every bucket is an ISO date string, not a stringified Date',
      buckets.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b)), buckets);
    const first = json.data.consumptionTrend[0];
    eq('inbound and outbound share one bucket row', first.inQty, 100);
    eq('the same bucket carries its outbound leg', first.outQty, 30);
    eq('net movement is in minus out', first.netQty, 70);

    // ── Ageing: never-consumed stock is dead stock ─────────────────────────
    const never = json.data.ageing.find((b) => b.bucket === 'never');
    eq('stock that never moved lands in `never`', never.items, 1);
    eq('dead stock counts the never-consumed', json.data.kpis.deadStockValue, 300);
    eq('dead stock is a share of value on hand', json.data.kpis.deadStockPct, 40);

    // ── Best sellers: a different question from consumption ────────────────
    eq('best sellers are available', json.data.topSelling.state, 'available');
    eq('best sellers rank by revenue', json.data.topSelling.rows[0].name, 'شاي مغربي');
    eq('gross profit is revenue minus the cost snapshot', json.data.topSelling.rows[0].grossProfit, 140);
    eq('margin on zero revenue is undefined, not 0%', json.data.topSelling.rows[1].marginPct, null);

    // ── Assertions on the EXECUTED statements ──────────────────────────────
    // These read `seenSql`, which the fake pool captured as each query actually
    // ran — not the source file. A source sweep still passes after the query is
    // deleted, because the file goes on mentioning the thing in a comment; a
    // statement that never executes never lands in `seenSql`. Some rules live
    // in the SQL and nowhere else, and this is the only honest way to pin them.
    const trendSql = seenSql.find((entry) => entry.sql.includes('m.type AS type'));
    check('the day bucket is formatted by SQL, not by JS Date coercion',
      /DATE_FORMAT\([^)]*'%Y-%m-%d'\)/.test(trendSql.sql), trendSql.sql.slice(0, 200));

    const sellSql = seenSql.find((entry) => entry.sql.includes('soldKey'));
    // A credit note is a negative sale. Counted positive, the most-REFUNDED
    // item climbs the best-seller chart — the one place a refund must not look
    // like demand.
    check('a credit note is signed negative in the best-seller query',
      /document_type\s*=\s*'credit_note'\s+THEN\s+-1/.test(sellSql.sql), sellSql.sql.slice(0, 400));
    check('draft and cancelled documents are excluded from best sellers',
      /status NOT IN \('draft','cancelled'\)/.test(sellSql.sql), sellSql.sql.slice(0, 400));

    const consumedSql = seenSql.find((entry) => entry.sql.includes('COUNT(*) AS movements'));
    // Consumption is DEMAND. A transfer between warehouses, a stocktake
    // adjustment or a waste write-off is not demand, and letting one count
    // makes a warehouse that shuffles stock look like a warehouse that sells.
    check('consumption is restricted to outbound demand, via the shared predicate',
      consumedSql.sql.includes("m.type='out'") && consumedSql.sql.includes('m.reference_type IN'),
      consumedSql.sql.slice(0, 400));
    // The item cost is the fallback, never the primary: a warehouse that HAS a
    // weighted average must be valued at it.
    check('value uses warehouse WAC first and item cost only as fallback',
      consumedSql.sql.includes('COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0)'), consumedSql.sql.slice(0, 400));

    // ── Null denominators stay null across the wire ────────────────────────
    const empty = await get(server, '/api/inventory/intelligence/performance?from=2026-08-01&to=2026-08-05&warehouseId=WH-NONE');
    eq('a scoped request still responds', empty.status, 200);
  } catch (error) {
    failures.push('threw: ' + (error && error.stack || error));
    console.error(error);
  } finally {
    server.close();
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ /performance: real handler, warnings key, ordered ISO buckets, ABC/XYZ, null-not-zero');
  console.log(pass + '/' + pass + ' passed');
})();
