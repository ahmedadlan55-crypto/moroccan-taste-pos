#!/usr/bin/env node
'use strict';
/**
 * tests/salesPostingService.test.js — the DB-touching half of «ترحيل المبيعات».
 *
 * The arithmetic is covered by salesPostingAggregate.test.js. What can only go
 * wrong HERE is concurrency, atomicity, and the period-close guard — so that
 * is what this pins, mostly by asserting the shape of the code, because these
 * are properties a unit test with a fake connection would happily fake too.
 *
 * Run: node tests/salesPostingService.test.js   (pure, no DB)
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const post = require('../lib/salesPosting/post');
const glTransitions = require('../lib/glTransitions');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * Drop comment lines, WITHOUT a greedy block-comment regex.
 *
 * `s.replace(/\/\*[\s\S]*?\*\//g, '')` looks equivalent and is not: a lone
 * `/*` inside a string literal or a regex makes it swallow everything up to
 * the next `*\/` anywhere in the file. On routes/erp.js that ate the entire
 * period-close guard, and six assertions failed against code that was present
 * and correct.
 *
 * A line-based filter cannot over-reach. It also normalises CRLF, which these
 * files use and the multi-line patterns below depend on.
 */
const code = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── 1. The claim must be an explicit id list ─────────────────────────────
// A range predicate (WHERE business_day = ?) takes gap locks over the range a
// concurrent CHECKOUT is inserting into — so a contended posting run would
// block the till. Any lock-contention path that reaches the register is
// unacceptable.
{
  const src = code(read('lib', 'salesPosting', 'post.js'));
  check('the claim names ids explicitly', /UPDATE sales_posting_queue\s*\n?\s*SET status = 'posting'\s*\n?\s*WHERE id IN \(/.test(src), src.match(/UPDATE sales_posting_queue[\s\S]{0,160}/));
  check('…and is conditional on the row still being unposted',
    /WHERE id IN \(\$\{ids\.map\(\(\) => '\?'\)\.join\(','\)\}\)\s*\n\s*AND status IN \('pending', 'failed'\)/.test(src));
  check('…and affectedRows decides what was actually won',
    /claim\.affectedRows !== ids\.length/.test(src));
  check('a partial claim is a 409, not a silent partial post',
    /code = 'claim_conflict'; e\.status = 409/.test(src));
  check('the claim never uses a date range predicate',
    !/SET status = 'posting'[\s\S]{0,200}business_day/.test(src));
}

// ── 2. Claim + post + record are ONE transaction ─────────────────────────
// A crash between "the journal committed" and "the queue rows were marked
// posted" would let a retry create a SECOND complete journal and apply
// gl_accounts.balance twice — postJournal has no idempotency and ix_glj_ref is
// deliberately non-unique, so nothing downstream would stop it.
{
  const src = code(read('lib', 'salesPosting', 'post.js'));
  check('postBatch runs inside withTransaction', /return pool\.withTransaction\(async \(conn\) => \{/.test(src));
  const tx = src.slice(src.indexOf('withTransaction'));
  const claimAt = tx.indexOf("SET status = 'posting'");
  const postAt = tx.indexOf('glPosting.postJournal');
  const recordAt = tx.indexOf('INSERT INTO sales_posting_batches');
  const markAt = tx.indexOf("SET status = 'posted'");
  check('order is claim → post → record → mark',
    claimAt > 0 && claimAt < postAt && postAt < recordAt && recordAt < markAt,
    { claimAt, postAt, recordAt, markAt });
  check('the journal is posted on the TRANSACTION connection',
    /glPosting\.postJournal\(conn,/.test(src));
  check('a GL failure aborts the whole unit', /code = 'gl_post_failed'; e\.status = 500; throw e/.test(src));
}

// ── 3. Three layers against double-posting ───────────────────────────────
{
  const src = code(read('lib', 'salesPosting', 'post.js'));
  const schema = read('db', 'migrations', 'sales-posting', 'schema.js');
  check('layer 1 — a unique idempotency key on the batch', /UNIQUE KEY uq_spb_idem/.test(schema));
  check('…and postBatch always supplies one', /const idempotencyKey = baseKey\.slice/.test(src));
  check('…deterministic, so a double-click collapses even without a client key',
    /granularity \+ ':' \+ bucketKey/.test(src));
  check('late arrivals and reversals advance one durable bucket counter',
    /nextPostingCycle\(conn, granularity, bucketKey\)/.test(src) &&
    /CREATE TABLE sales_posting_bucket_sequences/.test(schema));
  check('the bucket counter increment is a row lock inside the transaction',
    /ON DUPLICATE KEY UPDATE last_cycle = last_cycle \+ 1/.test(src) &&
    /SELECT last_cycle[\s\S]{0,160}FOR UPDATE/.test(src));
  check('layer 2 — the conditional claim', /AND status IN \('pending', 'failed'\)/.test(src));
  check('layer 3 — one queue row per economic event', /UNIQUE KEY uq_spq_source/.test(schema));
}

// ── 4. created_by is the system, posted_by is the human ──────────────────
// checkSelfApproval compares created_by to the acting user, so recording the
// human as creator would forbid them from posting their own batch under
// maker/checker. It is also simply true: the batch is generated by the system
// from documents already filed — the stance _generateClosingEntries takes.
{
  const src = code(read('lib', 'salesPosting', 'post.js'));
  check('the INSERT names created_by then posted_by',
    /created_by, posted_by, posted_at\)/.test(src));
  check("created_by is hard-coded to the system, posted_by is a parameter",
    /'system:sales-posting', \?, NOW\(\)\)/.test(src));
  check('…and that parameter is the acting user',
    /idempotencyKey, actor \|\| ''\]\)/.test(src));
}

