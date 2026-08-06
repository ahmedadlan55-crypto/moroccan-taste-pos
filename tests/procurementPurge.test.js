'use strict';
/*
 * tests/procurementPurge.test.js — lib/procurementPurge.
 *
 * This module DELETES financial history and unwinds warehouse stock, so the
 * properties below are not stylistic preferences — each one is a way the purge
 * could silently corrupt a live database:
 *
 *   · deleting a parent before its children strands orphan lines;
 *   · unwinding stock by DATE instead of by attribution would eat quantities
 *     that sales, transfers or stocktakes put there;
 *   · deleting GL rows without a reference filter would empty the books;
 *   · planning that writes anything at all breaks the promise the preview makes.
 *
 * Pure — no DB, no network. The connection is a recording stub.
 */
const assert = require('assert');
const purge = require('../lib/procurementPurge');

let passed = 0;
// Cases are QUEUED, then awaited in order by run() at the bottom. Firing them
// without awaiting would print the summary before the assertions ran — a suite
// that always says "passed" is worse than no suite.
const queue = [];
function it(name, fn) { queue.push({ name, fn }); }
const itAsync = it;

/** Records every statement; returns canned rows for the two SELECT shapes. */
function stubConn(opts) {
  const o = opts || {};
  const statements = [];
  const conn = {
    statements,
    query: async (sql, params) => {
      statements.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      if (/SELECT COUNT/i.test(sql)) return [[{ n: o.count == null ? 3 : o.count }]];
      if (/GROUP BY item_id/i.test(sql)) return [o.unwind || []];
      return [{ affectedRows: o.affected == null ? 1 : o.affected }];
    },
    withTransaction: async (fn) => fn(conn),
  };
  return conn;
}

const writes = (c) => c.statements.filter((s) => /^(DELETE|UPDATE|INSERT)/i.test(s.sql));

// ── The delete order is a correctness property, not a style choice ──────────
it('every child table is listed before its parent', () => {
  const idx = (t) => purge.DOC_TABLES.indexOf(t);
  const pairs = [
    ['supplier_invoice_lines', 'supplier_invoices'],
    ['supplier_invoice_matches', 'supplier_invoices'],
    ['purchase_return_lines', 'purchase_returns'],
    ['purchase_receipt_lines', 'purchase_receipts'],
    ['po_lines', 'purchase_orders'],
  ];
  for (const [child, parent] of pairs) {
    assert.ok(idx(child) >= 0 && idx(parent) >= 0, child + '/' + parent + ' must both be listed');
    assert.ok(idx(child) < idx(parent), child + ' must be deleted before ' + parent);
  }
});

it('covers every procurement document table the schema defines', () => {
  for (const t of [
    'purchase_requisitions', 'purchase_orders', 'po_lines', 'purchase_receipts',
    'purchase_receipt_lines', 'supplier_invoices', 'supplier_invoice_lines',
    'supplier_invoice_matches', 'purchase_returns', 'purchase_return_lines',
    'payment_allocations', 'procurement_events', 'purchase_lots', 'purchases',
  ]) {
    assert.ok(purge.DOC_TABLES.includes(t), 'missing from DOC_TABLES: ' + t);
  }
});

// ── planPurge must be READ-ONLY: the preview's whole promise ────────────────
itAsync('planPurge writes NOTHING — the preview cannot delete by accident', async () => {
  const c = stubConn({});
  await purge.planPurge(c);
  assert.strictEqual(writes(c).length, 0,
    'planPurge issued a write: ' + JSON.stringify(writes(c).map((s) => s.sql).slice(0, 3)));
});

itAsync('planPurge reports counts per table and flags an absent one', async () => {
  const c = stubConn({ count: 7 });
  const plan = await purge.planPurge(c);
  assert.strictEqual(plan.tables.length, purge.DOC_TABLES.length);
  assert.strictEqual(plan.tables[0].rows, 7);
  assert.strictEqual(plan.docRows, 7 * purge.DOC_TABLES.length);
  assert.strictEqual(plan.empty, false);
});

itAsync('an empty database is reported as empty, not as a purge to run', async () => {
  const c = stubConn({ count: 0 });
  const plan = await purge.planPurge(c);
  assert.strictEqual(plan.empty, true);
});

