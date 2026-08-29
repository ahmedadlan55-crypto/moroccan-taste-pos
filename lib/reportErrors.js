/**
 * One error contract for every report endpoint.
 *
 * ─── THE DEFECT THIS EXISTS TO END ──────────────────────────────────────────
 * A report handler used to answer a database fault like this:
 *
 *     } catch (e) {
 *       res.json({ revenue: [], totalRevenue: 0, netIncome: 0, degraded: true });
 *     }
 *
 * `res.json` with no `res.status` is **HTTP 200**. So a broken query does not
 * fail — it reports that the company earned nothing, owns nothing, and is owed
 * nothing. Every layer downstream agrees: the browser sees 200, react-query
 * caches it as data, the screen renders, and the numbers print onto paper that
 * someone signs. Nothing anywhere says the figure is not a figure.
 *
 * The `degraded: true` flag does not save it. A flag only works if every reader
 * checks it, and no reader was required to. An all-zero balance sheet lived on
 * main undetected for exactly this reason: the endpoint never failed.
 *
 * ─── THE CONTRACT ───────────────────────────────────────────────────────────
 *   1. A coded 4xx the handler raised deliberately passes through with its own
 *      message — those are answers, not faults.
 *   2. EVERYTHING else is a sanitized 500. Never a 200. Never a zero-filled
 *      body. There is no third option and no opt-out.
 *   3. The response carries `correlationId` so a user can quote one string and
 *      support can find the stack. It is `req.requestId` — the SAME id already
 *      on the `X-Request-Id` response header and in the structured logs, so
 *      one incident has one identity instead of three.
 *   4. `e.message` NEVER reaches the client. A driver error leaks table names,
 *      column names and fragments of SQL to whoever opened the page.
 *
 * Lifted from `routes/analytics/exports.js`, which has enforced exactly this
 * ("NEVER success:false with a 200") since the analytics hub shipped. This file
 * is that rule made reusable, not a new invention.
 */
'use strict';

const crypto = require('crypto');

// Deliberate, coded client errors. A handler throws one of these to say
// something true about the REQUEST; anything else is a fault in the SERVER and
// must not be dressed up as an answer.
const KNOWN_HTTP = new Set([400, 403, 404, 409, 413, 422, 429]);

/** The one message a client is allowed to see for an internal fault. */
const GENERIC_AR = 'تعذّر إنتاج التقرير. أعد المحاولة، وإن استمرّت المشكلة زوّد الدعم برقم المرجع.';

/**
 * Build a coded client error for `throw`.
 * `httpError(422, 'RANGE_REQUIRED', 'from + to مطلوبان')`
 */
function httpError(http, code, message) {
  const error = new Error(message || code);
  error.http = Number(http);
  error.code = String(code);
  error.expose = true;
  return error;
}

/**
 * The correlation id for this request.
 *
 * Prefers `req.requestId` (set by the server's request-id middleware and echoed
 * on `X-Request-Id`) so the id the user reads on screen is the id in the log.
 * Falls back to a fresh one only when this is called outside that middleware —
 * a test harness, or a router mounted before it.
 */
function correlationId(req) {
  const existing = req && req.requestId;
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return 'RPT-' + crypto.randomBytes(6).toString('hex');
}

/**
 * Answer a failed report request.
 *
 * @param {object} res    express response
 * @param {Error}  error  the thrown value
 * @param {string} where  log tag, e.g. 'erp/reports/income'
 * @param {object} req    express request (for the correlation id)
 */
function sendReportError(res, error, where, req) {
  const http = Number(error && error.http);
  if (error && error.code && KNOWN_HTTP.has(http)) {
    return res.status(http).json({
      success: false,
      code: String(error.code),
      error: String(error.message || error.code),
    });
  }

  const id = correlationId(req);
  // Log the WHOLE thing, always. The client gets a reference; the server keeps
  // the evidence. Losing the stack here is how the original defect stayed
  // invisible — it was caught, zeroed, and never written down.
  console.error('[' + where + '][' + id + ']', (error && error.stack) || error);

  return res.status(500).json({
    success: false,
    code: 'REPORT_FAILED',
    error: GENERIC_AR,
    correlationId: id,
  });
}

/** `if (!from || !to) return badRequest(res, 'RANGE_REQUIRED', '…')` */
function badRequest(res, code, message) {
  return res.status(422).json({
    success: false,
    code: String(code),
    error: String(message || code),
  });
}

module.exports = {
  KNOWN_HTTP,
  GENERIC_AR,
  httpError,
  correlationId,
  sendReportError,
  badRequest,
};
