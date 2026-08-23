'use strict';
/**
 * The one definition of "what the ledger says", shared by every GL-derived report.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * These fragments were written TWICE — inline in lib/reports/trialBalance.js and
 * as private helpers in lib/reports/glLedger.js — and the second file's own
 * comment claimed they were "the same half-open boundaries as the canonical
 * Trial Balance". They were. By convention and by comment, not by shared code.
 *
 * That is not a style complaint. The shape has ALREADY produced a live defect,
 * recorded at trialBalance.js:290-298: the opening clause is an OR of two
 * branches, and a missing outer pair of parentheses let SQL's AND-before-OR
 * precedence detach `status = 'posted'` from the second branch. A DRAFT journal
 * dated before the period then counted toward the opening balance. Two copies of
 * a clause that subtle will drift again; one copy cannot.
 *
 * ─── THE THREE RULES ─────────────────────────────────────────────────────────
 *
 * 1. POSTED ONLY. Draft and approved journals are operational workflow records,
 *    not the books. Every report reads `status = 'posted'`.
 *
 * 2. THE 0036 REMAP. Migration 0036 rebuilt the chart of accounts and
 *    deliberately left the historical rows immutable, recording each one's
 *    canonical destination in `coa_0036_account_map`. A report must therefore
 *    group a historical line by its DESTINATION account and exclude the
 *    mechanical transfer journal. Skip either half and the old history and the
 *    transfer are both counted — the canonical account is overstated, and the
 *    report silently disagrees with every report that did it correctly.
 *
 * 3. HALF-OPEN PERIOD BOUNDARIES. An opening-tagged journal dated on the first
 *    day is Opening; an ordinary journal that same day is Period movement; and
 *    an opening-tagged journal later inside the period is never disguised as
 *    ordinary turnover.
 *
 *      Opening = posted AND not-the-transfer AND
 *                ( (reference_type = 'opening'  AND journal_date <= :from)
 *               OR ( reference_type <> 'opening' AND journal_date <  :from) )
 *
 *      Period  = posted AND not-the-transfer AND reference_type <> 'opening'
 *                AND journal_date BETWEEN :from AND :to
 *
 *      Closing = opening + periodDebit − periodCredit
 *
 * Every builder returns `{ sql, params }` so a caller can never pair a clause
 * with the wrong placeholder count — the failure mode that made the original
 * duplication dangerous.
 */

/**
 * The mechanical journal migration 0036 posted to move history onto the
 * canonical chart. It is an artefact of the migration, never a business event,
 * and it must be excluded from EVERY report that also applies the remap —
 * otherwise the same money is counted on both sides of the transfer.
 */
const COA_TRANSITION_JOURNAL_ID = 'COA36-TRANSITION';

/** The company every ledger report is scoped to. */
const LEDGER_COMPANY_ID = 'CO-MAIN';

/**
 * The account a line belongs to AFTER the 0036 remap. Group by this, never by
 * the raw `account_id`.
 */
function effectiveAccountSql(entryAlias = 'e', mapAlias = 'coa_map') {
  return `COALESCE(${mapAlias}.target_account_id, ${entryAlias}.account_id)`;
}

/** The join that makes `effectiveAccountSql` resolvable. Always LEFT. */
function canonicalMapJoin(entryAlias = 'e', mapAlias = 'coa_map') {
  return `LEFT JOIN coa_0036_account_map ${mapAlias} ON ${mapAlias}.source_account_id = ${entryAlias}.account_id`;
}

// ─── The map table may not exist, and that is a legitimate state ─────────────
//
// `coa_0036_account_map` is created by db/migrations/0036_coa_saudi_canonical_
// rebuild.sql. A database that has never run 0036 does not have it — a fresh
// install, a dev box, a deployment mid-rollout.
//
// This is not an edge case to tolerate; it is the CORRECT answer. No map table
// means no chart rebuild happened, which means there is nothing to remap and no
// transfer journal to exclude. Joining unconditionally turns a working report
// into `Table ... doesn't exist` — and on two of the three reports that error
// was swallowed by an outer catch into an **empty 200**, which is the worst
// possible failure: a financial statement that reads as "no activity".
//
// Probed once and cached, mirroring lib/reports/trialBalance.js's own
// `getDimCols` cache for optional dimension columns.

let _mapPresent = null;

