/**
 * General Ledger HTTP adapter.
 *
 * All accounting rules, input bounds and cursor semantics live in the
 * canonical engine (`lib/reports/glLedger`).  Keeping this adapter thin makes
 * HTTP failures impossible to disguise as a successful empty report.
 */
'use strict';

const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');
const ledgerEngine = require('../../../lib/reports/glLedger');

function sendError(res, error, shape) {
  if (error instanceof ledgerEngine.GeneralLedgerError) {
    return res.status(error.status || 400).json(Object.assign({
      success: false,
      code: error.code,
      error: error.message,
    }, shape));
  }
  // Never return a financial-report failure as HTTP 200, and never expose the
  // database/SQL exception to the browser.  The complete exception remains in
  // the server log for operators.
  console.error('[general-ledger] unexpected error', error);
  return res.status(500).json(Object.assign({
    success: false,
    code: 'GL_INTERNAL_ERROR',
    error: 'تعذّر إنشاء دفتر الأستاذ بسبب خطأ داخلي في الخادم',
  }, shape));
}

router.get('/reports/gl-ledger-multi', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    return res.json(await ledgerEngine.getMultiLedger(db, req.query));
  } catch (error) {
    return sendError(res, error, {
      sections: [],
      grandTotals: { debit: 0, credit: 0, opening: 0, closing: 0, accountCount: 0, lineCount: 0 },
    });
  }
});

router.get('/gl/account-ledger/:accountId', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    return res.json(await ledgerEngine.getAccountLedger(db, req.params.accountId, req.query));
  } catch (error) {
    return sendError(res, error, { ledger: [] });
  }
});

module.exports = router;
