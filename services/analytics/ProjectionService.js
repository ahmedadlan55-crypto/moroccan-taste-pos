/**
 * services/analytics/ProjectionService.js — Unified Sales Analytics projection.
 *
 * Writes the analytics fact tables (analytics_order_facts / analytics_payment_facts /
 * analytics_modifier_facts / analytics_till_facts) from the OPERATIONAL tables after
 * each business write commits. Every writer is IDEMPOTENT (upsert on the fact tables'
 * unique keys) so a replay — retry, repair-queue drain, backfill re-run — produces
 * zero duplicate rows.
 *
 * Contract with callers (routes/sales.js, shifts.js, cash.js, O2C services):
 *   • called AFTER the business transaction commits, on the POOL (never the tx conn);
 *   • always through safeProject(), which NEVER throws — a failure is logged and
 *     queued into analytics_projection_repair for a later drain;
 *   • the business flow is byte-identical whether projection succeeds or fails.
 *
 * Every function takes `db` (pool or connection) as its first argument, like the
 * other services in this codebase. No module-level DB require → the module loads
 * even before `npm install` finishes (mysql2 is only needed by the caller's db).
 *
 * Business-day attribution: lib/analytics/businessDay.computeLocal(datetime, tz,
 * dayCloseTime) → { occurredAtLocal, businessDay } (authored by BE-A against the
 * same sprint spec). Branch tz + day-close are cached in-memory for 60s.
 */
'use strict';

// ── lazy requires ────────────────────────────────────────────────────────────
// businessDay is authored by agent BE-A on this same branch; requiring lazily
// means THIS module still loads (and safeProject still queues repairs) if the
// projection is exercised before that file lands.
let _bdMod = null;
function _businessDay() {
  if (!_bdMod) _bdMod = require('../../lib/analytics/businessDay');
  return _bdMod;
}

// ── branch timezone cache (60s TTL) ─────────────────────────────────────────
const TZ_TTL_MS = 60 * 1000;
const _tzCache = new Map(); // branchId → { tz, dayClose, at }
const DEFAULT_TZ = 'Asia/Riyadh';
const DEFAULT_DAY_CLOSE = '00:00:00';

async function loadBranchTz(db, branchId) {
  const key = branchId || '__none__';
  const hit = _tzCache.get(key);
  if (hit && Date.now() - hit.at < TZ_TTL_MS) return hit;
  let tz = DEFAULT_TZ, dayClose = DEFAULT_DAY_CLOSE;
  if (branchId && branchId !== 'UNASSIGNED') {
    try {
      const [r] = await db.query(
        'SELECT timezone, day_close_time FROM branches WHERE id = ? LIMIT 1', [branchId]);
      if (r.length) {
        if (r[0].timezone) tz = String(r[0].timezone);
        if (r[0].day_close_time != null && String(r[0].day_close_time) !== '') {
          dayClose = String(r[0].day_close_time);
        }
      }
    } catch (_) { /* branches.timezone not migrated yet — defaults apply */ }
  }
  const out = { tz, dayClose, at: Date.now() };
  _tzCache.set(key, out);
  return out;
}

/** occurred_at → { occurredAtLocal, businessDay, tz } for a branch. */
async function _localize(db, branchId, when) {
  const { tz, dayClose } = await loadBranchTz(db, branchId);
  const r = _businessDay().computeLocal(when, tz, dayClose);
  return { occurredAtLocal: r.occurredAtLocal, businessDay: r.businessDay, tz };
}

// ── payment-method normalization ────────────────────────────────────────────
// Same Arabic fold routes/sales.js `_normPmName` / routes/shifts.js `_normPM`
// use (both are file-local, so the logic is replicated — keep in sync).
function _normLabel(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
}

/** Bucket a raw method label → cash|card|kita|transfer|other. */
function normalizeMethod(raw) {
  const k = _normLabel(raw);
  if (!k) return 'other';
  if (k === 'ar' || /kita|كيتا|اجل|ذمم|credit/.test(k)) return 'kita';
  if (/cash|نقد|كاش/.test(k)) return 'cash';
  if (/card|mada|visa|master|amex|stc|شبكه|مدي|بطاقه|network/.test(k)) return 'card';
  if (/transfer|تحويل|bank|بنك|iban|حواله/.test(k)) return 'transfer';
  return 'other';
}

function _r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * Resolve a sale's payment legs → [{ label, amount }], plus whether it was split.
 * Handles every persisted shape:
 *   1. split_details_json — OBJECT {label: amount} (legacy UI, paymentMethod 'Split')
 *      or ARRAY [{method, amount}] (pos-v2 legacyPayload shape).
 *   2. payment_method string "Cash:80/Mada:20" (built at sale time for 'Split').
 *   3. payment_method literally 'split' with NO stored details (the React POS sends
 *      lowercase 'split', which the 'Split'-cased persistence guard misses) → the
 *      true legs live in pos_payments for the linked pos_order.
 *   4. plain single method label → one leg of total_final.
 */
