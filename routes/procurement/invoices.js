/**
 * routes/procurement/invoices.js — Supplier Invoices (AP) + three-way match.
 * draft → pending_review → approved (posts GRNI/AP GL) → paid/closed.
 * Duplicate (supplier_id, invoice_no) blocked at submit. Approval posts:
 *   stock:    Dr GRNI + Dr Input VAT (+PPV) / Cr AP
 *   non-stock Dr Expense + Dr Input VAT       / Cr AP
 *
 * Landed cost: a line may carry receiptChargeId — it settles an import-charge
 * accrual (purchase_receipt_charges) that the receipt post credited to GRNI.
 * On approve such lines clear GRNI at the ACCRUED value (their own entry,
 * 'تصفية مصاريف استيراد مستحقة'), the vendor's invoice/accrual difference is
 * PPV, and the charge rows flip to 'invoiced' naming this invoice. Lines
 * without receiptChargeId keep their existing stock / non-stock treatment, so
 * a mixed invoice is the union of the two.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const acctDate = require('../../lib/accountingDate');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const { err } = require('../../lib/procurement/errors');
const calc = require('../../lib/procurement/calculations');
const cfg = require('../../lib/procurement/config');
const { nextNumber } = require('../../lib/procurement/numbering');
const { runTransition } = require('../../services/procurement/TransitionExecutor');
const posting = require('../../lib/procurement/posting');
const events = require('../../lib/procurement/events');
const matching = require('../../lib/procurement/matching');
const stateMachine = require('../../lib/procurement/stateMachine');

const SORTABLE = { issueDate: 'si.issue_date', dueDate: 'si.due_date', createdAt: 'si.created_at', total: 'si.total_amount', status: 'si.status' };
const LIST_STATUSES = ['draft', 'pending_review', 'pending_approval', 'approved', 'partially_paid', 'paid', 'overdue', 'closed', 'cancelled'];

function genId() { return 'SINV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function lineId() { return 'SIL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function matchId() { return 'SIM-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

// variance thresholds (settings via env; sane defaults)
const PRICE_VAR_PCT = Number(process.env.PROCUREMENT_PRICE_VARIANCE_PCT || 5);
const QTY_VAR_PCT = Number(process.env.PROCUREMENT_QTY_VARIANCE_PCT || 5);
const C = 'COLLATE utf8mb4_unicode_ci';

// ── landed cost helpers ──────────────────────────────────────────────────────
/**
 * Lock and vet the import-charge accruals an invoice names (receiptChargeId).
 * Each must exist, still be 'accrued', sit on a POSTED receipt (an unposted
 * receipt has credited nothing to clear) and not be claimed by another live
 * invoice — two invoices clearing one accrual would debit GRNI twice. The
 * same check runs at create AND under the approve lock: the receipt can be
 * reversed, or another invoice approved, between the two.
 *
 * @returns the locked charge rows in the order of `chargeIds`
 */
