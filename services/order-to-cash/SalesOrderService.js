/**
 * services/order-to-cash/SalesOrderService.js — the (optional) order stage:
 * draft → confirmed → fulfilled → invoiced → closed (+ cancel before fulfillment).
 * Confirming a credit order runs the server credit gate. Invoicing an order
 * creates + issues an ar_document via InvoiceService (single AR writer) and links
 * it back (invoice_id). Fulfillment is a status marker only — stock stays owned by
 * the POS/warehouse writer (no dual-write here).
 */
'use strict';

const db = require('../../db/connection');
const { err } = require('../../lib/order-to-cash/errors');
const calc = require('../../lib/order-to-cash/calculations');
const { nextNumber } = require('../../lib/order-to-cash/numbering');
const { standardVatRate } = require('../../lib/order-to-cash/config');
const events = require('../../lib/order-to-cash/events');
const { runTransition } = require('./TransitionExecutor');
const CreditLimitService = require('./CreditLimitService');
const InvoiceService = require('./InvoiceService');

const money = calc.money;
function genId() { return 'SO-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function lineId() { return 'SOL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

async function _compute(conn, data) {
  const std = await standardVatRate(conn);
  const raw = Array.isArray(data.lines) ? data.lines : [];
  if (!raw.length) throw err('VALIDATION_ERROR', 'أمر البيع يجب أن يحتوي سطرًا واحدًا على الأقل');
  const computed = raw.map((l) => Object.assign(calc.computeLine({
    enteredQty: l.enteredQty != null ? l.enteredQty : l.qty,
    factor: l.factor != null ? l.factor : l.conversionFactor,
    unitPriceEntered: l.unitPrice != null ? l.unitPrice : l.unitPriceEntered,
    discount: l.discount, vatRate: l.vatRate, vatCategory: l.vatCategory, inclusiveTax: l.inclusiveTax,
  }, std), {
    itemId: l.itemId || null, menuId: l.menuId || null, description: l.description || null,
    enteredUnitId: l.enteredUnitId || null, enteredUnitCode: l.enteredUnitCode || null,
    revenueAccountCode: l.revenueAccountCode || null, warehouseId: l.warehouseId || null,
    costSnapshot: money(l.costSnapshot || 0),
  }));
  return { computed, totals: calc.computeTotals(computed) };
}

async function create(conn, data, actor) {
  // Same-key retry replays the existing order; same key + different payload
  // throws 409 inside findPrior. Parallel races recover at the route.
  const prior = await events.findPrior(conn, 'sales_order', 'create', '', data.idempotencyKey, data.requestHash);
  if (prior) return getWithLines(conn, prior.entity_id);

  const { computed, totals } = await _compute(conn, data);
  const id = genId();
  const number = await nextNumber(conn, 'sales_order', data.orderDate);
  await conn.query(
    `INSERT INTO sales_orders
       (id, order_number, customer_id, customer_name, brand_id, branch_id, warehouse_id, channel_id,
        order_date, expected_date, currency, subtotal, discount_amount, vat_amount, total_amount,
        is_credit_sale, status, version, idempotency_key, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',1,?,?,?)`,
    [id, number, data.customerId || null, data.customerName || null, data.brandId || null, data.branchId || null,
     data.warehouseId || null, data.channelId || null, calc.ymd(data.orderDate), data.expectedDate ? calc.ymd(data.expectedDate) : null,
     data.currency || 'SAR', totals.subtotal, totals.discountAmount, totals.vatAmount, totals.total,
     data.isCreditSale ? 1 : 0, data.idempotencyKey || null, data.notes || null, actor || '']);
  for (const l of computed) {
    await conn.query(
      `INSERT INTO sales_order_lines
        (id, order_id, item_id, menu_id, description, entered_unit_id, entered_unit_code, entered_qty,
         conversion_factor_snapshot, base_qty, unit_price, discount_amount, vat_category, vat_rate,
         net_amount, vat_amount, gross_amount, revenue_account_code, warehouse_id, cost_snapshot)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lineId(), id, l.itemId, l.menuId, l.description, l.enteredUnitId, l.enteredUnitCode, l.enteredQty,
       l.factor, l.baseQty, l.unitPriceEntered, l.discountAmount, l.vatCategory, l.vatRate,
       l.netAmount, l.vatAmount, l.grossAmount, l.revenueAccountCode, l.warehouseId, l.costSnapshot]);
  }
  // The create event is the idempotency record (scope sales_order:create:).
  await events.recordEvent(conn, {
    documentType: 'sales_order', documentId: id, action: 'create', toStatus: 'draft',
    actor, idempotencyKey: data.idempotencyKey || null, requestHash: data.requestHash || null,
    payload: { orderNumber: number },
  });
  return getWithLines(conn, id);
}

async function confirm(id, ctx) {
  return runTransition({
    docType: 'sales_order', table: 'sales_orders', id, action: 'confirm',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'confirmed_by', at: 'confirmed_at' },
    perform: async (conn, row) => {
      if (Number(row.is_credit_sale) && row.customer_id) {
        await CreditLimitService.enforce(conn, {
          customerId: row.customer_id, creditAmount: money(row.total_amount), issueDate: row.order_date,
          override: ctx.override, hasOverrideCapability: ctx.hasOverrideCapability,
        });
      }
      return {};
    },
  });
}

async function fulfill(id, ctx) {
  return runTransition({
    docType: 'sales_order', table: 'sales_orders', id, action: 'fulfill',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'fulfilled_by', at: 'fulfilled_at' }, perform: async () => ({}),
  });
}

async function cancel(id, ctx) {
  return runTransition({
    docType: 'sales_order', table: 'sales_orders', id, action: 'cancel',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'cancelled_by', at: 'cancelled_at' }, perform: async () => ({}),
  });
}

/** Invoice a fulfilled order: create + issue an ar_document, link it back. */
async function invoiceOrder(id, ctx) {
  return runTransition({
    docType: 'sales_order', table: 'sales_orders', id, action: 'invoice',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    perform: async (conn, row) => {
      const [lines] = await conn.query('SELECT * FROM sales_order_lines WHERE order_id = ?', [id]);
      const draft = await InvoiceService.createDraft(conn, {
        documentType: 'invoice', sourceType: 'contract', sourceId: row.id,
        customerId: row.customer_id, customerName: row.customer_name,
        brandId: row.brand_id, branchId: row.branch_id, warehouseId: row.warehouse_id, channelId: row.channel_id,
        issueDate: row.order_date, currency: row.currency,
        lines: lines.map((l) => ({
          itemId: l.item_id, menuId: l.menu_id, description: l.description,
          enteredQty: l.entered_qty, factor: l.conversion_factor_snapshot, unitPrice: l.unit_price,
          discount: l.discount_amount, vatCategory: l.vat_category, vatRate: l.vat_rate,
          revenueAccountCode: l.revenue_account_code, warehouseId: l.warehouse_id, costSnapshot: l.cost_snapshot,
        })),
      }, ctx.actor);
      const issued = await InvoiceService.issue(draft.id, {
        actor: ctx.actor, actorId: ctx.actorId, idempotencyKey: (ctx.idempotencyKey ? ctx.idempotencyKey + ':inv' : null),
        enforceCredit: !!Number(row.is_credit_sale), override: ctx.override, hasOverrideCapability: ctx.hasOverrideCapability,
      });
      return { extraSets: { invoice_id: draft.id }, journalIds: issued.result && issued.result.journalIds || [], payload: { invoiceId: draft.id } };
    },
  });
}

async function getWithLines(conn, id) {
  const [rows] = await conn.query('SELECT * FROM sales_orders WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw err('NOT_FOUND', 'أمر البيع غير موجود');
  const [lines] = await conn.query('SELECT * FROM sales_order_lines WHERE order_id = ? ORDER BY id', [id]);
  const [tl] = await conn.query("SELECT event_type, from_status, to_status, actor_username, created_at FROM ar_events WHERE entity_type='sales_order' AND entity_id=? ORDER BY created_at", [id]);
  return Object.assign({}, rows[0], { lines, timeline: tl });
}

const SORTABLE = { orderDate: 'order_date', total: 'total_amount', status: 'status', number: 'order_number' };
const LIST_STATUSES = ['draft', 'confirmed', 'fulfilled', 'invoiced', 'closed', 'cancelled'];

async function list(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const sortCol = SORTABLE[params.sort] || 'order_date';
  const dir = String(params.dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const where = ['1=1']; const args = [];
  if (params.status && LIST_STATUSES.includes(params.status)) { where.push('status = ?'); args.push(params.status); }
  if (params.customerId) { where.push('customer_id = ?'); args.push(String(params.customerId)); }
  if (params.q) { where.push('(order_number LIKE ? OR customer_name LIKE ?)'); args.push('%' + params.q + '%', '%' + params.q + '%'); }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const [rows] = await db.query(
    `SELECT id, order_number, customer_id, customer_name, order_date, total_amount, is_credit_sale, status, invoice_id, version
       FROM sales_orders ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
    args.concat([pageSize, offset]));
  const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM sales_orders ${whereSql}`, args);
  const total = Number(cnt[0].total);
  return { data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

module.exports = { create, confirm, fulfill, cancel, invoiceOrder, getWithLines, list };