async function _resolvePaymentLegs(db, sale, posOrder) {
  const total = _r2(sale.total_final);
  // 1. structured JSON
  if (sale.split_details_json) {
    try {
      const parsed = typeof sale.split_details_json === 'string'
        ? JSON.parse(sale.split_details_json) : sale.split_details_json;
      const legs = [];
      if (Array.isArray(parsed)) {
        parsed.forEach((p) => {
          const amt = _r2(p && p.amount);
          if (amt > 0) legs.push({ label: String((p && p.method) || 'other'), amount: amt });
        });
      } else if (parsed && typeof parsed === 'object') {
        Object.keys(parsed).forEach((name) => {
          const amt = _r2(parsed[name]);
          if (amt > 0) legs.push({ label: name, amount: amt });
        });
      }
      if (legs.length) return { legs, split: legs.length > 1 };
    } catch (_) { /* fall through */ }
  }
  const pm = String(sale.payment_method || '').trim();
  // 2. "Cash:80/Mada:20" string
  if (pm.indexOf(':') >= 0 && pm.indexOf('/') >= 0) {
    const legs = [];
    pm.split('/').forEach((part) => {
      const idx = part.lastIndexOf(':');
      if (idx < 0) return;
      const amt = _r2(part.slice(idx + 1));
      if (amt > 0) legs.push({ label: part.slice(0, idx), amount: amt });
    });
    if (legs.length) return { legs, split: legs.length > 1 };
  }
  // 3. bare 'split' → pos_payments of the linked v2 order
  if (_normLabel(pm) === 'split' && posOrder) {
    try {
      const [pp] = await db.query(
        'SELECT method, amount FROM pos_payments WHERE order_id = ? ORDER BY id', [posOrder.id]);
      const legs = pp
        .map((p) => ({ label: String(p.method || 'other'), amount: _r2(p.amount) }))
        .filter((l) => l.amount > 0);
      if (legs.length) return { legs, split: legs.length > 1 };
    } catch (_) { /* pos_payments absent — fall through */ }
  }
  // 4. single method
  return { legs: [{ label: pm || 'cash', amount: total }], split: false };
}

// ── shared upsert helpers ───────────────────────────────────────────────────

async function _enqueueDirty(db, branchId, businessDay) {
  if (!businessDay) return;
  await db.query(
    'INSERT IGNORE INTO analytics_rollup_dirty (branch_id, business_day) VALUES (?,?)',
    [branchId || 'UNASSIGNED', businessDay]);
}

async function _upsertPaymentFact(db, f) {
  await db.query(
    `INSERT INTO analytics_payment_facts
       (source_type, source_id, line_no, document_id, branch_id, brand_id, shift_id,
        method_raw, method_norm, provider, terminal, direction, amount, status, settled_at,
        occurred_at, occurred_at_local, business_day, performed_by, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       document_id = VALUES(document_id), branch_id = VALUES(branch_id),
       brand_id = VALUES(brand_id), shift_id = VALUES(shift_id),
       method_raw = VALUES(method_raw), method_norm = VALUES(method_norm),
       direction = VALUES(direction), amount = VALUES(amount), status = VALUES(status),
       occurred_at = VALUES(occurred_at), occurred_at_local = VALUES(occurred_at_local),
       business_day = VALUES(business_day), performed_by = VALUES(performed_by)`,
    [f.sourceType, String(f.sourceId), f.lineNo, f.documentId || null,
     f.branchId || 'UNASSIGNED', f.brandId || null, f.shiftId || null,
     String(f.methodRaw || '').slice(0, 60), f.methodNorm, f.provider || null, f.terminal || null,
     f.direction, _r2(f.amount), f.status || 'captured', f.settledAt || null,
     f.occurredAt, f.occurredAtLocal, f.businessDay, f.performedBy || null,
     f.provenance || 'live']);
}

async function _upsertTillFact(db, f) {
  await db.query(
    `INSERT INTO analytics_till_facts
       (shift_id, branch_id, movement_type, amount, occurred_at, occurred_at_local,
        business_day, performed_by, approved_by, source_type, source_id, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       shift_id = VALUES(shift_id), branch_id = VALUES(branch_id),
       amount = VALUES(amount), occurred_at = VALUES(occurred_at),
       occurred_at_local = VALUES(occurred_at_local), business_day = VALUES(business_day),
       performed_by = VALUES(performed_by), approved_by = VALUES(approved_by)`,
    [f.shiftId || null, f.branchId || 'UNASSIGNED', f.movementType, _r2(f.amount),
     f.occurredAt, f.occurredAtLocal, f.businessDay, f.performedBy || null,
     f.approvedBy || null, f.sourceType, String(f.sourceId), f.provenance || 'live']);
}

// ── 1. POS sale ─────────────────────────────────────────────────────────────

/**
 * Project a committed POS sale into order + payment + modifier + till facts, and
 * stamp category snapshots onto its ar_document_lines. Idempotent; re-running
 * after a void/return updates `status` in place (PK = document_id).
 *
 * opts.provenance: 'live' (default) | 'backfilled'.
 */
