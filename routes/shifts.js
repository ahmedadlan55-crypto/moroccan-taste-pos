const router = require('express').Router();
const db = require('../db/connection');
// G-SALES hardening — capability guard (pattern: routes/order-to-cash/returns.js)
// + hasCapability for the owner-or-manager report check. jsonwebtoken is needed
// because /:shiftId/full-report-print historically bypassed the global JWT gate
// (server.js exemption), so this route verifies the Bearer token itself.
const requireCapability = require('../middleware/requireCapability');
const { hasCapability } = require('../middleware/requireCapability');
const jwt = require('jsonwebtoken');
// W2-A — till cash movements (pay-in / pay-out) need the approver-credential
// check (bcrypt) and the shared GL poster, exactly like the cash-voucher
// approval in routes/cash.js they reuse the storage of.
const bcrypt = require('bcryptjs');
const glPosting = require('../lib/glPosting');
// The ONE authority for "what is this person called". The X/Z shift report
// names the cashier on paper exactly like the sale receipt does, so it must
// resolve that name by the same rule (users.full_name → settings.user_meta →
// username) or the same person prints under two different names on two
// documents from the same till.
const displayName = require('../lib/displayName');
// Unified Sales Analytics — post-commit till-movement projection (non-fatal;
// absence of the module never blocks a shift open/close).
let analyticsProjection;
try { analyticsProjection = require('../services/analytics/ProjectionService'); }
catch (_) { analyticsProjection = { safeProject: async () => {}, projectTillMovement: async () => {} }; }

// Resolve the authenticated user for routes that may be exempt from the global
// JWT gate: prefer req.user (set by server.js), else verify the standard
// Authorization header locally. Returns null when no valid token is present.
function _userFromRequest(req) {
  if (req.user && req.user.username) return req.user;
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) {
    try { return jwt.verify(h.slice(7), process.env.JWT_SECRET); } catch (_) { /* invalid/expired token → unauthenticated */ }
  }
  return null;
}

