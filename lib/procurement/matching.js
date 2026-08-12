/**
 * Concurrency-safe receipt-line capacity control for supplier-invoice matching.
 *
 * A receipt line is the unit of control.  We lock every referenced receipt
 * line in deterministic id order, then account for every positive match made
 * by every other invoice.  Capacity is checked line-by-line; negative or later
 * lines can never net an earlier over-match back under the receipt quantity.
 */
'use strict';

const calc = require('./calculations');
const { err } = require('./errors');

const QTY_EPSILON = 0.00005;

function _overMatch(details) {
  return err(
    'MATCHING_VARIANCE',
    'الكمية المراد مطابقتها تتجاوز الكمية المستلمة المتبقية في نفس سطر الاستلام',
    details
  );
}

/** Pure, mutation-oriented capacity planner. */
function allocateReceiptCapacity(invoiceLines, receiptRows, reservedByReceipt = {}) {
  const receipts = new Map((receiptRows || []).map((row) => [String(row.id), row]));
  const usedNow = new Map();
  const plan = [];

  for (const line of invoiceLines || []) {
    if (!line.grn_line_id) continue;
    const receiptLineId = String(line.grn_line_id);
    const receipt = receipts.get(receiptLineId);
    if (!receipt) {
      throw err('NOT_FOUND', 'سطر الاستلام المرتبط بالفاتورة غير موجود', {
        invoiceLineId: line.id,
        receiptLineId,
      });
    }

    const requestedQty = calc.qty(line.base_qty);
    if (requestedQty <= 0) {
      throw err('VALIDATION_ERROR', 'كمية سطر الفاتورة المطابق يجب أن تكون أكبر من صفر', {
        invoiceLineId: line.id,
        receiptLineId,
        requestedQty,
      });
    }

    const receivedQty = calc.qty(receipt.base_qty);
    const reservedQty = Math.max(0, calc.qty(reservedByReceipt[receiptLineId] || 0));
    const priorLineQty = calc.qty(usedNow.get(receiptLineId) || 0);
    const availableQty = calc.qty(Math.max(0, receivedQty - reservedQty - priorLineQty));

    // Check this line before adding it.  This is intentionally not a document
    // SUM check: a later negative/correction line must never hide an over-match.
    if (requestedQty - availableQty > QTY_EPSILON) {
      throw _overMatch({
        invoiceLineId: line.id,
        receiptLineId,
        requestedQty,
        availableQty,
        receivedQty,
        reservedQty,
        alreadyRequestedByThisInvoice: priorLineQty,
      });
    }

    usedNow.set(receiptLineId, calc.qty(priorLineQty + requestedQty));
    plan.push({ line, receipt, matchedQty: requestedQty, availableQtyBefore: availableQty });
  }

  return plan;
}

async function lockReceiptMatchPlan(conn, invoiceId, invoiceLines) {
  const ids = [...new Set((invoiceLines || [])
    .map((line) => line.grn_line_id && String(line.grn_line_id))
    .filter(Boolean))].sort();
  if (!ids.length) return [];

  const marks = ids.map(() => '?').join(',');
  const [receiptRows] = await conn.query(
    `SELECT id, po_line_id, base_qty, base_unit_cost, base_invoiced_qty
       FROM purchase_receipt_lines
      WHERE id IN (${marks})
      ORDER BY id
      FOR UPDATE`,
    ids
  );

  // Count each other invoice's positive reservation. GREATEST is deliberate:
  // corrupt legacy negative rows cannot net genuine consumption downwards.
  const [reservationRows] = await conn.query(
    `SELECT id, receipt_line_id, matched_qty
       FROM supplier_invoice_matches
      WHERE receipt_line_id IN (${marks})
        AND invoice_id <> ?
      ORDER BY receipt_line_id, id
      FOR UPDATE`,
    ids.concat([invoiceId])
  );
  const reserved = {};
  for (const row of reservationRows) {
    const id = String(row.receipt_line_id);
    // Corrupt legacy negatives never reduce genuine reservations.
    reserved[id] = calc.qty((reserved[id] || 0) + Math.max(0, calc.qty(row.matched_qty)));
  }
  return allocateReceiptCapacity(invoiceLines, receiptRows, reserved);
}

/**
 * Revalidate and consume the approved quantity under the same receipt locks.
 * This catches pre-existing/legacy bad matches as well as future regressions.
 */