async function projectPosSale(db, saleId, opts = {}) {
  const provenance = opts.provenance || 'live';
  const [srows] = await db.query('SELECT * FROM sales WHERE id = ? LIMIT 1', [saleId]);
  if (!srows.length) return { skipped: 'sale_not_found' }; // voided-with-delete → nothing to project
  const sale = srows[0];

  // sale ↔ ar_document: UNIQUE(source_type='pos', source_id=sale.id). May be
  // absent when ORDER_TO_CASH_ENABLE was off — fall back to keying the order
  // fact by the sale id itself so analytics still work under both flags.
  let doc = null;
  try {
    const [d] = await db.query(
      "SELECT id, document_type, status FROM ar_documents WHERE source_type = 'pos' AND source_id = ? LIMIT 1",
      [saleId]);
    doc = d.length ? d[0] : null;
  } catch (_) { /* ar_documents absent on legacy deploys */ }
  const documentId = doc ? doc.id : saleId;

  // sale ↔ pos_order: pos_orders.sale_id = sales.id (stamped at /complete) and
  // pos_orders.id = sales.client_order_id (the checkout idempotency key).
  let po = null;
  try {
    const [p] = await db.query(
      'SELECT * FROM pos_orders WHERE sale_id = ? OR id = ? LIMIT 1',
      [saleId, sale.client_order_id || ' none']);
    po = p.length ? p[0] : null;
  } catch (_) { /* pos_orders absent */ }

  let branchId = sale.branch_id || (po && po.branch_id) || null;
  if (!branchId && sale.shift_id) {
    try {
      const [sh] = await db.query('SELECT branch_id FROM shifts WHERE id = ? LIMIT 1', [sale.shift_id]);
      if (sh.length) branchId = sh[0].branch_id || null;
    } catch (_) {}
  }
  branchId = branchId || 'UNASSIGNED';

  const occurredAt = sale.order_date;
  const loc = await _localize(db, branchId, occurredAt);

  const zt = String(sale.zatca_type || '').toLowerCase();
  const status = zt === 'cancellation' ? 'voided'
    : (Number(sale.has_credit_note) ? 'returned' : 'completed');

  // ── order fact ──
  await db.query(
    `INSERT INTO analytics_order_facts
       (document_id, sale_id, pos_order_id, brand_id, branch_id, warehouse_id, shift_id,
        till_id, device_id, app_version, channel_id, order_type, source, origin, table_no,
        guests, customer_id, status, created_by, salesperson, closed_by, payment_collector,
        discount_by, void_by, approved_by, opened_at, closed_at, paid_at,
        occurred_at_local, business_day, tz_snapshot,
        discount_total, rounding_amount, tips_amount, fees_amount, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       sale_id = VALUES(sale_id), pos_order_id = VALUES(pos_order_id),
       brand_id = VALUES(brand_id), branch_id = VALUES(branch_id),
       warehouse_id = VALUES(warehouse_id), shift_id = VALUES(shift_id),
       device_id = VALUES(device_id), channel_id = VALUES(channel_id),
       order_type = VALUES(order_type), origin = VALUES(origin), table_no = VALUES(table_no),
       customer_id = VALUES(customer_id), status = VALUES(status),
       closed_at = VALUES(closed_at), paid_at = VALUES(paid_at),
       occurred_at_local = VALUES(occurred_at_local), business_day = VALUES(business_day),
       tz_snapshot = VALUES(tz_snapshot), discount_total = VALUES(discount_total),
       fees_amount = VALUES(fees_amount)`,
    [documentId, saleId, po ? po.id : null, sale.brand_id || null, branchId,
     (po && po.warehouse_id) || null, sale.shift_id || null,
     null /* till_id — no till entity yet */, (po && po.device_id) || null,
     null /* app_version — not captured at checkout */, sale.channel_id || null,
     (po && po.order_type) || null, 'pos', (po && po.origin) || null,
     (po && po.table_no) || null,
     (po && po.guests != null) ? po.guests : null, sale.customer_id || null, status,
     sale.username || null, null, null, sale.username || null, null, null, null,
     (po && po.created_at) || occurredAt, (po && po.completed_at) || occurredAt, occurredAt,
     loc.occurredAtLocal, loc.businessDay, loc.tz,
     _r2(sale.discount_amount), 0, 0, _r2(sale.kita_service_fee), provenance]);

  // ── payment facts ──
  const { legs, split } = await _resolvePaymentLegs(db, sale, po);
  const sourceType = split ? 'pos_split' : 'pos_single';
  let cashPortion = 0;
  for (let i = 0; i < legs.length; i++) {
    const norm = normalizeMethod(legs[i].label);
    if (norm === 'cash') cashPortion = _r2(cashPortion + legs[i].amount);
    await _upsertPaymentFact(db, {
      sourceType, sourceId: saleId, lineNo: i, documentId,
      branchId, brandId: sale.brand_id, shiftId: sale.shift_id,
      methodRaw: legs[i].label, methodNorm: norm,
      direction: 'in', amount: legs[i].amount, status: 'captured',
      occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
      performedBy: sale.username, provenance,
    });
  }

  // ── modifier facts (combo choices) ──
  await _projectComboChoices(db, documentId, sale, loc, provenance);

  // ── till fact: the cash BILL portion of this sale ──
  if (cashPortion > 0 && status !== 'voided') {
    await _upsertTillFact(db, {
      shiftId: sale.shift_id, branchId, movementType: 'cash_sale', amount: cashPortion,
      occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
      performedBy: sale.username, sourceType: 'sale', sourceId: saleId, provenance,
    });
  }

  // ── ar_document_lines category snapshots ──
  // Runs AT SALE TIME, so menu's *current* category IS the at-sale category.
  // There is no categories master table (menu.category is a free-text name), so
  // category_id_snapshot stays NULL and the name is the snapshot.
  if (doc) {
    try {
      await db.query(
        `UPDATE ar_document_lines l JOIN menu m ON m.id = l.menu_id
            SET l.category_name_snapshot = m.category,
                l.snapshot_provenance = ?
          WHERE l.document_id = ? AND l.category_name_snapshot IS NULL`,
        [provenance === 'live' ? 'at_sale' : 'backfilled', documentId]);
    } catch (_) { /* snapshot columns not migrated yet (BE-A) — repair drain will fill */ }
  }

  await _enqueueDirty(db, branchId, loc.businessDay);
  return { documentId, branchId, businessDay: loc.businessDay, legs: legs.length, status };
}

