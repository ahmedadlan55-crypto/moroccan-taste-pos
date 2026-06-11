const router = require('express').Router();
const db = require('../db/connection');
const bcrypt = require('bcryptjs');
const gl = require('../lib/glPosting');
const zatca = require('../lib/zatca');
const { recomputeInvItemStock, recomputeMenuStock, deductWarehouseStock } = require('../lib/stockRecompute');
// v6.20.0 — Central tax math.  Honors per-item is_tax_inclusive + reads
// the live VAT rate from settings (not ENV anymore).
const pricing = require('../lib/pricing');
// v6.11.0 — Human-readable invoice / void / return numbering. Helpers
// tolerate missing schema columns and return null silently so this
// require stays safe on deploys that haven't run migration 0002 yet.
const salesNumbering = require('../lib/salesNumbering');
// v6.1.0 Wave E.6 — queue trigger for ZATCA submissions
let zatcaWorker;
try { zatcaWorker = require('../lib/zatca-worker'); } catch (_) { zatcaWorker = { enqueue: () => {} }; }
// v6.2.0 Wave F.3 — period-close guard
let _periodsModule;
try { _periodsModule = require('./erp/periods'); } catch (_) { _periodsModule = { assertPeriodOpen: async () => {} }; }
async function _assertPeriodOpen(conn, date, brandId, branchId) {
  if (_periodsModule && typeof _periodsModule.assertPeriodOpen === 'function') {
    return _periodsModule.assertPeriodOpen(conn, date, brandId, branchId);
  }
}

// v6.20.0 — VAT_RATE is now resolved at REQUEST TIME from the settings
// table (see pricing.getVatRateFromDb).  The legacy ENV fallback is
// retained ONLY as a last-resort default if the settings query fails.
const VAT_RATE_FALLBACK = Number(process.env.VAT_RATE) || 15;
const SELLER_NAME_FALLBACK = process.env.COMPANY_NAME || 'Moroccan Taste';
const SELLER_VAT_FALLBACK = process.env.TAX_NUMBER || '';

// Map payment method keys → GL account codes.
// cash → 1110 (Cash), card/mada/stc/online → 1120 (Bank), kita/credit → 1150 (AR)
function _payToAccountCode(method) {
  const m = (method || '').toLowerCase();
  if (m === 'cash' || m.startsWith('cash')) return '1110';
  if (m === 'kita' || m === 'credit' || m === 'ar' || m.indexOf('ذمم') >= 0) return '1150';
  // default card/bank
  return '1120';
}

// V5.7.18 — same Arabic normalization the shift-close matcher uses.
//   So "مدى" / "مدي" / "Mada" / "MADA" all match the same payment-method
//   regardless of which variant the cashier typed at sale time.
function _normPmName(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
}

// Build a payment-method → GL account code map by joining payment_methods.gl_account_id → gl_accounts.code
// Returns: { 'cash': '1110', 'card': '1120', 'hangerstation': '4150', ... }
// V5.7.18 — keys normalized; both name and name_ar registered so the
//   sale's payment_method string resolves to the configured GL even
//   when the cashier typed an Arabic variant (مدى vs مدي).
async function _buildPmGlMap(db) {
  const map = {};
  try {
    const [rows] = await db.query(`
      SELECT pm.id, pm.name, pm.name_ar, ga.code AS gl_code
        FROM payment_methods pm
        LEFT JOIN gl_accounts ga ON ga.id = pm.gl_account_id
       WHERE pm.is_active = 1 AND pm.gl_account_id IS NOT NULL AND pm.gl_account_id <> ''
    `);
    rows.forEach(r => {
      if (!r.gl_code) return;
      // Index by id, normalized name, and normalized name_ar (each token of name_ar split on '/')
      if (r.id != null)  map[String(r.id)] = r.gl_code;
      const k1 = _normPmName(r.name);
      const k2 = _normPmName(r.name_ar);
      if (k1) map[k1] = r.gl_code;
      if (k2) map[k2] = r.gl_code;
      // Tokenize Arabic name on common separators ("مدى/شبكة" → "مدى" and "شبكة")
      String(r.name_ar || '').split(/[\/،\-,]/).forEach(p => {
        const k = _normPmName(p);
        if (k && !map[k]) map[k] = r.gl_code;
      });
    });
  } catch(e) { /* gl_account_id column may be missing on very old schemas — ignore */ }
  return map;
}

// V3: parse split payment using the dynamic GL map (falls back to legacy mapping)
// V5.7.18 — lookup uses the SAME normalization as the map build so مدى and
//   مدي resolve to the same GL account.
function _parseSplitPaymentsV3(payStr, total, pmGlMap) {
  const out = [];
  const lookup = (name) => {
    const k = _normPmName(name);
    return (pmGlMap && pmGlMap[k]) || _payToAccountCode(name);
  };
  if (!payStr || payStr.indexOf(':') < 0) {
    out.push({ code: lookup(payStr), amount: Number(total) || 0 });
    return out;
  }
  // Split-payment requires BOTH '/' AND ':' (else a name like "مدى/شبكة"
  //   gets misparsed — same fix pattern as the shift matcher).
  if (payStr.indexOf('/') < 0) {
    out.push({ code: lookup(payStr), amount: Number(total) || 0 });
    return out;
  }
  const parts = payStr.split('/');
  parts.forEach(p => {
    const [k, v] = p.split(':');
    const amt = Number(v) || 0;
    if (amt > 0) out.push({ code: lookup(k), amount: amt });
  });
  if (!out.length) out.push({ code: lookup(payStr), amount: Number(total) || 0 });
  return out;
}

// V3: resolve discount GL account id → code (with fallback to 4901 'Sales Discounts')
async function _resolveDiscountGlCode(db, glAccountId) {
  if (!glAccountId) return '4901'; // default Sales Discount account
  try {
    const [rows] = await db.query('SELECT code FROM gl_accounts WHERE id = ? LIMIT 1', [glAccountId]);
    if (rows.length && rows[0].code) return rows[0].code;
  } catch(e) {}
  return '4901';
}

// Back-compat shim — old code still calls _parseSplitPayments
function _parseSplitPayments(payStr, total) {
  return _parseSplitPaymentsV3(payStr, total, null);
}

// v7.2 (#8) — Route split-payment GL legs from the STRUCTURED splitDetails
// object instead of re-parsing the lossy "Cash:80/Mada:20" string. A method
// name containing '/' (e.g. "شبكة/مدى") corrupts the string parse and dumps
// the amount into the wrong GL account. The object's keys are the exact
// method names the cashier picked, so we map each one through pmGlMap (with
// the same normalization the map build uses) and fall back to the legacy
// payToAccountCode heuristic only when a method isn't configured.
//   splitDetails: { Cash: 80, Mada: 20, ... }  →  [{code, amount}, ...]
function _parseSplitFromDetails(splitDetails, pmGlMap) {
  const out = [];
  const lookup = (name) => {
    const k = _normPmName(name);
    return (pmGlMap && pmGlMap[k]) || _payToAccountCode(name);
  };
  if (!splitDetails || typeof splitDetails !== 'object') return out;
  Object.keys(splitDetails).forEach(name => {
    const amt = Math.round((Number(splitDetails[name]) || 0) * 100) / 100;
    if (amt > 0) out.push({ code: lookup(name), amount: amt });
  });
  return out;
}

