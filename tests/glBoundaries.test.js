#!/usr/bin/env node
'use strict';
/**
 * The shared ledger boundaries, and the 0036 discipline every GL-derived report
 * owes the Trial Balance.
 *
 * TWO THINGS ARE PINNED HERE, and both have already gone wrong in this repo:
 *
 *   1. THE OPENING CLAUSE MUST BIND `posted` TO BOTH BRANCHES. The clause is an
 *      OR of two branches, and SQL binds AND tighter than OR. When the outer
 *      parentheses were missing, `status = 'posted'` attached only to the first
 *      branch — so a DRAFT journal dated before the period counted toward the
 *      opening balance. Recorded at lib/reports/trialBalance.js:290-298.
 *      A structural test cannot execute SQL, so it asserts the SHAPE that makes
 *      the precedence bug impossible: the guard and the OR live inside one
 *      parenthesised group.
 *
 *   2. EVERY GL-DERIVED REPORT APPLIES THE 0036 REMAP, OR NONE SHOULD.
 *      The Trial Balance and the General Ledger grouped by the remapped account
 *      and excluded the transfer journal; the Income Statement, Balance Sheet
 *      and Cash Flow did neither. For any period spanning the chart rebuild the
 *      three of them counted the old history AND the transfer, so they
 *      disagreed with the Trial Balance BY CONSTRUCTION — not by rounding, by a
 *      doubled account. This sweeps the sources so a new report cannot quietly
 *      rejoin the wrong half of that split.
 */

const fs = require('fs');
const path = require('path');
const B = require('../lib/reports/glBoundaries');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra || '');
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Strip SQL/JS comments so a rule is never "satisfied" by prose about it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function placeholders(sql) {
  return (sql.match(/\?/g) || []).length;
}

// ── 1. Every builder pairs its clause with exactly its own parameters ───────
// The original duplication was dangerous precisely because a caller assembled
// the clause and the params separately and could mismatch them.
{
  const cases = [
    ['openingSql', B.openingSql('2026-01-01')],
    ['periodSql', B.periodSql('2026-01-01', '2026-01-31')],
    ['asOfSql', B.asOfSql('2026-01-31')],
    ['inTheBooksSql', B.inTheBooksSql()],
  ];
  for (const [name, out] of cases) {
    check(name + ': placeholder count equals param count',
      placeholders(out.sql) === out.params.length,
      { placeholders: placeholders(out.sql), params: out.params.length });
    check(name + ': excludes the 0036 transfer journal',
      out.params[0] === 'COA36-TRANSITION', out.params);
  }
}

// ── 2. The precedence bug is structurally impossible ────────────────────────
{
  const opening = B.openingSql('2026-01-01');
  // The whole clause is one parenthesised group…
  check('openingSql: the entire clause is wrapped in one group',
    opening.sql.startsWith('(') && opening.sql.endsWith(')'), opening.sql);

  // …and inside it, the posted guard precedes the OR rather than sitting in a
  // branch of it. If `posted` ever appears AFTER the first `OR`, the guard has
  // been pushed into a branch and a draft can re-enter the opening balance.
  const firstOr = opening.sql.indexOf(' OR ');
  const postedAt = opening.sql.indexOf("status = 'posted'");
  check('openingSql: the posted guard binds BEFORE the OR, not inside a branch',
    postedAt !== -1 && firstOr !== -1 && postedAt < firstOr,
    { postedAt, firstOr });

  // Both dates are the SAME boundary — an opening balance has one edge, and
  // passing `to` here by mistake would silently widen it.
  check('openingSql: both placeholders bind the same `from` date',
    opening.params[1] === '2026-01-01' && opening.params[2] === '2026-01-01',
    opening.params);
}

