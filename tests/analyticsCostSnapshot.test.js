#!/usr/bin/env node
'use strict';
/**
 * A cost snapshot must be HISTORICAL, and it must be WRITE-ONCE.
 *
 * TWO DEFECTS THIS PINS
 *   1. FABRICATION. `_projectComboChoices` reads `menu.computed_cost` /
 *      `menu.cost` — TODAY's figures — and stores them in a column called
 *      `cost_snapshot`. On the live path that is right: "today" IS the sale
 *      date. On the BACKFILL path the sale may be a year old, so the column
 *      received today's cost and became indistinguishable from a real
 *      historical capture. There is no recoverable per-component historical
 *      cost (ar_document_lines snapshots the whole LINE, and splitting it
 *      needs the very component costs that are missing), so the honest value
 *      is NULL — the same call this function already makes for `price_delta`.
 *
 *   2. DESTRUCTION. The upsert said `cost_snapshot = VALUES(cost_snapshot)`,
 *      so a re-run OVERWROTE a correct at-sale cost with today's. `provenance`
 *      is not in that UPDATE list, so the row kept reporting 'live' while its
 *      number no longer was — a wrong figure carrying a provenance that
 *      vouches for it. And it was reachable in normal operation, not just from
 *      a manual backfill: `_projectO2cReturn` re-projects the ORIGINAL sale
 *      with the RETURN's provenance, so backfilling one return rewrote the
 *      costs of a sale captured correctly months earlier.
 *
 * WHY BOTH A FAKE DB *AND* A LIVE MYSQL PASS
 *   The fake db proves what the FUNCTION decides (null vs a number) by reading
 *   the parameters it actually binds. It cannot prove what MySQL DOES with an
 *   ON DUPLICATE KEY UPDATE clause — `COALESCE(tbl.col, VALUES(col))` either
 *   preserves the stored value or it does not, and only the server can answer
 *   that. Asserting the clause's TEXT would pass a clause that reads
 *   plausibly and preserves nothing. So section 3 runs the real statement
 *   twice against the real table and reads the row back.
 */
const assert = require('assert');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const P = require('../services/analytics/ProjectionService');

let pass = 0, fail = 0;
function it(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  ok   ' + name); })
    .catch((e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); });
}

/* ── fake db: answers the two lookups _projectComboChoices makes, and records
      every INSERT so the bound parameters can be inspected. ── */
function fakeDb({ menuCost }) {
  const inserts = [];
  return {
    inserts,
    async query(sql, params) {
      if (/FROM menu WHERE id IN/i.test(sql)) {
        return [[{ id: 'M-COMP', name: 'Fries', cc: menuCost, c: 0 }]];
      }
      if (/FROM combo_group_items/i.test(sql)) return [[{ group_id: 'G1', menu_item_id: 'M-COMP', qty: 1 }]];
      if (/INSERT INTO analytics_modifier_facts/i.test(sql)) { inserts.push({ sql, params }); return [{}]; }
      return [[]];
    },
  };
}

const SALE = {
  items_json: JSON.stringify([{ id: 'M-PARENT', qty: 2, comboChoices: [{ menuItemId: 'M-COMP', groupId: 'G1' }] }]),
};
const LOC = { businessDay: '2025-01-15', occurredAtLocal: '2025-01-15 12:00:00' };

// The bound-parameter positions of the INSERT's value list.
const COST_PARAM = 7;
const PROV_PARAM = 9;

