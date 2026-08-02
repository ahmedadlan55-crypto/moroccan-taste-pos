/**
 * lib/salesScope.js — WHO may see WHICH Order-to-Cash rows.
 *
 * The O2C routers (invoices / payments / returns / reports) shipped with
 * capability guards only. `invoices.view` answers WHETHER the caller may read
 * invoices; it never answered WHOSE. So a branch manager holding the ordinary
 * read capabilities could page `/api/order-to-cash/invoices`, `/payments`,
 * `/returns` and every `/reports/:type` (and its CSV export) and get the whole
 * company — other branches' customers, amounts, cashiers and AR balances.
 * Analytics closed the same hole long ago (lib/analytics/planner.js appends
 * `fact.scopeColumn IN (…)`, or `1=0` on zero grants); these four routers were
 * the remaining door.
 *
 * ONE scope semantic, not a second one. The branch set is resolved by
 * lib/analytics/scope.js `loadBranchScope` — the SAME query
 * (user_warehouse_access → warehouses.branch_id) that the analytics engine
 * enforces on — so a user cannot see a number in an O2C report that the
 * analytics hub would hide, or vice versa. Global scope is
 * lib/warehouseScope.js `isGlobalScope` (admin or developer), unchanged.
 *
 * WHY FAIL-CLOSED RATHER THAN 403
 *   `assertBranchAllowed` INTERSECTS the caller-supplied branch filter with the
 *   caller's grants and returns the intersection — an out-of-scope `?branchId=`
 *   yields an empty set, which becomes `1=0`, which returns nothing. It does
 *   NOT raise 403, and detail reads answer 404 rather than 403, because a 403
 *   is itself a disclosure: "you may not see invoice X" confirms that invoice X
 *   exists, and an attacker who can enumerate ids learns the other branches'
 *   document numbering, volume and (by probing dates) trading pattern without
 *   ever reading a row. A 404 for an out-of-scope id is indistinguishable from
 *   a 404 for an id that was never issued. This is the same rule
 *   lib/warehouseScope.js already states for warehouses ("an out-of-scope id is
 *   indistinguishable from a non-existent one").
 *
 * ZERO GRANTS MEANS ZERO ROWS. A non-global user with no warehouse access rows
 * gets `1=0` — never an unscoped query, never an error. Guessing "they must
 * mean everything" is exactly how these leaks start.
 *
 * A row whose branch_id is NULL is likewise invisible to a non-global user:
 * `branch_id IN (…)` is NULL, not true. That is deliberate — an unattributed
 * money row cannot be proven to belong to the caller's branch, so it must not
 * be shown to a scoped user. Global users still see it.
 *
 * A DB fault while resolving throws, and the O2C error mapper turns that into a
 * 500. Same reasoning as lib/analytics/scope.js: a guessed scope either leaks
 * (too wide) or lies (too narrow).
 */
'use strict';

const { loadBranchScope } = require('./analytics/scope');
const { err } = require('./order-to-cash/errors');

/** Generic not-found message — it must read the same for "yours but missing"
 *  and "someone else's", or the difference between them IS the leak. */
const NOT_FOUND_AR = 'السجل غير موجود';

/** Tables this module may scope, and the branch column each one carries.
 *  A constant map, never a caller-supplied identifier — these names are
 *  interpolated into SQL. */
const BRANCH_COLUMN = Object.freeze({
  ar_documents: 'branch_id',
  customer_payments: 'branch_id',
  sales_returns: 'branch_id',
});

/** Normalize any scope-ish value to { all, branchIds:string[] }.
 *  null/undefined normalizes to NO grants (not to "all") — a missing scope must
 *  never widen a query. */
function _norm(scope) {
  if (!scope) return { all: false, branchIds: [] };
  return { all: !!scope.all, branchIds: (scope.branchIds || []).map(String) };
}

function _uniq(list) {
  const seen = Object.create(null);
  const out = [];
  list.forEach((v) => { if (v && !seen[v]) { seen[v] = true; out.push(v); } });
  return out;
}

