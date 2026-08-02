#!/usr/bin/env node
'use strict';
/**
 * `discount_reason` must be a REAL dimension — projected, stored, groupable.
 *
 * WHAT WAS WRONG
 *   The id was reserved in registry/dimensions.js with `facts: {}` — groupable
 *   in the contract, expressible on no fact. The planner rejected it against
 *   every metric, so the client greyed it out with "no data source" and the
 *   Group By menu carried an option that could never return a row. The source
 *   data existed the whole time: `sales.discount_name` is written at checkout
 *   and nothing read it. "Discounts by reason" is the first question anyone
 *   asks of a discount report, and it was unanswerable.
 *
 * THE TWO CONTRACTS THIS PINS
 *   1. NULL, NEVER ''. A sale with no named discount must project NULL. An
 *      empty string is a VALUE: it becomes its own GROUP BY bucket and prints
 *      as a blank row that reads like a reason someone forgot to type.
 *   2. THE REASON REFRESHES, IN LOCKSTEP WITH THE AMOUNT. This is the opposite
 *      of the write-once rule its neighbour `cost_snapshot` follows, and the
 *      difference is deliberate — see the comment on the upsert in
 *      ProjectionService. `cost_snapshot` is frozen because its source
 *      (menu.cost) is EXTERNAL and drifts, so a replay a year later would
 *      rewrite history with today's number. This column's source is the sale's
 *      OWN row, so a replay re-reads the identical value; it changes only when
 *      the sale changed. And `discount_total` — the amount this label names —
 *      already refreshes in that same clause. Freeze one half of the pair and
 *      they can contradict: a discount edited off a sale would leave
 *      discount_total 0 next to a reason still naming it.
 *
 * WHY THE STATEMENTS ARE CAPTURED FROM `projectPosSale` AND REPLAYED
 *   Both sibling suites (analyticsCostSnapshot, analyticsPaymentReplay) were
 *   rewritten after a mutation run proved the earlier shape worthless: a test
 *   that calls a helper with hand-written arguments, or replays a pasted copy
 *   of the SQL, stays green when the real call site is deleted. So the fake
 *   handle here only ANSWERS the reads `projectPosSale` makes and RECORDS the
 *   order-fact statement it emits; the writes are replayed against real MySQL,
 *   which is the only thing that can say what an ON DUPLICATE KEY UPDATE clause
 *   actually preserves or refreshes.
 *
 * And nothing below asserts against a hardcoded 100: the column width is read
 * from INFORMATION_SCHEMA, so the projector's cap is checked against the
 * schema it must not exceed rather than against a second copy of the number.
 */
const assert = require('assert');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const P = require('../services/analytics/ProjectionService');
const planner = require('../lib/analytics/planner');
const grouping = require('../lib/analytics/registry/grouping');
const db = require('../db/connection');

let pass = 0, fail = 0;
function it(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log('  ok   ' + name); })
    .catch((e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); });
}

const BRANCH = '__test_dr_branch__';
const IDS = ['__test_dr_named__', '__test_dr_none__', '__test_dr_long__'];

/**
 * Drive the REAL projectPosSale over a recording handle and hand back the
 * analytics_order_facts statement it emitted. Every read the function makes is
 * answered here (no sale, ar_document, pos_order or branch row needs to exist);
 * every write it aims at another fact table is swallowed.
 */
async function captureOrderFact(saleId, sale) {
  const stmts = [];
  const fake = {
    async query(sql, params) {
      if (/^\s*SELECT \* FROM sales WHERE id/i.test(sql)) {
        return [[Object.assign({
          id: saleId, branch_id: BRANCH, brand_id: null, shift_id: null,
          order_date: '2026-07-20 13:00:00', total_final: 50, payment_method: 'cash',
          items_json: '[]', username: 'tester', discount_amount: 0,
        }, sale)]];
      }
      if (/INSERT INTO analytics_order_facts/i.test(sql)) { stmts.push({ sql, params }); return [{}]; }
      return [[]]; // ar_documents, pos_orders, shifts, branches: all absent
    },
  };
  await P.projectPosSale(fake, saleId);
  assert.strictEqual(stmts.length, 1, 'projectPosSale emitted no order-fact INSERT at all');
  return stmts[0];
}