// ── Attribution: the unwind must never touch non-procurement stock ──────────
itAsync('stock is attributed by reference_type, never by date', async () => {
  const c = stubConn({});
  await purge.planPurge(c);
  const unwindSql = c.statements.find((s) => /GROUP BY item_id/i.test(s.sql));
  assert.ok(unwindSql, 'no attribution query was issued');
  assert.ok(/reference_type IN/i.test(unwindSql.sql), 'the unwind must filter on reference_type');
  assert.ok(!/movement_date|created_at|BETWEEN/i.test(unwindSql.sql),
    'the unwind must NOT be date-scoped — that would eat sales/transfer stock');
  for (const t of purge.MOVEMENT_REF_TYPES) assert.ok(unwindSql.params.includes(t));
});

itAsync('GL deletion is scoped to procurement reference types only', async () => {
  const c = stubConn({});
  const plan = await purge.planPurge(c);
  await purge.applyPurge(c, plan);
  const glDeletes = c.statements.filter((s) => /DELETE FROM gl_/i.test(s.sql));
  assert.ok(glDeletes.length >= 2, 'expected gl_entries and gl_journals deletes');
  for (const d of glDeletes) {
    assert.ok(/reference_type IN/i.test(d.sql),
      'an unscoped GL delete would empty the whole ledger: ' + d.sql);
  }
});

// ── The unwind itself ──────────────────────────────────────────────────────
itAsync('subtracts exactly the attributed quantity from each warehouse row', async () => {
  const c = stubConn({ unwind: [{ itemId: 'I1', warehouseId: 'W1', netQty: 12 }] });
  const plan = await purge.planPurge(c);
  assert.deepStrictEqual(plan.stockUnwind, [{ itemId: 'I1', warehouseId: 'W1', netQty: 12 }]);
  await purge.applyPurge(c, plan);
  const upd = c.statements.find((s) => /UPDATE warehouse_stock SET qty = qty - \?/i.test(s.sql));
  assert.ok(upd, 'warehouse_stock was never adjusted');
  assert.deepStrictEqual(upd.params, [12, 'W1', 'I1']);
});

itAsync('recomputes the rollups instead of adjusting them', async () => {
  const c = stubConn({ unwind: [{ itemId: 'I1', warehouseId: 'W1', netQty: 5 }] });
  const plan = await purge.planPurge(c);
  await purge.applyPurge(c, plan);
  const roll = c.statements.find((s) => /UPDATE inv_items i SET i.stock =/i.test(s.sql));
  assert.ok(roll, 'inv_items.stock was not recomputed');
  assert.ok(/SUM\(ws.qty\)/i.test(roll.sql),
    'the rollup must be derived from warehouse_stock, not adjusted by a delta');
});

itAsync('skips a movement with no warehouse — there is nothing to subtract from', async () => {
  const c = stubConn({ unwind: [{ itemId: 'I1', warehouseId: null, netQty: 9 }] });
  const plan = await purge.planPurge(c);
  await purge.applyPurge(c, plan);
  assert.ok(!c.statements.some((s) => /UPDATE warehouse_stock/i.test(s.sql)),
    'a null warehouse must not produce a blind UPDATE');
});

// ── Ordering inside apply ──────────────────────────────────────────────────
itAsync('unwinds stock BEFORE deleting the ledger rows it is attributed by', async () => {
  const c = stubConn({ unwind: [{ itemId: 'I1', warehouseId: 'W1', netQty: 4 }] });
  const plan = await purge.planPurge(c);
  c.statements.length = 0;
  await purge.applyPurge(c, plan);
  const iUnwind = c.statements.findIndex((s) => /UPDATE warehouse_stock/i.test(s.sql));
  const iDelete = c.statements.findIndex((s) => /DELETE FROM inventory_movements/i.test(s.sql));
  assert.ok(iUnwind >= 0 && iDelete >= 0);
  assert.ok(iUnwind < iDelete,
    'deleting the movements first would destroy the attribution the unwind needs');
});

itAsync('runs the whole purge inside ONE transaction', async () => {
  let opened = 0;
  const c = stubConn({});
  const inner = c.withTransaction;
  c.withTransaction = async (fn) => { opened++; return inner(fn); };
  const plan = await purge.planPurge(c);
  await purge.applyPurge(c, plan);
  assert.strictEqual(opened, 1, 'a half-purged graph is worse than either end state');
});

(async () => {
  for (const c of queue) {
    try { await c.fn(); passed++; }
    catch (e) { console.error('✗ ' + c.name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log('procurementPurge: ' + passed + '/' + queue.length + ' passed');
  if (passed !== queue.length) process.exitCode = 1;
})();