/**
 * Resolve the caller's branch scope.
 * @returns {Promise<{all:boolean, branchIds:string[]}>}
 */
async function resolveSalesScope(db, user) {
  const s = await loadBranchScope(db, user);
  return { all: !!s.all, branchIds: (s.branchIds || []).map(String) };
}

/**
 * Injection-safe branch predicate for a WHERE clause.
 *   global      → { sql: '',                    params: [] }  (no restriction)
 *   grants      → { sql: 'col IN (?,?)',        params: [ids] }
 *   zero grants → { sql: '1=0',                 params: [] }  (fail-closed)
 * `column` MUST be a trusted constant identifier — never user input.
 */
function branchClause(scope, column) {
  const s = _norm(scope);
  if (s.all) return { sql: '', params: [] };
  if (!s.branchIds.length) return { sql: '1=0', params: [] };
  const ph = s.branchIds.map(() => '?').join(',');
  return { sql: column + ' IN (' + ph + ')', params: s.branchIds.slice() };
}

/** Same predicate, pre-joined with ' AND ' for appending to a built WHERE. */
function andBranchClause(scope, column) {
  const c = branchClause(scope, column);
  return c.sql ? { sql: ' AND ' + c.sql, params: c.params } : { sql: '', params: [] };
}

/** Read `?branchId=` / `?branchIds=` (repeated or comma-separated) as a list. */
function requestedBranchIds(query) {
  const raw = [];
  const take = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(take); return; }
    String(v).split(',').forEach((p) => raw.push(p.trim()));
  };
  take(query && query.branchId);
  take(query && query.branchIds);
  return _uniq(raw.filter(Boolean));
}

/**
 * INTERSECT a caller-supplied branch filter with the caller's scope.
 * No filter → the scope unchanged. A filter naming a branch the caller has no
 * grant for simply drops out, so the resulting scope can be empty → `1=0` →
 * zero rows. Deliberately NOT a 403: see the header note on existence leaks.
 */
function assertBranchAllowed(scope, requested) {
  const s = _norm(scope);
  const want = _uniq(
    (Array.isArray(requested) ? requested : (requested == null || requested === '' ? [] : [requested]))
      .map((v) => String(v).trim())
      .filter(Boolean)
  );
  if (!want.length) return s;
  if (s.all) return { all: false, branchIds: want };
  const allow = Object.create(null);
  s.branchIds.forEach((id) => { allow[id] = true; });
  return { all: false, branchIds: want.filter((id) => allow[id]) };
}

/** Is a single row's branch visible to this scope? NULL/'' → no (see header). */
function isBranchAllowed(scope, branchId) {
  const s = _norm(scope);
  if (s.all) return true;
  if (branchId == null || String(branchId) === '') return false;
  return s.branchIds.indexOf(String(branchId)) !== -1;
}

/**
 * Guard an already-fetched row. Throws NOT_FOUND (404) — never 403 — when the
 * row belongs to another branch, so an out-of-scope id looks exactly like a
 * non-existent one.
 */
function assertRowInScope(scope, row, message) {
  if (!row || !isBranchAllowed(scope, row.branch_id)) {
    throw err('NOT_FOUND', message || NOT_FOUND_AR);
  }
  return row;
}

/**
 * Guard a record the handler does NOT otherwise load (e.g. an event timeline
 * keyed only by id). One cheap branch lookup; missing row and out-of-scope row
 * raise the identical NOT_FOUND.
 */
async function assertRecordInScope(db, scope, table, id, message) {
  const s = _norm(scope);
  if (s.all) return true;
  const column = BRANCH_COLUMN[table];
  if (!column) throw new Error('salesScope: no branch column registered for table "' + table + '"');
  const [rows] = await db.query(
    'SELECT ' + column + ' AS branch_id FROM ' + table + ' WHERE id = ? LIMIT 1', [id]);
  if (!rows.length || !isBranchAllowed(s, rows[0].branch_id)) {
    throw err('NOT_FOUND', message || NOT_FOUND_AR);
  }
  return true;
}

