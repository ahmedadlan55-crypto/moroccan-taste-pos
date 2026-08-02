#!/usr/bin/env node
'use strict';
/**
 * SUM(payment legs for a source) must equal the amount collected — after ANY
 * number of replays, in any order.
 *
 * THE DEFECT
 *   Legs are keyed UNIQUE(source_type, source_id, line_no) and written in a
 *   `for i < legs.length` loop, so a replay only ever wrote line_no 0..N-1 and
 *   nothing removed the rows above N.
 *
 *     3 legs → 2 legs   left leg #3 in place; the sale over-reported.
 *     split  → single   was worse. `source_type` is ALSO part of the key and
 *                       flips between 'pos_single' and 'pos_split', so the
 *                       replay overwrote nothing — it ADDED a row under the
 *                       other type. Three split legs plus one single leg: four
 *                       legs, roughly double the money.
 *
 *   Replays are ordinary traffic: the repair queue drains, a return
 *   re-projects its original sale, the backfill re-runs.
 *
 * WHY THIS RUNS AGAINST REAL MYSQL AND REPLAYS THE CAPTURED STATEMENTS
 *   The bug lives in the interaction between an upsert, a compound unique key
 *   and a delete. A fake db can record that a DELETE was issued; only the
 *   server can say what the table CONTAINS afterwards, which is the only thing
 *   the invariant is about. And the statements are captured from the
 *   production function rather than pasted, so breaking the real prune breaks
 *   these tests — a pasted copy would keep them green while production leaked.
 *   (An earlier sibling test learned that the hard way.)
 */
const assert = require('assert');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const P = require('../services/analytics/ProjectionService');
const db = require('../db/connection');

let pass = 0, fail = 0;
function it(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log('  ok   ' + name); })
    .catch((e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); });
}

const SALE_ID = '__test_replay_sale__';
const CN_ID = '__test_replay_cn__';

/**
 * Run the REAL `projectPosSale` against a recording handle, then replay only
 * the statements it aimed at analytics_payment_facts onto MySQL.
 *
 * WHY THE WHOLE FUNCTION AND NOT JUST THE HELPERS
 *   The first version of this file called `_upsertPaymentFact` and
 *   `_pruneStalePaymentLegs` directly, with the source-type list written out
 *   by hand. A mutation run exposed it: DELETING the prune from
 *   projectPosSale entirely, and narrowing its source-type list so the
 *   split↔single flip leaks again, both left every test green — because the
 *   test was supplying the arguments the production call site is responsible
 *   for. Driving projectPosSale means the CALL SITE is under test, not just
 *   the helper it calls.
 *
 * The fake answers the reads (no sale, branch or pos_order needs to exist) and
 * the writes are replayed for real, so MySQL still decides what the table
 * ends up containing.
 */
async function projectSale(legs) {
  const stmts = [];
  const fake = {
    async query(sql, params) {
      if (/^\s*SELECT \* FROM sales WHERE id/i.test(sql)) {
        return [[{
          id: SALE_ID, branch_id: 'B1', brand_id: null, shift_id: null,
          order_date: '2026-01-15 12:00:00', total_final: 100,
          payment_method: legs.length > 1 ? 'Split' : legs[0].label,
          // The leg shape under test, in the first shape _resolvePaymentLegs reads.
          split_details_json: legs.length > 1 ? JSON.stringify(legs.map(
            (l) => ({ method: l.label, amount: l.amount }))) : null,
          items_json: '[]', username: 'tester',
        }]];
      }
      if (/INSERT INTO analytics_payment_facts|DELETE FROM analytics_payment_facts/i.test(sql)) {
        stmts.push([sql, params]);
        return [{}];
      }
      return [[]]; // ar_documents, pos_orders, shifts, branches: all absent
    },
  };

  await P.projectPosSale(fake, SALE_ID);
  assert.ok(stmts.length, 'projectPosSale emitted no payment-fact statements at all');
  for (const [sql, params] of stmts) await db.query(sql, params);
}

async function state(sourceId) {
  const [r] = await db.query(
    `SELECT source_type, line_no, amount FROM analytics_payment_facts
      WHERE source_id = ? ORDER BY source_type, line_no`, [sourceId]);
  return {
    count: r.length,
    sum: Number(r.reduce((s, x) => s + Number(x.amount), 0).toFixed(2)),
    types: [...new Set(r.map((x) => x.source_type))].sort(),
  };
}

const clean = (id) => db.query('DELETE FROM analytics_payment_facts WHERE source_id = ?', [id]);

const SINGLE = [{ label: 'cash', amount: 100 }];
const TWO = [{ label: 'cash', amount: 40 }, { label: 'card', amount: 60 }];
const THREE = [{ label: 'cash', amount: 30 }, { label: 'card', amount: 50 }, { label: 'wallet', amount: 20 }];

