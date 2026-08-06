// ═══════════════════════════════════════════════════════════════════
// /api/erp/reports/equity-changes — قائمة التغيرات في حقوق الملكية
// (IAS 1 Statement of Changes in Equity)
//
// GET /reports/equity-changes?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// This report never had a backend. The legacy screen synthesized it
// client-side by summing 3-digit code prefixes ('31'/'32') that no
// longer match the live chart of accounts — so it showed zeros against
// a real ledger. This endpoint builds the statement from posted
// gl_entries, per LEAF equity account:
//
//   opening  = Σ posted entries dated BEFORE ?from
//   movement = period debits/credits between from..to
//   closing  = opening + movement
//
// RECONCILIATION CONTRACT — the one invariant that makes this statement
// trustworthy: totals.closing (equity accounts + accumulated income,
// folded exactly the way balance-sheet-ifrs folds it) MUST equal the
// `totEq` of GET /reports/balance-sheet-ifrs?asOfDate=<to>. To make
// that hold by construction instead of by hope, this file REUSES the
// balance-sheet module's exports (leaf predicate, bucket classifier,
// contra set) and computes `reconciliation.bsTotEq` by dispatching the
// actual balance-sheet-ifrs route in-process — the same code path an
// HTTP caller hits, so there is nothing to drift.
//
// Sign convention (mirrors balance-sheet.js :791-804 exactly):
//   equity magnitude = -(debit - credit)   (credit-normal positive)
//   contra buckets (drawings — see CONTRA_GROUP_KEYS) get the same
//   pushToGroup() flip the balance sheet applies: signed = -magnitude.
//
// Net income handling:
//   • netIncomeLine    — revenue (credit−debit) minus expense
//     (debit−credit) over posted entries in from..to EXCLUDING
//     journals flagged is_closing_entry=1.
//   • closingEntriesLine — the same measure over ONLY is_closing_entry
//     journals in the period, as its own identified row. A period close
//     moves income into retained earnings (Dr revenue / Cr retained);
//     showing its revenue/expense side separately is what lets the
//     retained bucket's jump reconcile instead of double-counting.
//   • netIncomeLine.openingAccumulated — accumulated un-closed income
//     BEFORE ?from (all journals, closing entries included). It is part
//     of opening equity exactly as balance-sheet-ifrs would report it
//     at from−1, and carries into totals.closing.
//
// Honest errors: any DB failure → 500 + console.error. No `||0` chains
// invent balances — every figure is a sum over recorded entries.
// ═══════════════════════════════════════════════════════════════════
'use strict';
const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const coaTree = require('../../../lib/coa/tree');
const classify = require('../../../lib/coa/classify');
const bs = require('./balance-sheet'); // router + shared helpers (exports)

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The same equity buckets, labels and IFRS order balance-sheet-ifrs uses
// (IFRS_SUBGROUP_ORDER.equity + the makeGroup labels).
const EQUITY_BUCKETS = [
  { key: 'capital',  label: 'رأس المال',              isContra: false },
  { key: 'retained', label: 'الأرباح المحتجزة',        isContra: false },
  { key: 'drawings', label: 'المسحوبات',               isContra: true  },
  { key: 'reserves', label: 'الاحتياطيات',             isContra: false }
];

