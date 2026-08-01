/**
 * routes/erp/reports/ar-aging.js — A/R Aging report.
 *
 * GET /api/erp/reports/ar-aging?asOfDate=YYYY-MM-DD&brandId=&branchId=
 *
 * Buckets every unpaid (or partially-paid) credit sale by days outstanding:
 *   0-30  / 31-60 / 61-90 / 91-120 / 120+
 *
 * Strategy:
 *   1. Pull all `sales` since the cut-off whose customer_id is not null
 *      and payment_method indicates a credit/AR component (kita, credit,
 *      ذمم, or any Split row containing those).
 *   2. Pull `customer_payments` rows that pay them down.
 *   3. Compute outstanding = total_final − sum(payment.amount).
 *   4. Place into a bucket by (asOfDate − order_date) days.
 *
 * The endpoint is tolerant of older deploys lacking the customer_payments
 * table — in that case sales are treated as fully outstanding.
 *
 * v6.2.0 — Wave F.1
 */

const router = require('express').Router();
const db = require('../../../db/connection');
const requireCapability = require('../../../middleware/requireCapability');

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

router.get('/reports/ar-aging', requireCapability('finance.reports.view'), async (req, res) => {
  try {
    const asOfDate = req.query.asOfDate || new Date().toISOString().slice(0, 10);
    const brandId = req.query.brandId || '';
    const branchId = req.query.branchId || '';

    // 1. Pull credit / AR sales
    let saleQuery = `
      SELECT s.id, s.order_date, s.total_final, s.payment_method, s.payment_notes,
             s.customer_id, s.has_credit_note,
             c.name AS customer_name, c.phone AS customer_phone
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.customer_id IS NOT NULL
        AND DATE(s.order_date) <= ?
        AND (LOWER(s.payment_method) LIKE '%kita%'
             OR LOWER(s.payment_method) LIKE '%credit%'
             OR LOWER(s.payment_method) LIKE '%ذمم%'
             OR LOWER(s.payment_method) LIKE '%آجل%'
             OR s.payment_method = 'Split'
             OR s.payment_method = 'Other')`;
    const params = [asOfDate];
    if (brandId)  { saleQuery += ' AND s.brand_id = ?';  params.push(brandId); }
    if (branchId) { saleQuery += ' AND s.branch_id = ?'; params.push(branchId); }
    saleQuery += ' ORDER BY s.order_date ASC';

    const [sales] = await db.query(saleQuery, params);

    // 2. Pull payments (best-effort — table may not exist on older deploys)
    let paymentMap = {};
    if (sales.length) {
      const ids = sales.map(s => s.id);
      const ph = ids.map(() => '?').join(',');
      try {
        const [paid] = await db.query(
          `SELECT sale_id, SUM(amount) AS total_paid
             FROM customer_payments
            WHERE sale_id IN (${ph})
              AND DATE(payment_date) <= ?
            GROUP BY sale_id`,
          [...ids, asOfDate]
        );
        paid.forEach(p => { paymentMap[p.sale_id] = Number(p.total_paid) || 0; });
      } catch (_) {
        // customer_payments table not present — treat all as fully outstanding
      }
    }

    // 3. Compute outstanding + bucket
    const customerMap = {};   // customerId → { name, phone, buckets: {...}, total, invoices: [] }
    let grandTotal = 0;
    const grandBuckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 };

    sales.forEach(s => {
      const paid = paymentMap[s.id] || 0;
      const total = Number(s.total_final) || 0;
      const outstanding = Math.max(0, total - paid);
      if (outstanding <= 0.001) return;
      const days = _daysBetween(s.order_date, asOfDate);
      const b = _bucket(days);
      if (!customerMap[s.customer_id]) {
        customerMap[s.customer_id] = {
          customerId: s.customer_id,
          customerName: s.customer_name || '—',
          customerPhone: s.customer_phone || '',
          total: 0,
          buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 },
          invoices: []
        };
      }
      customerMap[s.customer_id].buckets[b] += outstanding;
      customerMap[s.customer_id].total += outstanding;
      customerMap[s.customer_id].invoices.push({
        invoiceId: s.id,
        orderDate: s.order_date,
        ageDays: days,
        bucket: b,
        totalFinal: total,
        paid,
        outstanding,
        paymentMethod: s.payment_method,
        hasCreditNote: !!s.has_credit_note
      });
      grandBuckets[b] += outstanding;
      grandTotal += outstanding;
    });

    const customers = Object.values(customerMap).sort((a, b) => b.total - a.total);

    res.json({
      success: true,
      asOfDate,
      customers,
      grandTotal: Math.round(grandTotal * 100) / 100,
      grandBuckets: {
        '0-30':   Math.round(grandBuckets['0-30']   * 100) / 100,
        '31-60':  Math.round(grandBuckets['31-60']  * 100) / 100,
        '61-90':  Math.round(grandBuckets['61-90']  * 100) / 100,
        '91-120': Math.round(grandBuckets['91-120'] * 100) / 100,
        '120+':   Math.round(grandBuckets['120+']   * 100) / 100
      },
      topDebtor: customers[0] || null,
      overdue90PlusRatio: grandTotal > 0
        ? Math.round(((grandBuckets['91-120'] + grandBuckets['120+']) / grandTotal) * 10000) / 100
        : 0
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