// ── Additive schema ensure (idempotent, INFORMATION_SCHEMA-guarded) ──────────
// Pattern: routes/pos-v2.js `_ensureSchema` — shifts.branch_id is a NEW
// branch-level snapshot (populated at OPEN time, see POST /open below) that
// lets GET / brand-scope supervisors' shift listings. Reference SQL lives in
// db/migrations/0014_brand_branch_scope.sql; this ensure keeps the router
// self-sufficient until that (or the server.js wiring stage) lands.
let _shiftsSchemaEnsured = false;
async function _ensureShiftsSchema() {
  if (_shiftsSchemaEnsured) return;
  const [col] = await db.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shifts' AND COLUMN_NAME = 'branch_id'");
  if (!col.length) {
    await db.query('ALTER TABLE shifts ADD COLUMN branch_id VARCHAR(50) NULL');
    console.log('[shifts] added shifts.branch_id');
  }
  // W2-A — the shift↔voucher linkage this router's /movements endpoints write.
  // The authoritative migration is in server.js (addColumnIfMissing +
  // addIndexIfMissing next to the other cash-voucher columns); this mirrors it
  // for the same reason shifts.branch_id is mirrored above — the router stays
  // self-sufficient on a database that has not been through that boot path yet
  // (an integration test that mounts the router, a partially migrated replica).
  // Both are INFORMATION_SCHEMA-guarded and additive, so whichever runs first
  // wins and the other is a no-op.
  for (const [table, idx] of [['cash_receipts', 'idx_cr_shift'], ['cash_payments', 'idx_cp_shift']]) {
    try {
      const [c] = await db.query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'shift_id'", [table]);
      if (!c.length) {
        await db.query(`ALTER TABLE ${table} ADD COLUMN shift_id VARCHAR(50) NULL`);
        console.log(`[shifts] added ${table}.shift_id`);
      }
      const [i] = await db.query(
        'SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [table, idx]);
      if (!i.length) await db.query(`ALTER TABLE ${table} ADD INDEX ${idx} (shift_id)`);
    } catch (e) {
      // A missing cash_* table on a POS-only install must not stop shifts from
      // working — the /movements routes answer a clear error instead.
      console.warn(`[shifts] ${table}.shift_id ensure skipped:`, e.message);
    }
  }
  _shiftsSchemaEnsured = true;
}
_ensureShiftsSchema().catch((e) => console.error('[shifts] schema ensure at init failed (will retry on first request):', e.message));
router.use(async (req, res, next) => {
  if (_shiftsSchemaEnsured) return next();
  try { await _ensureShiftsSchema(); } catch (e) { console.error('[shifts] schema ensure failed:', e.message); }
  next();
});

// Brand/branch scope fix (bilingual-i18n-images, Owner A) — GET / authz.
// Non-supervisors are ALWAYS self-scoped (username=self, no capability gate —
// mirrors GET /api/pos/v2/orders). Supervisors default to their own resolved
// BRAND (shifts are branch-level, but scoping is still by brand, same as
// routes/pos-v2.js), with the same ?brandId=/?allBranches=1 bypass gated on
// the SAME capability introduced there.
const SHIFTS_BRAND_SCOPE_CAP = 'pos.catalog.viewAllBrands';
function _isSupervisor(user) {
  return ['admin', 'manager'].includes(String((user && user.role) || '').toLowerCase()) || !!(user && user.isDeveloper);
}
// Resolve a user's BRAND: users.brand_id directly if set, else the brand of
// COALESCE(users.branch_id, users.default_branch_id) via branches.brand_id.
async function _userBrandId(username) {
  if (!username) return null;
  const [u] = await db.query('SELECT brand_id, branch_id, default_branch_id FROM users WHERE username = ? LIMIT 1', [username]);
  if (!u.length) return null;
  if (u[0].brand_id) return u[0].brand_id;
  const branchId = u[0].branch_id || u[0].default_branch_id || null;
  if (!branchId) return null;
  const [b] = await db.query('SELECT brand_id FROM branches WHERE id = ? LIMIT 1', [branchId]);
  return b.length ? (b[0].brand_id || null) : null;
}
async function _resolveShiftBrandScope(req) {
  const rawBrandId = req.query && req.query.brandId != null ? String(req.query.brandId).trim() : '';
  const wantsAll = /^(1|true|on|yes)$/i.test(String((req.query && req.query.allBranches) || '').trim());
  if (rawBrandId || wantsAll) {
    let ok = false;
    try { ok = await hasCapability(req.user, SHIFTS_BRAND_SCOPE_CAP); } catch (_) { ok = false; }
    if (ok) {
      return rawBrandId ? { brandId: rawBrandId.slice(0, 50), allBrands: false } : { brandId: null, allBrands: true };
    }
    // No capability → bypass params ignored; fall through to default scope.
  }
  const brandId = await _userBrandId(req.user && req.user.username);
  if (brandId == null) {
    // Same rule as routes/pos-v2.js's _resolveBrandScope: no resolvable
    // brand -> don't restrict, never regress to an empty list for an
    // untagged supervisor account.
    return { brandId: null, allBrands: true };
  }
  return { brandId, allBrands: false };
}

// Shift reports are financial documents: only the shift OWNER (the cashier who
// ran it) or a holder of the manager-level `sales.reports.view` capability
// (admin/developer bypass inside hasCapability) may read them.
async function _canViewShiftReport(user, shiftUsername) {
  if (!user || !user.username) return false;
  if (shiftUsername && user.username === shiftUsername) return true;
  try { return await hasCapability(user, 'sales.reports.view'); }
  catch (_) { return false; /* fail closed */ }
}

// ═══════════════════════════════════════════════════════════════════
// V5.7.17 — Shared payment-aggregation helper used by ALL shift
//   endpoints (close-v3, closing-data, closing-data-v3, the new
//   thermal report). Centralizing this guarantees the SAME
//   computation everywhere — the variance you see in the UI is the
//   variance saved to DB and shown on the printed receipt.
//
//   Returns: {
//     methods: [{ id, name, nameAr, icon, color, groupType, expectedAmount, count }],
//     expectedById: { [methodId]: amount },
//     expectedTotal: number,
//     unmatchedTotal: number,
//     unmatchedDetails: [{ raw, normalized, amount }],
//     soldItems: [{ name, qty, price, total }],
//     orderCount: number
//   }
// ═══════════════════════════════════════════════════════════════════
function _normPM(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
}
const _ELECTRONIC_ALIASES = ['mada','visa','master','mastercard','amex','network','شبكة','مدى','مدي','بطاقة'];
const _CASH_ALIASES = ['cash','نقد','كاش','نقدي'];
const _KITA_ALIASES = ['kita','كيتا','آجل','ajl','اجل'];

// ── W0-A — ONE halala-safe reader for the `sales.payment_method` split string ──
// routes/sales.js writes split sales as "<method>:<amount>/<method>:<amount>"
// and used to round each leg to a whole SAR, so 50.40 + 30.10 was stored as
// "كاش:50/شبكة:30" and every shift screen reported an expected 80 against a
// total_final of 80.50 — an unexplainable 0.50 variance on the cashier's
// drawer. The writer now emits 2 decimals; this reader is the parsing half:
//   • parseFloat, not an integer read, so 50.40 comes back as 50.40;
//   • BARE-INTEGER TOLERANT — every row already in the database ("كاش:50")
//     parses to exactly the same number it always did;
//   • the method name is everything before the LAST ':' (a name may legally
//     contain one; the amount never does);
//   • requires BOTH '/' and ':' — the V5.7.14 rule that keeps a method NAMED
//     "مدى/شبكة" from being misparsed as two legs.
// Returns null when the string is not split-shaped (caller credits the single
// method with total_final), else [{ method, amount }] with 2-decimal amounts.
function _parseSplitLegs(raw) {
  const s = String(raw == null ? '' : raw);
  if (s.indexOf('/') < 0 || s.indexOf(':') < 0) return null;
  const legs = [];
  for (const part of s.split('/')) {
    const i = part.lastIndexOf(':');
    if (i < 0) continue;
    legs.push({ method: part.slice(0, i), amount: _r2(part.slice(i + 1)) });
  }
  return legs.length ? legs : null;
}
// Halala rounding — kills the binary-float dust that accumulating decimal legs
// leaves behind (50.4 + 30.1 must be 80.5, never 80.50000000000001).
function _r2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// openingFloat (default 0) is the REAL cash the drawer started with. It is
// folded into the CASH method's expected figure below so the physical count
// (which contains that same float) reconciles to zero. Callers MUST pass the
// value from the shifts row — never a client-supplied number.
async function aggregateShiftPayments(shiftId, openingFloat = 0) {
  // 1. Pull all active payment methods (with backward-compat fallback)
  let methods = [];
  try {
    const [rows] = await db.query(
      "SELECT id, name, name_ar, icon, color, group_type, sort_order FROM payment_methods " +
      "WHERE is_active = 1 AND show_in_shift_close != 0 ORDER BY sort_order, name"
    );
    methods = rows;
  } catch (_) {
    // Deliberate schema back-compat: legacy DBs lack show_in_shift_close.
    try {
      const [rows] = await db.query(
        "SELECT id, name, name_ar FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, name"
      );
      methods = rows;
    } catch (e2) {
      // No payment_methods table at all — synthetic methods below keep the
      // aggregation honest, but say so in the log instead of hiding it.
      console.error('[aggregateShiftPayments] payment_methods unavailable:', e2.message);
      methods = [];
    }
  }

  // 2. Build exact + alias lookup tables
  const exactLookup = {};
  const aliasLookup = {};
  function indexExact(m) {
    [_normPM(m.name), _normPM(m.name_ar), String(m.id)].forEach(k => {
      if (k && !exactLookup[k]) exactLookup[k] = m;
    });
    String(m.name_ar || '').split(/[\/،\-,]/).forEach(p => {
      const k = _normPM(p);
      if (k && !exactLookup[k]) exactLookup[k] = m;
    });
  }
  function indexAlias(m) {
    let aliases = [];
    const gt = m.group_type;
    if (gt === 'electronic' || gt === 'card') aliases = _ELECTRONIC_ALIASES;
    else if (gt === 'cash' || _normPM(m.name) === 'cash') aliases = _CASH_ALIASES;
    else if (gt === 'voucher' || _normPM(m.name) === 'kita') aliases = _KITA_ALIASES;
    aliases.map(_normPM).forEach(k => {
      if (k && !exactLookup[k] && !aliasLookup[k]) aliasLookup[k] = m;
    });
  }
  methods.forEach(indexExact);
  methods.forEach(indexAlias);
  // Synthetic fallbacks for fresh DBs where methods table is empty
  function ensureSynth(syntheticId, name, name_ar, group_type) {
    const aliasKey = _normPM(name);
    if (exactLookup[aliasKey] || aliasLookup[aliasKey]) return;
    const synth = { id: syntheticId, name, name_ar, group_type, _synthetic: true };
    methods.push(synth);
    indexExact(synth);
    indexAlias(synth);
  }
  ensureSynth('_cash',       'Cash',       'نقدي / كاش', 'cash');
  ensureSynth('_electronic', 'Card / Mada','شبكة / مدى', 'electronic');
  ensureSynth('_kita',       'Kita',       'كيتا / آجل', 'voucher');

  // 3. Pull sales for this shift + aggregate per method.id
  // v6.11.0 — Exclude voided + credit-note rows so the shift's expected total
  // matches what the cashier actually collected. Without this filter, a void
  // would still count toward "expected cash" and the shift would never
  // balance unless the cashier returned the money — which they didn't.
  const [sales] = await db.query(
    "SELECT id, payment_method, total_final, kita_service_fee FROM sales " +
    "WHERE shift_id = ? AND (zatca_type IS NULL OR zatca_type NOT IN ('cancellation','credit_note'))",
    [shiftId]
  );
  const expectedById = {};
  const countById    = {};
  let expectedTotal  = 0;
  let unmatchedTotal = 0;
  const unmatchedDetails = [];
  function credit(rawMethod, amount) {
    const key = _normPM(rawMethod);
    const m = exactLookup[key] || aliasLookup[key];
    if (m) {
      expectedById[m.id] = _r2((expectedById[m.id] || 0) + amount);
      countById[m.id]    = (countById[m.id]    || 0) + 1;
    } else {
      unmatchedTotal = _r2(unmatchedTotal + amount);
      unmatchedDetails.push({ raw: rawMethod, normalized: key, amount });
    }
    expectedTotal = _r2(expectedTotal + amount);
  }
  for (const sale of sales) {
    const total = _r2(sale.total_final);
    const pmRaw = sale.payment_method || 'cash';
    // W0-A — decimal-safe leg read (see _parseSplitLegs). Old bare-integer
    // rows parse exactly as before; a 50.40/30.10 split now sums to 80.50.
    const legs = _parseSplitLegs(pmRaw);
    if (legs) {
      for (const leg of legs) credit(leg.method, leg.amount);
    } else {
      credit(pmRaw, total);
    }
  }

  // 3b. Fold the opening float AND the approved till movements into the CASH
  //   method's EXPECTED figure. Done AFTER sales aggregation and BEFORE the
  //   filter/map below so a float-only (zero-sales) shift still surfaces a
  //   nonzero expected-cash row rather than being dropped as an empty synthetic
  //   method. The float is real cash that started in the drawer — the physical
  //   count already contains it, so this is what makes a float-only shift
  //   reconcile to zero variance.
  //
  //   W2-A — the same is true of a pay-in / pay-out. lib/analytics/equations.js
  //   already defines the identity the analytics side uses:
  //       expectedCash = openFloat + cashSales − cashReturns + payIns − payOuts
  //   Until now the shift screens implemented only the first two terms, so a
  //   drop to the safe or a float top-up made the drawer disagree with the
  //   screen by exactly that amount, every time, with no adjustment path. The
  //   net adjustment below is that missing ± term. When there are no movements
  //   it collapses to the historical `openingFloat` fold, byte for byte.
  const _openingFloat = Number(openingFloat) || 0;
  const mv = await _shiftMovementTotals(shiftId);
  const _cashAdjustment = _r2(_openingFloat + mv.payIn - mv.payOut);
  if (_cashAdjustment !== 0) {
    const cashMethod = methods.find(
      (m) => String(m.group_type || '').toLowerCase() === 'cash' || _normPM(m.name) === 'cash',
    );
    if (cashMethod) {
      expectedById[cashMethod.id] = _r2((expectedById[cashMethod.id] || 0) + _cashAdjustment);
      expectedTotal = _r2(expectedTotal + _cashAdjustment);
    } else {
      // No cash-group method at all — the adjustment has nowhere to land and
      // the drawer WILL disagree. Never silent about money.
      console.error('[aggregateShiftPayments] no cash-group payment method — opening float + till movements (' +
        _cashAdjustment + ') could not be folded into expected cash for shift ' + shiftId);
    }
  }

  // 4. Aggregate sold items
  let soldItems = [];
  try {
    const [items] = await db.query(
      'SELECT si.item_name AS name, si.qty, si.price, si.total ' +
      'FROM sales_items si JOIN sales s ON s.id = si.order_id ' +
      'WHERE s.shift_id = ? ORDER BY si.item_name',
      [shiftId]
    );
    const agg = {};
    for (const it of items) {
      const n = String(it.name || 'غير معروف');
      if (!agg[n]) agg[n] = { name: n, qty: 0, price: Number(it.price) || 0, total: 0 };
      agg[n].qty   += Number(it.qty)   || 0;
      agg[n].total += Number(it.total) || 0;
    }
    soldItems = Object.values(agg).sort((a, b) => b.qty - a.qty);
  } catch (e) {
    // G-SALES error honesty — this feeds the printed shift report's items
    // table. Keep the [] fallback (a missing items list must not block a
    // shift CLOSE), but never swallow the failure silently again.
    console.error('[aggregateShiftPayments] sold-items query failed:', e.message);
  }

  return {
    methods: methods
      .filter(m => !m._synthetic || (expectedById[m.id] || 0) > 0)
      .map(m => ({
        id: m.id, name: m.name, nameAr: m.name_ar,
        icon: m.icon || 'fa-money-bill', color: m.color || '#3b82f6',
        groupType: m.group_type,
        expectedAmount: expectedById[m.id] || 0,
        count: countById[m.id] || 0
      })),
    expectedById,
    expectedTotal,
    unmatchedTotal,
    unmatchedDetails,
    soldItems,
    orderCount: sales.length,
    rawSales: sales,
    // W2-A — the approved drawer movements folded into expectedTotal above, so
    // every caller (close-v3, the X/Z report) can SHOW the adjustment instead of
    // leaving the cashier to wonder why "expected" moved.
    movements: mv.rows,
    movementTotals: { payIn: mv.payIn, payOut: mv.payOut, net: _r2(mv.payIn - mv.payOut), count: mv.rows.length },
    openingFloat: _openingFloat,
  };
}

// ═══════════════════════════════════════════════════════════════════
// W2-A — TILL CASH MOVEMENTS (حركات نقدية على الدرج)
//
// THE GAP: a cashier could not record cash in or out during a shift from ANY
// client. /api/cash is mounted behind requireRole('admin','manager')
// (server.js), and neither cash_receipts nor cash_payments carried a shift
// reference — so a drop to the safe, a float top-up or petty cash was invisible
// to the till and the expected-cash figure at close was wrong by exactly those
// amounts. The analytics side was already finished (analytics_till_facts has
// pay_in/pay_out + a shift_id column, equations.expectedCash already sums them,
// ReconciliationService and the till_variance anomaly rule already read them);
// only the linkage was missing.
//
// OWNER DECISION: the cashier records the movement, a manager approves it.
//
// STORAGE — deliberately NOT a new table. A pay-in IS a cash receipt and a
// pay-out IS a cash payment: same money, same GL treatment, same voucher the
// bookkeeper already reviews and prints. They are written into cash_receipts /
// cash_payments with the new nullable `shift_id` set, which means the ERP cash
// module, the voucher print template, the cash-box balance and every existing
// report pick them up with no further work — and ProjectionService reads
// shift_id straight off the row, so the live projection, the repair drain and
// the backfill script all carry the shift through without a signature change.
//
// APPROVAL — the pattern is routes/sales.js `_verifyApproverCredentials` /
// `_assertRefundAuthority`, verbatim in shape: the actor proceeds on their own
// authority if they hold the capability, otherwise THIS request must carry an
// approver's credentials, verified server-side (constant-time bcrypt against a
// dummy pad so a wrong username and a wrong password are indistinguishable by
// timing), and that approver must hold the capability themselves. The approving
// account is recorded on the voucher (approved_by/approved_at) and in an
// audit_logs row. There is no client-trusted "approved" flag anywhere.
//
// COUNTED ONLY ONCE APPROVED — every read below filters `status = 'posted'`.
// A draft or cancelled voucher (one created through the ERP module, or a future
// deferred-approval path) can never move the expected-cash figure.
// ═══════════════════════════════════════════════════════════════════

/** The capability that authorizes a drawer movement. Seeded in server.js's
 *  late-permissions block and granted to manager/finance/accountant — NOT to
 *  cashier. admin/developer bypass inside hasCapability(). */
const MOVEMENT_APPROVE_CAP = 'pos.cash_movement.approve';
/** Hard ceiling per movement — the same order of magnitude as the opening-float
 *  cap. A mistyped amount must never silently distort a whole shift. */
const MOVEMENT_AMOUNT_CAP = 50000;
const MOVEMENT_KINDS = ['pay_in', 'pay_out'];
/** Computed once at module load: bcrypt.compare ALWAYS runs (against this pad
 *  when the approver does not exist) so response timing cannot be used to
 *  enumerate manager usernames. Mirrors routes/sales.js _APPROVAL_DUMMY_HASH. */
const _MV_APPROVAL_DUMMY_HASH = bcrypt.hashSync('till-movement-approval-timing-pad', 12);

function _mvErr(message, status, code) {
  const e = new Error(message); e.status = status; e.code = code; return e;
}

/**
 * The CREDENTIAL half of the approval gate — the same lookup, the same
 * constant-time bcrypt against a dummy pad, and the same SINGLE generic error
 * as routes/sales.js `_verifyApproverCredentials`. The one deliberate
 * difference: authority is asserted by CAPABILITY (below), not by a hardcoded
 * admin/manager role list, so a finance/accountant account that legitimately
 * holds `pos.cash_movement.approve` can approve a drop to the safe. Resolves to
 * { username, role } or throws a 403.
 */
async function _verifyMovementApprover(req) {
  const approverUsername = req.body && req.body.approverUsername;
  const approverPassword = req.body && req.body.approverPassword;
  if (!approverUsername || !approverPassword) {
    throw _mvErr('هذا الإجراء يتطلب اعتماد مدير · Manager approval required', 403, 'approval_required');
  }
  let rows;
  try {
    [rows] = await db.query('SELECT username, password, role FROM users WHERE username = ? LIMIT 1',
      [String(approverUsername).trim()]);
  } catch (e) {
    throw _mvErr('تعذّر التحقق من بيانات المدير · Could not verify approver', 500, 'approval_check_failed');
  }
  const mgr = rows && rows[0];
  let okPw = false;
  try {
    okPw = await bcrypt.compare(String(approverPassword), (mgr && mgr.password) || _MV_APPROVAL_DUMMY_HASH);
  } catch (_) { okPw = false; }
  if (!mgr || !okPw) {
    throw _mvErr('بيانات اعتماد المدير غير صحيحة · Invalid manager approval credentials', 403, 'approval_invalid');
  }
  return { username: mgr.username, role: String(mgr.role || '').toLowerCase() };
}

/**
 * Full authority assertion for a till movement. Returns the approving account's
 * username (never null — a movement is ALWAYS attributable to an approver) plus
 * whether that approval came from a second person.
 */
async function _assertMovementApproval(req) {
  if (!req.user || !req.user.username) {
    throw _mvErr('مطلوب تسجيل الدخول', 401, 'PERMISSION_DENIED');
  }
  let selfOk = false;
  try { selfOk = await hasCapability(req.user, MOVEMENT_APPROVE_CAP); }
  catch (_) { selfOk = false; } // fail closed, same as the middleware
  if (selfOk) return { approvedBy: req.user.username, elevated: false };

  const approver = await _verifyMovementApprover(req);
  let approverOk = false;
  try { approverOk = await hasCapability({ username: approver.username, role: approver.role }, MOVEMENT_APPROVE_CAP); }
  catch (_) { approverOk = false; } // fail closed
  if (!approverOk) {
    throw _mvErr('المدير المعتمد لا يملك صلاحية اعتماد حركات الدرج · The approving account does not hold the till-movement approval capability',
      403, 'approval_forbidden');
  }
  return { approvedBy: approver.username, elevated: true };
}

/** API shape for one movement row. */
function _movementRow(r) {
  return {
    id: r.id,
    kind: r.kind,                       // 'pay_in' | 'pay_out'
    number: r.number || '',
    amount: _r2(r.amount),
    reason: r.reason || '',
    note: r.note || '',
    createdBy: r.created_by || '',
    approvedBy: r.approved_by || '',
    approvedAt: r.approved_at || null,
    journalId: r.journal_id || null,
    date: r.movement_date || null,
  };
}

/**
 * Every APPROVED (posted) movement on a shift, plus the pay-in / pay-out totals
 * that lib/analytics/equations.expectedCash consumes.
 *
 * Degrades to zeros — loudly — when the cash voucher tables or the shift_id
 * column are unavailable (a POS-only install, a database that has not run the
 * migration): the shift close must never be blocked by this, and falling back
 * to zeros reproduces exactly the pre-W2-A behaviour rather than inventing a
 * number.
 */
async function _shiftMovementTotals(shiftId) {
  const empty = { payIn: 0, payOut: 0, rows: [] };
  if (!shiftId) return empty;
  try {
    const [rows] = await db.query(
      "SELECT id, 'pay_in' AS kind, receipt_number AS number, amount, description AS reason, " +
      "       reference AS note, created_by, approved_by, approved_at, journal_id, " +
      "       receipt_date AS movement_date, created_at " +
      "  FROM cash_receipts WHERE shift_id = ? AND status = 'posted' " +
      "UNION ALL " +
      "SELECT id, 'pay_out' AS kind, payment_number AS number, amount, description AS reason, " +
      "       reference AS note, created_by, approved_by, approved_at, journal_id, " +
      "       payment_date AS movement_date, created_at " +
      "  FROM cash_payments WHERE shift_id = ? AND status = 'posted' " +
      "ORDER BY created_at ASC, id ASC",
      [shiftId, shiftId]);
    // created_at is a TIMESTAMP — SECOND precision. Two movements recorded in
    // the same second tie, and the SQL tiebreak (id ASC across a UNION of two
    // tables) then orders them by the 'PAY-'/'REC-' PREFIX, i.e. by kind, not by
    // time: a pay-out always jumped ahead of a pay-in taken before it. The ids
    // this route mints embed Date.now() as their second segment, so re-sort on
    // that in JS — millisecond-accurate, and it degrades to the SQL order for
    // any row whose id does not carry one.
    rows.sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime() || 0;
      const tb = new Date(b.created_at || 0).getTime() || 0;
      if (ta !== tb) return ta - tb;
      const ms = (id) => { const m = /^[A-Z]+-(\d{10,})/.exec(String(id || '')); return m ? Number(m[1]) : 0; };
      const ma = ms(a.id), mb = ms(b.id);
      if (ma !== mb) return ma - mb;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
    let payIn = 0, payOut = 0;
    for (const r of rows) {
      if (r.kind === 'pay_in') payIn = _r2(payIn + _r2(r.amount));
      else payOut = _r2(payOut + _r2(r.amount));
    }
    return { payIn, payOut, rows: rows.map(_movementRow) };
  } catch (e) {
    console.error('[shifts] till-movement read failed for ' + shiftId + ' (expected cash falls back to float-only):', e.message);
    return empty;
  }
}

/**
 * The branch's cash box — the drawer the movement actually moves money into or
 * out of. Resolved from the shift's branch snapshot; auto-created (idempotent,
 * deterministic id) when the branch has none, exactly the way routes/cash.js
 * auto-creates the GL account behind a box. Without a cash box there is nothing
 * for ProjectionService to recognise as a TILL movement (it requires
 * destination/source_type = 'cash'), so this is not optional.
 */
async function _ensureBranchCashBox(conn, branchId) {
  const [existing] = await conn.query(
    "SELECT id FROM cash_boxes WHERE branch_id = ? AND is_active = 1 " +
    "ORDER BY (type = 'branch') DESC, id ASC LIMIT 1", [branchId]);
  if (existing.length) return existing[0].id;
  const id = ('CB-BR-' + String(branchId)).slice(0, 50);
  let name = 'صندوق الفرع';
  try {
    const [b] = await conn.query('SELECT name FROM branches WHERE id = ? LIMIT 1', [branchId]);
    if (b.length && b[0].name) name = 'صندوق ' + b[0].name;
  } catch (_) { /* cosmetic label only */ }
  await conn.query(
    'INSERT IGNORE INTO cash_boxes (id, name, code, type, branch_id, currency, balance, is_active) ' +
    'VALUES (?,?,?,?,?,?,0,1)',
    [id, name.slice(0, 200), ('BR-' + String(branchId)).slice(0, 30), 'branch', branchId, 'SAR']);
  return id;
}

/**
 * A gl_accounts.code that FITS. The column is VARCHAR(20): the obvious
 * `<parent>-<branch id>` overflowed it, MySQL truncated the value under
 * INSERT IGNORE (which downgrades the truncation to a warning), and
 * postJournal then refused the journal with "حساب غير موجود" for a code that
 * had genuinely just been written — under a different name. Deterministic: the
 * same seed always yields the same code, so re-running is idempotent and the
 * account is found on the second movement instead of a second one being minted.
 */
function _glCodeFor(parentCode, seed) {
  const MAX_CODE_LEN = 20;
  const room = MAX_CODE_LEN - String(parentCode).length - 1;
  const plain = String(seed).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (room <= 0) return String(parentCode).slice(0, MAX_CODE_LEN);
  if (plain.length && plain.length <= room) return parentCode + '-' + plain;
  // Stable FNV-1a → base36, 6 chars. Short, collision-checked by the caller.
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const hash = h.toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
  return (parentCode + '-' + hash).slice(0, MAX_CODE_LEN);
}

/**
 * The cash parent in whichever COA template this install actually has:
 *   '1101' (النقدية — the routes/cash.js convention this storage belongs to)
 * → '111'  (Cash and Bank — the v5.11.8 IFRS template in lib/glPosting)
 * → '1110' (النقدية — the CORE account ensureCoreAccounts always seeds)
 * → '11'   (last resort ancestor).
 * ensureCoreAccounts runs first so the '1110' rung is guaranteed to exist even
 * on a chart that has never been seeded — otherwise a fresh install would take
 * the coa_not_seeded path and a cashier could not record a movement at all.
 * Returns { id, code, level } or null.
 */
async function _cashParentAccount(conn) {
  try { await glPosting.ensureCoreAccounts(conn); } catch (e) {
    console.warn('[shifts] ensureCoreAccounts before till movement failed:', e.message);
  }
  for (const code of ['1101', '111', '1110', '11']) {
    const [r] = await conn.query('SELECT id, code, level FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
    if (r.length) return { id: r[0].id, code: r[0].code, level: Number(r[0].level) || 3 };
  }
  return null;
}

/** The cash box's own GL account (auto-created under the cash parent when the
 *  box has none) — mirrors routes/cash.js ensureCashAccount. Returns
 *  { id, code } so glPosting.postJournal can resolve it by CODE. */
async function _ensureCashBoxGl(conn, boxId) {
  const [r] = await conn.query('SELECT id, name, code, gl_account_id FROM cash_boxes WHERE id = ? LIMIT 1', [boxId]);
  if (!r.length) throw _mvErr('الصندوق غير موجود · Cash box not found', 500, 'cash_box_missing');
  const box = r[0];
  if (box.gl_account_id) {
    const [g] = await conn.query('SELECT id, code FROM gl_accounts WHERE id = ? LIMIT 1', [box.gl_account_id]);
    if (g.length) return { id: g[0].id, code: g[0].code };
  }
  const parent = await _cashParentAccount(conn);
  if (!parent) throw _mvErr('شجرة الحسابات غير مهيأة · Chart of accounts not initialised', 500, 'coa_not_seeded');
  const accId = ('GL-CB-' + String(boxId)).slice(0, 50);
  let accCode = _glCodeFor(parent.code, String(box.code || boxId));
  const [clash] = await conn.query('SELECT id, code FROM gl_accounts WHERE code = ? LIMIT 1', [accCode]);
  if (clash.length) {
    if (clash[0].id === accId) {
      // Already minted for this box by an earlier movement — reuse it.
      await conn.query('UPDATE cash_boxes SET gl_account_id = ? WHERE id = ?', [accId, boxId]);
      return { id: accId, code: accCode };
    }
    accCode = _glCodeFor(parent.code, String(boxId) + '#' + accId);
  }
  await conn.query(
    'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
    [accId, accCode, String(box.name || accCode).slice(0, 200), 'asset', parent.id, parent.level + 1]);
  // INSERT IGNORE downgrades EVERY error to a warning — including a value that
  // does not fit the column. Read the row back and fail loudly if the code the
  // journal is about to reference is not actually resolvable; a silent
  // "حساب غير موجود" on a code we just wrote is the exact bug this guards.
  const [written] = await conn.query('SELECT id, code FROM gl_accounts WHERE id = ? LIMIT 1', [accId]);
  if (!written.length || written[0].code !== accCode) {
    throw _mvErr('تعذّر إنشاء حساب الصندوق في شجرة الحسابات · Could not create the cash-box GL account',
      500, 'cash_box_gl_failed');
  }
  await conn.query('UPDATE cash_boxes SET gl_account_id = ? WHERE id = ?', [accId, boxId]);
  return { id: accId, code: accCode };
}

/**
 * The contra account for a drawer movement: «نقدية بالطريق — حركات الدرج».
 *
 * Deliberately an ASSET, not revenue or expense. Cash moving between the drawer
 * and the safe/treasury is a transfer between asset accounts; routing a float
 * top-up to «إيرادات أخرى» (the cash module's default contra for source_type
 * 'other') would fabricate revenue, and routing a petty-cash pay-out straight to
 * an expense would guess at a classification the cashier never made. Parking it
 * in cash-in-transit is the honest position: the money left/entered the drawer,
 * and the bookkeeper reclassifies it from a balance that is visibly non-zero.
 */
async function _ensureTillContraAccount(conn) {
  const parent = await _cashParentAccount(conn);
  if (!parent) throw _mvErr('شجرة الحسابات غير مهيأة · Chart of accounts not initialised', 500, 'coa_not_seeded');
  const code = _glCodeFor(parent.code, 'TILL');
  const [r] = await conn.query('SELECT id, code FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  if (r.length) return { id: r[0].id, code: r[0].code };
  const id = 'GL-TILL-ADJ';
  await conn.query(
    'INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
    [id, code, 'نقدية بالطريق — حركات الدرج', 'asset', parent.id, parent.level + 1]);
  const [written] = await conn.query('SELECT id, code FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  if (!written.length) {
    throw _mvErr('تعذّر إنشاء حساب حركات الدرج · Could not create the till-movement contra account',
      500, 'till_contra_gl_failed');
  }
  return { id: written[0].id, code: written[0].code };
}

/** Voucher number in the SAME sequence the ERP cash module uses, so a movement
 *  does not open a parallel numbering scheme the bookkeeper has to reconcile.
 *  Same algorithm as routes/cash.js nextNumber, run on the caller's connection. */
async function _nextVoucherNumber(conn, table, column, prefix) {
  try {
    const [last] = await conn.query(`SELECT ${column} FROM ${table} ORDER BY created_at DESC LIMIT 1`);
    let num = 1;
    if (last.length && last[0][column]) {
      const m = String(last[0][column]).match(/(\d+)/);
      if (m) num = parseInt(m[1], 10) + 1;
    }
    return prefix + String(num).padStart(5, '0');
  } catch (_) {
    return prefix + String(Date.now()).slice(-5);
  }
}

/** Post-commit audit row naming who recorded the movement and who authorized
 *  it. Never blocks (the money already moved) but a failure is LOUD. */
async function _auditMovement(row, actor, approvedBy, req) {
  try {
    await db.query(
      'INSERT INTO audit_logs (action, entity_type, entity_id, user_username, details, ip_address, created_at) ' +
      'VALUES (?,?,?,?,?,?,NOW())',
      ['shift_cash_movement_approved', 'shift_cash_movement', row.id, actor || 'system',
       JSON.stringify({
         shiftId: row.shiftId, kind: row.kind, amount: row.amount,
         reason: row.reason, approvedBy, actor: actor || null, journalId: row.journalId || null,
       }),
       (req && req.ip) || '']);
  } catch (e) {
    console.error('[shifts] movement audit row failed for ' + row.id + ':', e.message);
  }
}

/** Shift row + the caller's right to act on it. Owner always; a supervisor with
 *  `sales.reports.view` for the read path. */
async function _loadShiftForMovement(shiftId) {
  const [rows] = await db.query('SELECT id, username, branch_id, status FROM shifts WHERE id = ? LIMIT 1', [shiftId]);
  if (!rows.length) throw _mvErr('الوردية غير موجودة · Shift not found', 404, 'shift_not_found');
  return rows[0];
}

// ── POST /api/shifts/:shiftId/movements — record + approve a drawer movement ──
// Body: { kind: 'pay_in'|'pay_out', amount, reason, note?,
//         approverUsername?, approverPassword? }
// The whole thing is ONE transaction: shift lock → voucher insert → GL journal →
// posted + approver stamp → cash-box balance. Nothing half-written: if the
// journal is refused (closed period, unbalanced, missing COA) the movement does
// not exist at all, which is the only safe direction for money.
router.post('/:shiftId/movements', requireCapability('pos.use'), async (req, res) => {
  try {
    const shiftId = String(req.params.shiftId || '');
    const actor = req.user.username;
    const kind = String((req.body && req.body.kind) || '').toLowerCase();
    if (MOVEMENT_KINDS.indexOf(kind) === -1) {
      throw _mvErr('نوع الحركة غير صالح (pay_in أو pay_out) · Invalid movement kind', 400, 'invalid_kind');
    }
    const rawAmount = req.body && req.body.amount;
    const amount = _r2(rawAmount);
    if (!Number.isFinite(Number(rawAmount)) || amount <= 0) {
      throw _mvErr('المبلغ يجب أن يكون رقمًا موجبًا · Amount must be a positive number', 400, 'invalid_amount');
    }
    if (amount > MOVEMENT_AMOUNT_CAP) {
      throw _mvErr(`المبلغ يتجاوز الحد المسموح (${MOVEMENT_AMOUNT_CAP}) · Amount exceeds the allowed limit`, 400, 'amount_too_large');
    }
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 2) {
      throw _mvErr('سبب الحركة مطلوب · A reason is required', 400, 'reason_required');
    }
    const note = String((req.body && req.body.note) || '').trim().slice(0, 200);

    const shift = await _loadShiftForMovement(shiftId);
    // Identity comes ONLY from the verified token; a cashier records movements
    // on their OWN drawer. A supervisor may act on any shift they can see.
    if (shift.username !== actor && !_isSupervisor(req.user)) {
      throw _mvErr('لا يمكن تسجيل حركة على وردية مستخدم آخر · Not your shift', 403, 'PERMISSION_DENIED');
    }
    if (String(shift.status).toUpperCase() !== 'OPEN') {
      throw _mvErr('الوردية مغلقة — لا يمكن تسجيل حركة نقدية · Shift is closed', 400, 'shift_not_open');
    }

    // Manager approval BEFORE anything is written: an unapproved movement must
    // not exist even as a draft (a stray draft pay-out is a drawer that is short
    // with a paper trail that says otherwise).
    const approval = await _assertMovementApproval(req);

    const isReceipt = kind === 'pay_in';
    const branchId = shift.branch_id || null;
    const today = new Date().toISOString().slice(0, 10);

    const out = await db.withTransaction(async (conn) => {
      // Re-read the status UNDER the lock: the close is also transactional, so
      // this is the serialization point that keeps a movement from landing on a
      // shift that is closing right now (which would silently miss the
      // expected-cash figure the cashier is looking at).
      const [lock] = await conn.query('SELECT status, branch_id FROM shifts WHERE id = ? FOR UPDATE', [shiftId]);
      if (!lock.length) throw _mvErr('الوردية غير موجودة · Shift not found', 404, 'shift_not_found');
      if (String(lock[0].status).toUpperCase() !== 'OPEN') {
        throw _mvErr('الوردية مغلقة — لا يمكن تسجيل حركة نقدية · Shift is closed', 400, 'shift_not_open');
      }
      const lockedBranch = lock[0].branch_id || branchId;
      if (!lockedBranch) {
        throw _mvErr('الوردية غير مرتبطة بفرع — لا يمكن تحديد صندوق النقدية · Shift has no branch, cannot resolve a cash box',
          400, 'shift_has_no_branch');
      }

      const boxId = await _ensureBranchCashBox(conn, lockedBranch);
      const boxGl = await _ensureCashBoxGl(conn, boxId);
      const contra = await _ensureTillContraAccount(conn);

      const table = isReceipt ? 'cash_receipts' : 'cash_payments';
      const numberCol = isReceipt ? 'receipt_number' : 'payment_number';
      const number = await _nextVoucherNumber(conn, table, numberCol, isReceipt ? 'REC-' : 'PAY-');
      const id = (isReceipt ? 'REC-' : 'PAY-') + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const partyName = ('وردية ' + shiftId).slice(0, 200);

      if (isReceipt) {
        await conn.query(
          'INSERT INTO cash_receipts (id, receipt_number, receipt_date, destination_type, destination_id, ' +
          ' source_type, source_name, amount, reference, description, status, created_by, branch_id, shift_id) ' +
          "VALUES (?,?,?,'cash',?,'other',?,?,?,?,'draft',?,?,?)",
          [id, number, today, boxId, partyName, amount, note, reason, actor, lockedBranch, shiftId]);
      } else {
        await conn.query(
          'INSERT INTO cash_payments (id, payment_number, payment_date, source_type, source_id, ' +
          ' recipient_type, recipient_name, amount, reference, description, status, created_by, branch_id, shift_id) ' +
          "VALUES (?,?,?,'cash',?,'other',?,?,?,?,'draft',?,?,?)",
          [id, number, today, boxId, partyName, amount, note, reason, actor, lockedBranch, shiftId]);
      }

      // pay_in : Dr drawer / Cr cash-in-transit — money entered the drawer.
      // pay_out: Dr cash-in-transit / Cr drawer — money left the drawer.
      const entries = isReceipt
        ? [{ accountCode: boxGl.code, debit: amount, credit: 0, branchId: lockedBranch },
           { accountCode: contra.code, debit: 0, credit: amount, branchId: lockedBranch }]
        : [{ accountCode: contra.code, debit: amount, credit: 0, branchId: lockedBranch },
           { accountCode: boxGl.code, debit: 0, credit: amount, branchId: lockedBranch }];
      const posted = await glPosting.postJournal(conn, {
        journalDate: today,
        description: (isReceipt ? 'إيداع نقدي على الدرج ' : 'سحب نقدي من الدرج ') + number + ' — ' + reason,
        referenceType: 'shift_cash_movement',
        referenceId: id,
        postedBy: approval.approvedBy,
        status: 'posted',
        entries,
        branchId: lockedBranch,
      });
      if (!posted || !posted.success) {
        throw _mvErr('تعذّر ترحيل القيد: ' + ((posted && posted.error) || 'unknown') + ' · Could not post the journal',
          400, 'gl_post_failed');
      }

      await conn.query(
        `UPDATE ${table} SET status = 'posted', journal_id = ?, approved_by = ?, approved_at = NOW() WHERE id = ?`,
        [posted.journalId, approval.approvedBy, id]);
      await conn.query('UPDATE cash_boxes SET balance = balance ' + (isReceipt ? '+' : '-') + ' ? WHERE id = ?',
        [amount, boxId]);

      return {
        id, number, journalId: posted.journalId, journalNumber: posted.journalNumber,
        boxId, branchId: lockedBranch,
      };
    });

    // ── Post-commit, non-fatal, idempotent (UNIQUE on source_type+source_id+
    //    movement_type). ProjectionService reads shift_id off the row; the
    //    explicit opts.shiftId makes the intent visible at the call site. This
    //    is what puts the movement into analytics_till_facts, which is what
    //    makes equations.expectedCash and the three-way reconciliation include
    //    it without either of them changing at all. ──
    const projKind = isReceipt ? 'cash_receipt' : 'cash_payment';
    try {
      analyticsProjection.safeProject(db, projKind, out.id,
        () => analyticsProjection.projectCashVoucher(db, projKind, out.id, { shiftId }));
    } catch (_) {}

    const movement = {
      id: out.id, shiftId, kind, number: out.number, amount, reason, note,
      createdBy: actor, approvedBy: approval.approvedBy, approvedRemotely: approval.elevated,
      journalId: out.journalId, journalNumber: out.journalNumber, branchId: out.branchId,
    };
    await _auditMovement(movement, actor, approval.approvedBy, req);

    const totals = await _shiftMovementTotals(shiftId);
    res.json({
      success: true,
      movement,
      totals: { payIn: totals.payIn, payOut: totals.payOut, net: _r2(totals.payIn - totals.payOut), count: totals.rows.length },
    });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error('[POST /shifts/:shiftId/movements]', e.message);
    res.status(e.status || 500).json({ success: false, error: e.message, code: e.code || undefined });
  }
});

// ── GET /api/shifts/:shiftId/movements — the shift's approved movements ──────
// Same reader the expected-cash fold uses, so what the cashier sees in the
// dialog is exactly what the close will subtract/add. Financial data: shift
// owner or `sales.reports.view` only, same rule as the shift report.
router.get('/:shiftId/movements', async (req, res) => {
  try {
    const shiftId = String(req.params.shiftId || '');
    const shift = await _loadShiftForMovement(shiftId);
    if (!(await _canViewShiftReport(req.user, shift.username))) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض حركات هذه الوردية' });
    }
    const totals = await _shiftMovementTotals(shiftId);
    res.json({
      success: true,
      shiftId,
      movements: totals.rows,
      totals: { payIn: totals.payIn, payOut: totals.payOut, net: _r2(totals.payIn - totals.payOut), count: totals.rows.length },
    });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error('[GET /shifts/:shiftId/movements]', e.message);
    res.status(e.status || 500).json({ success: false, error: e.message, code: e.code || undefined });
  }
});

// Open shift — a CASHIER action: `pos.use` (live for role=cashier).
router.post('/open', requireCapability('pos.use'), async (req, res) => {
  try {
    // G-SALES — identity comes ONLY from the verified token. The legacy
    // req.body.username fallback let a request open a shift under another
    // cashier; requireCapability above guarantees req.user is set.
    const username = req.user.username;
    const { geoLat, geoLng, geoAddress, deviceInfo, device } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';

    // Opening float (الرصيد الافتتاحي) — the real cash placed in the drawer when
    // the shift starts. Validate strictly: it must be a finite, non-negative
    // number, and no larger than a sane ceiling (a mistyped float must never
    // silently distort the whole shift's expected-cash reconciliation). Rounded
    // to 2 decimals (halalas) before it is persisted.
    const OPENING_FLOAT_CAP = 50000;
    const rawFloat = req.body.openingFloat;
    const floatNum = Number(rawFloat);
    if (rawFloat != null && rawFloat !== '') {
      if (!Number.isFinite(floatNum) || floatNum < 0) {
        return res.status(400).json({ success: false, error: 'الرصيد الافتتاحي يجب أن يكون رقمًا موجبًا' });
      }
      if (floatNum > OPENING_FLOAT_CAP) {
        return res.status(400).json({ success: false, error: `الرصيد الافتتاحي يتجاوز الحد المسموح (${OPENING_FLOAT_CAP})` });
      }
    }
    const openingFloat = Math.round((Number.isFinite(floatNum) && floatNum > 0 ? floatNum : 0) * 100) / 100;

    // v5.12.2 — accept structured device { brand, model, os, ua, mobile }
    // sent by /shared/device-info.js, fall back to legacy raw deviceInfo
    // string for backwards compatibility with older clients.
    const dev = device && typeof device === 'object' ? device : {};
    const rawUA = (dev.ua || deviceInfo || '').toString();

    // v7.5 — TOCTOU fix: the old check-then-insert let two concurrent
    // requests (double-tap / network retry) create two OPEN shifts for one
    // cashier. Lock the user row as a per-user mutex (users.username is
    // UNIQUE NOT NULL and every caller is authenticated), then re-check +
    // insert inside ONE transaction. MySQL has no partial unique indexes,
    // so this row lock is the serialization point.
    const out = await db.withTransaction(async (conn) => {
      // Brand/branch scope fix — resolve branch_id in the SAME locked read (no
      // extra round-trip), snapshotted at OPEN time only (never rewritten
      // later), exactly like the existing name_snapshot / channel_name
      // convention elsewhere in this codebase.
      const [urow] = await conn.query('SELECT id, branch_id, default_branch_id FROM users WHERE username = ? FOR UPDATE', [username]);
      const branchId = urow.length ? (urow[0].branch_id || urow[0].default_branch_id || null) : null;
      const [existing] = await conn.query(
        'SELECT id, opening_float FROM shifts WHERE username = ? AND status = "OPEN" LIMIT 1', [username]);
      // Idempotent open (double-tap / retry): a second /open MUST NOT change an
      // already-open shift's float — return the ALREADY-STORED value untouched.
      if (existing.length) return { shiftId: existing[0].id, openingFloat: Number(existing[0].opening_float || 0) };

      const shiftId = 'SH-' + Date.now();
      const now = new Date();
      await conn.query(
        'INSERT INTO shifts (id, username, branch_id, start_time, status, opening_float, geo_lat, geo_lng, geo_address, device_info, device_brand, device_model, device_os, ip_address) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          shiftId, username, branchId, now, 'OPEN', openingFloat,
          geoLat || null, geoLng || null, geoAddress || '',
          rawUA,
          (dev.brand || '').toString().slice(0, 50),
          (dev.model || '').toString().slice(0, 120),
          (dev.os    || '').toString().slice(0, 80),
          ip
        ]
      );
      return { shiftId, openingFloat };
    });

    // Unified Sales Analytics — 'open_float' till fact. Post-commit, non-fatal,
    // idempotent (an idempotent re-open replays onto the same unique key).
    try { analyticsProjection.safeProject(db, 'shift_open', out.shiftId, () => analyticsProjection.projectTillMovement(db, { type: 'open_float', shiftId: out.shiftId })); } catch (_) {}

    res.json({ success: true, shiftId: out.shiftId, openingFloat: out.openingFloat });
  } catch (e) {
    // G-SALES error honesty — was res.json({success:false}) with HTTP 200.
    console.error('[POST /shifts/open]', e.message);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// Close shift — a CASHIER action: `pos.shift_close` (live for role=cashier).
router.post('/close', requireCapability('pos.shift_close'), async (req, res) => {
  try {
    const { shiftId, actualCash, actualCard, actualKita } = req.body;
    const now = new Date();

    // Get theoretical totals from sales
    // v7.5 — exclude voided / credit-note sales (same filter as
    // aggregateShiftPayments) so a void doesn't inflate the expected cash
    // and leave the shift permanently "short".
    const [sales] = await db.query(
      "SELECT payment_method, total_final, kita_service_fee FROM sales WHERE shift_id = ? AND (zatca_type IS NULL OR zatca_type NOT IN ('cancellation','credit_note'))",
      [shiftId]);

    let theoreticalCash = 0;
    let theoreticalCard = 0;
    let theoreticalKita = 0;

    for (const sale of sales) {
      const total = _r2(sale.total_final);
      const pm = (sale.payment_method || '').toLowerCase();

      // W0-A — same halala-safe leg read as every other shift aggregation.
      const legs = _parseSplitLegs(sale.payment_method);
      if (legs) {
        for (const leg of legs) {
          const method = String(leg.method).toLowerCase();
          if (method === 'cash') theoreticalCash = _r2(theoreticalCash + leg.amount);
          else if (method === 'card') theoreticalCard = _r2(theoreticalCard + leg.amount);
          else if (method === 'kita') theoreticalKita = _r2(theoreticalKita + leg.amount);
        }
      } else if (pm === 'cash') {
        theoreticalCash = _r2(theoreticalCash + total);
      } else if (pm === 'card') {
        theoreticalCard = _r2(theoreticalCard + total);
      } else if (pm === 'kita') {
        theoreticalKita = _r2(theoreticalKita + total);
      }
    }

    const totalTheoretical = _r2(theoreticalCash + theoreticalCard + theoreticalKita);
    const diffCash = _r2((Number(actualCash) || 0) - theoreticalCash);
    const diffCard = _r2((Number(actualCard) || 0) - theoreticalCard);
    const diffKita = _r2((Number(actualKita) || 0) - theoreticalKita);

    // v7.5 — atomic close: lock the row, refuse to close a non-OPEN shift
    // (a network-retry double-close used to silently overwrite the actuals).
    await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT status FROM shifts WHERE id = ? FOR UPDATE', [shiftId]);
      if (!rows.length) {
        const e = new Error('الوردية غير موجودة · Shift not found'); e.status = 404; throw e;
      }
      if (String(rows[0].status).toUpperCase() !== 'OPEN') {
        const e = new Error('الوردية مغلقة مسبقاً · Shift already closed');
        e.status = 400; e.code = 'shift_already_closed'; throw e;
      }
      await conn.query(
        `UPDATE shifts SET end_time = ?, status = 'closed',
         total_theoretical = ?, theoretical_cash = ?, theoretical_card = ?, theoretical_kita = ?,
         actual_cash = ?, actual_card = ?, actual_kita = ?,
         diff_cash = ?, diff_card = ?, diff_kita = ?
         WHERE id = ?`,
        [now, totalTheoretical, theoreticalCash, theoreticalCard, theoreticalKita,
         actualCash || 0, actualCard || 0, actualKita || 0,
         diffCash, diffCard, diffKita, shiftId]
      );
    });

    // Unified Sales Analytics — 'close_count' till fact (counted cash at close).
    // Post-commit, non-fatal, idempotent on (source_type,source_id,movement_type).
    try { analyticsProjection.safeProject(db, 'shift_close', shiftId, () => analyticsProjection.projectTillMovement(db, { type: 'close_count', shiftId })); } catch (_) {}

    res.json({
      success: true,
      theoreticalCash, theoreticalCard, theoreticalKita,
      diffCash, diffCard, diffKita, totalTheoretical
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message, code: e.code || undefined });
  }
});

// ═══════════════════════════════════════════════════════════════════
// V3 — Enhanced shift close: dynamic payment methods + cash denominations
// Body: {
//   shiftId,
//   openingFloat: <number>,
//   denominations: [{ value, count, kind: 'note'|'coin' }...],
//   paymentTotals: { <pmId>: <actualAmount>, ... },
//   notes
// }
// ═══════════════════════════════════════════════════════════════════
// G-SALES — same cashier capability as /close.
router.post('/close-v3', requireCapability('pos.shift_close'), async (req, res) => {
  try {
    const { shiftId, openingFloat, denominations, paymentTotals, notes } = req.body;
    if (!shiftId) return res.json({ success: false, error: 'shiftId مطلوب' });
    const now = new Date();
    const denomList = Array.isArray(denominations) ? denominations : [];

    // The ENTIRE close — lock, float read, aggregation, money math, and the
    // writes — runs inside ONE transaction so the opening float is read UNDER
    // the same row lock that guards the status, and can never race a concurrent
    // open/close. The client-supplied `openingFloat` is accepted for backward
    // compat but NEVER used for money math; the DB value is authoritative.
    const out = await db.withTransaction(async (conn) => {
      // v7.5 — lock the row + refuse a non-OPEN close (retry double-close used to
      // silently overwrite the saved reconciliation). Extended to also read the
      // stored opening_float in the SAME round-trip (no second query).
      const [stRows] = await conn.query('SELECT status, opening_float FROM shifts WHERE id = ? FOR UPDATE', [shiftId]);
      if (!stRows.length) {
        const e = new Error('الوردية غير موجودة · Shift not found'); e.status = 404; throw e;
      }
      if (String(stRows[0].status).toUpperCase() !== 'OPEN') {
        const e = new Error('الوردية مغلقة مسبقاً · Shift already closed');
        e.status = 400; e.code = 'shift_already_closed'; throw e;
      }
      // DB-authoritative float. A not-yet-updated client may still send its own
      // `openingFloat` (historically always 0); we log a mismatch for
      // observability but NEVER trust the client value or throw on it — the
      // server overrides it with the stored value for all money math.
      const dbOpeningFloat = Number(stRows[0].opening_float || 0);
      const clientFloat = Number(openingFloat || 0);
      if (clientFloat !== dbOpeningFloat) {
        console.warn(`[POST /shifts/close-v3] client openingFloat ${clientFloat} != stored ${dbOpeningFloat} for shift ${shiftId} — using stored value`);
      }

      // V5.7.17 — use the SHARED matcher so the variance saved here is identical
      //   to what the UI shows during the close flow. Fold the DB float into the
      //   cash EXPECTED figure (never into cashCounted — see below).
      const agg = await aggregateShiftPayments(shiftId, dbOpeningFloat);
      const expectedById = agg.expectedById;
      const expectedTotal = agg.expectedTotal;
      const methods = agg.methods;

      // ── 1. Sum cash from denominations — the PHYSICAL count only. The float
      //   is already sitting in the drawer, so the counted notes contain it;
      //   adding it again here would double-count on the actual side. ──
      let cashCounted = 0;
      for (const d of denomList) {
        cashCounted += (Number(d.value) || 0) * (Number(d.count) || 0);
      }

      // ── 2. Map incoming paymentTotals → actualsById (canonical key) ──
      //   Frontend sends BOTH `String(method.id)` AND name-based keys for the
      //   same method (defensive redundancy). To avoid double-counting, we
      //   process id keys FIRST (so they win) and skip name keys whose id
      //   was already credited. last-write-wins per method.id.
      const incoming = paymentTotals || {};
      const actualsById = {}; // { methodId: amount }
      const incomingKeys = Object.keys(incoming);
      // Pass 1: id-keyed (highest priority)
      incomingKeys.forEach(rawKey => {
        const amount = Number(incoming[rawKey]) || 0;
        const directIdHit = methods.find(m => String(m.id) === String(rawKey));
        if (directIdHit) actualsById[directIdHit.id] = amount;  // replace, not add
      });
      // Pass 2: name-keyed (only fills gaps not already filled by id)
      incomingKeys.forEach(rawKey => {
        const amount = Number(incoming[rawKey]) || 0;
        const k = _normPM(rawKey);
        // If the key is itself a numeric id we already handled, skip
        const directIdHit = methods.find(m => String(m.id) === String(rawKey));
        if (directIdHit) return;
        const nameHit = methods.find(m => _normPM(m.name) === k || _normPM(m.nameAr) === k);
        if (nameHit && actualsById[nameHit.id] == null) {
          actualsById[nameHit.id] = amount;
          return;
        }
        // Special: explicit 'cash' alias → first cash-group method
        if ((k === 'cash' || _CASH_ALIASES.indexOf(k) >= 0)) {
          const cashMethod = methods.find(m => m.groupType === 'cash');
          if (cashMethod && actualsById[cashMethod.id] == null) actualsById[cashMethod.id] = amount;
        }
      });

      // ── 3. Cash from denominations overrides any explicit 'cash' actual ──
      //   (the cashier counted real notes; that's authoritative)
      if (cashCounted > 0) {
        const cashMethod = methods.find(m => m.groupType === 'cash');
        if (cashMethod) actualsById[cashMethod.id] = cashCounted;
      }

      // ── 4. Compute totals + variance ──
      let actualTotal = 0;
      Object.keys(actualsById).forEach(k => { actualTotal += actualsById[k]; });
      const variance = actualTotal - expectedTotal;

      // ── 5. Build per-method breakdown (saved + returned) ──
      const breakdown = methods.map(m => ({
        id: m.id,
        name: m.name,
        nameAr: m.nameAr,
        groupType: m.groupType,
        expected: expectedById[m.id] || 0,
        actual: actualsById[m.id] || 0,
        variance: (actualsById[m.id] || 0) - (expectedById[m.id] || 0)
      }));

      // ── 6. Persist denominations ──
      await conn.query('DELETE FROM shift_close_denominations WHERE shift_id = ?', [shiftId]);
      for (let i = 0; i < denomList.length; i++) {
        const d = denomList[i];
        const cnt = Number(d.count) || 0;
        if (cnt > 0) {
          const did = 'DEN-' + shiftId + '-' + i;
          await conn.query(
            'INSERT INTO shift_close_denominations (id, shift_id, denomination, kind, count) VALUES (?,?,?,?,?)',
            [did, shiftId, Number(d.value) || 0, d.kind || 'note', cnt]
          );
        }
      }

      // ── 7. Compose payment_totals_json ──
      //   Stored shape (V5.7.17+ canonical):  { expectedById, actualsById, breakdown }
      //   Plus legacy aliases (expected, actuals) so older client builds still work.
      const legacyExpected = {};
      const legacyActuals  = {};
      methods.forEach(m => {
        const nameKey = _normPM(m.name) || _normPM(m.nameAr) || String(m.id);
        legacyExpected[nameKey] = expectedById[m.id] || 0;
        legacyActuals[nameKey]  = actualsById[m.id] || 0;
      });

      // ── V5.7.19 — properly compute per-group totals so the admin shifts
      //   list (which still reads diff_cash/diff_card/diff_kita columns)
      //   shows accurate per-group variance, not all-zeros. Without this,
      //   the user could only see the NET diff and couldn't tell that a
      //   "+31 net" was actually "+31 cash surplus AND -31 mada deficit".
      const cashMethods = methods.filter(m => (m.groupType || '').toLowerCase() === 'cash');
      const cardMethods = methods.filter(m => {
        const gt = (m.groupType || '').toLowerCase();
        return gt === 'electronic' || gt === 'card';
      });
      const kitaMethods = methods.filter(m => {
        const gt = (m.groupType || '').toLowerCase();
        return gt === 'voucher' || _normPM(m.name) === 'kita';
      });
      const sumExp = arr => arr.reduce((s, m) => s + (expectedById[m.id] || 0), 0);
      const sumAct = arr => arr.reduce((s, m) => s + (actualsById[m.id]   || 0), 0);
      const cashExpected = sumExp(cashMethods);
      const cardExpected = sumExp(cardMethods);
      const kitaExpected = sumExp(kitaMethods);
      // Cash actual: prefer counted denominations (authoritative); fall back to method actuals
      const cashActual   = cashCounted > 0 ? cashCounted : sumAct(cashMethods);
      const cardActual   = sumAct(cardMethods);
      const kitaActual   = sumAct(kitaMethods);
      const diffCash = cashActual - cashExpected;
      const diffCard = cardActual - cardExpected;
      const diffKita = kitaActual - kitaExpected;

      const paymentTotalsJson = JSON.stringify({
        version: 'v5.7.19',
        expectedById, actualsById, breakdown,
        // legacy aliases — older clients read these
        expected: legacyExpected, actuals: legacyActuals
      });

      // ── 8. Update the shift row (writes the DB-read float — a harmless
      //   self-write — never the client's; plus ALL legacy per-group columns) ──
      await conn.query(
        `UPDATE shifts SET
           end_time = ?, status = 'closed',
           opening_float = ?, expected_total = ?, actual_total = ?, variance_total = ?,
           payment_totals_json = ?, denominations_json = ?, cashier_notes = ?,
           total_theoretical = ?,
           theoretical_cash = ?, theoretical_card = ?, theoretical_kita = ?,
           actual_cash = ?,      actual_card = ?,      actual_kita = ?,
           diff_cash = ?,        diff_card = ?,        diff_kita = ?
         WHERE id = ?`,
        [
          now,
          dbOpeningFloat, expectedTotal, actualTotal, variance,
          paymentTotalsJson, JSON.stringify(denomList), notes || '',
          expectedTotal,
          cashExpected, cardExpected, kitaExpected,
          cashActual,   cardActual,   kitaActual,
          diffCash,     diffCard,     diffKita,
          shiftId
        ]
      );

      return {
        legacyExpected, legacyActuals, expectedById, actualsById, breakdown,
        expectedTotal, actualTotal, variance, cashCounted,
        orderCount: agg.orderCount, soldItems: agg.soldItems, methods: agg.methods,
      };
    });

    // Unified Sales Analytics — 'close_count' till fact (counted cash at close).
    // Post-commit, non-fatal, idempotent on (source_type,source_id,movement_type).
    try { analyticsProjection.safeProject(db, 'shift_close', shiftId, () => analyticsProjection.projectTillMovement(db, { type: 'close_count', shiftId })); } catch (_) {}

    res.json({
      success: true,
      shiftId,
      expected: out.legacyExpected, actuals: out.legacyActuals,
      expectedById: out.expectedById, actualsById: out.actualsById, breakdown: out.breakdown,
      expectedTotal: out.expectedTotal, actualTotal: out.actualTotal, variance: out.variance,
      cashCounted: out.cashCounted, denominations: denomList,
      orderCount: out.orderCount,
      soldItems: out.soldItems,
      methods: out.methods
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message, code: e.code || undefined });
  }
});

// Closing data v3 — returns expected totals per dynamic payment method
// V5.7.14 — uses the same robust matcher as /closing-data (Arabic
// normalization + alias fallback + unmatched bucket).
router.get('/closing-data-v3/:shiftId', async (req, res) => {
  try {
    const { shiftId } = req.params;
    // Pull all enabled methods so the cashier sees the full reconciliation grid
    const [methods] = await db.query(
      "SELECT id, name, name_ar, icon, color, group_type FROM payment_methods WHERE is_active = 1 AND show_in_shift_close != 0 ORDER BY sort_order, name"
    );
    // v7.5 — exclude voided / credit-note sales so the reconciliation grid
    // matches what aggregateShiftPayments computes at close time.
    const [sales] = await db.query(
      "SELECT payment_method, total_final FROM sales WHERE shift_id = ? AND (zatca_type IS NULL OR zatca_type NOT IN ('cancellation','credit_note'))",
      [shiftId]);

    function norm(s) {
      return String(s || '').toLowerCase()
        .replace(/[ً-ْ]/g, '')
        .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
    }
    const exactLookup = {};
    const aliasLookup = {};
    const ELECTRONIC_ALIASES = ['mada','visa','master','mastercard','amex','network','شبكة','مدى','مدي','بطاقة'];
    const CASH_ALIASES = ['cash','نقد','كاش','نقدي'];
    const KITA_ALIASES = ['kita','كيتا','آجل','ajl','اجل'];

    methods.forEach(m => {
      [norm(m.name), norm(m.name_ar), String(m.id)].forEach(k => {
        if (k && !exactLookup[k]) exactLookup[k] = m;
      });
      String(m.name_ar || '').split(/[\/،\-,]/).forEach(p => {
        const k = norm(p);
        if (k && !exactLookup[k]) exactLookup[k] = m;
      });
    });
    methods.forEach(m => {
      let aliases = [];
      const gt = m.group_type;
      if (gt === 'electronic' || gt === 'card') aliases = ELECTRONIC_ALIASES;
      else if (gt === 'cash' || norm(m.name) === 'cash') aliases = CASH_ALIASES;
      else if (gt === 'voucher' || norm(m.name) === 'kita') aliases = KITA_ALIASES;
      aliases.map(norm).forEach(k => {
        if (k && !exactLookup[k] && !aliasLookup[k]) aliasLookup[k] = m;
      });
    });

    const expectedById = {};
    let expectedTotal = 0;
    let orderCount = sales.length;
    let unmatchedTotal = 0;
    function credit(rawMethod, amount) {
      const key = norm(rawMethod);
      const m = exactLookup[key] || aliasLookup[key];
      if (m) expectedById[m.id] = _r2((expectedById[m.id] || 0) + amount);
      else   unmatchedTotal = _r2(unmatchedTotal + amount);
      expectedTotal = _r2(expectedTotal + amount);
    }
    for (const s of sales) {
      const total = _r2(s.total_final);
      const pmRaw = s.payment_method || 'cash';
      // W0-A — decimal-safe leg read (shared _parseSplitLegs). This grid is
      // what the cashier reconciles against, so it must agree with
      // aggregateShiftPayments to the halala.
      const legs = _parseSplitLegs(pmRaw);
      if (legs) {
        for (const leg of legs) credit(leg.method, leg.amount);
      } else {
        credit(pmRaw, total);
      }
    }

    // MINIMAL fold-in (matches aggregateShiftPayments 3b — this handler keeps its
    // own aggregation rather than calling the shared helper, so we replicate the
    // 2-line fix locally). The opening float is real drawer cash the cashier will
    // count, so it belongs in the cash EXPECTED figure. Read it from the shift
    // row; a failure is logged (never swallowed) and degrades to a 0 float.
    let openingFloat = 0;
    try {
      const [srow] = await db.query('SELECT opening_float FROM shifts WHERE id = ?', [shiftId]);
      if (srow.length) openingFloat = Number(srow[0].opening_float || 0);
    } catch (e) {
      console.error('[GET /shifts/closing-data-v3] opening_float read failed:', e.message);
    }
    // W2-A — approved till movements belong in the SAME cash EXPECTED figure as
    // the float (see aggregateShiftPayments 3b for the full reasoning and the
    // equations.expectedCash identity). This handler keeps its own aggregation
    // rather than calling the shared helper, so the fold is replicated here —
    // and it MUST stay identical, because this is the grid the cashier
    // reconciles against and close-v3 recomputes independently. A drift between
    // the two is a phantom variance on the cashier's drawer.
    const mv = await _shiftMovementTotals(shiftId);
    const cashAdjustment = _r2(openingFloat + mv.payIn - mv.payOut);
    if (cashAdjustment !== 0) {
      const cashMethod = methods.find(
        (m) => String(m.group_type || '').toLowerCase() === 'cash' || norm(m.name) === 'cash',
      );
      if (cashMethod) {
        expectedById[cashMethod.id] = _r2((expectedById[cashMethod.id] || 0) + cashAdjustment);
        expectedTotal = _r2(expectedTotal + cashAdjustment);
      } else {
        console.error('[GET /shifts/closing-data-v3] no cash-group payment method — opening float + till movements (' +
          cashAdjustment + ') could not be folded into expected cash for shift ' + shiftId);
      }
    }

    // Back-compat 'expected' shape — keyed by lowercased name
    const expected = {};
    methods.forEach(m => { expected[(m.name || '').toLowerCase()] = expectedById[m.id] || 0; });

    res.json({
      methods: methods.map(m => ({
        id: m.id, name: m.name, nameAr: m.name_ar, icon: m.icon, color: m.color,
        groupType: m.group_type,
        expectedAmount: expectedById[m.id] || 0
      })),
      expected, expectedTotal, orderCount, unmatchedTotal, openingFloat,
      // W2-A — surfaced so the close screen can SHOW the ± adjustment instead of
      // the cashier discovering an unexplained jump in «المتوقع».
      movements: mv.rows,
      movementTotals: { payIn: mv.payIn, payOut: mv.payOut, net: _r2(mv.payIn - mv.payOut), count: mv.rows.length }
    });
  } catch (e) {
    // G-SALES error honesty — was res.json({error}) with HTTP 200; the
    // reconciliation grid then rendered all-zeros over a real DB failure.
    console.error('[GET /shifts/closing-data-v3]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// V5.7.17 — Full shift report endpoint. ONE round-trip returns:
//   shift meta + cashier name + branch + saved actuals (parsed) +
//   live aggregation (items, methods, expected) + denominations.
//   Used by the new thermal-printer report on close + reprint.
router.get('/:shiftId/full-report', async (req, res) => {
  try {
    const { shiftId } = req.params;
    // 1. Shift row
    const [shifts] = await db.query('SELECT * FROM shifts WHERE id = ?', [shiftId]);
    if (!shifts.length) return res.status(404).json({ error: 'Shift not found' });
    const s = shifts[0];

    // G-SALES — financial report: shift owner or `sales.reports.view` only.
    if (!(await _canViewShiftReport(req.user, s.username))) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية لعرض تقرير هذه الوردية' });
    }

    // 2. Cashier display name — same rule as the sale receipt (lib/displayName.js).
    //    Was user_meta ONLY, which disagreed with users.full_name.
    const _shiftCashier = await displayName.resolveCashierIdentity(db, s.username);
    const cashierName = _shiftCashier.name;
    const cashierEmpNo = _shiftCashier.empNo;

    // 3. Branch info (per V5.7.9 receipt extension)
    let branchName = '', branchAddress = '', branchCompanyName = '';
    try {
      let branchId = s.branch_id;
      if (!branchId) {
        const [ub] = await db.query('SELECT branch_id FROM user_branches WHERE username = ? LIMIT 1', [s.username]);
        if (ub.length) branchId = ub[0].branch_id;
      }
      if (branchId) {
        const [br] = await db.query('SELECT name, location, company_name FROM branches WHERE id = ?', [branchId]);
        if (br.length) {
          branchName        = br[0].name || '';
          branchAddress     = br[0].location || '';
          branchCompanyName = br[0].company_name || '';
        }
      }
    } catch (_) { /* cosmetic — report header labels only */ }

    // 4. Company info from settings
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
    } catch (_) { /* cosmetic — company header labels; defaults already set */ }

    // 5. Live aggregation (items + methods + expected)
    const agg = await aggregateShiftPayments(shiftId, Number(s.opening_float || 0));

    // 6. Saved actuals (parsed)
    let savedActuals = {};
    let savedExpected = {};
    let savedBreakdown = null;
    try {
      if (s.payment_totals_json) {
        const parsed = typeof s.payment_totals_json === 'string'
          ? JSON.parse(s.payment_totals_json) : s.payment_totals_json;
        if (parsed) {
          savedActuals   = parsed.actualsById || parsed.actuals || {};
          savedExpected  = parsed.expectedById || parsed.expected || {};
          savedBreakdown = parsed.breakdown || null;
        }
      }
    } catch (e) {
      // G-SALES error honesty — corrupt saved reconciliation silently degraded
      // to legacy columns; keep the fallback but log it (financial data).
      console.error('[GET /shifts/:id/full-report] payment_totals_json parse failed:', e.message);
    }

    // 7. Build a per-method actual-vs-expected table that PREFERS the saved
    //    breakdown (what the cashier confirmed at close) and falls back to
    //    re-aggregation if the saved data is missing/old.
    const methodsTable = agg.methods.map(m => {
      let actual = null;
      // 1. Try saved by id
      if (savedBreakdown) {
        const b = savedBreakdown.find(x => String(x.id) === String(m.id));
        if (b) actual = Number(b.actual) || 0;
      }
      // 2. Try savedActuals by id
      if (actual == null && savedActuals[m.id] != null)            actual = Number(savedActuals[m.id]) || 0;
      if (actual == null && savedActuals[String(m.id)] != null)    actual = Number(savedActuals[String(m.id)]) || 0;
      // 3. Try savedActuals by name
      if (actual == null) {
        const k = _normPM(m.name);
        if (savedActuals[k] != null) actual = Number(savedActuals[k]) || 0;
      }
      // 4. Legacy fields
      if (actual == null) {
        if (m.groupType === 'cash')                                          actual = Number(s.actual_cash) || 0;
        else if (m.groupType === 'electronic' || m.groupType === 'card')    actual = Number(s.actual_card) || 0;
        else if (m.groupType === 'voucher' || _normPM(m.name) === 'kita')   actual = Number(s.actual_kita) || 0;
        else                                                                 actual = 0;
      }
      const expected = m.expectedAmount;
      return {
        id: m.id, name: m.name, nameAr: m.nameAr,
        icon: m.icon, color: m.color, groupType: m.groupType,
        expected, actual, variance: actual - expected, count: m.count
      };
    });

    // 8. Denominations
    let denominations = [];
    try {
      const [dr] = await db.query(
        'SELECT denomination, kind, count FROM shift_close_denominations WHERE shift_id = ? ORDER BY denomination DESC',
        [shiftId]
      );
      denominations = dr.map(d => ({
        value: Number(d.denomination), kind: d.kind, count: Number(d.count)
      }));
    } catch (e) {
      // Fallback to denominations_json — real fallback chain, but the cash
      // breakdown is financial data so the primary failure gets logged.
      console.error('[GET /shifts/:id/full-report] denominations query failed:', e.message);
      try {
        if (s.denominations_json) denominations = JSON.parse(s.denominations_json);
      } catch (_) { /* both sources unavailable — report renders "no cash recorded" */ }
    }

    const totalActual   = methodsTable.reduce((sum, m) => sum + m.actual,   0);
    const totalExpected = methodsTable.reduce((sum, m) => sum + m.expected, 0);
    const totalVariance = totalActual - totalExpected;

    res.json({
      shiftId: s.id,
      status: s.status,
      cashier: { username: s.username, name: cashierName, empNo: cashierEmpNo },
      branch: { name: branchName, address: branchAddress, companyName: branchCompanyName },
      company: {
        name: companyName, nameAr: 'المذاق المغربي',
        taxNumber, currency, phone: companyPhone, email: companyEmail, logo: companyLogo
      },
      times: {
        start: s.start_time, end: s.end_time,
        durationMs: (s.end_time && s.start_time) ? (new Date(s.end_time) - new Date(s.start_time)) : null
      },
      financials: {
        openingFloat: Number(s.opening_float || 0),
        expectedTotal: totalExpected,
        actualTotal:   totalActual,
        variance:      totalVariance,
        unmatched:     agg.unmatchedTotal,
        // W2-A — the ± term the X/Z report must show: without it the printed
        // «المتوقع» silently differs from opening float + sales by exactly the
        // movements, and there is nothing on the paper that explains it.
        payIn:  agg.movementTotals.payIn,
        payOut: agg.movementTotals.payOut
      },
      methods: methodsTable,
      // Itemised drawer movements — the reason each one happened and who
      // authorized it, printed on the X and Z reports.
      movements: agg.movements,
      movementTotals: agg.movementTotals,
      soldItems: agg.soldItems,
      denominations,
      orderCount: agg.orderCount,
      itemsCount: agg.soldItems.reduce((s, i) => s + (Number(i.qty) || 0), 0),
      notes: s.cashier_notes || '',
      // Diagnostics for the rare cases when aggregation skips a sale
      unmatchedDetails: agg.unmatchedDetails
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// V5.7.19 — Thermal-printer-friendly HTML page for a shift report.
//   Wired to the admin shifts list "🖨 طباعة" button: opens in a new tab,
//   auto-prints, sized for 80mm thermal paper but degrades cleanly on A4.
//   Uses the SAME data source as /full-report (single round-trip).
router.get('/:shiftId/full-report-print', async (req, res) => {
  try {
    const { shiftId } = req.params;
    // G-SALES (Mission 2) — this route was served ANONYMOUSLY via a server.js
    // exemption (print-in-new-tab had no JS auth headers). The route is now
    // JWT-safe on its own: it reads the standard Authorization header (the
    // React caller sends it) even while the legacy exemption is still in
    // place, and requires the shift owner or a manager-level capability.
    const user = _userFromRequest(req);
    if (!user || !user.username) {
      return res.status(401).type('text/plain').send('401 Unauthorized — تسجيل الدخول مطلوب لعرض تقرير الوردية');
    }
    const [shifts] = await db.query('SELECT * FROM shifts WHERE id = ?', [shiftId]);
    if (!shifts.length) return res.status(404).send('Shift not found');
    const s = shifts[0];
    if (!(await _canViewShiftReport(user, s.username))) {
      return res.status(403).type('text/plain').send('403 Forbidden — صلاحية غير كافية لعرض تقرير هذه الوردية');
    }
    // Same single rule as the sale receipt (lib/displayName.js) — this is the
    // server-rendered full shift report, printed on the same paper.
    const _printCashier = await displayName.resolveCashierIdentity(db, s.username);
    const cashierName = _printCashier.name, cashierEmpNo = _printCashier.empNo;
    let branchName = '', branchAddress = '', branchCompanyName = '';
    try {
      let branchId = s.branch_id;
      if (!branchId) {
        const [ub] = await db.query('SELECT branch_id FROM user_branches WHERE username = ? LIMIT 1', [s.username]);
        if (ub.length) branchId = ub[0].branch_id;
      }
      if (branchId) {
        const [br] = await db.query('SELECT name, location, company_name FROM branches WHERE id = ?', [branchId]);
        if (br.length) {
          branchName = br[0].name || '';
          branchAddress = br[0].location || '';
          branchCompanyName = br[0].company_name || '';
        }
      }
    } catch (_) { /* cosmetic — report header labels only */ }
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
    } catch (_) { /* cosmetic — company header labels; defaults already set */ }

    const agg = await aggregateShiftPayments(shiftId, Number(s.opening_float || 0));
    let savedActuals = {}, savedBreakdown = null;
    try {
      if (s.payment_totals_json) {
        const parsed = typeof s.payment_totals_json === 'string'
          ? JSON.parse(s.payment_totals_json) : s.payment_totals_json;
        if (parsed) {
          savedActuals   = parsed.actualsById || parsed.actuals || {};
          savedBreakdown = parsed.breakdown || null;
        }
      }
    } catch (e) {
      // G-SALES error honesty — corrupt saved reconciliation degrades to
      // legacy columns; keep the fallback but log it (financial data).
      console.error('[GET /shifts/:id/full-report-print] payment_totals_json parse failed:', e.message);
    }
    const norm = _normPM;
    const methodsTable = agg.methods.map(m => {
      let actual = null;
      if (savedBreakdown) {
        const b = savedBreakdown.find(x => String(x.id) === String(m.id));
        if (b) actual = Number(b.actual) || 0;
      }
      if (actual == null && savedActuals[m.id] != null)         actual = Number(savedActuals[m.id]) || 0;
      if (actual == null && savedActuals[String(m.id)] != null) actual = Number(savedActuals[String(m.id)]) || 0;
      if (actual == null) {
        const k = norm(m.name);
        if (savedActuals[k] != null) actual = Number(savedActuals[k]) || 0;
      }
      if (actual == null) {
        if (m.groupType === 'cash')                                          actual = Number(s.actual_cash) || 0;
        else if (m.groupType === 'electronic' || m.groupType === 'card')    actual = Number(s.actual_card) || 0;
        else if (m.groupType === 'voucher' || norm(m.name) === 'kita')      actual = Number(s.actual_kita) || 0;
        else                                                                 actual = 0;
      }
      return { id: m.id, name: m.name, nameAr: m.nameAr, icon: m.icon, color: m.color,
               groupType: m.groupType, expected: m.expectedAmount,
               actual, variance: actual - m.expectedAmount, count: m.count };
    });
    let denominations = [];
    try {
      const [dr] = await db.query(
        'SELECT denomination, kind, count FROM shift_close_denominations WHERE shift_id = ? ORDER BY denomination DESC',
        [shiftId]
      );
      denominations = dr.map(d => ({ value: Number(d.denomination), kind: d.kind, count: Number(d.count) }));
    } catch (e) {
      // Real fallback chain (denominations_json), but cash breakdown is
      // financial data — log the primary failure instead of hiding it.
      console.error('[GET /shifts/:id/full-report-print] denominations query failed:', e.message);
      try { if (s.denominations_json) denominations = JSON.parse(s.denominations_json); }
      catch (_) { /* both sources unavailable — report renders "no cash recorded" */ }
    }
    const totalActual   = methodsTable.reduce((sum, m) => sum + m.actual,   0);
    const totalExpected = methodsTable.reduce((sum, m) => sum + m.expected, 0);
    const totalVariance = totalActual - totalExpected;

    // Render the thermal HTML inline (mirror of POS-side printShiftThermalReport)
    // v7.5 — XSS hardening: this endpoint is public (server.js whitelist for
    //   print-in-new-tab), so EVERY db-sourced string must be entity-escaped
    //   before interpolation into the HTML below.
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = v => Number(v || 0).toFixed(2);
    // en-GB: 'ar-SA' printed the shift's open/close stamps in Arabic-Indic
    // digits ("١‏/٧‏/٢٠٢٦، ١٢:٠٠:٠٠ ص") on a thermal report whose every other
    // number is Latin. Day-first Gregorian, Latin digits, matching the app.
    const fmtDt = v => { try { return new Date(v).toLocaleString('en-GB', { calendar:'gregory', numberingSystem:'latn' }); } catch(e) { return v || '—'; } };
    const fmtDur = ms => {
      if (!ms || ms < 0) return '—';
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
      return (h > 0 ? h + 'س ' : '') + m + 'د';
    };
    const durationMs = (s.end_time && s.start_time) ? (new Date(s.end_time) - new Date(s.start_time)) : null;
    const itemsCount = agg.soldItems.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
    const denomsFiltered = denominations.filter(x => Number(x.count) > 0).sort((a, b) => Number(b.value) - Number(a.value));
    const sumDenoms = denomsFiltered.reduce((sum, x) => sum + Number(x.value) * Number(x.count), 0);

    function row(label, value, opts = {}) {
      return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;${opts.border?'border-bottom:1px dashed #999;':''}">
                <span style="color:#000;${opts.bold?'font-weight:700;':''}">${label}</span>
                <span style="color:#000;font-family:monospace;${opts.bold?'font-weight:800;':''}">${value}</span>
              </div>`;
    }

    const headerHtml =
      (companyLogo ? `<div style="text-align:center;margin-bottom:6px;"><img src="${esc(companyLogo)}" style="max-width:90px;max-height:90px;object-fit:contain;"></div>` : '') +
      `<div style="text-align:center;font-size:13px;font-weight:700;direction:rtl;margin-bottom:1px;">المذاق المغربي</div>` +
      `<div style="text-align:center;font-size:18px;font-weight:900;direction:ltr;margin-bottom:${branchCompanyName?'2':'6'}px;">${esc(companyName)}</div>` +
      (branchCompanyName ? `<div style="text-align:center;font-size:12px;font-weight:700;color:#000;direction:rtl;margin-bottom:6px;border-bottom:1px solid #d4d4d4;padding-bottom:6px;">${esc(branchCompanyName)}</div>` : '') +
      `<div style="text-align:center;font-size:11px;direction:rtl;margin-bottom:2px;">تقرير إقفال الوردية</div>` +
      `<div style="text-align:center;font-size:10px;color:#444;margin-bottom:6px;">SHIFT CLOSING REPORT</div>` +
      (taxNumber ? `<div style="text-align:center;font-size:10px;font-family:monospace;color:#444;margin-bottom:4px;">${esc(taxNumber)}</div>` : '') +
      (branchName ? `<div style="text-align:center;font-size:11px;font-weight:700;direction:ltr;">${esc(String(branchName).toUpperCase())}</div>` : '') +
      (branchAddress ? `<div style="text-align:center;font-size:9px;color:#666;direction:rtl;margin-bottom:4px;">${esc(branchAddress)}</div>` : '');

    const metaHtml = `<div style="border-top:1px dashed #000;border-bottom:1px dashed #000;padding:6px 0;margin:8px 0;">
      ${row('رقم الوردية', s.id, { bold: true })}
      ${row('الكاشير', `${esc(cashierName)}${cashierEmpNo && cashierEmpNo !== cashierName ? ' (' + esc(cashierEmpNo) + ')' : ''}`, { bold: true })}
      ${row('وقت الفتح', fmtDt(s.start_time))}
      ${row('وقت الإغلاق', fmtDt(s.end_time))}
      ${row('مدة الوردية', fmtDur(durationMs))}
      ${row('عدد الفواتير', String(agg.orderCount || 0), { bold: true })}
      ${row('عدد الأصناف', String(itemsCount), { bold: true })}
    </div>`;

    let itemsHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">الأصناف المباعة | ITEMS SOLD</div>`;
    if (!agg.soldItems.length) itemsHtml += `<div style="text-align:center;font-size:10px;color:#999;padding:6px;">— لا توجد أصناف —</div>`;
    else {
      itemsHtml += `<table style="width:100%;border-collapse:collapse;font-size:10.5px;">
        <thead><tr style="border-bottom:1px solid #000;">
          <th style="text-align:right;padding:3px 0;font-size:10px;">الصنف</th>
          <th style="text-align:center;padding:3px 0;font-size:10px;">الكمية</th>
          <th style="text-align:center;padding:3px 0;font-size:10px;">السعر</th>
          <th style="text-align:left;padding:3px 0;font-size:10px;">الإجمالي</th>
        </tr></thead><tbody>`;
      agg.soldItems.forEach(it => {
        itemsHtml += `<tr>
          <td style="padding:2px 0;">${esc(it.name) || '—'}</td>
          <td style="text-align:center;padding:2px 0;">${Number(it.qty) || 0}</td>
          <td style="text-align:center;padding:2px 0;font-family:monospace;">${fmt(it.price)}</td>
          <td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:700;">${fmt(it.total)}</td>
        </tr>`;
      });
      itemsHtml += `</tbody></table>`;
    }

    let denomsHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">فئات النقد | CASH BREAKDOWN</div>`;
    if (!denomsFiltered.length) denomsHtml += `<div style="text-align:center;font-size:10px;color:#999;padding:6px;">— لم يُسجَّل نقد —</div>`;
    else {
      denomsHtml += `<table style="width:100%;border-collapse:collapse;font-size:10.5px;">`;
      denomsFiltered.forEach(x => {
        const subtotal = Number(x.value) * Number(x.count);
        const faceLabel = Number(x.value) < 1 ? `${Number(x.value) * 100} هـ` : `${Number(x.value)} SAR`;
        denomsHtml += `<tr>
          <td style="padding:2px 0;font-weight:700;">${faceLabel}</td>
          <td style="text-align:center;padding:2px 0;">×</td>
          <td style="text-align:center;padding:2px 0;font-weight:700;">${Number(x.count)}</td>
          <td style="text-align:center;padding:2px 0;">=</td>
          <td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:800;">${fmt(subtotal)}</td>
        </tr>`;
      });
      denomsHtml += `</table>
        <div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;font-size:11px;font-weight:800;display:flex;justify-content:space-between;">
          <span>إجمالي النقد المعدود:</span>
          <span style="font-family:monospace;">${fmt(sumDenoms)} ${currency}</span>
        </div>`;
    }

    // W2-A — drawer movements. Printed ONLY when the shift has any, so an
    // untouched drawer's report is byte-identical to what it printed before.
    // This is the paper trail for the ± term now inside «المتوقع»: without it
    // the expected figure moves and nothing on the receipt says why.
    let movementsHtml = '';
    if (agg.movements && agg.movements.length) {
      movementsHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">حركات نقدية على الدرج | TILL MOVEMENTS</div>
        <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
          <thead><tr style="border-bottom:1px solid #000;">
            <th style="text-align:right;padding:3px 0;font-size:9.5px;">السبب</th>
            <th style="text-align:center;padding:3px 0;font-size:9.5px;">النوع</th>
            <th style="text-align:center;padding:3px 0;font-size:9.5px;">اعتمده</th>
            <th style="text-align:left;padding:3px 0;font-size:9.5px;">المبلغ</th>
          </tr></thead><tbody>`;
      agg.movements.forEach((mvr) => {
        const isIn = mvr.kind === 'pay_in';
        movementsHtml += `<tr>
          <td style="padding:2px 0;font-weight:700;">${esc(mvr.reason) || '—'}</td>
          <td style="text-align:center;padding:2px 0;">${isIn ? 'إيداع' : 'سحب'}</td>
          <td style="text-align:center;padding:2px 0;font-size:9.5px;">${esc(mvr.approvedBy) || '—'}</td>
          <td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:800;">${isIn ? '+' : '−'}${fmt(mvr.amount)}</td>
        </tr>`;
      });
      movementsHtml += `</tbody></table>
        <div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;font-size:10.5px;font-weight:800;display:flex;justify-content:space-between;">
          <span>صافي الحركات:</span>
          <span style="font-family:monospace;">${agg.movementTotals.net > 0 ? '+' : ''}${fmt(agg.movementTotals.net)} ${currency}</span>
        </div>`;
    }

    let methodsHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">تسوية طرق الدفع | PAYMENT RECONCILIATION</div>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
        <thead><tr style="border-bottom:1px solid #000;">
          <th style="text-align:right;padding:3px 0;font-size:9.5px;">الطريقة</th>
          <th style="text-align:center;padding:3px 0;font-size:9.5px;">المتوقع</th>
          <th style="text-align:center;padding:3px 0;font-size:9.5px;">الفعلي</th>
          <th style="text-align:left;padding:3px 0;font-size:9.5px;">الفرق</th>
        </tr></thead><tbody>`;
    methodsTable.forEach(m => {
      const diffPrefix = m.variance > 0 ? '+' : '';
      methodsHtml += `<tr>
        <td style="padding:2px 0;font-weight:700;">${esc(m.nameAr || m.name)}</td>
        <td style="text-align:center;padding:2px 0;font-family:monospace;">${fmt(m.expected)}</td>
        <td style="text-align:center;padding:2px 0;font-family:monospace;font-weight:700;">${fmt(m.actual)}</td>
        <td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:800;">${diffPrefix}${fmt(m.variance)}</td>
      </tr>`;
    });
    methodsHtml += `<tr style="border-top:1px solid #000;font-weight:900;">
        <td style="padding:3px 0;">الإجمالي</td>
        <td style="text-align:center;padding:3px 0;font-family:monospace;">${fmt(totalExpected)}</td>
        <td style="text-align:center;padding:3px 0;font-family:monospace;">${fmt(totalActual)}</td>
        <td style="text-align:left;padding:3px 0;font-family:monospace;">${totalVariance > 0 ? '+' : ''}${fmt(totalVariance)}</td>
      </tr></tbody></table>`;

    // V5.7.21 — offsetting-variances warning REMOVED per user direction:
    //   when net = 0, the report reads "balanced" regardless of
    //   per-method offsetting diffs. Per-method numbers are still in
    //   the table above for transparency.

    const varianceLabel = Math.abs(totalVariance) < 0.01 ? 'متطابق ✓' : (totalVariance < 0 ? 'عجز' : 'زيادة');
    const summaryHtml = `<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">ملخص الإغلاق | SUMMARY</div>
      <div style="border:1.5px solid #000;padding:6px 8px;margin:4px 0;">
        ${row('الرصيد الافتتاحي', `${fmt(s.opening_float)} ${currency}`)}
        ${agg.movementTotals.payIn ? row('إيداعات على الدرج (+)', `${fmt(agg.movementTotals.payIn)} ${currency}`) : ''}
        ${agg.movementTotals.payOut ? row('سحوبات من الدرج (−)', `${fmt(agg.movementTotals.payOut)} ${currency}`) : ''}
        ${row('إجمالي المبيعات (متوقع)', `${fmt(totalExpected)} ${currency}`, { bold: true })}
        ${row('إجمالي الجرد الفعلي', `${fmt(totalActual)} ${currency}`, { bold: true })}
        ${row(`الفرق (${varianceLabel})`, `${totalVariance > 0 ? '+' : ''}${fmt(totalVariance)} ${currency}`, { bold: true })}
      </div>`;

    const notesHtml = s.cashier_notes
      ? `<div style="margin-top:8px;padding:6px;border:1px dashed #999;font-size:10px;direction:rtl;">
           <div style="font-weight:700;margin-bottom:3px;">📝 ملاحظات:</div>
           <div style="white-space:pre-wrap;">${esc(s.cashier_notes)}</div>
         </div>`
      : '';

    const sigHtml = `<div style="margin-top:12px;display:flex;gap:6px;justify-content:space-between;">
      <div style="flex:1;text-align:center;"><div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">المستلم</div></div>
      <div style="flex:1;text-align:center;"><div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">${esc(cashierName || s.username)}</div></div>
      <div style="flex:1;text-align:center;"><div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">الإدارة</div></div>
    </div>`;

    const footerHtml = `<div style="text-align:center;margin-top:8px;font-size:9px;color:#444;border-top:1px dashed #000;padding-top:4px;">
      وثيقة موثّقة آلياً — Moroccan Taste POS<br>
      طُبع: ${fmtDt(new Date())}
      ${companyPhone ? `<br>Tel: ${esc(companyPhone)}` : ''}
      ${companyEmail ? `<br>Email: ${esc(companyEmail)}` : ''}
    </div>`;

    // V5.7.21 — read user's language from query param OR cookie OR
    //   fallback to ar. Embed the translator so English mode flips
    //   labels before window.print() runs.
    const userLang = (req.query.lang === 'en' || req.query.lang === 'ar') ? req.query.lang : 'ar';
    const dirAttr = userLang === 'en' ? 'ltr' : 'rtl';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="${userLang}" dir="${dirAttr}"><head><meta charset="UTF-8">
      <title>Shift Report — ${esc(s.id)}</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        body{font-family:"Helvetica Neue",Arial,"Segoe UI",sans-serif;padding:10px;width:300px;margin:0 auto;font-size:12px;color:#000;background:#fff;}
        table{border-collapse:collapse;}
        @media print{@page{margin:0;size:80mm auto;}body{padding:4px;width:100%;}}
      </style>
      <script src="/shared/dynamic-i18n.js?v=2"></script>
      </head><body>
      ${headerHtml}${metaHtml}${itemsHtml}${denomsHtml}${movementsHtml}${methodsHtml}${summaryHtml}${notesHtml}${sigHtml}${footerHtml}
      <script>(function(){
        try {
          // V5.7.21 — same lang-aware print-trigger as the POS-side window
          var saved = '';
          try { saved = localStorage.getItem('pos_lang') || localStorage.getItem('emp_lang') || ''; } catch(e){}
          var lang = ${JSON.stringify(userLang)} || saved || 'ar';
          if (lang === 'en' && window.DynamicI18N) {
            window.DynamicI18N.translatePage('en').then(function(){
              setTimeout(function(){ window.print(); }, 300);
            }).catch(function(){ setTimeout(function(){ window.print(); }, 500); });
          } else {
            setTimeout(function(){ window.print(); }, 400);
          }
        } catch(e) { setTimeout(function(){ window.print(); }, 400); }
      })();<\/script>
      </body></html>`);
  } catch (e) {
    // v7.5 — plain text so a reflected error message can never execute as HTML
    res.status(500).type('text/plain').send('Error: ' + e.message);
  }
});

// Get all shifts
// G-SALES/bilingual-i18n-images (Owner A) — this route had NO authz guard and
// NO branch/username filter at all: any authenticated caller (any role) could
// list every shift, system-wide, including another cashier's drawer counts.
// Now: every non-supervisor role is self-scoped (own username only, no
// capability gate); supervisors default to their own resolved brand
// (_resolveShiftBrandScope), with the same allBranches+capability bypass
// routes/pos-v2.js uses.
router.get('/', async (req, res) => {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    const where = ['1=1'];
    const params = [];
    let join = '';

    if (req.query.startDate) { where.push('DATE(shifts.start_time) >= ?'); params.push(req.query.startDate); }
    if (req.query.endDate) { where.push('DATE(shifts.start_time) <= ?'); params.push(req.query.endDate); }
    if (req.query.status) { where.push('shifts.status = ?'); params.push(req.query.status); }

    if (!_isSupervisor(req.user)) {
      // Self-scope — identity from the verified token, never the query string.
      where.push('shifts.username = ?'); params.push(req.user.username);
    } else {
      // Supervisors may still narrow by an explicit ?username=, PLUS the
      // brand scope below (own resolved brand by default). NULL branch_id
      // (pre-migration rows) and NULL-brand branches stay visible to
      // everyone — same "unscoped = global" rule the catalog applies.
      if (req.query.username) { where.push('shifts.username = ?'); params.push(req.query.username); }
      const scope = await _resolveShiftBrandScope(req);
      if (!scope.allBrands) {
        join = ' LEFT JOIN branches ON branches.id = shifts.branch_id';
        where.push('(shifts.branch_id IS NULL OR branches.brand_id IS NULL OR branches.brand_id = ?)');
        params.push(scope.brandId);
      }
    }

    const query = 'SELECT shifts.* FROM shifts' + join + ' WHERE ' + where.join(' AND ') + ' ORDER BY shifts.start_time DESC LIMIT 200';
    const [rows] = await db.query(query, params);
    // Display names for the whole page — the bulk form of the same one rule
    // (lib/displayName.js): two queries total, not two per row.
    const userMap = await displayName.resolveCashierIdentities(db, rows.map(s => s.username));
    res.json(rows.map(s => ({
      id: s.id, username: s.username,
      displayName: (userMap[s.username] && userMap[s.username].name) || s.username,
      startTime: s.start_time, endTime: s.end_time, status: s.status,
      totalTheoretical: Number(s.total_theoretical),
      theoreticalCash: Number(s.theoretical_cash),
      theoreticalCard: Number(s.theoretical_card),
      theoreticalKita: Number(s.theoretical_kita),
      actualCash: Number(s.actual_cash),
      actualCard: Number(s.actual_card),
      actualKita: Number(s.actual_kita),
      diffCash: Number(s.diff_cash),
      diffCard: Number(s.diff_card),
      diffKita: Number(s.diff_kita),
      // V5.7.17 — surface the rich JSONs so the printed report has full data
      paymentTotalsJson: s.payment_totals_json || null,
      denominationsJson: s.denominations_json || null,
      cashierNotes:      s.cashier_notes || '',
      openingFloat:      Number(s.opening_float || 0),
      expectedTotal:     Number(s.expected_total || 0),
      actualTotal:       Number(s.actual_total || 0),
      varianceTotal:     Number(s.variance_total || 0),
      geoLat: s.geo_lat ? Number(s.geo_lat) : null,
      geoLng: s.geo_lng ? Number(s.geo_lng) : null,
      geoAddress: s.geo_address || '',
      deviceInfo: s.device_info || '',
      ipAddress: s.ip_address || ''
    })));
  } catch (e) {
    // G-SALES error honesty — an empty [] made a DB failure look like
    // "no shifts exist" on the admin reconciliation screen. Surface it.
    console.error('[GET /shifts]', e.message);
    res.status(500).json({ success: false, error: 'تعذّر تحميل الورديات', code: 'shifts_list_failed' });
  }
});

// Get closing data (theoretical totals for a shift)
router.get('/closing-data/:shiftId', async (req, res) => {
  try {
    const { shiftId } = req.params;

    // ── 1. Pull all active payment methods (drives the dynamic table) ──
    let methods = [];
    try {
      const [rows] = await db.query(
        "SELECT id, name, name_ar, icon, color, group_type FROM payment_methods " +
        "WHERE is_active = 1 AND show_in_shift_close != 0 ORDER BY sort_order, name"
      );
      methods = rows;
    } catch (_) {
      // Legacy DB without payment_methods.show_in_shift_close column
      try {
        const [rows] = await db.query(
          "SELECT id, name, name_ar FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, name"
        );
        methods = rows;
      } catch (e2) {
        // No payment_methods table at all — synthetic fallbacks below keep
        // totals correct, but log it (feeds the closing reconciliation).
        console.error('[GET /shifts/closing-data] payment_methods unavailable:', e2.message);
        methods = [];
      }
    }

    // ── 2. Pull sales for this shift ──
    const [sales] = await db.query(
      'SELECT id, payment_method, total_final, kita_service_fee FROM sales WHERE shift_id = ?',
      [shiftId]
    );
    const orderCount = sales.length;

    // ── 3. SMART MATCHER (V5.7.14 — robust Arabic normalization) ──
    //   Two-tier lookup:
    //     (a) EXACT match on normalized name / name_ar / id  ← strict, wins first
    //     (b) ALIAS match (mada/visa/...) only if no exact match found
    //   Arabic normalization unifies common variant characters that the
    //   user types interchangeably:
    //     ى (U+0649 alif maksura) → ي (U+064A yaa)   (مدى ↔ مدي)
    //     ة (U+0629 taa marbuta)  → ه                 (شبكة ↔ شبكه)
    //     أ إ آ ا → ا                                 (any alif form)
    //     diacritics  ً ٌ ٍ َ ُ ِ ّ ْ → stripped
    //     trailing whitespace + lowercase
    //   This made "مدي 37 sales" + "مدى/شبكة 5 sales" both resolve cleanly
    //   to whichever method the cashier intended (the bug where 32 of 37
    //   Mada sales fell through to "unmatched").
    function norm(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[ً-ْ]/g, '')      // strip diacritics
        .replace(/[أإآا]/g, 'ا')               // unify alif forms
        .replace(/ى/g, 'ي')                   // alif maksura → yaa
        .replace(/ة/g, 'ه')                   // taa marbuta → haa
        .trim();
    }
    const exactLookup = {};   // exact name / name_ar / id keys
    const aliasLookup = {};   // group-based aliases (mada, visa, …)
    const ELECTRONIC_ALIASES = ['mada','visa','master','mastercard','amex','network','شبكة','مدى','مدي','بطاقة'];
    const CASH_ALIASES = ['cash','نقد','كاش','نقدي'];
    const KITA_ALIASES = ['kita','كيتا','آجل','ajl','اجل'];

    function indexMethodExact(m) {
      [norm(m.name), norm(m.name_ar), String(m.id)].forEach(k => {
        if (k && !exactLookup[k]) exactLookup[k] = m;
      });
      // Tokens of name_ar split on common separators
      String(m.name_ar || '').split(/[\/،\-,]/).forEach(p => {
        const k = norm(p);
        if (k && !exactLookup[k]) exactLookup[k] = m;
      });
    }
    function indexMethodAlias(m) {
      let aliases = [];
      const gt = m.group_type;
      if (gt === 'electronic' || gt === 'card')   aliases = ELECTRONIC_ALIASES;
      else if (gt === 'cash' || norm(m.name) === 'cash') aliases = CASH_ALIASES;
      else if (gt === 'voucher' || norm(m.name) === 'kita') aliases = KITA_ALIASES;
      aliases.map(norm).forEach(k => {
        // Don't overwrite an exact match with an alias
        if (k && !exactLookup[k] && !aliasLookup[k]) aliasLookup[k] = m;
      });
    }
    // Pass 1: exact keys for every method (first-seen wins on ties)
    methods.forEach(indexMethodExact);
    // Pass 2: aliases (only fill keys not claimed by exact)
    methods.forEach(indexMethodAlias);
    // Fallback synthetic methods so reports never lose data when no method exists at all
    function ensureSynthetic(syntheticId, name, name_ar, group_type) {
      const aliasKey = norm(name);
      if (exactLookup[aliasKey] || aliasLookup[aliasKey]) return;
      const synth = { id: syntheticId, name, name_ar, group_type, _synthetic: true };
      methods.push(synth);
      indexMethodExact(synth);
      indexMethodAlias(synth);
    }
    ensureSynthetic('_cash',       'Cash',       'نقدي / كاش',  'cash');
    ensureSynthetic('_electronic', 'Card / Mada','شبكة / مدى',  'electronic');
    ensureSynthetic('_kita',       'Kita',       'كيتا / آجل',  'voucher');

    function findMethod(rawKey) {
      // Try exact first, then alias
      return exactLookup[rawKey] || aliasLookup[rawKey] || null;
    }

    // ── 4. Aggregate sale totals per matched method ──
    const expectedById = {}; // method.id → amount
    const countById = {};    // method.id → number of sales attributed
    let expectedTotal = 0;
    let unmatchedTotal = 0;
    const unmatchedDetails = []; // for debugging — methods that didn't resolve
    function credit(rawMethod, amount) {
      const key = norm(rawMethod);
      const m = findMethod(key);
      if (m) {
        expectedById[m.id] = _r2((expectedById[m.id] || 0) + amount);
        countById[m.id]    = (countById[m.id]    || 0) + 1;
      } else {
        unmatchedTotal = _r2(unmatchedTotal + amount);
        unmatchedDetails.push({ raw: rawMethod, normalized: key, amount });
      }
      expectedTotal = _r2(expectedTotal + amount);
    }
    for (const sale of sales) {
      const total = _r2(sale.total_final);
      const pmRaw = sale.payment_method || 'cash';
      // W0-A — decimal-safe leg read (shared _parseSplitLegs); "مدى/شبكة"
      // (no ':') still falls through to the single-method branch.
      const legs = _parseSplitLegs(pmRaw);
      if (legs) {
        for (const leg of legs) credit(leg.method, leg.amount);
      } else {
        // Single payment — handles names like "مدى/شبكة" that contain '/'
        credit(pmRaw, total);
      }
    }

    // ── 5. Aggregate sold items (the missing piece — items table on report) ──
    let soldItems = [];
    try {
      const [items] = await db.query(
        'SELECT si.item_name AS name, si.qty, si.price, si.total ' +
        'FROM sales_items si JOIN sales s ON s.id = si.order_id ' +
        'WHERE s.shift_id = ? ORDER BY si.item_name',
        [shiftId]
      );
      // Group by name (server-side aggregation matches the report's behavior)
      const agg = {};
      for (const it of items) {
        const n = String(it.name || 'غير معروف');
        if (!agg[n]) agg[n] = { name: n, qty: 0, price: Number(it.price) || 0, total: 0 };
        agg[n].qty   += Number(it.qty)   || 0;
        agg[n].total += Number(it.total) || 0;
      }
      soldItems = Object.values(agg).sort((a, b) => b.qty - a.qty);
    } catch (e) {
      // G-SALES error honesty — feeds the closing report's items table; keep
      // the [] fallback (must not block the close flow) but log the failure.
      console.error('[GET /shifts/closing-data] sold-items query failed:', e.message);
      soldItems = [];
    }

    // ── 6. Back-compat shape (theoreticalCash/Card/Kita) ──
    //      Old POS clients still read these. Map by group_type.
    let theoreticalCash = 0, theoreticalCard = 0, theoreticalKita = 0;
    methods.forEach(m => {
      const amt = expectedById[m.id] || 0;
      const gt = m.group_type;
      if (gt === 'cash')                                   theoreticalCash += amt;
      else if (gt === 'electronic' || gt === 'card')       theoreticalCard += amt;
      else if (gt === 'voucher' || norm(m.name) === 'kita') theoreticalKita += amt;
      else                                                  theoreticalCash += amt; // safe default
    });

    // V5.7.14 — surface unmatched as its OWN method row so the cashier
    //          immediately sees there's a gap between sales and the report.
    const unmatchedRow = unmatchedTotal > 0 ? [{
      id: '__unmatched',
      name: 'Unmatched',
      nameAr: 'غير مصنّف',
      icon: 'fa-question-circle',
      color: '#f59e0b',
      groupType: 'unmatched',
      expectedAmount: unmatchedTotal,
      count: unmatchedDetails.length,
      _isUnmatched: true,
      // Sample of the raw payment_method strings that fell through (top 5)
      sample: Array.from(new Set(unmatchedDetails.map(d => d.raw))).slice(0, 5)
    }] : [];

    res.json({
      // ── New rich shape ──
      methods: methods
        .filter(m => !m._synthetic || (expectedById[m.id] || 0) > 0)
        .map(m => ({
          id: m.id, name: m.name, nameAr: m.name_ar,
          icon: m.icon || 'fa-money-bill', color: m.color || '#3b82f6',
          groupType: m.group_type,
          expectedAmount: expectedById[m.id] || 0,
          count: countById[m.id] || 0
        }))
        .concat(unmatchedRow),
      soldItems: soldItems,
      unmatchedTotal: unmatchedTotal,
      unmatchedDetails: unmatchedDetails,
      // ── Legacy shape (back-compat) ──
      theoreticalCash, theoreticalCard, theoreticalKita,
      totalTheoretical: expectedTotal,
      orderCount: orderCount
    });
  } catch (e) {
    // G-SALES error honesty — was res.json({error}) with HTTP 200 (the POS
    // close screen showed zero expected totals over a real DB failure).
    console.error('[GET /shifts/closing-data]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE shift
// - Hard-delete by default
// - ?unlinkSales=1 to detach sales from this shift (set shift_id=NULL)
//   instead of keeping them linked to a deleted shift
// - Refuses to delete shifts with linked sales unless ?force=1 is passed
// ═══════════════════════════════════════════════════════════════════
// G-SALES — wipe action: `shifts.delete` (NEW capability, seeded to manager in
// db/migrations/capability-seeds/g-sales.json; admin bypasses inside the guard).
router.delete('/:shiftId', requireCapability('shifts.delete'), async (req, res) => {
  try {
    const { shiftId } = req.params;
    const force = req.query.force === '1' || req.query.force === 'true';
    const unlinkSales = req.query.unlinkSales === '1' || req.query.unlinkSales === 'true';

    // Confirm the shift exists
    const [rows] = await db.query('SELECT id, status FROM shifts WHERE id = ?', [shiftId]);
    if (!rows.length) return res.json({ success: false, error: 'المناوبة غير موجودة' });

    // Count linked sales for safety
    const [cntRows] = await db.query('SELECT COUNT(*) AS c FROM sales WHERE shift_id = ?', [shiftId]);
    const linkedCount = Number(cntRows[0].c || 0);

    if (linkedCount > 0 && !force && !unlinkSales) {
      return res.json({
        success: false,
        requiresConfirm: true,
        linkedSales: linkedCount,
        error: 'المناوبة مرتبطة بـ '+linkedCount+' عملية بيع — أضف force=1 لحذفها مع فصل المبيعات، أو unlinkSales=1 لفصل المبيعات فقط ثم الحذف.'
      });
    }

    // Unlink sales (set shift_id = NULL) rather than cascade-deleting them —
    // losing sales data is almost always a bigger problem than losing a shift record.
    if (linkedCount > 0) {
      await db.query('UPDATE sales SET shift_id = NULL WHERE shift_id = ?', [shiftId]);
    }

    await db.query('DELETE FROM shifts WHERE id = ?', [shiftId]);
    res.json({ success: true, deleted: shiftId, unlinkedSales: linkedCount });
  } catch (e) {
    // G-SALES error honesty — destructive endpoint must never mask failure as 200.
    console.error('[DELETE /shifts/:shiftId]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Bulk delete — same wipe capability as DELETE /:shiftId.
router.post('/bulk-delete', requireCapability('shifts.delete'), async (req, res) => {
  try {
    const { ids, unlinkSales } = req.body;
    if (!ids || !ids.length) return res.json({ success: false, error: 'لم يُحدَّد أي معرّف' });
    const placeholders = ids.map(() => '?').join(',');
    if (unlinkSales) {
      await db.query('UPDATE sales SET shift_id = NULL WHERE shift_id IN ('+placeholders+')', ids);
    }
    const [r] = await db.query('DELETE FROM shifts WHERE id IN ('+placeholders+')', ids);
    res.json({ success: true, deleted: r.affectedRows || ids.length });
  } catch (e) {
    // G-SALES error honesty — destructive endpoint must never mask failure as 200.
    console.error('[POST /shifts/bulk-delete]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