async function main() {
  console.log('analyticsPaymentReplay');

  try { await clean(SALE_ID); } catch (e) {
    console.log('  FATAL: MySQL unreachable — ' + (e.code || e.message));
    console.log('  This suite cannot be satisfied without a server; refusing to report a pass.');
    process.exit(2);
  }

  console.log('\n1. the four replay transitions the invariant must survive');

  await it('single → split: 100 becomes 40+60, not 100+40+60', async () => {
    await clean(SALE_ID);
    await projectSale(SINGLE);
    await projectSale(TWO);
    const s = await state(SALE_ID);
    assert.strictEqual(s.count, 2, `expected 2 legs, found ${s.count} (${s.types.join('+')})`);
    assert.strictEqual(s.sum, 100);
    assert.deepStrictEqual(s.types, ['pos_split']);
  });

  await it('split → single: the three split legs do not survive alongside the single', async () => {
    await clean(SALE_ID);
    await projectSale(THREE);
    await projectSale(SINGLE);
    const s = await state(SALE_ID);
    assert.strictEqual(s.count, 1, `expected 1 leg, found ${s.count} (${s.types.join('+')})`);
    assert.strictEqual(s.sum, 100, 'the sale reported more money than was collected');
    assert.deepStrictEqual(s.types, ['pos_single']);
  });

  await it('3 legs → 2 legs: the third is removed, not orphaned', async () => {
    await clean(SALE_ID);
    await projectSale(THREE);
    await projectSale(TWO);
    const s = await state(SALE_ID);
    assert.strictEqual(s.count, 2);
    assert.strictEqual(s.sum, 100);
  });

  await it('the same event replayed five times is indistinguishable from once', async () => {
    await clean(SALE_ID);
    for (let i = 0; i < 5; i++) await projectSale(TWO);
    const s = await state(SALE_ID);
    assert.strictEqual(s.count, 2);
    assert.strictEqual(s.sum, 100);
  });

  console.log('\n2. the invariant under a longer, disordered replay history');

  await it('shape churn in both directions still lands on the final shape only', async () => {
    await clean(SALE_ID);
    for (const shape of [TWO, SINGLE, THREE, SINGLE, TWO, THREE]) await projectSale(shape);
    const s = await state(SALE_ID);
    assert.strictEqual(s.count, 3, `expected 3 legs, found ${s.count}`);
    assert.strictEqual(s.sum, 100);
    assert.deepStrictEqual(s.types, ['pos_split'], 'a stale pos_single row survived the churn');
  });

  await it('a leg amount that CHANGES is updated, not duplicated', async () => {
    // Proves the prune did not turn the upsert into an append.
    await clean(SALE_ID);
    await projectSale(TWO);
    await projectSale([{ label: 'cash', amount: 70 }, { label: 'card', amount: 30 }]);
    const s = await state(SALE_ID);
    assert.strictEqual(s.count, 2);
    assert.strictEqual(s.sum, 100);
  });

  console.log('\n3. the prune is scoped — it must not touch a neighbour');

  await it('projecting one sale leaves another sale\'s legs alone', async () => {
    const OTHER = '__test_replay_other__';
    await clean(SALE_ID); await clean(OTHER);
    await db.query(
      `INSERT INTO analytics_payment_facts
         (source_type, source_id, line_no, document_id, branch_id, method_raw, method_norm,
          direction, amount, status, occurred_at, occurred_at_local, business_day, provenance)
       VALUES ('pos_split',?,0,?, 'B1','cash','cash','in',55,'captured',
               '2026-01-15 12:00:00','2026-01-15 12:00:00','2026-01-15','live')`,
      [OTHER, OTHER]);
    await projectSale(SINGLE);
    const other = await state(OTHER);
    assert.strictEqual(other.count, 1, 'the prune deleted a different sale\'s leg');
    assert.strictEqual(other.sum, 55);
    await clean(OTHER);
  });

  await it('an ar_receipt leg on the same id is not collateral damage', async () => {
    // The prune names its source types explicitly; a WHERE on source_id alone
    // would wipe unrelated fact families that happen to share an id.
    await clean(SALE_ID);
    await db.query(
      `INSERT INTO analytics_payment_facts
         (source_type, source_id, line_no, document_id, branch_id, method_raw, method_norm,
          direction, amount, status, occurred_at, occurred_at_local, business_day, provenance)
       VALUES ('ar_receipt',?,0,NULL,'B1','cash','cash','in',12,'captured',
               '2026-01-15 12:00:00','2026-01-15 12:00:00','2026-01-15','live')`,
      [SALE_ID]);
    await projectSale(TWO);
    const [r] = await db.query(
      `SELECT COUNT(*) AS c FROM analytics_payment_facts
        WHERE source_id = ? AND source_type = 'ar_receipt'`, [SALE_ID]);
    assert.strictEqual(Number(r[0].c), 1, 'the prune reached outside its declared source types');
  });

  await clean(SALE_ID);
  await clean(CN_ID);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
