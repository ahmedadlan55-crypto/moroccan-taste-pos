'use strict';

// ─── ONE authority for "what is this person called" ─────────────────────────
//
// THE DEFECT THIS EXISTS TO KILL
// The POS receipt printed the cashier's LOGIN ID ("2004") instead of his name,
// because the only identity the till had at print time was the JWT — and the
// JWT carried username/role and nothing else (routes/auth.js jwt.sign at ~:194,
// ~:271, ~:333, ~:1508).
//
// THE TRAP THAT MADE IT MORE THAN A ONE-LINER
// This codebase has TWO independent stores for a person's display name, both
// written from the same admin form but readable independently:
//
//   1. users.full_name                — the column (server.js:3695 adds it via
//      addColumnIfMissing; written by routes/auth.js:766 on create and :910 on
//      update).
//   2. settings.user_meta[username].name — a JSON blob in the flat settings
//      table (written by routes/auth.js:788 on create and :1048 on update).
//
// Readers had already drifted apart:
//   • routes/auth.js:660  (admin users list) → full_name FIRST, meta second.
//   • lib/transactionGuards.js:130-145 (isDeveloper) → users column FIRST,
//     user_meta as the FALLBACK. Same precedence.
//   • routes/sales.js:2298-2308 (the RECEIPT reprint) → user_meta ONLY.
//   • routes/shifts.js:1469/1663/2018 (X/Z report) → user_meta ONLY.
//
// So sourcing a new JWT claim from users.full_name while the reprint kept
// reading user_meta would print TWO DIFFERENT NAMES for the SAME sale (original
// vs. reprint) on any account where only one store is populated. Every one of
// those readers now calls this module instead, so there is exactly one answer.
//
// THE RULE (precedence, highest first)
//   users.full_name  →  settings.user_meta[username].name  →  username
//
// Layer 1 + layer 3 are byte-for-byte the rule the rest of the repo already
// uses — COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) at server.js:3782,
// routes/hr.js:666, and the looser COALESCE(full_name, username) at
// routes/cash.js:400, routes/warehouse-ops.js:357-361. Layer 2 sits BETWEEN
// them so accounts whose name only ever reached the legacy JSON store keep
// their name instead of regressing to a login id — which is the whole point.
//
// A whitespace-only value in ANY layer falls through to the next, exactly as
// NULLIF(TRIM(x), '') does in SQL. The value returned is TRIMMED (SQL returns
// the raw column; a receipt must not print leading spaces) — the SELECTION rule
// is identical, only the presentation is tightened.
//
// Every DB read here is best-effort: a pre-migration schema with no
// users.full_name column, or a settings table with no user_meta row, degrades
// to the next layer instead of throwing. Callers on the auth path CANNOT be
// allowed to 500 over a cosmetic name.

/** The canonical SQL fragment, for queries that resolve the name in a JOIN.
 *  Assumes the users table is aliased `u`. Note this is the TWO-layer form —
 *  it cannot see settings.user_meta. Prefer resolveDisplayName() unless you are
 *  writing a bulk report query where a second round-trip is not worth it. */
const DISPLAY_NAME_SQL = "COALESCE(NULLIF(TRIM(u.full_name), ''), u.username)";

function _clean(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * The rule itself — pure, no I/O, so it can be unit-tested and reused by any
 * caller that already holds the three candidate values.
 *
 * @param {{fullName?: *, metaName?: *, username?: *}} parts
 * @returns {string} the display name, or '' when every layer is empty.
 */
function pickDisplayName(parts) {
  const p = parts || {};
  return _clean(p.fullName) || _clean(p.metaName) || _clean(p.username);
}

/** settings.user_meta as a plain object. Never throws; {} on any problem. */
async function readUserMeta(db) {
  try {
    const [rows] = await db.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'user_meta'"
    );
    if (!rows.length || !rows[0].setting_value) return {};
    const parsed = JSON.parse(rows[0].setting_value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * username → trimmed users.full_name (or '' when unset/whitespace/absent).
 * Never throws: an old schema without the column yields {}.
 */
async function readFullNames(db, usernames) {
  const list = [];
  (usernames || []).forEach((u) => {
    const c = _clean(u);
    if (c && list.indexOf(c) < 0) list.push(c);
  });
  if (!list.length) return {};
  try {
    const [rows] = await db.query(
      "SELECT username, COALESCE(NULLIF(TRIM(full_name), ''), '') AS display_name " +
        'FROM users WHERE username IN (?)',
      [list]
    );
    const out = {};
    rows.forEach((r) => {
      out[r.username] = _clean(r.display_name);
    });
    return out;
  } catch (_) {
    // users.full_name is added at boot (server.js:3695). A deploy that has not
    // run that migration yet must still be able to log in and print.
    return {};
  }
}

/**
 * Resolve ONE person, for the receipt / token / report.
 *
 * @param {object} db      the mysql2 pool (db/connection).
 * @param {string} username the login id — the value `sales.username`,
 *                          `shifts.username` and the JWT all key on.
 * @param {{fullName?: string, userMeta?: object}} [opts]
 *        fullName — pass it when the caller ALREADY has the users row in hand
 *                   (the login handler does: `SELECT *`), to skip a query.
 *                   Pass the RAW column value; the trim/empty rule is applied
 *                   here so it stays identical to the DB-read path.
 *        userMeta — a user_meta object already loaded by the caller (bulk
 *                   paths), to skip the settings query.
 * @returns {Promise<{username: string, name: string, empNo: string}>}
 *          `name` is never empty for a non-empty username (worst case it IS the
 *          username — the honest fallback, never a blank line on paper).
 *          `empNo` has NO users-table equivalent: it exists only in user_meta,
 *          and stays '' when unset so the receipt can hide the field rather
 *          than print a redundant "Ahmed, ahmed".
 */
async function resolveCashierIdentity(db, username, opts) {
  const uname = _clean(username);
  const o = opts || {};
  if (!uname) return { username: '', name: '', empNo: '' };

  let fullName = _clean(o.fullName);
  if (!fullName && o.fullName === undefined) {
    const map = await readFullNames(db, [uname]);
    fullName = map[uname] || '';
  }

  const meta = o.userMeta && typeof o.userMeta === 'object' ? o.userMeta : await readUserMeta(db);
  const me = (meta && meta[uname]) || {};

  return {
    username: uname,
    name: pickDisplayName({ fullName, metaName: me.name, username: uname }),
    empNo: _clean(me.empNo),
  };
}

/**
 * Bulk form — two queries total regardless of how many usernames, for list
 * endpoints (routes/shifts.js:2018 renders a whole page of shifts).
 *
 * @returns {Promise<Object<string, {username: string, name: string, empNo: string}>>}
 *          keyed by username. Unknown usernames still get an entry whose name
 *          is the username itself.
 */
async function resolveCashierIdentities(db, usernames) {
  const list = [];
  (usernames || []).forEach((u) => {
    const c = _clean(u);
    if (c && list.indexOf(c) < 0) list.push(c);
  });
  if (!list.length) return {};

  const [fullNames, meta] = await Promise.all([readFullNames(db, list), readUserMeta(db)]);
  const out = {};
  list.forEach((uname) => {
    const me = (meta && meta[uname]) || {};
    out[uname] = {
      username: uname,
      name: pickDisplayName({ fullName: fullNames[uname], metaName: me.name, username: uname }),
      empNo: _clean(me.empNo),
    };
  });
  return out;
}

module.exports = {
  DISPLAY_NAME_SQL,
  pickDisplayName,
  readUserMeta,
  readFullNames,
  resolveCashierIdentity,
  resolveCashierIdentities,
};
