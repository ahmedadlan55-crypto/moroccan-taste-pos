/**
 * services/order-to-cash/CustomerPaymentService.js — customer collections /
 * receipts (spec §التحصيل/التخصيص). Lifecycle draft → approved → posted →
 * reversed (cancel only before posting). Posting applies allocations + writes GL
 * atomically:
 *   allocated portion  → Dr Cash|Bank / Cr AR            (postCollection)
 *   unapplied portion  → Dr Cash|Bank / Cr Customer Deposits (postAdvance)
 * Reversal is append-only (reverses allocations + a swapped-journal clone) — never
 * a delete. paid_amount on invoices is written ONLY through PaymentAllocationService.
 * Maker–Checker: large collections/reversals require a distinct approver.
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
const cfg = require('../../lib/order-to-cash/config');

const money = calc.money;
function genId() { return 'CR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

/** Create a draft collection; intended allocations are captured for post-time. */
async function create(conn, data, actor) {
  // Same-key retry replays the existing payment; same key + different payload
  // throws 409 inside findPrior. Parallel races recover at the route.
  const prior = await events.findPrior(conn, 'customer_payment', 'create', '', data.idempotencyKey, data.requestHash);
  if (prior) return get(conn, prior.entity_id);

  const amount = money(data.amount);
  if (!(amount > 0)) throw err('VALIDATION_ERROR', 'مبلغ التحصيل يجب أن يكون موجبًا');
  if (!data.customerId) throw err('VALIDATION_ERROR', 'العميل مطلوب لسند القبض');
  const destType = data.destinationType === 'bank' ? 'bank' : 'cash';
  const id = genId();
  const number = await nextNumber(conn, 'customer_payment', data.paymentDate);
  const allocations = Array.isArray(data.allocations) ? data.allocations : [];
  await conn.query(
    `INSERT INTO customer_payments
       (id, payment_number, customer_id, customer_name, brand_id, branch_id, payment_date, payment_method,
        destination_type, destination_id, amount, allocated_amount, unapplied_amount, status, is_advance,
        reference, notes, version, idempotency_key, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,'draft',?,?,?,1,?,?)`,
    [id, number, data.customerId, data.customerName || null, data.brandId || null, data.branchId || null,
     calc.ymd(data.paymentDate), data.paymentMethod || destType, destType, data.destinationId || null,
     amount, amount, (data.isAdvance || !allocations.length) ? 1 : 0,
     data.reference || null, data.notes || null, data.idempotencyKey || null, actor || '']);
  await events.recordEvent(conn, {
    documentType: 'customer_payment', documentId: id, action: 'create', toStatus: 'draft',
    actor, idempotencyKey: data.idempotencyKey || null, requestHash: data.requestHash || null,
    payload: { allocations },
  });
  return get(conn, id);
}

async function approve(id, ctx) {
  return runTransition({
    docType: 'customer_payment', table: 'customer_payments', id, action: 'approve',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'approved_by', at: 'approved_at' },
    perform: async (conn, row) => {
      // Maker–Checker: the approver must differ from the creator for large amounts.
      if (cfg.makerCheckerEnabled() && money(row.amount) >= cfg.makerCheckerThreshold()
          && ctx.actor && row.created_by && ctx.actor === row.created_by) {
        throw err('PERMISSION_DENIED', 'اعتماد سند كبير يتطلب مستخدمًا مختلفًا عن المُنشئ');
      }
      return {};
    },
  });
}

