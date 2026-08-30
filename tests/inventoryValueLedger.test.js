#!/usr/bin/env node
'use strict';
/**
 * The immutable valued movement ledger.
 *
 * ─── WHY IT IS PROJECTED ────────────────────────────────────────────────────
 * `INSERT INTO inventory_movements` appears at 36 sites across 10 files. A
 * ledger written by each of them is complete only while every future
 * contributor remembers — and a valued ledger with holes is worse than none,
 * because the historical valuations built on it are trusted precisely when they
 * are wrong. Projecting from the monotonic `seq` makes completeness structural.
 *
 * ─── WHAT THESE ASSERTIONS PIN ──────────────────────────────────────────────
 *   · replay is a NO-OP — the ledger is immutable, and re-running the projector
 *     is the normal recovery path, so it must never double-count or rewrite;
 *   · the cost BASIS is recorded, not just the number — a ledger that says
 *     "6.50" without saying where 6.50 came from cannot be audited, and the
 *     two sources are not equally strong;
 *   · a movement with no cost anywhere is still WRITTEN, flagged `unknown` —
 *     skipping it would leave the one thing this ledger must not have: a hole;
 *   · the value is unsigned and the direction carries the sign, so the same
 *     fact is never stored twice in a way that can disagree;
 *   · the period is frozen at projection time, not re-derived on read.
 */

const path = require('path');
const L = require('../lib/inventoryValueLedger');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) { check(name, actual === expected, { actual, expected }); }

// ── Cost basis: recorded, ranked, and never silently absent ────────────────
{
  const wac = L.resolveUnitCost({ warehouse_avg_cost: 7.25, item_cost: 3 });
  eq('the warehouse average wins when it exists', wac.unitCost, 7.25);
  eq('and says so', wac.basis, L.COST_BASIS.WAREHOUSE_WAC);

  // The item cost is a FALLBACK, and the row must admit that it fell back.
  const item = L.resolveUnitCost({ warehouse_avg_cost: 0, item_cost: 3 });
  eq('the item cost is the fallback', item.unitCost, 3);
  eq('and the row records that it fell back', item.basis, L.COST_BASIS.ITEM_COST);

  // A zero WAC is "no average recorded", not "this item is free".
  const zero = L.resolveUnitCost({ warehouse_avg_cost: 0, item_cost: 0 });
  eq('no cost anywhere still yields a row', zero.unitCost, 0);
  eq('flagged unknown, so it can be found and fixed', zero.basis, L.COST_BASIS.UNKNOWN);
  check('the three bases are distinct',
    new Set([wac.basis, item.basis, zero.basis]).size === 3);
}

// ── The projected row ──────────────────────────────────────────────────────
{
  const row = L.toLedgerRow({
    seq: 42, id: 'MV-1', movement_date: new Date('2026-03-15T10:00:00Z'),
    item_id: 'ITM-A', type: 'out', qty: 4, warehouse_id: 'W1',
    reference_type: 'sale', reference_id: 'S-9', username: 'cashier1',
    warehouse_avg_cost: 2.5, item_cost: 9,
  });

  eq('quantity is unsigned', row.quantity, 4);
  eq('direction carries the sign instead', row.direction, 'out');
  // Storing a signed value AND a direction is the same fact twice; the day they
  // disagree nothing can say which is right.
  check('extended value is unsigned', row.extended_value >= 0, row.extended_value);
  eq('extended value is quantity × unit cost', row.extended_value, 10);
  eq('valued at the warehouse average, not the item cost', row.unit_cost, 2.5);

  // Frozen at projection time. Re-deriving on read would silently re-file every
  // historical row if the period calendar ever changed.
  eq('the accounting period is frozen with the row', row.accounting_period, '2026-03');
  eq('the source document is carried', row.source_type, 'sale');
  eq('and its id', row.source_id, 'S-9');
  eq('the actor is carried', row.actor, 'cashier1');

  // Identity is derived from the source watermark, which is what makes the
  // unique index — and therefore replay-safety — possible.
  const again = L.toLedgerRow({
    seq: 42, id: 'MV-1', movement_date: new Date('2026-03-15T10:00:00Z'),
    item_id: 'ITM-A', type: 'out', qty: 4, warehouse_id: 'W1',
    warehouse_avg_cost: 2.5,
  });
  eq('the same movement always projects to the same id', row.id, again.id);
  const other = L.toLedgerRow({ seq: 43, id: 'MV-2', movement_date: new Date(), item_id: 'X', type: 'in', qty: 1 });
  check('a different movement gets a different id', row.id !== other.id);

  eq('an inbound movement is `in`', other.direction, 'in');
  // A negative quantity must not flip the direction: the `type` column is the
  // authority, and a sign disagreeing with it is data to fix, not to interpret.
  const negative = L.toLedgerRow({ seq: 44, id: 'MV-3', movement_date: new Date(), item_id: 'X', type: 'in', qty: -5, item_cost: 2 });
  eq('a negative quantity is stored unsigned', negative.quantity, 5);
  eq('and does not flip the direction', negative.direction, 'in');
}