/** Explode combo choices from items_json → analytics_modifier_facts (kind 'combo_choice'). */
async function _projectComboChoices(db, documentId, sale, loc, provenance) {
  let items = [];
  try { items = JSON.parse(sale.items_json || '[]'); } catch (_) { return; }
  // (lineIdx, componentMenuId) → { parent, qty }; source_line_id 'L<idx>' matches
  // the ar_document_lines projection (routes/sales.js `_lineTax` sourceLineId).
  const agg = new Map();
  items.forEach((it, idx) => {
    if (!it || !Array.isArray(it.comboChoices)) return;
    it.comboChoices.forEach((c) => {
      if (!c || !c.menuItemId) return;
      const key = idx + ' ' + String(c.menuItemId);
      const cur = agg.get(key) || { lineIdx: idx, parent: it.id || null, componentMenuId: String(c.menuItemId), groupIds: [], picks: 0, lineQty: Number(it.qty) || 1 };
      cur.picks += 1;
      if (c.groupId != null) cur.groupIds.push(String(c.groupId));
      agg.set(key, cur);
    });
  });
  if (!agg.size) return;

  // WHY A BACKFILL MUST NOT READ `menu.cost`
  //   `menu.computed_cost` / `menu.cost` are TODAY's figures. On the live path
  //   that is exactly right — "today" IS the sale date, so the read is a real
  //   at-sale snapshot. On the backfill path the sale may be a year old, and
  //   stamping today's cost into a column named `cost_snapshot` produces a
  //   number that is confidently wrong and indistinguishable from a true one.
  //
  //   There is no historical component cost to recover: `ar_document_lines`
  //   snapshots the cost of the WHOLE line (the combo), and splitting that
  //   across its chosen components needs the very per-component costs we are
  //   missing. So the honest value is NULL — the same call this function
  //   already makes for `price_delta` ("the historical price split is
  //   unknowable"). A margin report shows "unknown" instead of a fabrication.
  const historical = provenance !== 'live';
  const compIds = [...new Set([...agg.values()].map((a) => a.componentMenuId))];
  const nameById = {}, costById = {}, qtyByGroupComp = {};
  try {
    const ph = compIds.map(() => '?').join(',');
    const [names] = await db.query(
      `SELECT id, name, COALESCE(computed_cost, 0) AS cc, COALESCE(cost, 0) AS c
         FROM menu WHERE id IN (${ph})`, compIds);
    names.forEach((r) => {
      nameById[r.id] = r.name || null;
      // The name is still today's, and deliberately so: it is a LABEL, and
      // today's label is the best one available for a row nobody can re-price.
      // The cost is a FIGURE that feeds arithmetic — a different obligation.
      costById[r.id] = historical ? null : (Number(r.cc) > 0 ? Number(r.cc) : (Number(r.c) || 0));
    });
  } catch (_) {}
  try {
    const ph = compIds.map(() => '?').join(',');
    const [gq] = await db.query(
      `SELECT group_id, menu_item_id, qty FROM combo_group_items WHERE menu_item_id IN (${ph})`, compIds);
    gq.forEach((r) => { qtyByGroupComp[String(r.group_id) + ' ' + String(r.menu_item_id)] = Number(r.qty) || 1; });
  } catch (_) {}

  for (const a of agg.values()) {
    // per-pick component qty from the combo definition (default 1), × picks × line qty
    let perPick = 1;
    for (const g of a.groupIds) {
      const q = qtyByGroupComp[g + ' ' + a.componentMenuId];
      if (q) { perPick = q; break; }
    }
    const qty = perPick * a.picks * a.lineQty;
    // A SNAPSHOT IS WRITE-ONCE — hence the COALESCE below.
    //
    // The clause used to be a plain `cost_snapshot = VALUES(cost_snapshot)`,
    // which made every re-run DESTRUCTIVE: a fact captured live at sale time,
    // carrying a correct at-sale cost, was overwritten with TODAY's cost the
    // next time the backfill touched it. And `provenance` is not in this UPDATE
    // list, so the row kept reporting 'live' while its number no longer was.
    // The row then lied twice: a wrong figure, and a provenance vouching for it.
    //
    // Not hypothetical: _projectO2cReturn re-projects the ORIGINAL sale with
    // the RETURN's provenance, so backfilling one return silently rewrote the
    // costs of a sale that had been captured correctly months earlier.
    //
    // COALESCE keeps the first non-NULL capture, and still lets a NULL (what a
    // backfill now writes) be filled in later by a real at-sale value.
    // `qty` is deliberately NOT preserved — it is a recomputation, not a
    // snapshot, and a corrected combo definition should propagate.
    await db.query(
      `INSERT INTO analytics_modifier_facts
         (document_id, source_line_id, parent_menu_id, component_menu_id,
          component_name_snapshot, qty, price_delta, cost_snapshot, kind, provenance)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         qty = VALUES(qty), component_name_snapshot = VALUES(component_name_snapshot),
         cost_snapshot = COALESCE(analytics_modifier_facts.cost_snapshot, VALUES(cost_snapshot))`,
      [documentId, 'L' + a.lineIdx, a.parent, a.componentMenuId,
       nameById[a.componentMenuId] || null, qty,
       null /* POS combos carry no per-choice price delta */,
       costById[a.componentMenuId] != null ? costById[a.componentMenuId] : null,
       'combo_choice', provenance]);
  }
}

