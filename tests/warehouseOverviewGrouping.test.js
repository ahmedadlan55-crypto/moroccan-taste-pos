#!/usr/bin/env node
'use strict';
/**
 * The warehouse overview must not GROUP BY a select alias.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 * `/api/inventory/intelligence/overview` answered **500** on production:
 *
 *   ER_WRONG_FIELD_WITH_GROUP: Expression #2 of SELECT list is not in GROUP BY
 *   clause and contains nonaggregated column 'pr.supplier_name_snapshot' …
 *   incompatible with sql_mode=only_full_group_by
 *
 * The supplier query selected a COALESCE over four columns as `supplier_name`
 * and then wrote `GROUP BY pr.supplier_id, supplier_name`. MySQL accepts an
 * alias in GROUP BY, but under ONLY_FULL_GROUP_BY it does not use it to satisfy
 * the functional-dependency check for a wrapped expression — so the statement
 * is rejected outright and the whole control centre fails closed.
 *
 * (It failed closed, which is right: it showed no numbers rather than wrong
 * ones. But a report that cannot run is still a report nobody can read.)
 *
 * This is the same family as the HAVING-cannot-restate-a-wrapped-expression bug
 * this project has already been bitten by: an alias is a LABEL, not a
 * substitute for the expression, anywhere the optimizer reasons about grouping.
 *
 * ─── WHY THE ASSERTION READS THE EXECUTED STATEMENT ─────────────────────────
 * It captures the SQL the real handler actually issued, through a fake pool —
 * not the source file. A source grep passes forever once the query is deleted,
 * because the file still mentions the words in its comments.
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

const ROOT = path.join(__dirname, '..');
const seen = [];

function stub(rel, exports) {
  const resolved = require.resolve(path.join(ROOT, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('db/connection.js', {
  query: async (sql) => {
    const s = String(sql);
    seen.push(s);
    if (s.includes('INFORMATION_SCHEMA.COLUMNS')) {
      // Report the snapshot column as PRESENT — that is the branch that builds
      // the four-way COALESCE, i.e. the one that broke.
      const cols = {
        purchase_receipts: ['id', 'po_id', 'supplier_id', 'supplier_name_snapshot', 'receipt_date', 'warehouse_id', 'status', 'brand_id', 'branch_id'],
        purchase_receipt_lines: ['id', 'receipt_id', 'po_line_id', 'item_id', 'item_name', 'qty', 'base_qty', 'net_amount', 'unit_cost', 'warehouse_id'],
        purchase_orders: ['id', 'supplier_name', 'supplier_id', 'status', 'warehouse_id', 'po_date', 'total_after_vat'],
        po_lines: ['id', 'po_id', 'item_id', 'qty', 'received_qty', 'unit_price', 'line_total'],
        suppliers: ['id', 'name'],
        warehouse_stock: ['warehouse_id', 'item_id', 'qty', 'avg_cost'],
        inv_items: ['id', 'name', 'cost', 'min_stock', 'active', 'deleted_at', 'unit'],
        warehouses: ['id', 'name', 'code'],
        inventory_movements: ['movement_date', 'item_id', 'type', 'qty', 'warehouse_id', 'reference_type', 'reason'],
      };
      const rows = [];
      for (const [tableName, list] of Object.entries(cols)) {
        for (const columnName of list) rows.push({ tableName, columnName });
      }
      return [rows];
    }
    return [[{}]];
  },
});
stub('middleware/requireCapability.js', Object.assign(
  () => (_req, _res, next) => next(),
  { hasCapability: async () => true },
));

const express = require(path.join(ROOT, 'node_modules', 'express'));
const app = express();
app.use((req, _res, next) => {
  req.user = { username: 't' };
  req.warehouseScope = { all: true, warehouseIds: [] };
  req.requestId = 'test';
  next();
});
app.use('/x', require(path.join(ROOT, 'routes', 'warehouse-intelligence.js')));

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await new Promise((resolve, reject) => {
      http.get({ port: server.address().port, path: '/x/overview?from=2026-01-01&to=2026-01-31' }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }).on('error', reject);
    });

    const supplierSql = seen.find((s) => /AS supplier_name/.test(s) && /GROUP BY/.test(s));
    check('the supplier aggregate actually ran', !!supplierSql, seen.length);

    if (supplierSql) {
      const groupBy = supplierSql.slice(supplierSql.indexOf('GROUP BY'));
      // The regression, precisely: grouping by the LABEL rather than the
      // expression it labels.
      check('GROUP BY does not reference the bare `supplier_name` alias',
        !/GROUP BY[^A-Za-z]*pr\.supplier_id\s*,\s*supplier_name\b/.test(supplierSql),
        groupBy.slice(0, 140));
      // And the positive form: the grouped term is the expression itself, so
      // ONLY_FULL_GROUP_BY can prove the dependency.
      check('GROUP BY carries the COALESCE expression itself',
        /GROUP BY[\s\S]*COALESCE\(/.test(supplierSql), groupBy.slice(0, 200));
      check('the snapshot column is inside the grouped expression',
        /GROUP BY[\s\S]*supplier_name_snapshot/.test(supplierSql), groupBy.slice(0, 200));
    }
  } catch (error) {
    failures.push('threw: ' + ((error && error.stack) || error));
  } finally {
    server.close();
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ overview groups by the expression, not its label');
  console.log(pass + '/' + pass + ' passed');
})();
