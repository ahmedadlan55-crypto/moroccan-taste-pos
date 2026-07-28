'use strict';
/*
 * routes/accounting.js — mounted at /api/accounting.
 * GET /accounts/search — searchable GL-account picker for every account field.
 * Server-side filter over code / name_ar / name_en / type. When postingOnly is
 * set (default for transaction contexts) it returns ONLY active POSTING LEAVES
 * — not a folder AND childless, the shared definition in lib/coa/tree.js — so
 * a header/parent account can never be selected. The usage context applies an
 * allow-list of account types on the SERVER, so the client can never post to
 * an arbitrary account code.
 */
const router = require('express').Router();
const db = require('../db/connection');
const coaTree = require('../lib/coa/tree');

// context → allowed account types (mirrors inventory-transactions ACCOUNT_USAGE).
const CONTEXT_TYPES = {
  receipt: ['revenue', 'equity', 'liability'],
  issue: ['expense'],
  waste: ['expense'],
  expense: ['expense'],
  adjustment: ['revenue', 'expense', 'equity'],
};

router.get('/accounts/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const context = String(req.query.context || '').trim();
    const accountType = String(req.query.accountType || '').trim().toLowerCase();
    // posting accounts only, unless a report/tree context explicitly opts out
    const postingOnly = req.query.postingOnly != null ? String(req.query.postingOnly) !== '0' : true;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const where = ['1=1']; const params = [];
    if (postingOnly) {
      // THE PICKER EVERY TRANSACTION SCREEN USES. It checked "has no children"
      // and nothing else, while the trial balance, the account-role registry
      // and the P&L / balance-sheet / cash-flow engines all require
      // `!is_folder AND !hasChildren`. So a CHILDLESS account someone marked as
      // a folder was selectable here and postable — and then the trial balance
      // refused to count it in the Grand Total, reported it as
      // `nonLeafPostingActivity`, and flipped `isClean` to false. The report
      // was right; this query was the one letting the bad posting in.
      //
      // One shared predicate now (lib/coa/tree.js POSTING_LEAF_SQL). Existing
      // history is untouched — this stops NEW bad postings; the repair for
      // rows already posted is /gl/accounts/:id/folder on the CoA health screen.
      where.push(coaTree.POSTING_LEAF_SQL('a'));
    }
    const allow = CONTEXT_TYPES[context];
    if (allow && allow.length) { where.push('a.type IN (' + allow.map(() => '?').join(',') + ')'); params.push(...allow); }
    if (accountType && ['asset', 'liability', 'equity', 'revenue', 'expense'].indexOf(accountType) !== -1) { where.push('a.type=?'); params.push(accountType); }
    if (q) { where.push('(a.code LIKE ? OR a.name_ar LIKE ? OR a.name_en LIKE ?)'); params.push(q + '%', '%' + q + '%', '%' + q + '%'); }

    const [rows] = await db.query(
      'SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.parent_id, a.is_active FROM gl_accounts a WHERE ' + where.join(' AND ') + ' ORDER BY ' + coaTree.ORDER_BY('a') + ' LIMIT ? OFFSET ?',
      params.concat([pageSize, offset]));
    const [cnt] = await db.query('SELECT COUNT(*) AS total FROM gl_accounts a WHERE ' + where.join(' AND '), params);
    res.json({
      data: rows.map((a) => ({ id: a.id, code: a.code, name: a.name_ar, nameEn: a.name_en, type: a.type, parentId: a.parent_id, active: a.is_active === 1 || a.is_active === true })),
      pagination: { page, pageSize, total: Number(cnt[0].total) || 0, totalPages: Math.max(1, Math.ceil((Number(cnt[0].total) || 0) / pageSize)) },
      filters: { q, context, accountType, postingOnly },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