// ── 2. returns / credit notes ───────────────────────────────────────────────

/**
 * Project a return. Two shapes:
 *   { returnId }                 — O2C sales_returns (posted → its ar_documents CN)
 *   { creditNoteId, saleId }     — legacy credit_notes row (routes/sales.js /return)
 *
 * HARD REQUIREMENT: the refund attributes to the CREDIT NOTE's business day, never
 * the original sale's. The original sale's order fact is re-projected so its
 * status flips to 'returned' (its own day is re-enqueued by that re-projection).
 * No order-fact amount adjustments are made — the CN is its own document; queries
 * distinguish it via ar_documents.document_type / the fact's `source`.
 */
async function projectReturn(db, ref = {}) {
  const provenance = ref.provenance || 'live';
  if (ref.returnId) return _projectO2cReturn(db, ref.returnId, provenance);
  if (ref.creditNoteId) return _projectLegacyCreditNote(db, ref.creditNoteId, ref.saleId || null, provenance);
  return { skipped: 'no_ref' };
}

/** CN date attribution: a DATE-only value is pinned to 12:00 local so a day-close
 *  boundary (e.g. 04:00) can never push a dated document into the previous day. */
function _cnOccurredAt(dateVal, timeVal) {
  if (dateVal instanceof Date && (dateVal.getHours() || dateVal.getMinutes())) return dateVal;
  let ymd = null;
  if (dateVal instanceof Date) {
    ymd = dateVal.getFullYear() + '-' + String(dateVal.getMonth() + 1).padStart(2, '0') + '-' + String(dateVal.getDate()).padStart(2, '0');
  } else if (dateVal) {
    ymd = String(dateVal).slice(0, 10);
  }
  if (!ymd) return new Date();
  const t = timeVal && /^\d{2}:\d{2}/.test(String(timeVal)) ? String(timeVal).slice(0, 8) : '12:00:00';
  return new Date(ymd + 'T' + (t.length === 5 ? t + ':00' : t));
}

