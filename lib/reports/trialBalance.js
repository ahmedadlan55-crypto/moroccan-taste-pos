/**
 * Canonical Trial Balance engine.
 *
 * Chart of Accounts / Trial Balance overhaul. See
 * docs/adr/0002-chart-of-accounts-trial-balance.md. This file has been
 * through two corrective gates (Tier A.1, Tier A.2); the header below only
 * documents fixes still live in THIS revision — see the ADR for the full
 * history of what each gate found and fixed.
 *
 * CONTRACT — Single Ledger / CO-MAIN only. gl_accounts has no company_id
 * column today: every account, journal, and balance in this engine belongs
 * to one implicit ledger. This report does NOT provide company/ledger
 * isolation and must never be represented as doing so — there is exactly
 * one ledger to report on until a real multi-company schema exists (out of
 * scope for this gate; see docs/adr/0002 section 7 and lib/accountRoles.js
 * for the same lock applied to the Account Role Registry).
 *
 * Tier A.2 fixes in this revision:
 *   - Opening net-vs-gross: totals.openDebit/openCredit used to be a RAW SQL
 *     sum of every matching gl_entries.debit / .credit column — i.e. gross
 *     historical turnover, not each account's own net balance. An account
 *     with historical Dr100/Cr80 (net Dr20) contributed the full 100/80 to
 *     the footer instead of just 20; a perfectly-tied ledger could show a
 *     footer of "180/180" for what is genuinely a "20/20" opening position.
 *     Meanwhile closeDebit/closeCredit were ALREADY correct: each account's
 *     own (never-aggregated) net, classified to its natural side, summed
 *     once. Fixed: openDebit/openCredit now follow the exact same pattern
 *     (ownOpenTotals below) as closeDebit/closeCredit. The raw gross figure
 *     is still useful diagnostically, so it is preserved, but only under an
 *     explicit, honest name: diagnostics.grossHistoricalMovement — never
 *     presented as "opening balance."
 *   - Opening boundary consolidation: the per-account Opening map used to
 *     run TWO separate grouped queries (opening-tagged rows dated <= from,
 *     then non-opening rows dated < from) and merge them in JS. That is
 *     exactly the same (IS_OPENING AND date<=from) OR (NOT_OPENING AND
 *     date<from) boundary already used for the Grand Total's raw SQL sum —
 *     now computed ONCE (openBoundaryClause) and reused for the per-account
 *     GROUP BY query, the raw gross diagnostic, and the opening-scope
 *     null-account diagnostic. One source of truth for what "Opening" means,
 *     checked by three independent consumers instead of duplicated by two.
 *   - from/to are now MANDATORY (TB_RANGE_REQUIRED, 400) instead of quietly
 *     dropping Opening when `from` was absent. A trial balance without a
 *     stated period boundary is not a well-defined report.
 *   - Real calendar-date validation: `2026-02-31` and `2026-13-01` now match
 *     the YYYY-MM-DD regex but fail an explicit Date round-trip check and
 *     are rejected with TB_INVALID_DATE_VALUE (400) — format-only regex
 *     validation would have silently accepted them (MySQL itself just rolls
 *     them over to the next valid date).
 *   - Journal counts use COUNT(DISTINCT journal_id)/COUNT(DISTINCT j.id),
 *     never a raw gl_entries row count (which double-counts a 2-line
 *     journal). Applies to futureDatedOpeningJournals.count and the
 *     per-account journalCount field (renamed from the ambiguous rowCount).
 *   - NULL-account diagnostics now cover Opening AND Period separately
 *     (nullAccountOpening / nullAccountPeriod) — previously only the Period
 *     window was checked, so a NULL-account entry dated before `from` was
 *     invisible to the report entirely.
 *   - New structural-integrity diagnostics, both scoped to `journal_date <=
 *     to` and independent of any dimension filter (a broken journal header
 *     is a data-integrity problem, not something a branch/warehouse filter
 *     should be able to hide): orphanAccounts (parent_id set but dangling),
 *     unbalancedJournals (a single posted journal whose own total_debit !=
 *     total_credit — checked per-journal, so two individually-unbalanced
 *     journals can never cancel each other into a false "clean" report),
 *     and headerLineMismatches (a journal header's totals disagreeing with
 *     the actual SUM of its own gl_entries lines). levelMismatches already
 *     existed but did not affect isClean — it now does, like every other
 *     diagnostic here.
 *   - HTTP 500s never carry e.message to the client (routes/erp-core.js) —
 *     a fixed TB_INTERNAL_ERROR message only; the real error still goes to
 *     console.error for the server-side log.
 *
 * Tier A.3 fixes in this revision:
 *   - futureDatedOpeningJournals had no upper bound at `to` — an opening-
 *     tagged journal dated any time after `from`, including years beyond
 *     the report's own window, flipped isClean=false for a report that has
 *     nothing wrong with it. Scoped to the half-open (from, to] window,
 *     the report's own period; a genuinely future-period Opening beyond
 *     `to` is not this report's concern.
 *
 * Tier A.1 fixes (still in effect, kept for context):
 *   - Inactive accounts with real historical postings must not vanish
 *     upstream of the zero-activity/includeZero check.
 *   - Grand Total's periodDebit/periodCredit is a direct SQL SUM over every
 *     posted gl_entries line with a real account_id, independent of the
 *     account tree; a mismatch against posting-leaf-only totals surfaces as
 *     nonLeafPostingActivity, not a silently dropped amount.
 *   - isPostingLeaf requires BOTH is_folder=0 AND no children.
 *   - level is a cycle-safe computed tree depth, never String(code).length.
 *   - reference_type IS NULL is compared with explicit IS NULL OR <> checks
 *     (SQL three-valued logic would otherwise silently drop those rows).
 *   - An opening-tagged journal dated after `from` is excluded from Opening
 *     and surfaced as futureDatedOpeningJournals instead.
 *   - A dimension filter whose column doesn't exist throws SCHEMA_NOT_READY
 *     (409) instead of silently no-op'ing.
 */
