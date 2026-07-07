/**
 * routes/order-to-cash/reports.js — read-only O2C reports.
 *   GET /reports            → list available report types
 *   GET /reports/:type      → run a report (JSON: columns, rows, totals)
 *   GET /reports/:type/export → same report as CSV (BOM + injection guard + cap)
 * data-quality requires o2c.data_quality; everything else ar_reports.view.
 */
'use strict';

const express = require('express');
const router = express.Router();
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const Reporting = require('../../services/order-to-cash/O2CReportingService');

function _capFor(type) {
  if (type === 'data-quality') return 'o2c.data_quality';
  return 'ar_reports.view';
}

router.get('/', requireCapability('ar_reports.view'), (req, res) => {
  return H.sendData(res, Reporting.REPORTS.map((t) => ({ type: t })));
});

async function _guard(req, res, next) {
  const cap = _capFor(req.params.type);
  return requireCapability(cap)(req, res, next);
}

router.get('/:type', _guard, async (req, res) => {
  try {
    const rep = await Reporting.run(req.params.type, req.query);
    return H.sendData(res, rep.rows, { columns: rep.columns, totals: rep.totals, asOf: rep.asOf });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:type/export', requireCapability('o2c.export'), async (req, res) => {
  try {
    const rep = await Reporting.run(req.params.type, req.query);
    const fname = `o2c-${req.params.type}-${new Date().toISOString().slice(0, 10)}.csv`;
    return H.sendCsv(res, fname, rep.rows, rep.columns);
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
