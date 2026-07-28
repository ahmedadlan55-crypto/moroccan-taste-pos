// ═══════════════════════════════════════════════════════════════════
// /api/erp/reports/gl-ledger-multi — دفتر الأستاذ المتعدد (Daftra-style)
// /api/erp/gl/account-ledger/:accountId — دفتر أستاذ حساب واحد
//
// gl-ledger-multi returns one section per account with: opening + lines
// + total. Filters: from, to, accType (main/sub/both), parent, addedBy,
// scope (all/active/leaf).
//
// account-ledger returns a single account's full ledger including
// running balance, opening, totals, and per-line journal metadata.
// Filters: startDate, endDate, status, includeDraft.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const coaTree = require('../../../lib/coa/tree');

router.get('/reports/gl-ledger-multi', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { from, to, parent, accounts, addedBy, scope, accType } = req.query;

    // v6.29.0 — multi-account selection. The GL-ledger filter now lets the
    // operator pick several specific accounts (comma-separated ids) and view
    // them side-by-side. When `accounts` is provided it takes precedence over
    // the single `parent` filter + scope/type filters, and renders EXACTLY
    // the chosen accounts — including ones with no movement in the period.
    const acctSet = new Set(
      String(accounts || '').split(',').map(s => s.trim()).filter(Boolean)
    );

    // Status filter — posted + approved by default
    const statusClause = "j.status IN ('posted','approved')";

    // 1) Load all active accounts (with parent_id)
    // `is_folder` is selected because the leaf test below needs it — checking
    // children alone classified a childless folder as a postable leaf here
    // while every other engine rolled it up. Canonical display order too, so
    // the ledger and the chart-of-accounts screen list accounts identically.
    const [accts] = await db.query(
      `SELECT id, code, name_ar, type, parent_id, is_folder, display_order
       FROM gl_accounts a WHERE is_active = 1 OR is_active IS NULL
       ORDER BY ${coaTree.ORDER_BY('a')}`);

    // 2) Compute opening balance for each account (entries before 'from')
    const openingMap = {};
    if (from) {
      const [openRows] = await db.query(
        `SELECT e.account_id,
                COALESCE(SUM(e.debit),0)  AS d,
                COALESCE(SUM(e.credit),0) AS c
         FROM gl_entries e
         JOIN gl_journals j ON e.journal_id = j.id
         WHERE j.journal_date < ? AND ${statusClause}
         GROUP BY e.account_id`,
        [from]);
      openRows.forEach(r => { openingMap[r.account_id] = Number(r.d) - Number(r.c); });
    }

    // 3) Load all entries within the date range with journal info
    let entSql =
      `SELECT e.id, e.journal_id, e.account_id, e.debit, e.credit, e.description AS entry_desc,
              j.journal_number, j.journal_date, j.description AS journal_desc,
              j.reference_type, j.reference_id, j.created_by
       FROM gl_entries e
       JOIN gl_journals j ON e.journal_id = j.id
       WHERE ${statusClause}`;
    const params = [];
    if (from) { entSql += ' AND j.journal_date >= ?'; params.push(from); }
    if (to)   { entSql += ' AND j.journal_date <= ?'; params.push(to); }
    if (addedBy) { entSql += ' AND j.created_by = ?'; params.push(addedBy); }
    entSql += ' ORDER BY e.account_id, j.journal_date ASC, j.created_at ASC, e.id ASC';
    const [entries] = await db.query(entSql, params);

    // Group entries by account_id
    const linesByAccount = {};
    entries.forEach(r => {
      if (!linesByAccount[r.account_id]) linesByAccount[r.account_id] = [];
      linesByAccount[r.account_id].push({
        id: r.id,
        journalId: r.journal_id,
        journalNumber: r.journal_number || '',
        date: r.journal_date,
        addedBy: r.created_by || '',
        description: r.entry_desc || r.journal_desc || '',
        referenceType: r.reference_type || '',
        referenceId: r.reference_id || '',
        debit: Number(r.debit) || 0,
        credit: Number(r.credit) || 0
      });
    });

    // 4) Build sections per account (only those with movement OR with opening)
    const childrenSet = new Set();
    accts.forEach(a => { if (a.parent_id) childrenSet.add(a.parent_id); });
    const isMain = (a) => !a.parent_id;
    // AND-based, matching lib/coa/tree.js and the trial balance: a childless
    // account someone flagged as a folder is NOT a posting leaf. Checking
    // children alone made this report treat such an account as postable while
    // every other engine rolled it up — two screens, two answers.
    const isLeaf = (a) => !Number(a.is_folder) && !childrenSet.has(a.id);

    const sections = [];
    accts.forEach(a => {
      const lines = linesByAccount[a.id] || [];
      const opening = Number(openingMap[a.id] || 0);
      // v6.29.0 — explicit multi-account selection wins over every other
      // filter: show exactly the chosen accounts (even empty ones) so the
      // operator can compare two accounts side-by-side regardless of scope.
      const picked = acctSet.size && acctSet.has(String(a.id));
      if (acctSet.size && !picked) return;
      if (!picked) {
        // Apply scope filter
        if (scope === 'active' && lines.length === 0 && Math.abs(opening) < 0.005) return;
        if (scope === 'leaf'   && !isLeaf(a)) return;
        // Apply account type filter
        if (accType === 'main' && !isMain(a)) return;
        if (accType === 'sub'  &&  isMain(a)) return;
        // Apply parent filter (legacy single-parent, kept for back-compat)
        if (parent && a.parent_id !== parent && a.id !== parent) return;
        // Skip empty accounts unless 'all' scope (which is the default)
        if (!scope || scope === 'all') {
          if (lines.length === 0 && Math.abs(opening) < 0.005) return;
        }
      }

      // Compute running balance + totals
      let bal = opening;
      let totalD = 0, totalC = 0;
      const decoratedLines = lines.map(l => {
        bal += (l.debit - l.credit);
        totalD += l.debit;
        totalC += l.credit;
        return Object.assign({}, l, { runningBalance: Math.round(bal*100)/100 });
      });

      sections.push({
        accountId: a.id,
        code: a.code,
        nameAr: a.name_ar,
        type: a.type,
        parentId: a.parent_id || null,
        opening: Math.round(opening * 100) / 100,
        openingDebit:  opening > 0 ?  opening : 0,
        openingCredit: opening < 0 ? -opening : 0,
        totalDebit:    Math.round(totalD * 100) / 100,
        totalCredit:   Math.round(totalC * 100) / 100,
        closingBalance: Math.round((opening + totalD - totalC) * 100) / 100,
        lineCount: decoratedLines.length,
        lines: decoratedLines
      });
    });

    res.json({
      success: true,
      filters: { from: from || null, to: to || null, parent: parent || null, accounts: acctSet.size ? Array.from(acctSet) : null, addedBy: addedBy || null, scope: scope || 'all', accType: accType || 'both' },
      sections,
      grandTotals: sections.reduce((g, s) => ({
        debit:   g.debit   + s.totalDebit,
        credit:  g.credit  + s.totalCredit,
        opening: g.opening + s.opening,
        closing: g.closing + s.closingBalance,
        accountCount: g.accountCount + 1,
        lineCount: g.lineCount + s.lineCount
      }), { debit:0, credit:0, opening:0, closing:0, accountCount:0, lineCount:0 })
    });
  } catch (e) {
    console.error('gl-ledger-multi error:', e);
    res.json({ success: false, error: e.message, sections: [] });
  }
});

