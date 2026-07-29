#!/usr/bin/env node
'use strict';
/**
 * tests/partyDimension.test.js — «الموردين حساب مراقبة واحد … والتعامل معهم بالأبعاد».
 *
 * One payables control account, suppliers told apart by a dimension on the
 * LINE. What this pins is the handful of decisions that, if reversed, break
 * the supplier ledger silently rather than loudly.
 *
 * Run: node tests/partyDimension.test.js   (pure, no DB)
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const boot = require('../lib/partyDimension/bootstrap');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const code = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── 1. The party lives on the LINE, and does NOT inherit from the header ──
// A journal legitimately touches two parties — «Dr supplier payable / Cr bank».
// Header dimensions in this codebase inherit DOWNWARD into every line, so a
// header-level party would stamp the supplier onto the BANK line and every
// "what does this account owe that party" query would count the bank as a
// supplier debt.
{
  const gl = code(read('lib', 'glPosting.js'));
  check('partyType is in the dimension plan', /\['partyType', 'party_type', null\]/.test(gl));
  check('partyId is in the dimension plan', /\['partyId',   'party_id',   null\]/.test(gl));
  check('…both with a NULL header key — no inheritance',
    !/\['party(Type|Id)',\s*'party_\w+',\s*'party/.test(gl));
  // Contrast: branch/brand DO inherit. If that ever changes for party, this
  // catches it.
  check('branch still inherits (the contrast is deliberate)',
    /\['branchId', 'branch_id', 'branchId'\]/.test(gl));

  const schema = code(read('db', 'migrations', 'party-dimension', 'schema.js'));
  check('the columns go on gl_entries', /addColumn\(db, 'gl_entries', 'party_type'/.test(schema));
  check('…and NOT on gl_journals', !/gl_journals/.test(schema));
}

// ── 1b. The migration survives its own mistakes ──────────────────────────
// Production caught this: a stray pair of parentheses in an index definition
// threw, and because the steps were one `await` chain, the `dim_required`
// column AFTER it never ran either. One typo in a nice-to-have index silently
// skipped the column the enforcement depends on.
{
  const schema = code(read('db', 'migrations', 'party-dimension', 'schema.js'));
  check('every step is individually guarded', /await step\('/.test(schema));
  check('…and there are five of them',
    (schema.match(/await step\('/g) || []).length === 5, schema.match(/await step\('/g));
  check('a failing step reports itself rather than vanishing', /FAILED: '/.test(schema));

  // addIndex wraps the column list in parens itself.
  const idx = schema.match(/addIndex\(db, '[^']+', '[^']+', '[^']+'/g) || [];
  check('no index passes its own parentheses',
    idx.length === 2 && idx.every((s) => !/'\(/.test(s)), idx);
}

// ── 2. A required party may never be silently dropped ────────────────────
// glPosting's fallback drops EVERY dimension on a missing column and reports
// success. Acceptable for an advisory dimension on an old schema; a silent
// data-integrity failure for a payable, which would then be money owed to
// nobody — invisible to the statement and to ageing alike.
{
  const gl = code(read('lib', 'glPosting.js'));
  check('the degrade path refuses a line that carries a party',
    /if \(e\.partyId\) throw err;/.test(gl));
  const at = gl.indexOf('dimCols.length && _isMissingColumn(err)');
  const fallback = gl.slice(at, at + 500);
  check('…and the refusal comes BEFORE the dimensionless retry',
    fallback.indexOf('e.partyId') < fallback.indexOf('INSERT INTO gl_entries (${cols.join'),
    fallback.slice(0, 200));
}

// ── 3. A reversal must carry the party ───────────────────────────────────
// Without it a reversal credits the control account with no counterparty, so
// the supplier's statement shows the invoice and never the credit: the balance
// stays owed forever while the ledger says it is settled.
{
  const gt = code(read('lib', 'glTransitions.js'));
  check('the reversal copies party_type', /partyType: e\.party_type \|\| null/.test(gt));
  check('the reversal copies party_id', /partyId: e\.party_id \|\| null/.test(gt));
}

// ── 4. ONE payables control account ──────────────────────────────────────
// Supplier payments posted to 2101 while the whole V2 procurement cycle posts
// to 2100. One liability, two accounts, and neither balance was the supplier's
// real position.
{
  const cash = code(read('routes', 'cash.js'));
  check('supplier payments now post to 2100', /recipientType === 'supplier'\s*\)\s*\{ code = '2100'/.test(cash));
  check('…named ذمم دائنة', /name = 'ذمم دائنة'/.test(cash));
  check('the old 2101 routing is gone', !/code = '2101'/.test(cash));

  // The auto-create is how 2101 came to exist at all: a missing account
  // silently became a NEW one, parented wherever the tree allowed.
  check('the payables account is NEVER auto-created', /ap_account_missing/.test(cash));
  check('…it raises instead', /err\.code = 'ap_account_missing'; err\.status = 500; throw err/.test(cash));

  check('procurement already owned 2100', /ap: String\(process\.env\.PROCUREMENT_AP_ACCOUNT_CODE \|\| '2100'\)/
    .test(read('lib', 'procurement', 'accounts.js')));
  check('the bootstrap targets the same account', boot.AP_CODE === '2100' && boot.AP_NAME === 'ذمم دائنة');
}

// ── 5. Posted history is reclassified by a JOURNAL, never rewritten ──────
// Money already posted is moved by an accountant's entry, not by a migration
// UPDATE-ing history. That is the difference between a correction and a
// forgery.
{
  const src = code(read('lib', 'partyDimension', 'bootstrap.js'));
  check('the reclassification posts a journal', /glPosting\.postJournal\(db, \{/.test(src));
  check('…referenced as ApUnification', /referenceType: 'ApUnification'/.test(src));
  check('…and balance-checks in halalas BEFORE writing',
    /const dr = entries\.reduce[\s\S]{0,300}if \(dr !== cr\)/.test(src));
  check('…refusing to post when unbalanced', /reason: 'unbalanced'/.test(src));
  check('no posted gl_entries row is ever rewritten by the reclassification',
    !/UPDATE gl_entries[\s\S]{0,120}(debit|credit|account_code)\s*=/.test(src));
  check('the account code is never renumbered', !/SET code = /.test(src));
}

// ── 6. No invented «miscellaneous supplier» ──────────────────────────────
// A fake party pollutes every statement forever. A visible unallocated balance
// is honest and shrinks as history is cleaned up.
{
  const src = read('lib', 'partyDimension', 'bootstrap.js');
  check('unidentifiable balance goes to its own account', boot.UNALLOCATED_CODE === '2109');
  check('…labelled as unallocated, not as a supplier', /ذمم دائنة — غير موزَّعة/.test(src));
  check('no placeholder party id is ever written',
    !/partyId: 'MISC|partyId: 'UNKNOWN|partyId: 'VARIOUS/.test(src));
}

// ── 7. Deactivation only when provably empty ─────────────────────────────
// An inactive account is dropped from the balance sheet AND from the
// idempotent year-end closing entry — misstating retained earnings
// unrecoverably if it still holds a balance.
{
  const src = code(read('lib', 'partyDimension', 'bootstrap.js'));
  const deactivations = src.match(/UPDATE gl_accounts SET is_active = 0[^`']*/g) || [];
  check('2101 is deactivated in exactly two places', deactivations.length === 2, deactivations);
  check('…once when it is already empty', /reason: 'empty — deactivated'/.test(src));
  check('…and once AFTER a successful reclassification post',
    src.indexOf('posted.success') < src.lastIndexOf('is_active = 0'));
}

