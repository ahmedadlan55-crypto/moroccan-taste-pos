/**
 * services/order-to-cash/PaymentAllocationService.js — the ONLY writer of
 * ar_documents.paid_amount / balance_amount / status. Allocations are guarded on
 * BOTH sides:
 *   • per invoice  — a locked (FOR UPDATE) current-read of existing allocations so
 *     two concurrent payments serialize behind the invoice row and can never
 *     over-allocate it (a plain SUM under REPEATABLE READ would miss the other's
 *     committed row).
 *   • per payment  — total allocations may never exceed the payment amount.
 * Over-allocation → OVER_ALLOCATION (422). Everything runs on the caller's tx conn.
 */
'use strict';

const { err } = require('../../lib/order-to-cash/errors');
const calc = require('../../lib/order-to-cash/calculations');
const money = calc.money;

function allocId() { return 'ARA-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

/** Locking current-read of an invoice's live allocations (see file header). */
async function lockedAllocatedSum(conn, arDocumentId) {
  const [rows] = await conn.query(
    'SELECT allocated_amount FROM ar_payment_allocations WHERE ar_document_id = ? AND reversed = 0 FOR UPDATE',
    [arDocumentId]);
  return money(rows.reduce((s, r) => s + Number(r.allocated_amount), 0));
}

/** Recompute + persist an invoice's paid/balance/status from its live allocations. */
async function recomputeInvoice(conn, arDocumentId) {
  const [inv] = await conn.query(
    'SELECT id, total_amount, status FROM ar_documents WHERE id = ? FOR UPDATE', [arDocumentId]);
  if (!inv.length) throw err('NOT_FOUND', 'الفاتورة غير موجودة');
  const total = money(inv[0].total_amount);
  const paid = await lockedAllocatedSum(conn, arDocumentId);
  const balance = money(total - paid);
  let status = inv[0].status;
  if (!['cancelled', 'credited', 'closed', 'draft'].includes(String(status))) {
    status = balance <= 0.01 ? 'paid' : (paid > 0.01 ? 'partially_paid' : 'issued');
  }
  await conn.query(
    'UPDATE ar_documents SET paid_amount = ?, balance_amount = ?, status = ?, version = version + 1 WHERE id = ?',
    [paid, Math.max(0, balance), status, arDocumentId]);
  return { total, paid, balance: Math.max(0, balance), status };
}

/**
 * Apply a set of allocations for a payment, guarding both bounds.
 * @param allocations [{ arDocumentId | invoiceId, amount }]
 * @returns { allocatedTotal, perInvoice:[{arDocumentId, amount, balanceAfter}] }
 */
async function applyAllocations(conn, payment, allocations, actor) {
  const perInvoice = [];
  let allocatedTotal = 0;
  for (const a of allocations || []) {
    const arDocumentId = a.arDocumentId || a.invoiceId || a.ar_document_id;
    const amount = money(a.amount);
    if (!arDocumentId) throw err('VALIDATION_ERROR', 'التخصيص يحتاج فاتورة');
    if (!(amount > 0)) throw err('VALIDATION_ERROR', 'مبلغ التخصيص يجب أن يكون موجبًا');
    const [inv] = await conn.query(
      "SELECT id, total_amount, customer_id, status FROM ar_documents WHERE id = ? FOR UPDATE", [arDocumentId]);
    if (!inv.length) throw err('NOT_FOUND', 'الفاتورة غير موجودة: ' + arDocumentId);
    if (['cancelled', 'draft'].includes(String(inv[0].status))) throw err('PAYMENT_NOT_ALLOCATABLE', 'لا يمكن تخصيص دفعة على فاتورة غير صادرة');
    if (payment.customer_id && inv[0].customer_id && String(payment.customer_id) !== String(inv[0].customer_id)) {
      throw err('VALIDATION_ERROR', 'الفاتورة تخص عميلًا مختلفًا عن الدفعة');
    }
    const already = await lockedAllocatedSum(conn, arDocumentId);
    const outstanding = money(Number(inv[0].total_amount) - already);
    if (amount - outstanding > 0.01) {
      throw err('OVER_ALLOCATION', `التخصيص (${amount}) يتجاوز المتبقّي على الفاتورة (${outstanding})`);
    }
    await conn.query(
      `INSERT INTO ar_payment_allocations (id, payment_id, ar_document_id, customer_id, allocated_amount, created_by)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE allocated_amount = allocated_amount + VALUES(allocated_amount), reversed = 0`,
      [allocId(), payment.id, arDocumentId, inv[0].customer_id || payment.customer_id || null, amount, actor || '']);
    const rec = await recomputeInvoice(conn, arDocumentId);
    perInvoice.push({ arDocumentId, amount, balanceAfter: rec.balance, status: rec.status });
    allocatedTotal += amount;
  }
  allocatedTotal = money(allocatedTotal);
  // per-payment ceiling: total live allocations ≤ payment amount
  const [tot] = await conn.query(
    'SELECT COALESCE(SUM(allocated_amount),0) AS a FROM ar_payment_allocations WHERE payment_id = ? AND reversed = 0', [payment.id]);
  if (Number(tot[0].a) - Number(payment.amount) > 0.01) {
    throw err('OVER_ALLOCATION', 'مجموع التخصيصات يتجاوز مبلغ الدفعة');
  }
  return { allocatedTotal, totalAllocatedLive: money(tot[0].a), perInvoice };
}

/** Reverse every live allocation of a payment and recompute the affected invoices. */
async function reverseAllocations(conn, paymentId) {
  const [alloc] = await conn.query(
    'SELECT ar_document_id FROM ar_payment_allocations WHERE payment_id = ? AND reversed = 0', [paymentId]);
  await conn.query('UPDATE ar_payment_allocations SET reversed = 1 WHERE payment_id = ?', [paymentId]);
  for (const a of alloc) await recomputeInvoice(conn, a.ar_document_id);
  return alloc.map((a) => a.ar_document_id);
}

module.exports = { lockedAllocatedSum, recomputeInvoice, applyAllocations, reverseAllocations };