async function _projectO2cReturn(db, returnId, provenance) {
  const [rr] = await db.query('SELECT * FROM sales_returns WHERE id = ? LIMIT 1', [returnId]);
  if (!rr.length) return { skipped: 'return_not_found' };
  const row = rr[0];
  if (String(row.status) !== 'posted' || !row.credit_note_id) {
    return { skipped: 'return_not_posted' }; // draft/approved/cancelled/reversed → nothing final to project
  }
  const [cnRows] = await db.query('SELECT * FROM ar_documents WHERE id = ? LIMIT 1', [row.credit_note_id]);
  const cn = cnRows.length ? cnRows[0] : null;
  const branchId = row.branch_id || (cn && cn.branch_id) || 'UNASSIGNED';
  // ATTRIBUTION IS THE CREDIT-NOTE DATE (hard requirement). posted_at is used
  // only when it falls ON that date (for a real time-of-day); a backdated
  // return keeps the CN's own date, noon-pinned.
  const cnDate = _cnOccurredAt((cn && cn.issue_date) || row.return_date);
  const sameDay = row.posted_at instanceof Date &&
    row.posted_at.toDateString() === cnDate.toDateString();
  const occurredAt = sameDay ? row.posted_at : cnDate;
  const loc = await _localize(db, branchId, occurredAt);

  // fact row for the CN document itself (distinguished via ar_documents.document_type)
  await db.query(
    `INSERT INTO analytics_order_facts
       (document_id, sale_id, pos_order_id, brand_id, branch_id, warehouse_id, shift_id,
        till_id, device_id, app_version, channel_id, order_type, source, origin, table_no,
        guests, customer_id, status, created_by, salesperson, closed_by, payment_collector,
        discount_by, void_by, approved_by, opened_at, closed_at, paid_at,
        occurred_at_local, business_day, tz_snapshot,
        discount_total, rounding_amount, tips_amount, fees_amount, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), occurred_at_local = VALUES(occurred_at_local),
       business_day = VALUES(business_day), tz_snapshot = VALUES(tz_snapshot)`,
    [row.credit_note_id, row.original_sale_id || null, null,
     row.brand_id || null, branchId, row.warehouse_id || null, null,
     null, null, null, null, null, 'sales_return', null, null,
     null, row.customer_id || null,
     (cn && String(cn.status) === 'cancelled') ? 'voided' : 'completed',
     row.created_by || null, null, null, null, null, null, row.approved_by || null,
     occurredAt, occurredAt, occurredAt,
     loc.occurredAtLocal, loc.businessDay, loc.tz,
     0, 0, 0, 0, provenance]);

  // refund payment fact (direction 'out'). 'ar_reduction' moves no money but is
  // recorded (method_norm 'other') so refund reporting sees the full population.
  const method = String(row.refund_method || 'ar_reduction');
  const norm = method === 'ar_reduction' ? 'other'
    : (method === 'deposit' ? 'other' : normalizeMethod(method));
  await _upsertPaymentFact(db, {
    sourceType: 'refund', sourceId: returnId, lineNo: 0, documentId: row.credit_note_id,
    branchId, brandId: row.brand_id, shiftId: null,
    methodRaw: method, methodNorm: norm, direction: 'out',
    amount: row.total_amount, status: 'settled', settledAt: row.posted_at || null,
    occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
    performedBy: row.posted_by || row.created_by, provenance,
  });

  if (norm === 'cash') {
    await _upsertTillFact(db, {
      shiftId: null, branchId, movementType: 'cash_refund', amount: row.total_amount,
      occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
      performedBy: row.posted_by || row.created_by, sourceType: 'sales_return',
      sourceId: returnId, provenance,
    });
  }

  await _enqueueDirty(db, branchId, loc.businessDay);
  // flip the ORIGINAL sale's fact status → 'returned' (re-enqueues its own day)
  if (row.original_sale_id) await projectPosSale(db, row.original_sale_id, { provenance });
  return { creditNoteId: row.credit_note_id, businessDay: loc.businessDay };
}

async function _projectLegacyCreditNote(db, creditNoteId, saleId, provenance) {
  const [cRows] = await db.query('SELECT * FROM credit_notes WHERE id = ? LIMIT 1', [creditNoteId]);
  if (!cRows.length) return { skipped: 'credit_note_not_found' };
  const cn = cRows[0];
  const origSaleId = saleId || cn.original_sale_id;
  const branchId = cn.branch_id || 'UNASSIGNED';
  const occurredAt = _cnOccurredAt(cn.issue_date, cn.issue_time);
  const loc = await _localize(db, branchId, occurredAt);

  await db.query(
    `INSERT INTO analytics_order_facts
       (document_id, sale_id, pos_order_id, brand_id, branch_id, warehouse_id, shift_id,
        till_id, device_id, app_version, channel_id, order_type, source, origin, table_no,
        guests, customer_id, status, created_by, salesperson, closed_by, payment_collector,
        discount_by, void_by, approved_by, opened_at, closed_at, paid_at,
        occurred_at_local, business_day, tz_snapshot,
        discount_total, rounding_amount, tips_amount, fees_amount, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), occurred_at_local = VALUES(occurred_at_local),
       business_day = VALUES(business_day), tz_snapshot = VALUES(tz_snapshot)`,
    [creditNoteId, origSaleId || null, null, cn.brand_id || null, branchId, null,
     cn.shift_id || null, null, null, null, null, null, 'credit_note', null, null,
     null, cn.customer_id || null, 'completed',
     cn.username || null, null, null, null, null, null, null,
     occurredAt, occurredAt, occurredAt,
     loc.occurredAtLocal, loc.businessDay, loc.tz,
     0, 0, 0, 0, provenance]);

  // Legacy returns are always FULL-order reversals refunded the way the customer
  // paid — mirror the original sale's legs, direction 'out'.
  let legs = [{ label: 'cash', amount: _r2(cn.total_final) }];
  if (origSaleId) {
    try {
      const [os] = await db.query(
        'SELECT id, total_final, payment_method, split_details_json, client_order_id FROM sales WHERE id = ? LIMIT 1',
        [origSaleId]);
      if (os.length) legs = (await _resolvePaymentLegs(db, os[0], null)).legs;
    } catch (_) {}
  }
  let cashOut = 0;
  for (let i = 0; i < legs.length; i++) {
    const norm = normalizeMethod(legs[i].label);
    if (norm === 'cash') cashOut = _r2(cashOut + legs[i].amount);
    await _upsertPaymentFact(db, {
      sourceType: 'cn_refund', sourceId: creditNoteId, lineNo: i, documentId: creditNoteId,
      branchId, brandId: cn.brand_id, shiftId: cn.shift_id,
      methodRaw: legs[i].label, methodNorm: norm, direction: 'out',
      amount: legs[i].amount, status: 'settled',
      occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
      performedBy: cn.username, provenance,
    });
  }
  if (cashOut > 0) {
    await _upsertTillFact(db, {
      shiftId: cn.shift_id, branchId, movementType: 'cash_refund', amount: cashOut,
      occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
      performedBy: cn.username, sourceType: 'credit_note', sourceId: creditNoteId, provenance,
    });
  }

  await _enqueueDirty(db, branchId, loc.businessDay);
  if (origSaleId) await projectPosSale(db, origSaleId, { provenance }); // status → 'returned'
  return { creditNoteId, businessDay: loc.businessDay };
}