/**
 * Drop out-of-scope rows from a page a list service already returned.
 *
 * THIS IS THE ROUTE-LAYER HALF OF THE FIX, AND IT IS NOT THE WHOLE FIX.
 * The right place for the branch predicate is the list statement's own WHERE —
 * one `branchClause()` appended in InvoiceService.list / CustomerPaymentService
 * .list / SalesReturnService.list. Those files are owned elsewhere, so until
 * that lands the router closes the ROW leak here: the page is re-checked
 * against the branch column and anything belonging to another branch is
 * removed before it reaches the client.
 *
 * What this DOES fix: no other branch's invoice, receipt or credit note is ever
 * returned. What it does NOT fix: `pagination.total` is still counted over
 * every branch, so a scoped caller sees an inflated total and short (sometimes
 * empty) pages. `pagination.scopeFiltered` marks a page that lost rows so the
 * caller can tell an empty page from an exhausted list. Both symptoms vanish —
 * with no change here — the moment the WHERE clause lands, because this filter
 * then has nothing left to drop.
 */
async function filterPage(db, scope, table, rows) {
  const s = _norm(scope);
  if (s.all) return { rows: rows || [], dropped: 0 };
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { rows: list, dropped: 0 };
  const column = BRANCH_COLUMN[table];
  if (!column) throw new Error('salesScope: no branch column registered for table "' + table + '"');
  const c = branchClause(s, column);
  const ids = list.map((r) => String(r.id));
  const ph = ids.map(() => '?').join(',');
  const [okRows] = await db.query(
    'SELECT id FROM ' + table + ' WHERE id IN (' + ph + ') AND ' + c.sql,
    ids.concat(c.params));
  const allow = Object.create(null);
  okRows.forEach((r) => { allow[String(r.id)] = true; });
  const kept = list.filter((r) => allow[String(r.id)]);
  return { rows: kept, dropped: list.length - kept.length };
}

/**
 * Guard a customer-keyed read (the customer statement). A customer master row
 * carries no branch — it is company-wide by design — so the question we can
 * actually answer is "has this customer traded in a branch you may see?". If
 * not, the caller gets the same NOT_FOUND they would get for a customer id that
 * was never created.
 *
 * The statement's FIGURES stay company-wide on purpose: a statement that omitted
 * another branch's invoices would not reconcile with the balance the customer
 * owes, and an unreconcilable statement is worse than no statement.
 */
async function assertCustomerInScope(db, scope, customerId, message) {
  const s = _norm(scope);
  if (s.all) return true;
  const c = branchClause(s, 'branch_id');
  if (!customerId) throw err('NOT_FOUND', message || NOT_FOUND_AR);
  const [rows] = await db.query(
    'SELECT 1 AS ok FROM ar_documents WHERE customer_id = ? AND ' + c.sql + ' LIMIT 1',
    [String(customerId)].concat(c.params));
  if (!rows.length) throw err('NOT_FOUND', message || NOT_FOUND_AR);
  return true;
}

/**
 * Per-request resolution, memoized on the request object. Every O2C handler
 * that reads data calls this, so a request pays for at most one scope query.
 */
async function forRequest(db, req) {
  if (req && req._salesScope) return req._salesScope;
  const scope = await resolveSalesScope(db, (req && req.user) || null);
  if (req) req._salesScope = scope;
  return scope;
}

/** forRequest ∩ the request's own branch filter — what list/report SQL uses. */
async function effectiveScope(db, req) {
  const scope = await forRequest(db, req);
  return assertBranchAllowed(scope, requestedBranchIds(req && req.query));
}

module.exports = {
  NOT_FOUND_AR,
  BRANCH_COLUMN,
  resolveSalesScope,
  branchClause,
  andBranchClause,
  requestedBranchIds,
  assertBranchAllowed,
  isBranchAllowed,
  assertRowInScope,
  assertRecordInScope,
  filterPage,
  assertCustomerInScope,
  forRequest,
  effectiveScope,
};