'use strict';

const DIMENSION_COLUMNS = ['brand_id', 'branch_id', 'cost_center_id', 'warehouse_id'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class TrialBalanceError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'TrialBalanceError';
    this.code = code;
    this.status = status || 400;
  }
}

let _dimColsCache = null;
async function getDimCols(db) {
  if (_dimColsCache) return _dimColsCache;
  const present = {};
  for (const col of DIMENSION_COLUMNS) {
    const [c] = await db.query('SHOW COLUMNS FROM gl_entries LIKE ?', [col]);
    present[col] = c.length > 0;
  }
  _dimColsCache = present;
  return present;
}
function resetDimColsCache() {
  _dimColsCache = null;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function buildWhere(fragments) {
  const active = fragments.filter(Boolean);
  return {
    clause: active.map((f) => f.sql).join(' AND '),
    params: active.reduce((acc, f) => acc.concat(f.params || []), []),
  };
}

function dimensionFragments(alias, dim, { branch, brand, costCenter, warehouse }) {
  return [
    branch ? { sql: `${alias}.branch_id = ?`, params: [branch] } : null,
    brand ? { sql: `${alias}.brand_id = ?`, params: [brand] } : null,
    costCenter ? { sql: `${alias}.cost_center_id = ?`, params: [costCenter] } : null,
    warehouse ? { sql: `${alias}.warehouse_id = ?`, params: [warehouse] } : null,
  ];
}

// Requested-but-unsupported dimension -> hard failure, never a silent no-op.
// NOTE — this only checks the COLUMN exists on this schema, never whether
// the caller is actually AUTHORIZED to see that branch/warehouse's data.
// Real warehouse-access authorization is enforced one layer up, in
// routes/erp-core.js, by reusing the existing middleware/warehouseScope.js
// (req.guardWh) — the same access-control infrastructure every other
// warehouse-scoped route in this repo already uses. Branch-level access
// authorization has NO equivalent infrastructure anywhere in this codebase
// today (no user_branch_access table, no req.guardBranch) — inventing one
// would mean guessing a new schema, which is explicitly out of scope for
// this gate (the same reasoning that keeps this engine locked to Single
// Ledger/CO-MAIN above). Branch filtering here therefore remains
// column-existence-gated only; this is a real, documented gap, not a
// silent one.
function assertDimensionsSupported(dim, { branch, brand, costCenter, warehouse }) {
  const missing = [];
  if (branch && !dim.branch_id) missing.push('branch_id');
  if (brand && !dim.brand_id) missing.push('brand_id');
  if (costCenter && !dim.cost_center_id) missing.push('cost_center_id');
  if (warehouse && !dim.warehouse_id) missing.push('warehouse_id');
  if (missing.length) {
    throw new TrialBalanceError(
      `الأبعاد التالية غير موجودة في المخطط الحالي: ${missing.join(', ')}`,
      'SCHEMA_NOT_READY',
      409
    );
  }
}

// from/to are mandatory for this report (a trial balance without a stated
// period boundary is not well-defined) and must be real calendar dates —
// the YYYY-MM-DD regex alone accepts `2026-02-31`/`2026-13-01`; an explicit
// Date round-trip catches those (MySQL would otherwise just roll them over
// to the next valid date, silently shifting the requested window).
function validateDateParam(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new TrialBalanceError(`${label} إلزامي لهذا التقرير`, 'TB_RANGE_REQUIRED', 400);
  }
  if (!DATE_RE.test(value)) {
    throw new TrialBalanceError(`صيغة ${label} غير صالحة — يجب أن تكون YYYY-MM-DD`, 'TB_INVALID_DATE_FORMAT', 400);
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new TrialBalanceError(`${label} غير صالح فعليًا — تاريخ غير موجود في التقويم`, 'TB_INVALID_DATE_VALUE', 400);
  }
}