// ── 3. AR receipts ──────────────────────────────────────────────────────────

/** customer_payments (posted) → analytics_payment_facts source_type 'ar_receipt'. */
async function projectArReceipt(db, paymentId, opts = {}) {
  const provenance = opts.provenance || 'live';
  const [rows] = await db.query('SELECT * FROM customer_payments WHERE id = ? LIMIT 1', [paymentId]);
  if (!rows.length) return { skipped: 'payment_not_found' };
  const row = rows[0];
  if (String(row.status) !== 'posted') return { skipped: 'payment_not_posted' };
  const branchId = row.branch_id || 'UNASSIGNED';
  // attribution is the receipt's payment_date (noon-pinned when DATE-only)
  const occurredAt = _cnOccurredAt(row.payment_date);
  const loc = await _localize(db, branchId, occurredAt);
  let norm = normalizeMethod(row.payment_method);
  if (norm === 'other' && String(row.destination_type) === 'bank') norm = 'transfer';
  if (norm === 'other' && String(row.destination_type) === 'cash') norm = 'cash';
  await _upsertPaymentFact(db, {
    sourceType: 'ar_receipt', sourceId: paymentId, lineNo: 0, documentId: null,
    branchId, brandId: row.brand_id, shiftId: null,
    methodRaw: row.payment_method || row.destination_type, methodNorm: norm,
    direction: 'in', amount: row.amount, status: 'settled',
    settledAt: row.posted_at || null,
    occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
    performedBy: row.posted_by || row.created_by, provenance,
  });
  await _enqueueDirty(db, branchId, loc.businessDay);
  return { paymentId, businessDay: loc.businessDay };
}

// ── 4. till movements ───────────────────────────────────────────────────────

/**
 * Shift-driven till movements.
 *   { type: 'open_float',  shiftId }  — reads shifts.opening_float/start_time
 *   { type: 'close_count', shiftId }  — reads shifts.actual_cash (fallback:
 *                                       payment_totals_json cash-group actual)
 * Both are idempotent on UNIQUE(source_type='shift', source_id=shiftId, movement_type).
 */
async function projectTillMovement(db, opts = {}) {
  const provenance = opts.provenance || 'live';
  const { type, shiftId } = opts;
  if (!shiftId || (type !== 'open_float' && type !== 'close_count')) {
    return { skipped: 'bad_args' };
  }
  const [rows] = await db.query('SELECT * FROM shifts WHERE id = ? LIMIT 1', [shiftId]);
  if (!rows.length) return { skipped: 'shift_not_found' };
  const sh = rows[0];
  const branchId = sh.branch_id || 'UNASSIGNED';

  let amount, occurredAt;
  if (type === 'open_float') {
    amount = _r2(sh.opening_float);
    occurredAt = sh.start_time || new Date();
  } else {
    if (String(sh.status).toLowerCase() !== 'closed') return { skipped: 'shift_not_closed' };
    amount = _r2(sh.actual_cash);
    if (!amount && sh.payment_totals_json) {
      try {
        const pt = typeof sh.payment_totals_json === 'string'
          ? JSON.parse(sh.payment_totals_json) : sh.payment_totals_json;
        if (Array.isArray(pt && pt.breakdown)) {
          amount = _r2(pt.breakdown
            .filter((b) => String(b.groupType || '').toLowerCase() === 'cash')
            .reduce((s, b) => s + (Number(b.actual) || 0), 0));
        }
      } catch (_) {}
    }
    occurredAt = sh.end_time || new Date();
  }

  const loc = await _localize(db, branchId, occurredAt);
  await _upsertTillFact(db, {
    shiftId, branchId, movementType: type, amount,
    occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
    performedBy: sh.username, sourceType: 'shift', sourceId: shiftId, provenance,
  });
  await _enqueueDirty(db, branchId, loc.businessDay);
  return { shiftId, type, amount, businessDay: loc.businessDay };
}

