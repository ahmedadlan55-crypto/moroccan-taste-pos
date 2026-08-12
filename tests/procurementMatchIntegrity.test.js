#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  QTY_EPSILON,
  allocateReceiptCapacity,
  lockReceiptMatchPlan,
  applyApprovedReceiptQuantities,
  releaseApprovedReceiptQuantities,
} = require('../lib/procurement/matching');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✅', name); }
  catch (error) { failed++; console.log('  ❌', name, '-', error.stack || error.message); }
}
async function thrown(fn) { try { await fn(); return null; } catch (error) { return error; } }

const receipt = (id, qty = 10, extra = {}) => ({
  id, po_line_id: `PO-${id}`, base_qty: qty, base_unit_cost: 4,
  base_invoiced_qty: 0, ...extra,
});
const line = (id, receiptLineId, qty) => ({ id, grn_line_id: receiptLineId, base_qty: qty, base_unit_price: 4 });

(async () => {
  console.log('\n▶ procurement receipt-line match integrity\n');

  await test('allows an exact line-level match against remaining receipt capacity', async () => {
    const plan = allocateReceiptCapacity([line('I1', 'R1', 6)], [receipt('R1', 10)], { R1: 4 });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].matchedQty, 6);
    assert.equal(plan[0].availableQtyBefore, 6);
  });

  await test('rejects over-match caused by another invoice reservation', async () => {
    const error = await thrown(() => Promise.resolve(allocateReceiptCapacity(
      [line('I1', 'R1', 6)], [receipt('R1', 10)], { R1: 5 }
    )));
    assert.equal(error && error.code, 'MATCHING_VARIANCE');
    assert.deepEqual(error.details, {
      invoiceLineId: 'I1', receiptLineId: 'R1', requestedQty: 6,
      availableQty: 5, receivedQty: 10, reservedQty: 5,
      alreadyRequestedByThisInvoice: 0,
    });
  });

  await test('two invoice lines sharing one receipt cannot collectively over-match it', async () => {
    const error = await thrown(() => Promise.resolve(allocateReceiptCapacity(
      [line('I1', 'R1', 6), line('I2', 'R1', 5)], [receipt('R1', 10)], {}
    )));
    assert.equal(error && error.code, 'MATCHING_VARIANCE');
    assert.equal(error && error.details.invoiceLineId, 'I2');
    assert.equal(error && error.details.availableQty, 4);
    assert.equal(error && error.details.alreadyRequestedByThisInvoice, 6);
  });

  await test('over-match on one receipt cannot be netted by spare capacity on another', async () => {
    const error = await thrown(() => Promise.resolve(allocateReceiptCapacity(
      [line('I1', 'R1', 11), line('I2', 'R2', 1)],
      [receipt('R1', 10), receipt('R2', 100)], {}
    )));
    assert.equal(error && error.code, 'MATCHING_VARIANCE');
    assert.equal(error && error.details.receiptLineId, 'R1');
  });

  await test('negative quantities are rejected per line and cannot net a prior line', async () => {
    const error = await thrown(() => Promise.resolve(allocateReceiptCapacity(
      [line('I1', 'R1', -2), line('I2', 'R1', 12)], [receipt('R1', 10)], {}
    )));
    assert.equal(error && error.code, 'VALIDATION_ERROR');
    assert.equal(error && error.details.invoiceLineId, 'I1');
  });

  await test('missing referenced receipt line fails closed instead of silently skipping it', async () => {
    const error = await thrown(() => Promise.resolve(allocateReceiptCapacity(
      [line('I1', 'MISSING', 1)], [receipt('R1', 10)], {}
    )));
    assert.equal(error && error.code, 'NOT_FOUND');
    assert.equal(error && error.details.receiptLineId, 'MISSING');
  });

  await test('lock plan sorts receipt locks and counts positive reservations from other invoices', async () => {
    const calls = [];
    const conn = {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        if (/FROM purchase_receipt_lines/.test(sql)) {
          return [[receipt('R1', 10), receipt('R2', 8)]];
        }
        if (/FROM supplier_invoice_matches/.test(sql)) {
          return [[
            { id: 'M1', receipt_line_id: 'R1', matched_qty: 4 },
            { id: 'M2', receipt_line_id: 'R1', matched_qty: -99 },
            { id: 'M3', receipt_line_id: 'R1', matched_qty: 3 },
          ]];
        }
        throw new Error(`unexpected query ${sql}`);
      },
    };
    const plan = await lockReceiptMatchPlan(conn, 'INV-CURRENT', [line('I2', 'R2', 8), line('I1', 'R1', 3)]);
    assert.equal(plan.length, 2);
    assert.match(calls[0].sql, /ORDER BY id\s+FOR UPDATE/);
    assert.deepEqual(calls[0].params, ['R1', 'R2']);
    assert.match(calls[1].sql, /ORDER BY receipt_line_id, id\s+FOR UPDATE/);
    assert.match(calls[1].sql, /invoice_id <> \?/);
    assert.deepEqual(calls[1].params, ['R1', 'R2', 'INV-CURRENT']);
  });

  await test('approval revalidates aggregate per receipt and applies one conditional update', async () => {
    const calls = [];
    const conn = {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        if (/SELECT DISTINCT receipt_line_id/.test(sql)) return [[{ receipt_line_id: 'R1' }]];
        if (/FROM purchase_receipt_lines/.test(sql)) return [[receipt('R1', 10, { base_invoiced_qty: 6 })]];
        if (/SELECT id, invoice_id, receipt_line_id/.test(sql)) {
          return [[{ id: 'M1', invoice_id: 'INV-1', receipt_line_id: 'R1', matched_qty: 4 }]];
        }
        if (/UPDATE purchase_receipt_lines/.test(sql)) return [{ affectedRows: 1 }];
        throw new Error(`unexpected query ${sql}`);
      },
    };
    const applied = await applyApprovedReceiptQuantities(conn, 'INV-1');
    assert.deepEqual(applied, [{ receiptLineId: 'R1', matchedQty: 4 }]);
    const receiptLockAt = calls.findIndex((c) => /FROM purchase_receipt_lines/.test(c.sql));
    const matchLockAt = calls.findIndex((c) => /SELECT id, invoice_id, receipt_line_id/.test(c.sql));
    assert.ok(receiptLockAt >= 0 && matchLockAt > receiptLockAt, 'approval lock order must be receipt then matches');
    assert.match(calls[matchLockAt].sql, /ORDER BY receipt_line_id, id\s+FOR UPDATE/);
    const update = calls.find((c) => /UPDATE purchase_receipt_lines/.test(c.sql));
    assert.match(update.sql, /base_invoiced_qty \+ \? <= base_qty \+ \?/);
    assert.deepEqual(update.params.slice(0, 3), [4, 'R1', 4]);
  });

  await test('approval blocks pre-existing bad matches before any quantity update', async () => {
    let updateCount = 0;
    const conn = {
      async query(sql) {
        if (/SELECT DISTINCT receipt_line_id/.test(sql)) return [[{ receipt_line_id: 'R1' }]];
        if (/FROM purchase_receipt_lines/.test(sql)) return [[receipt('R1', 10, { base_invoiced_qty: 0 })]];
        if (/SELECT id, invoice_id, receipt_line_id/.test(sql)) return [[
          { id: 'M0', invoice_id: 'OTHER', receipt_line_id: 'R1', matched_qty: 8 },
          { id: 'M1', invoice_id: 'INV-1', receipt_line_id: 'R1', matched_qty: 3 },
        ]];
        if (/UPDATE purchase_receipt_lines/.test(sql)) { updateCount++; return [{ affectedRows: 1 }]; }
        throw new Error(`unexpected query ${sql}`);
      },
    };
    const error = await thrown(() => applyApprovedReceiptQuantities(conn, 'INV-1'));
    assert.equal(error && error.code, 'MATCHING_VARIANCE');
    assert.equal(updateCount, 0);
  });

  await test('conditional-update loser fails closed (mutation/concurrency guard)', async () => {
    const conn = {
      async query(sql) {
        if (/SELECT DISTINCT receipt_line_id/.test(sql)) return [[{ receipt_line_id: 'R1' }]];
        if (/FROM purchase_receipt_lines/.test(sql)) return [[receipt('R1', 10, { base_invoiced_qty: 3 })]];
        if (/SELECT id, invoice_id, receipt_line_id/.test(sql)) {
          return [[{ id: 'M1', invoice_id: 'INV-1', receipt_line_id: 'R1', matched_qty: 2 }]];
        }
        if (/UPDATE purchase_receipt_lines/.test(sql)) return [{ affectedRows: 0 }];
        throw new Error(`unexpected query ${sql}`);
      },
    };
    const error = await thrown(() => applyApprovedReceiptQuantities(conn, 'INV-1'));
    assert.equal(error && error.code, 'MATCHING_VARIANCE');
    assert.equal(error && error.details.concurrentConflict, true);
  });

  await test('a full credit note releases approved receipt capacity without allowing a negative quantity', async () => {
    const calls = [];
    const conn = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT receipt_line_id, SUM/.test(sql)) return [[{ receipt_line_id: 'R1', matched_qty: 6 }]];
      if (/UPDATE purchase_receipt_lines/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    } };
    const released = await releaseApprovedReceiptQuantities(conn, 'INV-1');
    assert.deepEqual(released, [{ receiptLineId: 'R1', matchedQty: 6 }]);
    const update = calls.find((call) => /UPDATE purchase_receipt_lines/.test(call.sql));
    assert.match(update.sql, /base_invoiced_qty = base_invoiced_qty - \?/);
    assert.match(update.sql, /base_invoiced_qty \+ \? >= \?/);
    assert.deepEqual(update.params, [6, 'R1', QTY_EPSILON, 6]);
  });

  await test('credit-note route releases capacity before removing match reservations', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'procurement', 'invoices.js'), 'utf8');
    const releaseAt = source.indexOf('matching.releaseApprovedReceiptQuantities(conn, inv.id)');
    const deleteAt = source.indexOf("DELETE FROM supplier_invoice_matches WHERE invoice_id = ?", releaseAt);
    const cancelAt = source.indexOf('UPDATE supplier_invoices SET status = "cancelled"', releaseAt);
    assert.ok(releaseAt > 0 && deleteAt > releaseAt && cancelAt > deleteAt);
  });

  await test('invoice route wires locks before replacement, approval guard, and cancellation release', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'procurement', 'invoices.js'), 'utf8');
    const lockAt = source.indexOf('matching.lockReceiptMatchPlan');
    const deleteAt = source.indexOf("DELETE FROM supplier_invoice_matches WHERE invoice_id = ?", lockAt);
    assert.ok(lockAt >= 0 && deleteAt > lockAt, 'receipt locks must precede replacement of current draft matches');
    assert.match(source, /stateMachine\.next\('supplier_invoice', rows\[0\]\.status, 'match'\)/);
    assert.match(source, /matching\.applyApprovedReceiptQuantities\(conn, row\.id\)/);
    const cancellations = source.match(/DELETE FROM supplier_invoice_matches WHERE invoice_id = \?/g) || [];
    assert.ok(cancellations.length >= 2, 'cancel must release draft reservations as well as rematch replacement');
  });

  console.log(`\nProcurement match integrity: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
