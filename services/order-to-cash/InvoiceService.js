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
const SalesScope = require('../../lib/salesScope');
const { standardVatRate } = require('../../lib/order-to-cash/config');
const events = require('../../lib/order-to-cash/events');
const { runTransition } = require('./TransitionExecutor');
const Zatca = require('./ZatcaDocumentService');
const CreditLimitService = require('./CreditLimitService');

const money = calc.money;
function genId() { return 'AR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function lineId() { return 'ARL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

function _nonNegativeCost(value, label) {
  const n = value == null || value === '' ? 0 : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw err('VALIDATION_ERROR', `تكلفة غير صالحة (${label || 'سطر'})`);
  }
  return money(n);
}

function _nonNegativeRate(value, label) {
  const n = value == null || value === '' ? 0 : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw err('VALIDATION_ERROR', `تكلفة وحدة غير صالحة (${label || 'مكوّن'})`);
  }
  return calc.rate(n);
}

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
      // sourceLineId was absent here, so the INSERT below — its ONLY writer —
      // wrote NULL for every row ever created. The column existed but never
      // held a value, which also left the (document_id, source_line_id) replay
      // guard inert, since NULLs never collide.
      sourceLineId: l.sourceLineId || null,
      itemId: l.itemId || null, menuId: l.menuId || null,
      description: l.description || null,
      enteredUnitId: l.enteredUnitId || null, enteredUnitCode: l.enteredUnitCode || null,
      revenueAccountId: l.revenueAccountId || null, revenueAccountCode: l.revenueAccountCode || null,
      warehouseId: l.warehouseId || null,
      costSnapshot: _nonNegativeCost(l.costSnapshot, l.description || l.sourceLineId),
    });
  });
  const totals = calc.computeTotals(computed);
  return { computed, totals };
}

/** Create a draft invoice (manual / contract). POS invoices use linkPosSale instead. */
async function createDraft(conn, data, actor) {
  // Same-key retry replays the existing draft; same key + different payload
  // throws 409 inside findPrior. Parallel races recover at the route.
  const prior = await events.findPrior(conn, 'ar_document', 'create', '', data.idempotencyKey, data.requestHash);
  if (prior) return getWithLines(conn, prior.entity_id);

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
  // The create event is the idempotency record (scope ar_document:create:).
  await events.recordEvent(conn, {
    documentType: 'ar_document', documentId: id, action: 'create', toStatus: 'draft',
    actor, idempotencyKey: data.idempotencyKey || null, requestHash: data.requestHash || null,
    payload: { documentType: data.documentType || 'invoice' },
  });
  return getWithLines(conn, id);
}