async function _lockInvoiceableCharges(conn, chargeIds, invoiceId) {
  const ids = (chargeIds || []).map(String);
  if (!ids.length) return [];
  if (new Set(ids).size !== ids.length) throw err('VALIDATION_ERROR', 'مصروف الاستيراد نفسه مذكور في أكثر من سطر');
  const marks = ids.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT c.id, c.status, c.amount, c.charge_type, c.receipt_id, pr.status AS receipt_status, pr.receipt_number
       FROM purchase_receipt_charges c
       JOIN purchase_receipts pr ON pr.id ${C} = c.receipt_id ${C}
      WHERE c.id IN (${marks})
      ORDER BY c.id
      FOR UPDATE`, ids);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) throw err('VALIDATION_ERROR', `مصروف الاستيراد غير موجود: ${id}`);
    if (String(c.status) !== 'accrued') throw err('DOCUMENT_HAS_HISTORY', `مصروف الاستيراد ${id} مُفوتر مسبقًا`);
    if (String(c.receipt_status) !== 'posted') {
      throw err('VALIDATION_ERROR', `لا يمكن فوترة مصروف استيراد على استلام غير مُرحّل (${c.receipt_number}: ${c.receipt_status})`);
    }
  }
  const [claimed] = await conn.query(
    `SELECT sil.receipt_charge_id, si.code
       FROM supplier_invoice_lines sil
       JOIN supplier_invoices si ON si.id ${C} = sil.invoice_id ${C}
      WHERE sil.receipt_charge_id IN (${marks}) AND si.status <> 'cancelled'${invoiceId ? ' AND si.id <> ?' : ''}
      LIMIT 1`, invoiceId ? ids.concat([String(invoiceId)]) : ids);
  if (claimed.length) {
    throw err('DUPLICATE_SUPPLIER_INVOICE', `مصروف الاستيراد ${claimed[0].receipt_charge_id} مذكور في فاتورة أخرى (${claimed[0].code})`);
  }
  return ids.map((id) => byId.get(id));
}

/**
 * Net of VAT for one stored invoice line. line_total is stored WITH VAT
 * (calculations.computeLine: lineTotal = net + vatAmount, inclusive or not),
 * and the discount amount is not persisted per line, so the net is derived
 * from the total and the line's own rate rather than re-multiplied.
 */
function _lineNet(l) {
  const rate = Number(l.vat_pct) || 0;
  return calc.money(Number(l.line_total) / (1 + rate / 100));
}

/** Flip the cleared accruals to 'invoiced'; a row that moved under us is a conflict, not a silent skip. */
async function _markChargesInvoiced(conn, chargeIds, invoiceId) {
  if (!chargeIds.length) return;
  const [r] = await conn.query(
    `UPDATE purchase_receipt_charges SET status = 'invoiced', supplier_invoice_id = ?, updated_at = NOW()
      WHERE id IN (${chargeIds.map(() => '?').join(',')}) AND status = 'accrued'`,
    [invoiceId, ...chargeIds]);
  if (!r || r.affectedRows !== chargeIds.length) throw err('DOCUMENT_HAS_HISTORY', 'أحد مصاريف الاستيراد فُوتر في أثناء الاعتماد');
}

// ── POST / — create draft ────────────────────────────────────────────────────
router.post('/', requireCapability('supplier_invoices.create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.supplierId) throw err('VALIDATION_ERROR', 'المورد مطلوب');
    if (!b.supplierId) throw err('VALIDATION_ERROR', 'يجب اختيار مورد (لا يُسمح باسم حر)');
    const kind = b.invoiceKind === 'non_stock' ? 'non_stock' : 'stock';
    const standardRate = await cfg.standardVatRate(db);
    const rawLines = b.lines || b.items || [];
    if (!rawLines.length) throw err('VALIDATION_ERROR', 'الفاتورة تتطلب سطرًا واحدًا على الأقل');
    const computed = rawLines.map((l) => {
      const factor = Number(l.factor != null ? l.factor : l.conversionFactor) || 1;
      const c = calc.computeLine({
        enteredQty: l.enteredQty != null ? l.enteredQty : l.quantity, factor,
        unitPriceEntered: l.unitPriceEntered != null ? l.unitPriceEntered : l.unitPrice,
        discount: l.discount, vatRate: l.vatRate, taxCode: l.taxCode, inclusiveTax: l.inclusiveTax,
      }, standardRate);
      return Object.assign(c, {
        itemId: l.itemId || l.item_id || null, description: l.description || l.itemName || '',
        poLineId: l.poLineId || l.po_line_id || null, grnLineId: l.grnLineId || l.grn_line_id || null,
        accountId: l.accountId || l.account_id || null, accountCode: l.accountCode || null,
        // Landed cost: the import-charge accrual this line settles (or null).
        receiptChargeId: l.receiptChargeId || l.receipt_charge_id || null,
      });
    });
    const totals = calc.computeTotals(computed);
    const actor = H.actorOf(req);

    const out = await db.withTransaction(async (conn) => {
      const [s] = await conn.query('SELECT id, name, vat_number, is_active FROM suppliers WHERE id = ?', [b.supplierId]);
      if (!s.length) throw err('VALIDATION_ERROR', 'المورد غير موجود');
      // Vetted before anything is written: a charge that does not exist, is
      // already invoiced, or sits on an unposted receipt is a 4xx here, not a
      // surprise at approve.
      await _lockInvoiceableCharges(conn, computed.map((l) => l.receiptChargeId).filter(Boolean), null);
      const id = genId();
      const code = await nextNumber(conn, 'supplier_invoice');
      await conn.query(
        `INSERT INTO supplier_invoices
          (id, code, supplier_id, supplier_name, vat_number, invoice_no, issue_date, due_date,
           brand_id, branch_id, cost_center_id, warehouse_id, purchase_order_id, grn_id, currency,
           subtotal, discount_amount, vat_amount, total_amount, paid_amount, balance_amount,
           payment_terms, matching_status, status, invoice_kind, version, created_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,'unmatched','draft',?,1,?,?)`,
        [id, code, b.supplierId, s[0].name, s[0].vat_number || null, b.invoiceNo || null,
         b.issueDate || new Date().toISOString().slice(0, 10), b.dueDate || null,
         b.brandId || null, b.branchId || null, b.costCenterId || null, b.warehouseId || null,
         b.poId || null, b.grnId || null, b.currency || 'SAR',
         totals.subtotal, totals.discountAmount, totals.vatAmount, totals.total, totals.total,
         b.paymentTerms || null, kind, actor, H.idemOf(req)]);
      for (const l of computed) {
        await conn.query(
          `INSERT INTO supplier_invoice_lines
            (id, invoice_id, item_id, description, quantity, uom, unit_price, discount_pct, vat_pct, line_total,
             account_id, cost_center_id, po_line_id, grn_line_id, base_qty, base_unit_price, tax_code, inclusive_tax, receipt_charge_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [lineId(), id, l.itemId, l.description, l.enteredQty, null, l.unitPriceEntered, 0, l.vatRate, l.lineTotal,
           l.accountId, b.costCenterId || null, l.poLineId, l.grnLineId, l.baseQty, l.baseUnitPrice, l.taxCode, l.inclusiveTax ? 1 : 0,
           l.receiptChargeId]);
      }
      await events.recordEvent(conn, { documentType: 'supplier_invoice', documentId: id, action: 'create', toStatus: 'draft', actor });
      return { id, code };
    });
    return H.sendOk(res, { data: { id: out.id }, documentNumber: out.code, status: 'draft', version: 1 }, 201);
  } catch (e) { return H.sendErr(res, e); }
});

