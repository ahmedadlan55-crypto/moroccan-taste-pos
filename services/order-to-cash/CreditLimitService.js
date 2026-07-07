/**
 * services/order-to-cash/CreditLimitService.js — the SERVER-SIDE credit-sale gate
 * (spec §البيع الآجل). A credit (deferred) sale is REJECTED unless every rule
 * holds. The UI is advisory only; this is the security boundary. Called from both
 * the O2C invoice/order path and the legacy POST /api/sales path (when
 * ORDER_TO_CASH_ENABLE is on and the payment structure carries a credit portion).
 *
 * Rejection reasons (all raise a typed OrderToCashError → 422):
 *   CUSTOMER_REQUIRED       no customerId supplied for a credit sale
 *   NOT_FOUND               customer does not exist
 *   CUSTOMER_INACTIVE       customer is deactivated
 *   VALIDATION_ERROR        no payment terms / no derivable due date / zero limit
 *   CREDIT_LIMIT_EXCEEDED   exposure + this credit > limit AND no approved override
 *   CREDIT_APPROVAL_REQUIRED  over limit but caller holds credit.override (needs explicit approve flag)
 */
'use strict';

const db = require('../../db/connection');
const { err } = require('../../lib/order-to-cash/errors');
const calc = require('../../lib/order-to-cash/calculations');
const CustomerService = require('./CustomerService');

const money = calc.money;

/** Does this customer profile permit deferred terms at all? */
function _termsPermitCredit(customer) {
  const terms = String(customer.paymentTerms || 'Cash').trim().toLowerCase();
  const isCashOnly = terms === 'cash' || terms === 'نقدي' || terms === '';
  return { permitted: !isCashOnly && Number(customer.creditDays) >= 0, isCashOnly };
}

/**
 * Assess a proposed credit sale WITHOUT mutating anything.
 * @returns {{ allowed, dueDate, exposure, availableBefore, availableAfter,
 *             creditAmount, customer, warnings }}
 * @throws OrderToCashError on any hard rejection (unless override approved).
 */
async function assess(conn, opts = {}) {
  const conx = conn || db;
  const creditAmount = money(opts.creditAmount);
  if (!(creditAmount > 0)) {
    // Not a credit sale — nothing to gate.
    return { allowed: true, creditAmount: 0, dueDate: null, exposure: 0, availableBefore: null, availableAfter: null, customer: null, warnings: [] };
  }
  if (!opts.customerId) throw err('CUSTOMER_REQUIRED', 'البيع الآجل يتطلب اختيار عميل مسجّل');

  const [rows] = await conx.query('SELECT * FROM customers WHERE id = ? LIMIT 1', [opts.customerId]);
  if (!rows.length) throw err('NOT_FOUND', 'العميل غير موجود');
  const customer = CustomerService._shape(rows[0]);

  if (!customer.isActive) throw err('CUSTOMER_INACTIVE', 'العميل معطّل ولا يمكن البيع له آجلًا');

  const terms = _termsPermitCredit(customer);
  if (terms.isCashOnly) throw err('VALIDATION_ERROR', 'العميل مُعرّف بالدفع النقدي فقط — لا يُسمح بالبيع الآجل');

  const issueYmd = calc.ymd(opts.issueDate);
  const dueDate = calc.addDays(issueYmd, Number(customer.creditDays) || 0);
  if (!dueDate) throw err('VALIDATION_ERROR', 'تعذّر اشتقاق تاريخ الاستحقاق من شروط السداد');

  const limit = money(customer.creditLimit);
  if (!(limit > 0)) throw err('CREDIT_LIMIT_EXCEEDED', 'حد الائتمان صفر — لا يُسمح بالبيع الآجل لهذا العميل');

  const bal = await CustomerService.derivedBalance(conx, customer.id);
  const exposure = money(bal.arBalance);
  const availableBefore = money(limit - exposure);
  const projected = money(exposure + creditAmount);
  const availableAfter = money(limit - projected);
  const warnings = [];

  if (projected - limit > 0.01) {
    // Over the limit. Allowed only with an explicit, approved override by a caller who holds credit.override.
    if (opts.override && opts.hasOverrideCapability) {
      warnings.push(`تجاوز حد الائتمان باعتماد: التعرّض ${projected} مقابل الحد ${limit}`);
      return { allowed: true, overridden: true, dueDate, exposure, availableBefore, availableAfter, creditAmount, limit, customer, warnings };
    }
    if (opts.hasOverrideCapability && !opts.override) {
      throw err('CREDIT_APPROVAL_REQUIRED', `المبلغ يتجاوز حد الائتمان (المتاح ${availableBefore}) — يلزم اعتماد صريح`, { availableBefore, limit, exposure, projected });
    }
    throw err('CREDIT_LIMIT_EXCEEDED', `تجاوز حد الائتمان: المتاح ${availableBefore} والمطلوب ${creditAmount}`, { availableBefore, limit, exposure, projected });
  }

  return { allowed: true, overridden: false, dueDate, exposure, availableBefore, availableAfter, creditAmount, limit, customer, warnings };
}

/** Enforce (throws on rejection); returns the assessment on success. */
async function enforce(conn, opts) {
  return assess(conn, opts);
}

/** Read-only credit exposure snapshot for a customer (Customer 360 / dashboard). */
async function exposure(customerId, conn = db) {
  const [rows] = await conn.query('SELECT credit_limit, is_active, payment_terms, credit_days FROM customers WHERE id = ? LIMIT 1', [customerId]);
  if (!rows.length) throw err('NOT_FOUND', 'العميل غير موجود');
  const limit = money(rows[0].credit_limit);
  const bal = await CustomerService.derivedBalance(conn, customerId);
  const used = money(bal.arBalance);
  return {
    creditLimit: limit,
    exposure: used,
    available: money(limit - used),
    utilizationPct: limit > 0 ? Math.round((used / limit) * 10000) / 100 : null,
    paymentTerms: rows[0].payment_terms,
    creditDays: Number(rows[0].credit_days || 0),
    isActive: !!Number(rows[0].is_active),
  };
}

module.exports = { assess, enforce, exposure, _termsPermitCredit };