/**
 * Cash vouchers → pay_in / pay_out till movements.
 * kind: 'cash_receipt' | 'cash_payment'. Only POSTED vouchers moving a CASH BOX
 * **with a branch dimension** become till movements; treasury/bank-side vouchers
 * (no branch_id, or destination/source is a bank account) are deliberately
 * skipped — they are ledger movements, not till movements.
 *
 * W2-A — SHIFT LINKAGE. cash_receipts/cash_payments now carry a nullable
 * `shift_id` (server.js migration), written by POST /api/shifts/:shiftId/
 * movements when a cashier records a drop to the safe / float top-up / petty
 * cash and a manager approves it. The value is read OFF THE ROW rather than
 * taken from a caller argument so every entry point gets it for free — the live
 * post-commit projection, RollupService's repair drain, and
 * scripts/analytics/backfill-facts.js all call this function with no shift in
 * hand. `opts.shiftId` is accepted as an explicit override for a caller that
 * has one. A treasury/back-office voucher still has shift_id NULL and projects
 * EXACTLY as before.
 *
 * Branch fallback: a shift-linked voucher whose branch is unresolvable inherits
 * the shift's branch, and finally 'UNASSIGNED' — the same bucket
 * projectTillMovement puts that shift's open_float/close_count in. Without it a
 * branchless shift's pay_in/pay_out would silently vanish while its float and
 * counted cash were still reconciled, which is worse than no linkage at all.
 */
async function projectCashVoucher(db, kind, voucherId, opts = {}) {
  const provenance = opts.provenance || 'live';
  const isReceipt = kind === 'cash_receipt';
  const table = isReceipt ? 'cash_receipts' : 'cash_payments';
  const [rows] = await db.query(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [voucherId]);
  if (!rows.length) return { skipped: 'voucher_not_found' };
  const v = rows[0];
  if (String(v.status) !== 'posted') return { skipped: 'voucher_not_posted' };
  const boxType = isReceipt ? v.destination_type : v.source_type;
  if (String(boxType) !== 'cash') return { skipped: 'not_a_cash_box_movement' };

  // shift_id may be absent on a pre-migration database — never let a missing
  // column turn into a projection failure.
  const shiftId = opts.shiftId || (Object.prototype.hasOwnProperty.call(v, 'shift_id') ? v.shift_id : null) || null;
  let branchId = v.branch_id || null;
  if (!branchId && shiftId) {
    const [sr] = await db.query('SELECT branch_id FROM shifts WHERE id = ? LIMIT 1', [shiftId]);
    branchId = (sr.length && sr[0].branch_id) || 'UNASSIGNED';
  }
  if (!branchId) return { skipped: 'no_branch_scope' }; // treasury-only op

  const occurredAt = v.approved_at || _cnOccurredAt(isReceipt ? v.receipt_date : v.payment_date);
  const loc = await _localize(db, branchId, occurredAt);
  await _upsertTillFact(db, {
    shiftId, branchId,
    movementType: isReceipt ? 'pay_in' : 'pay_out', amount: v.amount,
    occurredAt, occurredAtLocal: loc.occurredAtLocal, businessDay: loc.businessDay,
    performedBy: v.created_by, approvedBy: v.approved_by,
    sourceType: kind, sourceId: voucherId, provenance,
  });
  await _enqueueDirty(db, branchId, loc.businessDay);
  return { voucherId, shiftId, branchId, businessDay: loc.businessDay };
}

// ── non-fatal wrapper ───────────────────────────────────────────────────────

/**
 * Run a projection, NEVER throw. On error: console.error + upsert into
 * analytics_projection_repair (attempts+1, last_error) so a drain job can retry.
 * Returns the projection result, or null on failure. Callers fire-and-forget
 * (the returned promise never rejects), exactly like the zatca enqueue pattern.
 */
async function safeProject(db, sourceType, sourceId, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error('[analytics] projection failed:', sourceType, sourceId,
      (e && (e.code || '')) || '', e && e.message);
    try {
      await db.query(
        `INSERT INTO analytics_projection_repair (source_type, source_id, queued_at, attempts, last_error)
         VALUES (?,?,NOW(),1,?)
         ON DUPLICATE KEY UPDATE attempts = attempts + 1, last_error = VALUES(last_error)`,
        [String(sourceType), String(sourceId),
         String((e && (e.stack || e.message)) || e).slice(0, 2000)]);
    } catch (e2) {
      console.error('[analytics] repair enqueue ALSO failed:', e2 && e2.message);
    }
    return null;
  }
}

module.exports = {
  projectPosSale,
  projectReturn,
  projectArReceipt,
  projectTillMovement,
  projectCashVoucher,
  safeProject,
  // exported for backfill / tests
  loadBranchTz,
  normalizeMethod,
  _resolvePaymentLegs,
  _enqueueDirty,
  _projectComboChoices,
};