// v7.2 (#9) — Resolve the sale's standard GL account codes from settings
// (key/value, same table getVatRateFromDb reads) so a chart-of-accounts
// import that renumbers Revenue / Output-VAT / COGS / Inventory doesn't make
// EVERY sale roll back with "حساب غير موجود". Each key is optional; when
// absent we keep the canonical core code (which gl.ensureCoreAccounts seeds
// on first post, so a standard account can never be missing). Returns:
//   { revenue, outputVat, cogs, inventory }
async function _resolveSaleGlCodes(db) {
  const codes = { revenue: '4100', outputVat: '2210', cogs: '5100', inventory: '1200' };
  const keyMap = {
    revenue:   'GL_SALES_REVENUE_CODE',
    outputVat: 'GL_OUTPUT_VAT_CODE',
    cogs:      'GL_COGS_CODE',
    inventory: 'GL_INVENTORY_CODE'
  };
  try {
    const wantedKeys = Object.values(keyMap);
    const ph = wantedKeys.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${ph})`,
      wantedKeys
    );
    const settings = {};
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    for (const [field, key] of Object.entries(keyMap)) {
      const v = settings[key];
      if (v != null && String(v).trim() !== '') codes[field] = String(v).trim();
    }
  } catch (e) { /* settings table missing on legacy deploys — keep core codes */ }
  return codes;
}

// v6.0.2 Wave B.2 — Invoice immutability guard.
// Per ZATCA BR-KSA-08, once an invoice has been submitted to the ZATCA
// reporting/clearance gateway (zatca_submitted_at set), it cannot be
// modified or deleted — only a Credit Note can offset it. This helper
// throws if the sale row has been submitted; callers that need to allow
// pre-submission edits should call it before any UPDATE/DELETE.
async function _ensureNotSubmitted(conn, orderId) {
  const c = conn || db;
  try {
    const [r] = await c.query(
      'SELECT zatca_submitted_at FROM sales WHERE id = ? LIMIT 1',
      [orderId]
    );
    if (r.length && r[0].zatca_submitted_at) {
      const err = new Error('Cannot modify a sale that has been submitted to ZATCA');
      err.code = 'invoice_immutable';
      err.status = 403;
      throw err;
    }
  } catch (e) {
    // The zatca_submitted_at column may not exist on very old deploys —
    // in that case, no enforcement is possible and we let the caller pass.
    if (e.code === 'invoice_immutable') throw e;
  }
}

// Save order
// v6.0.1 Wave A — Entire handler wrapped in a DB transaction. All
// queries below run on _conn (a single pooled connection). The outer
// `db` import is shadowed by `const db = _conn` so existing query calls
// keep working without rewriting every line. GL posting failure now
// throws (A.2), triggering rollback of sale + inventory + ZATCA stamp.
router.post('/', async (req, res) => {
  const _pool = db; // capture outer pool reference before shadowing
  let _conn;
  try {
    _conn = await _pool.getConnection();
    await _conn.beginTransaction();
    // eslint-disable-next-line no-shadow
    const db = _conn; // local shadow — every db.query() below routes through _conn

    const { items, total, totalFinal, paymentMethod, discountName, discountAmount, lineDiscountTotal, kitaServiceFee, splitDetails } = req.body;
    const { shiftId, warehouseId: reqWhId } = req.body;
    // v7.2 — HIGH: the actor is the AUTHENTICATED user, never the body.
    // The route is behind the global JWT gate (server.js), so req.user is
    // populated with the verified token claims. Trusting req.body.username
    // let a caller post a sale under any cashier's name (audit forgery +
    // wrong shift/commission attribution). We take the username from the
    // token and keep the body value only as a last-resort fallback for the
    // theoretical case where req.user is somehow absent.
    const username = (req.user && req.user.username) || req.body.username || '';
    // v7.2 — CRITICAL idempotency key. The POS sends a stable clientOrderId
    // per checkout attempt and re-sends it on every retry of the SAME sale.
    const clientOrderId = (req.body.clientOrderId != null && String(req.body.clientOrderId).trim() !== '')
      ? String(req.body.clientOrderId).trim().slice(0, 80)
      : null;
    // ─── V3: optional channel + discount metadata from POS ───
    let { channelId, channelName, discountId, discountGlAccountId, lineDiscounts: lineDiscPayload } = req.body;
    // ─── v5.11.4: optional customer payload (id OR phone+name+gender) + Other-method notes ───
    const { customer: customerPayload, paymentNotes } = req.body;
    // v7.3 — cash tendered + change due (optional; stored for receipt + drawer)
    const cashTendered = Math.max(0, Number(req.body.cashTendered) || 0);
    const changeDue    = Math.max(0, Number(req.body.changeDue) || 0);

    // ─── v7.2 HIGH: Cart validation (fail fast, before any writes) ───
    // An empty / malformed cart used to slip through and create a
    // zero-value invoice with no GL journal. Reject up-front with 400.
    // We DO NOT override legitimate client prices (channel / price-list
    // overrides are valid) — we only reject prices that are not a finite
    // number >= 0. Same for qty (must be > 0) and id (must be present).
    if (!Array.isArray(items) || items.length === 0) {
      const err = new Error('السلة فارغة — لا يمكن إتمام عملية بيع بدون أصناف');
      err.status = 400; err.code = 'empty_cart';
      throw err;
    }
    for (let _vi = 0; _vi < items.length; _vi++) {
      const _it = items[_vi];
      if (!_it || typeof _it !== 'object') {
        const err = new Error('سطر غير صالح في السلة (#' + (_vi + 1) + ')');
        err.status = 400; err.code = 'invalid_line'; throw err;
      }
      if (_it.id == null || String(_it.id).trim() === '') {
        const err = new Error('صنف بدون مُعرّف (id) في السلة (#' + (_vi + 1) + ')');
        err.status = 400; err.code = 'invalid_item_id'; throw err;
      }
      const _q = Number(_it.qty);
      if (!Number.isFinite(_q) || _q <= 0) {
        const err = new Error('كمية غير صالحة للصنف "' + (_it.name || _it.id) + '" — يجب أن تكون أكبر من صفر');
        err.status = 400; err.code = 'invalid_qty'; throw err;
      }
      const _p = Number(_it.price);
      if (!Number.isFinite(_p) || _p < 0) {
        const err = new Error('سعر غير صالح للصنف "' + (_it.name || _it.id) + '" — يجب أن يكون رقماً صفر أو أكثر');
        err.status = 400; err.code = 'invalid_price'; throw err;
      }
    }

    // ─── v7.2 CRITICAL: Idempotency guard (double-POST safety) ───
    // If the POS already created this sale (same clientOrderId), return the
    // ORIGINAL success response with HTTP 200 WITHOUT inserting anything
    // again. This makes network retries / double-taps safe (no duplicate
    // invoice, GL journal, or stock relief). The UNIQUE index on
    // sales.client_order_id is the final race-safety net (see the
    // ER_DUP_ENTRY handler around the sales INSERT).
    if (clientOrderId) {
      try {
        const [dup] = await db.query(
          'SELECT id, invoice_number, total_final, invoice_uuid, invoice_hash, ' +
          'previous_invoice_hash, customer_id FROM sales WHERE client_order_id = ? LIMIT 1',
          [clientOrderId]
        );
        if (dup.length) {
          // Already processed — release the (untouched) transaction and
          // echo the original sale so the POS reconciles to the same order.
          try { await _conn.rollback(); } catch (_) {}
          try { _conn.release(); } catch (_) {}
          _conn = null;
          return res.status(200).json({
            success: true,
            idempotent: true,
            orderId: dup[0].id,
            invoiceNumber: dup[0].invoice_number || null,
            customerId: dup[0].customer_id || null,
            zatca: {
              uuid: dup[0].invoice_uuid || null,
              invoiceHash: dup[0].invoice_hash || null,
              previousInvoiceHash: dup[0].previous_invoice_hash || null,
              qrBase64: null
            },
            totals: { total: Number(dup[0].total_final) || 0 }
          });
        }
      } catch (dupErr) {
        // client_order_id column may be missing on a not-yet-migrated
        // deploy — fall through and process normally (no idempotency).
        if (dupErr && dupErr.code && dupErr.code !== 'ER_BAD_FIELD_ERROR') {
          // unexpected DB error — surface it, don't silently proceed
          throw dupErr;
        }
      }
    }
    // ─── v7.3 HIGH: server-side shift integrity (not just the POS guard) ──
    // The POS blocks checkout without an open shift, but that guard reads
    // localStorage and can desync (cleared session, second tab, a stale id
    // after the shift was closed elsewhere). Every sale MUST FK to a REAL
    // OPEN shift owned by this cashier, or the shift-close cash
    // reconciliation and the audit trail silently break. Placed AFTER the
    // idempotency short-circuit (so a legit retry of an already-posted sale
    // still echoes success even if the shift has since closed) and BEFORE
    // any writes. Tolerant of a missing/legacy shifts schema (skips the
    // check rather than blocking the sale).
    if (!shiftId || String(shiftId).trim() === '') {
      const err = new Error('لا توجد وردية مفتوحة — افتح وردية قبل تسجيل المبيعات');
      err.status = 400; err.code = 'shift_required'; throw err;
    }
    let _shiftRow = null, _shiftCheckable = true;
    try {
      const [shiftRows] = await db.query('SELECT id, status, username FROM shifts WHERE id = ? LIMIT 1', [shiftId]);
      _shiftRow = shiftRows.length ? shiftRows[0] : null;
    } catch (shErr) {
      if (shErr && (shErr.code === 'ER_NO_SUCH_TABLE' || shErr.code === 'ER_BAD_FIELD_ERROR')) _shiftCheckable = false;
      else throw shErr;
    }
    if (_shiftCheckable) {
      if (!_shiftRow) {
        const err = new Error('الوردية غير موجودة — ربما أُغلقت. افتح وردية جديدة وأعد المحاولة');
        err.status = 400; err.code = 'shift_not_found'; throw err;
      }
      if (String(_shiftRow.status || '').toUpperCase() !== 'OPEN') {
        const err = new Error('الوردية مغلقة — لا يمكن تسجيل مبيعات على وردية مغلقة');
        err.status = 400; err.code = 'shift_closed'; throw err;
      }
      if (_shiftRow.username && username && _shiftRow.username !== username) {
        const err = new Error('هذه الوردية تخص مستخدماً آخر — افتح وردية باسمك');
        err.status = 400; err.code = 'shift_owner_mismatch'; throw err;
      }
    }

    // V5.9.2 — 4-step fallback chain to resolve which warehouse the
    //   cashier's sale should deduct from:
    //     1. Explicit warehouseId in the request body (POS override)
    //     2. Cashier's user.default_warehouse_id
    //     3. Cashier's branch's warehouse_id (the natural one)
    //     4. null (will skip warehouse-specific deduction; global stock
    //        on inv_items is the only thing that updates).
    let warehouseId = reqWhId || (req.user && req.user.default_warehouse_id) || null;
    if (!warehouseId && username) {
      try {
        const [u] = await db.query(
          'SELECT u.branch_id, b.warehouse_id ' +
          'FROM users u LEFT JOIN branches b ON b.id = u.branch_id ' +
          'WHERE u.username = ? LIMIT 1',
          [username]
        );
        if (u.length && u[0].warehouse_id) {
          warehouseId = u[0].warehouse_id;
        }
      } catch(e) { /* legacy schema — ignore */ }
    }
    const orderId = shiftId + '-' + Date.now();
    const now = new Date();

    // v6.11.0 — Reserve a human-readable invoice number (INV-YYYYMMDD-NNNN).
    // Done up-front so it's part of the audit trail even on rollback;
    // returns null gracefully when the schema migration hasn't run yet.
    const _ymd = '' + now.getFullYear()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0');
    let invoiceNumber = null;
    try { invoiceNumber = await salesNumbering.nextInvoiceNumber(db, _ymd); }
    catch (_) { /* tolerate — falls back to orderId in UI */ }

    // ─── v6.2.0 Wave F.3 — Period close guard ───
    // Reject the sale up-front if the date falls in a closed/locked
    // accounting period. We do this before any inventory or GL writes
    // so the transaction stays clean.
    try {
      await _assertPeriodOpen(db, now, req.body.brandId || null, req.body.branchId || null);
    } catch (periodErr) {
      // Bubble out of the transaction so the outer catch returns 403
      throw periodErr;
    }

    // v7.1 — default to the main dine-in channel when the POS omits the channel,
    // so every sale is attributed (no NULL "بدون قناة" rows in channel reports).
    if (!channelId) {
      try {
        const [_dc] = await db.query("SELECT id FROM sales_channels WHERE channel_type = 'dine_in' AND is_active = 1 ORDER BY display_order LIMIT 1");
        channelId = _dc.length ? _dc[0].id : 'CH-MAIN';
      } catch (_) { channelId = 'CH-MAIN'; }
    }

    // ─── V3: Resolve channel name from DB if id provided ───
    let resolvedChannelName = channelName || null;
    if (channelId && !resolvedChannelName) {
      try {
        const [chRow] = await db.query('SELECT name FROM sales_channels WHERE id = ?', [channelId]);
        if (chRow.length) resolvedChannelName = chRow[0].name;
      } catch(e) {}
    }

    // Determine payment method string
    let payStr = paymentMethod;
    if (paymentMethod === 'Split' && splitDetails) {
      payStr = Object.entries(splitDetails).filter(([k,v]) => v > 0).map(([k,v]) => k+':'+Math.round(v)).join('/');
    }

    // ───── v6.20.0 — Tax computation rewrite ─────
    // Step A: Resolve the active VAT rate.  Reads settings.VATRate at
    //         REQUEST TIME so changes via the settings page take effect
    //         on the very next sale (no server restart needed).
    const VAT_RATE = await pricing.getVatRateFromDb(db, VAT_RATE_FALLBACK);

    // Step B: Look up each item's tax_category + is_tax_inclusive flag
    //         in a single round-trip.  Items missing from the menu
    //         (rare: walk-in / custom line) fall back to 'S' + inclusive
    //         (preserves pre-v6.20.0 semantics for any unknown line).
    const _taxMeta = {};
    try {
      const itemIds = items.map(it => it.id).filter(Boolean);
      if (itemIds.length) {
        const ph = itemIds.map(() => '?').join(',');
        const [mrows] = await db.query(
          'SELECT id, COALESCE(tax_category, \'S\') AS tax_category, ' +
          'COALESCE(is_tax_inclusive, 1) AS is_tax_inclusive, ' +
          'COALESCE(active, 1) AS active ' +
          'FROM menu WHERE id IN (' + ph + ')',
          itemIds
        );
        mrows.forEach(m => {
          _taxMeta[m.id] = {
            cat: m.tax_category || 'S',
            inclusive: Number(m.is_tax_inclusive) === 1,
            active: Number(m.active) !== 0
          };
        });
      }
    } catch (_) { /* menu schema gaps on older deploys — fall through */ }

    // ─── A1 (v7.4) — Ghost / disabled-item guard ───
    // Defence-in-depth behind the POS add-to-cart guard: refuse to invoice a
    // line whose menu item is DISABLED (active=0 / soft-deleted). We only
    // reject items we can POSITIVELY confirm are disabled, so unknown ids
    // (channel / walk-in / custom lines not present in `menu`) are never
    // blocked and a valid channel sale is never rejected at the till. Custom
    // lines may opt out explicitly via __custom. Thrown as a 400 → the outer
    // catch rolls back the transaction and surfaces the message to the POS.
    const _blockedLines = items.filter(it =>
      it && it.id && !it.__custom &&
      _taxMeta[it.id] && _taxMeta[it.id].active === false
    );
    if (_blockedLines.length) {
      const _names = _blockedLines.map(it => it.name || it.id).join('، ');
      const dErr = new Error('تعذّر إتمام البيع: أصناف لم تعد متاحة (' + _names + '). يرجى تحديث القائمة.');
      dErr.status = 400;
      dErr.code = 'item_unavailable';
      throw dErr;
    }

    // Step C: For every line, split price into net + vat using the
    //         per-item is_tax_inclusive flag.  Accumulate per-category
    //         subtotals for ZATCA + accumulate a precise grand total.
    //         The client-supplied `totalFinal` is IGNORED for the
    //         authoritative total — the backend recomputes from line
    //         items and rounds to a whole SAR for the customer-facing
    //         amount (owner's v6.20.0 requirement).
    const taxSubtotals = {};
    let grandNet = 0, grandVat = 0;
    items.forEach(it => {
      const meta = _taxMeta[it.id] || { cat: 'S', inclusive: true };
      const cat = meta.cat;
      const isIncl = meta.inclusive;
      const qty = Number(it.qty) || 0;
      const unitPrice = Number(it.price) || 0;
      const rate = cat === 'S' ? VAT_RATE : 0;
      // splitLinePrice gives us per-unit net + vat; multiply by qty.
      const split = pricing.splitLinePrice(unitPrice, isIncl, rate);
      const lineNet = Math.round(split.net * qty * 100) / 100;
      const lineVat = Math.round(split.vat * qty * 100) / 100;
      grandNet += lineNet;
      grandVat += lineVat;
      if (!taxSubtotals[cat]) taxSubtotals[cat] = { net: 0, vat: 0, rate };
      taxSubtotals[cat].net += lineNet;
      taxSubtotals[cat].vat += lineVat;
    });
    Object.keys(taxSubtotals).forEach(k => {
      taxSubtotals[k].net = Math.round(taxSubtotals[k].net * 100) / 100;
      taxSubtotals[k].vat = Math.round(taxSubtotals[k].vat * 100) / 100;
    });
    grandNet = Math.round(grandNet * 100) / 100;
    grandVat = Math.round(grandVat * 100) / 100;

    // ─── v7.3 CRITICAL: discounts in GROSS (tax-inclusive) space ───────
    // The POS computes the customer-facing total ENTIRELY in gross:
    //   totalFinal = grossSubtotal − lineDiscountTotal − invoiceDiscount.
    // The backend MUST mirror that exact space or the recorded total
    // diverges from what the cashier showed (→ cash-drawer mismatch at
    // shift close). The old code applied ONLY the invoice discount, to the
    // NET, and IGNORED line discounts entirely. We now reduce the GROSS
    // subtotal by BOTH the line-discount total AND the invoice discount,
    // then scale net + vat TOGETHER by the post-discount ratio so
    // per-category VAT stays correct and net + vat === invTotal holds.
    // Both discounts arrive from the POS as GROSS figures.
    const grossSubtotal = Math.round((grandNet + grandVat) * 100) / 100;
    const invoiceDiscountGross = Math.max(0, Number(discountAmount) || 0);
    const lineDiscountGross    = Math.max(0, Number(lineDiscountTotal) || 0);
    // Line discounts first (mirrors the POS order + per-line persistence),
    // invoice discount on the remainder; each capped so the total can never
    // go negative or invent a credit.
    const lineDiscCapped     = Math.min(lineDiscountGross, grossSubtotal);
    const grossAfterLine     = Math.round((grossSubtotal - lineDiscCapped) * 100) / 100;
    const invDiscCapped      = Math.min(invoiceDiscountGross, grossAfterLine);
    const grossAfterDiscount = Math.round((grossAfterLine - invDiscCapped) * 100) / 100;
    // ONE ratio scales NET and VAT together (gross-proportional). A
    // zero-rated bucket (vat already 0) stays 0, and the VAT-factor skew the
    // old net-space discount caused is gone.
    const discountRatio    = grossSubtotal > 0 ? (grossAfterDiscount / grossSubtotal) : 0;
    const netAfterDiscount = Math.round(grandNet * discountRatio * 100) / 100;
    const vatAfterDiscount = Math.round(grandVat * discountRatio * 100) / 100;

    const grossPrecise = Math.round((netAfterDiscount + vatAfterDiscount) * 100) / 100;
    // The TOTAL stored on the sales row + shown to the customer is the
    // WHOLE-SAR rounded amount.  The per-category breakdown above keeps
    // its 2-decimal precision so the ZATCA QR / invoice XML validate.
    const grossWhole = pricing.roundToWhole(grossPrecise);
    const invTotal = grossWhole;

    // ─── v7.2 CRITICAL (#1): derive net + vat PER-CATEGORY, not flat ───
    // The legacy line recomputed `net = invTotal / 1.15` and `vat = total
    // - net`, applying the standard 15% rate to the WHOLE invoice. That
    // over-charged VAT on zero-rated/exempt lines and ignored the discount
    // mix. We instead build net/vat from the per-category POST-DISCOUNT
    // buckets:
    //   • netAfterDiscount  = Σ (category net × discount ratio)   — all cats
    //   • vatAfterDiscount  = Σ (category vat × discount ratio)   — S only,
    //                         because Z/E/O categories were split at rate 0
    //                         so their vat contribution is already 0.
    // Then we absorb the whole-SAR rounding delta (invTotal vs grossPrecise)
    // so the journal invariant net + vat === invTotal holds EXACTLY and the
    // 2210 Output-VAT credit + totals.vat returned to the POS are correct.
    const _roundDelta = Math.round((invTotal - grossPrecise) * 100) / 100;
    // Push the (tiny) rounding delta onto the NET side, then make VAT the
    // residual. This keeps Output-VAT tied to the actual taxable base and
    // never invents VAT on a zero-rated cart (vat stays 0 when no S lines).
    let net = Math.round((netAfterDiscount + _roundDelta) * 100) / 100;
    let vat = Math.round((invTotal - net) * 100) / 100;
    // Guard: if the cart is entirely zero-rated/exempt (vatAfterDiscount is
    // 0), force vat to 0 and let net carry the full total so we never credit
    // 2210 for an exempt sale. net + vat === invTotal is preserved.
    if (vatAfterDiscount <= 0) {
      vat = 0;
      net = invTotal;
    }

    // ─── v7.3 CRITICAL: money-safety reconciliation guard ──────────────
    // The recorded total MUST equal what the cashier displayed. Both sides
    // now compute the customer-facing total in the SAME gross space with the
    // SAME discounts and round to a whole SAR, so they can only differ by
    // sub-riyal rounding. If the client total is present and off by MORE than
    // 1 SAR, something is wrong (a dropped discount, a tampered price, a stale
    // cart, a contract drift) — REJECT the sale inside the transaction
    // (rollback: no sale, no GL, no ZATCA serial) rather than silently
    // charging a different amount. We always record the SERVER figure
    // (invTotal); within tolerance, displayed == recorded == charged.
    // Skipped when the client omits totalFinal (legacy POS builds) so the
    // server recompute still governs with no regression.
    const clientTotalFinal = Math.round(Number(totalFinal) || 0);
    if (Number.isFinite(clientTotalFinal) && clientTotalFinal > 0 &&
        Math.abs(invTotal - clientTotalFinal) > 1) {
      const mmErr = new Error(
        'تعذّر إتمام البيع: الإجمالي المعروض (' + clientTotalFinal +
        ') لا يطابق الإجمالي المحسوب (' + invTotal +
        '). يرجى تحديث السلة وإعادة المحاولة · Displayed total does not match the computed total.'
      );
      mmErr.status = 400;
      mmErr.code = 'total_mismatch';
      throw mmErr;
    }
    // v7.5 — audit trail for sub-tolerance drift (0.5–1 SAR is accepted, but a
    // recurring pattern means client/server math is drifting — catch it early).
    if (Number.isFinite(clientTotalFinal) && clientTotalFinal > 0) {
      const _tfDelta = Math.abs(invTotal - clientTotalFinal);
      if (_tfDelta >= 0.5 && _tfDelta <= 1) {
        console.warn('[sale ' + orderId + '] total drift within tolerance: client=' +
          clientTotalFinal + ' server=' + invTotal + ' (delta ' + _tfDelta + ')');
      }
    }

    // ─── v7.2 CRITICAL (#2): reconcile taxSubtotals to the POST-DISCOUNT
    // figures before persisting. taxSubtotals was built PRE-discount, so
    // sum(net)/sum(vat) wouldn't tie to the GL/total after a discount and
    // the ZATCA UBL XML (which sums these buckets) would fail validation.
    // Scale every bucket by the same discount ratio used above, then make
    // the LAST standard bucket absorb the rounding residual so the buckets
    // sum EXACTLY to the persisted net/vat.
    {
      const _cats = Object.keys(taxSubtotals);
      let _accNet = 0, _accVat = 0;
      _cats.forEach(k => {
        const b = taxSubtotals[k];
        b.net = Math.round((b.net * discountRatio) * 100) / 100;
        b.vat = Math.round((b.vat * discountRatio) * 100) / 100;
        _accNet += b.net;
        _accVat += b.vat;
      });
      _accNet = Math.round(_accNet * 100) / 100;
      _accVat = Math.round(_accVat * 100) / 100;
      // Reconcile bucket sums to the authoritative net/vat (which include
      // the whole-SAR rounding delta). Prefer a standard-rated bucket for
      // the VAT residual; net residual can land on any bucket.
      if (_cats.length) {
        const _netResidual = Math.round((net - _accNet) * 100) / 100;
        const _vatResidual = Math.round((vat - _accVat) * 100) / 100;
        const _stdCat = _cats.find(k => Number(taxSubtotals[k].rate) > 0) || _cats[0];
        const _netCat = _cats[_cats.length - 1];
        taxSubtotals[_netCat].net = Math.round((taxSubtotals[_netCat].net + _netResidual) * 100) / 100;
        taxSubtotals[_stdCat].vat = Math.round((taxSubtotals[_stdCat].vat + _vatResidual) * 100) / 100;
      }
    }

    // ═══ ZATCA Phase 2 stamp (UUID + hash chain + QR) ═══
    // Load seller details — company + branch names if available
    let sellerName = SELLER_NAME_FALLBACK, sellerVat = SELLER_VAT_FALLBACK;
    try {
      const [cRow] = await db.query("SELECT name, tax_number FROM companies WHERE id='CO-MAIN' LIMIT 1");
      if (cRow.length) {
        if (cRow[0].name) sellerName = cRow[0].name;
        if (cRow[0].tax_number) sellerVat = cRow[0].tax_number;
      }
    } catch(e) {}

    // ─── v7.2 CRITICAL (#4): serialize the ZATCA hash-chain head ───
    // getLastInvoiceHash() does SELECT … ORDER BY created_at DESC LIMIT 1
    // FOR UPDATE, which locks the *previous* invoice row — but on GENESIS
    // (zero invoices) that query matches no rows and acquires NO lock, so
    // two concurrent first-sales can both read prev=null and fork the chain.
    // It also can't serialize the very first link otherwise. We take an
    // explicit row lock on a stable sentinel row (settings key) on the SAME
    // _conn inside this txn BEFORE reading the chain head. Every concurrent
    // checkout must queue on this single row, so the read→stamp→insert of
    // the chain head is strictly serialized (held until commit/rollback).
    // Defensive: tolerates a missing settings table (older deploys) — in
    // that case we lose the extra guard but the per-row FOR UPDATE still
    // serializes the common (non-genesis) path.
    try {
      await db.query(
        "INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('zatca_chain_lock', '1')"
      );
      await db.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'zatca_chain_lock' FOR UPDATE"
      );
    } catch (lockErr) {
      // v7.5 — FAIL-SAFE: proceeding without the chain lock can fork the
      // ZATCA hash chain under concurrency (two genesis invoices with the
      // same previousHash). Abort the sale (rollback) instead of continuing.
      console.error('[sale ' + orderId + '] zatca chain lock FAILED — aborting sale:', lockErr.message);
      throw lockErr;
    }

    let zatcaStamp = {};
    try {
      zatcaStamp = await zatca.stampSale(db, {
        orderId,
        createdAt: now,
        total: invTotal,
        vatAmount: vat,
        lines: items.map(it => ({ name: it.name, qty: it.qty, unitPrice: it.price, lineTotal: it.qty * it.price }))
      }, { name: sellerName, vatNumber: sellerVat });
    } catch(e) {
      zatcaStamp = { uuid: null, invoiceHash: null, previousInvoiceHash: null, qrBase64: null };
    }

    // Insert sale (legacy columns)
    // v6.20.0 — total_final = invTotal (the backend-recomputed, whole-SAR
    // rounded gross).  Pre-v6.20.0 stored the raw `totalFinal` from the
    // POS payload, which could disagree with the per-line VAT breakdown.
    // Now they're guaranteed to match: line sums (net + vat) round to
    // grossPrecise; grossWhole = Math.round(grossPrecise) = total_final.
    // v7.2 — store the idempotency key on insert. We try the wide INSERT
    // (with client_order_id) first; on a not-yet-migrated deploy the column
    // is absent → ER_BAD_FIELD_ERROR → fall back to the legacy INSERT. On a
    // concurrent double-POST the UNIQUE index throws ER_DUP_ENTRY → we
    // rollback this (uncommitted) attempt and return the original sale's
    // success response so the second request is a safe no-op.
    try {
      if (clientOrderId) {
        await db.query('INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, discount_name, discount_amount, kita_service_fee, client_order_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [orderId, now, JSON.stringify(items), invTotal, payStr, username, shiftId, discountName || '', discountAmount || 0, kitaServiceFee || 0, clientOrderId]);
      } else {
        await db.query('INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, discount_name, discount_amount, kita_service_fee) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [orderId, now, JSON.stringify(items), invTotal, payStr, username, shiftId, discountName || '', discountAmount || 0, kitaServiceFee || 0]);
      }
    } catch (insErr) {
      if (insErr && insErr.code === 'ER_DUP_ENTRY' && clientOrderId) {
        // Lost the race — another request already committed this sale.
        try { await _conn.rollback(); } catch (_) {}
        let _orig = null;
        try {
          const [rows] = await _conn.query(
            'SELECT id, invoice_number, total_final, invoice_uuid, invoice_hash, ' +
            'previous_invoice_hash, customer_id FROM sales WHERE client_order_id = ? LIMIT 1',
            [clientOrderId]
          );
          if (rows.length) _orig = rows[0];
        } catch (_) {}
        try { _conn.release(); } catch (_) {}
        _conn = null;
        return res.status(200).json({
          success: true,
          idempotent: true,
          orderId: _orig ? _orig.id : orderId,
          invoiceNumber: _orig ? (_orig.invoice_number || null) : null,
          customerId: _orig ? (_orig.customer_id || null) : null,
          zatca: {
            uuid: _orig ? (_orig.invoice_uuid || null) : null,
            invoiceHash: _orig ? (_orig.invoice_hash || null) : null,
            previousInvoiceHash: _orig ? (_orig.previous_invoice_hash || null) : null,
            qrBase64: null
          },
          totals: { total: _orig ? (Number(_orig.total_final) || 0) : invTotal }
        });
      }
      if (insErr && insErr.code === 'ER_BAD_FIELD_ERROR' && clientOrderId) {
        // client_order_id column not present on this deploy — insert without it.
        await db.query('INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, discount_name, discount_amount, kita_service_fee) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [orderId, now, JSON.stringify(items), invTotal, payStr, username, shiftId, discountName || '', discountAmount || 0, kitaServiceFee || 0]);
      } else {
        throw insErr;
      }
    }

    // v6.11.0 — Stamp the invoice_number on the freshly-inserted row.
    // Separate UPDATE keeps the INSERT signature stable + makes the column
    // optional on deploys that haven't applied migration 0002 yet.
    if (invoiceNumber) {
      try { await db.query('UPDATE sales SET invoice_number = ? WHERE id = ?', [invoiceNumber, orderId]); }
      catch (_) { invoiceNumber = null; /* column missing — clear so we don't lie in the response */ }
    }

    // ─── V3: Persist channel + discount metadata (post-insert update so it works on older deploys) ───
    try {
      await db.query(
        `UPDATE sales SET channel_id=?, channel_name=?, discount_id=?, discount_gl_id=?, line_discounts_json=? WHERE id=?`,
        [channelId || null, resolvedChannelName || null, discountId || null, discountGlAccountId || null,
         lineDiscPayload ? JSON.stringify(lineDiscPayload) : null, orderId]
      );
    } catch(e) { /* columns may be missing on very old deploys — ignore */ }

    // ─── v5.11.4: Resolve / upsert customer by phone, then link to the sale ───
    // Strategy: phone is the natural key. If the cashier sent a customer.id,
    // trust it. Otherwise look up by phone; create on the fly when missing.
    //
    // v6.13.0 — Surface failures via `customerSaveOutcome` so the cashier UI
    // can tell the user what happened. Categories:
    //   linked-existing     — found by id or phone, sale linked OK
    //   created-new         — fresh insert succeeded
    //   skipped-no-data     — payload missing both phone and name
    //   skipped-no-phone    — name given but phone is the natural key
    //   failed-insert       — INSERT exception (e.g. duplicate phone race)
    //   failed-other        — anything else swallowed by the outer catch
    let resolvedCustomerId = null;
    let customerSaveOutcome = null;
    let customerSaveError = null;
    if (customerPayload && typeof customerPayload === 'object') {
      try {
        const cName  = String(customerPayload.name  || '').trim();
        const cPhone = String(customerPayload.phone || '').trim();
        const cGenderRaw = String(customerPayload.gender || 'unknown').toLowerCase();
        const cGender = (cGenderRaw === 'male' || cGenderRaw === 'female') ? cGenderRaw : 'unknown';
        if (customerPayload.id) {
          // Trust the supplied id — confirm it exists then use it
          const [chk] = await db.query('SELECT id FROM customers WHERE id = ? AND is_active = 1 LIMIT 1', [customerPayload.id]);
          if (chk.length) {
            resolvedCustomerId = customerPayload.id;
            customerSaveOutcome = 'linked-existing';
          }
        }
        if (!resolvedCustomerId && cPhone) {
          const [existing] = await db.query(
            'SELECT id FROM customers WHERE phone = ? AND is_active = 1 LIMIT 1',
            [cPhone]
          );
          if (existing.length) {
            resolvedCustomerId = existing[0].id;
            customerSaveOutcome = 'linked-existing';
            // Refresh name + gender if cashier provided more recent info
            try {
              await db.query(
                'UPDATE customers SET name = COALESCE(NULLIF(?, \'\'), name), gender = ?, updated_by = ? WHERE id = ?',
                [cName, cGender, username || '', resolvedCustomerId]
              );
            } catch(e) {}
          } else if (cName || cPhone) {
            resolvedCustomerId = 'CUST-' + Date.now();
            try {
              await db.query(
                `INSERT INTO customers (id, name, phone, gender, customer_type, created_by)
                 VALUES (?, ?, ?, ?, 'B2C', ?)`,
                [resolvedCustomerId, cName || cPhone, cPhone, cGender, username || '']
              );
              customerSaveOutcome = 'created-new';
            } catch(e) {
              resolvedCustomerId = null;
              customerSaveOutcome = 'failed-insert';
              customerSaveError = e.message || 'INSERT failed';
              console.warn('[sales] customer INSERT failed:', customerSaveError);
            }
          }
        }
        // v6.13.0 — Distinguish the two "nothing to save" paths so the UI
        // can give a targeted hint instead of generic silence.
        if (!resolvedCustomerId && !customerSaveOutcome) {
          if (!cName && !cPhone)      customerSaveOutcome = 'skipped-no-data';
          else if (cName && !cPhone)  customerSaveOutcome = 'skipped-no-phone';
        }
      } catch(e) {
        // Never block a sale on customer-capture issues, but record the
        // reason so the operator isn't left wondering.
        customerSaveOutcome = customerSaveOutcome || 'failed-other';
        customerSaveError   = customerSaveError   || (e && e.message) || 'unknown';
        console.warn('[sales] customer upsert outer catch:', customerSaveError);
      }
    }

    // ─── v5.11.4: Link customer + persist payment notes (post-insert update — tolerates pre-migration deploys) ───
    try {
      await db.query(
        'UPDATE sales SET customer_id = ?, payment_notes = ? WHERE id = ?',
        [resolvedCustomerId || null, (paymentNotes && String(paymentNotes).trim()) || null, orderId]
      );
    } catch(e) { /* columns missing — older deploy, skip */ }

    // ─── v6.0.2 Wave B.3 — Persist VAT category breakdown ───
    try {
      const subtotalsHasData = Object.keys(taxSubtotals).length > 0;
      await db.query(
        'UPDATE sales SET tax_subtotals_json = ? WHERE id = ?',
        [subtotalsHasData ? JSON.stringify(taxSubtotals) : null, orderId]
      );
    } catch(e) { /* tax_subtotals_json missing on older deploy */ }

    // ─── v6.0.3 Wave C.4 — Persist structured split-payment JSON ───
    // The legacy payStr "Cash:80/Mada:20" string breaks when a method
    // name contains '/' (e.g. "شبكة/مدى"). The JSON form is unambiguous.
    if (paymentMethod === 'Split' && splitDetails && typeof splitDetails === 'object') {
      try {
        await db.query(
          'UPDATE sales SET split_details_json = ? WHERE id = ?',
          [JSON.stringify(splitDetails), orderId]
        );
      } catch(e) { /* split_details_json missing on older deploy */ }
    }

    // ─── v7.3 — Persist cash tendered + change due (tolerant) ───
    // v8.0 — persist for ANY method that carried cash, including a Split whose
    // cash leg gave change (the unified tender flow). splitDetails still holds
    // the per-method BILL portions; these two fields are the cash-handling
    // overlay for the receipt + drawer.
    if (cashTendered > 0 || changeDue > 0) {
      try {
        await db.query(
          'UPDATE sales SET cash_tendered = ?, change_due = ? WHERE id = ?',
          [cashTendered, changeDue, orderId]
        );
      } catch (e) { /* cash_tendered/change_due missing on older deploy */ }
    }

    // Stamp ZATCA fields back (tolerate schemas without these columns)
    if (zatcaStamp.uuid) {
      try {
        await db.query(
          `UPDATE sales SET invoice_uuid=?, invoice_hash=?, previous_invoice_hash=?, zatca_type=? WHERE id=?`,
          [zatcaStamp.uuid, zatcaStamp.invoiceHash, zatcaStamp.previousInvoiceHash || null, 'simplified', orderId]);
      } catch(e) { /* older schema — ignore */ }
    }

    // Build recipe map: menu_id → [{ invId, invName, qtyUsed, wastePct }]
    // V5.6: now includes BOTH legacy `recipe` table AND modern `bom`/`bom_lines`.
    // Per menu item, BOM takes priority (it's the new system); recipe is the fallback.
    const recipeMap = {};

    // 1. Modern BOMs linked to menu items via menu.bom_id
    try {
      const [bomRows] = await db.query(`
        SELECT m.id AS menu_id, b.id AS bom_id, b.yield_quantity,
               bl.component_item_id, bl.quantity, bl.waste_pct,
               COALESCE(i.name, '') AS inv_name
        FROM menu m
        INNER JOIN bom b ON b.id = m.bom_id AND b.is_active = 1
        INNER JOIN bom_lines bl ON bl.bom_id = b.id
        LEFT JOIN inv_items i ON i.id = bl.component_item_id
        WHERE m.bom_id IS NOT NULL`);
      bomRows.forEach(r => {
        if (!recipeMap[r.menu_id]) recipeMap[r.menu_id] = [];
        const yieldQ = Math.max(1, Number(r.yield_quantity)||1);
        const wasteFactor = 1 + (Number(r.waste_pct)||0)/100;
        recipeMap[r.menu_id].push({
          invId: r.component_item_id,
          invName: r.inv_name || '',
          qtyUsed: (Number(r.quantity)||0) * wasteFactor / yieldQ,
          source: 'bom'
        });
      });
    } catch(_) {}

    // 2. Legacy recipe table — only used for menu items that DON'T have a BOM yet
    const [recipes] = await db.query('SELECT * FROM recipe');
    recipes.forEach(r => {
      if (recipeMap[r.menu_id]) return;  // BOM already covers this — skip legacy
      if (!recipeMap[r.menu_id]) recipeMap[r.menu_id] = [];
      recipeMap[r.menu_id].push({
        invId: r.inv_item_id,
        invName: r.inv_item_name || '',
        qtyUsed: Number(r.qty_used),
        source: 'legacy_recipe'
      });
    });

    // 3. v5.12.3 — Channel-specific BOM overrides. If this sale was made
    // through a sales channel that has a custom bom_id on any of its
    // channel_menu_items, that BOM replaces the menu's default for the
    // matching item only. Lets one main menu product expose different
    // recipes per channel (e.g. delivery uses larger packaging).
    if (channelId) {
      try {
        const itemIds = items.map(it => it.id).filter(Boolean);
        if (itemIds.length) {
          const ph = itemIds.map(() => '?').join(',');
          const [overrides] = await db.query(
            `SELECT cmi.menu_item_id, b.yield_quantity,
                    bl.component_item_id, bl.quantity, bl.waste_pct,
                    COALESCE(i.name, '') AS inv_name
             FROM channel_menu_items cmi
             INNER JOIN bom b ON b.id = cmi.bom_id AND b.is_active = 1
             INNER JOIN bom_lines bl ON bl.bom_id = b.id
             LEFT JOIN inv_items i ON i.id = bl.component_item_id
             WHERE cmi.channel_id = ? AND cmi.bom_id IS NOT NULL
               AND cmi.menu_item_id IN (${ph})`,
            [channelId, ...itemIds]
          );
          if (overrides.length) {
            const overrideMap = {};
            overrides.forEach(r => {
              if (!overrideMap[r.menu_item_id]) overrideMap[r.menu_item_id] = [];
              const yieldQ = Math.max(1, Number(r.yield_quantity) || 1);
              const wasteFactor = 1 + (Number(r.waste_pct) || 0) / 100;
              overrideMap[r.menu_item_id].push({
                invId:   r.component_item_id,
                invName: r.inv_name || '',
                qtyUsed: (Number(r.quantity) || 0) * wasteFactor / yieldQ,
                source:  'channel_override'
              });
            });
            // Replace recipeMap entries for items the channel overrides
            Object.keys(overrideMap).forEach(mid => { recipeMap[mid] = overrideMap[mid]; });
            console.log('[sales] channel ' + channelId + ' overrode recipe for ' +
                        Object.keys(overrideMap).length + ' item(s)');
          }
        }
      } catch (e) { console.warn('[sales] channel recipe override failed:', e.message); }
    }

    // V5.7 — Build production-method map so we know how to handle each item:
    //   - made_at_branch  → made-to-order: do NOT touch menu.stock; only deduct ingredients
    //   - made_at_kitchen → same as branch but flagged for kitchen production logging
    //   - prepared        → batch-made (uses semi-finished or BOM); deduct ingredients
    //   - imported        → physical stocked goods; deduct from menu.stock + warehouse_stock
    const [productionMetaRows] = await db.query(
      `SELECT id, COALESCE(production_method, 'made_at_branch') AS production_method,
              COALESCE(deduct_strategy, 'on_sale') AS deduct_strategy,
              COALESCE(allow_negative_stock, 1) AS allow_negative_stock,
              stock
       FROM menu`);
    const productionMetaMap = {};
    productionMetaRows.forEach(r => {
      productionMetaMap[r.id] = {
        method: r.production_method,
        strategy: r.deduct_strategy,
        allowNegative: !!r.allow_negative_stock,
        currentStock: Number(r.stock) || 0
      };
    });

    // ─── NEW: Build semi-finished consumption map ───
    // For finished products that consume from a semi-finished (e.g. كوب شاي مغربي → براد شاي مغربي)
    const [menuRows] = await db.query(
      'SELECT id, name, consumes_semi_id, consumes_semi_qty FROM menu WHERE consumes_semi_id IS NOT NULL AND consumes_semi_id <> ""'
    );
    const semiConsumeMap = {};
    for (const m of menuRows) {
      semiConsumeMap[m.id] = { semiId: m.consumes_semi_id, semiQty: Number(m.consumes_semi_qty || 0) };
    }
    // Lookup semi-finished names for movement logs
    const semiNameMap = {};
    if (Object.keys(semiConsumeMap).length) {
      const semiIds = [...new Set(Object.values(semiConsumeMap).map(x => x.semiId))];
      const [semiRows] = await db.query(
        `SELECT id, name FROM menu WHERE id IN (${semiIds.map(()=>'?').join(',')})`,
        semiIds
      );
      semiRows.forEach(r => { semiNameMap[r.id] = r.name; });
    }

    // Production: removed debug log

    // Diagnostic info to return to the frontend so we can verify deductions worked
    const recipesApplied = []; // [{ menuId, menuName, deductions: [{invId, invName, deducted, affected}] }]
    const itemsWithoutRecipe = []; // menu items that have no recipe attached
    const semiDeductions = []; // [{ menuId, menuName, semiId, semiName, qty }]
    // v7.2 (#7) — imported finished goods physically relieve warehouse stock
    // but are NOT in recipeMap, so without this they would book revenue with
    // ZERO COGS (inventory never relieved in the GL). Track each imported
    // deduction so we can value it at menu.cost and post the COGS/Inventory
    // legs alongside the recipe-driven COGS.
    const importedDeductions = []; // [{ menuId, menuName, qty }]

    for (const item of items) {
      // sales_items log row
      await db.query('INSERT INTO sales_items (order_id, order_date, item_name, qty, price, total, payment_method, username, shift_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [orderId, now, item.name, item.qty, item.price, item.qty * item.price, payStr, username, shiftId]);

      // Stock deduction
      if (!item.id) {
        itemsWithoutRecipe.push({ name: item.name, reason: 'no item id' });
        continue;
      }

      // ─── Legacy semi-finished consumption (v5.x → fallback as of v6.5.0) ───
      // v6.5.0 — Semi-finished items moved from `menu` to `inv_items`
      // (kind='semi'). The startup migration in server.js translates every
      // `menu.consumes_semi_id` pointer into an equivalent `recipe` row
      // (menu_id → INV-SEMI-x), so the unified raw-recipe deduction path
      // below already handles the consumption.
      //
      // The branch is kept ONLY as a safety net for unmigrated rows (e.g.
      // a fresh installation that hasn't booted v6.5.0 yet, or a
      // consumer link the migration could not resolve). We skip it when
      // a recipe row exists for this menu_id pointing to a semi item —
      // otherwise we would double-deduct.
      if (semiConsumeMap[item.id]) {
        const sc = semiConsumeMap[item.id];

        // Has the migration already wired a recipe row? If yes the raw
        // loop below will handle it — skip this legacy branch.
        let skipLegacy = false;
        try {
          const [recipeCheck] = await db.query(
            `SELECT COUNT(*) AS c FROM recipe r
               JOIN inv_items i ON i.id = r.inv_item_id
              WHERE r.menu_id = ? AND i.kind = 'semi'`,
            [item.id]
          );
          if (recipeCheck[0] && Number(recipeCheck[0].c) > 0) skipLegacy = true;
        } catch (_) { /* inv_items.kind absent on very old DBs — fall through */ }

        if (!skipLegacy) {
          const consumed = sc.semiQty * item.qty;
          // v5.10.19 — warehouse_stock is the source of truth. menu.stock for
          // semi-finished products becomes a SUM(warehouse_stock.qty) rollup
          // so multi-warehouse balances stay independent.
          if (warehouseId) {
            // v7.1 — atomic upsert-deduct: creates a NEGATIVE row if the semi
            // has none in this warehouse (empty branch) so the shortage is real
            // and visible, instead of a 0-rows UPDATE that silently vanishes.
            await deductWarehouseStock(db, warehouseId, sc.semiId, consumed);
            await recomputeMenuStock(db, sc.semiId);
          } else {
            // Legacy fallback: no warehouse — deduct global menu.stock directly.
            // v7.1 — allow negative (true shortage) instead of flooring at 0.
            await db.query('UPDATE menu SET stock = stock - ? WHERE id = ?', [consumed, sc.semiId]);
          }
          // Movement log
          const movId = 'MOV-SEMI-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
          // v7.5 — carry reference_type/reference_id like the raw-recipe path so
          // every deduction is traceable to its invoice; graceful fallback for
          // older schemas without the columns (mirrors the pattern below).
          try {
            await db.query(
              'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
              [movId, now, sc.semiId, semiNameMap[sc.semiId] || sc.semiId, 'out', consumed,
               'مبيعات (نصف مصنع - legacy)', username, orderId + ' / ' + item.name, warehouseId || null,
               'sale', (invoiceNumber || orderId)]
            );
          } catch (refErr) {
            if (refErr && refErr.code === 'ER_BAD_FIELD_ERROR') {
              await db.query(
                'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
                [movId, now, sc.semiId, semiNameMap[sc.semiId] || sc.semiId, 'out', consumed,
                 'مبيعات (نصف مصنع - legacy)', username, orderId + ' / ' + item.name, warehouseId || null]
              );
            } else { throw refErr; }
          }
          semiDeductions.push({
            menuId: item.id, menuName: item.name,
            semiId: sc.semiId, semiName: semiNameMap[sc.semiId] || sc.semiId,
            qty: consumed
          });
          // Skip the raw recipe deduction — semi covers it (legacy path)
          continue;
        }
        // skipLegacy=true → fall through to the unified raw-recipe loop
      }

      // V5.7 — For "imported" items (physically stocked goods like canned drinks),
      // ALSO deduct from menu.stock + warehouse_stock so the cashier sees the right
      // remaining count. For made-to-order (made_at_branch/kitchen/prepared) items,
      // skip menu.stock entirely — the only truth is the ingredients.
      // v5.10.19 — warehouse_stock leads, menu.stock is recomputed as the sum.
      // v6.0.3 Wave C.2 — recomputeMenuStock now always derives menu.stock as
      // SUM(warehouse_stock.qty) so multi-warehouse drift is impossible.
      const meta = productionMetaMap[item.id];
      if (meta && meta.method === 'imported') {
        try {
          if (warehouseId) {
            // v7.1 — never silently clamp at 0. Stock must reflect reality so
            // an over-sale shows as NEGATIVE (visible shortage) instead of a
            // misleading 0. (The register is never blocked.)
            // v7.1 — atomic upsert-deduct (creates a negative row if missing so
            // an over-sale from an empty warehouse shows the true shortage).
            await deductWarehouseStock(db, warehouseId, item.id, item.qty);
            // C.2 — always re-derive from sum, not GREATEST-clamp the global field
            await recomputeMenuStock(db, item.id);
          } else {
            // Legacy: no warehouse → write global menu.stock directly.
            await db.query(
              `UPDATE menu SET stock = stock - ? WHERE id = ?`,
              [item.qty, item.id]);
          }
          // v7.2 (#7) — record the imported relief so its cost flows into
          // the COGS/Inventory GL legs below (otherwise revenue posts with
          // zero COGS and inventory is never relieved in the ledger).
          importedDeductions.push({ menuId: item.id, menuName: item.name, qty: Number(item.qty) || 0 });
        } catch(_) {}
      }

      // ─── LEGACY PATH: raw recipe deduction (unchanged) ───
      if (!recipeMap[item.id]) {
        itemsWithoutRecipe.push({ id: item.id, name: item.name, reason: 'no recipe defined' });
        continue;
      }

      const deductions = [];
      for (const ing of recipeMap[item.id]) {
        const deduct = ing.qtyUsed * item.qty;

        // v5.10.19 — Deduct from per-warehouse balance first (source of
        // truth), then recompute the global inv_items.stock rollup. This
        // means W1's sale never touches W2's balance, and the global field
        // always equals SUM(warehouse_stock) without drift.
        let affected = 0;
        if (warehouseId) {
          // v7.1 — allow negative: an over-sale shows the true (negative)
          // shortage instead of being silently floored at 0.
          // v7.1 — atomic upsert-deduct: never a 0-rows silent loss. If the raw
          // material has no row in this warehouse (empty branch), a NEGATIVE row
          // is created so the deficit is real and visible on the stock screen.
          await deductWarehouseStock(db, warehouseId, ing.invId, deduct);
          affected = 1; // deduction is now always applied (row created if missing)
          await recomputeInvItemStock(db, ing.invId);
        } else {
          // Legacy fallback: no warehouse context — direct global write.
          const [updateResult] = await db.query(
            'UPDATE inv_items SET stock = stock - ? WHERE id = ?',
            [deduct, ing.invId]
          );
          affected = updateResult.affectedRows;
        }

        // Record movement, linked to the numbered invoice (reference_type='sale').
        const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4) + '-' + deductions.length;
        await db.query(
          'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [movId, now, ing.invId, ing.invName, 'out', deduct, 'مبيعات', username, (invoiceNumber || orderId), warehouseId || null, 'sale', (invoiceNumber || orderId)]
        );

        deductions.push({
          invId: ing.invId,
          invName: ing.invName,
          deducted: deduct,
          affected: affected
        });
      }

      recipesApplied.push({
        menuId: item.id,
        menuName: item.name,
        deductions: deductions
      });
    }

    // Production: removed debug log

    // ═══════════════════════════════════════════════════════════════
    // AUTO GL POSTING — Revenue + VAT + COGS
    // v6.0.1 Wave A: GL posting now FATAL — any failure throws, the
    // surrounding transaction rolls back the sale + inventory + ZATCA
    // stamp. No more "sale saved with missing GL" scenarios.
    // v6.0.3 Wave C.1: zero-cost components are detected and surfaced
    // via `cogsWarning` in the response so the cashier sees a toast.
    // Journal lines:
    //   Dr Cash/Card/AR    totalFinal (split by payment)
    //   Cr Sales Revenue   net (totalFinal / (1 + VAT_RATE/100))
    //   Cr Output VAT      totalFinal - net
    //   Dr COGS            totalCogs
    //   Cr Inventory       totalCogs
    // (Discount add-back removed in v6.0.1 — Net method per IFRS 15 §70)
    // All lines carry brand_id + branch_id; COGS/Inventory also carry warehouse_id.
    // ═══════════════════════════════════════════════════════════════
    let cogsWarning = null;
    {
      // v7.5 — this block now runs for EVERY sale. A zero-total (100% comp /
      // staff-meal) sale still relieves physical stock above, so the
      // COGS/Inventory legs must post regardless of invTotal; only the
      // payment/revenue/VAT legs stay gated on invTotal > 0 below.
      {
        // Compute total COGS from deductions × avg_cost
        const invIds = [...new Set(recipesApplied.flatMap(r => r.deductions.map(d => d.invId)))];
        let costMap = {};
        if (invIds.length) {
          const placeholders = invIds.map(() => '?').join(',');
          const [rows] = await db.query(
            `SELECT id, COALESCE(cost, 0) AS avg_cost FROM inv_items WHERE id IN (${placeholders})`,
            invIds);
          rows.forEach(r => { costMap[r.id] = Number(r.avg_cost) || 0; });
        }
        let totalCogs = 0;
        // v6.0.3 Wave C.1 — detect components with cost = 0. A non-empty
        // list means gross margin is artificially inflated; surface a
        // warning so admin can update costs before more sales fly.
        const zeroCostComponents = [];
        recipesApplied.forEach(r => {
          r.deductions.forEach(d => {
            const unitCost = costMap[d.invId] || 0;
            totalCogs += (Number(d.deducted) || 0) * unitCost;
            if (unitCost === 0 && (Number(d.deducted) || 0) > 0) {
              zeroCostComponents.push(d.invName || d.invId);
            }
          });
        });
        // v7.2 (#7) — value imported finished-goods relief at menu.cost and
        // fold it into totalCogs so the COGS/Inventory legs are posted for
        // physically-stocked items (which never appear in recipesApplied).
        if (importedDeductions.length) {
          const impIds = [...new Set(importedDeductions.map(d => d.menuId))];
          const impCost = {};
          try {
            const ph = impIds.map(() => '?').join(',');
            const [crows] = await db.query(
              `SELECT id, COALESCE(computed_cost, 0) AS cc, COALESCE(cost, 0) AS c FROM menu WHERE id IN (${ph})`,
              impIds);
            // Prefer the computed (recipe-rolled) cost; fall back to the
            // manually-entered cost. Either way imported items now relieve
            // inventory in the ledger instead of booking 100% margin.
            crows.forEach(r => { impCost[r.id] = Number(r.cc) > 0 ? Number(r.cc) : (Number(r.c) || 0); });
          } catch (_) { /* menu.computed_cost/cost gaps on older deploys */ }
          importedDeductions.forEach(d => {
            const unitCost = impCost[d.menuId] || 0;
            totalCogs += (Number(d.qty) || 0) * unitCost;
            if (unitCost === 0 && (Number(d.qty) || 0) > 0) {
              zeroCostComponents.push(d.menuName || d.menuId);
            }
          });
        }
        totalCogs = Math.round(totalCogs * 100) / 100;
        if (zeroCostComponents.length) {
          const names = [...new Set(zeroCostComponents)].slice(0, 5);
          console.warn('[sale ' + orderId + '] zero-cost components:', names.join(', '));
          cogsWarning = 'تَنبيه: ' + zeroCostComponents.length + ' مُكوِّن بتَكلفة صفر — هامش الرِّبح قد يَكون مَغلوط. حَدِّث تَكلفة: ' + names.join('، ');
        }

        // Pull brand + branch from the user context (best-effort).
        // v7.2 (#5) — prefer the AUTHENTICATED token claims (brandId/branchId
        // are camelCase in the JWT payload, see routes/auth.js) over body so
        // the GL dimensions can't be spoofed. Body + DB lookup remain as
        // fallbacks for tokens issued before these claims existed.
        let brandId = (req.user && (req.user.brandId || req.user.brand_id)) || req.body.brandId || null;
        let branchId = (req.user && (req.user.branchId || req.user.branch_id)) || req.body.branchId || null;
        if (!brandId || !branchId) {
          try {
            const [u] = await db.query('SELECT brand_id, branch_id FROM users WHERE username = ? LIMIT 1', [username]);
            if (u.length) {
              brandId = brandId || u[0].brand_id;
              branchId = branchId || u[0].branch_id;
            }
          } catch(e) {}
        }

        // V3: Build dynamic payment method → GL code map
        const pmGlMap = await _buildPmGlMap(db);
        // v7.2 (#9) — resolve standard sale account codes from settings so a
        // renumbered chart-of-accounts can't hard-fail the journal.
        const saleGl = await _resolveSaleGlCodes(db);
        // v7.2 (#8) — for split payments, route legs from the STRUCTURED
        // splitDetails object (unambiguous) rather than re-parsing payStr,
        // whose '/' separator collides with method names like "شبكة/مدى".
        // Falls back to the string parser for non-split / legacy payloads.
        const entries = [];
        if (invTotal > 0) {
          let paymentDebits;
          if (paymentMethod === 'Split' && splitDetails && typeof splitDetails === 'object') {
            paymentDebits = _parseSplitFromDetails(splitDetails, pmGlMap);
            if (!paymentDebits.length) {
              // Defensive: structured object had no positive legs — fall back
              // so we never post a sale with zero payment debits.
              paymentDebits = _parseSplitPaymentsV3(payStr, invTotal, pmGlMap);
            }
          } else {
            paymentDebits = _parseSplitPaymentsV3(payStr, invTotal, pmGlMap);
          }

          // v7.5 — Guarantee the payment debits sum EXACTLY to invTotal AFTER
          // per-leg rounding. The previous order (absorb residual, THEN round
          // each leg independently while building entries) could re-introduce
          // a >0.01 imbalance and hard-fail the journal — e.g. 6 even legs on
          // 100 SAR → 6 × 16.67 = 100.02 → GL rejects → the whole sale rolls
          // back. Work in integer cents: round legs first, absorb the residual
          // into the largest leg, then hard-assert the final sum.
          if (paymentDebits.length) {
            paymentDebits.forEach(pd => { pd.amount = Math.round((Number(pd.amount) || 0) * 100) / 100; });
            const _totC = Math.round(invTotal * 100);
            const _sumC = paymentDebits.reduce((s, p) => s + Math.round(p.amount * 100), 0);
            const _diffC = _totC - _sumC;
            if (_diffC !== 0) {
              let _big = 0;
              for (let _i = 1; _i < paymentDebits.length; _i++) {
                if (paymentDebits[_i].amount > paymentDebits[_big].amount) _big = _i;
              }
              paymentDebits[_big].amount = (Math.round(paymentDebits[_big].amount * 100) + _diffC) / 100;
            }
            const _finC = paymentDebits.reduce((s, p) => s + Math.round(p.amount * 100), 0);
            if (_finC !== _totC) {
              const imbErr = new Error(
                'دفع مقسّم غير متوازن: مجموع الأطراف (' + (_finC / 100) +
                ') لا يساوي إجمالي الفاتورة (' + invTotal +
                ') · Split legs do not sum to the invoice total');
              imbErr.status = 400; imbErr.code = 'split_imbalance'; throw imbErr;
            }
          }

          // Debit(s) — by payment method (one per split, GL routed dynamically)
          paymentDebits.forEach(pd => {
            entries.push({
              accountCode: pd.code,
              debit: pd.amount, credit: 0,
              description: 'Sale receipt — ' + orderId + (resolvedChannelName ? ' (' + resolvedChannelName + ')' : ''),
              branchId: branchId || null, brandId: brandId || null
            });
          });
          // Credit Sales Revenue (net) — GROSS revenue (post-discount net) at minimum
          entries.push({
            accountCode: saleGl.revenue,
            debit: 0, credit: net,
            description: 'Sales revenue — ' + orderId + (resolvedChannelName ? ' (' + resolvedChannelName + ')' : ''),
            branchId: branchId || null, brandId: brandId || null
          });
          // Credit Output VAT (if any)
          if (vat > 0) {
            entries.push({
              accountCode: saleGl.outputVat,
              debit: 0, credit: vat,
              description: 'Output VAT — ' + orderId,
              branchId: branchId || null, brandId: brandId || null
            });
          }
        }

        // v6.0.1 Wave A.5 — Discount GL entries REMOVED (Net method per IFRS 15 §70).
        // Revenue is recognised at the consideration the entity is entitled to
        // = net post-discount, which is already in the Cr 4100 line above.
        // The previous "Dr Discount Allowed / Cr Revenue add-back" pattern
        // double-inflated revenue without properly adjusting Output VAT for
        // the discount portion, producing a 3-way inconsistency.
        // Discount visibility is preserved through sales.discount_amount +
        // discount_name + reports filters (no GL entry needed).

        // COGS leg (if any cost)
        if (totalCogs > 0) {
          entries.push({
            accountCode: saleGl.cogs,
            debit: totalCogs, credit: 0,
            description: 'COGS — ' + orderId,
            branchId: branchId || null, brandId: brandId || null,
            warehouseId: warehouseId || null
          });
          entries.push({
            accountCode: saleGl.inventory,
            debit: 0, credit: totalCogs,
            description: 'Inventory reduction (sale) — ' + orderId,
            branchId: branchId || null, brandId: brandId || null,
            warehouseId: warehouseId || null
          });
        }

        // v7.5 — entries may legitimately be empty (comp sale whose components
        // all carry zero cost): skip posting rather than fail on all-zero lines.
        if (entries.length) {
          const post = await gl.postJournal(db, {
            journalDate: now.toISOString().slice(0, 10),
            description: (invTotal > 0 ? 'Sale ' : 'Sale (comp — zero total) ') + orderId + ' (' + (payStr || '—') + ')',
            referenceType: 'Sale',
            referenceId: orderId,
            entries,
            postedBy: username || ''
          });
          // v6.0.1 Wave A.2 — GL posting failure is FATAL. Throws to roll back
          // the entire transaction (sale row + inventory + ZATCA stamp).
          if (!post.success) {
            throw new Error('GL_POSTING_FAILED: ' + (post.error || 'unknown'));
          }
        }

        // v7.1 — Channel commission + service fee as a SEPARATE journal.
        // BEST-EFFORT: postJournal returns a success flag (never throws), and the
        // whole block is wrapped so a missing account / any error only logs — the
        // sale is NEVER lost. The journal is balanced (Dr expense = Cr payable).
        try {
          if (channelId && net > 0) {
            const [chRow] = await db.query(
              'SELECT commission_pct, service_fee_pct FROM sales_channels WHERE id = ? LIMIT 1', [channelId]);
            const _pct = chRow.length
              ? (Number(chRow[0].commission_pct) || 0) + (Number(chRow[0].service_fee_pct) || 0) : 0;
            const _amt = Math.round(net * (_pct / 100) * 100) / 100;
            if (_amt > 0) {
              await gl.ensureCoreAccounts(db); // idempotent — seeds 5500 + 2320 if missing
              const cPost = await gl.postJournal(db, {
                journalDate: now.toISOString().slice(0, 10),
                description: 'عمولة قناة ' + (resolvedChannelName || '') + ' — ' + orderId,
                referenceType: 'ChannelCommission',
                referenceId: orderId,
                entries: [
                  { accountCode: '5500', debit: _amt, credit: 0, description: 'عمولة منصة التوصيل', branchId: branchId || null, brandId: brandId || null },
                  { accountCode: '2320', debit: 0, credit: _amt, description: 'مستحق للمنصة', branchId: branchId || null, brandId: brandId || null }
                ],
                postedBy: username || ''
              });
              if (!cPost.success) console.warn('[sale ' + orderId + '] channel commission GL not posted:', cPost.error);
            }
          }
        } catch (commErr) { console.warn('[sale ' + orderId + '] channel commission GL skipped:', commErr.message); }
      }
    }

    // v6.0.1 Wave A — commit the transaction
    await _conn.commit();

    // v7.1 — NON-BLOCKING cost audit: record (best-effort) when a sale had
    // zero-cost components or items with no recipe, so the owner can review
    // margins later. Never affects the sale (already committed).
    try {
      if (cogsWarning || (itemsWithoutRecipe && itemsWithoutRecipe.length)) {
        await db.query(
          'INSERT INTO audit_log (action, entity_type, entity_id, username, details, ip, created_at) VALUES (?,?,?,?,?,?,NOW())',
          ['sale_cost_warning', 'sale', orderId, username || '',
           JSON.stringify({ cogsWarning: cogsWarning || null, noRecipe: (itemsWithoutRecipe || []).map(x => x.name || x.id) }),
           req.ip || '']);
      }
    } catch (_) { /* audit_log columns may differ — never block the sale */ }

    // v6.1.0 Wave E.6 — enqueue ZATCA submission AFTER commit. The
    // worker silently no-ops when CSID isn't onboarded yet, so this
    // is safe for every deploy.
    try { zatcaWorker.enqueue('sale', orderId); } catch (_) {}

    res.json({
      success: true,
      orderId,
      // v6.11.0 — Human-readable invoice number (INV-YYYYMMDD-NNNN). Null
      // on legacy deploys; UI must fall back to displaying `orderId`.
      invoiceNumber: invoiceNumber,
      // v6.13.0 — Tell the cashier what happened with the customer block.
      // The POS shows a green toast for linked/created and a yellow
      // warning toast for skipped/failed.
      customerId: resolvedCustomerId || null,
      customerSaveOutcome: customerSaveOutcome,    // one of the 6 enum values
      customerSaveError:   customerSaveError,      // human-readable error or null
      recipesApplied: recipesApplied,
      itemsWithoutRecipe: itemsWithoutRecipe,
      semiDeductions: semiDeductions,
      // postingWarning kept for backward-compat; always null now (GL is fatal).
      postingWarning: null,
      // v6.0.3 Wave C.1 — zero-cost component warning (non-blocking)
      cogsWarning: cogsWarning,
      zatca: {
        uuid: zatcaStamp.uuid || null,
        invoiceHash: zatcaStamp.invoiceHash || null,
        previousInvoiceHash: zatcaStamp.previousInvoiceHash || null,
        qrBase64: zatcaStamp.qrBase64 || null
      },
      totals: { total: invTotal, net, vat }
    });
  } catch (e) {
    // v6.0.1 Wave A — roll back the transaction on any error.
    // (If we already rolled back + released for an idempotent short-circuit,
    // _conn was set to null and these are safe no-ops.)
    if (_conn) {
      try { await _conn.rollback(); } catch (_) {}
    }
    // v7.2 (#11) — log the FULL detail server-side only; never leak raw
    // e.message (it can expose SQL / account codes / internal structure).
    console.error('[POST /sales] tx rollback:', e.code || '', e.message, e.stack || '');

    // v7.2 (#10) — correct HTTP status. 200 is RESERVED for real success.
    //   • explicit e.status (our 400 validation / 403 immutability) wins
    //   • period-locked / invoice-immutable → 403
    //   • everything else unexpected → 500
    let status = e.status;
    if (!status) {
      if (e.code === 'period_locked' || e.code === 'invoice_immutable') status = 403;
      else status = 500;
    }

    // v7.2 (#11) — only surface the message for client-safe (4xx) errors we
    // raised on purpose (validation, period lock, immutability). For 5xx we
    // return a generic message + a stable error code so the cashier sees a
    // useful toast while the detail stays in the server log.
    if (status >= 500) {
      res.status(status).json({
        success: false,
        error: 'تعذّر إتمام عملية البيع بسبب خطأ داخلي. حاول مرة أخرى أو تواصل مع الدعم.',
        code: 'sale_failed'
      });
    } else {
      res.status(status).json({ success: false, error: e.message, code: e.code || undefined });
    }
  } finally {
    if (_conn) {
      try { _conn.release(); } catch (_) {}
    }
  }
});