// Cycle-safe tree depth (1-based) for every account, memoized. A cycle is
// broken the moment a node revisits an ancestor already on the current
// walk's path — that node is flagged, not looped on. Hard-capped at
// accounts.length so no malformed data can cause unbounded work.
//
// Tier A.3 Release Gate item 4 — a plain A<->B cycle used to flag only
// ONE of the two nodes: the walk keeps `pathSet` (a Set, no ordering), and
// when the back-edge closing the cycle is found, only the single revisited
// id got added to cycleMembers — every OTHER node on the path back to it
// (B, in an A<->B cycle) was never marked, even though it is equally part
// of the same cycle. Fixed by also tracking the walk's ancestry as an
// ORDERED array (`path`): when a back-edge is detected, every node from the
// repeated id's first occurrence onward in that array is the actual cycle
// — mark all of them, not just the one where the revisit was detected. A
// node that merely points INTO a cycle (C -> A, where A<->B is the cycle)
// is correctly excluded — path.indexOf(id) isolates just the true cycle,
// not the whole ancestry chain leading to it. Depth values are unchanged
// by this fix (verified: the recursion and its returned depth numbers are
// identical to the old code — only which ids land in cycleMembers differs).
function computeDepths(accounts, byId) {
  const depth = new Map();
  const cycleMembers = new Set();
  const n = accounts.length;

  function walk(id, path, pathSet) {
    if (depth.has(id)) return depth.get(id);
    if (pathSet.has(id)) {
      const cycleStart = path.indexOf(id);
      for (let i = cycleStart; i < path.length; i++) cycleMembers.add(path[i]);
      cycleMembers.add(id);
      return 1; // break the cycle here; still returns a finite depth
    }
    const acc = byId.get(id);
    if (!acc || !acc.parent_id || !byId.has(acc.parent_id)) {
      depth.set(id, 1);
      return 1;
    }
    path.push(id);
    pathSet.add(id);
    let d;
    if (path.length > n + 1) {
      // Belt-and-suspenders against any pathological chain length.
      cycleMembers.add(id);
      d = 1;
    } else {
      d = 1 + walk(acc.parent_id, path, pathSet);
    }
    path.pop();
    pathSet.delete(id);
    depth.set(id, d);
    return d;
  }

  accounts.forEach((a) => walk(a.id, [], new Set()));
  return { depth, cycleMembers };
}

/**
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.from YYYY-MM-DD (mandatory)
 * @param {string} opts.to YYYY-MM-DD (mandatory)
 * @param {string} [opts.branch] @param {string} [opts.brand]
 * @param {string} [opts.costCenter] @param {string} [opts.warehouse]
 * @param {boolean} [opts.includeZero]
 */
