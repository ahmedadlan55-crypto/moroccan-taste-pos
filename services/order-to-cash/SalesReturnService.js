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
const Zatca = require('./ZatcaDocumentService');

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
  // Sequential same-key retry replays the existing draft instead of creating a
  // twin; same key + different payload is a 409 (thrown by findPrior). The
  // PARALLEL race is handled at the route via ER_DUP_ENTRY + a pool re-check.
  const prior = await events.findPrior(conn, 'sales_return', 'create', '', data.idempotencyKey, data.requestHash);
  if (prior) return getWithLines(conn, prior.entity_id);

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
    // Whether the goods physically come back. Not derivable from the item: only
    // the person holding it knows. Absent ⇒ false, matching the column default.
    const restock = rl.restock === true || rl.restock === 1 || rl.restock === '1';
    // Restocking moves stock and reverses COGS, so it is an authorised decision,
    // not a checkbox: the route gates it on returns.restock (a cashier may raise
    // the return but not rule that a prepared meal is resellable), and the
    // reason is mandatory because `restock` alone records the outcome without
    // the grounds. created_by is the raiser, so the decider is stamped here.
    const restockReason = String(rl.restockReason || '').trim();
    if (restock && !data.canRestock) {
      throw err('PERMISSION_DENIED', 'إعادة المرتجع للمخزون تحتاج صلاحية مدير');
    }
    if (restock && !restockReason) {
      throw err('VALIDATION_ERROR', `سبب إعادة السطر للمخزون مطلوب (${ol.description || ol.id})`);
    }
    // The components this line deducted at checkout, scaled to the returned
    // fraction. Read from the ORIGINAL line's snapshot, never from the live
    // recipe — a reformulated recipe would restock quantities never deducted.
    const [origComps] = await conn.query(
      'SELECT * FROM ar_document_line_components WHERE document_line_id = ? ORDER BY component_seq', [ol.id]);
    // A lot/expiry-tracked item leaves stock through lotLedger.allocateOutbound,
    // which picks specific lots — but the component snapshot records only item,
    // warehouse and quantity, never WHICH lot. Restoring it would add quantity
    // to warehouse_stock that no lot balance accounts for, silently breaking the
    // Σ(lot balances) = warehouse_stock invariant that assertInvariant enforces.
    // Refuse rather than corrupt the ledger; no_restock is always available.
    if (restock && origComps.length) {
      const ids = [...new Set(origComps.map((c) => c.inv_item_id).filter(Boolean))];
      if (ids.length) {
        const [tracked] = await conn.query(
          `SELECT id, name, tracking_mode FROM inv_items
            WHERE id IN (${ids.map(() => '?').join(',')}) AND tracking_mode IS NOT NULL AND tracking_mode <> 'none'`, ids);
        if (tracked.length) {
          throw err('VALIDATION_ERROR',
            `لا يمكن إعادة مكوّن متتبَّع بالتشغيلة للمخزون (${tracked.map((t) => t.name || t.id).join('، ')}) — ` +
            'اللقطة لا تحفظ رقم التشغيلة الأصلية. اختر «بدون إعادة للمخزون».');
        }
      }
    }
    const components = origComps.map((c) => ({
      seq: c.component_seq, source: c.source, invItemId: c.inv_item_id, invItemName: c.inv_item_name,
      // Component-level warehouse: the header's is NULL on every live return and
      // one line's components can span warehouses.
      warehouseId: c.warehouse_id || rl.warehouseId || ol.warehouse_id || original.warehouse_id || null,
      restoredBaseQty: qty(Number(c.deducted_base_qty) * fraction),
      unitCode: c.unit_code, conversionFactor: c.conversion_factor,
      unitCostSnapshot: c.unit_cost_snapshot, totalCost: money(Number(c.total_cost) * fraction),
      projectionVersion: c.projection_version,
    }));
    computed.push({
      originalLineId: ol.id, itemId: ol.item_id, menuId: ol.menu_id, description: ol.description,
      enteredUnitId: ol.entered_unit_id, enteredUnitCode: ol.entered_unit_code,
      conversionFactor: ol.conversion_factor_snapshot, baseQty,
      soldQty, previouslyReturned: already, returnQty,
      unitPrice: ol.unit_price, vatCategory: ol.vat_category, vatRate: ol.vat_rate,
      net, vat, gross: money(net + vat), cost, restock, restockReason, components,
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
    const rlId = lineId();
    await conn.query(
      `INSERT INTO sales_return_lines
        (id, return_id, original_line_id, item_id, menu_id, description, sold_qty, previously_returned_qty,
         return_qty, entered_unit_id, entered_unit_code, conversion_factor_snapshot, base_qty, unit_price_snapshot,
         discount_snapshot, vat_category, vat_rate, net_amount, vat_amount, gross_amount, cost_snapshot,
         lot_allocations_json, warehouse_id, restock, restock_reason, restock_by, restock_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rlId, id, l.originalLineId, l.itemId, l.menuId, l.description, l.soldQty, l.previouslyReturned,
       l.returnQty, l.enteredUnitId, l.enteredUnitCode, l.conversionFactor, l.baseQty, l.unitPrice,
       0, l.vatCategory, l.vatRate, l.net, l.vat, l.gross, l.cost, l.lotSnapshot,
       l.warehouseId || null, l.restock ? 1 : 0,
       // A no_restock line has no decision, so it carries no decider or reason.
       l.restock ? l.restockReason : null,
       l.restock ? (actor || '') : null,
       l.restock ? new Date() : null]);
    for (const c of l.components) {
      await conn.query(
        `INSERT INTO sales_return_line_components
          (id, return_id, return_line_id, component_seq, source, inv_item_id, inv_item_name, warehouse_id,
           restored_base_qty, unit_code, conversion_factor, unit_cost_snapshot, total_cost, projection_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['SRLC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), id, rlId, c.seq, c.source,
         c.invItemId, c.invItemName, c.warehouseId, c.restoredBaseQty, c.unitCode, c.conversionFactor,
         c.unitCostSnapshot, c.totalCost, c.projectionVersion]);
    }
  }
  // The create event is the idempotency record (scope sales_return:create: +
  // request_hash); its UNIQUE is also the backstop the parallel-race recovery
  // reads after ER_DUP_ENTRY.
  await events.recordEvent(conn, {
    documentType: 'sales_return', documentId: id, action: 'create', toStatus: 'draft',
    actor, idempotencyKey: data.idempotencyKey || null, requestHash: data.requestHash || null,
    payload: { returnNumber: 'DRAFT-' + id.slice(-8) },
  });
  return getWithLines(conn, id);
}