// Dispatch the REAL /reports/balance-sheet-ifrs handler in-process and
// resolve with its JSON body. This is deliberate reuse-not-reimplement:
// the reconciliation figure comes from the exact code path an HTTP
// caller would hit.
//
// `user` MUST be forwarded. The balance-sheet route is itself wrapped in
// requireCapability('finance.reports.view'), which rejects with 401 when
// `req.user` is absent — so a synthetic request without it made this whole
// endpoint answer 500 with "تعذّر احتساب مرجع المطابقة". This is not a way
// round the guard: the caller below has ALREADY passed the very same
// capability, so what is forwarded is an identity that was authorized a
// moment earlier for exactly this data.
function fetchBalanceSheetIfrs(asOfDate, user) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url: '/reports/balance-sheet-ifrs',
      originalUrl: '/reports/balance-sheet-ifrs',
      baseUrl: '',
      query: { asOfDate },
      params: {},
      headers: {},
      user,
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve(body); }
    };
    try {
      bs(req, res, (err) => reject(err || new Error('balance-sheet-ifrs route did not answer')));
    } catch (err) { reject(err); }
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/reports/equity-changes', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to || !DATE_RE.test(String(from)) || !DATE_RE.test(String(to))) {
      return res.status(400).json({ success: false, error: 'المطلوب from و to بصيغة YYYY-MM-DD' });
    }
    if (String(to) < String(from)) {
      return res.status(400).json({ success: false, error: 'نهاية الفترة قبل بدايتها' });
    }

    const LEAF = bs.LEAF_ACCOUNT_WHERE;

    // ── 1) Per LEAF equity account: opening split + period movement ──
    const [accRows] = await db.query(
      // PACKAGE G — project type + the stored classification columns so the
      // shared classifier can report provenance instead of guessing silently.
      `SELECT a.id, a.code, a.name_ar, a.name_en, a.report_section, a.type,
              a.normal_balance, a.is_contra, a.status,
              COALESCE(SUM(CASE WHEN DATE(j.journal_date) <  ? THEN e.debit  ELSE 0 END), 0) AS open_d,
              COALESCE(SUM(CASE WHEN DATE(j.journal_date) <  ? THEN e.credit ELSE 0 END), 0) AS open_c,
              COALESCE(SUM(CASE WHEN DATE(j.journal_date) >= ? THEN e.debit  ELSE 0 END), 0) AS per_d,
              COALESCE(SUM(CASE WHEN DATE(j.journal_date) >= ? THEN e.credit ELSE 0 END), 0) AS per_c
         FROM gl_accounts a
         JOIN gl_entries e  ON e.account_id = a.id
         JOIN gl_journals j ON j.id = e.journal_id
        WHERE j.status = 'posted' AND DATE(j.journal_date) <= ?
          AND a.type = 'equity'
          AND ${LEAF}
        GROUP BY a.id, a.code, a.name_ar, a.name_en, a.report_section, a.type,
                 a.normal_balance, a.is_contra, a.status
        ORDER BY ${coaTree.ORDER_BY('a')}`,
      [from, from, from, from, to]
    );

    // ── 2) Period net income — posted revenue/expense, EXCLUDING closing entries ──
    const [[ni]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN a.type = 'revenue' THEN e.credit - e.debit ELSE 0 END), 0) AS rev,
              COALESCE(SUM(CASE WHEN a.type = 'expense' THEN e.debit - e.credit ELSE 0 END), 0) AS exp
         FROM gl_entries e
         JOIN gl_journals j ON j.id = e.journal_id
         JOIN gl_accounts a ON a.id = e.account_id
        WHERE j.status = 'posted'
          AND DATE(j.journal_date) >= ? AND DATE(j.journal_date) <= ?
          AND COALESCE(j.is_closing_entry, 0) = 0
          AND a.type IN ('revenue','expense')
          AND ${LEAF}`,
      [from, to]
    );

    // ── 3) Closing-entry effects on income accounts inside the period ──
    const [[ce]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN a.type = 'revenue' THEN e.credit - e.debit ELSE 0 END), 0) AS rev,
              COALESCE(SUM(CASE WHEN a.type = 'expense' THEN e.debit - e.credit ELSE 0 END), 0) AS exp,
              COUNT(DISTINCT j.id) AS jcount
         FROM gl_entries e
         JOIN gl_journals j ON j.id = e.journal_id
         JOIN gl_accounts a ON a.id = e.account_id
        WHERE j.status = 'posted'
          AND DATE(j.journal_date) >= ? AND DATE(j.journal_date) <= ?
          AND j.is_closing_entry = 1
          AND a.type IN ('revenue','expense')
          AND ${LEAF}`,
      [from, to]
    );

    // ── 4) Accumulated un-closed income BEFORE the period (all journals,
    //       closing entries included — a closed year nets to zero here,
    //       its income already sits inside retained earnings above). ──
    const [[pre]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN a.type = 'revenue' THEN e.credit - e.debit ELSE 0 END), 0) AS rev,
              COALESCE(SUM(CASE WHEN a.type = 'expense' THEN e.debit - e.credit ELSE 0 END), 0) AS exp
         FROM gl_entries e
         JOIN gl_journals j ON j.id = e.journal_id
         JOIN gl_accounts a ON a.id = e.account_id
        WHERE j.status = 'posted' AND DATE(j.journal_date) < ?
          AND a.type IN ('revenue','expense')
          AND ${LEAF}`,
      [from]
    );

    // ── Bucketize with the balance sheet's OWN classifier + contra flip ──
    // PACKAGE G — accounts whose bucket came from the code prefix rather than
    // from a stored report_section. Reported, never hidden.
    const unmapped = [];
    const byKey = {};
    const buckets = EQUITY_BUCKETS.map(b => {
      const bucket = { key: b.key, label: b.label, isContra: b.isContra, accounts: [], opening: 0, closing: 0 };
      byKey[b.key] = bucket;
      return bucket;
    });

    for (const a of accRows) {
      const openD = Number(a.open_d), openC = Number(a.open_c);
      const perD  = Number(a.per_d),  perC  = Number(a.per_c);
      // Skip pure-zero rows (no opening, no movement) — same effect as the
      // balance sheet's zero-balance filter: they contribute nothing.
      const openMag  = -(openD - openC);                       // equity magnitude = -(debit-credit)
      const closeMag = -((openD + perD) - (openC + perC));
      if (perD === 0 && perC === 0 && Math.abs(openMag) < 0.001 && Math.abs(closeMag) < 0.001) continue;

      // EXACT mirror of balance-sheet-ifrs: report_section first, code
      // prefix fallback; the pushToGroup() flip applies when the target
      // group is contra (equity → only 'drawings').
      const stored = bs.classifyByReportSection(a.report_section);
      if (!stored) unmapped.push(classify.unmappedRow(a, classify.sectionOf(a)));
      const cls = stored || bs.classifyEquity(a.code);
      const isContra = bs.CONTRA_GROUP_KEYS.has(cls[1]);
      // A mis-sectioned equity account (report_section pointing at an
      // asset/liability bucket) still counts toward totEq on the balance
      // sheet; for PRESENTATION we place it where its code says it belongs.
      const bucketKey = cls[0] === 'equity' ? cls[1] : bs.classifyEquity(a.code)[1];
      const bucket = byKey[bucketKey] || byKey.capital;

      const opening = isContra ? -openMag : openMag;
      const closing = isContra ? -closeMag : closeMag;
      bucket.accounts.push({
        id: a.id,
        code: a.code,
        name: a.name_ar || a.name_en || '',
        opening: r2(opening),
        periodDebit: r2(perD),
        periodCredit: r2(perC),
        closing: r2(closing)
      });
      bucket.opening += opening;
      bucket.closing += closing;
    }

    let accountsOpening = 0, accountsClosing = 0;
    buckets.forEach(b => {
      accountsOpening += b.opening;
      accountsClosing += b.closing;
      b.opening = r2(b.opening);
      b.closing = r2(b.closing);
    });

    const periodNet   = Number(ni.rev) - Number(ni.exp);
    const closingNet  = Number(ce.rev) - Number(ce.exp);
    const preNet      = Number(pre.rev) - Number(pre.exp);

    const netIncomeLine = {
      key: 'netIncome',
      label: periodNet >= 0 ? 'صافي ربح الفترة (قبل قيود الإغلاق)' : 'صافي خسارة الفترة (قبل قيود الإغلاق)',
      revenue: r2(ni.rev),
      expense: r2(ni.exp),
      netIncome: r2(periodNet),
      // Accumulated un-closed income carried INTO the period — part of
      // opening equity exactly as balance-sheet-ifrs reports it.
      openingAccumulated: r2(preNet)
    };
    const closingEntriesLine = {
      key: 'closingEntries',
      label: 'أثر قيود الإغلاق على حسابات النتيجة خلال الفترة',
      revenueEffect: r2(ce.rev),
      expenseEffect: r2(ce.exp),
      netEffect: r2(closingNet),
      journalCount: Number(ce.jcount) || 0
    };

    const totalOpening = accountsOpening + preNet;
    const totalClosing = accountsClosing + preNet + periodNet + closingNet;

    // ── Reconciliation: the actual balance-sheet-ifrs route, in-process ──
    const bsBody = await fetchBalanceSheetIfrs(to, req.user);
    // The bs handler's catch answers a zeroed shape WITHOUT asOfDate (and now
    // WITH degraded:true) — a zeroed ledger is not a reconciliation target, it
    // is a failure.
    if (!bsBody || !('asOfDate' in bsBody) || bsBody.degraded) {
      console.error('[erp/reports/equity-changes] balance-sheet-ifrs reconciliation source failed');
      return res.status(500).json({ success: false, error: 'تعذّر احتساب مرجع المطابقة (قائمة المركز المالي)' });
    }
    const bsTotEq = Number(bsBody.totEq) || 0;

    res.json({
      success: true,
      from,
      to,
      buckets,
      netIncomeLine,
      closingEntriesLine,
      totals: {
        opening: r2(totalOpening),
        closing: r2(totalClosing)
      },
      reconciliation: {
        bsTotEq: r2(bsTotEq),
        matches: Math.abs(totalClosing - bsTotEq) < 0.01
      },
      // PACKAGE G — equity accounts bucketed from a code-prefix guess.
      unmapped
    });
  } catch (e) {
    console.error('[erp/reports/equity-changes] failed:', e && (e.code || e.message));
    res.status(500).json({ success: false, error: 'تعذّر توليد قائمة التغيرات في حقوق الملكية' });
  }
});

module.exports = router;