// Get sales list (detailed)
// v5.11.4 — LEFT JOIN customers so the sales-log table can show the
// customer chip and the ERP advanced filter can filter by customerId.
// Schema-tolerant: if customer columns are missing on an older deploy
// the query falls back to the legacy form.
router.get('/', async (req, res) => {
  try {
    let query =
      'SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.gender AS customer_gender ' +
      'FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE 1=1';
    const params = [];
    if (req.query.startDate)     { query += ' AND DATE(s.order_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate)       { query += ' AND DATE(s.order_date) <= ?'; params.push(req.query.endDate); }
    if (req.query.username)      { query += ' AND s.username = ?'; params.push(req.query.username); }
    if (req.query.paymentMethod) { query += ' AND LOWER(s.payment_method) = ?'; params.push(String(req.query.paymentMethod).toLowerCase()); }
    if (req.query.customerId)    { query += ' AND s.customer_id = ?'; params.push(req.query.customerId); }
    query += ' ORDER BY s.order_date DESC LIMIT 500';

    let rows;
    try {
      [rows] = await db.query(query, params);
    } catch (joinErr) {
      // Schema fallback: customer_id column not yet migrated.
      let legacy = 'SELECT * FROM sales WHERE 1=1';
      const lp = [];
      if (req.query.startDate)     { legacy += ' AND DATE(order_date) >= ?'; lp.push(req.query.startDate); }
      if (req.query.endDate)       { legacy += ' AND DATE(order_date) <= ?'; lp.push(req.query.endDate); }
      if (req.query.username)      { legacy += ' AND username = ?'; lp.push(req.query.username); }
      if (req.query.paymentMethod) { legacy += ' AND LOWER(payment_method) = ?'; lp.push(String(req.query.paymentMethod).toLowerCase()); }
      legacy += ' ORDER BY order_date DESC LIMIT 500';
      [rows] = await db.query(legacy, lp);
    }

    res.json(rows.map(r => ({
      orderId: r.id, date: r.order_date, total: Number(r.total_final),
      payment: r.payment_method, username: r.username,
      items: JSON.parse(r.items_json || '[]'),
      discount: Number(r.discount_amount) || 0, shiftId: r.shift_id,
      // v5.11.4 extras (null-safe on legacy schema)
      customerId:     r.customer_id     || null,
      customerName:   r.customer_name   || null,
      customerPhone:  r.customer_phone  || null,
      customerGender: r.customer_gender || null,
      paymentNotes:   r.payment_notes   || null,
      zatcaType:      r.zatca_type      || null,
      // v6.0.4 Wave D — flag set when a credit note exists for this sale
      hasCreditNote:  !!r.has_credit_note,
      // v6.11.0 — Human-readable identifiers (null on legacy rows)
      invoiceNumber:  r.invoice_number  || null,
      voidSerial:     r.void_serial     || null,
      returnSerial:   r.return_serial   || null,
      // Add missing fields required by Advanced Reports filtering & UI
      brandId:        r.brand_id        || null,
      branchId:       r.branch_id       || null,
      channelId:      r.channel_id      || null,
      channelName:    r.channel_name    || null
    })));
  } catch (e) { res.json([]); }
});

// Get invoice
// V5.7.9 — also returns cashier full-name, branch name+address, and company
//          contact info (phone/email) so the printed receipt can render the
//          full bilingual layout the user expects (matches printed sample).
router.get('/invoice/:orderId', async (req, res) => {
  try {
    const [sales] = await db.query('SELECT * FROM sales WHERE id = ?', [req.params.orderId]);
    if (!sales.length) return res.json(null);
    const sale = sales[0];
    const [items] = await db.query('SELECT * FROM sales_items WHERE order_id = ?', [req.params.orderId]);

    // ── Lookup cashier display name from settings.user_meta ──
    // The receipt shows "You were served by : <FullName>, <empNo>".
    // empNo is OPTIONAL — only printed when explicitly set in user_meta;
    // falling back to username here would render "John Smith, j.smith" which
    // looks redundant. So default empNo to '' and let the frontend hide it.
    let cashierName = sale.username || '';
    let cashierEmpNo = '';
    try {
      const [metaRows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
      if (metaRows.length && metaRows[0].setting_value) {
        const meta = JSON.parse(metaRows[0].setting_value) || {};
        const me = meta[sale.username] || {};
        if (me.name)  cashierName  = me.name;
        if (me.empNo) cashierEmpNo = me.empNo;
      }
    } catch (_) { /* fall back to username for the name; empNo stays empty */ }

    // ── Lookup the branch: prefer the shift's branch, else the user's primary branch ──
    let branchName = '', branchAddress = '', branchLat = null, branchLng = null;
    let branchCompanyName = '';  // V5.7.14 — operating company per branch
    try {
      let branchId = null;
      if (sale.shift_id) {
        const [shiftRows] = await db.query('SELECT branch_id FROM shifts WHERE id = ?', [sale.shift_id]);
        if (shiftRows.length && shiftRows[0].branch_id) branchId = shiftRows[0].branch_id;
      }
      if (!branchId && sale.username) {
        const [ub] = await db.query('SELECT branch_id FROM user_branches WHERE username = ? LIMIT 1', [sale.username]);
        if (ub.length) branchId = ub[0].branch_id;
      }
      if (branchId) {
        const [br] = await db.query('SELECT name, location, company_name, geo_lat, geo_lng FROM branches WHERE id = ?', [branchId]);
        if (br.length) {
          branchName = br[0].name || '';
          branchAddress = br[0].location || '';
          branchLat = br[0].geo_lat;
          branchLng = br[0].geo_lng;
          // V5.7.14 — operating-company name shown on receipt below the parent brand
          branchCompanyName = br[0].company_name || '';
        }
      }
    } catch (_) { /* shifts.branch_id or user_branches may not exist on legacy schemas — ignore */ }

    // ── Pull company contact + branding from settings ──
    let companyName = 'Moroccan Taste', taxNumber = '', currency = 'SAR';
    let companyPhone = '', companyEmail = '', companyLogo = '';
    try {
      const [setRows] = await db.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyPhone','CompanyEmail','logo')"
      );
      const map = {};
      setRows.forEach(r => { map[r.setting_key] = r.setting_value; });
      companyName  = map.CompanyName  || companyName;
      taxNumber    = map.TaxNumber    || '';
      currency     = map.Currency     || 'SAR';
      companyPhone = map.CompanyPhone || '';
      companyEmail = map.CompanyEmail || '';
      companyLogo  = map.logo         || '';
    } catch (_) { /* settings table missing — ignore, defaults already set */ }

    // V5.7.26 — per-brand logo: if the sale has a brand_id, prefer THAT
    //   brand's logo over the company-wide one. So Burger Wagef sales
    //   print with the Burger Wagef logo, Hangerstation with theirs, etc.
    let brandLogo = '';
    let brandName = '';
    try {
      let brandId = sale.brand_id;
      if (!brandId && sale.username) {
        // Fallback: derive from the user's primary brand
        const [ub] = await db.query('SELECT brand_id FROM user_brands WHERE username = ? LIMIT 1', [sale.username]);
        if (ub.length) brandId = ub[0].brand_id;
      }
      if (brandId) {
        const [br] = await db.query('SELECT name, logo FROM brands WHERE id = ?', [brandId]);
        if (br.length) {
          brandName = br[0].name || '';
          brandLogo = br[0].logo || '';
        }
      }
    } catch (_) { /* brands table or brand_id column may not exist on legacy schemas */ }

    // ─── v5.11.4 — customer enrichment for receipts ───
    let customerName = '', customerPhone = '', customerGender = '';
    try {
      if (sale.customer_id) {
        const [cr] = await db.query(
          'SELECT name, phone, gender FROM customers WHERE id = ? LIMIT 1',
          [sale.customer_id]
        );
        if (cr.length) {
          customerName = cr[0].name || '';
          customerPhone = cr[0].phone || '';
          customerGender = cr[0].gender || '';
        }
      }
    } catch (_) { /* customer_id column or row missing — skip */ }

    res.json({
      orderId: sale.id, date: sale.order_date, payment: sale.payment_method,
      totalFinal: Number(sale.total_final), username: sale.username,
      discountName: sale.discount_name, discountAmount: Number(sale.discount_amount),
      // v7.3 — discount + split transparency for reprints; the receipt
      // template itemizes these so SUBTOTAL − discounts === TOTAL on paper.
      lineDiscounts: (function () { try { return sale.line_discounts_json ? JSON.parse(sale.line_discounts_json) : null; } catch (e) { return null; } })(),
      splitDetails: (function () { try { return sale.split_details_json ? JSON.parse(sale.split_details_json) : null; } catch (e) { return null; } })(),
      cashTendered: Number(sale.cash_tendered) || 0,
      changeDue: Number(sale.change_due) || 0,
      items: items.map(i => ({ name: i.item_name, qty: i.qty, price: Number(i.price), total: Number(i.total) })),
      // V5.7.9 — receipt enrichment
      cashierName: cashierName,
      cashierEmpNo: cashierEmpNo,
      branchName: branchName,
      branchAddress: branchAddress,
      branchLat: branchLat,
      branchLng: branchLng,
      // V5.7.14 — operating company per branch (printed under parent brand)
      branchCompanyName: branchCompanyName,
      companyName: companyName,
      taxNumber: taxNumber,
      currency: currency,
      companyPhone: companyPhone,
      companyEmail: companyEmail,
      // V5.7.26 — receiptLogo prefers brand logo > company logo
      companyLogo: companyLogo,
      brandName: brandName,
      brandLogo: brandLogo,
      receiptLogo: brandLogo || companyLogo,
      // v5.11.4 — customer block + payment notes for receipt and admin display
      customerId: sale.customer_id || null,
      customerName: customerName,
      customerPhone: customerPhone,
      customerGender: customerGender,
      paymentNotes: sale.payment_notes || null,
      zatcaType: sale.zatca_type || null,
      // v6.11.0 — Human-readable identifiers for printable receipts
      invoiceNumber: sale.invoice_number || null,
      voidSerial: sale.void_serial || null,
      returnSerial: sale.return_serial || null
    });
  } catch (e) { res.json(null); }
});

// v5.10.29 — Reverse a sale's stock + GL effects, then optionally hard-delete.
// This is the proper way to undo a sale: it restores warehouse_stock,
// writes reversing inventory_movements, and reverses the GL journal so
// books stay balanced. Wrapped in a transaction so a partial reversal can
// never leave phantom stock or unbalanced GL.
//
// Returns:
//   { success, restored: [...], reversedGl: bool, deletedSale: bool }
async function _reverseSaleEffects(conn, orderId, username, opts) {
  opts = opts || {};
  const c = conn || db;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const restored = [];

  // 1. Find every "out" movement that came from this sale (sale-creation
  //    code stamps notes with orderId or "orderId / itemName").
  const [movs] = await c.query(
    `SELECT id, item_id, item_name, qty, warehouse_id, reason
       FROM inventory_movements
      WHERE type = 'out'
        AND (notes = ? OR notes LIKE CONCAT(?, ' /%') OR notes LIKE CONCAT(?, ' / %'))
        AND reason IN ('مبيعات', 'مبيعات (نصف مصنع)')`,
    [orderId, orderId, orderId]
  );

  for (const m of movs) {
    // 2a. Restore warehouse_stock if a warehouse was tracked
    if (m.warehouse_id) {
      try {
        await c.query(
          'UPDATE warehouse_stock SET qty = qty + ?, last_updated = ? WHERE warehouse_id = ? AND item_id = ?',
          [Number(m.qty) || 0, now, m.warehouse_id, m.item_id]);
      } catch (_) { /* row may have been deleted; non-fatal */ }
    } else {
      // Legacy path: deduction happened against inv_items.stock directly
      try {
        await c.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?',
          [Number(m.qty) || 0, m.item_id]);
      } catch (_) {}
    }

    // 2b. Write a reversing movement so the warehouse ledger is honest
    const reverseId = 'MOV-VOID-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
    try {
      await c.query(
        `INSERT INTO inventory_movements
          (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [reverseId, now, m.item_id, m.item_name, 'in', Number(m.qty) || 0,
         'عكس بيع', username || 'system',
         'void of ' + orderId + ' (mov ' + m.id + ')',
         m.warehouse_id || null]);
    } catch (_) {}

    restored.push({
      itemId: m.item_id, itemName: m.item_name,
      qty: Number(m.qty) || 0, warehouseId: m.warehouse_id || null
    });
  }

  // 3. Recompute global stock for each affected item once
  const itemIds = Array.from(new Set(movs.map(m => m.item_id))).filter(Boolean);
  for (const id of itemIds) {
    try { await recomputeInvItemStock(c, id); } catch (_) {}
  }

  // 4. Reverse the GL journal for this sale
  let reversedGl = false;
  try {
    const [journals] = await c.query(
      'SELECT id FROM gl_journals WHERE reference_type = ? AND reference_id = ?',
      ['Sale', orderId]);
    for (const j of journals) {
      const [entries] = await c.query('SELECT * FROM gl_entries WHERE journal_id = ?', [j.id]);
      for (const e of entries) {
        if (e.account_id) {
          const reverseAmount = (Number(e.credit) || 0) - (Number(e.debit) || 0);
          await c.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?',
            [reverseAmount, e.account_id]);
        }
      }
      await c.query('DELETE FROM gl_entries WHERE journal_id = ?', [j.id]);
      await c.query('DELETE FROM gl_journals WHERE id = ?', [j.id]);
      reversedGl = true;
    }
  } catch (glErr) {
    // v7.5 — ONLY a missing-GL-tables deploy is non-fatal. Anything else
    // (lock timeout, constraint failure) must abort the void: otherwise it
    // commits with stock restored but the GL journal left standing.
    if (!glErr || glErr.code !== 'ER_NO_SUCH_TABLE') throw glErr;
  }

  // 5. Optionally hard-delete the sale row + lines
  let deletedSale = false;
  if (opts.deleteSale) {
    try { await c.query('DELETE FROM sales_items WHERE order_id = ?', [orderId]); } catch (_) {}
    await c.query('DELETE FROM sales WHERE id = ?', [orderId]);
    deletedSale = true;
  }

  return { restored, reversedGl, deletedSale };
}

// ─── v7.3 — Manager-approval gate for sensitive actions (void / return) ───
// Privileged roles (admin/manager) act directly; ANY other role MUST supply a
// valid admin/manager approver's credentials, verified server-side here so the
// gate can never be bypassed from the client. Resolves silently when allowed,
// or throws a 403 (the route's try/catch returns it as a clear client error).
// v7.5 — DUMMY hash computed once at module load: bcrypt.compare always runs
// (against this pad when the approver doesn't exist) so response timing can't
// be used to enumerate manager usernames.
const _APPROVAL_DUMMY_HASH = bcrypt.hashSync('approval-dummy-timing-pad', 12);
async function _requireManagerApproval(req) {
  const PRIVILEGED = ['admin', 'manager'];
  const actorRole = String((req.user && req.user.role) || '').toLowerCase();
  if (PRIVILEGED.indexOf(actorRole) !== -1) return null; // already authorized
  const approverUsername = req.body && req.body.approverUsername;
  const approverPassword = req.body && req.body.approverPassword;
  if (!approverUsername || !approverPassword) {
    const err = new Error('هذا الإجراء يتطلب اعتماد مدير · Manager approval required');
    err.status = 403; err.code = 'approval_required'; throw err;
  }
  let rows;
  try {
    [rows] = await db.query('SELECT username, password, role FROM users WHERE username = ? LIMIT 1', [String(approverUsername).trim()]);
  } catch (e) {
    const err = new Error('تعذّر التحقق من بيانات المدير · Could not verify approver');
    err.status = 500; err.code = 'approval_check_failed'; throw err;
  }
  const mgr = rows && rows[0];
  const mgrRole = mgr ? String(mgr.role || '').toLowerCase() : '';
  // v7.5 — constant-time: ALWAYS run bcrypt.compare (against the dummy pad
  // when the user is missing), judge role + password AFTER, and return one
  // generic error so neither timing nor wording leaks which check failed.
  let okPw = false;
  try {
    okPw = await bcrypt.compare(String(approverPassword), (mgr && mgr.password) || _APPROVAL_DUMMY_HASH);
  } catch (e) { okPw = false; }
  if (!mgr || PRIVILEGED.indexOf(mgrRole) === -1 || !okPw) {
    const err = new Error('بيانات اعتماد المدير غير صحيحة · Invalid manager approval credentials');
    err.status = 403; err.code = 'approval_invalid'; throw err;
  }
  return mgr.username; // approved — return the approver for audit if needed
}

// POST /sales/:orderId/void — reverse stock + GL but KEEP the sale row.
// This is the recommended path when you need an audit trail (the sale
// remains visible in reports as voided). Use ?delete=1 to also drop the row.
router.post('/:orderId/void', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const username = (req.user && req.user.username) || (req.body && req.body.username) || 'system';
    const wantDelete = req.query.delete === '1';
    // v7.3 — gate: cashiers (and any non-privileged role) need manager approval.
    await _requireManagerApproval(req);

    // v6.0.1 Wave A.4 — race-safe void: the lock + reversal happen inside
    // ONE transaction with SELECT … FOR UPDATE on the sale row.
    // v6.0.2 Wave B.2 — also reject if the sale has been submitted to
    // ZATCA (BR-KSA-08 invoice immutability) — only a Credit Note can
    // offset a submitted invoice.
    const runner = async (conn) => {
      const [sale] = await conn.query(
        'SELECT id, zatca_type, zatca_submitted_at FROM sales WHERE id = ? FOR UPDATE',
        [orderId]
      );
      if (!sale.length) {
        const err = new Error('sale-not-found'); err.status = 404; throw err;
      }
      if (sale[0].zatca_submitted_at) {
        const err = new Error('Cannot void a ZATCA-submitted invoice — issue a Credit Note instead');
        err.code = 'invoice_immutable'; err.status = 403; throw err;
      }
      const existingType = String(sale[0].zatca_type || '').toLowerCase();
      if (existingType === 'cancellation' || existingType === 'credit_note') {
        const err = new Error('already-reversed');
        err.status = 400; err.zatcaType = existingType; throw err;
      }
      const r = await _reverseSaleEffects(conn, orderId, username, { deleteSale: wantDelete });
      // v6.14.0 — Stamp zatca_type='cancellation' as a HARD requirement (was
      // silently swallowed before). Migration 0003 widens the enum to accept
      // the value. If the UPDATE doesn't take effect we throw, which rolls
      // back the entire transaction (inventory + GL get restored) and the
      // client receives a clear error instead of a fake success.
      let voidSerial = null;
      if (!wantDelete) {
        try { voidSerial = await salesNumbering.nextVoidSerial(conn); } catch (_) {}

        const [updRes] = await conn.query(
          "UPDATE sales SET zatca_type='cancellation' WHERE id = ?",
          [orderId]
        );
        if (!updRes || updRes.affectedRows === 0) {
          // The row exists (we SELECTed it above), so this only fires if
          // the enum still rejects 'cancellation' — caller needs to apply
          // migration 0003. Surface, don't hide.
          const err = new Error('void-update-failed: zatca_type could not be set to cancellation');
          err.code = 'enum_missing_cancellation';
          err.hint = 'Run db/migrate.js to apply migration 0003_zatca_type_cancellation.sql';
          throw err;
        }

        if (voidSerial) {
          try { await conn.query('UPDATE sales SET void_serial = ? WHERE id = ?', [voidSerial, orderId]); }
          catch (_) { voidSerial = null; /* column missing — non-fatal, UI falls back to orderId */ }
        }
      }
      return Object.assign({}, r, { voidSerial });
    };

    let result;
    try {
      result = await db.withTransaction(runner);
    } catch (txErr) {
      console.warn('[POST /sales/:id/void] rolled back:', txErr.message);
      const status = txErr.status || 500;
      return res.status(status).json({
        success: false, error: txErr.message,
        zatcaType: txErr.zatcaType || undefined
      });
    }

    res.json({
      success: true, orderId,
      ...result,
      zatcaType: wantDelete ? null : 'cancellation'
    });
  } catch (e) {
    // v7.3 — honor e.status (e.g. 403 from the manager-approval gate) instead
    // of always 500, and surface the error code so the POS can react.
    res.status(e.status || 500).json({ success: false, error: e.message, code: e.code || undefined });
  }
});

// ─── v5.11.4 — POST /:orderId/return ─────────────────────────────────────
// Customer-return semantics (vs Void which is "the order was wrong").
// Reuses _reverseSaleEffects (which restores warehouse_stock + posts the
// reversing GL journal inside a transaction) and then:
//   • stamps the sale as a ZATCA credit note (zatca_type='credit_note')
//   • appends "RETURN: <reason>" to payment_notes so the audit trail
//     captures *why* the customer returned the order.
// Refuses if the sale is already a cancellation or credit_note.
// v6.0.4 Wave D — POST /sales/:orderId/return now generates a REAL ZATCA
// Credit Note: a new row in `credit_notes` with its own UUID + hash chain
// link, referencing the original sale's UUID/hash. The original sale row
// is NOT mutated (BR-KSA-08 immutability) — only `has_credit_note` flips
// to 1 for UI hinting. Inventory + GL are reversed via the existing
// _reverseSaleEffects helper. Cancellation tag on the original is removed.
router.post('/:orderId/return', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const username = (req.user && req.user.username) || (req.body && req.body.username) || 'system';
    const reason   = (req.body && String(req.body.reason || '').trim()) || 'customer return';
    const reasonCode = (req.body && String(req.body.reasonCode || '').trim()) || 'goods_returned';
    // v7.3 — gate: cashiers (and any non-privileged role) need manager approval.
    await _requireManagerApproval(req);

    const runner = async (conn) => {
      // 1. Lock the original sale row + load everything we need to clone
      const [orig] = await conn.query(
        'SELECT * FROM sales WHERE id = ? FOR UPDATE', [orderId]
      );
      if (!orig.length) {
        const err = new Error('sale-not-found'); err.status = 404; throw err;
      }
      const sale = orig[0];
      // Already fully reversed?
      const exType = String(sale.zatca_type || '').toLowerCase();
      if (exType === 'cancellation') {
        const err = new Error('already-cancelled');
        err.status = 400; err.zatcaType = exType; throw err;
      }
      if (sale.has_credit_note) {
        const err = new Error('already-credited');
        err.status = 400; err.zatcaType = 'credit_note'; throw err;
      }

      // 2. Seller (for ZATCA QR)
      let sellerName = SELLER_NAME_FALLBACK, sellerVat = SELLER_VAT_FALLBACK;
      try {
        const [cRow] = await conn.query("SELECT name, tax_number FROM companies WHERE id='CO-MAIN' LIMIT 1");
        if (cRow.length) {
          if (cRow[0].name) sellerName = cRow[0].name;
          if (cRow[0].tax_number) sellerVat = cRow[0].tax_number;
        }
      } catch(e) {}

      // 3. Compute the credit note's own ZATCA stamp (own UUID, own hash
      //    chained off the most recent invoice hash in the system).
      // v6.20.0 — VAT rate resolved at request time from settings, not ENV.
      const _vatRateForReturn = await pricing.getVatRateFromDb(conn, VAT_RATE_FALLBACK);
      const itemsArr = sale.items_json ? JSON.parse(sale.items_json) : [];
      const totalFinalNum = Number(sale.total_final) || 0;
      const cnNet = Math.round((totalFinalNum / (1 + _vatRateForReturn / 100)) * 100) / 100;
      const cnVat = Math.round((totalFinalNum - cnNet) * 100) / 100;
      const cnStamp = await zatca.stampSale(conn, {
        orderId: 'CN-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        createdAt: new Date(),
        total: totalFinalNum,
        vatAmount: cnVat,
        lines: itemsArr.map(it => ({
          name: it.name, qty: it.qty,
          unitPrice: it.price, lineTotal: it.qty * it.price
        }))
      }, { name: sellerName, vatNumber: sellerVat });
      const cnId = 'CN-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const ksaNow = zatca.nowInRiyadh(new Date());

      // 4. Insert the credit_note row
      await conn.query(
        `INSERT INTO credit_notes (
          id, original_sale_id, original_invoice_uuid, original_invoice_hash,
          invoice_uuid, invoice_hash, previous_invoice_hash,
          zatca_type, issue_date, issue_time,
          total_final, net_amount, vat_amount, tax_subtotals_json,
          reason, reason_code, items_json,
          customer_id, brand_id, branch_id, username, shift_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          cnId, sale.id, sale.invoice_uuid || null, sale.invoice_hash || null,
          cnStamp.uuid, cnStamp.invoiceHash, cnStamp.previousInvoiceHash || null,
          'credit_note', ksaNow.date, ksaNow.time,
          totalFinalNum, cnNet, cnVat, sale.tax_subtotals_json || null,
          reason, reasonCode, sale.items_json || null,
          sale.customer_id || null, sale.brand_id || null,
          sale.branch_id || null, username, sale.shift_id || null
        ]
      );

      // 5. Reverse inventory + GL (existing helper). _reverseSaleEffects
      //    runs inside the same transaction (conn) we're in.
      const reversal = await _reverseSaleEffects(conn, sale.id, username, { deleteSale: false });

      // 6. Flag the original (do NOT change its zatca_type — immutable!)
      try {
        await conn.query("UPDATE sales SET has_credit_note = 1 WHERE id = ?", [sale.id]);
      } catch (_) { /* column missing on very old deploy — ignore */ }

      // v6.11.0 — Stamp a sequential return_serial (RET-YYYYMMDD-NNNN) on the
      // original sale so the customer-facing return receipt + admin sales list
      // can quote a short reference instead of the long credit-note UUID.
      let returnSerial = null;
      try { returnSerial = await salesNumbering.nextReturnSerial(conn); } catch (_) {}
      if (returnSerial) {
        try { await conn.query('UPDATE sales SET return_serial = ? WHERE id = ?', [returnSerial, sale.id]); }
        catch (_) { returnSerial = null; /* column missing */ }
      }

      // 7. Audit trail in payment_notes (non-critical)
      try {
        await conn.query(
          "UPDATE sales SET payment_notes = CONCAT(COALESCE(payment_notes,''), " +
          "CASE WHEN payment_notes IS NULL OR payment_notes = '' THEN '' ELSE '\n' END, ?) " +
          "WHERE id = ?",
          ['CREDIT_NOTE ' + cnId + ': ' + reason, sale.id]
        );
      } catch(_) {}

      return {
        creditNoteId: cnId,
        creditNoteUuid: cnStamp.uuid,
        creditNoteHash: cnStamp.invoiceHash,
        previousInvoiceHash: cnStamp.previousInvoiceHash || null,
        qrBase64: cnStamp.qrBase64 || null,
        originalSaleId: sale.id,
        totalFinal: totalFinalNum,
        net: cnNet,
        vat: cnVat,
        returnSerial: returnSerial,
        ...reversal
      };
    };

    let result;
    try {
      result = await db.withTransaction(runner);
    } catch (txErr) {
      console.warn('[POST /sales/:id/return] rolled back:', txErr.message);
      const status = txErr.status || 500;
      return res.status(status).json({
        success: false, error: txErr.message,
        zatcaType: txErr.zatcaType || undefined
      });
    }

    // v6.1.0 Wave E.6 — enqueue the new credit_note for ZATCA submission
    try { if (result && result.creditNoteId) zatcaWorker.enqueue('credit_note', result.creditNoteId); } catch (_) {}

    res.json({ success: true, orderId, reason, ...result });
  } catch (e) {
    // v7.3 — honor e.status (e.g. 403 from the manager-approval gate).
    res.status(e.status || 500).json({ success: false, error: e.message, code: e.code || undefined });
  }
});