// ── GET / list ───────────────────────────────────────────────────────────────
router.get('/', requireCapability('procurement.view'), async (req, res) => {
  try {
    const p = H.listParams(req, Object.keys(SORTABLE), LIST_STATUSES);
    const where = [], params = [];
    if (p.status) { where.push('si.status = ?'); params.push(p.status); }
    if (p.supplierId) { where.push('si.supplier_id = ?'); params.push(p.supplierId); }
    if (p.q) { where.push('(si.invoice_no LIKE ? OR si.code LIKE ? OR si.supplier_name LIKE ?)'); params.push('%' + p.q + '%', '%' + p.q + '%', '%' + p.q + '%'); }
    if (p.dateFrom) { where.push('si.issue_date >= ?'); params.push(p.dateFrom); }
    if (p.dateTo) { where.push('si.issue_date <= ?'); params.push(p.dateTo); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = H.orderBy(p.sort, p.dir, SORTABLE, 'si.issue_date');
    const [rows] = await db.query(
      `SELECT si.id, si.code, si.invoice_no, si.supplier_id, si.supplier_name, si.issue_date, si.due_date,
              si.total_amount, si.paid_amount, si.balance_amount, si.matching_status, si.status, si.version
         FROM supplier_invoices si ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params.concat([p.pageSize, p.offset]));
    const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM supplier_invoices si ${whereSql}`, params);
    const [tot] = await db.query(`SELECT COALESCE(SUM(si.total_amount),0) AS total, COALESCE(SUM(si.balance_amount),0) AS balance FROM supplier_invoices si ${whereSql}`, params);
    return H.sendData(res, rows, {
      pagination: { page: p.page, pageSize: p.pageSize, total: Number(cnt[0].total), totalPages: Math.ceil(cnt[0].total / p.pageSize) },
      totals: { value: calc.money(tot[0].total), outstanding: calc.money(tot[0].balance) },
    });
  } catch (e) { return H.sendErr(res, e); }
});

router.get('/:id', requireCapability('procurement.view'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM supplier_invoices WHERE id = ?', [req.params.id]);
    if (!rows.length) throw err('NOT_FOUND', 'الفاتورة غير موجودة');
    const [lines] = await db.query('SELECT * FROM supplier_invoice_lines WHERE invoice_id = ? ORDER BY id', [req.params.id]);
    const [matches] = await db.query('SELECT * FROM supplier_invoice_matches WHERE invoice_id = ?', [req.params.id]);
    return H.sendData(res, Object.assign({}, rows[0], { lines, matches }));
  } catch (e) { return H.sendErr(res, e); }
});

