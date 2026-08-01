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
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/order-to-cash/http');
const SalesScope = require('../../lib/salesScope');
const Reporting = require('../../services/order-to-cash/O2CReportingService');

function _capFor(type) {
  if (type === 'data-quality') return 'o2c.data_quality';
  return 'ar_reports.view';
}

/**
 * The caller's branch scope, intersected with any `?branchId=` they sent, handed
 * to the reporting service as `params.scope`.
 *
 * READ THIS BEFORE TRUSTING IT. Every report aggregates INSIDE SQL
 * (services/order-to-cash/O2CReportingService.js), so a report cannot be scoped
 * from out here the way a row list can — there are no rows left to filter by the
 * time the router sees the result, only sums. Each of the thirteen report
 * queries needs `SalesScope.andBranchClause(params.scope, …)` appended to its own
 * WHERE (`branch_id` on ar_documents / customer_payments / sales_returns,
 * `d.branch_id` where ar_document_lines and sales join through ar_documents, and
 * an EXISTS over ar_documents for the two customer-keyed reports that carry no
 * branch column at all). That file is owned elsewhere; until it reads
 * `params.scope`, THESE REPORTS STILL AGGREGATE EVERY BRANCH. The scope is
 * threaded through now so that change is one helper call per query and nothing
 * here has to move.
 */
async function _scopedParams(req) {
  const scope = await SalesScope.effectiveScope(db, req);
  // customer-statement is the one report the router CAN guard: it is keyed by a
  // customer rather than aggregated over a period, so we can refuse a customer
  // who has never traded in a branch the caller may see. 404, not 403 — a 403
  // would confirm the customer exists. The statement's own figures stay
  // company-wide on purpose (see assertCustomerInScope).
  if (req.params.type === 'customer-statement') {
    await SalesScope.assertCustomerInScope(db, scope, req.query.customerId, 'العميل غير موجود');
  }
  return Object.assign({}, req.query, { scope });
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
    const rep = await Reporting.run(req.params.type, await _scopedParams(req));
    return H.sendData(res, rep.rows, { columns: rep.columns, totals: rep.totals, asOf: rep.asOf });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:type/export', requireCapability('o2c.export'), async (req, res) => {
  try {
    // The export runs the same scoped params as the JSON report — an export that
    // took a different path would be the obvious way around whatever the screen
    // enforces.
    const rep = await Reporting.run(req.params.type, await _scopedParams(req));
    const fname = `o2c-${req.params.type}-${new Date().toISOString().slice(0, 10)}.csv`;
    return H.sendCsv(res, fname, rep.rows, rep.columns);
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