/** Issue a draft invoice: number + credit gate + ZATCA stamp + GL post, atomically. */
async function issue(id, ctx) {
  return runTransition({
    docType: 'ar_document', table: 'ar_documents', id, action: 'issue',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
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
      // Number FIRST, then stamp: every stamping path takes locks in the order
      // counter → chain head. Returns-post takes the CN counter before its
      // stamp; taking them here in the opposite order is a deadlock the retry
      // loop would mask as latency.
      const number = row.document_number && !/^DRAFT-/.test(row.document_number)
        ? row.document_number : await nextNumber(conn, row.document_type === 'credit_note' ? 'credit_note' : 'invoice', row.issue_date);
      // real ZATCA stamp (locks the chain head until commit)
      const z = await Zatca.stamp(conn, { doc: row, lines });
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
      // Advance the head in THIS transaction: a failure after this point rolls
      // back the head together with the document, and an idempotent replay
      // (which never reaches perform) cannot advance it again.
      await Zatca.advanceChain(conn, { hash: z.hash, icv: z.icv });
      return {
        extraSets: {
          document_number: number, gl_journal_id: journalId,
          // previousHash and the QR used to be RETURNED by the stamper and
          // dropped here — the chain link existed only as a recomputation.
          zatca_uuid: z.uuid, zatca_hash: z.hash, zatca_status: z.status,
          previous_invoice_hash: z.previousHash, zatca_icv: z.icv, zatca_qr_base64: z.qr,
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
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'cancelled_by', at: 'cancelled_at' }, perform: async () => ({}),
  });
}

/**
 * Link a POS sale into ar_documents as an ISSUED invoice, referencing the sale's
 * existing 'Sale' GL journal — NO GL re-post (avoids double Revenue/VAT/COGS).
 * Idempotent via UNIQUE(source_type, source_id). Used by POS integration + backfill.
 */
/**
 * Write the POS line snapshots + their inventory-component snapshots.
 *
 * These are inserted VERBATIM — deliberately not routed through _computeDoc /
 * calc.computeLine, which would recompute VAT from unit price and diverge from
 * the per-category figures the sale actually recorded and the GL actually
 * posted. The caller has already fitted these numbers to the header; this
 * function's only job is to persist them faithfully.
 *
 * Idempotent on UNIQUE(document_id, source_line_id) and
 * UNIQUE(document_line_id, component_seq). ON DUPLICATE KEY UPDATE rather than
 * INSERT IGNORE, which would also swallow genuine errors (bad FK, truncation).
 */
async function _ensurePosLines(conn, documentId, lines, components) {
  if (!Array.isArray(lines) || !lines.length) return 0;
  // Validate every cost before the first INSERT. The POS projection is a
  // financial snapshot; accepting a negative value here can later restore
  // negative inventory value while posting.js intentionally emits no COGS
  // journal for a non-positive aggregate.
  const lineCosts = lines.map((l) => _nonNegativeCost(l.costSnapshot, l.description || l.sourceLineId));
  const componentCosts = Array.isArray(components)
    ? components.map((c) => ({
      unit: _nonNegativeRate(c.unitCostSnapshot, c.invItemName || c.invItemId),
      total: _nonNegativeCost(c.totalCost, c.invItemName || c.invItemId),
    }))
    : [];
  const idBySourceLine = {};
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const l = lines[lineIndex];
    const existing = await conn.query(
      'SELECT id FROM ar_document_lines WHERE document_id = ? AND source_line_id = ? LIMIT 1',
      [documentId, l.sourceLineId]);
    if (existing[0].length) { idBySourceLine[l.sourceLineId] = existing[0][0].id; continue; }
    const id = lineId();
    await conn.query(
      `INSERT INTO ar_document_lines
        (id, document_id, source_line_id, item_id, menu_id, description, entered_unit_id, entered_unit_code,
         entered_qty, conversion_factor_snapshot, base_qty, unit_price, discount_amount, vat_category, vat_rate,
         net_amount, vat_amount, gross_amount, revenue_account_id, revenue_account_code, warehouse_id,
         cost_snapshot, projection_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE id = id`,
      [id, documentId, l.sourceLineId, l.itemId || null, l.menuId || null, l.description || null,
       l.enteredUnitId || null, l.enteredUnitCode || null, l.enteredQty, l.conversionFactor || 1, l.baseQty,
       l.unitPrice, l.discountAmount, l.vatCategory, l.vatRate, l.netAmount, l.vatAmount, l.grossAmount,
       l.revenueAccountId || null, l.revenueAccountCode || null, l.warehouseId || null,
       lineCosts[lineIndex], l.projectionVersion]);
    idBySourceLine[l.sourceLineId] = id;
  }

  if (Array.isArray(components) && components.length) {
    // component_seq is per-line and assigned in the caller's deterministic
    // order, so a replay reproduces the same key rather than duplicating rows.
    const seqByLine = {};
    for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
      const c = components[componentIndex];
      const parentId = idBySourceLine[c.sourceLineId];
      if (!parentId) continue;
      seqByLine[c.sourceLineId] = (seqByLine[c.sourceLineId] || 0) + 1;
      await conn.query(
        `INSERT INTO ar_document_line_components
          (id, document_id, document_line_id, component_seq, source, inv_item_id, inv_item_name,
           warehouse_id, deducted_base_qty, unit_code, conversion_factor, unit_cost_snapshot,
           total_cost, projection_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE id = id`,
        ['ARLC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), documentId, parentId,
         seqByLine[c.sourceLineId], c.source || 'recipe', c.invItemId || null, c.invItemName || null,
         c.warehouseId || null, c.deductedBaseQty, c.unitCode || null, c.conversionFactor || null,
         componentCosts[componentIndex].unit, componentCosts[componentIndex].total, c.projectionVersion]);
    }
  }
  return lines.length;
}

async function linkPosSale(conn, sale, opts = {}) {
  const [exist] = await conn.query("SELECT id FROM ar_documents WHERE source_type='pos' AND source_id = ? LIMIT 1", [sale.id]);
  if (exist.length) {
    // Ensure lines even on replay: a header may predate the projection (the
    // backfill script wrote headers only), in which case it is still lineless
    // and therefore still un-returnable.
    if (opts.lines) await _ensurePosLines(conn, exist[0].id, opts.lines, opts.components);
    return { id: exist[0].id, linked: true, replayed: true };
  }
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
  const lineCount = await _ensurePosLines(conn, id, opts.lines, opts.components);
  await events.recordEvent(conn, {
    documentType: 'ar_document', documentId: id, action: 'link_pos_sale', toStatus: (opts.status || 'paid'),
    actor: opts.actor || 'backfill', glJournalId: journalId, payload: { saleId: sale.id, lines: lineCount },
  });
  return { id, linked: true, journalId, lines: lineCount };
}

