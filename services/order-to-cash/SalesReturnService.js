/**
 * services/order-to-cash/SalesReturnService.js — partial, per-line sales returns
 * (spec §المرتجعات). A return references an original invoice (ar_document) and its
 * lines; each return line is bounded by return_qty ≤ sold_qty − previously_returned
 * and snapshots the original UoM / price / VAT / cost so amounts are proportional
 * and immune to later price changes.
 *
 * Posting (approved → posted) creates a credit_note ar_document linked to the
 * original, posts append-only GL (Dr Revenue + Dr Output VAT / Cr AR|Cash|Bank|
 * Deposit) via postCreditNote, and — for physically returnable lines (item_id +
 * warehouse) — restores stock AND reverses its cost (Dr Inventory / Cr COGS) so GL
 * value and physical quantity always move together. Reversal is append-only.
 * Legacy sale-reverse/return is gated (409) when the flag is on, so no dual-write.
 */
'use strict';

const db = require('../../db/connection');
const { err } = require('../../lib/order-to-cash/errors');
const calc = require('../../lib/order-to-cash/calculations');
const { nextNumber } = require('../../lib/order-to-cash/numbering');
const posting = require('../../lib/order-to-cash/posting');
const events = require('../../lib/order-to-cash/events');
const { runTransition } = require('./TransitionExecutor');
const Alloc = require('./PaymentAllocationService');

let recomputeInvItemStock;
try { recomputeInvItemStock = require('../../lib/stockRecompute').recomputeInvItemStock; }
catch (_) { recomputeInvItemStock = async () => {}; }