async function main() {
  console.log('analyticsCostSnapshot');

  console.log('\n1. the figure written on each path');

  await it('live capture stores the menu cost — "today" IS the sale date', async () => {
    const db = fakeDb({ menuCost: 3.25 });
    await P._projectComboChoices(db, 'DOC-L', SALE, LOC, 'live');
    assert.strictEqual(db.inserts.length, 1, 'expected exactly one modifier fact');
    assert.strictEqual(Number(db.inserts[0].params[COST_PARAM]), 3.25);
    assert.strictEqual(db.inserts[0].params[PROV_PARAM], 'live');
  });

  await it('backfill stores NULL, not a cost it cannot know', async () => {
    const db = fakeDb({ menuCost: 3.25 });
    await P._projectComboChoices(db, 'DOC-B', SALE, LOC, 'backfilled');
    assert.strictEqual(db.inserts.length, 1);
    assert.strictEqual(
      db.inserts[0].params[COST_PARAM], null,
      "backfill bound a number — today's cost is being passed off as a historical snapshot",
    );
    assert.strictEqual(db.inserts[0].params[PROV_PARAM], 'backfilled');
  });

  await it('the two paths really do differ — otherwise the pair above proves nothing', async () => {
    const live = fakeDb({ menuCost: 3.25 });
    const back = fakeDb({ menuCost: 3.25 });
    await P._projectComboChoices(live, 'D1', SALE, LOC, 'live');
    await P._projectComboChoices(back, 'D2', SALE, LOC, 'backfilled');
    assert.notStrictEqual(live.inserts[0].params[COST_PARAM], back.inserts[0].params[COST_PARAM]);
  });

  await it('everything ELSE the backfill writes is unchanged — only the cost is withheld', async () => {
    // A fix that degraded the whole row to nulls would also pass the test
    // above. The name, qty and identity must still be projected.
    const db = fakeDb({ menuCost: 3.25 });
    await P._projectComboChoices(db, 'DOC-B', SALE, LOC, 'backfilled');
    const p = db.inserts[0].params;
    assert.strictEqual(p[0], 'DOC-B');
    assert.strictEqual(p[1], 'L0');            // source_line_id
    assert.strictEqual(p[3], 'M-COMP');        // component_menu_id
    assert.strictEqual(p[4], 'Fries');         // name is still projected
    assert.strictEqual(Number(p[5]), 2);       // qty = perPick 1 × picks 1 × lineQty 2
  });

  console.log('\n2. a zero cost is a FACT, and must survive the historical gate');

  await it('a live component genuinely costing 0 stores 0, never NULL', async () => {
    // `costById` used a `!= null` guard, so conflating "no cost" with "zero
    // cost" here would silently reclassify free components as unknown-cost.
    const db = fakeDb({ menuCost: 0 });
    await P._projectComboChoices(db, 'DOC-Z', SALE, LOC, 'live');
    assert.strictEqual(Number(db.inserts[0].params[COST_PARAM]), 0);
    assert.notStrictEqual(db.inserts[0].params[COST_PARAM], null);
  });

  console.log('\n3. the upsert against the REAL table — is a snapshot write-once?');

  const db = require('../db/connection');
  const DOC = '__test_cost_snapshot__';
  const cleanup = () => db.query('DELETE FROM analytics_modifier_facts WHERE document_id = ?', [DOC]);

  let live = true;
  try { await cleanup(); } catch (e) {
    live = false;
    console.log('  SKIP live-MySQL section — ' + (e.code || e.message));
    fail++; // a skipped integrity proof is not a pass
    console.log('       (counted as a FAILURE: this section is the only proof the clause preserves)');
  }

  if (live) {
    // The statement is CAPTURED FROM THE PRODUCTION FUNCTION, never copied.
    //
    // The first version of this section pasted the upsert in as a literal, and
    // a mutation run proved it worthless: reverting the real clause back to
    // the destructive `cost_snapshot = VALUES(cost_snapshot)` left these tests
    // green, because they were executing the paste and not the code. Capturing
    // the SQL means the mutation flows through to MySQL, which is the only
    // thing that can answer whether the clause preserves.
    const capture = async (menuCost, prov, qty) => {
      const sale = {
        items_json: JSON.stringify([
          { id: 'M-PARENT', qty, comboChoices: [{ menuItemId: 'M-COMP', groupId: 'G1' }] },
        ]),
      };
      const fake = fakeDb({ menuCost });
      await P._projectComboChoices(fake, DOC, sale, LOC, prov);
      assert.strictEqual(fake.inserts.length, 1, 'capture produced no INSERT');
      return fake.inserts[0];
    };
    /** Replay one projection exactly as production would emit it. */
    const project = async (menuCost, prov, qty = 1) => {
      const { sql, params } = await capture(menuCost, prov, qty);
      return db.query(sql, params);
    };
    const read = async () => {
      const [r] = await db.query(
        'SELECT cost_snapshot, qty, provenance FROM analytics_modifier_facts WHERE document_id = ?', [DOC]);
      return r[0];
    };

    await it('a re-projection after the menu cost changed keeps the ORIGINAL cost', async () => {
      // The everyday path, not an exotic one: menu costs change, and a sale is
      // re-projected whenever the repair queue drains or a return touches it.
      // Without preservation the snapshot silently tracks the current price
      // list, and last quarter's margins move every time someone edits a menu.
      await cleanup();
      await project(3.25, 'live');
      await project(9.99, 'live');             // same sale, re-projected later
      assert.strictEqual(
        Number((await read()).cost_snapshot), 3.25,
        'the at-sale cost was overwritten — every re-projection rewrites history',
      );
    });

    await it('a backfill arriving after a live capture cannot disturb it', async () => {
      await cleanup();
      await project(3.25, 'live');
      await project(9.99, 'backfilled');
      const r = await read();
      assert.strictEqual(Number(r.cost_snapshot), 3.25);
      assert.strictEqual(r.provenance, 'live', 'provenance must not be downgraded either');
    });

    await it('a real cost DOES fill the NULL a backfill left behind', async () => {
      await cleanup();
      await project(9.99, 'backfilled');        // writes NULL
      assert.strictEqual((await read()).cost_snapshot, null);
      await project(3.25, 'live');
      assert.strictEqual(Number((await read()).cost_snapshot), 3.25);
    });

    await it('qty still refreshes — it is a recomputation, not a snapshot', async () => {
      await cleanup();
      await project(3.25, 'live', 1);
      await project(3.25, 'live', 4);
      assert.strictEqual(Number((await read()).qty), 4);
    });

    await it('re-running the identical projection adds no duplicate — idempotent', async () => {
      await cleanup();
      await project(3.25, 'live');
      await project(3.25, 'live');
      const [r] = await db.query('SELECT COUNT(*) AS c FROM analytics_modifier_facts WHERE document_id = ?', [DOC]);
      assert.strictEqual(Number(r[0].c), 1);
    });

    await cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