// ── 8. The backfill only fills NULLs, resumably ──────────────────────────
{
  const src = code(read('lib', 'partyDimension', 'bootstrap.js'));
  check('every backfill statement guards on party_id IS NULL',
    (src.match(/UPDATE gl_entries e[\s\S]*?LIMIT 2000/g) || [])
      .every((q) => /party_id IS NULL/.test(q)));
  check('…is batched', /LIMIT 2000/.test(src));
  check('…and stops when a batch does nothing', /if \(!r\.affectedRows\) break;/.test(src));
  check('a missing source table is not an error',
    /ER_NO_SUCH_TABLE' \|\| e\.code === 'ER_BAD_FIELD_ERROR'\)\) break/.test(src));

  // Both sides of every join, or the join silently matches nothing.
  const joins = src.match(/ON [^\n]*COLLATE[^\n]*/g) || [];
  check('every join COLLATEs BOTH sides', joins.length >= 2 &&
    joins.every((j) => (j.match(/COLLATE/g) || []).length === 2), joins);

  // Name matching is a guess wearing the costume of a fact.
  check('suppliers are never matched by NAME', !/supplier_name\s*=|LIKE '%' \+ supplier/.test(src));
  check('what cannot be attributed is COUNTED, not guessed', /unattributed: Number\(left\.n\)/.test(src));
}

// ── 9. It runs itself, and cannot take the server down ───────────────────
{
  const srv = read('server.js');
  check('the schema is applied at boot', /party-dimension\/schema'\)\.apply/.test(srv));
  check('the bootstrap is gated on a settings key', /PartyDimensionBootstrap_v1/.test(srv));
  check('…and cannot abort startup', /catch \(e\) \{ console\.error\('\[party\] bootstrap skipped:'/.test(srv));
  const src = code(read('lib', 'partyDimension', 'bootstrap.js'));
  check('each of the three steps is independently guarded',
    (src.match(/catch \(e\) \{ log\('\[party\]/g) || []).length === 3,
    src.match(/catch \(e\) \{ log\('\[party\]/g));
}

// ── 10. dim_required stops being dead ────────────────────────────────────
{
  const src = code(read('lib', 'partyDimension', 'bootstrap.js'));
  check('the control account is marked party-required', /dim_required = \?/.test(src));
  check('…with the party:vendor marker', /JSON\.stringify\(\['party:vendor'\]\)/.test(src));
  check('…and an existing value is never overwritten',
    /dim_required IS NULL OR dim_required = ''/.test(src));
}

// ── 11. AP ageing reads the LIVE ledger ──────────────────────────────────
// It read the legacy `purchases` table, selected rows by matching free text in
// payment_method, and looked for payments in `supplier_payments` — a table that
// does not exist in this repository. That lookup sat in a bare catch, so every
// supplier appeared 100% unpaid and the entire live V2 procurement ledger was
// invisible to the report.
{
  const ap = code(read('routes', 'erp', 'reports', 'ap-aging.js'));
  check('it no longer reads the legacy purchases table', !/FROM purchases/.test(ap));
  check('it no longer looks for supplier_payments', !/supplier_payments/.test(ap));
  check('it reads supplier_invoices', /FROM supplier_invoices/.test(ap));
  check('…and nets allocations the way v_supplier_ap_balance does',
    /payment_allocations pa/.test(ap) && /pa\.reversed = 0/.test(ap));
  check('allocations are bounded by asOfDate (a back-dated report must not net future payments)',
    /DATE\(pa\.created_at\) <= \?/.test(ap));

  // "Overdue" is a statement about the agreed terms, not about the invoice date.
  check('it ages by DUE date', /r\.due_date \|\| r\.issue_date/.test(ap));
  check('…and declares that basis in the response', /agedBy: 'due_date'/.test(ap));
  check('…and names the ledger that answered', /source: 'supplier_invoices'/.test(ap));

  // An absent schema must never look like "you owe nobody anything".
  check('a missing procurement schema is a 503, not an empty report',
    /PROCUREMENT_SCHEMA_NOT_READY/.test(ap) && /status\(503\)/.test(ap));
  check('no bare catch swallows the main query', !/catch \(_\) \{ \/\* table missing/.test(ap));
  check('the date default is Riyadh-local, not UTC', !/toISOString/.test(ap));
}

// ── 12. The backfill targets tables that actually exist ──────────────────
// The first version joined `ap_invoices` — which does not exist here. The
// missing-table guard would have swallowed that as "this lane has nothing to
// contribute", so the invoice lane would have backfilled nothing while
// reporting success. Same wrong name that broke AP ageing.
{
  const src = code(read('lib', 'partyDimension', 'bootstrap.js'));
  check('the invoice lane joins supplier_invoices', /JOIN supplier_invoices i/.test(src));
  check('…and never ap_invoices', !/ap_invoices/.test(src));
  check('there is a payment-allocation lane too', /JOIN payment_allocations pa/.test(src));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ party dimension: line-level, never silently dropped, history reclassified not rewritten');
