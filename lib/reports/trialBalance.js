/**
 * Canonical Trial Balance engine.
 *
 * Chart of Accounts / Trial Balance overhaul — Tier A.1 Corrective Gate.
 * See docs/adr/0002-chart-of-accounts-trial-balance.md and the independent
 * review that produced this revision. This file replaces the Tier A version
 * wholesale; the bugs below were all real, reproduced against the local DB
 * before being fixed here (not theoretical):
 *
 *   - Inactive accounts were excluded from the account list UPSTREAM of any
 *     activity check, so an inactive account with real historical postings
 *     silently vanished from the report. Fixed: fetch every account; only
 *     hide a row when it is BOTH zero-activity AND (inactive or includeZero
 *     is false).
 *   - Grand Total was computed by summing rows classified as "posting
 *     leaves" (a tree-derived concept). If a Folder or a non-leaf Parent
 *     ever carried its own direct postings (a data-quality violation, but
 *     one the report must never hide money because of), that money would
 *     just disappear from the total. Fixed: Grand Total is now a direct SQL
 *     SUM over every posted gl_entries line with a real account_id, in one
 *     pass, completely independent of the account tree. A mismatch between
 *     this raw total and the sum of true posting-leaf rows becomes a
 *     `nonLeafPostingActivity` diagnostic that flips `isClean` to false —
 *     the money is never lost, and the anomaly is never hidden either.
 *   - `isPostingLeaf` was `!hasChildren` alone. A childless account flagged
 *     is_folder=1 would have counted toward Grand Total. Fixed: a posting
 *     leaf now requires BOTH is_folder=0 AND no children (matching the
 *     stricter of the two prior implementations this engine replaced).
 *   - `level` was `String(code).length` — literally banned by the brief
 *     ("لا تقبل level من العميل... لا طول الكود"). Fixed: level is now a
 *     cycle-safe computed tree depth (memoized, hard-capped at the account
 *     count so a cycle can never cause unbounded recursion or a stack
 *     overflow).
 *   - `j.reference_type != 'opening'` silently drops every row where
 *     reference_type IS NULL (SQL three-valued logic: NULL != 'opening' is
 *     NULL, not TRUE) — those journals vanished from BOTH the opening and
 *     the period bucket. Fixed with an explicit IS NULL OR <> check
 *     everywhere reference_type is compared.
 *   - An opening-tagged journal dated AFTER the requested `from` cutoff was
 *     included in Opening unconditionally. Fixed: only opening-tagged
 *     entries dated on or before `from` count as Opening; later-dated ones
 *     are excluded from both Opening and Period and surfaced as a
 *     `futureDatedOpeningJournals` diagnostic instead.
 *   - A dimension filter (branch/brand/costCenter/warehouse) whose column
 *     doesn't exist on this schema was silently dropped. Fixed: throws
 *     TrialBalanceError SCHEMA_NOT_READY (409) instead of pretending the
 *     filter was applied.
 *   - Diagnostics (null-account entries) ignored the caller's date/dimension
 *     filters. Fixed: diagnostics now use the exact same WHERE fragments.
 *   - The route handler returned HTTP 200 on a genuine DB/unexpected error.
 *     Fixed in routes/erp-core.js: TrialBalanceError -> its own status
 *     (400/409), anything else -> 500, unified {success:false, code, error}.
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

function validateDateParam(value, label) {
  if (value === undefined || value === null || value === '') return;
  if (!DATE_RE.test(value)) {
    throw new TrialBalanceError(`صيغة ${label} غير صالحة — يجب أن تكون YYYY-MM-DD`, 'TB_INVALID_DATE_FORMAT', 400);
  }
}

// Cycle-safe tree depth (1-based) for every account, memoized. A cycle is
// broken the moment a node revisits an ancestor already on the current
// walk's path — that node is flagged, not looped on. Hard-capped at
// accounts.length so no malformed data can cause unbounded work.
function computeDepths(accounts, byId) {
  const depth = new Map();
  const cycleMembers = new Set();
  const n = accounts.length;

  function walk(id, pathSet) {
    if (depth.has(id)) return depth.get(id);
    if (pathSet.has(id)) {
      cycleMembers.add(id);
      return 1; // break the cycle here; still returns a finite depth
    }
    const acc = byId.get(id);
    if (!acc || !acc.parent_id || !byId.has(acc.parent_id)) {
      depth.set(id, 1);
      return 1;
    }
    pathSet.add(id);
    let d;
    if (pathSet.size > n + 1) {
      // Belt-and-suspenders against any pathological chain length.
      cycleMembers.add(id);
      d = 1;
    } else {
      d = 1 + walk(acc.parent_id, pathSet);
    }
    pathSet.delete(id);
    depth.set(id, d);
    return d;
  }

  accounts.forEach((a) => walk(a.id, new Set()));
  return { depth, cycleMembers };
}

/**
 * @param {object} db
 * @param {object} opts
 * @param {string} [opts.from] YYYY-MM-DD
 * @param {string} [opts.to] YYYY-MM-DD
 * @param {string} [opts.branch] @param {string} [opts.brand]
 * @param {string} [opts.costCenter] @param {string} [opts.warehouse]
 * @param {boolean} [opts.includeZero]
 */