async function getWithLines(conn, id) {
  const [rows] = await conn.query('SELECT * FROM ar_documents WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw err('NOT_FOUND', 'الفاتورة غير موجودة');
  const [lines] = await conn.query('SELECT * FROM ar_document_lines WHERE document_id = ? ORDER BY id', [id]);
  // How much of each line has already gone back. SalesReturnService.create bounds
  // return_qty by exactly this (OVER_RETURN) but never published it, so a return
  // form could only cap at the full sold qty and invite a request the server was
  // always going to refuse. Same query, same statuses — client and server agree
  // by construction rather than by coincidence.
  const [prev] = await conn.query(
    `SELECT srl.original_line_id, COALESCE(SUM(srl.return_qty), 0) AS returned
       FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id
      WHERE sr.original_ar_document_id = ? AND sr.status NOT IN ('cancelled','reversed')
      GROUP BY srl.original_line_id`, [id]);
  const returnedBy = {};
  prev.forEach((r) => { returnedBy[r.original_line_id] = Number(r.returned); });
  return Object.assign({}, rows[0], {
    lines: lines.map((l) => Object.assign({}, l, { returned_qty: returnedBy[l.id] || 0 })),
  });
}

// Sort keys are qualified: the list joins analytics_order_facts, which carries
// its own `status`, `customer_id`, `branch_id` and `channel_id`. An unqualified
// ORDER BY status would be an ambiguous-column error, not a silent wrong sort.
const SORTABLE = { issueDate: 'd.issue_date', total: 'd.total_amount', dueDate: 'd.due_date', status: 'd.status', number: 'd.document_number' };
const LIST_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'credited', 'closed', 'cancelled'];

/**
 * THE DATE BASIS OF THIS LIST — read before changing it.
 *
 * `ar_documents.issue_date` is the CALENDAR day: linkPosSale sets it to
 * `calc.ymd(sale.order_date)`, the Riyadh wall-clock date of the sale. The
 * analytics hub keys EVERYTHING by `business_day`, which is that same local date
 * minus one when the sale happened before the branch's day_close_time
 * (lib/analytics/businessDay.js). For a 04:00 close the two disagree on exactly
 * the 00:00–03:59 trade — the same window the journal-date fix (d4b34e8) was
 * about. Filtering this list on issue_date while the KPI row above it is
 * filtered on business_day puts an invoice in the table that the KPI does not
 * count, and the page shows two different populations of the "same" period.
 *
 * So the list filters on `f.business_day` — the hub's own column, read from the
 * hub's own fact row — and falls back to `d.issue_date` only where there is no
 * fact row to read. That fallback is not a shortcut: analytics_order_facts is
 * projected for POS sales and returns only (scripts/analytics/backfill-facts.js
 * passes A–D), so a manual or contract invoice has no business day anywhere in
 * the schema and its issue_date IS its trading day. `businessDay=false` (the
 * hub's own calendar-day toggle) switches both sides to the calendar day.
 *
 * The LEFT JOIN never multiplies rows: analytics_order_facts.document_id is the
 * PRIMARY KEY. The table is created by the idempotent boot migration in
 * server.js — the same path that creates ar_documents itself.
 */
const DAY_BUSINESS = 'COALESCE(f.business_day, d.issue_date)';
const DAY_CALENDAR = 'd.issue_date';
const LIST_FROM = 'FROM ar_documents d LEFT JOIN analytics_order_facts f ON f.document_id = d.id';

/**
 * A bound, or nothing. Anything that is not a real calendar date is DROPPED
 * rather than bound: `calc.ymd('abc')` happily returns 'abc', and comparing a
 * DATE column to that makes MySQL's answer depend on its warning mode instead of
 * on the filter the user asked for. Silently ignoring junk is also what keeps
 * this endpoint from 422-ing the live Orders page.
 */
function _dayBound(value) {
  const s = calc.ymd(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) ? s : null;
}

/** Read a repeated or comma-separated multi-value query param as a list. */
function _multi(value) {
  const out = [];
  const take = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(take); return; }
    String(v).split(',').forEach((p) => { const s = p.trim(); if (s) out.push(s); });
  };
  take(value);
  return out.filter((v, i) => out.indexOf(v) === i);
}