// ── POST /:id/match — three-way match against receipt lines ──────────────────
router.post('/:id/match', requireCapability('supplier_invoices.create'), async (req, res) => {
  try {
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM supplier_invoices WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'الفاتورة غير موجودة');
      // `match` is a state-machine action even though it does not advance the
      // status.  Without this guard an approved invoice could be re-matched,
      // rewriting the evidence after its journal and receipt consumption.
      stateMachine.next('supplier_invoice', rows[0].status, 'match');
      const [lines] = await conn.query('SELECT * FROM supplier_invoice_lines WHERE invoice_id = ?', [req.params.id]);
      // Lock every referenced receipt line in deterministic order and prove
      // capacity across ALL other invoice matches before replacing this
      // invoice's prior draft matches.
      const plan = await matching.lockReceiptMatchPlan(conn, req.params.id, lines);
      await conn.query('DELETE FROM supplier_invoice_matches WHERE invoice_id = ?', [req.params.id]);
      await conn.query('UPDATE supplier_invoice_lines SET matched_qty = 0 WHERE invoice_id = ?', [req.params.id]);
      let anyVariance = false, matchedCount = 0;
      for (const candidate of plan) {
        const l = candidate.line;
        const rl = candidate.receipt;
        const invQty = candidate.matchedQty;
        const rcvCost = calc.rate(rl.base_unit_cost);
        const invPrice = calc.rate(l.base_unit_price);
        const matchedQty = invQty;
        const matchedAmount = calc.money(matchedQty * rcvCost);
        const priceVar = calc.money(matchedQty * (invPrice - rcvCost));
        const orderedQty = calc.qty(rl.base_qty);
        const qtyVar = calc.qty(invQty - orderedQty);
        const priceVarPct = rcvCost > 0 ? Math.abs((invPrice - rcvCost) / rcvCost) * 100 : 0;
        const qtyVarPct = orderedQty > 0 ? Math.abs(qtyVar / orderedQty) * 100 : 0;
        if (priceVarPct > PRICE_VAR_PCT || qtyVarPct > QTY_VAR_PCT) anyVariance = true;
        await conn.query(
          `INSERT INTO supplier_invoice_matches (id, invoice_id, invoice_line_id, po_line_id, receipt_line_id, matched_qty, matched_amount, price_variance, qty_variance, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [matchId(), req.params.id, l.id, rl.po_line_id, rl.id, matchedQty, matchedAmount, priceVar, qtyVar, H.actorOf(req)]);
        await conn.query('UPDATE supplier_invoice_lines SET matched_qty = ? WHERE id = ?', [matchedQty, l.id]);
        matchedCount++;
      }
      const status = matchedCount === 0 ? 'unmatched' : (anyVariance ? 'partial' : 'matched');
      const [agg] = await conn.query('SELECT COALESCE(SUM(matched_amount),0) AS m FROM supplier_invoice_matches WHERE invoice_id = ?', [req.params.id]);
      await conn.query('UPDATE supplier_invoices SET matching_status = ?, matched_amount = ? WHERE id = ?', [status, calc.money(agg[0].m), req.params.id]);
      await events.recordEvent(conn, { documentType: 'supplier_invoice', documentId: req.params.id, action: 'match', actor: H.actorOf(req), payload: { status, anyVariance } });
      return { status, anyVariance, matchedCount };
    });
    return H.sendOk(res, { data: out, status: 'draft' });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/submit', requireCapability('supplier_invoices.create'), async (req, res) => {
  try {
    const r = await runTransition({
      docType: 'supplier_invoice', table: 'supplier_invoices', id: req.params.id, action: 'submit',
      actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'submitted_by', at: 'submitted_at' },
      perform: async (conn, row) => {
        if (!row.invoice_no) throw err('VALIDATION_ERROR', 'رقم فاتورة المورد مطلوب قبل التقديم');
        const [dup] = await conn.query('SELECT id FROM supplier_invoices WHERE supplier_id = ? AND invoice_no = ? AND id <> ? AND status <> "cancelled" LIMIT 1', [row.supplier_id, row.invoice_no, row.id]);
        if (dup.length) throw err('DUPLICATE_SUPPLIER_INVOICE', 'رقم الفاتورة مكرر لنفس المورد');
        return {};
      },
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.code, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

// ── POST /:id/approve — post GRNI/AP GL ──────────────────────────────────────
router.post('/:id/approve', requireCapability('supplier_invoices.approve'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const r = await runTransition({
      docType: 'supplier_invoice', table: 'supplier_invoices', id: req.params.id, action: 'approve',
      actor, expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'approved_by', at: 'approved_at' },
      perform: async (conn, row) => {
        if (cfg.makerCheckerEnabled()) {
          const maker = row.submitted_by || row.created_by;
          if (maker && maker === actor) throw err('PERMISSION_DENIED', 'لا يمكن للمُنشئ اعتماد فاتورته (فصل المهام)');
        }
        // Landed cost: the lines that settle an import-charge accrual clear GRNI
        // at the ACCRUED value (what the receipt post credited); AP owes the
        // vendor what was billed. Re-vetted under lock — the receipt may have
        // been reversed, or the accrual invoiced elsewhere, since create.
        const [allLines] = await conn.query('SELECT id, line_total, vat_pct, receipt_charge_id FROM supplier_invoice_lines WHERE invoice_id = ?', [row.id]);
        const chargeLines = allLines.filter((l) => l.receipt_charge_id);
        const chargeRows = await _lockInvoiceableCharges(conn, chargeLines.map((l) => l.receipt_charge_id), row.id);
        const chargesClear = calc.money(chargeRows.reduce((s, c) => s + Number(c.amount), 0));
        // A pure charge invoice's net IS the header subtotal — no per-line
        // re-derivation that could drift from it by a rounding cent.
        const chargesNet = !chargeLines.length ? 0
          : (chargeLines.length === allLines.length ? calc.money(row.subtotal) : calc.money(chargeLines.reduce((s, l) => s + _lineNet(l), 0)));
        const charges = chargeRows.length ? { clear: chargesClear, invoiceNet: chargesNet } : null;
        let journalId;
        if (row.invoice_kind === 'non_stock') {
          const [lines] = await conn.query('SELECT account_id, line_total FROM supplier_invoice_lines WHERE invoice_id = ?', [row.id]);
          const byAcc = {};
          for (const l of lines) {
            let code = require('../../lib/glPosting').CORE_ACCOUNTS.COGS.code;
            if (l.account_id) {
              const [a] = await conn.query('SELECT code FROM gl_accounts WHERE id = ? LIMIT 1', [l.account_id]);
              if (a.length) code = a[0].code;
            }
            byAcc[code] = calc.money((byAcc[code] || 0) + Number(l.line_total) - 0);
          }
          // strip VAT from the expense (line_total includes VAT here) — approximate net by subtracting invoice VAT proportionally.
          // The charge lines' net is NOT an expense: it clears GRNI (see `charges`).
          journalId = await posting.postNonStockInvoice(conn, {
            invoice: Object.assign({}, row, { approved_by: actor }),
            expenseByAccount: { [require('../../lib/glPosting').CORE_ACCOUNTS.COGS.code]: calc.money(Number(row.subtotal) - chargesNet) },
            vat: calc.money(row.vat_amount),
            charges,
          });
        } else {
          const [agg] = await conn.query('SELECT COALESCE(SUM(matched_amount),0) AS m FROM supplier_invoice_matches WHERE invoice_id = ?', [row.id]);
          let grniClear = calc.money(agg[0].m);
          // no receipt link → clear the full GOODS net (direct stock invoice);
          // a pure charge-vendor invoice has no goods to clear at all.
          if (grniClear <= 0) grniClear = calc.money(Number(row.subtotal) - chargesNet);
          journalId = await posting.postStockInvoice(conn, { invoice: Object.assign({}, row, { approved_by: actor }), grniClear, vat: calc.money(row.vat_amount), chargesClear });
          // Re-lock and consume each receipt line independently. The
          // conditional update is the final guard against legacy corruption or
          // a future mutation bypassing the match-time reservation check.
          await matching.applyApprovedReceiptQuantities(conn, row.id);
        }
        await _markChargesInvoiced(conn, chargeRows.map((c) => c.id), row.id);
        return { extraSets: { gl_journal_id: journalId, posted_by: actor, posted_at: new Date() }, journalIds: [journalId] };
      },
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.code, status: r.toStatus, version: r.newVersion, journalIds: r.result.journalIds });
  } catch (e) { return H.sendErr(res, e); }
});

router.post('/:id/cancel', requireCapability('supplier_invoices.create'), async (req, res) => {
  try {
    const r = await runTransition({
      docType: 'supplier_invoice', table: 'supplier_invoices', id: req.params.id, action: 'cancel',
      actor: H.actorOf(req), expectedVersion: H.expectedVersionOf(req), idempotencyKey: H.idemOf(req),
      actorColumns: { by: 'cancelled_by', at: 'cancelled_at' },
      perform: async (conn, row) => {
        if (['approved', 'partially_paid', 'paid'].includes(row.status)) throw err('DOCUMENT_HAS_HISTORY', 'لا يمكن إلغاء فاتورة معتمدة — استخدم إشعار دائن');
        // Draft matches reserve receipt capacity. Releasing a draft/pending
        // invoice must release those reservations atomically with cancellation.
        await conn.query('DELETE FROM supplier_invoice_matches WHERE invoice_id = ?', [row.id]);
        await conn.query('UPDATE supplier_invoice_lines SET matched_qty = 0 WHERE invoice_id = ?', [row.id]);
        return { extraSets: { matching_status: 'unmatched', matched_amount: 0 } };
      },
    });
    return H.sendOk(res, { data: { id: req.params.id }, documentNumber: r.row.code, status: r.toStatus, version: r.newVersion });
  } catch (e) { return H.sendErr(res, e); }
});

// ── POST /:id/credit-note — reverse an approved invoice via credit note ──────
router.post('/:id/credit-note', requireCapability('supplier_invoices.credit'), async (req, res) => {
  try {
    const actor = H.actorOf(req);
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM supplier_invoices WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw err('NOT_FOUND', 'الفاتورة غير موجودة');
      const inv = rows[0];
      if (!['approved', 'partially_paid'].includes(inv.status)) throw err('INVALID_STATE_TRANSITION', 'إشعار دائن يتطلب فاتورة معتمدة غير مسددة كليًا');
      const [alloc] = await conn.query('SELECT COALESCE(SUM(allocated_amount),0) AS a FROM payment_allocations WHERE supplier_invoice_id = ? AND reversed = 0', [inv.id]);
      if (Number(alloc[0].a) > 0) throw err('DOCUMENT_HAS_HISTORY', 'توجد مدفوعات مخصصة — اعكس السداد أولًا');
      let journalId = null;
      if (inv.gl_journal_id) {
        journalId = await posting.postReversal(conn, { originalJournalId: inv.gl_journal_id, referenceType: 'SupplierInvoice', referenceId: inv.id, actor, dateYMD: acctDate.journalDate(), description: 'إشعار دائن للفاتورة ' + (inv.invoice_no || inv.code) });
      }
      await matching.releaseApprovedReceiptQuantities(conn, inv.id);
      // Landed cost: the reversal above re-credited GRNI, so the import-charge
      // accruals this invoice had cleared are open again — release them, or
      // they can never be invoiced and their receipt can never be reversed.
      await conn.query(
        "UPDATE purchase_receipt_charges SET status = 'accrued', supplier_invoice_id = NULL, updated_at = NOW() WHERE supplier_invoice_id = ? AND status = 'invoiced'",
        [inv.id]);
      await conn.query('DELETE FROM supplier_invoice_matches WHERE invoice_id = ?', [inv.id]);
      await conn.query('UPDATE supplier_invoice_lines SET matched_qty = 0 WHERE invoice_id = ?', [inv.id]);
      await conn.query('UPDATE supplier_invoices SET status = "cancelled", version = version + 1, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?', [actor, inv.id]);
      await events.recordEvent(conn, { documentType: 'supplier_invoice', documentId: inv.id, action: 'credit_note', fromStatus: inv.status, toStatus: 'cancelled', actor, glJournalId: journalId });
      return { journalId };
    });
    return H.sendOk(res, { data: { id: req.params.id }, status: 'cancelled', journalIds: out.journalId ? [out.journalId] : [] });
  } catch (e) { return H.sendErr(res, e); }
});


router.get('/:id/timeline', requireCapability('procurement.view'), async (req, res) => {
  try { return H.sendData(res, await events.timeline(db, 'supplier_invoice', req.params.id)); }
  catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