async function computeTrialBalance(db, opts) {
  const o = opts || {};
  const { from, to, branch, brand, costCenter, warehouse, includeZero } = o;

  validateDateParam(from, 'from');
  validateDateParam(to, 'to');
  if (from && to && String(from) > String(to)) {
    throw new TrialBalanceError('نطاق التاريخ غير صالح: from بعد to', 'TB_INVALID_RANGE', 400);
  }

  const dim = await getDimCols(db);
  assertDimensionsSupported(dim, { branch, brand, costCenter, warehouse });
  const dimFrag = (alias) => dimensionFragments(alias, dim, { branch, brand, costCenter, warehouse });
  // reference_type is nullable — NULL must behave as "not opening", never as
  // a value that silently fails both the = 'opening' and <> 'opening' checks.
  const NOT_OPENING = "(j.reference_type IS NULL OR j.reference_type <> 'opening')";
  const IS_OPENING = "j.reference_type = 'opening'";

  // ── 1) Opening — reference_type='opening', dated on/before `from` only ──
  const openingMap = {};
  if (from) {
    const { clause: openClause1, params: openParams1 } = buildWhere([
      { sql: "j.status = 'posted'", params: [] },
      { sql: IS_OPENING, params: [] },
      { sql: 'j.journal_date <= ?', params: [from] },
      ...dimFrag('e'),
    ]);
    const [openRows1] = await db.query(
      `SELECT e.account_id, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${openClause1} AND e.account_id IS NOT NULL GROUP BY e.account_id`,
      openParams1
    );
    openRows1.forEach((r) => { openingMap[r.account_id] = { d: Number(r.d), c: Number(r.c) }; });

    // ── plus non-opening (incl. NULL reference_type) entries strictly before `from` ──
    const { clause: openClause2, params: openParams2 } = buildWhere([
      { sql: "j.status = 'posted'", params: [] },
      { sql: NOT_OPENING, params: [] },
      { sql: 'j.journal_date < ?', params: [from] },
      ...dimFrag('e'),
    ]);
    const [openRows2] = await db.query(
      `SELECT e.account_id, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${openClause2} AND e.account_id IS NOT NULL GROUP BY e.account_id`,
      openParams2
    );
    openRows2.forEach((r) => {
      if (!openingMap[r.account_id]) openingMap[r.account_id] = { d: 0, c: 0 };
      openingMap[r.account_id].d += Number(r.d);
      openingMap[r.account_id].c += Number(r.c);
    });
  }

  // ── Diagnostic: opening-tagged journals dated AFTER `from` — excluded
  // from both Opening and Period by design, never silently merged in. ──
  let futureDatedOpening = { count: 0, debit: 0, credit: 0 };
  if (from) {
    const { clause: futClause, params: futParams } = buildWhere([
      { sql: "j.status = 'posted'", params: [] },
      { sql: IS_OPENING, params: [] },
      { sql: 'j.journal_date > ?', params: [from] },
      ...dimFrag('e'),
    ]);
    const [[fut]] = await db.query(
      `SELECT COUNT(*) n, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${futClause} AND e.account_id IS NOT NULL`,
      futParams
    );
    futureDatedOpening = { count: Number(fut.n) || 0, debit: round2(fut.d), credit: round2(fut.c) };
  }

  // ── 2) Period movement: non-opening (incl. NULL) entries within [from, to] ──
  const { clause: periodClause, params: periodParams } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    { sql: NOT_OPENING, params: [] },
    from ? { sql: 'j.journal_date >= ?', params: [from] } : null,
    to ? { sql: 'j.journal_date <= ?', params: [to] } : null,
    ...dimFrag('e'),
  ]);
  const [periodRows] = await db.query(
    `SELECT e.account_id, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c, COUNT(*) n
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE ${periodClause} AND e.account_id IS NOT NULL GROUP BY e.account_id`,
    periodParams
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

  const rawFigures = new Map();
  accounts.forEach((a) => {
    rawFigures.set(a.id, {
      openD: (openingMap[a.id] || {}).d || 0,
      openC: (openingMap[a.id] || {}).c || 0,
      periodD: (periodMap[a.id] || {}).d || 0,
      periodC: (periodMap[a.id] || {}).c || 0,
      rowCount: (periodMap[a.id] || {}).n || 0,
    });
  });

  // Aggregated (self + descendants) — DISPLAY rollup for folder/parent rows
  // only. Cycle-safe: a cycle member's aggregate is just its own raw figures.
  const aggCache = new Map();
  function aggregate(id) {
    if (aggCache.has(id)) return aggCache.get(id);
    const self = rawFigures.get(id) || { openD: 0, openC: 0, periodD: 0, periodC: 0, rowCount: 0 };
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
      agg.rowCount += c.rowCount;
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
      rowCount: figs.rowCount,
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

  // ── Grand Total: a DIRECT, tree-independent SQL sum over every posted
  // line with a real account_id — never a sum of display rows. This is the
  // one number that can't be wrong because of a tree-shape bug. ──
  const { clause: rawOpenClause, params: rawOpenParams } = from
    ? buildWhere([
        { sql: "j.status = 'posted'", params: [] },
        { sql: `(${IS_OPENING} AND j.journal_date <= ?) OR (${NOT_OPENING} AND j.journal_date < ?)`, params: [from, from] },
        ...dimFrag('e'),
      ])
    : { clause: '1=0', params: [] }; // no `from` → opening is not meaningful, matches the per-row behavior
  const [[rawOpen]] = await db.query(
    `SELECT COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NOT NULL AND (${rawOpenClause})`,
    rawOpenParams
  );

  const { clause: rawPeriodClause, params: rawPeriodParams } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    { sql: NOT_OPENING, params: [] },
    from ? { sql: 'j.journal_date >= ?', params: [from] } : null,
    to ? { sql: 'j.journal_date <= ?', params: [to] } : null,
    ...dimFrag('e'),
  ]);
  const [[rawPeriod]] = await db.query(
    `SELECT COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NOT NULL AND ${rawPeriodClause}`,
    rawPeriodParams
  );

  // Grand Total open/period debit-credit = raw ledger sum (tree-independent,
  // authoritative, computed by direct SQL above). closeDebit/closeCredit
  // has no equivalent single raw-SQL shape (closing is a derived net, and
  // "natural side" only makes sense per-account) — so it is the sum of
  // EVERY account's own (never aggregated/rolled-up) natural-side-classified
  // closing figure, counted exactly once regardless of leaf/folder/parent.
  // This is mathematically required to tie for a correctly double-entry-
  // balanced ledger (Assets = Liabilities + Equity, by construction) — using
  // leaves-only here would manufacture a FALSE imbalance any time money
  // legitimately (or anomalously) sits on a non-leaf account.
  const ownTotals = rows.reduce(
    (t, r) => ({
      closeDebit: t.closeDebit + r._ownCloseDebit,
      closeCredit: t.closeCredit + r._ownCloseCredit,
    }),
    { closeDebit: 0, closeCredit: 0 }
  );
  const leafRows = rows.filter((r) => r.isPostingLeaf);

  const totals = {
    openDebit: round2(rawOpen.d),
    openCredit: round2(rawOpen.c),
    opening: round2(Number(rawOpen.d) - Number(rawOpen.c)),
    periodDebit: round2(rawPeriod.d),
    periodCredit: round2(rawPeriod.c),
    closing: round2((Number(rawOpen.d) - Number(rawOpen.c)) + (Number(rawPeriod.d) - Number(rawPeriod.c))),
    closeDebit: round2(ownTotals.closeDebit),
    closeCredit: round2(ownTotals.closeCredit),
  };

  totals.isOpeningBalanced = Math.abs(totals.openDebit - totals.openCredit) < 0.01;
  totals.isPeriodBalanced = Math.abs(totals.periodDebit - totals.periodCredit) < 0.01;
  totals.isClosingBalanced = Math.abs(totals.closeDebit - totals.closeCredit) < 0.01;
  totals.isBalanced = totals.isClosingBalanced; // backward-compat field name
  totals.abnormalCount = leafRows.filter((r) => r.abnormalSign).length;

  // ── Diagnostics — same filters as the report, never silently dropped ──
  const { clause: diagClause, params: diagParams } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    from ? { sql: 'j.journal_date >= ?', params: [from] } : null,
    to ? { sql: 'j.journal_date <= ?', params: [to] } : null,
    ...dimFrag('e'),
  ]);
  const [[nullAcc]] = await db.query(
    `SELECT COUNT(*) n, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NULL AND ${diagClause}`,
    diagParams
  );

  const nonLeafWithActivity = rows.filter((r) => !r.isPostingLeaf && r._ownHasActivity);
  const cycleAccounts = rows.filter((r) => r.isCycleMember).map((r) => ({ code: r.code, nameAr: r.nameAr }));
  const levelMismatches = rows.filter((r) => r.levelMismatch).map((r) => ({ code: r.code, nameAr: r.nameAr, storedLevel: r.storedLevel, computedLevel: r.level }));

  const diagnostics = {
    nullAccountEntries: Number(nullAcc.n) || 0,
    nullAccountDebit: round2(nullAcc.d),
    nullAccountCredit: round2(nullAcc.c),
    futureDatedOpeningJournals: futureDatedOpening,
    nonLeafPostingActivity: nonLeafWithActivity.map((r) => ({
      code: r.code, nameAr: r.nameAr, isFolder: r.isFolder, hasChildren: r.hasChildren,
      openDebit: r._own.openD ? round2(r._own.openD) : 0, openCredit: r._own.openC ? round2(r._own.openC) : 0,
      periodDebit: round2(r._own.periodD), periodCredit: round2(r._own.periodC),
    })),
    cycleAccounts,
    levelMismatches,
    note:
      'nullAccountEntries وfutureDatedOpeningJournals مستبعدة من openDebit/openCredit/periodDebit/periodCredit ' +
      '(الرقم الخام المباشر من القيود) ومن closeDebit/closeCredit (مجموع القيمة الخاصة بكل حساب، غير المُجمَّعة، ' +
      'مرة واحدة لكل حساب — تشمل nonLeafPostingActivity فعليًا حتى لا يظهر توازن زائف). nonLeafPostingActivity ' +
      'إذن لا يُغيّر الأرقام؛ هو تنبيه حوكمة (ترحيل على Folder/Parent مخالف للسياسة) يُظهر أين حدث ذلك، رغم أن ' +
      'المبلغ محسوب بشكل صحيح ضمن الإجمالي. أي بند هنا غير صفري يجعل isClean=false.',
  };

  const isClean =
    totals.isOpeningBalanced &&
    totals.isPeriodBalanced &&
    totals.isClosingBalanced &&
    diagnostics.nullAccountEntries === 0 &&
    diagnostics.futureDatedOpeningJournals.count === 0 &&
    diagnostics.nonLeafPostingActivity.length === 0 &&
    diagnostics.cycleAccounts.length === 0;
  totals.isClean = isClean;

  const cleanRows = filtered.map((r) => {
    const { _ownHasActivity, _own, _ownOpenDebit, _ownOpenCredit, _ownCloseDebit, _ownCloseCredit, ...rest } = r;
    return rest;
  });

  return {
    success: true,
    isClean,
    filters: {
      from: from || null, to: to || null,
      branch: branch || null, brand: brand || null, costCenter: costCenter || null, warehouse: warehouse || null,
      includeZero: !!includeZero,
    },
    rows: cleanRows,
    totals,
    diagnostics,
  };
}

module.exports = { computeTrialBalance, getDimCols, resetDimColsCache, TrialBalanceError };
