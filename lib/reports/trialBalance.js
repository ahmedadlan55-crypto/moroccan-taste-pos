/**
 * Canonical Trial Balance engine.
 *
 * Chart of Accounts / Trial Balance overhaul, Tier A — see
 * docs/adr/0002-chart-of-accounts-trial-balance.md section 6.
 *
 * Replaces the calculation logic previously duplicated (and diverging)
 * between routes/erp-core.js's live '/reports/trial-balance' handler and
 * the shadowed/unreachable routes/erp/reports/trial-balance.js. This module
 * merges the correct parts of both:
 *   - Opening balance = reference_type='opening' entries (any date) PLUS
 *     non-opening entries strictly before `from` (from the shadowed file —
 *     the live file did not distinguish opening journals at all).
 *   - Debit/credit split by natural side + abnormalSign + three independent
 *     balance checks (also from the shadowed file).
 *   - Recursive folder rollup for DISPLAY, kept separate from the Grand
 *     Total (from the live file's tree-aggregation approach) — but the
 *     Grand Total here sums ONLY structural tree leaves (own-only, never
 *     aggregated), so a "parent marked as postable" data-quality bug
 *     (see the audit's "non-aggregating parent" check) cannot double-count.
 *
 * Computed from posted gl_entries only — gl_accounts.balance is never read
 * (rule 6). All statements here are read-only SELECT/SHOW.
 */
'use strict';

const DIMENSION_COLUMNS = ['brand_id', 'branch_id', 'cost_center_id', 'warehouse_id'];

class TrialBalanceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TrialBalanceError';
    this.code = code;
  }
}

// SHOW COLUMNS is expensive to run per-request (it was running 3-4x per call
// in BOTH prior implementations, duplicated a 3rd time in balance-sheet.js).
// Cache once per process. resetDimColsCache() exists for tests that need to
// simulate a schema without these columns.
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

// Each fragment owns its own SQL text AND its own bound param(s) together,
// so clause order and param order can never drift apart — the historical
// failure mode this guards against is two hand-maintained parallel arrays
// (`where.push(...)` / `params.push(...)`) getting out of step after an
// edit. Falsy entries (condition not met) are simply skipped.
function buildWhere(fragments) {
  const active = fragments.filter(Boolean);
  return {
    clause: active.map((f) => f.sql).join(' AND '),
    params: active.reduce((acc, f) => acc.concat(f.params || []), []),
  };
}

function dimensionFragments(alias, dim, { branch, brand, costCenter, warehouse }) {
  return [
    branch && dim.branch_id ? { sql: `${alias}.branch_id = ?`, params: [branch] } : null,
    brand && dim.brand_id ? { sql: `${alias}.brand_id = ?`, params: [brand] } : null,
    costCenter && dim.cost_center_id ? { sql: `${alias}.cost_center_id = ?`, params: [costCenter] } : null,
    warehouse && dim.warehouse_id ? { sql: `${alias}.warehouse_id = ?`, params: [warehouse] } : null,
  ];
}

/**
 * @param {object} db - pool/connection exposing .query()
 * @param {object} opts
 * @param {string} [opts.from] - YYYY-MM-DD (gl_journals.journal_date is a DATE column — no
 *   UTC/Riyadh slicing ambiguity, comparisons are calendar-day exact regardless of session tz)
 * @param {string} [opts.to]
 * @param {string} [opts.branch]
 * @param {string} [opts.brand]
 * @param {string} [opts.costCenter]
 * @param {string} [opts.warehouse]
 * @param {boolean} [opts.includeZero]
 */