/**
 * The value bound to a named column, located by parsing the statement's OWN
 * column list. A fixed index would keep passing if a column were inserted
 * ahead of it and every value silently shifted one place.
 */
function bound(stmt, column) {
  const cols = stmt.sql.slice(stmt.sql.indexOf('(') + 1, stmt.sql.indexOf(')'))
    .split(',').map((s) => s.trim());
  const idx = cols.indexOf(column);
  assert.ok(idx >= 0, `the INSERT does not name a "${column}" column at all`);
  assert.strictEqual(cols.length, stmt.params.length,
    `the INSERT names ${cols.length} columns but binds ${stmt.params.length} values`);
  return stmt.params[idx];
}

/** Replay a captured projection against real MySQL. */
const replay = (stmt) => db.query(stmt.sql, stmt.params);

async function readFact(id) {
  const [r] = await db.query(
    'SELECT discount_reason, discount_total, status FROM analytics_order_facts WHERE document_id = ?', [id]);
  return r[0];
}

async function cleanup() {
  for (const id of IDS) {
    await db.query('DELETE FROM analytics_order_facts WHERE document_id = ?', [id]);
    await db.query('DELETE FROM ar_documents WHERE id = ?', [id]);
  }
  await db.query('DELETE FROM analytics_rollup_dirty WHERE branch_id = ?', [BRANCH]);
}

