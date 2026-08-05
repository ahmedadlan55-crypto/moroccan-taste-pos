const router = require('express').Router();
const salesPostingCapture = require('../lib/salesPosting/capture');
const { CORE_ACCOUNTS } = require('../lib/glPosting');
const db = require('../db/connection');
const bcrypt = require('bcryptjs');
const { isTruthy } = require('../lib/settingsKeys');
const invoiceIdentity = require('../lib/invoiceIdentity');
// G-SALES hardening — fine-grained capability guard (same pattern as
// routes/order-to-cash/returns.js). Runs after the global JWT gate, so
// req.user is the verified token. admin/developer bypass inside.
const requireCapability = require('../middleware/requireCapability');
// W0-A — the same effective-permission resolver the guard uses, called
// DIRECTLY so the void/return routes can ask "does this account hold
// pos.refund?" about the CALLER *and* about an approving manager, instead of
// letting the middleware 403 before the approval credentials are ever read.
const { hasCapability } = require('../middleware/requireCapability');
// The ONE authority for "what is this person called" — users.full_name →
// settings.user_meta[u].name → username. The receipt's cashier line and the
// JWT claim the till prints from (routes/auth.js) both go through it, so an
// original and its reprint can never name the same cashier differently.
const displayName = require('../lib/displayName');
const zatca = require('../lib/zatca');
// Renders the ZATCA TLV payload into a PNG data-URL SERVER-side. The clients
// must not encode QRs themselves: the legacy receipt template lazy-loaded a QR
// library from a CDN — an online dependency inside the receipt of an
// offline-first POS — and the React POS simply printed no QR at all.
const qrImage = require('qrcode');
async function zatcaQrDataUrl(tlvBase64) {
  if (!tlvBase64) return null;
  try {
    // The TLV is BINARY; feed it as bytes or the QR encodes mojibake text.
    return await qrImage.toDataURL([{ data: Buffer.from(tlvBase64, 'base64'), mode: 'byte' }], { margin: 0, width: 160 });
  } catch (e) {
    console.error('[zatca] QR image render failed:', e.message);
    return null;
  }
}
const { recomputeInvItemStock, recomputeMenuStock, deductWarehouseStock } = require('../lib/stockRecompute');
// v6.20.0 — Central tax math.  Honors per-item is_tax_inclusive + reads
// the live VAT rate from settings (not ENV anymore).
const pricing = require('../lib/pricing');
// v7.4 — integer-halala allocation for the eager POS→O2C line projection.
// Pure; fits per-line snapshots to the header figures this route records.
const alloc = require('../lib/order-to-cash/lineAllocation');
const InvoiceService = require('../services/order-to-cash/InvoiceService');
const o2cConfig = require('../lib/order-to-cash/config');
// v6.11.0 — Human-readable invoice / void / return numbering. Helpers
// tolerate missing schema columns and return null silently so this
// require stays safe on deploys that haven't run migration 0002 yet.
const salesNumbering = require('../lib/salesNumbering');
// v6.1.0 Wave E.6 — queue trigger for ZATCA submissions
let zatcaWorker;
try { zatcaWorker = require('../lib/zatca-worker'); } catch (_) { zatcaWorker = { enqueue: () => {} }; }
// Unified Sales Analytics — post-commit fact projection. Same tolerance
// pattern as the zatca worker above: absence of the module never blocks a sale.
let analyticsProjection;
try { analyticsProjection = require('../services/analytics/ProjectionService'); }
catch (_) { analyticsProjection = { safeProject: async () => {}, projectPosSale: async () => {}, projectReturn: async () => {} }; }
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
// cash → canonical cash control, card/mada/stc/online → bank control,
// kita/credit → trade receivables. The actual codes come from CORE_ACCOUNTS.
function _payToAccountCode(method) {
  const m = (method || '').toLowerCase();
  if (m === 'cash' || m.startsWith('cash')) return CORE_ACCOUNTS.CASH.code;
  if (m === 'kita' || m === 'credit' || m === 'ar' || m.indexOf('ذمم') >= 0) return CORE_ACCOUNTS.AR.code;
  // default card/bank
  return CORE_ACCOUNTS.BANK.code;
}

// V5.7.18 — same Arabic normalization the shift-close matcher uses.
//   So "مدى" / "مدي" / "Mada" / "MADA" all match the same payment-method
//   regardless of which variant the cashier typed at sale time.
function _normPmName(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// close2/sales-security — supervisor gate + ownership helpers.
// These enforce, at the money-writing /api/sales endpoints themselves, the same
// rules pos-v2.js and middleware/o2cLegacyGate enforce elsewhere — but WITHOUT
// depending on the ORDER_TO_CASH_ENABLE flag, so a direct POST can never bypass
// them. They reuse this file's OWN helpers (_payToAccountCode / _normPmName) so
// the guard and the GL posting agree on what "credit" means.
// ─────────────────────────────────────────────────────────────────────────────

// Does this payment-method label/key denote a credit / on-account sale?
// Anchored on the file's own GL mapping (_payToAccountCode routes credit to the
// canonical AR account) so the guard and the posted journal never disagree. Also
// catches the Arabic labels the pos-v2 legacyPayload and middleware/o2cLegacyGate
// treat as on-account (كيتا / آجل / ذمم), so a direct POST can't slip a credit
// sale past the guard by sending the display label instead of the 'credit' key.
function _isCreditMethod(method) {
  if (_payToAccountCode(method) === CORE_ACCOUNTS.AR.code) return true;
  const k = _normPmName(method); // lower-cased + Arabic normalized (آجل → اجل)
  return /^(credit|customer_credit|kita|ar)$/.test(k) || /كيتا|اجل|ذمم/.test(k);
}

// Mirror pos-v2.js _userIsSuper EXACTLY: admin/manager role or the developer
// flag bypass the credit-sale supervisor gate (and grant "view all sales").
function _isSuperUser(user) {
  const role = String((user && user.role) || '').toLowerCase();
  return role === 'admin' || role === 'manager' || !!(user && user.isDeveloper);
}

// Does the POST /api/sales body carry a credit / on-account payment leg?
// Serves BOTH the legacy UI contract and the pos-v2 legacyPayload, so it checks
// every shape a credit leg can arrive in:
//   • single method:  paymentMethod = 'credit' | 'كيتا' | owner AR method …
//   • split (object):  splitDetails = { <label>: amount, … }        (legacy UI)
//   • split (array):   splitDetails = [{ method, amount }, … ]      (legacyPayload)
//   • structured:      payments     = [{ method, amount }, … ]      (O2C contract)
// For the split/payments shapes a leg only counts when its amount is > 0.
function _saleCarriesCredit(body) {
  if (!body || typeof body !== 'object') return false;
  // 1) single method — a lone credit method carries the whole invoice
  if (body.paymentMethod != null
      && String(body.paymentMethod).toLowerCase() !== 'split'
      && _isCreditMethod(body.paymentMethod)) return true;
  // 2) splitDetails — object {label:amount} OR array [{method,amount}]
  const sd = body.splitDetails;
  if (sd && typeof sd === 'object') {
    if (Array.isArray(sd)) {
      if (sd.some((leg) => leg && _isCreditMethod(leg.method) && (Number(leg.amount) || 0) > 0)) return true;
    } else if (Object.keys(sd).some((label) => _isCreditMethod(label) && (Number(sd[label]) || 0) > 0)) {
      return true;
    }
  }
  // 3) structured payments [{method,amount}] — sits alongside the legacy fields
  if (Array.isArray(body.payments)
      && body.payments.some((p) => p && _isCreditMethod(p.method) && (Number(p.amount) || 0) > 0)) return true;
  return false;
}

// Elevated read scope: admin/manager/developer, or an explicit sales.viewAll
// grant (see db/migrations/capability-seeds/g-sales-viewall.json). Everyone else
// sees only their OWN sales. Fails CLOSED (own-sales-only) on any capability
// lookup error — a DB hiccup must never widen a cashier's visibility.
async function _canViewAllSales(user) {
  if (_isSuperUser(user)) return true;
  try {
    return await requireCapability.hasCapability(user, 'sales.viewAll');
  } catch (e) {
    console.error('[sales] sales.viewAll capability check failed — restricting to own sales:', e && (e.code || e.message));
    return false;
  }
}

// Build a payment-method → GL account code map by joining payment_methods.gl_account_id → gl_accounts.code
// Returns configured payment-method keys mapped to canonical GL account codes.
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

// G-SPLIT — case-insensitive 'split' detector for WRITE-PATH BRANCH DECISIONS.
// The React POS (lib/posOrderMachine.js legacyPaymentFields) sends lowercase
// 'split'; the legacy UI sends 'Split'. The old `=== 'Split'` comparisons made
// every React split sale skip split_details_json persistence, keep the literal
// string 'split' as payment_method, and dump ALL payment GL legs into one
// clearing account. Only the branch DECISIONS go through this helper — what
// gets STORED in sales.payment_method for non-split flows is untouched (the
// caller's casing is preserved verbatim, exactly as before).
// W0-A — HALALA-SAFE leg amount for the `sales.payment_method` split string.
// It used to be `Math.round(v)`: 50.40 cash + 30.10 card was STORED as
// "كاش:50/شبكة:30", so every shift parser reconstructed 80 against a
// total_final of 80.50 and the cashier carried a 0.50 variance nobody could
// explain. Two decimals, always — an amount is money, not a count. Old rows
// that carry bare integers still parse identically (Number('50') === 50).
function _fmtLegAmount(v) {
  return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);
}

function _isSplitMethod(pm) {
  return String(pm || '').trim().toLowerCase() === 'split';
}