/** Post an approved collection: apply allocations + GL, atomically. */
async function post(id, ctx) {
  return runTransition({
    docType: 'customer_payment', table: 'customer_payments', id, action: 'post',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'posted_by', at: 'posted_at' },
    perform: async (conn, row) => {
      let allocations = Array.isArray(ctx.allocations) ? ctx.allocations : null;
      if (!allocations) {
        const [ev] = await conn.query(
          "SELECT payload_json FROM ar_events WHERE entity_type='customer_payment' AND entity_id=? AND event_type='create' LIMIT 1", [row.id]);
        const pl = ev.length && ev[0].payload_json ? JSON.parse(ev[0].payload_json) : {};
        allocations = (pl && pl.allocations) || [];
      }
      const applied = await Alloc.applyAllocations(conn, row, allocations, ctx.actor);
      const unapplied = money(Number(row.amount) - applied.allocatedTotal);
      const journalIds = [];
      if (applied.allocatedTotal > 0) {
        journalIds.push(await posting.postCollection(conn, {
          payment: Object.assign({}, row, { posted_by: ctx.actor }), amount: applied.allocatedTotal,
        }));
      }
      if (unapplied > 0.001) {
        journalIds.push(await posting.postAdvance(conn, {
          payment: Object.assign({}, row, { posted_by: ctx.actor }), amount: unapplied,
        }));
      }
      return {
        extraSets: { journal_id: journalIds[0] || null, allocated_amount: applied.allocatedTotal, unapplied_amount: unapplied, is_advance: unapplied > 0.001 ? 1 : 0 },
        journalIds, affectedValue: money(row.amount),
        payload: { allocated: applied.allocatedTotal, unapplied, perInvoice: applied.perInvoice },
      };
    },
  });
}