/**
 * What a restock line puts back on the shelf. Components first: a POS line sells a
 * menu item but deducts inv_items, so the components ARE the stock movement. Lines
 * with no components (manual invoices sell an inv_item directly) fall back to the
 * line's own item. `direction` is +1 on post and −1 on reverse, so a reversal can
 * never re-deduct stock a no_restock line never restored.
 */
async function _restore(conn, row, lines, actor, direction = 1) {
  const wanted = lines.filter((l) => Number(l.restock) === 1);
  const out = { restoredCost: 0, affectedStock: [], cogsByWarehouse: {} };
  if (!wanted.length) return out;                                  // no_restock ⇒ zero stock, zero COGS

  const [comps] = await conn.query(
    `SELECT * FROM sales_return_line_components WHERE return_line_id IN (${wanted.map(() => '?').join(',')})
      ORDER BY return_line_id, component_seq`, wanted.map((l) => l.id));
  const byLine = {};
  comps.forEach((c) => { (byLine[c.return_line_id] = byLine[c.return_line_id] || []).push(c); });

  const moves = [];
  for (const l of wanted) {
    const cs = byLine[l.id] || [];
    if (cs.length) {
      for (const c of cs) {
        if (!c.inv_item_id || !c.warehouse_id) {
          // Do NOT skip. The operator asked for a restock and we cannot honour it;
          // silently continuing is exactly the bug that made this branch dead.
          throw err('VALIDATION_ERROR',
            `مكوّن بلا صنف أو مستودع في السطر ${l.id} — لا يمكن إعادة المخزون (component_seq ${c.component_seq})`);
        }
        if (!(Number(c.restored_base_qty) > 0)) continue;           // a zero-qty component moves nothing
        moves.push({ itemId: c.inv_item_id, itemName: c.inv_item_name || l.description || '',
          warehouseId: c.warehouse_id, baseQty: qty(c.restored_base_qty), cost: money(c.total_cost || 0) });
      }
    } else if (l.item_id && l.warehouse_id && Number(l.base_qty) > 0) {
      moves.push({ itemId: l.item_id, itemName: l.description || '', warehouseId: l.warehouse_id,
        baseQty: qty(l.base_qty), cost: money(l.cost_snapshot || 0) });
    } else {
      throw err('VALIDATION_ERROR',
        `السطر ${l.id} مطلوب إعادته للمخزون لكن لا توجد له لقطة مكوّنات ولا صنف/مستودع مباشر`);
    }
  }

  for (const m of moves) {
    const delta = direction > 0 ? m.baseQty : -m.baseQty;
    const [ws] = await conn.query(
      'SELECT id, qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ? LIMIT 1 FOR UPDATE',
      [m.warehouseId, m.itemId]);
    if (ws.length) {
      await conn.query('UPDATE warehouse_stock SET qty = qty + ?, last_updated = NOW() WHERE id = ?', [delta, ws[0].id]);
    } else {
      await conn.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_by) VALUES (?,?,?,?,?)',
        ['WS-' + mvId(), m.warehouseId, m.itemId, delta, actor]);
    }
    await conn.query(
      `INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id)
       VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [mvId(), m.itemId, m.itemName, direction > 0 ? 'in' : 'out', m.baseQty,
       direction > 0 ? 'مرتجع بيع' : 'عكس مرتجع بيع', actor, row.return_number, m.warehouseId,
       direction > 0 ? 'SalesReturn' : 'SalesReturnReversal', row.id]);
    // The qty cache is derived data; a failure here means it disagrees with the
    // movements, which is a real defect — do not swallow it into a silent drift.
    await recomputeInvItemStock(conn, m.itemId);
    out.restoredCost += m.cost;
    out.cogsByWarehouse[m.warehouseId] = money((out.cogsByWarehouse[m.warehouseId] || 0) + m.cost);
    out.affectedStock.push({ itemId: m.itemId, warehouseId: m.warehouseId, qty: m.baseQty });
  }
  out.restoredCost = money(out.restoredCost);
  return out;
}

async function approve(id, ctx) {
  return runTransition({
    docType: 'sales_return', table: 'sales_returns', id, action: 'approve',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'approved_by', at: 'approved_at' },
    perform: async (conn, row) => {
      // Separation of duties. The capability gate proves the actor MAY approve
      // returns; it cannot know they are approving their OWN. A manager holds
      // both returns.create and returns.approve, so without this one person can
      // raise a return crediting a customer and approve it unreviewed — the
      // control the draft→approved step exists to provide. Checked here rather
      // than at the route because `row` is already locked FOR UPDATE, so the
      // creator cannot change under the check.
      if (row.created_by && ctx.actor && String(row.created_by) === String(ctx.actor)) {
        throw err('SOD_VIOLATION', 'لا يمكنك اعتماد مرتجع أنشأته بنفسك — يلزم اعتماد شخص آخر');
      }
      return {};
    },
  });
}

/** Post an approved return: credit note + append-only GL + stock restoration. */
async function post(id, ctx) {
  return runTransition({
    docType: 'sales_return', table: 'sales_returns', id, action: 'post',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'posted_by', at: 'posted_at' },
    perform: async (conn, row) => {
      const [lines] = await conn.query('SELECT * FROM sales_return_lines WHERE return_id = ? ORDER BY id', [id]);
      if (!lines.length) throw err('VALIDATION_ERROR', 'لا يمكن ترحيل مرتجع بلا أسطر');

      // The revenue account each original line credited. The credit note must
      // debit THAT account, not a global default: an invoice whose revenue was
      // split across accounts would otherwise never net back to zero.
      const revByOrig = {};
      const origIds = lines.map((l) => l.original_line_id).filter(Boolean);
      if (origIds.length) {
        const [o] = await conn.query(
          `SELECT id, revenue_account_id, revenue_account_code FROM ar_document_lines WHERE id IN (${origIds.map(() => '?').join(',')})`, origIds);
        o.forEach((x) => { revByOrig[x.id] = x; });
      }

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

      // 2) the credit note's LINES. These were never written: every credit note
      //    ever posted is a header with a total and nothing under it — unprintable,
      //    un-auditable, and unstampable (ZATCA needs lines). source_line_id is the
      //    return line's id: stable, replay-safe, and honours uq_arl_doc_srcline.
      for (const l of lines) {
        const rev = revByOrig[l.original_line_id] || {};
        await conn.query(
          `INSERT INTO ar_document_lines
            (id, document_id, source_line_id, item_id, menu_id, description, entered_unit_id, entered_unit_code,
             entered_qty, conversion_factor_snapshot, base_qty, unit_price, discount_amount, vat_category, vat_rate,
             net_amount, vat_amount, gross_amount, revenue_account_id, revenue_account_code, warehouse_id,
             cost_snapshot, projection_version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
           ON DUPLICATE KEY UPDATE id = id`,
          ['ARL-' + mvId(), cnDocId, l.id, l.item_id, l.menu_id, l.description, l.entered_unit_id,
           l.entered_unit_code, qty(l.return_qty), l.conversion_factor_snapshot, qty(l.base_qty),
           l.unit_price_snapshot, 0, l.vat_category, l.vat_rate, money(l.net_amount), money(l.vat_amount),
           money(l.gross_amount), rev.revenue_account_id || null, rev.revenue_account_code || null,
           l.warehouse_id || null, money(l.cost_snapshot)]);
      }

      // 3) REAL ZATCA stamp — mirrors InvoiceService.issue. A credit note is a
      //    Type-381 document; leaving it 'pending' with no uuid/hash was not a
      //    conservative default, it was an unstamped document.
      const [cnRows] = await conn.query('SELECT * FROM ar_documents WHERE id = ? LIMIT 1', [cnDocId]);
      const [cnLines] = await conn.query('SELECT * FROM ar_document_lines WHERE document_id = ?', [cnDocId]);
      const z = await Zatca.stamp(conn, { doc: cnRows[0], lines: cnLines });
      await conn.query(
        'UPDATE ar_documents SET zatca_uuid = ?, zatca_hash = ?, zatca_status = ?, zatca_qr_base64 = ? WHERE id = ?',
        [z.uuid, z.hash, z.status, z.qr, cnDocId]);

      // 4) physical stock restoration — ONLY for lines the operator marked restock,
      //    and ONLY from the checkout component snapshot. A POS line is a menu item
      //    (a burger); what left the shelf were its components (bun, patty). The old
      //    code tested l.warehouse_id, a column that did not exist, so it skipped
      //    every line on every return — restock and the COGS reversal have never run.
      const { restoredCost, affectedStock, cogsByWarehouse } = await _restore(conn, row, lines, ctx.actor || '');

      // 5) GL — revenue + VAT reversal + refund leg; cost reversal only for what
      //    physically came back, split per warehouse so the inventory legs land on
      //    the same dimension the sale credited.
      const revenueByAccount = {};
      for (const l of lines) {
        const code = (revByOrig[l.original_line_id] || {}).revenue_account_code || '';
        revenueByAccount[code] = money((revenueByAccount[code] || 0) + Number(l.net_amount || 0));
      }
      const { journalId, cogsJournalId } = await posting.postCreditNote(conn, {
        ret: Object.assign({}, row, { posted_by: ctx.actor }),
        net: money(row.subtotal), vat: money(row.vat_amount), cost: restoredCost,
        warehouseId: row.warehouse_id, revenueByAccount, cogsByWarehouse,
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
        extraSets: { credit_note_id: cnDocId, journal_id: journalId, cogs_journal_id: cogsJournalId },
        journalIds: cogsJournalId ? [journalId, cogsJournalId] : [journalId],
        affectedStock, affectedValue: money(row.total_amount),
        payload: { creditNoteId: cnDocId, creditNoteNumber: cnNumber, restoredCost },
      };
    },
  });
}

/** Reverse a posted return: append-only reversal journal + stock re-deduction. */
async function reverse(id, ctx) {
  return runTransition({
    docType: 'sales_return', table: 'sales_returns', id, action: 'reverse',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'reversed_by', at: 'reversed_at' },
    perform: async (conn, row) => {
      const journalIds = [];
      if (row.journal_id) {
        journalIds.push(await posting.postReversal(conn, {
          originalJournalId: row.journal_id, referenceType: 'SalesReturn', referenceId: row.id, actor: ctx.actor, dateYMD: calc.ymd(ctx.date),
        }));
      }
      // The cost reversal is a SECOND journal (postCreditNote posts revenue and
      // COGS separately) and sales_returns only remembers the first. Reversing the
      // revenue journal alone would put the stock back out the door while leaving
      // Dr Inventory / Cr COGS standing — value and quantity would part company.
      // This was latent, not visible: restoredCost was always 0, so the COGS
      // journal never existed to be missed.
      const [cogsJ] = await conn.query(
        "SELECT id FROM gl_journals WHERE reference_type = 'SalesReturnCOGS' AND reference_id = ? AND reversed_by_journal_id IS NULL",
        [row.id]);
      for (const j of cogsJ) {
        journalIds.push(await posting.postReversal(conn, {
          originalJournalId: j.id, referenceType: 'SalesReturnCOGS', referenceId: row.id, actor: ctx.actor, dateYMD: calc.ymd(ctx.date),
        }));
      }
      // Re-deduct EXACTLY what the post restored — no more. Reading the same
      // restock flag and the same component snapshot is what makes that true; the
      // old loop keyed off a non-existent column, so it would have re-deducted
      // stock on lines that never restored any had the column ever appeared.
      const [lines] = await conn.query('SELECT * FROM sales_return_lines WHERE return_id = ? ORDER BY id', [id]);
      const undone = await _restore(conn, row, lines, ctx.actor || '', -1);
      // mark the credit note as cancelled (it no longer represents a live document)
      if (row.credit_note_id) await conn.query("UPDATE ar_documents SET status='cancelled', version=version+1 WHERE id = ?", [row.credit_note_id]);
      return {
        extraSets: { reversal_journal_id: journalIds[0] || null },
        journalIds, affectedStock: undone.affectedStock,
      };
    },
  });
}

async function cancel(id, ctx) {
  return runTransition({
    docType: 'sales_return', table: 'sales_returns', id, action: 'cancel',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    perform: async () => ({}),
  });
}

async function getWithLines(conn, id) {
  const [rows] = await conn.query('SELECT * FROM sales_returns WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw err('NOT_FOUND', 'المرتجع غير موجود');
  const [lines] = await conn.query('SELECT * FROM sales_return_lines WHERE return_id = ? ORDER BY id', [id]);
  // Components ride along so the screen can show WHAT a restock actually puts
  // back — a menu line names a burger, but the shelf sees bun + patty.
  const [comps] = await conn.query(
    'SELECT * FROM sales_return_line_components WHERE return_id = ? ORDER BY return_line_id, component_seq', [id]);
  const byLine = {};
  comps.forEach((c) => { (byLine[c.return_line_id] = byLine[c.return_line_id] || []).push(c); });
  // The credit note is the whole point of posting; the screen should not have to
  // guess whether it was stamped.
  let creditNote = null;
  if (rows[0].credit_note_id) {
    const [cn] = await conn.query(
      'SELECT id, document_number, issue_date, total_amount, status, zatca_status, zatca_uuid, zatca_qr_base64 FROM ar_documents WHERE id = ? LIMIT 1',
      [rows[0].credit_note_id]);
    if (cn.length) creditNote = cn[0];
  }
  return Object.assign({}, rows[0], {
    lines: lines.map((l) => Object.assign({}, l, { components: byLine[l.id] || [] })),
    creditNote,
  });
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
