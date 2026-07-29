'use strict';
/**
 * lib/partyDimension/bootstrap.js — make the supplier ledger true at boot.
 *
 * Three one-shot steps, each independently gated, each safe to re-run:
 *   1. rename 2100 → «ذمم دائنة» and mark it party-required
 *   2. reclassify whatever sits on 2101 onto 2100, with a BALANCED journal
 *   3. backfill party_id on historical gl_entries, resumably
 *
 * The owner runs nothing. That is the requirement, and it is also the safer
 * design: a migration that only exists as a script someone must remember to
 * run is a migration that silently did not happen.
 */

const acctDate = require('../accountingDate');

const AP_CODE = '2100';
const AP_NAME = 'ذمم دائنة';
const LEGACY_AP_CODE = '2101';
const UNALLOCATED_CODE = '2109';
const UNALLOCATED_NAME = 'ذمم دائنة — غير موزَّعة';

/**
 * Step 1 — name the control account what it is, and declare that it needs a party.
 *
 * Renaming is one of only two operations that cannot corrupt posted history
 * (`gl_entries.account_name` is a frozen snapshot, so old journals keep their
 * original label either way). Renumbering would rewrite `account_code` across
 * all history and is never done here.
 */
async function nameControlAccount(db, log) {
  const [rows] = await db.query(
    'SELECT id, name_ar FROM gl_accounts WHERE code = ? LIMIT 1', [AP_CODE]);
  if (!rows.length) { log('[party] ' + AP_CODE + ' not in the chart — nothing to name'); return false; }
  if (String(rows[0].name_ar || '') !== AP_NAME) {
    await db.query('UPDATE gl_accounts SET name_ar = ? WHERE id = ?', [AP_NAME, rows[0].id]);
    log('[party] ' + AP_CODE + ' renamed «' + rows[0].name_ar + '» → «' + AP_NAME + '»');
  }
  // `dim_required` has been dead since the table was created. This is the
  // first thing that reads it — the enforcement lives in lib/glPosting.js,
  // which refuses to silently drop a party from a line that carries one.
  await db.query(
    "UPDATE gl_accounts SET dim_required = ? WHERE code = ? AND (dim_required IS NULL OR dim_required = '')",
    [JSON.stringify(['party:vendor']), AP_CODE]);
  return true;
}

/**
 * Step 2 — move the 2101 balance onto 2100 with a real journal entry.
 *
 * NOT an UPDATE of posted rows. Money that has already been posted is
 * reclassified by an accountant's journal entry, not by a migration rewriting
 * history — that is the difference between a correction and a forgery.
 *
 * Anything whose supplier can be identified moves with its party attached.
 * The remainder goes to `2109 ذمم دائنة — غير موزَّعة`, deliberately NOT to an
 * invented «miscellaneous supplier»: a fake party pollutes every statement
 * forever, while a visible unallocated balance is honest and shrinks as the
 * history is cleaned up.
 */