/** Apply a posted advance's unapplied balance to invoices: Dr Deposits / Cr AR. */
async function allocateAdvance(id, ctx) {
  const actor = ctx.actor;
  const run = () => db.withTransaction(async (conn) => {
    // This posts a REAL journal and moves invoice balances, yet it ran with no
    // idempotency at all — and applyAllocations uses ON DUPLICATE KEY UPDATE
    // ... + VALUES, so a double-submit ADDED a second application instead of
    // replaying the first. Same (scope,key,hash) contract as the executor:
    // scope is customer_payment:allocate_advance:<id>.
    const priorIn = await events.findPrior(conn, 'customer_payment', 'allocate_advance', id, ctx.idempotencyKey, ctx.requestHash);
    if (priorIn) return Object.assign({ replayed: true }, events.replayEnvelope(priorIn).payload || {});

    const [rows] = await conn.query('SELECT * FROM customer_payments WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) throw err('NOT_FOUND', 'سند القبض غير موجود');
    const row = rows[0];
    if (String(row.status) !== 'posted') throw err('INVALID_STATE_TRANSITION', 'يجب أن يكون السند مُرحّلًا');
    const available = money(row.unapplied_amount);
    const allocations = Array.isArray(ctx.allocations) ? ctx.allocations : [];
    const want = money(allocations.reduce((s, a) => s + Number(a.amount || 0), 0));
    if (!(want > 0)) throw err('VALIDATION_ERROR', 'لا توجد تخصيصات');
    if (want - available > 0.01) throw err('OVER_ALLOCATION', `التخصيص (${want}) يتجاوز الرصيد المتاح للدفعة (${available})`);
    const applied = await Alloc.applyAllocations(conn, row, allocations, actor);
    const journalId = await posting.postAdvanceApplication(conn, { payment: Object.assign({}, row, { posted_by: actor }), amount: applied.allocatedTotal });
    const newUnapplied = money(available - applied.allocatedTotal);
    await conn.query('UPDATE customer_payments SET allocated_amount = allocated_amount + ?, unapplied_amount = ?, is_advance = ? WHERE id = ?',
      [applied.allocatedTotal, newUnapplied, newUnapplied > 0.001 ? 1 : 0, id]);
    const out = { id, allocated: applied.allocatedTotal, unapplied: newUnapplied, journalId, perInvoice: applied.perInvoice };
    // The FULL return value is the payload, so a replay answers byte-equally.
    await events.recordEvent(conn, {
      documentType: 'customer_payment', documentId: id, action: 'allocate_advance', actor,
      idempotencyKey: ctx.idempotencyKey || null, requestHash: ctx.requestHash || null,
      glJournalId: journalId, payload: Object.assign({}, out, { journalIds: [journalId] }),
    });
    return out;
  });
  try {
    return await run();
  } catch (e) {
    // Parallel same-key race: the loser's UNIQUE(event_scope, key) violation
    // rolled it back. Re-check on the POOL (the dead txn's snapshot predates
    // the winner's commit); hash mismatch throws the 409 from findPrior.
    if (ctx.idempotencyKey) {
      const prior = await events.findPrior(db, 'customer_payment', 'allocate_advance', id, ctx.idempotencyKey, ctx.requestHash);
      if (prior) return Object.assign({ replayed: true }, events.replayEnvelope(prior).payload || {});
    }
    throw e;
  }
}

/** Reverse a posted collection: undo allocations + append-only reversal journal. */
async function reverse(id, ctx) {
  return runTransition({
    docType: 'customer_payment', table: 'customer_payments', id, action: 'reverse',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    actorColumns: { by: 'reversed_by', at: 'reversed_at' },
    perform: async (conn, row) => {
      await Alloc.reverseAllocations(conn, row.id);
      const journalIds = [];
      if (row.journal_id) {
        journalIds.push(await posting.postReversal(conn, {
          originalJournalId: row.journal_id, referenceType: 'CustomerPayment', referenceId: row.id,
          actor: ctx.actor, dateYMD: calc.ymd(ctx.date),
        }));
      }
      // reverse the advance journal too, if any (separate reference row)
      const [adv] = await conn.query("SELECT id FROM gl_journals WHERE reference_type='CustomerAdvance' AND reference_id=? LIMIT 1", [row.id]);
      if (adv.length) {
        journalIds.push(await posting.postReversal(conn, {
          originalJournalId: adv[0].id, referenceType: 'CustomerAdvance', referenceId: row.id,
          actor: ctx.actor, dateYMD: calc.ymd(ctx.date),
        }));
      }
      return { extraSets: { reversal_journal_id: journalIds[0] || null }, journalIds };
    },
  });
}

async function cancel(id, ctx) {
  return runTransition({
    docType: 'customer_payment', table: 'customer_payments', id, action: 'cancel',
    actor: ctx.actor, actorId: ctx.actorId, expectedVersion: ctx.expectedVersion, idempotencyKey: ctx.idempotencyKey, requestHash: ctx.requestHash,
    perform: async () => ({}),
  });
}

async function get(conn, id) {
  const [rows] = await conn.query('SELECT * FROM customer_payments WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw err('NOT_FOUND', 'سند القبض غير موجود');
  const [alloc] = await conn.query('SELECT * FROM ar_payment_allocations WHERE payment_id = ? AND reversed = 0', [id]);
  return Object.assign({}, rows[0], { allocations: alloc });
}

const SORTABLE = { paymentDate: 'payment_date', amount: 'amount', status: 'status', number: 'payment_number' };
const LIST_STATUSES = ['draft', 'approved', 'posted', 'reversed', 'cancelled'];

async function list(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const sortCol = SORTABLE[params.sort] || 'payment_date';
  const dir = String(params.dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const where = ['1=1']; const args = [];
  if (params.status && LIST_STATUSES.includes(params.status)) { where.push('status = ?'); args.push(params.status); }
  if (params.customerId) { where.push('customer_id = ?'); args.push(String(params.customerId)); }
  if (params.unallocated === 'true') where.push('unapplied_amount > 0.01 AND status = "posted"');
  if (params.q) { where.push('payment_number LIKE ?'); args.push('%' + params.q + '%'); }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const [rows] = await db.query(
    `SELECT id, payment_number, customer_id, customer_name, payment_date, payment_method, destination_type,
            amount, allocated_amount, unapplied_amount, status, is_advance, journal_id, version
       FROM customer_payments ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
    args.concat([pageSize, offset]));
  const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM customer_payments ${whereSql}`, args);
  const total = Number(cnt[0].total);
  return { data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

module.exports = { create, approve, post, allocateAdvance, reverse, cancel, get, list };
