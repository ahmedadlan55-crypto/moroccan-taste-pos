#!/usr/bin/env node
'use strict';
/**
 * The valued stock card and the value roll-forward, driven end-to-end.
 *
 * ─── WHY THESE REPORTS DID NOT EXIST UNTIL NOW ─────────────────────────────
 * Both need the cost of a movement AS IT STOOD WHEN IT HAPPENED.
 * `inventory_movements` stores quantity only and `warehouse_stock.avg_cost` is
 * today's average, so every "historical" valuation was really today's cost
 * wearing an old date. They were kept OUT of the catalogue rather than shipped
 * wrong. `inventory_value_ledger` records cost per movement, so they became
 * answerable.
 *
 * ─── THE CONTRACT THAT MATTERS MOST ────────────────────────────────────────
 * The ledger is FORWARD-ONLY. Rows before `activated_at` were never written,
 * because their cost is not recoverable. So a request reaching back before
 * that date must be REFUSED, not served: a half-covered month looks exactly
 * like a quiet month, and nothing on the page tells the reader which one they
 * are holding. That refusal is the first thing asserted here.
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

// ── The fake ledger ────────────────────────────────────────────────────────
// Activation is 2026-03-01: anything asked about February must be refused.
const STATE = { id: 'default', activated_seq: 100, activated_at: '2026-03-01T08:00:00.000Z', cursor_seq: 400 };

// One item, one warehouse, four movements inside March, plus one BEFORE the
// window so the opening balance has something real to be.
const LEDGER = [
  // before the window — opening only
  { movement_seq: 101, item_id: 'ITEM-1', warehouse_id: 'WH-1', at: '2026-03-02', direction: 'in', quantity: 10, unit_cost: 5, extended_value: 50, cost_basis: 'warehouse_wac' },
  // inside the window
  { movement_seq: 102, item_id: 'ITEM-1', warehouse_id: 'WH-1', at: '2026-03-11', direction: 'in', quantity: 20, unit_cost: 6, extended_value: 120, cost_basis: 'warehouse_wac' },
  { movement_seq: 103, item_id: 'ITEM-1', warehouse_id: 'WH-1', at: '2026-03-12', direction: 'out', quantity: 5, unit_cost: 6, extended_value: 30, cost_basis: 'warehouse_wac' },
  // a movement whose cost could not be established — WRITTEN, and flagged
  { movement_seq: 104, item_id: 'ITEM-1', warehouse_id: 'WH-1', at: '2026-03-13', direction: 'in', quantity: 2, unit_cost: 0, extended_value: 0, cost_basis: 'unknown' },
  // a second item, so the roll-forward has more than one row to total
  { movement_seq: 105, item_id: 'ITEM-2', warehouse_id: 'WH-1', at: '2026-03-14', direction: 'in', quantity: 3, unit_cost: 10, extended_value: 30, cost_basis: 'item_cost' },
];

function inWindow(row, from, to) { return row.at >= from && row.at <= to; }

function fakePool() {
  return {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ');

      if (/FROM inventory_value_ledger_state/i.test(s)) return [[{ ...STATE }]];

      // stock card — opening (strictly before `from`)
      if (/FROM inventory_value_ledger l WHERE l\.item_id = \? AND DATE\(l\.movement_at\) < \?/i.test(s)) {
        const [itemId, from] = params;
        const rows = LEDGER.filter((r) => r.item_id === itemId && r.at < from);
        const qty = rows.reduce((a, r) => a + (r.direction === 'in' ? r.quantity : -r.quantity), 0);
        const value = rows.reduce((a, r) => a + (r.direction === 'in' ? r.extended_value : -r.extended_value), 0);
        return [[{ qty, value }]];
      }

      // stock card — the window itself
      if (/FROM inventory_value_ledger l LEFT JOIN warehouses/i.test(s)) {
        const [itemId, from, to] = params;
        const rows = LEDGER
          .filter((r) => r.item_id === itemId && inWindow(r, from, to))
          .sort((a, b) => a.movement_seq - b.movement_seq)
          .map((r) => ({
            id: 'L-' + r.movement_seq, movement_id: 'MV-' + r.movement_seq,
            movement_at: r.at + ' 10:00:00', accounting_period: r.at.slice(0, 7),
            warehouse_id: r.warehouse_id, warehouse_name: 'مستودع الرياض',
            direction: r.direction, quantity: r.quantity, unit_cost: r.unit_cost,
            extended_value: r.extended_value, cost_basis: r.cost_basis,
            source_type: null, source_id: null, reverses_ledger_id: null, actor: null,
          }));
        // Honour LIMIT: a fake that ignores it hides the overflow guard.
        const m = /LIMIT (\d+)/.exec(s);
        return [m ? rows.slice(0, Number(m[1])) : rows];
      }

      // roll-forward — opening, grouped
      if (/DATE\(l\.movement_at\) < \? GROUP BY l\.item_id/i.test(s)) {
        const [from] = params;
        const byItem = new Map();
        for (const r of LEDGER.filter((x) => x.at < from)) {
          const cur = byItem.get(r.item_id) || { item_id: r.item_id, qty: 0, value: 0 };
          cur.qty += r.direction === 'in' ? r.quantity : -r.quantity;
          cur.value += r.direction === 'in' ? r.extended_value : -r.extended_value;
          byItem.set(r.item_id, cur);
        }
        return [[...byItem.values()]];
      }

      // roll-forward — the window, grouped
      if (/GROUP BY l\.item_id/i.test(s)) {
        const [from, to] = params;
        const byItem = new Map();
        for (const r of LEDGER.filter((x) => inWindow(x, from, to))) {
          const cur = byItem.get(r.item_id)
            || { item_id: r.item_id, in_qty: 0, in_value: 0, out_qty: 0, out_value: 0, unknown_rows: 0 };
          if (r.direction === 'in') { cur.in_qty += r.quantity; cur.in_value += r.extended_value; }
          else { cur.out_qty += r.quantity; cur.out_value += r.extended_value; }
          if (r.cost_basis === 'unknown') cur.unknown_rows += 1;
          byItem.set(r.item_id, cur);
        }
        return [[...byItem.values()]];
      }

      if (/FROM inv_items WHERE id IN/i.test(s)) {
        return [params.map((id) => ({ id, name: 'صنف ' + id }))];
      }

      throw new Error('unexpected query: ' + s.slice(0, 140));
    },
  };
}

function stub(rel, exports) {
  const resolved = require.resolve(path.join(ROOT, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('db/connection.js', fakePool());
// Controllable, so the guard can be driven BOTH ways. A stub that always
// answers yes proves only that the happy path works — it would pass just as
// well for a guard that had quietly stopped checking anything at all.
const caps = { allowed: true };
stub('middleware/requireCapability.js',
  Object.assign(() => (_q, _s, n) => n(), { hasCapability: async () => caps.allowed }));

const express = require(path.join(ROOT, 'node_modules', 'express'));
const app = express();
app.use((req, _res, next) => { req.user = { username: 't' }; req.requestId = 'test'; next(); });
app.use('/api/erp', require(path.join(ROOT, 'routes', 'erp', 'reports', 'inventoryValue.js')));

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const get = (p) => new Promise((res, rej) => {
    http.get({ port, path: p }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res({ status: r.statusCode, json: JSON.parse(b) }); } catch (_) { res({ status: r.statusCode, json: null }); } });
    }).on('error', rej);
  });

  try {
    // ── The refusal ────────────────────────────────────────────────────────
    // February is before activation. The ledger has nothing for it and cannot
    // get it, so the only honest answer is "no".
    {
      const r = await get('/api/erp/reports/inventory-value/stock-card?itemId=ITEM-1&from=2026-02-01&to=2026-03-31');
      eq('a period before the ledger began is REFUSED, not served empty', r.status, 422);
      eq('with a code the UI can act on', r.json && r.json.code, 'LEDGER_STARTS_LATER');
      // The UI needs the real start date to say what IS answerable; without it
      // the only possible message is "try something else".
      check('and the earliest answerable date', /2026-03-01/.test(JSON.stringify(r.json)), r.json);
    }
    {
      const r = await get('/api/erp/reports/inventory-value/roll-forward?from=2026-01-01&to=2026-03-31');
      eq('the roll-forward refuses it too', r.status, 422);
      eq('with the same code', r.json && r.json.code, 'LEDGER_STARTS_LATER');
    }

    // ── The valued stock card ──────────────────────────────────────────────
    {
      const r = await get('/api/erp/reports/inventory-value/stock-card?itemId=ITEM-1&from=2026-03-10&to=2026-03-31');
      eq('the stock card answers', r.status, 200);
      const d = r.json;

      // Opening is everything BEFORE the window, read from the ledger — not
      // supplied by the caller, so it cannot disagree with the rows below it.
      eq('opening quantity comes from the ledger', d.opening.quantity, 10);
      eq('opening value likewise', d.opening.value, 50);

      eq('the window rows are returned', d.data.length, 3);
      // in 20 @6, out 5 @6, in 2 @0 (unknown)
      eq('closing quantity = opening + in - out', d.closing.quantity, 10 + 20 - 5 + 2);
      eq('closing value likewise', d.closing.value, 50 + 120 - 30 + 0);

      // The running balance must be computed over the ORDERED rows, so the
      // column beside each line agrees with the line.
      eq('the running balance walks the rows in order', d.data[0].runningQuantity, 30);
      eq('and the second line continues from the first', d.data[1].runningQuantity, 25);
      eq('running value tracks it', d.data[1].runningValue, 140);

      // A row whose cost could not be established is WRITTEN and FLAGGED. It
      // is included in the count so a reader knows the total rests partly on
      // a zero that means "unknown", not "free".
      eq('rows with no establishable cost are counted, not hidden', d.unknownCostRows, 1);
      eq('and each row carries the basis that produced its number', d.data[0].costBasis, 'warehouse_wac');

      eq('the response says where the ledger begins', d.ledgerStartsAt, '2026-03-01');
    }

    // ── The roll-forward ───────────────────────────────────────────────────
    {
      const r = await get('/api/erp/reports/inventory-value/roll-forward?from=2026-03-10&to=2026-03-31');
      eq('the roll-forward answers', r.status, 200);
      const d = r.json;

      const item1 = d.data.find((x) => x.itemId === 'ITEM-1');
      const item2 = d.data.find((x) => x.itemId === 'ITEM-2');
      check('both items appear', !!item1 && !!item2, d.data.map((x) => x.itemId));

      // THE STATEMENT: opening + in − out = closing, per item. If this stops
      // holding, the report has become a recomputation that happens to land
      // near the truth rather than a proof that it follows from it.
      for (const row of d.data) {
        eq('closing = opening + in - out for ' + row.itemId,
          row.closingValue,
          Number((row.openingValue + row.inValue - row.outValue).toFixed(2)));
      }
      eq('item 1 opening carries in from before the window', item1.openingValue, 50);
      eq('item 1 closing', item1.closingValue, 140);
      // An item with no history before the window opens at zero, not at null.
      eq('an item first seen inside the window opens at zero', item2.openingValue, 0);
      eq('and closes at what moved', item2.closingValue, 30);

      eq('totals add the rows up', d.totals.closingValue, 170);
      eq('and carry the unknown-cost count forward', d.totals.unknownCostRows, 1);
      eq('names are resolved for display', item1.itemName, 'صنف ITEM-1');
    }

    // ── Validation ─────────────────────────────────────────────────────────
    {
      const noItem = await get('/api/erp/reports/inventory-value/stock-card?from=2026-03-01&to=2026-03-31');
      eq('a stock card without an item is a client error', noItem.status, 422);
      const badRange = await get('/api/erp/reports/inventory-value/roll-forward?from=2026-03-31&to=2026-03-01');
      eq('an inverted range is refused', badRange.status, 422);
      const badDate = await get('/api/erp/reports/inventory-value/roll-forward?from=March&to=2026-03-01');
      eq('a non-ISO date is refused', badDate.status, 422);
    }

    // ── The guard actually guards ────────────────────────────────────────
    // A named guard satisfies the static authz sweep by EXISTING and
    // mentioning hasCapability. Only driving it with the answer "no" proves
    // it still acts on that answer.
    {
      caps.allowed = false;
      const denied = await get('/api/erp/reports/inventory-value/roll-forward?from=2026-03-10&to=2026-03-31');
      eq('a user without the capability is refused', denied.status, 403);
      const deniedCard = await get('/api/erp/reports/inventory-value/stock-card?itemId=ITEM-1&from=2026-03-10&to=2026-03-31');
      eq('the stock card too', deniedCard.status, 403);
      caps.allowed = true;
    }
  } finally {
    server.close();
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ valued stock card + value roll-forward; a period before the ledger is refused, not faked');
  console.log(pass + '/' + pass + ' passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
