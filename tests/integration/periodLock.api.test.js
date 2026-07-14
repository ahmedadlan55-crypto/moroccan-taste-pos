'use strict';
/* Integration — the accounting period lock (real server + DB).
 *
 * lib/glPosting.js:332 is THE gate for every journal posting in the system:
 *   if (await isPeriodClosed(db, jdate)) return { success:false, error:'الفترة المحاسبية مُقفلة لهذا التاريخ' };
 *
 * Two defects made it porous:
 *
 * 1. ENUM GAP. It compared `status === 'closed'`, but the live column is
 *    ENUM('open','soft_close','soft_closed','closed','locked'). A period in
 *    `locked`, `soft_close` or `soft_closed` accepted journals. That also made
 *    the Periods screen (739408b) a liar: it offers "إقفال مبدئي" and states
 *    "يمنع الترحيل الجديد في هذه الفترة" — which was simply not true.
 *
 * 2. FAIL-OPEN. `catch(e) { return false; }` meant any DB error read as "the
 *    period is open", so the swallow disabled the control precisely when the DB
 *    was unhealthy. It now fails CLOSED.
 *
 * Run: node tests/integration/periodLock.api.test.js
 */
require('dotenv').config();
const path = require('path');
const db = require('../../db/connection');
const gl = require('../../lib/glPosting');

const P = (s) => `ITEST-LOCK-${s}`;
const DATE = '2029-06-15';               // inside the fixture periods, far from real data
const OUTSIDE = '2031-01-15';            // no period covers this
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }

async function setPeriod(status) {
  await db.query('DELETE FROM accounting_periods WHERE id = ?', [P('X')]);
  await db.query(
    "INSERT INTO accounting_periods (id, period_name, period_label, start_date, end_date, status) VALUES (?,?,?,'2029-06-01','2029-06-30',?)",
    [P('X'), 'ITEST Lock', 'ITEST Lock', status]);
}
async function cleanup() { try { await db.query('DELETE FROM accounting_periods WHERE id = ?', [P('X')]); } catch (_) {} }

(async () => {
  await cleanup();
  try {
    console.log('\n═══ accounting period lock ═══');

    check('the closed-status set is exported and covers all five enum values minus open',
      Array.isArray(gl.PERIOD_CLOSED_STATUSES) &&
      ['closed', 'locked', 'soft_close', 'soft_closed'].every((s) => gl.PERIOD_CLOSED_STATUSES.includes(s)),
      gl.PERIOD_CLOSED_STATUSES);

    // The live enum must not contain a blocking value we forgot to list.
    const [col] = await db.query("SELECT COLUMN_TYPE t FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accounting_periods' AND COLUMN_NAME='status'");
    const enumVals = String(col[0].t).match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
    const unhandled = enumVals.filter((v) => v !== 'open' && !gl.PERIOD_CLOSED_STATUSES.includes(v));
    check('every non-open enum value in the LIVE schema is treated as closed', unhandled.length === 0, { enumVals, unhandled });

    // ── open ──
    await setPeriod('open');
    check('open period → posting allowed', (await gl.isPeriodClosed(db, DATE)) === false);

    // ── the four blocking states ──
    for (const s of ['closed', 'locked', 'soft_close', 'soft_closed']) {
      await setPeriod(s);
      const blocked = await gl.isPeriodClosed(db, DATE);
      check(`'${s}' period → posting BLOCKED${s.startsWith('soft') || s === 'locked' ? '  (silently posted before)' : ''}`, blocked === true, { status: s, blocked });
    }

    // ── the guarantee my Periods screen advertises, end to end ──
    // NOTE: the real contract is journalDate/entries (see routes/erp-core.js:1678),
    // not date/lines — an earlier version of this test used the wrong shape and
    // "passed" the block for the wrong reason (empty entries), which is exactly
    // the kind of false green this suite exists to prevent.
    const probe = (extra) => ({
      journalDate: DATE, description: 'ITEST period-lock probe', referenceType: 'ITEST',
      // Codes from gl.CORE_ACCOUNTS, which postJournal's ensureCoreAccounts()
      // guarantees exist: CASH 1110 / INVENTORY 1200.
      entries: [
        { accountCode: gl.CORE_ACCOUNTS.CASH.code, debit: 10, credit: 0, description: 'itest debit' },
        { accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: 0, credit: 10, description: 'itest credit' },
      ],
      ...extra,
    });

    await setPeriod('soft_closed');
    const res = await gl.postJournal(db, probe());
    check('postJournal REFUSES a soft-closed period (the screen\'s "يمنع الترحيل الجديد" is now true)',
      res && res.success === false && /مُقفلة/.test(res.error || ''), res);

    await setPeriod('open');
    const ok = await gl.postJournal(db, probe({ description: 'ITEST period-lock probe (open)' }));
    check('postJournal still ALLOWS an open period (the lock hardens without blocking real work)',
      ok && ok.success === true, ok && { success: ok.success, error: ok.error });
    if (ok && ok.journalId) {
      await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [ok.journalId]).catch(() => {});
      await db.query('DELETE FROM gl_journals WHERE id = ?', [ok.journalId]).catch(() => {});
    }

    // ── no period defined ──
    await cleanup();
    check('a date with no period defined → not blocked', (await gl.isPeriodClosed(db, OUTSIDE)) === false);
    check('a null date → not blocked', (await gl.isPeriodClosed(db, null)) === false);

    // ── FAIL-CLOSED on a DB fault ──
    const brokenDb = { query: async () => { const e = new Error('simulated DB outage'); e.code = 'ECONNREFUSED'; throw e; } };
    const failClosed = await gl.isPeriodClosed(brokenDb, DATE);
    check('a DB error now FAILS CLOSED (was `return false` → the swallow disabled the control)',
      failClosed === true, { got: failClosed });

    // ── the duplicate is gone: erp-core delegates to the same implementation ──
    const src = require('fs').readFileSync(path.join(__dirname, '..', '..', 'routes', 'erp-core.js'), 'utf8');
    check('routes/erp-core.js no longer keeps its own drifted copy',
      /gl\.isPeriodClosed\(db, date\)/.test(src) && !/SELECT status FROM accounting_periods/.test(src),
      { delegates: /gl\.isPeriodClosed/.test(src) });

    console.log(`\n${fail === 0 ? '✅' : '❌'} periodLock: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