// Delete sale (developer only — frontend checks isDeveloper)
// v5.10.29 — DELETE is no longer a silent destructor. It now:
//   * reverses warehouse_stock + GL journal automatically (so books balance)
//   * deletes the sale row (sales_items cascades via FK)
//   * accepts ?force=1 to skip reversal (legacy emergency mode — leaves
//     phantom stock; do NOT use in normal operation)
router.delete('/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const username = (req.user && req.user.username) || 'system';
    // v6.0.2 Wave B.7 — Submitted invoices are immutable (ZATCA BR-KSA-08).
    // The only way to undo a submitted sale is a Credit Note (Wave D).
    try {
      await _ensureNotSubmitted(null, orderId);
    } catch (err) {
      if (err.code === 'invoice_immutable') {
        return res.status(err.status || 403).json({ success: false, error: err.message, code: err.code });
      }
      throw err;
    }
    if (req.query.force === '1') {
      await db.query('DELETE FROM sales WHERE id = ?', [orderId]);
      return res.json({ success: true, force: true, warning: 'inventory + GL NOT reversed' });
    }
    const [sale] = await db.query('SELECT id FROM sales WHERE id = ?', [orderId]);
    if (!sale.length) return res.status(404).json({ success: false, error: 'sale-not-found' });

    const runner = async (conn) => _reverseSaleEffects(conn, orderId, username, { deleteSale: true });
    let result;
    try {
      result = (typeof db.withTransaction === 'function')
        ? await db.withTransaction(runner)
        : await runner(null);
    } catch (txErr) {
      return res.status(500).json({ success: false, error: txErr.message });
    }
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Bulk delete sales — same reversal semantics applied to each id.
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids, force } = req.body || {};
    if (!ids || !ids.length) return res.status(400).json({ success: false, error: 'No IDs' });
    const username = (req.user && req.user.username) || 'system';

    if (force) {
      const placeholders = ids.map(() => '?').join(',');
      await db.query('DELETE FROM sales WHERE id IN (' + placeholders + ')', ids);
      return res.json({ success: true, deleted: ids.length, force: true, warning: 'inventory + GL NOT reversed' });
    }

    const reversed = [];
    for (const id of ids) {
      try {
        const runner = async (conn) => _reverseSaleEffects(conn, id, username, { deleteSale: true });
        const r = (typeof db.withTransaction === 'function')
          ? await db.withTransaction(runner)
          : await runner(null);
        reversed.push({ id, ...r });
      } catch (e) {
        reversed.push({ id, error: e.message });
      }
    }
    res.json({ success: true, deleted: reversed.length, results: reversed });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// ADVANCED FULL REPORT (التقارير المتطورة)
