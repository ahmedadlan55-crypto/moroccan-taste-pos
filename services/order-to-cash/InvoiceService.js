/**
 * services/order-to-cash/InvoiceService.js — customer invoices = the single AR
 * source of truth (ar_documents). Manual / contract invoices post their own GL
 * (Dr AR / Cr Revenue / Cr Output VAT [+ COGS/Inventory]) at ISSUE; POS sales are
 * LINKED to their already-posted 'Sale' journal (no double post). An issued
 * invoice is IMMUTABLE — a correction is a credit note, never an edit.
 *
 * Numbers/GL/ZATCA are all produced inside ONE transaction via the shared
 * TransitionExecutor, so a failure rolls the whole issue back atomically.
 */
'use strict';

const db = require('../../db/connection');
const { err } = require('../../lib/order-to-cash/errors');
const calc = require('../../lib/order-to-cash/calculations');
const { nextNumber } = require('../../lib/order-to-cash/numbering');
const posting = require('../../lib/order-to-cash/posting');
const { standardVatRate } = require('../../lib/order-to-cash/config');
const events = require('../../lib/order-to-cash/events');
const { runTransition } = require('./TransitionExecutor');
const Zatca = require('./ZatcaDocumentService');
const CreditLimitService = require('./CreditLimitService');

const money = calc.money;
function genId() { return 'AR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function lineId() { return 'ARL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

/** Compute lines + totals from raw input (server-authoritative — never trusts client totals). */
async function _computeDoc(conn, data) {
  const std = await standardVatRate(conn);
  const rawLines = Array.isArray(data.lines) ? data.lines : [];
  if (!rawLines.length) throw err('VALIDATION_ERROR', 'الفاتورة يجب أن تحتوي سطرًا واحدًا على الأقل');
  const computed = rawLines.map((l) => {
    const c = calc.computeLine({
      enteredQty: l.enteredQty != null ? l.enteredQty : l.qty,
      factor: l.factor != null ? l.factor : l.conversionFactor,
      unitPriceEntered: l.unitPrice != null ? l.unitPrice : l.unitPriceEntered,
      discount: l.discount,
      vatRate: l.vatRate,
      vatCategory: l.vatCategory,
      inclusiveTax: l.inclusiveTax,
    }, std);
    return Object.assign({}, c, {
      itemId: l.itemId || null, menuId: l.menuId || null,
      description: l.description || null,
      enteredUnitId: l.enteredUnitId || null, enteredUnitCode: l.enteredUnitCode || null,
      revenueAccountId: l.revenueAccountId || null, revenueAccountCode: l.revenueAccountCode || null,
      warehouseId: l.warehouseId || null,
      costSnapshot: money(l.costSnapshot || 0),
    });
  });
  const totals = calc.computeTotals(computed);
  return { computed, totals };
}

/** Create a draft invoice (manual / contract). POS invoices use linkPosSale instead. */
async function createDraft(conn, data, actor) {
  const { computed, totals } = await _computeDoc(conn, data);
  const id = genId();
  const issueDate = calc.ymd(data.issueDate);
  let dueDate = data.dueDate ? calc.ymd(data.dueDate) : null;
  // derive due date from customer terms when a credit invoice omits it
  if (!dueDate && data.customerId) {
    const [c] = await conn.query('SELECT credit_days FROM customers WHERE id = ? LIMIT 1', [data.customerId]);
    if (c.length && Number(c[0].credit_days) > 0) dueDate = calc.addDays(issueDate, Number(c[0].credit_days));
  }
  await conn.query(
    `INSERT INTO ar_documents
       (id, document_number, document_type, source_type, source_id, customer_id, customer_name,
        brand_id, branch_id, warehouse_id, channel_id, issue_date, due_date, currency,
        subtotal, discount_amount, vat_amount, total_amount, paid_amount, balance_amount,
        status, zatca_status, version, idempotency_key, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'draft','pending',1,?,?,?)`,
    [id, 'DRAFT-' + id.slice(-8), data.documentType || 'invoice', data.sourceType || 'manual', data.sourceId || null,
     data.customerId || null, data.customerName || null, data.brandId || null, data.branchId || null,
     data.warehouseId || null, data.channelId || null, issueDate, dueDate, data.currency || 'SAR',
     totals.subtotal, totals.discountAmount, totals.vatAmount, totals.total, totals.total,
     data.idempotencyKey || null, data.notes || null, actor || '']);
  for (const l of computed) {
    await conn.query(
      `INSERT INTO ar_document_lines
        (id, document_id, source_line_id, item_id, menu_id, description, entered_unit_id, entered_unit_code,
         entered_qty, conversion_factor_snapshot, base_qty, unit_price, discount_amount, vat_category, vat_rate,
         net_amount, vat_amount, gross_amount, revenue_account_id, revenue_account_code, warehouse_id, cost_snapshot)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lineId(), id, l.sourceLineId || null, l.itemId, l.menuId, l.description, l.enteredUnitId, l.enteredUnitCode,
       l.enteredQty, l.factor, l.baseQty, l.unitPriceEntered, l.discountAmount, l.vatCategory, l.vatRate,
       l.netAmount, l.vatAmount, l.grossAmount, l.revenueAccountId, l.revenueAccountCode, l.warehouseId, l.costSnapshot]);
  }
  return getWithLines(conn, id);
}

/** Issue a draft invoice: number + credit gate + ZATCA stamp + GL post, atomically. */
async function issue(id, ctx) {
  return runTransition({
    docType: 'ar_document', table: 'ar_documents', id, action: 'issue',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey,
    actorColumns: { by: 'issued_by', at: 'issued_at' },
    perform: async (conn, row) => {
      if (row.source_type === 'pos' && row.gl_journal_id) {
        // POS invoice already carries its sale journal — issue only stamps/links, never re-posts GL.
      }
      const [lines] = await conn.query('SELECT * FROM ar_document_lines WHERE document_id = ?', [id]);
      // credit gate for on-account issue (customer + due date in the future vs terms)
      if (ctx.enforceCredit && row.customer_id) {
        await CreditLimitService.enforce(conn, {
          customerId: row.customer_id, creditAmount: money(row.total_amount), issueDate: row.issue_date,
          override: ctx.override, hasOverrideCapability: ctx.hasOverrideCapability,
        });
      }
      // real ZATCA stamp
      const z = await Zatca.stamp(conn, { doc: row, lines });
      const number = row.document_number && !/^DRAFT-/.test(row.document_number)
        ? row.document_number : await nextNumber(conn, row.document_type === 'credit_note' ? 'credit_note' : 'invoice', row.issue_date);
      // GL — POS sales link the existing journal; manual/contract post now
      let journalId = row.gl_journal_id || null;
      if (row.source_type !== 'pos') {
        const net = money(row.subtotal);
        const vat = money(row.vat_amount);
        const cogs = money(lines.reduce((s, l) => s + Number(l.cost_snapshot || 0), 0));
        const revenueByAccount = {};
        for (const l of lines) {
          const code = l.revenue_account_code || '4100';
          revenueByAccount[code] = money((revenueByAccount[code] || 0) + Number(l.net_amount || 0));
        }
        journalId = await posting.postInvoice(conn, {
          doc: Object.assign({}, row, { document_number: number, issued_by: ctx.actor }),
          net, vat, cogs: money(cogs || 0), warehouseId: row.warehouse_id, revenueByAccount,
        });
      }
      return {
        extraSets: {
          document_number: number, gl_journal_id: journalId,
          zatca_uuid: z.uuid, zatca_hash: z.hash, zatca_status: z.status,
          balance_amount: money(row.total_amount), paid_amount: 0,
        },
        journalIds: journalId ? [journalId] : [],
        affectedValue: money(row.total_amount),
        payload: { documentNumber: number, zatcaStatus: z.status },
      };
    },
  });
}

/** Cancel a DRAFT invoice (issued invoices are immutable — use a credit note). */
async function cancel(id, ctx) {
  return runTransition({
    docType: 'ar_document', table: 'ar_documents', id, action: 'cancel',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey,
    actorColumns: { by: 'cancelled_by', at: 'cancelled_at' }, perform: async () => ({}),
  });
}

/**
 * Link a POS sale into ar_documents as an ISSUED invoice, referencing the sale's
 * existing 'Sale' GL journal — NO GL re-post (avoids double Revenue/VAT/COGS).
 * Idempotent via UNIQUE(source_type, source_id). Used by POS integration + backfill.
 */
async function linkPosSale(conn, sale, opts = {}) {
  const [exist] = await conn.query("SELECT id FROM ar_documents WHERE source_type='pos' AND source_id = ? LIMIT 1", [sale.id]);
  if (exist.length) return { id: exist[0].id, linked: true, replayed: true };
  const [jrows] = await conn.query("SELECT id FROM gl_journals WHERE reference_type = 'Sale' AND reference_id = ? LIMIT 1", [sale.id]);
  const journalId = jrows.length ? jrows[0].id : null;
  const id = genId();
  const total = money(sale.total_final);
  const vat = money(sale.vat_amount != null ? sale.vat_amount : 0);
  const subtotal = money(total - vat);
  const issueDate = calc.ymd(sale.order_date || sale.created_at);
  let dueDate = null;
  if (sale.customer_id) {
    const [c] = await conn.query('SELECT credit_days FROM customers WHERE id = ? LIMIT 1', [sale.customer_id]);
    if (c.length && Number(c[0].credit_days) > 0) dueDate = calc.addDays(issueDate, Number(c[0].credit_days));
  }
  await conn.query(
    `INSERT INTO ar_documents
       (id, document_number, document_type, source_type, source_id, customer_id, customer_name,
        brand_id, branch_id, issue_date, due_date, currency, subtotal, discount_amount, vat_amount,
        total_amount, paid_amount, balance_amount, status, zatca_status, zatca_uuid, zatca_hash,
        gl_journal_id, version, created_by, issued_by, issued_at)
     VALUES (?,?,?,'pos',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,NOW())`,
    [id, sale.invoice_number || sale.id, 'invoice', sale.id, sale.customer_id || null, null,
     sale.brand_id || null, sale.branch_id || null, issueDate, dueDate, 'SAR',
     subtotal, money(sale.discount_amount || 0), vat, total,
     (opts.paid != null ? money(opts.paid) : total), (opts.balance != null ? money(opts.balance) : 0),
     (opts.status || 'paid'), sale.zatca_status || 'pending', sale.invoice_uuid || null, sale.invoice_hash || null,
     journalId, opts.actor || 'backfill', opts.actor || 'backfill']);
  await events.recordEvent(conn, {
    documentType: 'ar_document', documentId: id, action: 'link_pos_sale', toStatus: (opts.status || 'paid'),
    actor: opts.actor || 'backfill', glJournalId: journalId, payload: { saleId: sale.id },
  });
  return { id, linked: true, journalId };
}

async function getWithLines(conn, id) {
  const [rows] = await conn.query('SELECT * FROM ar_documents WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw err('NOT_FOUND', 'الفاتورة غير موجودة');
  const [lines] = await conn.query('SELECT * FROM ar_document_lines WHERE document_id = ? ORDER BY id', [id]);
  return Object.assign({}, rows[0], { lines });
}

const SORTABLE = { issueDate: 'issue_date', total: 'total_amount', dueDate: 'due_date', status: 'status', number: 'document_number' };
const LIST_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'credited', 'closed', 'cancelled'];

async function list(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const sortCol = SORTABLE[params.sort] || 'issue_date';
  const dir = String(params.dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const where = ["document_type <> 'credit_note' OR ? = 1"];
  const args = [params.includeCreditNotes ? 1 : 0];
  if (params.status && LIST_STATUSES.includes(params.status)) { where.push('status = ?'); args.push(params.status); }
  if (params.customerId) { where.push('customer_id = ?'); args.push(String(params.customerId)); }
  if (params.sourceType) { where.push('source_type = ?'); args.push(String(params.sourceType)); }
  if (params.q) { where.push('(document_number LIKE ? OR customer_name LIKE ?)'); args.push('%' + params.q + '%', '%' + params.q + '%'); }
  const whereSql = 'WHERE ' + where.map((w) => '(' + w + ')').join(' AND ');
  const [rows] = await db.query(
    `SELECT id, document_number, document_type, source_type, customer_id, customer_name, issue_date, due_date,
            subtotal, vat_amount, total_amount, paid_amount, balance_amount, status, zatca_status, version
       FROM ar_documents ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
    args.concat([pageSize, offset]));
  const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM ar_documents ${whereSql}`, args);
  const total = Number(cnt[0].total);
  return { data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

module.exports = { createDraft, issue, cancel, linkPosSale, getWithLines, list, _computeDoc };