async function reclassifyLegacyAp(db, glPosting, log) {
  const [legacy] = await db.query(
    'SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [LEGACY_AP_CODE]);
  if (!legacy.length) return { moved: 0, reason: 'no legacy account' };

  const [[bal]] = await db.query(
    `SELECT COALESCE(SUM(credit) - SUM(debit), 0) AS net, COUNT(*) AS n
       FROM gl_entries WHERE account_code = ?`, [LEGACY_AP_CODE]);
  const net = Math.round((Number(bal.net) || 0) * 100) / 100;
  if (!Number(bal.n) || net === 0) {
    // Nothing posted, or it already nets to zero. Deactivating an account with
    // a live balance would drop it from the balance sheet AND from the
    // idempotent year-end closing entry — so it is only ever retired once it
    // is provably empty.
    await db.query("UPDATE gl_accounts SET is_active = 0 WHERE code = ? AND is_active = 1", [LEGACY_AP_CODE]);
    return { moved: 0, reason: 'empty — deactivated' };
  }

  // Split the balance by identifiable supplier.
  const [byParty] = await db.query(
    `SELECT j.reference_type, j.reference_id,
            COALESCE(SUM(e.credit) - SUM(e.debit), 0) AS net
       FROM gl_entries e
       JOIN gl_journals j ON j.id = e.journal_id
      WHERE e.account_code = ?
      GROUP BY j.reference_type, j.reference_id`, [LEGACY_AP_CODE]);

  const perSupplier = new Map();
  let unallocated = 0;
  for (const r of byParty) {
    const amt = Math.round((Number(r.net) || 0) * 100) / 100;
    if (amt === 0) continue;
    let supplierId = null;
    // A treasury voucher is linked the other way round — cash_payments carries
    // the journal id, not the reverse.
    if (String(r.reference_type || '').toLowerCase().includes('pay')) {
      try {
        const [[cp]] = await db.query(
          'SELECT supplier_id FROM cash_payments WHERE journal_id IS NOT NULL AND id = ? LIMIT 1', [r.reference_id]);
        if (cp && cp.supplier_id) supplierId = String(cp.supplier_id);
      } catch (_) { /* column/table absent on an older deploy */ }
    }
    if (supplierId) perSupplier.set(supplierId, (perSupplier.get(supplierId) || 0) + amt);
    else unallocated += amt;
  }

  const entries = [];
  // Dr 2101 to clear it…
  entries.push({ accountCode: LEGACY_AP_CODE, debit: Math.abs(net), credit: 0,
    description: 'إعادة تصنيف رصيد ' + LEGACY_AP_CODE + ' إلى ' + AP_CODE });
  // …Cr 2100 per identified supplier, with the party attached.
  for (const [supplierId, amt] of perSupplier) {
    entries.push({ accountCode: AP_CODE, debit: 0, credit: Math.abs(amt),
      partyType: 'vendor', partyId: supplierId,
      description: 'ذمم دائنة — مورد ' + supplierId });
  }
  if (Math.abs(unallocated) > 0.004) {
    entries.push({ accountCode: UNALLOCATED_CODE, debit: 0, credit: Math.abs(unallocated),
      description: UNALLOCATED_NAME });
  }

  // Balance check in halalas before anything is written.
  const dr = entries.reduce((s, e) => s + Math.round((e.debit || 0) * 100), 0);
  const cr = entries.reduce((s, e) => s + Math.round((e.credit || 0) * 100), 0);
  if (dr !== cr) {
    log('[party] reclassification REFUSED — Dr ' + dr / 100 + ' vs Cr ' + cr / 100);
    return { moved: 0, reason: 'unbalanced' };
  }

  await glPosting.ensureCoreAccounts(db);
  // The unallocated bucket must exist before it is posted to.
  const [unal] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [UNALLOCATED_CODE]);
  if (!unal.length) {
    const [parent] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', ['21']);
    await db.query(
      `INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active, report_section)
       VALUES (?,?,?,'liability',?,?,1,'payables')`,
      ['GL-' + UNALLOCATED_CODE, UNALLOCATED_CODE, UNALLOCATED_NAME,
       parent.length ? parent[0].id : null, parent.length ? 3 : 2]);
  }

  const posted = await glPosting.postJournal(db, {
    journalDate: acctDate.journalDate(),
    description: 'توحيد الذمم الدائنة — إعادة تصنيف ' + LEGACY_AP_CODE + ' إلى ' + AP_CODE,
    referenceType: 'ApUnification',
    referenceId: LEGACY_AP_CODE,
    entries,
    postedBy: 'system:party-dimension',
    status: 'posted',
  });
  if (!posted || !posted.success) {
    log('[party] reclassification post FAILED: ' + ((posted && posted.error) || 'unknown'));
    return { moved: 0, reason: 'post failed' };
  }

  await db.query("UPDATE gl_accounts SET is_active = 0 WHERE code = ?", [LEGACY_AP_CODE]);
  return {
    moved: perSupplier.size,
    unallocated: Math.round(unallocated * 100) / 100,
    journal: posted.journalNumber || posted.journalId,
  };
}

/**
 * Step 3 — backfill the party on historical payable lines.
 *
 * Only fills NULLs, never overwrites. Batched so an interrupted run resumes on
 * the next boot, and a finished one is a no-op.
 *
 * WHAT IS DELIBERATELY NOT RECOVERED, and why saying so matters more than
 * guessing: manual journal entries typed straight onto the payables account,
 * vouchers that carry a free-text supplier NAME but no id, and bulk opening
 * balances. Matching those by name is a guess wearing the costume of a fact —
 * one mis-match silently moves money between two suppliers' statements. They
 * stay unattributed and countable.
 */
