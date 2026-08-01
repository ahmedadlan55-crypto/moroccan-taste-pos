'use strict';
/**
 * db/migrations/party-dimension/schema.js — the counterparty dimension.
 *
 * THE OWNER'S ASK: «الموردين حساب مراقبة واحد اسمه ذمم دائنة، والتعامل معهم
 * بالأبعاد» — one control account, suppliers distinguished by a dimension
 * rather than by a proliferation of per-supplier accounts.
 *
 * ─── WHY gl_entries AND NOT gl_journals ─────────────────────────────────────
 *
 * A single journal legitimately touches two parties — «Dr supplier payable /
 * Cr bank» — and header dimensions in this codebase INHERIT DOWNWARD into
 * every line (lib/glPosting.js). A header-level party would therefore stamp
 * the supplier onto the bank line too, and every query asking "what does this
 * account owe that party" would count the bank as a supplier debt.
 *
 * So the party lives on the LINE, and header inheritance is deliberately off.
 *
 * ─── WHY NULLABLE ───────────────────────────────────────────────────────────
 *
 * There are ~18 distinct writers of gl_entries, most of which do not go
 * through lib/glPosting.js. Two of them are period close and period reopen
 * (routes/erp.js), which insert six columns and no dimensions at all. A NOT
 * NULL party would hard-fail every month-end close — and that failure is
 * SWALLOWED there, so the period would still be marked closed while its
 * closing entry silently failed to post.
 *
 * Nullable, enforced per-account instead: `gl_accounts.dim_required` names the
 * accounts that must carry one, and lib/glPosting.js refuses to degrade a line
 * that has a party (see the _isMissingColumn fallback).
 *
 * ─── THE SHAPE MATCHES WHAT THE REPO ALREADY USES ───────────────────────────
 *
 * `advance_payments`, `cash_credit_notes` and `contracts` all already carry
 * `party_type ENUM(...) / party_id VARCHAR(40)` with an `idx_party`. Matching
 * that shape means one mental model and no translation at every join. The
 * width follows gl_entries' OTHER dimension columns (VARCHAR(50)), which are
 * wider than the 40 those tables use — a supplier id must fit both.
 */

const H = require('../order-to-cash/ddlHelpers');

/**
 * Each step is INDEPENDENTLY guarded.
 *
 * The first production run proved why: a stray pair of parentheses in an index
 * definition threw, and because the steps were a single `await` chain, the
 * `dim_required` column after it never ran either. One typo in a
 * nice-to-have index silently skipped a column the enforcement depends on.
 *
 * A migration is a set of independent facts, not a script — so one failing
 * step reports itself and the rest still land.
 */
async function step(label, log, fn) {
  try { await fn(); }
  catch (e) { log('  ! ' + label + ' FAILED: ' + String(e.message || e).slice(0, 120)); }
}

async function apply(db, log = () => {}) {
  // 'vendor' rather than 'supplier': the three existing party tables in this
  // repo all use 'vendor', and one vocabulary beats a more accurate word that
  // needs translating at every join.
  await step('party_type', log, () => H.addColumn(db, 'gl_entries', 'party_type',
    "ENUM('customer','vendor','employee','partner') NULL", log));
  await step('party_id', log, () => H.addColumn(db, 'gl_entries', 'party_id', 'VARCHAR(50) NULL', log));

  // The supplier-statement query shape: "every line on this account for this
  // party, in date order". account_code leads because a statement is always
  // scoped to one control account first.
  //
  // NO surrounding parentheses — addIndex wraps the list itself, so passing
  // them here produced `ADD INDEX x ((party_type, party_id))`.
  await step('ix_gle_party', log, () =>
    H.addIndex(db, 'gl_entries', 'ix_gle_party', 'party_type, party_id', {}, log));
  await step('ix_gle_acct_party', log, () =>
    H.addIndex(db, 'gl_entries', 'ix_gle_acct_party', 'account_code, party_type, party_id', {}, log));

  // `dim_required` has existed since the accounts table was created and has
  // never been read by anything (one occurrence in the whole tree). It is the
  // natural home for "this account must carry a party", so it gets used rather
  // than a new column invented beside it.
  await step('dim_required', log, () =>
    H.addColumn(db, 'gl_accounts', 'dim_required', 'VARCHAR(200) NULL', log));

  // ── payment_allocations: which payment SYSTEM the id belongs to ─────────
  //
  // A PREREQUISITE, not a fix for a live bug — and the distinction matters.
  //
  // `payment_allocations.payment_id` is currently written by exactly ONE
  // caller (routes/procurement/payments.js), so nothing collides today. But
  // `cash_payments.id` and `payment_records.id` are minted from two different
  // generators that produce the SAME SHAPE — `PAY-<ms>-<rand4>` from both
  // routes/shifts.js and routes/procurement/payments.js — and they live in
  // separate tables, so neither generator can see the other's ids.
  //
  // The moment the treasury voucher becomes a first-class AP document and
  // starts allocating against invoices, `UPDATE payment_allocations SET
  // reversed = 1 WHERE payment_id = ?` can reach across the two systems and
  // silently reverse an allocation belonging to the other one. Adding the
  // discriminator BEFORE that path exists is the difference between a column
  // default and a data-repair exercise.
  //
  // DEFAULT 'procurement' is correct for every existing row: procurement is
  // the only writer there has ever been.
  await step('payment_source', log, () =>
    H.addColumn(db, 'payment_allocations', 'payment_source',
      "VARCHAR(20) NOT NULL DEFAULT 'procurement'", log));

  // The uniqueness rule that actually holds: one allocation per
  // (system, payment, invoice). The old `uq_alloc (payment_id,
  // supplier_invoice_id)` would forbid a treasury payment and a procurement
  // payment that happen to share an id from both allocating to the same
  // invoice — a legitimate pair it cannot tell apart.
  await step('uq_alloc_src', log, () =>
    H.addIndex(db, 'payment_allocations', 'uq_alloc_src',
      'payment_source, payment_id, supplier_invoice_id', { unique: true }, log));

  log('party dimension ready');
}

module.exports = { apply };