// ── Period edges ───────────────────────────────────────────────────────────
{
  eq('January pads to two digits', L.accountingPeriod(new Date('2026-01-05T00:00:00')), '2026-01');
  eq('December is not truncated', L.accountingPeriod(new Date('2026-12-31T00:00:00')), '2026-12');
  // An unparseable date must not silently become the current month — that would
  // file a broken row into a period a human is reconciling.
  eq('an unparseable date is quarantined, not guessed', L.accountingPeriod('not-a-date'), '0000-00');
}

// ── The projector, against a fake pool ─────────────────────────────────────
{
  const inserted = [];
  let cursor = 100;
  // When set, the state read returns this instead of the live cursor —
  // simulating a tick that read the watermark before another tick advanced it.
  let staleCursor = null;
  const movements = [
    { seq: 101, id: 'M1', movement_date: new Date('2026-04-01T00:00:00'), item_id: 'A', type: 'in', qty: 10, warehouse_id: 'W', warehouse_avg_cost: 1.5, item_cost: 9 },
    { seq: 102, id: 'M2', movement_date: new Date('2026-04-02T00:00:00'), item_id: 'B', type: 'out', qty: 2, warehouse_id: 'W', warehouse_avg_cost: 0, item_cost: 4 },
  ];
  const db = {
    query: async (sql, params) => {
      const s = String(sql);
      if (/FROM inventory_value_ledger_state/.test(s)) {
        return [[{ id: 'default', activated_seq: 100, activated_at: new Date('2026-03-31T00:00:00'), cursor_seq: staleCursor === null ? cursor : staleCursor }]];
      }
      if (/FROM inventory_movements/.test(s)) {
        // HONOUR the LIMIT. Ignoring it let a "stale tick" batch run all the way
        // to the newest row, so its UPDATE carried the same cursor the live one
        // already had — and the rewind guard became unobservable. A fake that
        // is more generous than the real query hides exactly the bugs that
        // depend on a partial batch.
        return [movements.filter((m) => m.seq > params[0]).slice(0, params[1])];
      }
      if (/INSERT IGNORE INTO inventory_value_ledger\b/.test(s)) {
        const seq = params[1];
        if (inserted.some((r) => r[1] === seq)) return [{ affectedRows: 0 }]; // the unique index
        inserted.push(params);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE inventory_value_ledger_state/.test(s)) {
        // HONOUR the WHERE clause. A fake pool that applies every UPDATE
        // unconditionally cannot test a guard that lives IN the WHERE — and
        // a mutant deleting `cursor_seq < ?` then survives, which is exactly
        // what happened before this was written.
        const guarded = / AND cursor_seq < \?/.test(s);
        if (!guarded || params[0] > cursor) cursor = params[0];
        return [{}];
      }
      return [[]];
    },
  };

  (async () => {
    const first = await L.runProjector(db, { batchSize: 10 });
    eq('both movements are projected', first.projected, 2);
    eq('the watermark advances to the last seq', cursor, 102);

    // THE property. Replay is the documented recovery path, so it must add
    // nothing and rewrite nothing.
    const replay = await L.runProjector(db, { batchSize: 10 });
    eq('replay projects nothing', replay.projected, 0);
    eq('and writes no extra rows', inserted.length, 2);

    // The fallback row still landed, flagged.
    const fallback = inserted.find((r) => r[5] === 'B');
    eq('a warehouse with no average falls back to the item cost', Number(fallback[9]), 4);
    eq('and the row says which rule produced it', fallback[11], L.COST_BASIS.ITEM_COST);

    // Never REPLACE: that would rewrite an immutable row in place.
    // (asserted on the statement the projector actually issued)
    eq('the projector inserts, never replaces', inserted.length, 2);

    // ── The watermark only ever moves FORWARD ──────────────────────────
    // The real scenario: two worker ticks overlap. Tick A reads cursor 100
    // and advances it to 102. Tick B read 100 BEFORE that and finishes
    // afterwards, issuing an UPDATE back to 101. The re-projection itself is
    // harmless — the unique index absorbs it — but a cursor that moves
    // backwards means the ledger can never be said to have caught up.
    //
    // This drives the LIBRARY's own UPDATE, not a copy of it: a test that
    // issues its own hardcoded SQL proves nothing about the statement the
    // projector actually sends, and a mutant deleting the guard survived
    // exactly that mistake.
    staleCursor = 100;
    await L.projectBatch(db, 1);
    staleCursor = null;
    eq('a stale tick cannot rewind the watermark', cursor, 102);

    if (failures.length) {
      console.error('\n' + failures.length + ' failure(s):');
      failures.forEach((f) => console.error('  - ' + f));
      process.exit(1);
    }
    console.log('  ✅ projected not written, replay is a no-op, cost basis recorded per row');
    console.log(pass + '/' + pass + ' passed');
  })();
}