async function backfillParty(db, log) {
  const SOURCES = [
    // [description, SQL] — each fills party from a document table that already
    // knows the supplier. COLLATE on both sides of every join: gl_entries and
    // the procurement tables were created in different migrations and do not
    // reliably share a collation, and a mismatch fails the JOIN outright.
    // `supplier_invoices`, NOT `ap_invoices` — the latter does not exist in
    // this repo. The guard below would have swallowed the mistake as "that
    // lane has nothing to contribute", so the whole invoice lane would have
    // backfilled nothing while reporting success. The same wrong table name
    // is what made the AP-aging report show every supplier as unpaid.
    ['purchase invoices', `
      UPDATE gl_entries e
        JOIN gl_journals j ON j.id = e.journal_id
        JOIN supplier_invoices i
          ON i.id COLLATE utf8mb4_unicode_ci = j.reference_id COLLATE utf8mb4_unicode_ci
         SET e.party_type = 'vendor', e.party_id = i.supplier_id
       WHERE e.account_code = ? AND e.party_id IS NULL AND i.supplier_id IS NOT NULL
       LIMIT 2000`],
    ['payment allocations', `
      UPDATE gl_entries e
        JOIN gl_journals j ON j.id = e.journal_id
        JOIN payment_records pr
          ON pr.id COLLATE utf8mb4_unicode_ci = j.reference_id COLLATE utf8mb4_unicode_ci
        JOIN payment_allocations pa
          ON pa.payment_id COLLATE utf8mb4_unicode_ci = pr.id COLLATE utf8mb4_unicode_ci
        JOIN supplier_invoices si
          ON si.id COLLATE utf8mb4_unicode_ci = pa.supplier_invoice_id COLLATE utf8mb4_unicode_ci
         SET e.party_type = 'vendor', e.party_id = si.supplier_id
       WHERE e.account_code = ? AND e.party_id IS NULL AND si.supplier_id IS NOT NULL
       LIMIT 2000`],
    ['treasury vouchers', `
      UPDATE gl_entries e
        JOIN cash_payments p
          ON p.journal_id COLLATE utf8mb4_unicode_ci = e.journal_id COLLATE utf8mb4_unicode_ci
         SET e.party_type = 'vendor', e.party_id = p.supplier_id
       WHERE e.account_code = ? AND e.party_id IS NULL AND p.supplier_id IS NOT NULL
       LIMIT 2000`],
  ];

  let total = 0;
  for (const [label, sql] of SOURCES) {
    let filled = 0;
    for (let guard = 0; guard < 200; guard++) {
      let r;
      try { [r] = await db.query(sql, [AP_CODE]); }
      catch (e) {
        // A source table absent on this deploy is not an error — it just means
        // that lane has nothing to contribute.
        if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR')) break;
        throw e;
      }
      if (!r.affectedRows) break;
      filled += r.affectedRows;
    }
    if (filled) log('[party] backfilled ' + filled + ' line(s) from ' + label);
    total += filled;
  }

  const [[left]] = await db.query(
    `SELECT COUNT(*) AS n FROM gl_entries WHERE account_code = ? AND party_id IS NULL`, [AP_CODE]);
  return { filled: total, unattributed: Number(left.n) || 0 };
}

/** Run all three, each independently guarded. Never throws. */
async function bootstrap(db, glPosting, log = console.log) {
  const out = {};
  try { out.named = await nameControlAccount(db, log); }
  catch (e) { log('[party] naming skipped: ' + e.message); }
  try { out.reclassified = await reclassifyLegacyAp(db, glPosting, log); }
  catch (e) { log('[party] reclassification skipped: ' + e.message); }
  try { out.backfill = await backfillParty(db, log); }
  catch (e) { log('[party] backfill skipped: ' + e.message); }
  return out;
}

module.exports = {
  bootstrap, nameControlAccount, reclassifyLegacyAp, backfillParty,
  AP_CODE, AP_NAME, LEGACY_AP_CODE, UNALLOCATED_CODE,
};