// ═══════════════════════════════════════

router.get('/report/advanced', async (req, res) => {
  try {
    const { startDate, endDate, username, paymentMethod } = req.query;

    // Build WHERE clause for sales
    // v6.11.0 — Exclude voided + credit-note rows from headline totals so the
    // "إجمالي المبيعات" figure reflects actual realised revenue. They're still
    // queryable via the dedicated /sales endpoint for audit/listing purposes.
    let salesWhere = "1=1 AND (zatca_type IS NULL OR zatca_type NOT IN ('cancellation','credit_note'))";
    const salesParams = [];
    if (startDate) { salesWhere += ' AND DATE(order_date) >= ?'; salesParams.push(startDate); }
    if (endDate)   { salesWhere += ' AND DATE(order_date) <= ?'; salesParams.push(endDate); }
    if (username)  { salesWhere += ' AND username = ?'; salesParams.push(username); }
    if (paymentMethod) { salesWhere += ' AND LOWER(payment_method) LIKE ?'; salesParams.push('%' + paymentMethod.toLowerCase() + '%'); }

    // 1) Fetch all sales in range (we need rows for payment parsing + product detail)
    const [allSales] = await db.query(
      `SELECT id, order_date, items_json, total_final, payment_method, username,
              discount_name, discount_amount, kita_service_fee
       FROM sales WHERE ${salesWhere} ORDER BY order_date`, salesParams
    );

    // ── Aggregate stats ──
    let totalSales = 0, totalDiscount = 0, totalKitaFees = 0;
    const orderCount = allSales.length;
    allSales.forEach(s => {
      totalSales += Number(s.total_final) || 0;
      totalDiscount += Number(s.discount_amount) || 0;
      totalKitaFees += Number(s.kita_service_fee) || 0;
    });

    // ── Payment method breakdown (supports split: "cash:100/card:50") ──
    const pay = { cash: { total: 0, count: 0 }, card: { total: 0, count: 0 }, kita: { total: 0, count: 0 } };

    function addPayment(method, amount) {
      const m = method.toLowerCase().trim();
      if (m.includes('kita'))      { pay.kita.total += amount; pay.kita.count++; }
      else if (m.includes('card') || m.includes('mada') || m.includes('شبكة') || m.includes('مدى'))
                                   { pay.card.total += amount; pay.card.count++; }
      else                         { pay.cash.total += amount; pay.cash.count++; }
    }

    allSales.forEach(s => {
      const pm = (s.payment_method || 'cash').trim();
      const total = Number(s.total_final) || 0;
      // Check for split payment format: "cash:100/card:50"
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, amt] = part.split(':');
          if (method && amt) addPayment(method, Number(amt) || 0);
        });
      } else {
        addPayment(pm, total);
      }
    });

    // ── Charts data ──

    // Sales by day
    const dayMap = {};
    allSales.forEach(s => {
      const d = new Date(s.order_date);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      dayMap[key] = (dayMap[key] || 0) + (Number(s.total_final) || 0);
    });
    const salesByDay = Object.entries(dayMap).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, value]) => ({ label, value }));

    // Sales by hour
    const hourMap = {};
    for (let i = 0; i < 24; i++) hourMap[i] = 0;
    allSales.forEach(s => {
      const h = new Date(s.order_date).getHours();
      hourMap[h] += Number(s.total_final) || 0;
    });
    const salesByHour = Object.entries(hourMap).map(([h, value]) => ({ label: h + ':00', value }));

    // Sales by cashier
    const cashierMap = {};
    allSales.forEach(s => {
      const u = s.username || 'unknown';
      if (!cashierMap[u]) cashierMap[u] = { total: 0, count: 0, cash: 0, card: 0, kita: 0 };
      cashierMap[u].total += Number(s.total_final) || 0;
      cashierMap[u].count++;
      // Payment breakdown per cashier
      const pm = (s.payment_method || 'cash').trim();
      const amt = Number(s.total_final) || 0;
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, a] = part.split(':');
          const val = Number(a) || 0;
          const ml = (method || '').toLowerCase();
          if (ml.includes('kita')) cashierMap[u].kita += val;
          else if (ml.includes('card') || ml.includes('mada')) cashierMap[u].card += val;
          else cashierMap[u].cash += val;
        });
      } else {
        const ml = pm.toLowerCase();
        if (ml.includes('kita')) cashierMap[u].kita += amt;
        else if (ml.includes('card') || ml.includes('mada') || ml.includes('شبكة') || ml.includes('مدى')) cashierMap[u].card += amt;
        else cashierMap[u].cash += amt;
      }
    });
    const salesByCashier = Object.entries(cashierMap)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([label, v]) => ({ label, value: v.total }));

    // Top products (from items_json)
    const prodMap = {}; // name → {qty, revenue, orders}
    allSales.forEach(s => {
      try {
        const items = JSON.parse(s.items_json || '[]');
        // v7.1 fix — pro-rate each product's share of the CHARGED total
        // (total_final) by line value, so revenue reflects the actual amount
        // (4) not the pre-rounding line-price sum (4.35).
        const lineSum = items.reduce((t,it)=> t + (Number(it.qty)||0)*(Number(it.price)||0), 0);
        const saleTotal = Number(s.total_final) || 0;
        const orderProducts = new Set();
        items.forEach(item => {
          const name = item.name || 'Unknown';
          if (!prodMap[name]) prodMap[name] = { qty: 0, revenue: 0, orders: 0 };
          prodMap[name].qty += Number(item.qty) || 0;
          const lineVal = (Number(item.qty)||0)*(Number(item.price)||0);
          prodMap[name].revenue += lineSum > 0 ? (saleTotal * lineVal / lineSum) : 0;
          orderProducts.add(name);
        });
        orderProducts.forEach(n => { prodMap[n].orders++; });
      } catch (e) { /* ignore parse errors */ }
    });
    const topProducts = Object.entries(prodMap)
      .sort((a, b) => b[1].qty - a[1].qty)
      .slice(0, 5)
      .map(([label, v]) => ({ label, value: v.qty }));

    // ── Tables data ──

    // Daily detail
    const dailyMap = {};
    allSales.forEach(s => {
      const d = new Date(s.order_date);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (!dailyMap[key]) dailyMap[key] = { date: key, cash: 0, card: 0, kita: 0, total: 0, orders: 0, discount: 0 };
      dailyMap[key].total += Number(s.total_final) || 0;
      dailyMap[key].orders++;
      dailyMap[key].discount += Number(s.discount_amount) || 0;
      // Payment breakdown per day
      const pm = (s.payment_method || 'cash').trim();
      const amt = Number(s.total_final) || 0;
      if (pm.includes('/') && pm.includes(':')) {
        pm.split('/').forEach(part => {
          const [method, a] = part.split(':');
          const val = Number(a) || 0;
          const ml = (method || '').toLowerCase();
          if (ml.includes('kita')) dailyMap[key].kita += val;
          else if (ml.includes('card') || ml.includes('mada')) dailyMap[key].card += val;
          else dailyMap[key].cash += val;
        });
      } else {
        const ml = pm.toLowerCase();
        if (ml.includes('kita')) dailyMap[key].kita += amt;
        else if (ml.includes('card') || ml.includes('mada') || ml.includes('شبكة') || ml.includes('مدى')) dailyMap[key].card += amt;
        else dailyMap[key].cash += amt;
      }
    });
    const dailyDetail = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // Cashier detail
    const cashierDetail = Object.entries(cashierMap)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, v]) => ({ name, cash: v.cash, card: v.card, kita: v.kita, total: v.total, orders: v.count }));

    // Product detail (all products, sorted by qty)
    const productDetail = Object.entries(prodMap)
      .sort((a, b) => b[1].qty - a[1].qty)
      .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue, orders: v.orders }));

    // ── Expenses by category (date filters only) ──
    let expWhere = '1=1';
    const expParams = [];
    if (startDate) { expWhere += ' AND DATE(expense_date) >= ?'; expParams.push(startDate); }
    if (endDate)   { expWhere += ' AND DATE(expense_date) <= ?'; expParams.push(endDate); }

    const [expRows] = await db.query(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS cnt FROM expenses
       WHERE ${expWhere} GROUP BY category ORDER BY total DESC`, expParams
    );
    const expensesByCategory = expRows.map(r => ({ category: r.category || 'أخرى', total: Number(r.total), count: r.cnt }));
    const totalExp = expensesByCategory.reduce((sum, e) => sum + e.total, 0);

    // ── Purchases by supplier (date filters only, received only) ──
    let purWhere = "status = 'received'";
    const purParams = [];
    if (startDate) { purWhere += ' AND DATE(purchase_date) >= ?'; purParams.push(startDate); }
    if (endDate)   { purWhere += ' AND DATE(purchase_date) <= ?'; purParams.push(endDate); }

    const [purRows] = await db.query(
      `SELECT supplier_name, SUM(total_price) AS total, COUNT(*) AS cnt FROM purchases
       WHERE ${purWhere} GROUP BY supplier_name ORDER BY total DESC`, purParams
    );
    const purchasesBySupplier = purRows.map(r => ({ supplier: r.supplier_name || 'غير محدد', total: Number(r.total), count: r.cnt }));
    const totalPur = purchasesBySupplier.reduce((sum, p) => sum + p.total, 0);

    // ── Computed stats ──
    const activeDays = salesByDay.length || 1;
    const avgOrderValue = orderCount > 0 ? totalSales / orderCount : 0;
    const avgDailyRevenue = totalSales / activeDays;
    const netProfit = totalSales - totalExp - totalPur;
    const profitMargin = totalSales > 0 ? ((netProfit / totalSales) * 100).toFixed(1) : '0.0';

    // ── Sales list for Excel export ──
    const salesList = allSales.map(s => ({
      orderId: s.id,
      date: s.order_date,
      username: s.username,
      paymentMethod: s.payment_method,
      discountName: s.discount_name || '',
      discountAmount: Number(s.discount_amount) || 0,
      total: Number(s.total_final) || 0
    }));

    res.json({
      success: true,
      stats: {
        totalSales, totalExp, totalPur, totalDiscount, totalKitaFees,
        orderCount, activeDays, avgOrderValue, avgDailyRevenue,
        netProfit, profitMargin
      },
      payments: pay,
      charts: { salesByDay, salesByHour, salesByCashier, topProducts },
      tables: { dailyDetail, cashierDetail, productDetail, expensesByCategory, purchasesBySupplier },
      salesList
    });

  } catch (e) {
    // Production: removed debug log
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