// v7.2 (#8) — Route split-payment GL legs from the STRUCTURED splitDetails
// object instead of re-parsing the lossy "Cash:80/Mada:20" string. A method
// name containing '/' (e.g. "شبكة/مدى") corrupts the string parse and dumps
// the amount into the wrong GL account. The object's keys are the exact
// method names the cashier picked, so we map each one through pmGlMap (with
// the same normalization the map build uses) and fall back to the legacy
// payToAccountCode heuristic only when a method isn't configured.
// G-SPLIT — now also accepts the pos-v2 legacyPayload ARRAY shape (the form
// the React POS actually posts; see lib/posOrderMachine.js legacyPaymentFields):
//   splitDetails: { Cash: 80, Mada: 20, ... }            (legacy UI object)
//   splitDetails: [{ method: 'كاش', amount: 80 }, ... ]  (pos-v2 array)
// → [{code, amount}, ...]
function _parseSplitFromDetails(splitDetails, pmGlMap) {
  const out = [];
  const lookup = (name) => {
    const k = _normPmName(name);
    return (pmGlMap && pmGlMap[k]) || _payToAccountCode(name);
  };
  if (!splitDetails || typeof splitDetails !== 'object') return out;
  if (Array.isArray(splitDetails)) {
    splitDetails.forEach(leg => {
      if (!leg || typeof leg !== 'object') return;
      const amt = Math.round((Number(leg.amount) || 0) * 100) / 100;
      if (amt > 0) out.push({ code: lookup(leg.method), amount: amt });
    });
    return out;
  }
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
//   { revenue, outputVat, cogs, inventory, platformCommission, platformPayable }
async function _resolveSaleGlCodes(db) {
  const codes = {
    revenue: CORE_ACCOUNTS.SALES_REVENUE.code,
    outputVat: CORE_ACCOUNTS.OUTPUT_VAT.code,
    cogs: CORE_ACCOUNTS.COGS.code,
    inventory: CORE_ACCOUNTS.INVENTORY.code,
    platformCommission: CORE_ACCOUNTS.PLATFORM_COMMISSION.code,
    platformPayable: CORE_ACCOUNTS.PLATFORM_PAYABLE.code,
  };
  const keyMap = {
    revenue:   'GL_SALES_REVENUE_CODE',
    outputVat: 'GL_OUTPUT_VAT_CODE',
    cogs:      'GL_COGS_CODE',
    inventory: 'GL_INVENTORY_CODE',
    platformCommission: 'GL_PLATFORM_COMMISSION_CODE',
    platformPayable: 'GL_PLATFORM_PAYABLE_CODE',
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
// G-SALES — checkout stays reachable by the cashier: `pos.use` is the base POS
// capability (live for role=cashier). Roles without it (employee/warehouse) 403.
router.post('/', requireCapability('pos.use'), async (req, res) => {
  const _pool = db; // capture outer pool reference before shadowing
  let _conn;

  // ─── close2/sales-security · Task 1 — credit-sale supervisor gate ───
  // This money-writing endpoint must enforce the SAME rule pos-v2.js enforces on
  // its cart-submit path (routes/pos-v2.js: credit legs require a supervisor).
  // A direct POST here with a credit/on-account leg — single method OR any split
  // / structured-payments leg — is rejected for non-supervisors. Run BEFORE any
  // DB connection or transaction opens (no partial writes), and INDEPENDENTLY of
  // ORDER_TO_CASH_ENABLE / middleware/o2cLegacyGate (that gate only fires when
  // the flag is ON — this closes the gap when it's OFF). Authority = admin/manager
  // role, the developer flag, or the credit.override capability (the exact id the
  // O2C creditSaleGate already uses).
  if (_saleCarriesCredit(req.body)) {
    let _creditAllowed = _isSuperUser(req.user);
    if (!_creditAllowed) {
      try {
        _creditAllowed = await requireCapability.hasCapability(req.user, 'credit.override');
      } catch (capErr) {
        // Fail CLOSED — never open a credit sale when authority can't be verified.
        console.error('[POST /sales] credit.override capability check failed — denying credit sale:', capErr && (capErr.code || capErr.message));
        _creditAllowed = false;
      }
    }
    if (!_creditAllowed) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'البيع الآجل يتطلب مشرفًا/مديرًا' });
    }
  }

  try {
    _conn = await _pool.getConnection();
    await _conn.beginTransaction();
    // eslint-disable-next-line no-shadow
    const db = _conn; // local shadow — every db.query() below routes through _conn

    const { items, total, totalFinal, paymentMethod, discountName, discountAmount, lineDiscountTotal, kitaServiceFee, splitDetails } = req.body;
    const { shiftId, warehouseId: reqWhId } = req.body;
    // v7.2 — HIGH: the actor is the AUTHENTICATED user, never the body.
    // G-SALES — the legacy req.body.username fallback is DELETED: it let a
    // caller post a sale under any cashier's name (audit forgery + wrong
    // shift/commission attribution). requireCapability('pos.use') above
    // guarantees req.user is set, so there is no legitimate absent case.
    const username = req.user.username;
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

    // ─── «ترحيل المبيعات» capture buffers ───
    // Declared at handler scope because the splits are built deep inside the
    // GL block (paymentDebits at ~:1802, totalCogs at ~:1661) while the queue
    // row is written just before the commit. They hold the three things four
    // totals cannot reconstruct: payment by method, revenue by account, and
    // COGS by warehouse. Empty is a legitimate state — a comp sale whose
    // components all cost zero posts no GL entries at all.
    let _capturePayments = [];
    let _captureRevenue = [];
    let _captureCogsByWarehouse = [];
    let _captureCogs = 0;
    let _captureCommissions = [];

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
    // G-SPLIT — the branch decision is case-insensitive ('Split' from the
    // legacy UI, 'split' from the React POS) and the legs are read from
    // EITHER persisted shape: object {label: amount} (legacy) or array
    // [{method, amount}] (pos-v2 legacyPayload). Before this, a lowercase
    // 'split' sale stored the literal string 'split' as payment_method.
    // Non-split sales still store paymentMethod verbatim (casing preserved).
    let payStr = paymentMethod;
    if (_isSplitMethod(paymentMethod) && splitDetails) {
      const _legPairs = Array.isArray(splitDetails)
        ? splitDetails.filter(l => l && Number(l.amount) > 0).map(l => [String(l.method), Number(l.amount)])
        : Object.entries(splitDetails).filter(([k,v]) => v > 0);
      // W0-A — 2-decimal legs (was Math.round(v), which silently dropped the
      // halalas and manufactured shift variance). See _fmtLegAmount.
      payStr = _legPairs.map(([k,v]) => k+':'+_fmtLegAmount(v)).join('/');
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
    // v7.4 — retain each line's PRE-discount split for the O2C projection.
    // These were computed and thrown away into the accumulators below; the
    // projection needs them as the allocation weights, and they are the only
    // per-line tax figures the sale ever produces.
    const _lineTax = [];
    items.forEach((it, lineIdx) => {
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
      _lineTax.push({
        sourceLineId: 'L' + lineIdx, lineIdx,
        menuId: it.id || null, name: it.name || null,
        qty, unitPrice, cat, rate, inclusive: isIncl,
        net: lineNet, vat: lineVat,
      });
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
    // v7.4 — the discount ACTUALLY applied to this sale. `discountAmount` from
    // the body is neither: it is the invoice discount only (line discounts were
    // never recorded at all) and it is uncapped, so whenever the cap bit, the
    // stored value could not be reconciled against total_final. This is the
    // figure the sale row and the AR header both persist, and the one the line
    // allocations must sum to.
    const appliedDiscountTotal = Math.round((lineDiscCapped + invDiscCapped) * 100) / 100;
    // ONE ratio scales NET and VAT together (gross-proportional). A
    // zero-rated bucket (vat already 0) stays 0, and the VAT-factor skew the
    // old net-space discount caused is gone.
    const discountRatio    = grossSubtotal > 0 ? (grossAfterDiscount / grossSubtotal) : 0;
    const netAfterDiscount = Math.round(grandNet * discountRatio * 100) / 100;
    const vatAfterDiscount = Math.round(grandVat * discountRatio * 100) / 100;

    const grossPrecise = Math.round((netAfterDiscount + vatAfterDiscount) * 100) / 100;
    // v8.1 — the total is the EXACT 2-decimal amount. It used to be rounded to
    // a whole SAR (pricing.roundToWhole), which broke the one property the
    // owner asked for: "price before tax + tax = the number on the invoice".
    // A 16.00 net item is 16.00 + 2.40 = 18.40; rounding that to 18 forces the
    // delta onto the net side below, so the invoice would read net 15.65 —
    // NOT the 16.00 the owner priced. Menu prices stay whole numbers; only the
    // computed total carries halalas, which is what every POS and the ZATCA
    // invoice expect.
    const invTotal = grossPrecise;

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
    // The delta below is now structurally 0 (invTotal === grossPrecise since
    // the whole-SAR rounding was removed); it is kept as an explicit safety
    // net so the journal invariant net + vat === invTotal is enforced by
    // construction rather than by assumption.
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
    // The recorded total MUST equal what the cashier displayed. If the client
    // total is present and off by more than the tolerance, something is wrong
    // (a dropped discount, a tampered price, a stale cart, a contract drift) —
    // REJECT the sale inside the transaction (rollback: no sale, no GL, no
    // ZATCA serial) rather than silently charging a different amount. We always
    // record the SERVER figure (invTotal). Skipped when the client omits
    // totalFinal (legacy POS builds) so the server recompute still governs.
    //
    // v8.1 — the client total is compared at 2 DECIMALS, not rounded to a whole
    // SAR. Both sides now compute the same exact amount (same per-item tax
    // convention, same settings.VATRate, no whole-SAR rounding), so the only
    // legitimate difference is sub-halala float noise. Rounding the client
    // figure to an integer here would have masked a real 0.40 divergence — and
    // this guard exists precisely to refuse charging a number the customer was
    // not shown.
    const clientTotalFinal = Math.round((Number(totalFinal) || 0) * 100) / 100;
    const TOTAL_TOLERANCE = 0.02; // two halalas — per-line rounding, nothing more
    if (Number.isFinite(clientTotalFinal) && clientTotalFinal > 0 &&
        Math.abs(invTotal - clientTotalFinal) > TOTAL_TOLERANCE) {
      const mmErr = new Error(
        'تعذّر إتمام البيع: الإجمالي المعروض (' + clientTotalFinal +
        ') لا يطابق الإجمالي المحسوب (' + invTotal +
        '). يرجى تحديث السلة وإعادة المحاولة · Displayed total does not match the computed total.'
      );
      mmErr.status = 400;
      mmErr.code = 'total_mismatch';
      throw mmErr;
    }
    // v7.5 — audit trail for sub-tolerance drift. Any non-zero delta now means
    // client/server math is diverging (they compute the identical amount), so
    // the window narrowed with the tolerance above: log everything that is not
    // exactly equal but still accepted.
    if (Number.isFinite(clientTotalFinal) && clientTotalFinal > 0) {
      const _tfDelta = Math.abs(invTotal - clientTotalFinal);
      if (_tfDelta > 0 && _tfDelta <= TOTAL_TOLERANCE) {
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
    // v7.3 — stamp the seller's brand + branch ONTO the sale.
    // `sales.brand_id`/`branch_id` have existed since server.js:1983-1984 but
    // nothing ever wrote them, so every row was NULL and the receipt had to
    // guess the branch at print time — which meant a historical receipt silently
    // followed the cashier when they were reassigned. Freezing it here is both
    // the correctness fix and the foundation for the invoice snapshot.
    let saleBrandId = null, saleBranchId = null;
    try {
      saleBrandId  = (req.user && (req.user.brandId  || req.user.brand_id))  || null;
      saleBranchId = (req.user && (req.user.branchId || req.user.branch_id)) || null;
      if ((!saleBrandId || !saleBranchId) && username) {
        const [u] = await db.query(
          'SELECT brand_id, branch_id, default_branch_id FROM users WHERE username = ? LIMIT 1', [username]);
        if (u.length) {
          saleBrandId  = saleBrandId  || u[0].brand_id || null;
          saleBranchId = saleBranchId || u[0].branch_id || u[0].default_branch_id || null;
        }
      }
    } catch (e) {
      console.warn('[sales] could not resolve seller brand/branch for', username, '—', e.code || e.message);
    }

    // v4 — freeze the seller identity this invoice is issued under. Resolved
    // through the scope chain (branch → brand → company → global settings) and
    // content-addressed, so a later logo/tax-number edit cannot rewrite what this
    // receipt already printed or the ZATCA QR built from it. Best-effort: a
    // failure here must never block taking money — the reprint then falls back to
    // a live resolve exactly as it did before.
    let receiptIdentityId = null;
    try {
      const { identity } = await invoiceIdentity.resolveIdentity(db, { brandId: saleBrandId, branchId: saleBranchId });
      receiptIdentityId = await invoiceIdentity.snapshotIdentity(db, identity);
    } catch (e) {
      console.warn('[sales] receipt identity snapshot skipped for', orderId, '—', e.code || e.message);
    }

    try {
      if (clientOrderId) {
        await db.query('INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, discount_name, discount_amount, kita_service_fee, client_order_id, brand_id, branch_id, receipt_identity_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [orderId, now, JSON.stringify(items), invTotal, payStr, username, shiftId, discountName || '', appliedDiscountTotal, kitaServiceFee || 0, clientOrderId, saleBrandId, saleBranchId, receiptIdentityId]);
      } else {
        await db.query('INSERT INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, discount_name, discount_amount, kita_service_fee, brand_id, branch_id, receipt_identity_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [orderId, now, JSON.stringify(items), invTotal, payStr, username, shiftId, discountName || '', appliedDiscountTotal, kitaServiceFee || 0, saleBrandId, saleBranchId, receiptIdentityId]);
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
        // A clientOrderId means the POS is (re)playing a checkout and is relying
        // on us to make the replay single-shot. If the column is missing we CANNOT
        // honour that contract.
        //
        // This branch used to silently re-insert without client_order_id: the sale
        // succeeded, the POS saw 200, and every offline replay posted the invoice,
        // the GL journal and the stock relief AGAIN — duplicating money with no
        // error anywhere. Never silently downgrade an idempotency guarantee; fail
        // loudly so the schema gets fixed instead of the books.
        console.error(
          '[sales] REFUSING checkout: clientOrderId supplied but `sales` is missing a ' +
          'column required for idempotency (' + (insErr.sqlMessage || insErr.message) + '). ' +
          'Run the boot migrations (addColumnIfMissing on sales) and retry.'
        );
        const e = new Error('Checkout idempotency unavailable on this deploy — refusing to risk a duplicate sale.');
        e.code = 'IDEMPOTENCY_UNAVAILABLE';
        e.status = 503;
        throw e;
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
    // G-SPLIT — case-insensitive guard; the ORIGINAL shape is stored verbatim
    // (object for legacy, array for pos-v2 — ProjectionService._resolvePaymentLegs
    // and GET /:orderId already read both).
    if (_isSplitMethod(paymentMethod) && splitDetails && typeof splitDetails === 'object') {
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

    // Stamp ZATCA fields back — including the TLV payload, so the QR the
    // customer received is the QR every future reprint shows, byte for byte,
    // rather than a client-side re-derivation that drifts with the inputs.
    if (zatcaStamp.uuid) {
      try {
        await db.query(
          `UPDATE sales SET invoice_uuid=?, invoice_hash=?, previous_invoice_hash=?, zatca_type=?, zatca_qr_base64=? WHERE id=?`,
          [zatcaStamp.uuid, zatcaStamp.invoiceHash, zatcaStamp.previousInvoiceHash || null, 'simplified', zatcaStamp.qrBase64 || null, orderId]);
      } catch(e) {
        // Not silent (was `/* older schema — ignore */`): losing the stamp means
        // the printed invoice and the stored one disagree, and nobody knew.
        console.error('[zatca] failed to persist stamp on sale', orderId, e.code || e.message);
      }
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
    // v7.4 BUG FIX — the guard below used to read `recipeMap[r.menu_id]`, which
    // is also where THIS loop accumulates. So the first ingredient of a legacy
    // recipe created the key, and every ingredient after it matched the guard
    // and was silently dropped: a multi-ingredient legacy recipe deducted only
    // its FIRST ingredient, understating COGS and never relieving the rest of
    // the inventory — with no error anywhere. Snapshot the BOM-covered set
    // BEFORE the loop so the guard means what its comment says.
    const _bomCovered = new Set(Object.keys(recipeMap));
    const [recipes] = await db.query('SELECT * FROM recipe');
    recipes.forEach(r => {
      if (_bomCovered.has(String(r.menu_id))) return;  // BOM already covers this — skip legacy
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

    // ─── Combos (العروض) — load definitions for any combo lines in this order ───
    // A combo line carries no BOM of its own; its makeup is fixed components
    // (always consumed) + choice groups (cashier-selected). We resolve the
    // FIXED parts authoritatively from the DB and VALIDATE the client choices
    // against the stored options (blocks a tampered client picking arbitrary
    // deductions). Each resolved component then runs through the SAME deduction
    // engine as a normal item, so COGS/GL stay correct with no engine changes.
    const comboWarnings = [];          // [{ combo, group, choice?, reason }]
    const comboDefMap = {};            // comboMenuId → { groups:[{id,type,items:[{menuItemId,qty}]}] }
    const comboCompNameMap = {};       // componentMenuId → name (for logs/warnings)
    try {
      const lineIds = [...new Set(items.map(it => it.id).filter(Boolean))];
      if (lineIds.length) {
        const ph = lineIds.map(() => '?').join(',');
        const [comboRows] = await db.query(
          `SELECT id FROM menu WHERE id IN (${ph}) AND is_combo = 1`, lineIds);
        if (comboRows.length) {
          const cids = comboRows.map(r => r.id);
          cids.forEach(cid => { comboDefMap[cid] = { groups: [] }; });
          const cph = cids.map(() => '?').join(',');
          const [grps] = await db.query(
            `SELECT id, menu_id, group_type FROM combo_groups WHERE menu_id IN (${cph}) ORDER BY sort_order, id`, cids);
          const gById = {};
          grps.forEach(g => { gById[g.id] = { menuId: g.menu_id, type: g.group_type, items: [] }; });
          if (grps.length) {
            const gids = grps.map(g => g.id);
            const gph = gids.map(() => '?').join(',');
            const [gItems] = await db.query(
              `SELECT group_id, menu_item_id, qty FROM combo_group_items WHERE group_id IN (${gph}) ORDER BY sort_order, id`, gids);
            const compIds = [];
            gItems.forEach(it => {
              if (gById[it.group_id]) gById[it.group_id].items.push({ menuItemId: it.menu_item_id, qty: Number(it.qty) || 1 });
              compIds.push(it.menu_item_id);
            });
            Object.keys(gById).forEach(gid => {
              const g = gById[gid];
              if (comboDefMap[g.menuId]) comboDefMap[g.menuId].groups.push({ id: gid, type: g.type, items: g.items });
            });
            // Component names for movement logs / warnings
            const uniqComp = [...new Set(compIds)];
            if (uniqComp.length) {
              const ph2 = uniqComp.map(() => '?').join(',');
              const [names] = await db.query(`SELECT id, name FROM menu WHERE id IN (${ph2})`, uniqComp);
              names.forEach(r => { comboCompNameMap[r.id] = r.name; });
            }
          }
        }
      }
    } catch (e) { console.warn('[sales] combo load failed:', e.message); }

    // v7.4 — indexed loop. `recipesApplied` et al. were keyed ONLY by menuId,
    // which cannot identify a LINE: two cart lines of the same item are
    // indistinguishable, and the `continue`s below mean the arrays have gaps,
    // so positional correlation is invalid too. The projection needs to know
    // which line each deduction belongs to, so every push now carries lineIdx
    // — the line's ordinal in `items`, which is also its source_line_id.
    for (let lineIdx = 0; lineIdx < items.length; lineIdx++) {
      const item = items[lineIdx];
      // sales_items log row
      await db.query('INSERT INTO sales_items (order_id, order_date, item_name, qty, price, total, payment_method, username, shift_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [orderId, now, item.name, item.qty, item.price, item.qty * item.price, payStr, username, shiftId]);

      // Stock deduction
      if (!item.id) {
        itemsWithoutRecipe.push({ name: item.name, reason: 'no item id' });
        continue;
      }

      // ─── Combo line: expand into components, deduct each, then skip the
      // normal item paths (the combo row itself has no recipe/stock). ───
      if (comboDefMap[item.id]) {
        const def = comboDefMap[item.id];
        // Build the consumed component list.
        const components = []; // [{ menuId, qty }]
        // 1) Fixed components — always consumed (authoritative from DB).
        def.groups.filter(g => g.type === 'fixed').forEach(g => {
          g.items.forEach(ci => components.push({ menuId: ci.menuItemId, qty: ci.qty }));
        });
        // 2) Choice components — from the cashier's validated selections.
        const sel = Array.isArray(item.comboChoices) ? item.comboChoices : [];
        def.groups.filter(g => g.type === 'choice').forEach(g => {
          const picks = sel.filter(s => s && String(s.groupId) === String(g.id));
          if (!picks.length) { comboWarnings.push({ combo: item.name, group: g.id, reason: 'no selection' }); return; }
          picks.forEach(p => {
            const opt = g.items.find(ci => String(ci.menuItemId) === String(p.menuItemId));
            if (opt) components.push({ menuId: opt.menuItemId, qty: opt.qty });
            else comboWarnings.push({ combo: item.name, group: g.id, choice: p.menuItemId, reason: 'invalid choice (not an option)' });
          });
        });

        const deductions = [];
        for (const comp of components) {
          const compName = comboCompNameMap[comp.menuId] || comp.menuId;
          const compMeta = productionMetaMap[comp.menuId];
          // Imported/stocked component → relieve its own stock (valued at menu.cost in GL).
          if (compMeta && compMeta.method === 'imported') {
            const physQty = comp.qty * item.qty;
            try {
              if (warehouseId) {
                await deductWarehouseStock(db, warehouseId, comp.menuId, physQty);
                await recomputeMenuStock(db, comp.menuId);
              } else {
                await db.query('UPDATE menu SET stock = stock - ? WHERE id = ?', [physQty, comp.menuId]);
              }
              // lineIdx, not menuId: this records the COMPONENT's menuId, which
              // matches no cart line at all, so lineIdx is the only thing that
              // ties this deduction back to the combo line that caused it.
              importedDeductions.push({ lineIdx, menuId: comp.menuId, menuName: compName, qty: physQty });
            } catch (_) {}
            continue;
          }
          // Made-to-order component → deduct its recipe (same engine as normal items).
          const recipe = recipeMap[comp.menuId];
          if (!recipe) {
            itemsWithoutRecipe.push({ id: comp.menuId, name: compName, reason: 'combo component without recipe', combo: item.id });
            continue;
          }
          for (const ing of recipe) {
            const deduct = ing.qtyUsed * comp.qty * item.qty;
            if (warehouseId) {
              await deductWarehouseStock(db, warehouseId, ing.invId, deduct);
              await recomputeInvItemStock(db, ing.invId);
            } else {
              await db.query('UPDATE inv_items SET stock = stock - ? WHERE id = ?', [deduct, ing.invId]);
            }
            const movId = 'MOV-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4) + '-' + deductions.length;
            await db.query(
              'INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
              [movId, now, ing.invId, ing.invName, 'out', deduct, 'مبيعات (عرض)', username, (invoiceNumber || orderId) + ' / ' + item.name + ' → ' + compName, warehouseId || null, 'sale', (invoiceNumber || orderId)]
            );
            deductions.push({ invId: ing.invId, invName: ing.invName, deducted: deduct, affected: 1 });
          }
        }
        recipesApplied.push({ lineIdx, menuId: item.id, menuName: item.name, deductions: deductions, isCombo: true });
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
            lineIdx, menuId: item.id, menuName: item.name,
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
          importedDeductions.push({ lineIdx, menuId: item.id, menuName: item.name, qty: Number(item.qty) || 0 });
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
        lineIdx,
        menuId: item.id,
        menuName: item.name,
        deductions: deductions
      });
    }

    // Production: removed debug log

    // ═══════════════════════════════════════════════════════════════
    // DEFERRED GL SNAPSHOT — Revenue + VAT + COGS
    // Checkout computes and freezes the exact economic legs here, but writes
    // no journal. The queue capture below is fatal and the operator later
    // posts one daily/monthly journal with invoice drill-down.
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
    // v7.4 — per-line COGS + component snapshots for the O2C projection, built
    // from the SAME deductions and cost maps that produce totalCogs below.
    // Assigned inside the COGS block where those maps are in scope.
    let _projCost = null;
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
        // v7.4 — hoisted out of the `if` below so the projection can value
        // imported components from the SAME map the GL used.
        const impCost = {};
        if (importedDeductions.length) {
          const impIds = [...new Set(importedDeductions.map(d => d.menuId))];
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

        // ─── v7.4 — per-line COGS + component snapshots (O2C projection) ───
        // Same deductions, same cost maps, same numbers the GL just posted.
        // A return must reverse the cost that was actually booked, and the
        // recipe may be reformulated before the return is ever filed — so the
        // components are frozen here rather than re-read later.
        //
        // totalCogs rounds ONCE at the end (above), so per-line rounding would
        // not sum back to it. We allocate the recorded totalCogs across lines
        // instead, using the same largest-remainder primitive the money path
        // uses — exact by construction, and totalCogs itself never shifts (the
        // GL legs below are already computed from it and posting is fatal).
        {
          const comps = [];   // flat: one row per deducted component
          recipesApplied.forEach((r) => {
            r.deductions.forEach((d) => {
              const unitCost = costMap[d.invId] || 0;
              comps.push({
                lineIdx: r.lineIdx,
                source: r.isCombo ? 'combo' : 'recipe',
                invItemId: d.invId, invItemName: d.invName,
                deductedBaseQty: Number(d.deducted) || 0,
                unitCostSnapshot: unitCost,
                rawCost: (Number(d.deducted) || 0) * unitCost,
              });
            });
          });
          importedDeductions.forEach((d) => {
            const unitCost = impCost[d.menuId] || 0;
            comps.push({
              lineIdx: d.lineIdx,
              source: 'imported',
              invItemId: d.menuId, invItemName: d.menuName,
              deductedBaseQty: Number(d.qty) || 0,
              unitCostSnapshot: unitCost,
              rawCost: (Number(d.qty) || 0) * unitCost,
            });
          });

          // Weights are integers at 4dp of a SAR — ample proportional
          // resolution without risking the 2^53 ceiling on a large cart.
          const W = (raw) => Math.round((Number(raw) || 0) * 1e4);
          const lineIdxs = [...new Set(comps.map((c) => c.lineIdx))].sort((a, b) => a - b);
          const lineRaw = lineIdxs.map((li) =>
            comps.filter((c) => c.lineIdx === li).reduce((s, c) => s + c.rawCost, 0));

          const costByLine = {};
          if (lineIdxs.length) {
            // Σ(line cost_snapshot) === totalCogs, exactly.
            const parts = alloc.largestRemainder(
              alloc.toMinor(totalCogs), lineRaw.map(W), lineIdxs.map((li) => 'L' + li));
            lineIdxs.forEach((li, i) => { costByLine[li] = parts[i]; });
          }

          // Σ(component total_cost) === that line's cost_snapshot, exactly.
          lineIdxs.forEach((li) => {
            const mine = comps.filter((c) => c.lineIdx === li);
            const parts = alloc.largestRemainder(
              costByLine[li], mine.map((c) => W(c.rawCost)),
              mine.map((c, i) => String(c.invItemId || '') + '#' + i));
            mine.forEach((c, i) => { c.totalCostMinor = parts[i]; });
          });

          _projCost = { costByLine, components: comps, totalCogs };
        }

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
        if (invTotal > 0) {
          let paymentDebits;
          // G-SPLIT — case-insensitive guard: a React 'split' sale now routes
          // one GL debit PER LEG (via _parseSplitFromDetails, which reads both
          // the object and the pos-v2 array shape) instead of collapsing the
          // whole invoice into one clearing-account debit.
          if (_isSplitMethod(paymentMethod) && splitDetails && typeof splitDetails === 'object') {
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

          // Snapshot the splits for the posting queue. Taken HERE, from the
          // same values the journal is built from, so a batch can only ever
          // reproduce what this sale actually posted. Reading the sale again
          // at posting time would let a later edit change a number that was
          // already reported.
          _capturePayments = paymentDebits.map(pd => ({ code: pd.code, amount: pd.amount }));
          _captureRevenue = [{ code: saleGl.revenue, amount: net }];
          if (vat > 0) _captureRevenue.push({ code: saleGl.outputVat, amount: vat, tax: true });

        }

        // v6.0.1 Wave A.5 — Discount GL entries REMOVED (Net method per IFRS 15 §70).
        // Revenue is recognised at the consideration the entity is entitled to
        // = net post-discount, already included in the sales-revenue credit.
        // The previous "Dr Discount Allowed / Cr Revenue add-back" pattern
        // double-inflated revenue without properly adjusting Output VAT for
        // the discount portion, producing a 3-way inconsistency.
        // Discount visibility is preserved through sales.discount_amount +
        // discount_name + reports filters (no GL entry needed).

        // COGS leg (if any cost)
        if (totalCogs > 0) {
          // Snapshot for the queue. Grouped by warehouse because that is the
          // grain the inventory credit is posted at, and `ar_documents` has no
          // warehouse_id to recover it from later.
          _captureCogs = totalCogs;
          _captureCogsByWarehouse = [{ warehouseId: warehouseId || null, amount: totalCogs,
            cogsCode: saleGl.cogs, inventoryCode: saleGl.inventory }];
        }

        // No journal is written per invoice. The values above are immutable
        // snapshots for the posting queue, which creates one daily/monthly
        // journal while retaining invoice drill-down.

        // Commission is part of the same queued event. Losing this lookup
        // would understate both expense and the platform payable, so it is no
        // longer a best-effort side journal.
        if (channelId && net > 0) {
          const [chRow] = await db.query(
            'SELECT commission_pct, service_fee_pct FROM sales_channels WHERE id = ? LIMIT 1', [channelId]);
          const _pct = chRow.length
            ? (Number(chRow[0].commission_pct) || 0) + (Number(chRow[0].service_fee_pct) || 0) : 0;
          const _amt = Math.round(net * (_pct / 100) * 100) / 100;
          if (_amt > 0) {
            _captureCommissions = [{
              amount: _amt,
              expenseCode: saleGl.platformCommission,
              payableCode: saleGl.platformPayable,
            }];
          }
        }
      }
    }

    // ═══ v7.4 — eager POS→O2C line projection ═══════════════════════════
    // Placement is load-bearing:
    //  • INSIDE the transaction (before the commit below), so a projection
    //    failure rolls back the sale, inventory and GL together. Anything
    //    after the commit runs under autocommit and could not be rolled back.
    //  • `gl_journal_id` is intentionally NULL until the event belongs to an
    //    aggregated SalesBatch; O2C returns resolve from immutable line and
    //    component snapshots, not from an invoice-level journal.
    //  • linkPosSale(conn, …) only — never InvoiceService.issue(), which opens
    //    its OWN connection via db.withTransaction and would then SELECT … FOR
    //    UPDATE rows this transaction has not committed: a guaranteed self-
    //    deadlock, amplified by the pool's lock-wait retry loop.
    //
    // Fatal by design: a sale whose snapshot
    // is missing or disagrees with the ledger is not returnable and not
    // auditable, so it is better never recorded than recorded wrong.
    //
    // Gated on the O2C flag, which is this module's documented rollback lever
    // (ORDER_TO_CASH_ENABLE=0 restores the legacy path untouched).
    if (o2cConfig.o2cEnabled()) {
      const _alloc = alloc.allocateSaleLines({
        lines: _lineTax,
        taxSubtotals,
        appliedDiscount: appliedDiscountTotal,
        totalFinal: invTotal,
      });
      const _allocById = {};
      _alloc.lines.forEach((l) => { _allocById[l.sourceLineId] = l; });

      const _projLines = _lineTax.map((t) => {
        const a = _allocById[t.sourceLineId];
        return {
          sourceLineId: t.sourceLineId,
          // POS lines are MENU items: menu_id is the identity, item_id stays
          // null (inventory items appear only as component snapshots below).
          itemId: null,
          menuId: t.menuId,
          description: t.name,
          enteredUnitId: null, enteredUnitCode: null,
          enteredQty: t.qty, conversionFactor: 1, baseQty: t.qty,
          unitPrice: t.unitPrice,
          discountAmount: a.discount,
          vatCategory: t.cat, vatRate: t.rate,
          netAmount: a.net, vatAmount: a.vat, grossAmount: a.gross,
          // The GL journal is referenced on the header; the revenue account is
          // not re-derived per line (that would recompute, not snapshot).
          revenueAccountId: null, revenueAccountCode: null,
          warehouseId: warehouseId || null,
          costSnapshot: alloc.fromMinor((_projCost && _projCost.costByLine[t.lineIdx]) || 0),
          projectionVersion: _alloc.projectionVersion,
        };
      });

      const _projComponents = (_projCost ? _projCost.components : []).map((c) => ({
        sourceLineId: 'L' + c.lineIdx,
        source: c.source,
        invItemId: c.invItemId, invItemName: c.invItemName,
        warehouseId: warehouseId || null,
        deductedBaseQty: c.deductedBaseQty,
        unitCode: null, conversionFactor: null,
        unitCostSnapshot: c.unitCostSnapshot,
        totalCost: alloc.fromMinor(c.totalCostMinor || 0),
        projectionVersion: _alloc.projectionVersion,
      }));

      await InvoiceService.linkPosSale(db, {
        id: orderId,
        invoice_number: invoiceNumber || orderId,
        order_date: now,
        total_final: invTotal,
        vat_amount: vat,
        // The APPLIED discount, not the raw body value — see the sales INSERT.
        discount_amount: appliedDiscountTotal,
        brand_id: saleBrandId || null,
        branch_id: saleBranchId || null,
        customer_id: resolvedCustomerId || null,
        zatca_status: zatcaStamp.uuid ? 'pending' : 'pending',
        invoice_uuid: zatcaStamp.uuid || null,
        invoice_hash: zatcaStamp.invoiceHash || null,
      }, {
        actor: username || '',
        status: 'paid',
        lines: _projLines,
        components: _projComponents,
      });
    }

    // ═══ «ترحيل المبيعات» — capture this sale as a postable economic event ══
    //
    // INSIDE the transaction, and that placement is the whole point. The
    // post-commit region below is NOT reached on the idempotent-replay path
    // (a duplicate clientOrderId rolls back and returns 200 earlier in this
    // handler) nor on any of the three rollbacks — so a capture placed there
    // would miss exactly the cases where a sale exists without a posting
    // record, which is the hole this queue exists to close.
    //
    // On `db`, which is the transaction connection (shadowed at the top of the
    // handler). It must never open its own connection: that would deadlock
    // against the row locks this transaction already holds.
    //
    // Cheap by construction — every value below is already in memory, and
    // there is no account resolution and no balance check. Those move to
    // posting time, which is the change the owner asked for.
    //
    // The queue is now the accounting source of truth. It is written in this
    // same transaction and is therefore fatal: a committed sale without its
    // economic event could never be included in a batch.
    await salesPostingCapture.capture(db, {
        sourceType: 'sale',
        sourceId: orderId,
        occurredAt: now,
        brandId: saleBrandId || brandId || null,
        branchId: saleBranchId || branchId || null,
        net, tax: vat, gross: invTotal, cogs: _captureCogs,
        invoiceNumber: invoiceNumber || null,
        channelId: channelId || null,
        payments: _capturePayments,
        revenue: _captureRevenue,
        cogsByWarehouse: _captureCogsByWarehouse,
        commissions: _captureCommissions,
      }, { throwOnError: true });

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

    // Unified Sales Analytics — project the committed sale into the fact tables.
    // AFTER commit, on the POOL (never _conn), non-fatal: safeProject never
    // throws; a failure is queued into analytics_projection_repair.
    try { analyticsProjection.safeProject(_pool, 'sale', orderId, () => analyticsProjection.projectPosSale(_pool, orderId)); } catch (_) {}

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
      // Combo selections that could not be resolved (missing/invalid choice).
      // Non-blocking diagnostic — the sale still posts with what WAS valid.
      comboWarnings: comboWarnings.length ? comboWarnings : undefined,
      // postingWarning kept for backward-compat; always null now (GL is fatal).
      postingWarning: null,
      // v6.0.3 Wave C.1 — zero-cost component warning (non-blocking)
      cogsWarning: cogsWarning,
      zatca: {
        uuid: zatcaStamp.uuid || null,
        invoiceHash: zatcaStamp.invoiceHash || null,
        previousInvoiceHash: zatcaStamp.previousInvoiceHash || null,
        qrBase64: zatcaStamp.qrBase64 || null,
        // Print-ready PNG so the receipt needs no client-side QR encoder.
        qrDataUrl: await zatcaQrDataUrl(zatcaStamp.qrBase64)
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
    // ─── close2/sales-security · Task 3 — server-side ownership scoping ───
    // The username filter used to be applied ONLY when the client sent it, so a
    // plain cashier calling this with no param (or with someone ELSE's username)
    // got EVERY cashier's sales. Decide the effective username filter on the
    // SERVER from the verified identity: privileged callers (admin/manager/dev or
    // sales.viewAll) may filter by any username (or omit for all); everyone else
    // is pinned to their OWN username regardless of what they sent.
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    const _viewAll = await _canViewAllSales(req.user);
    const _userFilter = _viewAll ? (req.query.username || null) : req.user.username;

    let query =
      'SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.gender AS customer_gender ' +
      'FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE 1=1';
    const params = [];
    if (req.query.startDate)     { query += ' AND DATE(s.order_date) >= ?'; params.push(req.query.startDate); }
    if (req.query.endDate)       { query += ' AND DATE(s.order_date) <= ?'; params.push(req.query.endDate); }
    if (_userFilter)             { query += ' AND s.username = ?'; params.push(_userFilter); }
    // New: server-side shift filter so the POS can scope to one shift instead of
    // fetching everything and filtering in the browser.
    if (req.query.shiftId)       { query += ' AND s.shift_id = ?'; params.push(req.query.shiftId); }
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
      if (_userFilter)             { legacy += ' AND username = ?'; lp.push(_userFilter); }
      if (req.query.shiftId)       { legacy += ' AND shift_id = ?'; lp.push(req.query.shiftId); }
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
  } catch (e) {
    // G-SALES error honesty — an empty [] here made a DB failure look like
    // "no sales today" on every financial screen. Surface it as a 500.
    console.error('[GET /sales]', e.message);
    res.status(500).json({ success: false, error: 'تعذّر تحميل المبيعات', code: 'sales_list_failed' });
  }
});

// Get invoice
// V5.7.9 — also returns cashier full-name, branch name+address, and company
//          contact info (phone/email) so the printed receipt can render the
//          full bilingual layout the user expects (matches printed sample).
// Parse a sale's RECORDED per-category tax breakdown (sales.tax_subtotals_json,
// shape { <category>: { net, vat, rate? } }) into summed net/vat plus a
// {net,vat} map per category. Returns null when the column is absent/empty
// (pre-migration sales) or the blob is unparseable — a caller must treat null as
// "indeterminable", NEVER as zero (a rebuilt ZATCA QR must carry the sale's real
// VAT, not a guessed one). Rounded to 2dp so the exposed figures match paper.
function parseTaxSubtotals(rawJson) {
  if (rawJson == null || rawJson === '') return null;
  let parsed;
  try { parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson; }
  catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const byCategory = {};
  let net = 0, vat = 0;
  for (const [cat, b] of Object.entries(parsed)) {
    const bn = Number(b && b.net) || 0;
    const bv = Number(b && b.vat) || 0;
    byCategory[cat] = { net: r2(bn), vat: r2(bv) };
    net += bn; vat += bv;
  }
  return { net: r2(net), vat: r2(vat), byCategory };
}

router.get('/invoice/:orderId', async (req, res) => {
  try {
    const [sales] = await db.query('SELECT * FROM sales WHERE id = ?', [req.params.orderId]);
    if (!sales.length) return res.json(null);
    const sale = sales[0];

    // ─── close2/sales-security · Task 2 — invoice ownership ───
    // Previously ANY authenticated user could fetch ANY sale's full invoice by
    // id (a plain cashier could read a colleague's — or a manager's — receipts).
    // Restrict to the sale's own cashier unless the caller can view all sales
    // (admin/manager/developer, or the sales.viewAll grant). Ownership is decided
    // by the VERIFIED JWT identity (req.user.username), never a client-supplied
    // claim.
    if (!(await _canViewAllSales(req.user)) && sale.username !== (req.user && req.user.username)) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'لا تملك صلاحية عرض فاتورة كاشير آخر' });
    }

    // ORDER BY id ASC: sales_items rows are inserted one per line, in cart
    // order, at checkout (see the `for (let lineIdx ...)` loop above) — this
    // is the only way to recover each row's original ordinal, which is also
    // its O2C source_line_id ('L' + lineIdx). No column records the ordinal
    // directly.
    const [items] = await db.query('SELECT * FROM sales_items WHERE order_id = ? ORDER BY id ASC', [req.params.orderId]);

    // ─── close2/pos-returns · ReturnRequestDialog contract ───
    // The returns flow needs each line's REAL ar_document_lines.id
    // (originalLineId) and the ar_documents.version (expectedVersion) —
    // ReturnRequestDialog.tsx has read these as `lineId`/`version` since it
    // was built, but this endpoint never actually supplied them, so every
    // real return request submitted lineId "0"/"1"/... (the array position)
    // and the server correctly rejected it with VALIDATION_ERROR "سطر أصلي
    // غير موجود". Degrades to no lineId/version (dialog falls back to the
    // position, which still fails server-side) for a pre-O2C-projection sale
    // or when O2C is disabled — never fatal to the receipt/reprint path this
    // endpoint also serves.
    let arDocVersion = null;
    const lineIdByOrdinal = {};
    try {
      const [arDocs] = await db.query(
        "SELECT id, version FROM ar_documents WHERE source_type='pos' AND source_id=? LIMIT 1",
        [req.params.orderId]);
      if (arDocs.length) {
        arDocVersion = arDocs[0].version;
        const [arLines] = await db.query(
          'SELECT id, source_line_id FROM ar_document_lines WHERE document_id=?', [arDocs[0].id]);
        arLines.forEach(l => {
          const m = /^L(\d+)$/.exec(l.source_line_id || '');
          if (m) lineIdByOrdinal[Number(m[1])] = l.id;
        });
      }
    } catch (e) {
      console.warn('[sales/invoice] ar_document_lines lookup failed for sale', req.params.orderId, '—', e.code || e.message);
    }

    // ── Cashier display name — resolved from the SALE's OWN username ──
    // The receipt shows "You were served by : <FullName>, <empNo>", so a
    // reprint pulled up by a DIFFERENT cashier must still name the person who
    // MADE the sale. `sales.username` (written at INSERT, ~:953/:956) is that
    // person; the name is resolved here at READ time because the sales table
    // has no name column (db/schema.sql:148-189).
    //
    // This used to read settings.user_meta ONLY, while the admin screen
    // (routes/auth.js:660) and the developer guard (lib/transactionGuards.js:130)
    // both read users.full_name FIRST. The moment the till started printing a
    // name from users.full_name, that split would have made the SAME sale print
    // two different names on its original and its reprint. lib/displayName.js
    // is now the single rule for all of them.
    //
    // empNo is OPTIONAL — it exists only in user_meta and is only printed when
    // explicitly set; falling back to username here would render "John Smith,
    // j.smith", which looks redundant. It stays '' so the receipt can hide it.
    const cashierIdentity = await displayName.resolveCashierIdentity(db, sale.username);
    const cashierName = cashierIdentity.name;
    const cashierEmpNo = cashierIdentity.empNo;

    // ── Lookup the branch: prefer the branch frozen on the sale, else the user's ──
    //
    // This used to read `shifts.branch_id` and then `user_branches`. NEITHER
    // EXISTS: `shifts` has no branch_id column and the `user_branches` table is
    // never created anywhere in the codebase. Both queries threw on every single
    // call and the bare `catch` swallowed it, so branchName/branchAddress were
    // silently ALWAYS empty and the receipt's whole branch block could never
    // render. The real mapping lives on `users` (branch_id / default_branch_id).
    let branchName = '', branchAddress = '', branchLat = null, branchLng = null;
    let branchCompanyName = '';  // V5.7.14 — operating company per branch
    try {
      // Prefer the branch stamped on the sale at checkout — a historical receipt
      // must not follow the cashier if they are later moved to another branch.
      let branchId = sale.branch_id || null;
      if (!branchId && sale.username) {
        const [ub] = await db.query(
          'SELECT branch_id, default_branch_id FROM users WHERE username = ? LIMIT 1', [sale.username]);
        if (ub.length) branchId = ub[0].branch_id || ub[0].default_branch_id || null;
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
    } catch (e) {
      // Do NOT swallow silently — that is exactly how this stayed broken. A
      // missing branch must be visible in the logs, not printed as a blank line.
      console.warn('[sales/invoice] branch lookup failed for sale', sale.id, '—', e.code || e.message);
    }

    // ── Pull company contact + branding from settings ──
    let companyName = 'Moroccan Taste', taxNumber = '', currency = 'SAR';
    let companyPhone = '', companyEmail = '', companyLogo = '', receiptFooter = '';
    try {
      const [setRows] = await db.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('CompanyName','TaxNumber','Currency','CompanyPhone','CompanyEmail','logo','receiptFooter')"
      );
      const map = {};
      setRows.forEach(r => { map[r.setting_key] = r.setting_value; });
      companyName  = map.CompanyName  || companyName;
      taxNumber    = map.TaxNumber    || '';
      currency     = map.Currency     || 'SAR';
      companyPhone = map.CompanyPhone || '';
      companyEmail = map.CompanyEmail || '';
      companyLogo  = map.logo         || '';
      // receiptFooter was write-only: the React admin saved it under a label
      // promising it prints on the invoice, and nothing anywhere read it.
      receiptFooter = map.receiptFooter || '';
    } catch (_) { /* settings table missing — ignore, defaults already set */ }

    // V5.7.26 — per-brand logo: if the sale has a brand_id, prefer THAT
    //   brand's logo over the company-wide one. So Burger Wagef sales
    //   print with the Burger Wagef logo, Hangerstation with theirs, etc.
    // The fallback here read `user_brands`, a table that is never created —
    // it threw on every call and was swallowed, so brandLogo was always ''.
    // `users.brand_id` is the real mapping.
    let brandLogo = '';
    let brandName = '';
    try {
      let brandId = sale.brand_id;
      if (!brandId && sale.username) {
        // Fallback: derive from the user's primary brand
        const [ub] = await db.query('SELECT brand_id FROM users WHERE username = ? LIMIT 1', [sale.username]);
        if (ub.length) brandId = ub[0].brand_id;
      }
      if (brandId) {
        const [br] = await db.query('SELECT name, logo FROM brands WHERE id = ?', [brandId]);
        if (br.length) {
          brandName = br[0].name || '';
          brandLogo = br[0].logo || '';
        }
      }
    } catch (e) {
      console.warn('[sales/invoice] brand lookup failed for sale', sale.id, '—', e.code || e.message);
    }

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

    // ─── v4 — the seller block this invoice was ISSUED under wins ───
    // Everything resolved above is the LIVE identity. For any sale carrying a
    // snapshot we replace it wholesale: a receipt reprinted next year must show
    // the company name, tax number, CR and logo that were on it the day it was
    // issued — not today's — because the ZATCA QR is built from these values.
    // Invoices predating the migration have no snapshot and keep the live
    // resolution, so old receipts print exactly as they did before.
    let crNumber = '', nationalAddress = '', receiptHeader = '', receiptThankYou = '', receiptReturnPolicy = '';
    let identitySource = 'live';
    const snap = await invoiceIdentity.loadIdentity(db, sale.receipt_identity_id);
    if (snap) {
      identitySource = 'snapshot';
      companyName   = snap.sellerName   || companyName;
      taxNumber     = snap.taxNumber    || taxNumber;
      currency      = snap.currency     || currency;
      companyPhone  = snap.phone        || companyPhone;
      companyEmail  = snap.email        || companyEmail;
      companyLogo   = snap.logo         || companyLogo;
      receiptFooter = snap.footer       || receiptFooter;
      brandName     = snap.brandName    || brandName;
      branchName    = snap.branchName   || branchName;
      branchAddress = snap.address      || branchAddress;
      crNumber            = snap.crNumber       || '';
      nationalAddress     = snap.nationalAddress || '';
      receiptHeader       = snap.header         || '';
      receiptThankYou     = snap.thankYou       || '';
      receiptReturnPolicy = snap.returnPolicy   || '';
    }

    // RECORDED per-category tax breakdown — parsed ONCE and reused for both the
    // QR-rebuild fallback (below) and the new `taxSubtotals` response field.
    const recordedTaxSubtotals = parseTaxSubtotals(sale.tax_subtotals_json);

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
      items: items.map((i, idx) => ({
        name: i.item_name, qty: i.qty, price: Number(i.price), total: Number(i.total),
        lineId: lineIdByOrdinal[idx] ?? null,
      })),
      // O2C document version — required by ReturnRequestDialog as
      // expectedVersion (optimistic-concurrency guard on the return create).
      version: arDocVersion,
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
      receiptFooter: receiptFooter,
      // v4 — fields the receipt never had a source for. crNumber lived on
      // companies.cr_number and was never printed; the rest did not exist.
      crNumber: crNumber,
      nationalAddress: nationalAddress,
      receiptHeader: receiptHeader,
      receiptThankYou: receiptThankYou,
      receiptReturnPolicy: receiptReturnPolicy,
      // 'snapshot' = frozen at issue; 'live' = pre-migration sale resolved now.
      identitySource: identitySource,
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
      // The RECORDED per-category tax breakdown ({net, vat, byCategory}) or null
      // for a pre-migration / corrupt sale. Feeds any client that itemizes VAT
      // by category on the printed invoice; null means the breakdown is honestly
      // unavailable, never zero.
      taxSubtotals: recordedTaxSubtotals,
      // v6.15 — the QR for reprints. Preferred source is the STORED TLV: byte for
      // byte what the customer's first receipt carried. Sales stamped before the
      // column existed get a deterministic server-side rebuild from the sale's
      // RECORDED values — VAT from tax_subtotals_json (the recorded per-category
      // amounts), never total/1.15, and never a client-side derivation: the legacy
      // template re-derived the TLV in the browser and pulled its QR library from
      // a CDN, which fails exactly where this POS must work — offline.
      zatcaQr: await (async () => {
        let tlv = sale.zatca_qr_base64 || null;
        if (!tlv && taxNumber) {
          // A corrupt/absent subtotal blob means the VAT is indeterminable — a
          // rebuilt QR must carry the sale's numbers, so in that case there is
          // honestly no QR rather than one asserting a guessed VAT.
          const vat = recordedTaxSubtotals ? recordedTaxSubtotals.vat : null;
          if (vat != null) {
            tlv = zatca.buildZatcaQR({
              sellerName: companyName, sellerVat: taxNumber,
              timestamp: new Date(sale.order_date).toISOString(),
              total: Number(sale.total_final) || 0, vatAmount: vat,
            });
          }
        }
        return tlv ? { qrBase64: tlv, qrDataUrl: await zatcaQrDataUrl(tlv), stored: !!sale.zatca_qr_base64 } : null;
      })(),
      // v6.11.0 — Human-readable identifiers for printable receipts
      invoiceNumber: sale.invoice_number || null,
      voidSerial: sale.void_serial || null,
      returnSerial: sale.return_serial || null
    });
  } catch (e) {
    // G-SALES error honesty — `null` made a DB failure indistinguishable from
    // "invoice not found" on the printed-receipt path. Surface it as a 500.
    console.error('[GET /sales/invoice/:orderId]', e.message);
    res.status(500).json({ success: false, error: 'تعذّر تحميل الفاتورة', code: 'invoice_load_failed' });
  }
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
      const [stockRestore] = await c.query(
        'UPDATE warehouse_stock SET qty = qty + ?, last_updated = ? WHERE warehouse_id = ? AND item_id = ?',
        [Number(m.qty) || 0, now, m.warehouse_id, m.item_id]);
      if (stockRestore.affectedRows !== 1) {
        const e = new Error('warehouse stock row missing during sale reversal');
        e.code = 'INVENTORY_RESTORE_FAILED'; e.status = 409; throw e;
      }
    } else {
      // Legacy path: deduction happened against inv_items.stock directly
      const [stockRestore] = await c.query('UPDATE inv_items SET stock = stock + ? WHERE id = ?',
        [Number(m.qty) || 0, m.item_id]);
      if (stockRestore.affectedRows !== 1) {
        const e = new Error('inventory item missing during sale reversal');
        e.code = 'INVENTORY_RESTORE_FAILED'; e.status = 409; throw e;
      }
    }

    // 2b. Write a reversing movement so the warehouse ledger is honest
    const reverseId = 'MOV-VOID-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
    await c.query(
      `INSERT INTO inventory_movements
        (id, movement_date, item_id, item_name, type, qty, reason, username, notes, warehouse_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [reverseId, now, m.item_id, m.item_name, 'in', Number(m.qty) || 0,
       'عكس بيع', username || 'system',
       'void of ' + orderId + ' (mov ' + m.id + ')',
       m.warehouse_id || null]);

    restored.push({
      itemId: m.item_id, itemName: m.item_name,
      qty: Number(m.qty) || 0, warehouseId: m.warehouse_id || null
    });
  }

  // 3. Recompute global stock for each affected item once
  const itemIds = Array.from(new Set(movs.map(m => m.item_id))).filter(Boolean);
  for (const id of itemIds) {
    await recomputeInvItemStock(c, id);
  }

  // 4. Reconcile the deferred posting state before touching the GL.
  // A sale that has not reached a batch has no journal to reverse: cancel its
  // immutable queue snapshot. Once a SalesBatch is posted, an invoice-level
  // hard reversal would destroy the batch's audit trail, so require the O2C
  // credit-note workflow instead.
  let postingState = null;
  try {
    const [queued] = await c.query(
      "SELECT id, status, batch_id FROM sales_posting_queue WHERE source_type='sale' AND source_id=? FOR UPDATE",
      [orderId]);
    postingState = queued[0] || null;
    if (postingState && ['posting', 'posted', 'stranded'].includes(String(postingState.status))) {
      const err = new Error('Sale belongs to a posted/in-flight sales batch — issue an O2C Credit Note');
      err.code = 'SALES_BATCH_REQUIRES_CREDIT_NOTE'; err.status = 409; throw err;
    }
    if (postingState && ['pending', 'failed'].includes(String(postingState.status))) {
      await c.query(
        "UPDATE sales_posting_queue SET status='cancelled', last_error=NULL WHERE id=?",
        [postingState.id]);
    }
  } catch (queueErr) {
    if (!queueErr || queueErr.code !== 'ER_NO_SUCH_TABLE') throw queueErr;
    postingState = null; // pre-sales-posting deployment: use legacy journals
  }

  // 5. Reverse only a historical per-invoice GL journal. New pending sales
  // intentionally have none; posted_legacy/no-queue rows retain rollback
  // compatibility with the old accounting path.
  //
  // BOTH reference types, and that is the fix: a sale on a delivery channel
  // posts a SECOND journal — Dr 5500 commission / Cr 2320 payable to the
  // platform — under referenceType 'ChannelCommission' (see the posting site
  // in this file). This query used to name only 'Sale', so voiding an
  // Uber/HungerStation order removed the revenue, VAT and COGS and left the
  // commission journal standing: a permanent expense and a permanent payable
  // for an order that no longer exists. Nothing pointed at it afterwards — the
  // sale row could even be hard-deleted underneath it — so it was unreachable
  // for anyone trying to clean it up by hand.
  let reversedGl = false;
  try {
    const shouldReverseLegacyGl = !postingState || postingState.status === 'posted_legacy';
    if (!shouldReverseLegacyGl) {
      reversedGl = false;
    } else {
    const [journals] = await c.query(
      'SELECT id FROM gl_journals WHERE reference_type IN (?, ?) AND reference_id = ?',
      ['Sale', 'ChannelCommission', orderId]);
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
    }
  } catch (glErr) {
    // v7.5 — ONLY a missing-GL-tables deploy is non-fatal. Anything else
    // (lock timeout, constraint failure) must abort the void: otherwise it
    // commits with stock restored but the GL journal left standing.
    if (!glErr || glErr.code !== 'ER_NO_SUCH_TABLE') throw glErr;
  }

  // 6. Optionally hard-delete the sale row + lines
  let deletedSale = false;
  if (opts.deleteSale) {
    await c.query('DELETE FROM sales_items WHERE order_id = ?', [orderId]);
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
const _APPROVAL_PRIVILEGED = ['admin', 'manager'];

// W0-A — the CREDENTIAL half of the approval gate, factored out of
// _requireManagerApproval unchanged (same lookup, same constant-time bcrypt
// against the dummy pad, same single generic error) so the ELEVATION path
// below can reuse the EXACT verification instead of a second copy of it.
// Resolves to { username, role } or throws a 403.
async function _verifyApproverCredentials(req) {
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
  if (!mgr || _APPROVAL_PRIVILEGED.indexOf(mgrRole) === -1 || !okPw) {
    const err = new Error('بيانات اعتماد المدير غير صحيحة · Invalid manager approval credentials');
    err.status = 403; err.code = 'approval_invalid'; throw err;
  }
  return { username: mgr.username, role: mgrRole };
}

async function _requireManagerApproval(req, action) {
  // Optional opt-out (VOID only): owners can let cashiers cancel without a
  // manager via settings.RequireManagerApprovalForVoid='0'. Returns stay gated
  // (more sensitive — money out). Absent/'1' → enforce (preserves prior behavior).
  if (action === 'void') {
    try {
      const [s] = await db.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'RequireManagerApprovalForVoid' LIMIT 1");
      // Tolerant read: a === '0' comparison ignored the "false" the React admin
      // wrote, so this failed CLOSED — approval stayed enforced after the owner
      // switched it off. Absent/unparseable still enforces (safe default).
      if (s.length && !isTruthy(s[0].setting_value)) return null; // approval disabled
    } catch (_) { /* settings missing → fall through to enforce */ }
  }
  const actorRole = String((req.user && req.user.role) || '').toLowerCase();
  if (_APPROVAL_PRIVILEGED.indexOf(actorRole) !== -1) return null; // already authorized
  const mgr = await _verifyApproverCredentials(req);
  return mgr.username; // approved — return the approver for audit if needed
}

// ─── W0-A — refund authority for the legacy void / return paths ───────────
// THE DEFECT: both routes were mounted `requireCapability('pos.refund')`, so
// the middleware answered 403 BEFORE the handler could read approverUsername /
// approverPassword. Role `cashier` is deliberately NOT granted pos.refund
// (server.js cashier grant list), so the manager-approval dialog the POS shows
// could never succeed — the cashier typed valid manager credentials and still
// got PERMISSION_DENIED, forever.
//
// OWNER DECISION: the cashier KEEPS no pos.refund. The elevation is what has to
// work. So authority is now asserted IN-HANDLER, in this order:
//   1. caller holds pos.refund  → proceeds exactly as before (the historical
//      _requireManagerApproval second factor still runs, privileged roles still
//      short-circuit it, RequireManagerApprovalForVoid='0' still opts VOID out);
//   2. caller does NOT hold it  → may proceed ONLY when THIS request carries
//      manager credentials that verify server-side AND that manager holds
//      pos.refund himself.
// The RequireManagerApprovalForVoid opt-out is deliberately NOT honored on
// path 2: it relaxes the SECOND factor for an account that is already
// authorized — it can never hand the refund right to an account that is not.
// Nothing else is relaxed: the ZATCA-submitted refusal, the period-close guard
// and middleware/o2cLegacyGate all still run, untouched, after this.
// Returns the approving manager's username (for the audit trail) or null when
// the caller acted on their own authority.
const REFUND_CAP = 'pos.refund';
async function _assertRefundAuthority(req, action) {
  if (!req.user || !req.user.username) {
    const err = new Error('مطلوب تسجيل الدخول');
    err.status = 401; err.code = 'PERMISSION_DENIED'; throw err;
  }
  let selfOk = false;
  try { selfOk = await hasCapability(req.user, REFUND_CAP); }
  catch (_) { selfOk = false; } // fail closed, same as the middleware
  if (selfOk) return await _requireManagerApproval(req, action);

  const approver = await _verifyApproverCredentials(req);
  let approverOk = false;
  try { approverOk = await hasCapability({ username: approver.username, role: approver.role }, REFUND_CAP); }
  catch (_) { approverOk = false; } // fail closed
  if (!approverOk) {
    const err = new Error('المدير المعتمد لا يملك صلاحية الاسترداد · The approving manager does not hold the refund capability');
    err.status = 403; err.code = 'approval_forbidden'; throw err;
  }
  return approver.username;
}

// Post-commit audit row naming the manager who authorized a reversal the actor
// could not perform alone. Written to `audit_logs` (the entity_type/entity_id/
// details table — NOT the login-oriented `audit_log`, whose columns are
// user_id/table_name/record_id). Never blocks the operation (the money movement
// is already committed) but a failure is LOUD, never silently swallowed.
async function _auditApproval(action, orderId, actor, approvedBy, req) {
  if (!approvedBy) return;
  try {
    await db.query(
      'INSERT INTO audit_logs (action, entity_type, entity_id, user_username, details, ip_address, created_at) VALUES (?,?,?,?,?,?,NOW())',
      ['sale_' + action + '_approved', 'sale', orderId, actor || 'system',
       JSON.stringify({ action, approvedBy, actor: actor || null }), (req && req.ip) || '']);
  } catch (e) {
    console.error('[sales] approval audit row failed for ' + orderId + ':', e.message);
  }
}

// POST /sales/:orderId/void — reverse stock + GL but KEEP the sale row.
// This is the recommended path when you need an audit trail (the sale
// remains visible in reports as voided). Use ?delete=1 to also drop the row.
// G-SALES — void reverses money + stock, so it needs `pos.refund`
// (manager-level; cashier does NOT hold it).
// W0-A — that capability is asserted IN-HANDLER by _assertRefundAuthority, NOT
// by a `requireCapability('pos.refund')` middleware: the middleware answered
// 403 before the handler could read the manager credentials, which made the
// cashier's approval dialog unwinnable. Same authority, plus a working
// manager-elevation path. o2c saleReverseGate still covers the flag-on path.
router.post('/:orderId/void', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    // G-SALES — spoofable req.body.username fallback deleted; the authority
    // assertion below guarantees req.user.
    const username = req.user && req.user.username;
    const wantDelete = req.query.delete === '1';
    // v7.3 — gate: cashiers (and any non-privileged role) need manager approval.
    // Honors settings.RequireManagerApprovalForVoid='0' to skip (void only).
    // W0-A — returns the approving manager (null when the caller was already
    // authorized on their own); recorded in the audit trail below.
    const approvedBy = await _assertRefundAuthority(req, 'void');

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

        // W0-A — the approving manager is part of the void's story: a voided
        // sale that survives in reports must say WHO authorized it. Written on
        // the surviving row, inside the same transaction as the reversal.
        if (approvedBy) {
          try {
            await conn.query(
              "UPDATE sales SET payment_notes = CONCAT(COALESCE(payment_notes,''), " +
              "CASE WHEN payment_notes IS NULL OR payment_notes = '' THEN '' ELSE '\n' END, ?) " +
              "WHERE id = ?",
              ['VOID_APPROVED_BY ' + approvedBy, orderId]);
          } catch (e) { console.warn('[POST /sales/:id/void] approval note failed:', e.message); }
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
        // W0-A — surface the code here too (the OUTER catch always did). The
        // POS has to tell 'invoice_immutable' apart from 'approval_invalid',
        // or an approval dialog re-prompts for credentials that can never help.
        code: txErr.code || undefined,
        zatcaType: txErr.zatcaType || undefined
      });
    }

    // Unified Sales Analytics — re-project so the sale's fact row flips to
    // 'voided' (a deleted sale row is skipped inside projectPosSale).
    // Post-commit, non-fatal (mirrors the zatca enqueue pattern).
    try { analyticsProjection.safeProject(db, 'sale', orderId, () => analyticsProjection.projectPosSale(db, orderId)); } catch (_) {}

    // W0-A — name the approving manager in audit_log (post-commit, non-fatal).
    await _auditApproval('void', orderId, username, approvedBy, req);

    res.json({
      success: true, orderId,
      ...result,
      approvedBy: approvedBy || null,
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
// G-SALES — returns are money-out: they require the `pos.refund` capability.
// W0-A — asserted IN-HANDLER for exactly the reason documented on /void above:
// as a mounted middleware it 403'd the cashier before the manager credentials
// could be read, so the approval path was unreachable. Returns are ALWAYS
// gated (money out) — the void-only settings opt-out never applied here.
router.post('/:orderId/return', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    // G-SALES — spoofable req.body.username fallback deleted.
    const username = req.user && req.user.username;
    const reason   = (req.body && String(req.body.reason || '').trim()) || 'customer return';
    const reasonCode = (req.body && String(req.body.reasonCode || '').trim()) || 'goods_returned';
    // v7.3 — gate: cashiers (and any non-privileged role) need manager approval.
    // W0-A — returns the approving manager (null when the caller was already
    // authorized on their own); recorded in the audit trail below.
    const approvedBy = await _assertRefundAuthority(req, 'return');

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
      // W0-A — when the actor could not refund alone, the approving manager's
      // username rides on the SAME note, so the credit note's paper trail names
      // who authorized the money going out.
      try {
        await conn.query(
          "UPDATE sales SET payment_notes = CONCAT(COALESCE(payment_notes,''), " +
          "CASE WHEN payment_notes IS NULL OR payment_notes = '' THEN '' ELSE '\n' END, ?) " +
          "WHERE id = ?",
          ['CREDIT_NOTE ' + cnId + ': ' + reason +
           (approvedBy ? ' (RETURN_APPROVED_BY ' + approvedBy + ')' : ''), sale.id]
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
        code: txErr.code || undefined,   // W0-A — see the /void note above
        zatcaType: txErr.zatcaType || undefined
      });
    }

    // v6.1.0 Wave E.6 — enqueue the new credit_note for ZATCA submission
    try { if (result && result.creditNoteId) zatcaWorker.enqueue('credit_note', result.creditNoteId); } catch (_) {}

    // Unified Sales Analytics — project the credit note (refund facts attribute
    // to the CN's business day; the original sale's fact flips to 'returned').
    // Post-commit, non-fatal (mirrors the zatca enqueue above).
    try { if (result && result.creditNoteId) analyticsProjection.safeProject(db, 'credit_note', result.creditNoteId, () => analyticsProjection.projectReturn(db, { creditNoteId: result.creditNoteId, saleId: orderId })); } catch (_) {}

    // W0-A — name the approving manager in audit_log (post-commit, non-fatal).
    await _auditApproval('return', orderId, username, approvedBy, req);

    res.json({ success: true, orderId, reason, ...result, approvedBy: approvedBy || null });
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
// G-SALES — destructive: `sales.delete` (sensitive; live grant = admin only).
router.delete('/:orderId', requireCapability('sales.delete'), async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const username = req.user.username;
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
      return res.status(409).json({
        success: false,
        code: 'FORCE_DELETE_RETIRED',
        error: 'الحذف القسري غير متاح؛ استخدم الإلغاء أو إشعارًا دائنًا للحفاظ على المخزون والحسابات.',
      });
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
// G-SALES — destructive: `sales.delete` (sensitive; live grant = admin only).
router.post('/bulk-delete', requireCapability('sales.delete'), async (req, res) => {
  try {
    const { ids, force } = req.body || {};
    if (!ids || !ids.length) return res.status(400).json({ success: false, error: 'No IDs' });
    const username = req.user.username;

    if (force) {
      return res.status(409).json({
        success: false,
        code: 'FORCE_DELETE_RETIRED',
        error: 'الحذف القسري الجماعي غير متاح؛ كل فاتورة تحتاج إلغاءً أو إشعارًا دائنًا محكومًا.',
      });
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

// ── RETIRED: the GET report/advanced endpoint (التقارير المتطورة) ───────────
// Deleted per the rationalization doc §3.3 — zero frontend/e2e/test consumers
// (grep-zero evidence in §5.3), no requireCapability on the path, legacy
// VAT/discount math. The Sales Analytics Hub (/reports/sales/* over
// POST /api/analytics/query) is the replacement. 404 asserted in
// tests/integration/retiredSurfaces.api.test.js.

module.exports = router;