async function list(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const sortCol = SORTABLE[params.sort] || 'd.issue_date';
  const dir = String(params.dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const where = ["d.document_type <> 'credit_note' OR ? = 1"];
  const args = [params.includeCreditNotes ? 1 : 0];
  // The Sales Decision Center puts analytics KPIs above this operational list.
  // In that context both halves must describe the SAME population: projected
  // sales facts, excluding voided orders and credit-note facts. Without this,
  // drafts/manual documents widened the table while the KPI stayed narrower.
  const analyticsPopulation = params.analyticsPopulation === true ||
    params.analyticsPopulation === 1 ||
    ['1', 'true'].includes(String(params.analyticsPopulation || '').toLowerCase());
  if (analyticsPopulation) {
    where.push('f.document_id IS NOT NULL');
    where.push("(f.status IS NULL OR f.status <> 'voided')");
    where.push("(f.source IS NULL OR f.source NOT IN ('sales_return','credit_note'))");
  }
  if (params.status && LIST_STATUSES.includes(params.status)) { where.push('d.status = ?'); args.push(params.status); }
  if (params.customerId) { where.push('d.customer_id = ?'); args.push(String(params.customerId)); }
  if (params.sourceType) { where.push('d.source_type = ?'); args.push(String(params.sourceType)); }
  if (params.q) { where.push('(d.document_number LIKE ? OR d.customer_name LIKE ?)'); args.push('%' + params.q + '%', '%' + params.q + '%'); }

  // Period. The hub page has been sending from/to since it shipped and they
  // reached nothing, so honouring them is a fix, not a new contract — and an
  // unknown-parameter 422 here would break that live page on deploy.
  // In analyticsPopulation mode the fact row is mandatory, so use the exact
  // date expressions the analytics planner uses. In particular its calendar
  // day is DATE(f.occurred_at_local), not ar_documents.issue_date; those can
  // differ around midnight for a branch outside the server timezone. Ordinary
  // operational invoice lists retain their existing issue-date fallback.
  const dayExpr = String(params.businessDay) === 'false'
    ? (analyticsPopulation ? 'DATE(f.occurred_at_local)' : DAY_CALENDAR)
    : (analyticsPopulation ? 'f.business_day' : DAY_BUSINESS);
  const dFrom = params.from ? _dayBound(params.from) : null;
  const dTo = params.to ? _dayBound(params.to) : null;
  if (dFrom) { where.push(`${dayExpr} >= ?`); args.push(dFrom); }
  if (dTo) { where.push(`${dayExpr} <= ?`); args.push(dTo); }

  // Channel / order type. ar_documents.channel_id is only written by the manual
  // invoice path — linkPosSale does not set it — so the POS truth is the fact
  // row's channel; COALESCE reads whichever one exists. order_type is POS-only
  // and has no ar_documents column at all, so filtering by it necessarily
  // excludes manual invoices, which genuinely have no order type.
  const channels = _multi(params.channels != null ? params.channels : params.channel);
  if (channels.length) {
    const channelExpr = analyticsPopulation ? 'f.channel_id' : 'COALESCE(f.channel_id, d.channel_id)';
    where.push(`${channelExpr} IN (${channels.map(() => '?').join(',')})`);
    channels.forEach((v) => args.push(v));
  }
  const orderTypes = _multi(params.orderTypes != null ? params.orderTypes : params.orderType);
  if (orderTypes.length) {
    where.push(`f.order_type IN (${orderTypes.map(() => '?').join(',')})`);
    orderTypes.forEach((v) => args.push(v));
  }

  // Decision-center drill filters. These are deliberately available only for
  // the projected analytics population: the source of truth is the frozen fact
  // / line snapshot, not today's menu or a best-effort parse of the invoice
  // description. EXISTS keeps the outer document set one-row-per-invoice, so a
  // split payment or a multi-line sale cannot inflate either the page or its
  // pagination total.
  if (analyticsPopulation) {
    const cashiers = _multi(params.cashiers != null ? params.cashiers : params.cashierId);
    if (cashiers.length) {
      where.push(`f.created_by IN (${cashiers.map(() => '?').join(',')})`);
      cashiers.forEach((v) => args.push(v));
    }

    const hours = _multi(params.hours != null ? params.hours : params.hour)
      .map((v) => Number(v))
      .filter((v, i, all) => Number.isInteger(v) && v >= 0 && v <= 23 && all.indexOf(v) === i);
    if (hours.length) {
      // Same expression as the registry's `hour` dimension over the order
      // fact. occurred_at_local is the branch-local timestamp; using UTC or
      // ar_documents.issue_date here would make the clicked heat-map cell and
      // the invoice list describe different hours.
      where.push(`HOUR(f.occurred_at_local) IN (${hours.map(() => '?').join(',')})`);
      hours.forEach((v) => args.push(v));
    }

    const menuIds = _multi(params.menuIds != null ? params.menuIds : params.menuItemId);
    const categoryNames = _multi(
      params.categoryIds != null ? params.categoryIds : params.categoryId,
    );
    if (menuIds.length || categoryNames.length) {
      const lineWhere = ['lf.document_id = d.id'];
      if (menuIds.length) {
        lineWhere.push(`lf.menu_id IN (${menuIds.map(() => '?').join(',')})`);
        menuIds.forEach((v) => args.push(v));
      }
      if (categoryNames.length) {
        // The shared URL key is historical (`categoryId`), but the analytics
        // registry groups by category_name_snapshot because the projector has
        // never had a category master id. Match the exact at-sale snapshot.
        lineWhere.push(`lf.category_name_snapshot IN (${categoryNames.map(() => '?').join(',')})`);
        categoryNames.forEach((v) => args.push(v));
      }
      // Menu + category belong to the SAME line. Two independent EXISTS
      // clauses would accept a burger line plus an unrelated drinks line when
      // the user asked for "Burger in Drinks".
      where.push(`EXISTS (SELECT 1 FROM ar_document_lines lf WHERE ${lineWhere.join(' AND ')})`);
    }

    const paymentMethods = _multi(
      params.paymentMethods != null ? params.paymentMethods : params.paymentMethod,
    );
    if (paymentMethods.length) {
      where.push(
        `EXISTS (SELECT 1 FROM analytics_payment_facts pf ` +
        `WHERE pf.document_id = d.id AND pf.method_norm IN (${paymentMethods.map(() => '?').join(',')}))`,
      );
      paymentMethods.forEach((v) => args.push(v));
    }
  }

  // THE BRANCH PREDICATE, IN THE STATEMENT ITSELF.
  // The router already drops out-of-scope rows from the page it gets back
  // (lib/salesScope.filterPage), which closed the row leak but left
  // pagination.total counted over every branch — an inflated total and a page
  // short by however many rows the router had to remove. Counting and paging
  // through the same predicate is what makes the total true and the page full;
  // filterPage then finds nothing left to drop.
  // `params.scope` has already been intersected with any `?branchId=` the caller
  // sent, and a missing scope normalizes to zero grants → `1=0` → no rows.
  const b = SalesScope.branchClause(params.scope, analyticsPopulation ? 'f.branch_id' : 'd.branch_id');
  if (b.sql) { where.push(b.sql); b.params.forEach((v) => args.push(v)); }

  const whereSql = 'WHERE ' + where.map((w) => '(' + w + ')').join(' AND ');
  const visibleBranch = analyticsPopulation ? 'f.branch_id' : 'd.branch_id';
  const listFrom = `${LIST_FROM}
       LEFT JOIN branches br ON br.id = ${visibleBranch}
       LEFT JOIN users u ON u.username = f.created_by`;
  const [rows] = await db.query(
    `SELECT d.id, d.document_number, d.document_type, d.source_type, d.customer_id, d.customer_name,
            d.issue_date, d.due_date, d.subtotal, d.vat_amount, d.total_amount, d.paid_amount,
            d.balance_amount, d.status, d.zatca_status, d.version, ${visibleBranch} AS branch_id,
            br.name AS branch_name, br.name_en AS branch_name_en,
            COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, f.created_by) AS cashier_name,
            ${analyticsPopulation ? 'f.channel_id' : 'COALESCE(f.channel_id, d.channel_id)'} AS channel,
            f.order_type, f.business_day
       ${listFrom} ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
    args.concat([pageSize, offset]));
  // The drill filters span order, line and payment facts. Let the operational
  // list return its own summary from the exact same WHERE instead of showing an
  // unfiltered analytics KPI above a correctly filtered table.
  const [cnt] = await db.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(d.subtotal), 0) AS net_ex_vat,
            COALESCE(SUM(d.total_amount), 0) AS invoice_total,
            CASE WHEN COUNT(*) = 0 THEN NULL
                 ELSE ROUND(SUM(d.subtotal) / COUNT(*), 2) END AS avg_ticket
       ${listFrom} ${whereSql}`,
    args,
  );
  const total = Number(cnt[0].total);
  return {
    data: rows,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    totals: {
      orders: total,
      net_ex_vat: Number(cnt[0].net_ex_vat || 0),
      invoice_total: Number(cnt[0].invoice_total || 0),
      avg_ticket: cnt[0].avg_ticket == null ? null : Number(cnt[0].avg_ticket),
    },
  };
}

module.exports = { createDraft, issue, cancel, linkPosSale, getWithLines, list, _computeDoc, _ensurePosLines };
