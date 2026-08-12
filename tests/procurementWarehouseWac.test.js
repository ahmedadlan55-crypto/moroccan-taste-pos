#!/usr/bin/env node
'use strict';

/**
 * Procurement warehouse-WAC contract.
 *
 * This is intentionally DB-free: a strict in-memory transaction double drives
 * the real InventoryPostingService and rejects every SQL statement the test did
 * not model. It proves the accounting behavior rather than grepping comments.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../services/procurement/InventoryPostingService');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  ✅', name);
  }, (e) => {
    console.error('  ❌', name);
    throw e;
  });
}
function near(actual, expected, tolerance = 0.0001) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `got ${actual}; expected ${expected}`);
}

class FakeTransaction {
  constructor() {
    this.item = { id: 'ITEM-1', stock: 200, cost: 12.5, tracking_mode: 'none' };
    this.stock = new Map([
      ['WH-A', { id: 'WS-A', warehouse_id: 'WH-A', item_id: 'ITEM-1', qty: 100, avg_cost: 5, last_cost: 5 }],
      ['WH-B', { id: 'WS-B', warehouse_id: 'WH-B', item_id: 'ITEM-1', qty: 100, avg_cost: 20, last_cost: 20 }],
    ]);
    this.lots = new Map();
    this.nextLot = 1;
    this.itemHistory = [];
    this.globalHistory = [];
    this.movements = [];
    this.failDetailedHistory = false;
  }

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim();

    if (/^SELECT id, stock, cost, tracking_mode FROM inv_items/i.test(q)) {
      return [[Object.assign({}, this.item)]];
    }
    if (/^SELECT id, qty, avg_cost, last_cost FROM warehouse_stock WHERE warehouse_id/i.test(q)) {
      const row = this.stock.get(String(params[0]));
      return [row ? [Object.assign({}, row)] : []];
    }
    if (/^UPDATE warehouse_stock SET qty = \?, avg_cost = \?, last_cost = \?/i.test(q)) {
      const row = [...this.stock.values()].find((r) => r.id === params[3]);
      assert.ok(row, 'warehouse UPDATE targets an existing locked row');
      row.qty = Number(params[0]); row.avg_cost = Number(params[1]); row.last_cost = Number(params[2]);
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO warehouse_stock/i.test(q)) {
      const row = { id: params[0], warehouse_id: params[1], item_id: params[2], qty: Number(params[3]), avg_cost: Number(params[4]), last_cost: Number(params[5]) };
      this.stock.set(String(params[1]), row);
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE inv_items i SET i\.stock/i.test(q)) {
      this.item.stock = [...this.stock.values()].reduce((sum, r) => sum + Number(r.qty), 0);
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT warehouse_id, qty, avg_cost FROM warehouse_stock WHERE item_id/i.test(q)) {
      return [[...this.stock.values()].map((r) => ({ warehouse_id: r.warehouse_id, qty: r.qty, avg_cost: r.avg_cost }))];
    }
    if (/^UPDATE inv_items SET cost = \?/i.test(q)) {
      this.item.cost = Number(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO item_cost_history/i.test(q)) {
      if (this.failDetailedHistory) throw Object.assign(new Error('item_cost_history unavailable'), { code: 'ER_NO_SUCH_TABLE' });
      this.itemHistory.push({
        itemId: params[1], warehouseId: params[2], method: params[3], oldCost: Number(params[4]), newCost: Number(params[5]),
        oldQty: Number(params[6]), newQty: Number(params[7]), triggerType: params[8], referenceId: params[9], changedBy: params[10],
      });
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO inventory_cost_history/i.test(q)) {
      this.globalHistory.push({ oldCost: Number(params[2]), newCost: Number(params[3]), referenceId: params[5] });
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO purchase_lots/i.test(q)) {
      const id = this.nextLot++;
      this.lots.set(id, { id, qty_remaining: Number(params[4]) });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/^UPDATE purchase_receipt_lines SET purchase_lot_id/i.test(q)) return [{ affectedRows: 1 }];
    if (/^INSERT INTO inventory_movements/i.test(q)) {
      this.movements.push({ type: params[4], qty: Number(params[5]), warehouseId: params[9], refType: params[10] });
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT id, qty_remaining FROM purchase_lots/i.test(q)) {
      const row = this.lots.get(Number(params[0]));
      return [row ? [Object.assign({}, row)] : []];
    }
    if (/^UPDATE purchase_lots SET qty_remaining = qty_remaining -/i.test(q)) {
      const row = this.lots.get(Number(params[1]));
      row.qty_remaining -= Number(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE po_lines/i.test(q) || /^SELECT id, base_qty, base_received_qty FROM po_lines/i.test(q)) {
      return [/^SELECT/i.test(q) ? [] : { affectedRows: 1 }];
    }
    throw new Error('Unmodelled SQL in warehouse-WAC test: ' + q);
  }
}

const receiptLine = (overrides) => Object.assign({
  id: 'RL-1', item_id: 'ITEM-1', item_name: 'Test item', po_line_id: null,
  base_qty: 100, base_unit_cost: 7, warehouse_id: 'WH-A', lot_no: null, expiry_date: null,
}, overrides || {});

(async () => {
  console.log('\n══ procurement warehouse WAC ══\n');

  await test('pure: each warehouse contributes its own quantity × WAC to the item roll-up', () => {
    near(S.weightedWarehouseRollup([
      { qty: 200, avg_cost: 6 },
      { qty: 100, avg_cost: 20 },
    ], 12.5), 10.6667);
  });

  await test('pure: missing warehouse WAC cannot recursively feed the derived master cost', () => {
    near(S.weightedWarehouseRollup([
      { qty: 10, avg_cost: 0 },
      { qty: 30, avg_cost: 20 },
      { qty: -50, avg_cost: 999 },
    ], 8), 20);
    near(S.weightedWarehouseRollup([{ qty: 10, avg_cost: 0 }], 8), 8);
  });

  await test('pure: exact-cost removal derives the remaining WAC and full removal clears it', () => {
    near(S.costAfterRemoval(200, 6, 100, 7), 5);
    near(S.costAfterRemoval(100, 5, 100, 5), 0);
  });

  await test('pure: removal cannot exceed stock or manufacture a negative inventory value', () => {
    assert.throws(() => S.costAfterRemoval(10, 5, 11, 5), (e) => e.code === 'INSUFFICIENT_STOCK');
    assert.throws(() => S.costAfterRemoval(10, 5, 9, 10), (e) => e.code === 'INVENTORY_VALUATION_CONFLICT');
  });

  await test('real service: receipt changes only WH-A WAC and derives the global item roll-up', async () => {
    const tx = new FakeTransaction();
    const result = await S.applyReceiptStock(tx, {
      grn: { id: 'GRN-1', po_id: null, warehouse_id: 'WH-A' },
      lines: [receiptLine()], actor: 'receiver',
    });
    const a = tx.stock.get('WH-A'); const b = tx.stock.get('WH-B');
    near(a.qty, 200); near(a.avg_cost, 6);
    near(b.qty, 100); near(b.avg_cost, 20);
    near(tx.item.stock, 300); near(tx.item.cost, 10.6667);
    assert.deepStrictEqual(result.affectedStock[0], { itemId: 'ITEM-1', warehouseId: 'WH-A', qtyDelta: 100, newQty: 200 });
    assert.deepStrictEqual(tx.itemHistory[0], {
      itemId: 'ITEM-1', warehouseId: 'WH-A', method: 'WAC', oldCost: 5, newCost: 6,
      oldQty: 100, newQty: 200, triggerType: 'goods_receipt', referenceId: 'GRN-1', changedBy: 'receiver',
    });
    assert.strictEqual(tx.globalHistory.length, 1);
  });

  await test('real service: exact receipt reversal restores WH-A WAC; WH-B remains untouched', async () => {
    const tx = new FakeTransaction();
    const receipt = await S.applyReceiptStock(tx, {
      grn: { id: 'GRN-2', po_id: null, warehouse_id: 'WH-A' },
      lines: [receiptLine()], actor: 'receiver',
    });
    await S.reverseReceiptStock(tx, {
      grn: { id: 'GRN-2', warehouse_id: 'WH-A' },
      lines: [receiptLine({ purchase_lot_id: receipt.lotIds[0] })], actor: 'controller',
    });
    near(tx.stock.get('WH-A').qty, 100); near(tx.stock.get('WH-A').avg_cost, 5);
    near(tx.stock.get('WH-B').qty, 100); near(tx.stock.get('WH-B').avg_cost, 20);
    near(tx.item.stock, 200); near(tx.item.cost, 12.5);
    assert.strictEqual(tx.itemHistory[1].triggerType, 'goods_receipt_reverse');
    assert.strictEqual(tx.lots.get(receipt.lotIds[0]).qty_remaining, 0);
  });

  await test('real service: purchase return updates only its warehouse and has a distinct audit trigger', async () => {
    const tx = new FakeTransaction();
    await S.applyReturnStock(tx, {
      ret: { id: 'RET-1', warehouse_id: 'WH-B' },
      lines: [receiptLine({ id: 'RTL-1', warehouse_id: 'WH-B', base_qty: 20, base_unit_cost: 20 })],
      actor: 'buyer',
    });
    near(tx.stock.get('WH-A').qty, 100); near(tx.stock.get('WH-A').avg_cost, 5);
    near(tx.stock.get('WH-B').qty, 80); near(tx.stock.get('WH-B').avg_cost, 20);
    near(tx.item.cost, 11.6667);
    assert.strictEqual(tx.itemHistory[0].triggerType, 'purchase_return');
  });

  await test('real service: detailed cost history is fail-closed, not best-effort', async () => {
    const tx = new FakeTransaction();
    tx.failDetailedHistory = true;
    await assert.rejects(
      () => S.applyReceiptStock(tx, {
        grn: { id: 'GRN-HISTORY', po_id: null, warehouse_id: 'WH-A' },
        lines: [receiptLine()], actor: 'receiver',
      }),
      /item_cost_history unavailable/,
    );
  });

  await test('static contract: receipt WAC no longer reads inv_items.stock as its quantity basis', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'procurement', 'InventoryPostingService.js'), 'utf8');
    const receiptBody = source.slice(source.indexOf('async function applyReceiptStock'), source.indexOf('async function reverseReceiptStock'));
    assert.match(receiptBody, /const warehouse = await _warehouseQty/);
    assert.match(receiptBody, /calc\.newWAC\(\s*warehouseQtyBefore/);
    assert.doesNotMatch(receiptBody, /calc\.newWAC\(\s*(?:stockBefore|item\.stock)/);
    assert.match(source, /INSERT INTO item_cost_history/);
    assert.doesNotMatch(source, /item_cost_history[\s\S]{0,400}catch\s*\([^)]*\)\s*\{\s*\/\*\s*best effort/);
  });

  console.log(`\n${passed}/9 passed\n`);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