// ── 3. Period and as-of are distinct questions ──────────────────────────────
{
  const period = B.periodSql('2026-01-01', '2026-01-31');
  check('periodSql: excludes opening-tagged journals',
    /reference_type/.test(period.sql) && /<>\s*'opening'/.test(period.sql), period.sql);
  check('periodSql: binds from and to, in that order',
    period.params[1] === '2026-01-01' && period.params[2] === '2026-01-31', period.params);

  const asOf = B.asOfSql('2026-01-31');
  // A balance sheet asks for one cumulative balance at a point in time. If it
  // ever excluded opening journals it would drop the opening balances that ARE
  // the balance sheet's starting position.
  check('asOfSql: does NOT exclude opening journals — a snapshot includes them',
    !/<>\s*'opening'/.test(asOf.sql), asOf.sql);
  check('asOfSql: is inclusive of its date', /<=\s*\?/.test(asOf.sql), asOf.sql);
}

// ── 4. The remap sweep — the defect this module was extracted to end ────────
{
  // The two GL engines that are LIBRARIES, not routes.
  //
  // The three report ROUTES (income, balance-sheet, cash-flow) are deliberately
  // absent: a source sweep proved too weak for them — deleting a map join left
  // the file still mentioning the module, so the sweep stayed green while the
  // money changed. They are covered executably instead, by driving the real
  // handlers against a fake pool and asserting the SQL they actually issue:
  // tests/glReportRemap.test.js. That test catches 5/5 mutants; this sweep
  // caught 1/3. Keep the split.
  //
  // A source sweep is still the right tool HERE, because these two are called
  // as functions with a live `db` and have no cheap seam to record through.
  const GL_DERIVED_REPORTS = [
    'lib/reports/trialBalance.js',
    'lib/reports/glLedger.js',
  ];

  // A report satisfies the rule by either sanctioned route, and the test must
  // accept BOTH — otherwise it would fail the very refactor this module exists
  // to enable, and push the next author back toward inlining the SQL.
  //
  //   (a) through the shared module — glBoundaries.canonicalMapJoin() etc.
  //   (b) with the literal SQL, for the two files that predate the module and
  //       build their clauses through their own fragment builders.
  //
  // What is asserted is the PROPERTY (this report applies the remap and drops
  // the transfer), never the spelling.
  const viaModule = (src) => /glBoundaries\.(canonicalMapJoin|effectiveAccountSql)/.test(src);
  const viaLiteral = (src) => /coa_0036_account_map/.test(src);
  const dropsTransferViaModule = (src) =>
    /glBoundaries\.(inTheBooksSql|openingSql|periodSql|asOfSql|COA_TRANSITION_JOURNAL_ID)/.test(src);
  const dropsTransferViaLiteral = (src) => /COA36-TRANSITION/.test(src);

  for (const rel of GL_DERIVED_REPORTS) {
    const src = stripComments(read(rel));
    check(rel + ': groups by the REMAPPED account (0036)',
      viaModule(src) || viaLiteral(src));
    check(rel + ': excludes the COA36 transfer journal',
      dropsTransferViaModule(src) || dropsTransferViaLiteral(src));
  }
}

// ── 5. A require for every use ──────────────────────────────────────────────
{
  // This exact class of bug has shipped TWICE in this repo: a module used only
  // inside a route handler, with no require. `node --check` passes, module load
  // passes, and the route fails at request time. Grepping for the module PATH
  // is not enough — it matches the comment that mentions it. Grep the STATEMENT.
  const CONSUMERS = [
    'routes/erp/reports/income.js',
    'routes/erp/reports/balance-sheet.js',
    'routes/erp/reports/cash-flow.js',
  ];
  for (const rel of CONSUMERS) {
    const src = read(rel);
    const uses = (src.match(/glBoundaries\./g) || []).length;
    const required = /^\s*const glBoundaries = require\(/m.test(src);
    check(rel + ': requires glBoundaries if it uses it',
      uses === 0 || required, { uses, required });
  }
}

if (failures.length) {
  console.error('\n' + failures.length + ' failure(s):');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('  ✅ ledger boundaries: one definition, precedence-safe, and every GL report applies the 0036 remap');
console.log(pass + '/' + pass + ' passed');