const money = calc.money;
const qty = calc.qty;
function genId() { return 'SRET-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function lineId() { return 'SRETL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function cnId() { return 'CN-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function mvId() { return 'MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

/** Resolve the original AR document (by id or by original sale id). */
async function _resolveOriginal(conn, data) {
  if (data.originalArDocumentId) {
    const [d] = await conn.query('SELECT * FROM ar_documents WHERE id = ? LIMIT 1', [data.originalArDocumentId]);
    if (d.length) return d[0];
  }
  if (data.originalSaleId) {
    const [d] = await conn.query("SELECT * FROM ar_documents WHERE source_type='pos' AND source_id = ? LIMIT 1", [data.originalSaleId]);
    if (d.length) return d[0];
  }
  throw err('NOT_FOUND', 'الفاتورة الأصلية للمرتجع غير موجودة');
}

/** Create a draft return with proportional, snapshot-based lines. */
async function create(conn, data, actor) {
  const original = await _resolveOriginal(conn, data);
  const [origLines] = await conn.query('SELECT * FROM ar_document_lines WHERE document_id = ?', [original.id]);
  const byId = {}; origLines.forEach((l) => { byId[l.id] = l; });
  const rawLines = Array.isArray(data.lines) ? data.lines : [];
  if (!rawLines.length) throw err('VALIDATION_ERROR', 'المرتجع يجب أن يحتوي سطرًا واحدًا على الأقل');

  // previously-returned qty per original line across posted/approved returns
  const [prev] = await conn.query(
    `SELECT srl.original_line_id, COALESCE(SUM(srl.return_qty),0) AS returned
       FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id
      WHERE sr.original_ar_document_id = ? AND sr.status NOT IN ('cancelled','reversed')
      GROUP BY srl.original_line_id`, [original.id]);
  const prevMap = {}; prev.forEach((r) => { prevMap[r.original_line_id] = Number(r.returned); });

  const computed = [];
  for (const rl of rawLines) {
    const ol = byId[rl.originalLineId];
    if (!ol) throw err('VALIDATION_ERROR', 'سطر أصلي غير موجود: ' + rl.originalLineId);
    const soldQty = qty(ol.entered_qty);
    const already = qty(prevMap[ol.id] || 0);
    const returnQty = qty(rl.returnQty);
    if (!(returnQty > 0)) throw err('VALIDATION_ERROR', 'كمية المرتجع يجب أن تكون موجبة');
    if (returnQty - (soldQty - already) > 0.0001) {
      throw err('OVER_RETURN', `كمية المرتجع (${returnQty}) تتجاوز المتاح (${qty(soldQty - already)}) للسطر`);
    }
    const fraction = soldQty > 0 ? returnQty / soldQty : 0;
    const net = money(Number(ol.net_amount) * fraction);
    const vat = money(Number(ol.vat_amount) * fraction);
    const cost = money(Number(ol.cost_snapshot) * fraction);
    const baseQty = qty(Number(ol.base_qty) * fraction);
    computed.push({
      originalLineId: ol.id, itemId: ol.item_id, menuId: ol.menu_id, description: ol.description,
      enteredUnitId: ol.entered_unit_id, enteredUnitCode: ol.entered_unit_code,
      conversionFactor: ol.conversion_factor_snapshot, baseQty,
      soldQty, previouslyReturned: already, returnQty,
      unitPrice: ol.unit_price, vatCategory: ol.vat_category, vatRate: ol.vat_rate,
      net, vat, gross: money(net + vat), cost,
      warehouseId: rl.warehouseId || ol.warehouse_id || original.warehouse_id,
      lotSnapshot: ol.lot_allocations_json || null,
    });
  }
  const subtotal = money(computed.reduce((s, l) => s + l.net, 0));
  const vatTotal = money(computed.reduce((s, l) => s + l.vat, 0));
  const costTotal = money(computed.reduce((s, l) => s + l.cost, 0));
  const total = money(subtotal + vatTotal);

  const id = genId();
  await conn.query(
    `INSERT INTO sales_returns
       (id, return_number, original_sale_id, original_ar_document_id, customer_id, customer_name,
        brand_id, branch_id, warehouse_id, return_date, reason, reason_code, refund_method, refund_destination_id,
        subtotal, vat_amount, total_amount, cost_total, status, version, idempotency_key, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?)`,
    [id, 'DRAFT-' + id.slice(-8), original.source_id || null, original.id, original.customer_id, original.customer_name,
     original.brand_id, original.branch_id, original.warehouse_id, calc.ymd(data.returnDate),
     data.reason || null, data.reasonCode || null, data.refundMethod || 'ar_reduction', data.refundDestinationId || null,
     subtotal, vatTotal, total, costTotal, data.idempotencyKey || null, actor || '']);
  for (const l of computed) {
    await conn.query(
      `INSERT INTO sales_return_lines
        (id, return_id, original_line_id, item_id, menu_id, description, sold_qty, previously_returned_qty,
         return_qty, entered_unit_id, entered_unit_code, conversion_factor_snapshot, base_qty, unit_price_snapshot,
         discount_snapshot, vat_category, vat_rate, net_amount, vat_amount, gross_amount, cost_snapshot, lot_allocations_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lineId(), id, l.originalLineId, l.itemId, l.menuId, l.description, l.soldQty, l.previouslyReturned,
       l.returnQty, l.enteredUnitId, l.enteredUnitCode, l.conversionFactor, l.baseQty, l.unitPrice,
       0, l.vatCategory, l.vatRate, l.net, l.vat, l.gross, l.cost, l.lotSnapshot]);
  }
  return getWithLines(conn, id);
}

async function approve(id, ctx) {
  return runTransition({
    docType: 'sales_return', table: 'sales_returns', id, action: 'approve',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey,
    actorColumns: { by: 'approved_by', at: 'approved_at' }, perform: async () => ({}),
  });
}

/** Post an approved return: credit note + append-only GL + stock restoration. */
async function post(id, ctx) {
  return runTransition({
    docType: 'sales_return', table: 'sales_returns', id, action: 'post',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey,
    actorColumns: { by: 'posted_by', at: 'posted_at' },
    perform: async (conn, row) => {
      const [lines] = await conn.query('SELECT * FROM sales_return_lines WHERE return_id = ?', [id]);
      // 1) create the credit_note ar_document linked to the original invoice
      const cnDocId = cnId();
      const cnNumber = await nextNumber(conn, 'credit_note', row.return_date);
      await conn.query(
        `INSERT INTO ar_documents
           (id, document_number, document_type, source_type, source_id, customer_id, customer_name,
            brand_id, branch_id, warehouse_id, issue_date, currency, subtotal, discount_amount, vat_amount,
            total_amount, paid_amount, balance_amount, status, zatca_status, gl_journal_id, original_document_id,
            version, created_by, issued_by, issued_at)
         VALUES (?,?,'credit_note','manual',?,?,?,?,?,?,?,'SAR',?,0,?,?,0,0,'issued','pending',NULL,?,1,?,?,NOW())`,
        [cnDocId, cnNumber, row.id, row.customer_id, row.customer_name, row.brand_id, row.branch_id, row.warehouse_id,
         row.return_date, money(row.subtotal), money(row.vat_amount), money(row.total_amount),
         row.original_ar_document_id, ctx.actor || '', ctx.actor || '']);

      // 2) physical stock restoration (only lines with item_id + warehouse) → accumulate restorable cost
      let restoredCost = 0;
      const affectedStock = [];
      for (const l of lines) {
        if (!l.item_id || !l.warehouse_id || !(Number(l.base_qty) > 0)) continue;
        const [ws] = await conn.query('SELECT id, qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ? LIMIT 1 FOR UPDATE', [l.warehouse_id, l.item_id]);
        if (ws.length) {
          await conn.query('UPDATE warehouse_stock SET qty = qty + ?, last_updated = NOW() WHERE id = ?', [qty(l.base_qty), ws[0].id]);
        } else {
          await conn.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_by) VALUES (?,?,?,?,?)',
            ['WS-' + mvId(), l.warehouse_id, l.item_id, qty(l.base_qty), ctx.actor || '']);
        }
        await conn.query(
          `INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id)
           VALUES (?, NOW(), ?, ?, 'in', ?, ?, ?, ?, ?, 'SalesReturn', ?)`,
          [mvId(), l.item_id, l.description || '', qty(l.base_qty), 'مرتجع بيع', ctx.actor || '', row.return_number, l.warehouse_id, row.id]);
        try { await recomputeInvItemStock(conn, l.item_id); } catch (_) { /* qty cache best-effort */ }
        restoredCost += Number(l.cost_snapshot || 0);
        affectedStock.push({ itemId: l.item_id, warehouseId: l.warehouse_id, qty: qty(l.base_qty) });
      }
      restoredCost = money(restoredCost);

      // 3) GL — revenue + VAT reversal + refund leg; cost reversal only for physically restored qty
      const journalId = await posting.postCreditNote(conn, {
        ret: Object.assign({}, row, { posted_by: ctx.actor }),
        net: money(row.subtotal), vat: money(row.vat_amount), cost: restoredCost, warehouseId: row.warehouse_id,
      });
      await conn.query('UPDATE ar_documents SET gl_journal_id = ? WHERE id = ?', [journalId, cnDocId]);

      // 4) AR-reduction refund: the CN credits GL AR (postCreditNote → Cr AR), so the
      //    original invoice's subledger balance MUST drop by the same amount to stay
      //    tied to the GL. Cash/bank/deposit refunds don't touch AR → no change here.
      if (String(row.refund_method) === 'ar_reduction' && row.original_ar_document_id) {
        const [orig] = await conn.query(
          'SELECT id, total_amount, paid_amount, balance_amount, status FROM ar_documents WHERE id = ? FOR UPDATE', [row.original_ar_document_id]);
        if (orig.length && !['cancelled', 'draft'].includes(String(orig[0].status))) {
          const cnTotal = money(row.total_amount);
          const curBalance = money(orig[0].balance_amount);
          const applied = money(Math.min(cnTotal, Math.max(0, curBalance)));
          const newPaid = money(Number(orig[0].paid_amount) + applied);   // settled = cash + credit memo
          const newBalance = money(Number(orig[0].total_amount) - newPaid);
          const status = newBalance <= 0.01
            ? (applied >= curBalance && curBalance > 0 ? 'credited' : 'paid')
            : 'partially_paid';
          await conn.query(
            'UPDATE ar_documents SET paid_amount = ?, balance_amount = ?, status = ?, version = version + 1 WHERE id = ?',
            [newPaid, Math.max(0, newBalance), status, row.original_ar_document_id]);
        }
      }
      return {
        extraSets: { credit_note_id: cnDocId, journal_id: journalId },
        journalIds: [journalId], affectedStock, affectedValue: money(row.total_amount),
        payload: { creditNoteId: cnDocId, creditNoteNumber: cnNumber, restoredCost },
      };
    },
  });
}

/** Reverse a posted return: append-only reversal journal + stock re-deduction. */
async function reverse(id, ctx) {
  return runTransition({
    docType: 'sales_return', table: 'sales_returns', id, action: 'reverse',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey,
    actorColumns: { by: 'reversed_by', at: 'reversed_at' },
    perform: async (conn, row) => {
      const journalIds = [];
      if (row.journal_id) {
        journalIds.push(await posting.postReversal(conn, {
          originalJournalId: row.journal_id, referenceType: 'SalesReturn', referenceId: row.id, actor: ctx.actor, dateYMD: calc.ymd(ctx.date),
        }));
      }
      // re-deduct the restored stock
      const [lines] = await conn.query('SELECT * FROM sales_return_lines WHERE return_id = ?', [id]);
      for (const l of lines) {
        if (!l.item_id || !l.warehouse_id || !(Number(l.base_qty) > 0)) continue;
        await conn.query('UPDATE warehouse_stock SET qty = qty - ?, last_updated = NOW() WHERE warehouse_id = ? AND item_id = ?', [qty(l.base_qty), l.warehouse_id, l.item_id]);
        await conn.query(
          `INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id)
           VALUES (?, NOW(), ?, ?, 'out', ?, ?, ?, ?, ?, 'SalesReturnReversal', ?)`,
          [mvId(), l.item_id, l.description || '', qty(l.base_qty), 'عكس مرتجع بيع', ctx.actor || '', row.return_number, l.warehouse_id, row.id]);
        try { await recomputeInvItemStock(conn, l.item_id); } catch (_) {}
      }
      // mark the credit note as cancelled (it no longer represents a live document)
      if (row.credit_note_id) await conn.query("UPDATE ar_documents SET status='cancelled', version=version+1 WHERE id = ?", [row.credit_note_id]);
      return { extraSets: { reversal_journal_id: journalIds[0] || null }, journalIds };
    },
  });
}

async function cancel(id, ctx) {
  return runTransition({
    docType: 'sales_return', table: 'sales_returns', id, action: 'cancel',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey,
    perform: async () => ({}),
  });
}

async function getWithLines(conn, id) {
  const [rows] = await conn.query('SELECT * FROM sales_returns WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw err('NOT_FOUND', 'المرتجع غير موجود');
  const [lines] = await conn.query('SELECT * FROM sales_return_lines WHERE return_id = ? ORDER BY id', [id]);
  return Object.assign({}, rows[0], { lines });
}

const SORTABLE = { returnDate: 'return_date', total: 'total_amount', status: 'status', number: 'return_number' };
const LIST_STATUSES = ['draft', 'approved', 'posted', 'reversed', 'cancelled'];

async function list(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const sortCol = SORTABLE[params.sort] || 'return_date';
  const dir = String(params.dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const where = ['1=1']; const args = [];
  if (params.status && LIST_STATUSES.includes(params.status)) { where.push('status = ?'); args.push(params.status); }
  if (params.customerId) { where.push('customer_id = ?'); args.push(String(params.customerId)); }
  if (params.q) { where.push('return_number LIKE ?'); args.push('%' + params.q + '%'); }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const [rows] = await db.query(
    `SELECT id, return_number, original_ar_document_id, customer_id, customer_name, return_date,
            subtotal, vat_amount, total_amount, refund_method, status, credit_note_id, version
       FROM sales_returns ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
    args.concat([pageSize, offset]));
  const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM sales_returns ${whereSql}`, args);
  const total = Number(cnt[0].total);
  return { data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

module.exports = { create, approve, post, reverse, cancel, getWithLines, list };
