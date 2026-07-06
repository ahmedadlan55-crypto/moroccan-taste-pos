/**
 * middleware/procurementLegacyGate.js
 *
 * When PROCUREMENT_P2P_ENABLE is ON, the unified /api/procurement module is the
 * SOLE writer of procurement stock (goods receipts) and AP (supplier invoices +
 * supplier payments). These guards block every LEGACY write path so no legacy
 * endpoint can mutate stock or AP in parallel — provable "zero dual-write".
 *
 * Reads (GET/HEAD/OPTIONS) always pass through so legacy screens can still show
 * historical data during the transition. Reverting PROCUREMENT_P2P_ENABLE=0
 * removes every guard and the legacy writers resume untouched.
 */
'use strict';

const ENABLED = /^(1|true|on|yes)$/i.test(String(process.env.PROCUREMENT_P2P_ENABLE || '').trim());

function _blocked(res, redirect) {
  return res.status(409).json({
    success: false,
    code: 'V2_RECEIPTS_LINKED',
    error: 'انتقلت هذه العملية إلى وحدة «المشتريات والموردون» الموحدة.',
    redirect,
  });
}

/** Block ALL mutations on a legacy prefix; GET/HEAD/OPTIONS pass. */
function legacyWriteGate(redirect) {
  return function (req, res, next) {
    if (!ENABLED) return next();
    if (/^(GET|HEAD|OPTIONS)$/.test(req.method)) return next();
    return _blocked(res, redirect);
  };
}

/** Block a legacy supplier payment (erp/payments) but let other treasury pass. */
function supplierPaymentGate(redirect) {
  return function (req, res, next) {
    if (!ENABLED) return next();
    if (/^(GET|HEAD|OPTIONS)$/.test(req.method)) return next();
    const rt = String((req.body && (req.body.referenceType || req.body.reference_type)) || '');
    const dir = String((req.body && req.body.direction) || 'out');
    if (dir === 'out' && /supplier/i.test(rt)) return _blocked(res, redirect);
    return next();
  };
}

module.exports = { legacyWriteGate, supplierPaymentGate, ENABLED };