// ── 5. A reversal is dated in the ORIGINAL's period ──────────────────────
// Reversing a month-end batch on the 3rd of the next month would move the
// correction into a period the original never touched — and be refused once
// that month is closed, leaving a wrong journal standing with no way to undo.
{
  const src = code(read('lib', 'salesPosting', 'post.js'));
  check('reverseBatch passes the batch journal date', /journalDate: batch\.journal_date/.test(src));
  check('…and reuses glTransitions.reverse rather than reimplementing it',
    /glTransitions\.reverse\(batch\.journal_id/.test(src));

  const gt = code(read('lib', 'glTransitions.js'));
  check('reverse honours a caller-supplied date', /opts\.journalDate[\s\S]{0,120}toAccountingDate\(opts\.journalDate\)/.test(gt));
  check('…and still defaults to today from MySQL', /: riyadhToday;/.test(gt));
  check('reverse has a REAL require for accountingDate (not one in a comment)',
    /const acctDate = require\('\.\/accountingDate'\)/.test(gt));
  check('reverse can join a caller-owned transaction without nesting one',
    /opts\.conn[\s\S]{0,100}runOnConnection\(opts\.conn\)/.test(gt));

  check('the queue rows go back to pending so they can be re-posted',
    /SET status = 'pending', batch_id = NULL/.test(src));
  check('reversal clears the invoice link only when it points at this batch journal',
    /SET d\.gl_journal_id = NULL[\s\S]{0,180}d\.gl_journal_id = \?/.test(src));
  check('…but batch_items are NOT deleted (history stays answerable)',
    !/DELETE FROM sales_posting_batch_items/.test(src));
  check('the batch row itself is locked before reversal',
    /SELECT \* FROM sales_posting_batches[\s\S]{0,100}FOR UPDATE/.test(src));
  check('the composite workflow passes its transaction connection to GL reverse',
    /glTransitions\.reverse\([\s\S]{0,180}\bconn\b/.test(src));
  check('a failed GL reverse aborts before state changes',
    /if \(!rev \|\| !rev\.ok \|\| !rev\.newJournalId\)[\s\S]*?throw e/.test(src));
  check('the persisted reversal id is the service result newJournalId',
    /\[rev\.newJournalId, actor/.test(src));
}

// ── 6. The period-close guard is on BOTH implementations ─────────────────
// There are two close endpoints. Guarding one makes the bypass a matter of
// knowing which URL to call.
{
  const periods = code(read('routes', 'erp', 'periods.js'));
  const erp = code(read('routes', 'erp.js'));
  for (const [label, src] of [['routes/erp/periods.js', periods], ['routes/erp.js', erp]]) {
    check(label + ' calls the guard on the transaction connection', /assertNoUnpostedSales\(conn, \{/.test(src));
    check(label + ' returns 409 UNPOSTED_SALES_IN_PERIOD',
      /UNPOSTED_SALES_IN_PERIOD[\s\S]{0,300}status\(409\)/.test(src));
    check(label + ' requires force AND capability AND a reason',
      /wantsForce \|\| !mayOverride \|\| reason\.length < 10/.test(src));
    check(label + ' strands rather than deletes on a forced close',
      /strandUnposted\(conn/.test(src));
    check(label + ' recovers stranded rows on reopen using the transaction connection',
      /recoverStranded\(conn/.test(src));
    check(label + ' wraps period state and queue state in transactions',
      /withTransaction\(async \(conn\)/.test(src));
    check(label + ' deep-links to what is blocking',
      /accounting\/sales-posting\?from=/.test(src));
  }
  // Only a real close. soft_close is a review state, and a reopen must never
  // be blocked by unposted sales — that would trap the books shut.
  check('periods.js guards only close/lock', /if \(target === 'closed' \|\| target === 'locked'\)/.test(periods));
  check('erp.js guards only the open→closed transition',
    /if \(status === 'closed' && period\.status !== 'closed'\)/.test(erp));
}

// ── 7. The accounting source fails closed ────────────────────────────────
{
  const src = code(read('routes', 'erp', 'sales-posting.js'));
  check('a missing queue table is not swallowed during close',
    !/ER_NO_SUCH_TABLE'\) return;/.test(src));
  check('the guard counts pending, failed AND in-flight rows',
    /status IN \('pending', 'failed', 'posting'\)/.test(src));
  check('it reports the accounting-date range so the screen can jump there',
    /MIN\(calendar_date\) AS first_day, MAX\(calendar_date\) AS last_day/.test(src));
  check('strand and recovery preserve brand/branch scope',
    /async function strandUnposted\(conn, \{ from, to, brandId, branchId \}/.test(src) &&
    /async function recoverStranded\(conn, \{ from, to, brandId, branchId \}/.test(src));
}

// ── 8. Reading and writing the ledger are different permissions ──────────
{
  const src = code(read('routes', 'erp', 'sales-posting.js'));
  const routes = [...src.matchAll(/router\.(get|post)\('([^']+)',\s*requireCapability\('([^']+)'\)/g)]
    .map((m) => ({ method: m[1], path: m[2], cap: m[3] }));
  check('every route is gated', routes.length >= 7, routes.length);
  check('no route is left ungated',
    !/router\.(get|post)\('[^']+',\s*async/.test(src), src.match(/router\.(get|post)\('[^']+',\s*async/g));
  const writes = routes.filter((r) => r.path === '/post' || /reverse/.test(r.path));
  check('posting and reversal are separated capabilities',
    writes.length === 2 &&
    writes.some((r) => r.path === '/post' && r.cap === 'finance.gl.post') &&
    writes.some((r) => /reverse/.test(r.path) && r.cap === 'finance.gl.reverse'), writes);
  check('posted history is paged instead of silently truncated',
    /COUNT\(\*\) AS total FROM sales_posting_batches/.test(src) &&
    /LIMIT \? OFFSET \?/.test(src) && /pagination: \{/.test(src));
  const reads = routes.filter((r) => r.method === 'get');
  check('reading needs only finance.reports.view',
    reads.every((r) => r.cap === 'finance.reports.view'), reads);
}

// ── 9. Preview and post share ONE plan ───────────────────────────────────
{
  const src = code(read('lib', 'salesPosting', 'post.js'));
  check('preview calls planBatches', /aggregate\.planBatches\(rows, granularity, accounts\)/.test(src));
  check('postBatch calls the same planBatches',
    (src.match(/aggregate\.planBatches\(/g) || []).length === 2, src.match(/aggregate\.planBatches\(/g));
  check('post refuses a bucket the preview marked unpostable',
    /if \(!bucket\.postable\)/.test(src));
  check('…and an empty one', /code = 'empty_batch'/.test(src));
  check('account resolution mirrors the sale path (settings, then core codes)',
    /GL_SALES_REVENUE_CODE/.test(src) && /GL_OUTPUT_VAT_CODE/.test(src));
  check('the aggregated journal is linked back to every POS invoice',
    /UPDATE ar_documents[\s\S]{0,160}SET gl_journal_id = \?/.test(src));
}

// ── 10. Errors never leak SQL to the browser ─────────────────────────────
{
  const src = code(read('routes', 'erp', 'sales-posting.js'));
  check('a 5xx returns a code, not a message', /if \(status >= 500\) console\.error/.test(src));
  check('only 4xx carries a human message', /if \(e && e\.status && e\.status < 500\) body\.message/.test(src));
  check('a duplicate idempotency key is a friendly 409',
    /ER_DUP_ENTRY[\s\S]{0,120}already_posted/.test(src));
}

// ── 11. The module surface ───────────────────────────────────────────────
{
  for (const fn of ['listPending', 'preview', 'postBatch', 'reverseBatch', 'resolveAccounts', 'nextPostingCycle']) {
    check('post.js exports ' + fn, typeof post[fn] === 'function');
  }
  check('the journal reference type is its own', post.REFERENCE_TYPE === 'SalesBatch');
  const f = post.pendingFilter({ from: '2026-07-01', to: '2026-07-31', branchId: 'BR-1' });
  check('the pending filter is parameterised, never interpolated',
    f.args.length === 3 && !/2026-07-01/.test(f.sql), f);
  check('…and always restricts to unposted rows',
    /status IN \('pending', 'failed'\)/.test(f.sql), f.sql);
}

(async () => {
  // Mutation probe for late arrivals: if the increment or bucket scope is
  // removed, the second generation is no longer 2 (the production lock is the
  // PK row plus ON DUPLICATE UPDATE; this fake exercises the same contract).
  const cycles = new Map();
  const cycleConn = {
    query: async (sql, args) => {
      const key = String(args[0]) + '|' + String(args[1]);
      if (/INSERT INTO sales_posting_bucket_sequences/.test(sql)) {
        cycles.set(key, (cycles.get(key) || 0) + 1);
        return [{ affectedRows: 1 }];
      }
      if (/SELECT last_cycle/.test(sql)) return [[{ last_cycle: cycles.get(key) }]];
      throw new Error('unexpected cycle SQL: ' + sql);
    },
  };
  const first = await post.nextPostingCycle(cycleConn, 'daily', 'daily|2026-08-04|BR-1');
  const late = await post.nextPostingCycle(cycleConn, 'daily', 'daily|2026-08-04|BR-1');
  const other = await post.nextPostingCycle(cycleConn, 'daily', 'daily|2026-08-04|BR-2');
  check('late arrival advances the same bucket to generation 2', first === 1 && late === 2, { first, late });
  check('a different bucket owns an independent generation', other === 1, other);

  const originalReverse = glTransitions.reverse;
  const makeReverseHarness = () => {
    const calls = [];
    const conn = {
      query: async (sql, args = []) => {
        calls.push({ sql, args });
        if (/SELECT \* FROM sales_posting_batches/.test(sql)) {
          return [[{ id: 'B-1', status: 'posted', journal_id: 'J-1', journal_date: '2026-07-31' }]];
        }
        if (/UPDATE sales_posting_batches/.test(sql)) return [{ affectedRows: 1 }];
        if (/UPDATE sales_posting_queue/.test(sql)) return [{ affectedRows: 2 }];
        if (/UPDATE ar_documents/.test(sql)) return [{ affectedRows: 2 }];
        throw new Error('unexpected reversal SQL: ' + sql);
      },
    };
    const pool = {
      withTransaction: async (fn) => fn(conn),
      query: async () => { throw new Error('reversal escaped its transaction connection'); },
    };
    return { pool, conn, calls };
  };

  try {
    const failed = makeReverseHarness();
    glTransitions.reverse = async () => ({ ok: false, code: 'mutated_reverse_failure', message: 'no GL reversal', status: 500 });
    let reversalError = null;
    try {
      await post.reverseBatch(failed.pool, { batchId: 'B-1', actor: 'accountant', reason: 'test failure' });
    } catch (e) { reversalError = e; }
    check('a failed GL reversal aborts the batch workflow',
      reversalError && reversalError.code === 'mutated_reverse_failure', reversalError && reversalError.code);
    check('failure performs no batch/queue/AR state update',
      failed.calls.every((c) => !/^\s*UPDATE /.test(c.sql)), failed.calls.map((c) => c.sql));

    const succeeded = makeReverseHarness();
    let reverseCall = null;
    glTransitions.reverse = async (journalId, user, opts) => {
      reverseCall = { journalId, user, opts };
      return { ok: true, newJournalId: 'RJ-1', newJournalNumber: 'JV-REV-1' };
    };
    const out = await post.reverseBatch(succeeded.pool,
      { batchId: 'B-1', actor: 'accountant', reason: 'governed correction' });
    const batchUpdate = succeeded.calls.find((c) => /UPDATE sales_posting_batches/.test(c.sql));
    check('GL reverse receives the SAME transaction connection and real actor',
      reverseCall && reverseCall.opts.conn === succeeded.conn && reverseCall.user.username === 'accountant', reverseCall);
    check('newJournalId is persisted as reversal_journal_id',
      batchUpdate && batchUpdate.args[0] === 'RJ-1', batchUpdate && batchUpdate.args);
    check('successful reversal requeues through the same transaction',
      out.requeued === 2 && succeeded.calls.some((c) => /UPDATE sales_posting_queue/.test(c.sql)), out);
  } finally {
    glTransitions.reverse = originalReverse;
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('✅ posting service: explicit claim, one transaction, guard on both close paths');
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