/** True when the 0036 remap table exists. Probed once per process. */
async function hasCanonicalMap(db) {
  if (_mapPresent !== null) return _mapPresent;
  try {
    const [rows] = await db.query("SHOW TABLES LIKE 'coa_0036_account_map'");
    _mapPresent = Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    // A probe that cannot answer must not take a report down with it. Absent is
    // the safe reading: it degrades to "no rebuild happened", which is exactly
    // the behaviour every one of these reports had before 0036 existed.
    _mapPresent = false;
  }
  return _mapPresent;
}

/** Test seam — the probe caches for the life of the process. */
function resetCanonicalMapCache() { _mapPresent = null; }

/**
 * The ENTRY-anchored shape: `FROM gl_entries e … GROUP BY <account>`.
 * Returns the join to add (possibly empty) and the account expression to both
 * select and group by.
 */
async function canonicalForEntries(db, entryAlias = 'e', mapAlias = 'coa_map') {
  if (!(await hasCanonicalMap(db))) {
    return { join: '', account: `${entryAlias}.account_id`, mapped: false };
  }
  return {
    join: canonicalMapJoin(entryAlias, mapAlias),
    account: effectiveAccountSql(entryAlias, mapAlias),
    mapped: true,
  };
}

/**
 * The ACCOUNT-anchored shape: `FROM gl_accounts a LEFT JOIN gl_entries e ON …`.
 * Here the remap runs the other way — an account collects the lines of the
 * historical accounts that were folded into it.
 */
async function canonicalForAccounts(db, accountAlias = 'a', entryAlias = 'e', mapAlias = 'coa_map') {
  if (!(await hasCanonicalMap(db))) {
    return { join: '', entryMatch: `${entryAlias}.account_id = ${accountAlias}.id`, mapped: false };
  }
  return {
    join: `LEFT JOIN coa_0036_account_map ${mapAlias} ON ${mapAlias}.target_account_id = ${accountAlias}.id`,
    entryMatch: `(${entryAlias}.account_id = ${accountAlias}.id OR ${entryAlias}.account_id = ${mapAlias}.source_account_id)`,
    mapped: true,
  };
}

/** An ordinary journal — i.e. NOT an opening-balance journal. */
function notOpeningSql(journalAlias = 'j') {
  return `(${journalAlias}.reference_type IS NULL OR ${journalAlias}.reference_type <> 'opening')`;
}

/**
 * Posted, and not the 0036 transfer. The floor under every clause below.
 *
 * Returned as `{sql, params}` and ALWAYS wrapped in its own parentheses: this is
 * the precise guard whose absence let a draft journal into an opening balance.
 */
function inTheBooksSql(journalAlias = 'j') {
  return {
    sql: `(${journalAlias}.status = 'posted' AND ${journalAlias}.id <> ?)`,
    params: [COA_TRANSITION_JOURNAL_ID],
  };
}

/**
 * Everything on the books strictly BEFORE `from` — the opening balance.
 * Two placeholders, both `from`, in this order.
 */
function openingSql(from, journalAlias = 'j') {
  const books = inTheBooksSql(journalAlias);
  return {
    sql:
      `(${books.sql} AND ` +
      `((${journalAlias}.reference_type = 'opening' AND ${journalAlias}.journal_date <= ?) OR ` +
      `(${notOpeningSql(journalAlias)} AND ${journalAlias}.journal_date < ?)))`,
    params: [...books.params, from, from],
  };
}

/** Ordinary movement inside [from, to] — the period's turnover. */
function periodSql(from, to, journalAlias = 'j') {
  const books = inTheBooksSql(journalAlias);
  return {
    sql:
      `(${books.sql} AND ${notOpeningSql(journalAlias)} AND ` +
      `${journalAlias}.journal_date >= ? AND ${journalAlias}.journal_date <= ?)`,
    params: [...books.params, from, to],
  };
}

/**
 * Everything on the books up to and including `asOf` — a cumulative snapshot.
 * This is what a balance sheet asks for, and it deliberately does NOT split
 * opening from movement: at a point in time there is only one balance.
 */
function asOfSql(asOf, journalAlias = 'j') {
  const books = inTheBooksSql(journalAlias);
  return {
    sql: `(${books.sql} AND ${journalAlias}.journal_date <= ?)`,
    params: [...books.params, asOf],
  };
}

module.exports = {
  COA_TRANSITION_JOURNAL_ID,
  LEDGER_COMPANY_ID,
  effectiveAccountSql,
  canonicalMapJoin,
  hasCanonicalMap,
  resetCanonicalMapCache,
  canonicalForEntries,
  canonicalForAccounts,
  notOpeningSql,
  inTheBooksSql,
  openingSql,
  periodSql,
  asOfSql,
};