async function computeTrialBalance(db, opts) {
  const o = opts || {};
  const { from, to, branch, brand, costCenter, warehouse, includeZero } = o;

  validateDateParam(from, 'from');
  validateDateParam(to, 'to');
  if (String(from) > String(to)) {
    throw new TrialBalanceError('نطاق التاريخ غير صالح: from بعد to', 'TB_INVALID_RANGE', 400);
  }

  const dim = await getDimCols(db);
  assertDimensionsSupported(dim, { branch, brand, costCenter, warehouse });
  const dimFrag = (alias) => dimensionFragments(alias, dim, { branch, brand, costCenter, warehouse });
  // reference_type is nullable — NULL must behave as "not opening", never as
  // a value that silently fails both the = 'opening' and <> 'opening' checks.
  const NOT_OPENING = "(j.reference_type IS NULL OR j.reference_type <> 'opening')";
  const IS_OPENING = "j.reference_type = 'opening'";

  // ── Opening boundary, computed ONCE and reused by every consumer below:
  // the per-account Opening map, the raw gross diagnostic, and the
  // opening-scope null-account diagnostic. `status='posted'` and every
  // dimension filter must apply to BOTH branches of the OR — which requires
  // the ENTIRE disjunction to be wrapped in its own parens as ONE fragment.
  // buildWhere joins fragments with plain ' AND ', it does not parenthesize
  // each fragment for you: an earlier revision of this exact line omitted
  // the outer parens around the OR, so SQL's normal AND-before-OR
  // precedence silently rewrote `status='posted' AND (A) OR (B)` into
  // `(status='posted' AND A) OR (B)` — the second branch (non-opening rows
  // dated before `from`) was NOT gated by status='posted' at all, so a
  // DRAFT journal dated before `from` was wrongly counted as Opening.
  // trialBalanceEngine.test.js's draft-historical-exclusion case caught
  // this for real; the outer parens below are what make the fix hold. ──
  const { clause: openBoundaryClause, params: openBoundaryParams } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    { sql: `((${IS_OPENING} AND j.journal_date <= ?) OR (${NOT_OPENING} AND j.journal_date < ?))`, params: [from, from] },
    ...dimFrag('e'),
  ]);

  // ── Period boundary, computed ONCE and reused by the per-account Period
  // map, the raw gross Grand Total, and the period-scope null-account
  // diagnostic. ──
  const { clause: periodBoundaryClause, params: periodBoundaryParams } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    { sql: NOT_OPENING, params: [] },
    { sql: 'j.journal_date >= ?', params: [from] },
    { sql: 'j.journal_date <= ?', params: [to] },
    ...dimFrag('e'),
  ]);

  // ── 1) Opening — per-account net, via the single boundary clause above ──
  const [openRows] = await db.query(
    `SELECT e.account_id, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NOT NULL AND (${openBoundaryClause}) GROUP BY e.account_id`,
    openBoundaryParams
  );
  const openingMap = {};
  openRows.forEach((r) => { openingMap[r.account_id] = { d: Number(r.d), c: Number(r.c) }; });

  // ── Diagnostic: opening-tagged journals dated AFTER `from` — excluded
  // from both Opening and Period by design, never silently merged in.
  // Tier A.3 Release Gate item 3 — this used to have NO upper bound at
  // `to`, so an opening-tagged journal dated years beyond the report's own
  // window (a genuinely future REPORTING PERIOD, not a data problem for
  // THIS historical report) still flipped isClean=false. Scoped to the
  // half-open window (from, to] — the report's own period — matching how
  // every other diagnostic here is bounded by the requested range instead
  // of an unbounded "anything after X". A future-dated Opening beyond `to`
  // is simply not this report's concern; it will surface on its own report
  // once `to` reaches it. ──
  const { clause: futClause, params: futParams } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    { sql: IS_OPENING, params: [] },
    { sql: 'j.journal_date > ?', params: [from] },
    { sql: 'j.journal_date <= ?', params: [to] },
    ...dimFrag('e'),
  ]);
  const [[fut]] = await db.query(
    `SELECT COUNT(DISTINCT j.id) n, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE ${futClause} AND e.account_id IS NOT NULL`,
    futParams
  );
  const futureDatedOpening = { count: Number(fut.n) || 0, debit: round2(fut.d), credit: round2(fut.c) };

  // ── 2) Period movement: non-opening (incl. NULL) entries within [from, to] ──
  const [periodRows] = await db.query(
    `SELECT e.account_id, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c, COUNT(DISTINCT e.journal_id) n
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NOT NULL AND ${periodBoundaryClause} GROUP BY e.account_id`,
    periodBoundaryParams
  );
  const periodMap = {};
  periodRows.forEach((r) => { periodMap[r.account_id] = { d: Number(r.d), c: Number(r.c), n: Number(r.n) }; });

  // ── 3) EVERY account, active or not — inactive-with-history must not
  // vanish before the row-level zero/active filter even runs. ──
  const [accounts] = await db.query(
    `SELECT id, code, name_ar, type, parent_id, is_folder, is_active, level AS storedLevel
     FROM gl_accounts ORDER BY code`
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const childrenOf = new Map();
  accounts.forEach((a) => {
    const pid = a.parent_id || null;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(a);
  });
  const hasChildren = (id) => (childrenOf.get(id) || []).length > 0;
  const { depth: depthMap, cycleMembers } = computeDepths(accounts, byId);
  // parent_id set but dangling (doesn't resolve to any real account) — the
  // depth walk above silently treats these as roots (depth=1); this is
  // reasonable fallback behavior for computing a depth, but the anomaly
  // itself must not go unreported.
  const orphanAccounts = accounts
    .filter((a) => a.parent_id && !byId.has(a.parent_id))
    .map((a) => ({ code: a.code, nameAr: a.name_ar, parentId: a.parent_id }));

  const rawFigures = new Map();
  accounts.forEach((a) => {
    rawFigures.set(a.id, {
      openD: (openingMap[a.id] || {}).d || 0,
      openC: (openingMap[a.id] || {}).c || 0,
      periodD: (periodMap[a.id] || {}).d || 0,
      periodC: (periodMap[a.id] || {}).c || 0,
      journalCount: (periodMap[a.id] || {}).n || 0,
    });
  });

  // Aggregated (self + descendants) — DISPLAY rollup for folder/parent rows
  // only. Cycle-safe: a cycle member's aggregate is just its own raw figures.
  const aggCache = new Map();
  function aggregate(id) {
    if (aggCache.has(id)) return aggCache.get(id);
    const self = rawFigures.get(id) || { openD: 0, openC: 0, periodD: 0, periodC: 0, journalCount: 0 };
    if (cycleMembers.has(id)) {
      aggCache.set(id, Object.assign({}, self));
      return aggCache.get(id);
    }
    const agg = Object.assign({}, self);
    (childrenOf.get(id) || []).forEach((ch) => {
      if (cycleMembers.has(ch.id)) return; // never recurse into a cycle
      const c = aggregate(ch.id);
      agg.openD += c.openD; agg.openC += c.openC;
      agg.periodD += c.periodD; agg.periodC += c.periodC;
      agg.journalCount += c.journalCount;
    });
    aggCache.set(id, agg);
    return agg;
  }

  const rows = accounts.map((a) => {
    // AND-based posting-leaf definition: a Folder flag alone or a childless
    // structure alone is not enough — both must hold. A childless Folder is
    // NOT a posting leaf (never enters Grand Total); a non-folder "parent
    // with direct activity" is not a posting leaf either (has children).
    const isPostingLeaf = !a.is_folder && !hasChildren(a.id);
    const own = rawFigures.get(a.id);
    const figs = isPostingLeaf || cycleMembers.has(a.id) ? own : aggregate(a.id);
    const isDebitNormal = a.type === 'asset' || a.type === 'expense';

    function naturalSide(net) {
      if (isDebitNormal) return net >= 0 ? { d: net, c: 0 } : { d: 0, c: -net };
      return net <= 0 ? { d: 0, c: -net } : { d: net, c: 0 };
    }

    const openNet = figs.openD - figs.openC;
    const closeNet = openNet + figs.periodD - figs.periodC;
    const openSide = naturalSide(openNet);
    const closeSide = naturalSide(closeNet);
    const openDebit = openSide.d, openCredit = openSide.c;
    const closeDebit = closeSide.d, closeCredit = closeSide.c;
    const abnormalSign = isDebitNormal ? closeCredit > 0.01 : closeDebit > 0.01;
    const ownHasActivity = own.openD !== 0 || own.openC !== 0 || own.periodD !== 0 || own.periodC !== 0;

    // Own-only (never aggregated) natural-side split — used for the TRUE
    // Grand Total balance check below, which must include every account's
    // own direct activity exactly once (leaf or not) to hold as a real
    // double-entry invariant. Aggregated `figs` above is for DISPLAY rollup
    // on folder/parent rows only and would double-count an ancestor
    // alongside its own descendants if summed directly.
    const ownOpenNet = own.openD - own.openC;
    const ownCloseNet = ownOpenNet + own.periodD - own.periodC;
    const ownOpenSide = naturalSide(ownOpenNet);
    const ownCloseSide = naturalSide(ownCloseNet);

    return {
      accountId: a.id,
      code: a.code,
      nameAr: a.name_ar,
      type: a.type,
      parentId: a.parent_id || null,
      level: depthMap.get(a.id) || 1,
      storedLevel: a.storedLevel,
      levelMismatch: Number(a.storedLevel) !== (depthMap.get(a.id) || 1),
      hasChildren: hasChildren(a.id),
      isFolder: !!a.is_folder,
      isPostingLeaf,
      isActive: a.is_active === 1 || a.is_active === null,
      isCycleMember: cycleMembers.has(a.id),
      opening: round2(openNet),
      openDebit: round2(openDebit),
      openCredit: round2(openCredit),
      periodDebit: round2(figs.periodD),
      periodCredit: round2(figs.periodC),
      net: round2(figs.periodD - figs.periodC),
      closing: round2(closeNet),
      closeDebit: round2(closeDebit),
      closeCredit: round2(closeCredit),
      abnormalSign,
      journalCount: figs.journalCount,
      _ownHasActivity: ownHasActivity,
      _own: own,
      _ownOpenDebit: ownOpenSide.d,
      _ownOpenCredit: ownOpenSide.c,
      _ownCloseDebit: ownCloseSide.d,
      _ownCloseCredit: ownCloseSide.c,
    };
  });

  // Row-level visibility: hide ONLY when there is truly nothing to show —
  // zero activity AND includeZero not requested. Active/inactive plays no
  // part in this decision; an inactive account with any opening/period/
  // closing figure is always shown, exactly like an active one.
  const filtered = includeZero
    ? rows
    : rows.filter((r) => r.opening !== 0 || r.periodDebit !== 0 || r.periodCredit !== 0 || r.closing !== 0);

  // ── Grand Total, Period: a DIRECT, tree-independent SQL sum over every
  // posted line with a real account_id in the period window — never a sum
  // of display rows. Period movement is conventionally a GROSS turnover
  // figure (total debits posted, total credits posted), unlike Opening/
  // Closing which are per-account NET balances — this is intentionally
  // NOT "fixed" the way Opening was; showing gross period activity is
  // correct trial-balance behavior, not the net-vs-gross bug. ──
  const [[rawPeriod]] = await db.query(
    `SELECT COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NOT NULL AND ${periodBoundaryClause}`,
    periodBoundaryParams
  );

  // ── Grand Total, Opening: NOT a raw SQL sum (that was the bug — see file
  // header). Each account's own (never aggregated) net balance, classified
  // to its natural side, summed exactly once across every account — the
  // identical method closeDebit/closeCredit already used correctly. ──
  const ownTotals = rows.reduce(
    (t, r) => ({
      openDebit: t.openDebit + r._ownOpenDebit,
      openCredit: t.openCredit + r._ownOpenCredit,
      closeDebit: t.closeDebit + r._ownCloseDebit,
      closeCredit: t.closeCredit + r._ownCloseCredit,
    }),
    { openDebit: 0, openCredit: 0, closeDebit: 0, closeCredit: 0 }
  );
  const leafRows = rows.filter((r) => r.isPostingLeaf);

  const totals = {
    openDebit: round2(ownTotals.openDebit),
    openCredit: round2(ownTotals.openCredit),
    opening: round2(ownTotals.openDebit - ownTotals.openCredit),
    periodDebit: round2(rawPeriod.d),
    periodCredit: round2(rawPeriod.c),
    closing: round2((ownTotals.openDebit - ownTotals.openCredit) + (Number(rawPeriod.d) - Number(rawPeriod.c))),
    closeDebit: round2(ownTotals.closeDebit),
    closeCredit: round2(ownTotals.closeCredit),
  };

  totals.isOpeningBalanced = Math.abs(totals.openDebit - totals.openCredit) < 0.01;
  totals.isPeriodBalanced = Math.abs(totals.periodDebit - totals.periodCredit) < 0.01;
  totals.isClosingBalanced = Math.abs(totals.closeDebit - totals.closeCredit) < 0.01;
  totals.isBalanced = totals.isClosingBalanced; // backward-compat field name
  totals.abnormalCount = leafRows.filter((r) => r.abnormalSign).length;

  // ── Diagnostics — same filters as the report, never silently dropped ──

  // Raw gross historical turnover — explicitly NOT the opening balance (see
  // file header). Exposed only so a reader who wants "how much activity
  // happened before `from`, gross" can still see it, under an honest name.
  const [[rawOpenGross]] = await db.query(
    `SELECT COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NOT NULL AND (${openBoundaryClause})`,
    openBoundaryParams
  );
  const grossHistoricalMovement = { debit: round2(rawOpenGross.d), credit: round2(rawOpenGross.c) };

  // NULL-account entries — Opening scope AND Period scope, checked
  // separately (previously only Period was checked at all, so a
  // NULL-account entry dated before `from` was invisible to this report).
  const [[nullOpen]] = await db.query(
    `SELECT COUNT(*) n, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NULL AND (${openBoundaryClause})`,
    openBoundaryParams
  );
  const [[nullPeriod]] = await db.query(
    `SELECT COUNT(*) n, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NULL AND ${periodBoundaryClause}`,
    periodBoundaryParams
  );
  const nullAccountOpening = { count: Number(nullOpen.n) || 0, debit: round2(nullOpen.d), credit: round2(nullOpen.c) };
  const nullAccountPeriod = { count: Number(nullPeriod.n) || 0, debit: round2(nullPeriod.d), credit: round2(nullPeriod.c) };

  // Tier A.3 Release Gate item 5 — a NON-NULL gl_entries.account_id that
  // matches no row in gl_accounts at all was invisible to every existing
  // diagnostic: nullAccountOpening/Period only catch account_id IS NULL,
  // and orphanAccounts is about gl_accounts.parent_id dangling, a
  // different concept entirely. db/schema.sql DOES declare a real FK
  // (account_id REFERENCES gl_accounts(id) ON DELETE SET NULL) — a normal
  // INSERT or a normal account deletion through that constraint can't
  // produce this state (deleting the account auto-nulls the reference,
  // already covered by the NULL-account diagnostics above). This remains a
  // real, reachable data-integrity gap regardless: a bulk import/migration
  // that ran with FOREIGN_KEY_CHECKS=0, a row from before the constraint
  // existed on an older deploy, or direct manual DB surgery, can all leave
  // a genuinely dangling non-NULL account_id behind — the FK protects the
  // normal path, not every path. Checked in both Opening and Period scope,
  // same pattern as the NULL-account checks right above, using the same
  // boundary clauses (one source of truth for what "Opening"/"Period"
  // means).
  const [[danglingOpen]] = await db.query(
    `SELECT COUNT(*) n, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     LEFT JOIN gl_accounts ga ON ga.id = e.account_id
     WHERE e.account_id IS NOT NULL AND ga.id IS NULL AND (${openBoundaryClause})`,
    openBoundaryParams
  );
  const [[danglingPeriod]] = await db.query(
    `SELECT COUNT(*) n, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     LEFT JOIN gl_accounts ga ON ga.id = e.account_id
     WHERE e.account_id IS NOT NULL AND ga.id IS NULL AND ${periodBoundaryClause}`,
    periodBoundaryParams
  );
  const danglingAccountOpening = { count: Number(danglingOpen.n) || 0, debit: round2(danglingOpen.d), credit: round2(danglingOpen.c) };
  const danglingAccountPeriod = { count: Number(danglingPeriod.n) || 0, debit: round2(danglingPeriod.d), credit: round2(danglingPeriod.c) };

  // Structural integrity — a broken journal is a data problem regardless of
  // which branch/warehouse a report happens to filter by, so these are
  // scoped only by `journal_date <= to` (everything this report could ever
  // show), never by dimension filters that could hide the anomaly.
  const [unbalancedJournalRows] = await db.query(
    `SELECT id, journal_number, journal_date, total_debit AS totalDebit, total_credit AS totalCredit
     FROM gl_journals
     WHERE status = 'posted' AND journal_date <= ? AND ABS(total_debit - total_credit) > 0.01`,
    [to]
  );
  const [headerLineMismatchRows] = await db.query(
    `SELECT j.id, j.journal_number, j.journal_date,
            j.total_debit AS headerDebit, j.total_credit AS headerCredit,
            COALESCE(SUM(e.debit),0) AS lineDebit, COALESCE(SUM(e.credit),0) AS lineCredit
     FROM gl_journals j LEFT JOIN gl_entries e ON e.journal_id = j.id
     WHERE j.status = 'posted' AND j.journal_date <= ?
     GROUP BY j.id, j.journal_number, j.journal_date, j.total_debit, j.total_credit
     HAVING ABS(j.total_debit - lineDebit) > 0.01 OR ABS(j.total_credit - lineCredit) > 0.01`,
    [to]
  );

  const nonLeafWithActivity = rows.filter((r) => !r.isPostingLeaf && r._ownHasActivity);
  const cycleAccounts = rows.filter((r) => r.isCycleMember).map((r) => ({ code: r.code, nameAr: r.nameAr }));
  const levelMismatches = rows.filter((r) => r.levelMismatch).map((r) => ({ code: r.code, nameAr: r.nameAr, storedLevel: r.storedLevel, computedLevel: r.level }));

  const diagnostics = {
    nullAccountOpening,
    nullAccountPeriod,
    danglingAccountOpening,
    danglingAccountPeriod,
    futureDatedOpeningJournals: futureDatedOpening,
    grossHistoricalMovement,
    orphanAccounts,
    nonLeafPostingActivity: nonLeafWithActivity.map((r) => ({
      code: r.code, nameAr: r.nameAr, isFolder: r.isFolder, hasChildren: r.hasChildren,
      openDebit: r._own.openD ? round2(r._own.openD) : 0, openCredit: r._own.openC ? round2(r._own.openC) : 0,
      periodDebit: round2(r._own.periodD), periodCredit: round2(r._own.periodC),
    })),
    cycleAccounts,
    levelMismatches,
    unbalancedJournals: unbalancedJournalRows.map((j) => ({
      id: j.id, journalNumber: j.journal_number, journalDate: j.journal_date,
      totalDebit: round2(j.totalDebit), totalCredit: round2(j.totalCredit),
    })),
    headerLineMismatches: headerLineMismatchRows.map((j) => ({
      id: j.id, journalNumber: j.journal_number, journalDate: j.journal_date,
      headerDebit: round2(j.headerDebit), headerCredit: round2(j.headerCredit),
      lineDebit: round2(j.lineDebit), lineCredit: round2(j.lineCredit),
    })),
    note:
      'nullAccountOpening/nullAccountPeriod وdanglingAccountOpening/danglingAccountPeriod و' +
      'futureDatedOpeningJournals مستبعدة من openDebit/openCredit/' +
      'periodDebit/periodCredit (الرقم المباشر من القيود) ومن closeDebit/closeCredit (مجموع القيمة الخاصة بكل ' +
      'حساب، غير المُجمَّعة، مرة واحدة لكل حساب — تشمل nonLeafPostingActivity فعليًا حتى لا يظهر توازن زائف). ' +
      'grossHistoricalMovement رقم تشخيصي فقط (إجمالي الحركة التاريخية الخام قبل from) وليس رصيد أول المدة — ' +
      'رصيد أول المدة الصحيح هو openDebit/openCredit أعلاه. أي بند غير صفري هنا (باستثناء grossHistoricalMovement ' +
      'نفسه) يجعل isClean=false.',
  };

  const isClean =
    totals.isOpeningBalanced &&
    totals.isPeriodBalanced &&
    totals.isClosingBalanced &&
    diagnostics.nullAccountOpening.count === 0 &&
    diagnostics.nullAccountPeriod.count === 0 &&
    diagnostics.danglingAccountOpening.count === 0 &&
    diagnostics.danglingAccountPeriod.count === 0 &&
    diagnostics.futureDatedOpeningJournals.count === 0 &&
    diagnostics.orphanAccounts.length === 0 &&
    diagnostics.nonLeafPostingActivity.length === 0 &&
    diagnostics.cycleAccounts.length === 0 &&
    diagnostics.levelMismatches.length === 0 &&
    diagnostics.unbalancedJournals.length === 0 &&
    diagnostics.headerLineMismatches.length === 0;
  totals.isClean = isClean;

  const cleanRows = filtered.map((r) => {
    const { _ownHasActivity, _own, _ownOpenDebit, _ownOpenCredit, _ownCloseDebit, _ownCloseCredit, ...rest } = r;
    return rest;
  });

  return {
    success: true,
    isClean,
    // Single Ledger/CO-MAIN contract — see file header. Fixed, not a real
    // filter; exposed so a caller never has to guess.
    ledgerScope: 'CO-MAIN',
    filters: {
      from, to,
      branch: branch || null, brand: brand || null, costCenter: costCenter || null, warehouse: warehouse || null,
      includeZero: !!includeZero,
    },
    rows: cleanRows,
    totals,
    diagnostics,
  };
}

module.exports = { computeTrialBalance, getDimCols, resetDimColsCache, TrialBalanceError };