async function main() {
  console.log('analyticsDiscountReason');

  try { await cleanup(); } catch (e) {
    console.log('  FATAL: MySQL unreachable — ' + (e.code || e.message));
    console.log('  This suite cannot be satisfied without a server; refusing to report a pass.');
    process.exit(2);
  }

  // The width the projector must not exceed, read from the schema itself.
  const [wrows] = await db.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS w FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'analytics_order_facts'
        AND column_name = 'discount_reason'`);
  const WIDTH = wrows.length ? Number(wrows[0].w) : null;
  if (!WIDTH) {
    console.log('  FATAL: analytics_order_facts.discount_reason does not exist —'
      + ' run `node scripts/analytics/migrate.js` (the additive analytics migration).');
    process.exit(2);
  }
  console.log(`  (column width from INFORMATION_SCHEMA: ${WIDTH})`);

  console.log('\n1. what projectPosSale binds for the reason');

  await it('a sale with a discount name projects that name', async () => {
    const s = await captureOrderFact(IDS[0], { discount_name: 'Staff meal', discount_amount: 12 });
    assert.strictEqual(bound(s, 'discount_reason'), 'Staff meal');
  });

  await it('surrounding whitespace is trimmed — " Staff meal " is not a second reason', async () => {
    // Untrimmed, the same discount arrives as several distinct GROUP BY keys
    // and the report splits one reason across three rows.
    const s = await captureOrderFact(IDS[0], { discount_name: '  Staff meal\n', discount_amount: 12 });
    assert.strictEqual(bound(s, 'discount_reason'), 'Staff meal');
  });

  await it('no discount projects NULL, not an empty string', async () => {
    for (const name of [null, undefined, '', '   ']) {
      const s = await captureOrderFact(IDS[1], { discount_name: name, discount_amount: 0 });
      assert.strictEqual(
        bound(s, 'discount_reason'), null,
        `discount_name ${JSON.stringify(name)} bound ${JSON.stringify(bound(s, 'discount_reason'))}`
        + " — '' is a value and becomes its own blank bucket in a GROUP BY",
      );
    }
  });

  await it('a name wider than the column is capped TO THE COLUMN, whatever that width is', async () => {
    const s = await captureOrderFact(IDS[2], { discount_name: 'ب'.repeat(WIDTH + 40), discount_amount: 1 });
    const v = bound(s, 'discount_reason');
    assert.ok(v.length <= WIDTH, `bound ${v.length} chars into a VARCHAR(${WIDTH}) column`);
    assert.strictEqual(v.length, WIDTH, 'the cap must fill the column, not shorten it further');
  });

  await it('the rest of the order fact is unchanged — only the reason was added', async () => {
    // A regression that nulled the row would satisfy the NULL test above.
    const s = await captureOrderFact(IDS[0], { discount_name: 'Staff meal', discount_amount: 12 });
    assert.strictEqual(bound(s, 'document_id'), IDS[0]);
    assert.strictEqual(bound(s, 'branch_id'), BRANCH);
    assert.strictEqual(Number(bound(s, 'discount_total')), 12);
    assert.strictEqual(bound(s, 'source'), 'pos');
    assert.strictEqual(bound(s, 'status'), 'completed');
  });

  console.log('\n2. the upsert against the REAL table — refresh, in lockstep with the amount');

  await it('the projected reason is what the table ends up holding', async () => {
    await cleanup();
    await replay(await captureOrderFact(IDS[0], { discount_name: 'Staff meal', discount_amount: 12 }));
    assert.strictEqual((await readFact(IDS[0])).discount_reason, 'Staff meal');
  });

  await it('an unnamed discount is stored as SQL NULL — no empty-string rows exist', async () => {
    await cleanup();
    await replay(await captureOrderFact(IDS[1], { discount_name: '   ', discount_amount: 0 }));
    assert.strictEqual((await readFact(IDS[1])).discount_reason, null);
    const [r] = await db.query(
      "SELECT COUNT(*) AS c FROM analytics_order_facts WHERE branch_id = ? AND discount_reason = ''", [BRANCH]);
    assert.strictEqual(Number(r[0].c), 0, "an '' reason reached the table");
  });

  await it('a re-projection after the sale was re-labelled REFRESHES the reason', async () => {
    // The deliberate opposite of cost_snapshot's write-once rule: this value is
    // re-read from the sale's own row, so the stored label must track it.
    await cleanup();
    await replay(await captureOrderFact(IDS[0], { discount_name: 'Staff meal', discount_amount: 12 }));
    await replay(await captureOrderFact(IDS[0], { discount_name: 'Manager comp', discount_amount: 12 }));
    assert.strictEqual((await readFact(IDS[0])).discount_reason, 'Manager comp');
  });

  await it('reason and amount move TOGETHER through every replay — neither goes stale', async () => {
    // The property, not a constant: after any sequence of re-projections the
    // stored (reason, amount) pair must equal the LAST sale state projected.
    // A write-once reason beside a refreshing amount passes each half alone and
    // still ends up reporting last month's label against this month's money.
    await cleanup();
    const history = [
      { discount_name: 'Staff meal', discount_amount: 12 },
      { discount_name: 'Loyalty', discount_amount: 5 },
      { discount_name: null, discount_amount: 0 },        // discount removed
      { discount_name: 'Manager comp', discount_amount: 8 },
    ];
    for (const sale of history) {
      await replay(await captureOrderFact(IDS[0], sale));
      const row = await readFact(IDS[0]);
      const expected = sale.discount_name == null ? null : sale.discount_name;
      assert.strictEqual(row.discount_reason, expected,
        `after projecting ${JSON.stringify(sale)} the table holds ${JSON.stringify(row.discount_reason)}`);
      assert.strictEqual(Number(row.discount_total), sale.discount_amount);
    }
  });

  await it('removing a discount clears the reason — no label left beside a zero', async () => {
    await cleanup();
    await replay(await captureOrderFact(IDS[0], { discount_name: 'Staff meal', discount_amount: 12 }));
    await replay(await captureOrderFact(IDS[0], { discount_name: null, discount_amount: 0 }));
    const row = await readFact(IDS[0]);
    assert.strictEqual(row.discount_reason, null, 'the reason outlived the discount it named');
    assert.strictEqual(Number(row.discount_total), 0);
  });

  await it('a capped name survives the round trip — MySQL never truncates it for us', async () => {
    // With STRICT_TRANS_TABLES an over-long bind ERRORS instead of truncating,
    // so this both stores and re-reads the widest legal value.
    await cleanup();
    const s = await captureOrderFact(IDS[2], { discount_name: 'ب'.repeat(WIDTH + 40), discount_amount: 1 });
    await replay(s);
    assert.strictEqual((await readFact(IDS[2])).discount_reason, bound(s, 'discount_reason'));
  });

  await it('replaying the identical projection adds no duplicate row', async () => {
    await cleanup();
    const s = await captureOrderFact(IDS[0], { discount_name: 'Staff meal', discount_amount: 12 });
    await replay(s); await replay(s);
    const [r] = await db.query(
      'SELECT COUNT(*) AS c FROM analytics_order_facts WHERE document_id = ?', [IDS[0]]);
    assert.strictEqual(Number(r[0].c), 1);
  });

  console.log('\n3. the dimension is real — registry, metadata route, and the planner');

  await it('the registry maps discount_reason to the order fact, and only there', async () => {
    assert.deepStrictEqual(grouping.dimensionFacts('discount_reason'), ['order']);
    assert.ok(grouping.supports('discounts_total', 'discount_reason'),
      'the discount amount cannot be grouped by its own reason');
  });

  await it('GET /api/analytics/metadata ships it as supported on a fact', async () => {
    // The REAL route module, driven directly — the client builds its Group By
    // menu from this payload, and an empty `facts` list is what made the UI
    // print "no data source".
    const router = require('../routes/analytics/metadata');
    const handler = router.stack[0].route.stack[0].handle;
    const req = { analyticsScope: { caps: new Set(['analytics.view']) } };
    const payload = await new Promise((resolve, reject) => {
      handler(req, { json: resolve, status: () => ({ json: reject }) }).catch(reject);
    });
    const d = payload.data.dimensions.find((x) => x.id === 'discount_reason');
    assert.ok(d, 'the metadata route no longer ships the dimension at all');
    assert.ok(d.groupable, 'shipped as not groupable');
    assert.deepStrictEqual(d.facts, ['order'], `metadata ships facts ${JSON.stringify(d.facts)}`);
  });

  await it('the REAL planner groups by it and MySQL returns the projected reasons', async () => {
    await cleanup();
    // Three sales on one branch: two named reasons and one unnamed.
    const seed = [
      [IDS[0], { discount_name: 'Staff meal', discount_amount: 12 }],
      [IDS[1], { discount_name: null, discount_amount: 0 }],
      [IDS[2], { discount_name: 'Loyalty', discount_amount: 5 }],
    ];
    for (const [id, sale] of seed) {
      await replay(await captureOrderFact(id, sale));
      // the order fact's FROM joins ar_documents — the invoice must exist
      await db.query(
        `INSERT INTO ar_documents (id, document_number, issue_date, source_type, source_id,
                                   document_type, status, branch_id)
         VALUES (?,?,?,'pos',?,'invoice','issued',?)`,
        [id, 'DR-' + id.slice(-8), '2026-07-20', id, BRANCH]);
    }
    // The day the projector itself attributed these to — never a guess.
    const day = (await db.query(
      'SELECT business_day FROM analytics_order_facts WHERE document_id = ?', [IDS[0]]))[0][0].business_day;
    const iso = day instanceof Date
      ? new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
      : String(day).slice(0, 10);

    const plan = planner.plan(
      { metrics: ['discounts_total', 'orders'], dimensions: ['discount_reason'], range: { from: iso, to: iso } },
      { caps: new Set(['analytics.view']), all: false, branchIds: [BRANCH] },
      { mealPeriods: [] },
    );
    assert.strictEqual(plan.statements.length, 1, 'expected one order-fact statement');
    const st = plan.statements[0];
    const [rows] = await db.query(st.rows.sql, st.rows.params);

    const byReason = new Map(rows.map((r) => [r.d0, r]));
    assert.strictEqual(byReason.size, 3,
      `expected 3 groups (2 reasons + the unnamed bucket), got ${byReason.size}: `
      + JSON.stringify(rows));
    assert.strictEqual(Number(byReason.get('Staff meal').m_discounts_total), 12);
    assert.strictEqual(Number(byReason.get('Loyalty').m_discounts_total), 5);
    assert.ok(byReason.has(null), 'the unnamed sale did not land in the NULL bucket');
    assert.strictEqual(Number(byReason.get(null).m_orders), 1);
    // Every projected reason is reachable through the planner — the whole point.
    for (const [id, sale] of seed) {
      const expected = sale.discount_name;
      if (expected == null) continue;
      assert.ok(byReason.has(expected), `${id}'s reason "${expected}" is not groupable`);
    }
  });

  await cleanup();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
