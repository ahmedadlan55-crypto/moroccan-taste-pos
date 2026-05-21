/**
 * routes/erp/reports/ap-aging.js — A/P (Accounts Payable) Aging report.
 *
 * GET /api/erp/reports/ap-aging?asOfDate=YYYY-MM-DD&brandId=&branchId=
 *
 * Mirrors ar-aging.js but for `purchases` (supplier invoices). Buckets
 * any purchase with payment_method indicating credit/AR ('آجل', 'credit')
 * whose payments don't cover the total.
 *
 * Tolerant of:
 *   - Missing supplier_payments table → treats purchases as fully unpaid
 *   - Missing 'received' / 'paid' status columns → falls back to amount-only
 *
 * v6.2.0 — Wave F.2
 */

const router = require('express').Router();
const db = require('../../../db/connection');

function _bucket(days) {
  if (days <= 30)  return '0-30';
  if (days <= 60)  return '31-60';
  if (days <= 90)  return '61-90';
  if (days <= 120) return '91-120';
  return '120+';
}

function _daysBetween(a, b) {
  const aMs = (a instanceof Date) ? a.getTime() : new Date(a).getTime();
  const bMs = (b instanceof Date) ? b.getTime() : new Date(b).getTime();
  return Math.max(0, Math.floor((bMs - aMs) / 86400000));
}

router.get('/reports/ap-aging', async (req, res) => {
  try {
    const asOfDate = req.query.asOfDate || new Date().toISOString().slice(0, 10);

    // Detect optional columns on purchases
    let hasStatus = false, hasSupplierId = false;
    try { const [c] = await db.query("SHOW COLUMNS FROM purchases LIKE 'status'"); hasStatus = !!c.length; } catch(_) {}
    try { const [c] = await db.query("SHOW COLUMNS FROM purchases LIKE 'supplier_id'"); hasSupplierId = !!c.length; } catch(_) {}

    let purchQuery = `
      SELECT p.id, p.purchase_date, p.total_price, p.payment_method, p.supplier_name,
             ${hasStatus ? 'p.status' : "'received' AS status"},
             ${hasSupplierId ? 'p.supplier_id' : 'NULL AS supplier_id'}
      FROM purchases p
      WHERE DATE(p.purchase_date) <= ?
        AND (LOWER(p.payment_method) LIKE '%آجل%'
             OR LOWER(p.payment_method) LIKE '%credit%'
             OR LOWER(p.payment_method) LIKE '%ذمم%'
             OR p.payment_method = 'Credit')`;
    const params = [asOfDate];
    purchQuery += ' ORDER BY p.purchase_date ASC';

    const [purchases] = await db.query(purchQuery, params);

    // Pull supplier_payments if present
    let paymentMap = {};
    if (purchases.length) {
      const ids = purchases.map(p => p.id);
      const ph = ids.map(() => '?').join(',');
      try {
        const [paid] = await db.query(
          `SELECT purchase_id, SUM(amount) AS total_paid
             FROM supplier_payments
            WHERE purchase_id IN (${ph})
              AND DATE(payment_date) <= ?
            GROUP BY purchase_id`,
          [...ids, asOfDate]
        );
        paid.forEach(p => { paymentMap[p.purchase_id] = Number(p.total_paid) || 0; });
      } catch (_) { /* table missing */ }
    }

    const supplierMap = {};
    let grandTotal = 0;
    const grandBuckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 };

    purchases.forEach(p => {
      const paid = paymentMap[p.id] || 0;
      const total = Number(p.total_price) || 0;
      const outstanding = Math.max(0, total - paid);
      if (outstanding <= 0.001) return;
      const days = _daysBetween(p.purchase_date, asOfDate);
      const b = _bucket(days);
      const key = p.supplier_id || ('SUPP-' + (p.supplier_name || 'UNKNOWN'));
      if (!supplierMap[key]) {
        supplierMap[key] = {
          supplierId: p.supplier_id || null,
          supplierName: p.supplier_name || '—',
          total: 0,
          buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 },
          invoices: []
        };
      }
      supplierMap[key].buckets[b] += outstanding;
      supplierMap[key].total += outstanding;
      supplierMap[key].invoices.push({
        purchaseId: p.id,
        purchaseDate: p.purchase_date,
        ageDays: days,
        bucket: b,
        totalPrice: total,
        paid,
        outstanding,
        paymentMethod: p.payment_method
      });
      grandBuckets[b] += outstanding;
      grandTotal += outstanding;
    });

    const suppliers = Object.values(supplierMap).sort((a, b) => b.total - a.total);

    res.json({
      success: true,
      asOfDate,
      suppliers,
      grandTotal: Math.round(grandTotal * 100) / 100,
      grandBuckets: {
        '0-30':   Math.round(grandBuckets['0-30']   * 100) / 100,
        '31-60':  Math.round(grandBuckets['31-60']  * 100) / 100,
        '61-90':  Math.round(grandBuckets['61-90']  * 100) / 100,
        '91-120': Math.round(grandBuckets['91-120'] * 100) / 100,
        '120+':   Math.round(grandBuckets['120+']   * 100) / 100
      },
      topCreditor: suppliers[0] || null,
      overdue90PlusRatio: grandTotal > 0
        ? Math.round(((grandBuckets['91-120'] + grandBuckets['120+']) / grandTotal) * 10000) / 100
        : 0
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