async function applyApprovedReceiptQuantities(conn, invoiceId) {
  const [refs] = await conn.query(
    `SELECT DISTINCT receipt_line_id
       FROM supplier_invoice_matches
      WHERE invoice_id = ? AND receipt_line_id IS NOT NULL
      ORDER BY receipt_line_id`,
    [invoiceId]
  );
  if (!refs.length) return [];

  const ids = refs.map((row) => String(row.receipt_line_id)).sort();
  const marks = ids.map(() => '?').join(',');
  const [receipts] = await conn.query(
    `SELECT id, base_qty, base_invoiced_qty
       FROM purchase_receipt_lines
      WHERE id IN (${marks})
      ORDER BY id
      FOR UPDATE`,
    ids
  );
  const receiptById = new Map(receipts.map((row) => [String(row.id), row]));
  if (receiptById.size !== ids.length) {
    const missing = ids.find((id) => !receiptById.has(id));
    throw err('NOT_FOUND', 'سطر استلام مرتبط بالفاتورة لم يعد موجودًا', { receiptLineId: missing });
  }

  // Lock and read all reservations only after the receipt locks. This is a
  // current read under REPEATABLE READ and preserves one lock order across
  // match and approve paths (receipt first, match rows second).
  const [allMatches] = await conn.query(
    `SELECT id, invoice_id, receipt_line_id, matched_qty
       FROM supplier_invoice_matches
      WHERE receipt_line_id IN (${marks})
      ORDER BY receipt_line_id, id
      FOR UPDATE`,
    ids
  );
  const currentByReceipt = {};
  const otherByReceipt = {};
  for (const row of allMatches) {
    const id = String(row.receipt_line_id);
    const qty = Math.max(0, calc.qty(row.matched_qty));
    const bucket = String(row.invoice_id) === String(invoiceId) ? currentByReceipt : otherByReceipt;
    bucket[id] = calc.qty((bucket[id] || 0) + qty);
  }

  const applied = [];
  for (const receiptLineId of ids) {
    const receipt = receiptById.get(receiptLineId);
    const matchedQty = calc.qty(currentByReceipt[receiptLineId] || 0);
    const otherReservedQty = calc.qty(otherByReceipt[receiptLineId] || 0);
    const alreadyInvoicedQty = calc.qty(receipt.base_invoiced_qty);
    const receivedQty = calc.qty(receipt.base_qty);
    if (
      matchedQty <= 0 ||
      otherReservedQty + matchedQty - receivedQty > QTY_EPSILON ||
      alreadyInvoicedQty + matchedQty - receivedQty > QTY_EPSILON
    ) {
      throw _overMatch({ receiptLineId, matchedQty, otherReservedQty, alreadyInvoicedQty, receivedQty });
    }

    const [updated] = await conn.query(
      `UPDATE purchase_receipt_lines
          SET base_invoiced_qty = base_invoiced_qty + ?
        WHERE id = ?
          AND base_invoiced_qty + ? <= base_qty + ?`,
      [matchedQty, receiptLineId, matchedQty, QTY_EPSILON]
    );
    if (!updated || updated.affectedRows !== 1) {
      throw _overMatch({ receiptLineId, matchedQty, alreadyInvoicedQty, receivedQty, concurrentConflict: true });
    }
    applied.push({ receiptLineId, matchedQty });
  }
  return applied;
}

/**
 * Release receipt capacity when a fully reversed supplier invoice is replaced.
 * The credit-note transaction calls this before cancelling the invoice; every
 * receipt row is locked and decremented conditionally so corrupt history can
 * never manufacture negative invoiced quantity.
 */
async function releaseApprovedReceiptQuantities(conn, invoiceId) {
  const [matches] = await conn.query(
    `SELECT receipt_line_id, SUM(GREATEST(matched_qty,0)) AS matched_qty
       FROM supplier_invoice_matches
      WHERE invoice_id = ? AND receipt_line_id IS NOT NULL
      GROUP BY receipt_line_id
      ORDER BY receipt_line_id`,
    [invoiceId]
  );
  if (!matches.length) return [];

  const released = [];
  for (const match of matches) {
    const receiptLineId = String(match.receipt_line_id);
    const matchedQty = calc.qty(match.matched_qty);
    if (matchedQty <= 0) continue;
    const [updated] = await conn.query(
      `UPDATE purchase_receipt_lines
          SET base_invoiced_qty = base_invoiced_qty - ?
        WHERE id = ?
          AND base_invoiced_qty + ? >= ?`,
      [matchedQty, receiptLineId, QTY_EPSILON, matchedQty]
    );
    if (!updated || updated.affectedRows !== 1) {
      throw _overMatch({ receiptLineId, matchedQty, releaseConflict: true });
    }
    released.push({ receiptLineId, matchedQty });
  }
  return released;
}

module.exports = {
  QTY_EPSILON,
  allocateReceiptCapacity,
  lockReceiptMatchPlan,
  applyApprovedReceiptQuantities,
  releaseApprovedReceiptQuantities,
};