async function computeTrialBalance(db, opts) {
  const o = opts || {};
  const { from, to, branch, brand, costCenter, warehouse, includeZero } = o;

  if (from && to && String(from) > String(to)) {
    throw new TrialBalanceError('نطاق التاريخ غير صالح: from بعد to', 'TB_INVALID_RANGE');
  }

  const dim = await getDimCols(db);
  const dimFrag = (alias) => dimensionFragments(alias, dim, { branch, brand, costCenter, warehouse });

  // ── 1) Opening: reference_type='opening' entries (any date) ──
  const { clause: openClause1, params: openParams1 } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    { sql: "j.reference_type = 'opening'", params: [] },
    ...dimFrag('e'),
  ]);
  const [openRows1] = await db.query(
    `SELECT e.account_id, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE ${openClause1} GROUP BY e.account_id`,
    openParams1
  );
  const openingMap = {};
  openRows1.forEach((r) => { openingMap[r.account_id] = { d: Number(r.d), c: Number(r.c) }; });

  // ── plus non-opening entries strictly before `from` ──
  if (from) {
    const { clause: openClause2, params: openParams2 } = buildWhere([
      { sql: "j.status = 'posted'", params: [] },
      { sql: "j.reference_type != 'opening'", params: [] },
      { sql: 'j.journal_date < ?', params: [from] },
      ...dimFrag('e'),
    ]);
    const [openRows2] = await db.query(
      `SELECT e.account_id, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
       FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${openClause2} GROUP BY e.account_id`,
      openParams2
    );
    openRows2.forEach((r) => {
      if (!openingMap[r.account_id]) openingMap[r.account_id] = { d: 0, c: 0 };
      openingMap[r.account_id].d += Number(r.d);
      openingMap[r.account_id].c += Number(r.c);
    });
  }

  // ── 2) Period movement: non-opening entries within [from, to] ──
  const { clause: periodClause, params: periodParams } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    { sql: "j.reference_type != 'opening'", params: [] },
    from ? { sql: 'j.journal_date >= ?', params: [from] } : null,
    to ? { sql: 'j.journal_date <= ?', params: [to] } : null,
    ...dimFrag('e'),
  ]);
  const [periodRows] = await db.query(
    `SELECT e.account_id, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c, COUNT(*) n
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE ${periodClause} GROUP BY e.account_id`,
    periodParams
  );
  const periodMap = {};
  periodRows.forEach((r) => { periodMap[r.account_id] = { d: Number(r.d), c: Number(r.c), n: Number(r.n) }; });

  // ── 3) Accounts + tree ──
  const [accounts] = await db.query(
    `SELECT id, code, name_ar, type, parent_id, is_folder, is_active
     FROM gl_accounts WHERE is_active = 1 OR is_active IS NULL ORDER BY code`
  );
  const childrenOf = new Map();
  accounts.forEach((a) => {
    const pid = a.parent_id || null;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(a);
  });
  const hasChildren = (id) => (childrenOf.get(id) || []).length > 0;

  const rawFigures = new Map(); // own-only figures, never aggregated
  accounts.forEach((a) => {
    rawFigures.set(a.id, {
      openD: (openingMap[a.id] || {}).d || 0,
      openC: (openingMap[a.id] || {}).c || 0,
      periodD: (periodMap[a.id] || {}).d || 0,
      periodC: (periodMap[a.id] || {}).c || 0,
      rowCount: (periodMap[a.id] || {}).n || 0,
    });
  });

  // Aggregated (self + descendants) — DISPLAY rollup for folder rows only.
  const aggCache = new Map();
  function aggregate(id) {
    if (aggCache.has(id)) return aggCache.get(id);
    const self = rawFigures.get(id) || { openD: 0, openC: 0, periodD: 0, periodC: 0, rowCount: 0 };
    const agg = Object.assign({}, self);
    (childrenOf.get(id) || []).forEach((ch) => {
      const c = aggregate(ch.id);
      agg.openD += c.openD; agg.openC += c.openC;
      agg.periodD += c.periodD; agg.periodC += c.periodC;
      agg.rowCount += c.rowCount;
    });
    aggCache.set(id, agg);
    return agg;
  }

  const rows = accounts.map((a) => {
    const isPostingLeaf = !hasChildren(a.id); // structural leaf — the ONLY thing Grand Total trusts
    const figs = isPostingLeaf ? rawFigures.get(a.id) : aggregate(a.id);
    const openNet = figs.openD - figs.openC;
    const closeNet = openNet + figs.periodD - figs.periodC;
    const isDebitNormal = a.type === 'asset' || a.type === 'expense';

    let openDebit = 0, openCredit = 0, closeDebit = 0, closeCredit = 0;
    if (isDebitNormal) {
      if (openNet >= 0) openDebit = openNet; else openCredit = -openNet;
      if (closeNet >= 0) closeDebit = closeNet; else closeCredit = -closeNet;
    } else {
      if (openNet <= 0) openCredit = -openNet; else openDebit = openNet;
      if (closeNet <= 0) closeCredit = -closeNet; else closeDebit = closeNet;
    }
    const abnormalSign = isDebitNormal ? closeCredit > 0.01 : closeDebit > 0.01;

    return {
      accountId: a.id,
      code: a.code,
      nameAr: a.name_ar,
      type: a.type,
      parentId: a.parent_id || null,
      level: a.code ? String(a.code).length : 1,
      hasChildren: !isPostingLeaf,
      isFolder: !!a.is_folder,
      isPostingLeaf,
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
      // own (non-aggregated) raw activity — used only for diagnostics below,
      // never summed into totals directly from here.
      _ownHasActivity: figs.openD !== 0 || figs.openC !== 0 || figs.periodD !== 0 || figs.periodC !== 0,
    };
  });

  const filtered = includeZero
    ? rows
    : rows.filter((r) => r.opening !== 0 || r.periodDebit !== 0 || r.periodCredit !== 0 || r.closing !== 0);

  // ── Grand Total: posting leaves ONLY, unfiltered by includeZero — the
  // ledger's true total must never depend on a display filter. ──
  const leafRows = rows.filter((r) => r.isPostingLeaf);
  const totals = leafRows.reduce(
    (t, r) => ({
      opening: t.opening + r.opening,
      openDebit: t.openDebit + r.openDebit,
      openCredit: t.openCredit + r.openCredit,
      periodDebit: t.periodDebit + r.periodDebit,
      periodCredit: t.periodCredit + r.periodCredit,
      closing: t.closing + r.closing,
      closeDebit: t.closeDebit + r.closeDebit,
      closeCredit: t.closeCredit + r.closeCredit,
    }),
    { opening: 0, openDebit: 0, openCredit: 0, periodDebit: 0, periodCredit: 0, closing: 0, closeDebit: 0, closeCredit: 0 }
  );
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });
  totals.isOpeningBalanced = Math.abs(totals.openDebit - totals.openCredit) < 0.01;
  totals.isPeriodBalanced = Math.abs(totals.periodDebit - totals.periodCredit) < 0.01;
  totals.isClosingBalanced = Math.abs(totals.closeDebit - totals.closeCredit) < 0.01;
  totals.isBalanced = totals.isClosingBalanced; // backward-compat field name (routes/erp-core.js consumers)
  totals.abnormalCount = leafRows.filter((r) => r.abnormalSign).length;

  // ── Diagnostics: orphan/null/nonpostable activity is SHOWN, never
  // silently dropped from the response (even though it's excluded from
  // every balance column above by construction). ──
  const { clause: diagClause, params: diagParams } = buildWhere([
    { sql: "j.status = 'posted'", params: [] },
    from ? { sql: 'j.journal_date >= ?', params: [from] } : null,
    to ? { sql: 'j.journal_date <= ?', params: [to] } : null,
  ]);
  const [[nullAcc]] = await db.query(
    `SELECT COUNT(*) n, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_journals j ON e.journal_id = j.id
     WHERE e.account_id IS NULL AND ${diagClause}`,
    diagParams
  );
  const postingOnFolder = rows.filter((r) => r.isFolder && r.isPostingLeaf && r._ownHasActivity);
  const nonAggregatingParentsWithActivity = rows.filter((r) => !r.isFolder && r.hasChildren && r._ownHasActivity);

  const cleanRows = filtered.map((r) => {
    const { _ownHasActivity, ...rest } = r;
    return rest;
  });

  return {
    success: true,
    filters: {
      from: from || null,
      to: to || null,
      branch: branch || null,
      brand: brand || null,
      costCenter: costCenter || null,
      warehouse: warehouse || null,
      includeZero: !!includeZero,
    },
    rows: cleanRows,
    totals,
    diagnostics: {
      nullAccountEntries: Number(nullAcc.n) || 0,
      nullAccountDebit: round2(nullAcc.d),
      nullAccountCredit: round2(nullAcc.c),
      postingOnFolderAccounts: postingOnFolder.map((r) => ({ code: r.code, nameAr: r.nameAr })),
      nonAggregatingParentsWithActivity: nonAggregatingParentsWithActivity.map((r) => ({ code: r.code, nameAr: r.nameAr })),
      note:
        'هذه البنود مستبعدة من كل أعمدة الإجمالي أعلاه بالتصميم (منع الترحيل على Folder أو الازدواج) — ' +
        'ولا تُخفى هنا حتى تُسوَّى من Health Center.',
    },
  };
}

module.exports = { computeTrialBalance, getDimCols, resetDimColsCache, TrialBalanceError };