router.get('/gl/account-ledger/:accountId', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const accId = req.params.accountId;
    const { startDate, endDate, status, includeDraft } = req.query;

    const [accRows] = await db.query('SELECT * FROM gl_accounts WHERE id = ?', [accId]);
    const acc = accRows.length ? accRows[0] : null;
    if (!acc) return res.json({ success: false, ledger: [], error: 'الحساب غير موجود' });
    const accCode = acc.code || '';
    const accType = acc.type || '';

    // Status filter: by default include posted + approved (active accounting entries)
    const statusClause = (status && status !== 'all')
      ? 'AND j.status = ?'
      : (includeDraft === '1' ? '' : "AND j.status IN ('posted','approved')");
    const statusParams = (status && status !== 'all') ? [status] : [];

    // 1) Opening balance — sum of all entries strictly BEFORE startDate
    let opening = 0;
    if (startDate) {
      const [openRows] = await db.query(
        `SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
         FROM gl_entries e
         JOIN gl_journals j ON e.journal_id = j.id
         WHERE (e.account_id = ? OR (e.account_code = ? AND e.account_code != ''))
           AND j.journal_date < ? ${statusClause}`,
        [accId, accCode, startDate, ...statusParams]
      );
      opening = Number(openRows[0].d || 0) - Number(openRows[0].c || 0);
    }

    // 2) Entries within the date range
    let sql =
      `SELECT e.id, e.journal_id, e.account_id, e.account_code, e.debit, e.credit, e.description,
              j.journal_number, j.journal_date, j.description AS journal_desc, j.status,
              j.reference_type, j.reference_id, j.created_by, j.created_at
       FROM gl_entries e
       JOIN gl_journals j ON e.journal_id = j.id
       WHERE (e.account_id = ? OR (e.account_code = ? AND e.account_code != ''))
         ${statusClause}`;
    const params = [accId, accCode, ...statusParams];
    if (startDate) { sql += ' AND j.journal_date >= ?'; params.push(startDate); }
    if (endDate)   { sql += ' AND j.journal_date <= ?'; params.push(endDate); }
    sql += ' ORDER BY j.journal_date ASC, j.created_at ASC, e.id ASC';

    const [rows] = await db.query(sql, params);

    let runningBal = opening;
    let totalDebit = 0, totalCredit = 0;
    const ledger = rows.map(r => {
      const d = Number(r.debit) || 0;
      const c = Number(r.credit) || 0;
      runningBal += (d - c);
      totalDebit += d; totalCredit += c;
      return {
        id: r.id, journalId: r.journal_id, journalNumber: r.journal_number,
        journalDate: r.journal_date, journalDesc: r.journal_desc || '',
        entryDesc: r.description || '', referenceType: r.reference_type || '',
        referenceId: r.reference_id || '',
        status: r.status, createdBy: r.created_by || '',
        debit: d, credit: c, balance: runningBal
      };
    });

    res.json({
      success: true,
      account: {
        id: acc.id, code: accCode, nameAr: acc.name_ar, nameEn: acc.name_en || '',
        type: accType, level: acc.level || 0, parentId: acc.parent_id || ''
      },
      accountName: acc.name_ar, accountCode: accCode,
      period: { startDate: startDate || null, endDate: endDate || null },
      opening,
      totals: { debit: totalDebit, credit: totalCredit, net: totalDebit - totalCredit, count: ledger.length },
      closing: runningBal,
      ledger
    });
  } catch (e) { res.json({ success: false, ledger: [], error: e.message }); }
});

module.exports = router;
