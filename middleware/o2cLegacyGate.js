/**
 * middleware/o2cLegacyGate.js
 *
 * When ORDER_TO_CASH_ENABLE is ON, the unified /api/order-to-cash module owns the
 * AR source of truth (ar_documents), customer collections, and returns. These
 * guards block the LEGACY *duplicate* write paths so no legacy endpoint can create
 * a detached receipt or destroy a sale's GL in parallel:
 *
 *   customerReceiptGate → /api/cash customer-directed receipts (source_type='customer')
 *   saleReverseGate     → legacy sale VOID / RETURN / DELETE / bulk-delete (GL-destroying)
 *
 * The former legacyArGate guarded /api/ar-invoices; that route was deleted, so the
 * second invoice source no longer exists to gate.
 *
 * POS sale CREATION (POST /api/sales) is NOT gated — POS remains the financial
 * writer; only its destructive reverse/return/delete paths move to O2C (a proper
 * append-only credit note). Reads (GET/HEAD/OPTIONS) always pass so legacy screens
 * keep working. Reverting ORDER_TO_CASH_ENABLE=0 removes every guard untouched.
 */
'use strict';

const ENABLED = /^(1|true|on|yes)$/i.test(String(process.env.ORDER_TO_CASH_ENABLE || '').trim());

/**
 * Where a blocked reversal actually has to go now.
 *
 * Callers still pass the pre-cutover '/sales' (server.js mounts
 * saleReverseGate('/sales')). That path no longer reaches a returns screen: the
 * standalone Sales SPA was retired, and server.js 302s /sales/* to the read-only
 * invoices ledger. So a cashier told "this moved" landed on a screen with no way
 * to reverse anything, which reads as a dead end.
 *
 * The gate is the thing that knows *why* the request was refused, so it is also
 * the right place to know where the operation now lives. A caller may still pass
 * an explicit destination; the retired value is healed to the real one.
 */
const RETURNS_ROUTE = '/app/sales/returns';
const RETIRED_REDIRECTS = new Set(['/sales', '/sales/invoices', '']);

function _dest(redirect) {
  const r = String(redirect || '').trim();
  return RETIRED_REDIRECTS.has(r) ? RETURNS_ROUTE : r;
}

function _blocked(res, redirect) {
  return res.status(409).json({
    success: false,
    code: 'O2C_MODULE_ACTIVE',
    error: 'انتقلت هذه العملية إلى وحدة «المبيعات والعملاء» — استخدم تدفق المرتجعات لإصدار إشعار دائن.',
    redirect: _dest(redirect),
  });
}
function _isRead(req) { return /^(GET|HEAD|OPTIONS)$/.test(req.method); }

/** Block customer-directed cash receipts; let other treasury (boxes/banks/transfers/misc) pass. */
function customerReceiptGate(redirect) {
  return function (req, res, next) {
    if (!ENABLED || _isRead(req)) return next();
    const p = String(req.path || '');
    const isReceiptCreate = /^\/receipts\/?$/.test(p);
    const src = String((req.body && (req.body.source_type || req.body.sourceType)) || '');
    const hasCustomer = !!(req.body && (req.body.customer_id || req.body.customerId));
    if (isReceiptCreate && (src === 'customer' || hasCustomer)) return _blocked(res, redirect);
    return next();
  };
}

/** Block destructive legacy sale ops (void/return/delete/bulk-delete); POS create passes. */
function saleReverseGate(redirect) {
  return function (req, res, next) {
    if (!ENABLED || _isRead(req)) return next();
    const p = String(req.path || '');
    if (req.method === 'DELETE') return _blocked(res, redirect);                 // DELETE /:orderId
    if (req.method === 'POST' && /(\/void|\/return|\/refund|\/reverse|bulk-delete)/i.test(p)) return _blocked(res, redirect);
    return next();                                                                // POST / (create) + everything else passes
  };
}

/**
 * Credit-sale gate for POS create (POST /api/sales). When ON, a sale whose
 * payment resolves to on-account (credit / kita / ar, or a structured
 * customer_credit split portion) MUST pass the server credit policy before the
 * sale is written — enforced here at the boundary so the strong POS router stays
 * untouched. A cash/card sale is unaffected. Rejections use the O2C error body.
 */
function _creditPortion(body) {
  if (!body) return 0;
  // structured payments (preferred): [{ method:'customer_credit'|'credit', amount }]
  // Latin tokens are matched EXACTLY — an unanchored /ar/ also matches "card",
  // which classified every card leg as on-account and 422'd normal card sales.
  if (Array.isArray(body.payments)) {
    return body.payments
      .filter((p) => {
        const m = String(p.method || p.type || '').trim();
        return /^(credit|customer_credit|kita|ar)$/i.test(m) || /آجل|ذمم|كيتا/.test(m);
      })
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  }
  // legacy single method string
  const m = String(body.payment_method || body.paymentMethod || '').toLowerCase();
  if (/^(credit|kita|ar)$/.test(m) || m.indexOf('ذمم') >= 0 || m.indexOf('آجل') >= 0) {
    return Number(body.total_final || body.total || body.amount || 0) || 0;
  }
  return 0;
}

function creditSaleGate() {
  return async function (req, res, next) {
    if (!ENABLED || _isRead(req)) return next();
    if (!/^\/?$/.test(String(req.path || ''))) return next(); // only the create endpoint
    let creditAmount = 0;
    try { creditAmount = _creditPortion(req.body); } catch (_) { creditAmount = 0; }
    if (!(creditAmount > 0)) return next(); // cash/card sale — not gated
    try {
      const CreditLimitService = require('../services/order-to-cash/CreditLimitService');
      const requireCapability = require('./requireCapability');
      const hasOverride = req.user ? await requireCapability.hasCapability(req.user, 'credit.override') : false;
      await CreditLimitService.enforce(null, {
        customerId: req.body.customer_id || req.body.customerId,
        creditAmount, issueDate: req.body.order_date || req.body.orderDate,
        override: !!(req.body.creditOverride || req.body.override), hasOverrideCapability: hasOverride,
      });
      return next();
    } catch (e) {
      const { sendError } = require('../lib/order-to-cash/errors');
      return sendError(res, e);
    }
  };
}

module.exports = { customerReceiptGate, saleReverseGate, creditSaleGate, ENABLED, RETURNS_ROUTE, _dest };
