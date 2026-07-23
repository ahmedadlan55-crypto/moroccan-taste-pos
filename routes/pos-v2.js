/**
 * Cashier V2 — cart lifecycle API. Mounted at /api/pos/v2 (server.js).
 *
 * SCOPE: this layer owns ONLY the order lifecycle (open ⇄ held → submitted →
 * completed, + voided). The FINANCIAL write path stays the battle-tested
 * legacy POST /api/sales (ZATCA chain, GL, stock deduction incl. lots/FEFO,
 * shift totals): /submit freezes the payments and returns the EXACT legacy
 * payload; the client posts it with clientOrderId = pos_orders.id (the legacy
 * route's unique-index idempotency makes retries/offline replays single-shot);
 * /complete links the resulting sale back. Voids/returns AFTER completion go
 * through the legacy credit-note flow — never here.
 *
 * Every mutation is implemented as an internal do*() function used by BOTH the
 * HTTP handlers and POST /sync (offline batch replay) — one logic path.
 * Conventions mirror routes/inventory-transactions.js: actor from JWT,
 * expectedVersion conditional UPDATEs (→ 409 VERSION_CONFLICT), Idempotency-Key
 * on /submit, unified error envelope, db.withTransaction + FOR UPDATE.
 * RBAC: POS roles (admin/manager/cashier); credit sales + above-ceiling
 * discounts are supervisor-gated SERVER-SIDE (never just hidden buttons).
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db/connection');
const M = require('../lib/posOrderMachine');
const C = require('../lib/inventoryTxContract');
const UC = require('../lib/unitConversion');
const IDEM = require('../lib/idempotencyStore');
const invoiceIdentity = require('../lib/invoiceIdentity');
const requireRole = require('../middleware/auth').requireRole;
const hasCapability = require('../middleware/requireCapability').hasCapability;

const POS = requireRole('admin', 'manager', 'cashier');

// Brand/branch scope fix (bilingual-i18n-images, Owner A). Every catalog/order
// caller — INCLUDING admin/manager — defaults to their OWN resolved brand
// (see _cashierBrandId / _resolveBrandScope below). This capability is the
// ONLY way to widen that to ?brandId=/?allBranches=1 — introduced here, not
// yet seeded anywhere; report it to the wiring stage to grant it.
const BRAND_SCOPE_CAP = 'pos.catalog.viewAllBrands';

// Cashier order-level discount ceiling (percent of subtotal). Above it → manager.
const MAX_CASHIER_DISC_PCT = (() => { const n = Number(process.env.POS_MAX_CASHIER_DISCOUNT_PCT); return Number.isFinite(n) && n >= 0 ? n : 10; })();

function _userName(user) { return (user && (user.username || user.name)) || ''; }
function _userIsSuper(user) { return ['admin', 'manager'].includes(String((user && user.role) || '').toLowerCase()) || !!(user && user.isDeveloper); }
function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function _fail(res, codeOrErr, message) {
  const code = C.isCanonical(codeOrErr) ? codeOrErr : C.mapError(codeOrErr);
  const msg = message || (codeOrErr && codeOrErr.message) || code;
  return res.status(C.httpFor(code)).json(C.errorBody(code, msg));
}
function _catch(res, e) {
  if (e && e.status === 404) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: e.message || 'not found' });
  if (e && e.code === 'PAYMENT_MISMATCH') return res.status(422).json({ success: false, code: 'PAYMENT_MISMATCH', error: e.message });
  const hasDomain = e && (e.code || (e.status && e.status !== 500));
  if (!hasDomain) return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: (e && e.message) || 'error' });
  return _fail(res, e, e && e.message);
}
const ULID_RE = /^[0-9A-Za-z_-]{10,40}$/;

// ── Additive schema ensure (idempotent, INFORMATION_SCHEMA-guarded) ──────────
// Pattern: routes/sales-channels.js `_ensureUseFullMenuColumn` — checked lazily
// on the first request through this router (module load can precede DB
// readiness) and kicked off once at module init as a best effort.
//   • pos_order_lines.combo_choices_json — the cashier's validated combo picks
//     (legacy [{groupId, menuItemId}] shape) persisted per line so /submit can
//     rebuild the EXACT legacy /api/sales payload for recipe deductions.
//   • pos_payments.method VARCHAR(20) → VARCHAR(50) — owner-configured payment
//     method names (payment_methods.name) exceed the built-in 20-char budget.
//   • pos_orders.branch_id — brand/branch scope fix (bilingual-i18n-images,
//     Owner A): a snapshot of the cashier's branch at order-CREATION time
//     (never rewritten on edits — same convention as name_snapshot /
//     channel_name), so GET /orders can brand-scope supervisors. Reference
//     SQL lives in db/migrations/0014_brand_branch_scope.sql; this ensure
//     keeps the router self-sufficient until that (or the server.js wiring
//     stage) lands.
//   • menu_category_i18n — AR→EN category-name overlay for the catalog's
//     categoryEn field. Reference SQL in db/migrations/0013_bilingual_catalog.sql.
let _schemaEnsured = false;
async function _ensureSchema() {
  if (_schemaEnsured) return;
  const [col] = await db.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_order_lines' AND COLUMN_NAME = 'combo_choices_json'");
  if (!col.length) {
    await db.query('ALTER TABLE pos_order_lines ADD COLUMN combo_choices_json TEXT NULL');
    console.log('[pos-v2] added pos_order_lines.combo_choices_json');
  }
  const [mcol] = await db.query(
    "SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_payments' AND COLUMN_NAME = 'method'");
  if (mcol.length && Number(mcol[0].len) < 50) {
    await db.query('ALTER TABLE pos_payments MODIFY method VARCHAR(50) NOT NULL');
    console.log('[pos-v2] widened pos_payments.method to VARCHAR(50)');
  }
  const [bcol] = await db.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_orders' AND COLUMN_NAME = 'branch_id'");
  if (!bcol.length) {
    await db.query('ALTER TABLE pos_orders ADD COLUMN branch_id VARCHAR(50) NULL');
    console.log('[pos-v2] added pos_orders.branch_id');
  }
  const [catTbl] = await db.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu_category_i18n'");
  if (!catTbl.length) {
    await db.query(
      'CREATE TABLE menu_category_i18n (' +
      'category_ar VARCHAR(100) PRIMARY KEY, ' +
      'category_en VARCHAR(100) NULL, ' +
      'updated_by VARCHAR(100) NULL, ' +
      'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' +
      ') ENGINE=InnoDB');
    console.log('[pos-v2] created menu_category_i18n');
  }
  _schemaEnsured = true;
}
_ensureSchema().catch((e) => console.error('[pos-v2] schema ensure at init failed (will retry on first request):', e.message));
router.use(async (req, res, next) => {
  if (_schemaEnsured) return next();
  try { await _ensureSchema(); } catch (e) { console.error('[pos-v2] schema ensure failed:', e.message); }
  next();
});

async function _loadOrder(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM pos_orders WHERE id=? LIMIT 1' + (conn ? ' FOR UPDATE' : ''), [id]);
  return rows[0] || null;
}
async function _loadLines(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM pos_order_lines WHERE order_id=? ORDER BY sort, id', [id]);
  return rows;
}
async function _loadPayments(id, conn) {
  const q = conn || db;
  const [rows] = await q.query('SELECT * FROM pos_payments WHERE order_id=? ORDER BY id', [id]);
  return rows;
}
// Parse a stored combo_choices_json (server-written legacy shape
// [{groupId, menuItemId}]). Corrupt JSON is loud, never silent — it means a
// write bug, and a combo submitted without its choices would deduct wrong.
function _parseComboChoices(raw, lineId) {
  if (raw == null || raw === '') return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch (e) {
    console.error('[pos-v2] corrupt combo_choices_json on line', lineId, ':', e.message);
    return null;
  }
}

function _linesForMath(rows) {
  // qty is the stored BASE qty; the entered-unit snapshot is carried through for
  // the legacy sale payload (→ items_json → returns echo the same unit).
  return rows.map((l) => ({
    menuId: l.menu_id, nameSnapshot: l.name_snapshot, qty: Number(l.qty), unitPrice: Number(l.unit_price),
    lineDiscount: Number(l.line_discount), vatCategory: l.vat_category, notes: l.notes,
    enteredUnitId: l.entered_unit_id, enteredUnitCode: l.entered_unit_code,
    enteredQty: l.entered_qty != null ? Number(l.entered_qty) : null,
    conversionFactorSnapshot: l.conversion_factor_snapshot != null ? Number(l.conversion_factor_snapshot) : null,
    baseQty: Number(l.qty),
    comboChoices: _parseComboChoices(l.combo_choices_json, l.id),
  }));
}
function _orderForMath(o) {
  return {
    id: o.id, shiftId: o.shift_id, warehouseId: o.warehouse_id, channelId: o.channel_id, channelName: o.channel_name,
    customerId: o.customer_id, discountType: o.discount_type, discountValue: Number(o.discount_value), discountName: o.discount_name,
  };
}
function _publicOrder(o, lines, payments) {
  return {
    id: o.id, status: o.status, orderType: o.order_type, tableNo: o.table_no,
    shiftId: o.shift_id, username: o.username, deviceId: o.device_id,
    warehouseId: o.warehouse_id, customerId: o.customer_id,
    discountType: o.discount_type, discountValue: Number(o.discount_value), discountName: o.discount_name,
    subtotal: Number(o.subtotal), lineDiscountTotal: Number(o.line_discount_total),
    discountTotal: Number(o.discount_total), vatTotal: Number(o.vat_total), total: Number(o.total),
    note: o.note, saleId: o.sale_id, invoiceNumber: o.invoice_number, origin: o.origin,
    version: Number(o.version), heldAt: o.held_at, submittedAt: o.submitted_at,
    completedAt: o.completed_at, voidedAt: o.voided_at, voidReason: o.void_reason,
    createdAt: o.created_at, updatedAt: o.updated_at,
    lines: (lines || []).map((l) => ({ id: l.id, menuId: l.menu_id, name: l.name_snapshot, qty: Number(l.qty), unitPrice: Number(l.unit_price), lineDiscount: Number(l.line_discount), vatCategory: l.vat_category, notes: l.notes, sort: l.sort, comboChoices: _parseComboChoices(l.combo_choices_json, l.id) })),
    payments: (payments || []).map((p) => ({ id: p.id, method: p.method, amount: Number(p.amount), ref: p.ref })),
  };
}

// ── Combo choice validation (server-authoritative) ──────────────────────────
// The V2 client sends `comboChoices` per line as {[groupId]: menuId[]}. The
// choices are validated against the LIVE combo definition (combo_groups /
// combo_group_items — the same tables routes/sales.js expands at deduction
// time): min/max per choice group, configured options only, no duplicates,
// active components only. Returns the LEGACY array shape
// [{groupId, menuItemId}] — EXACTLY what the legacy POS sent to /api/sales.
function _validateComboChoices(m, def, raw) {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw _err('VALIDATION_ERROR', 'خيارات العرض "' + m.name + '" يجب أن تكون كائنًا {groupId: [menuId]}');
  }
  const choiceGroups = (def && def.groups ? def.groups : []).filter((g) => g.type === 'choice');
  const picks = raw || {};
  for (const gid of Object.keys(picks)) {
    if (!choiceGroups.some((g) => g.id === String(gid))) {
      throw _err('VALIDATION_ERROR', 'مجموعة اختيار غير معروفة في العرض "' + m.name + '": ' + gid);
    }
  }
  const out = [];
  for (const g of choiceGroups) {
    const arr = picks[g.id];
    if (arr != null && !Array.isArray(arr)) throw _err('VALIDATION_ERROR', 'اختيارات مجموعة "' + g.name + '" في العرض "' + m.name + '" يجب أن تكون قائمة معرفات');
    const sel = (arr || []).map((x) => String(x));
    if (new Set(sel).size !== sel.length) throw _err('VALIDATION_ERROR', 'خيار مكرر في مجموعة "' + g.name + '" للعرض "' + m.name + '"');
    if (sel.length < g.min) throw _err('VALIDATION_ERROR', 'أكمل اختيارات "' + g.name + '" في العرض "' + m.name + '" — المطلوب ' + g.min + ' على الأقل');
    if (g.max > 0 && sel.length > g.max) throw _err('VALIDATION_ERROR', 'عدد اختيارات "' + g.name + '" يتجاوز الحد الأقصى (' + g.max + ') في العرض "' + m.name + '"');
    for (const menuItemId of sel) {
      const opt = g.options.get(menuItemId);
      if (!opt) throw _err('VALIDATION_ERROR', 'خيار غير صالح في مجموعة "' + g.name + '" للعرض "' + m.name + '": ' + menuItemId);
      if (!opt.active) throw _err('VALIDATION_ERROR', 'الخيار "' + opt.name + '" غير نشط — لا يمكن بيعه ضمن العرض "' + m.name + '"');
      out.push({ groupId: g.id, menuItemId });
    }
  }
  return out;
}

// Load combo definitions (groups + options) for the given combo menu ids.
// Map: menuId → { groups: [{id, name, type, min, max, options: Map<menuId, {name, active}>}] }
async function _loadComboDefs(q, comboIds) {
  const defs = new Map();
  if (!comboIds.length) return defs;
  for (const id of comboIds) defs.set(String(id), { groups: [] });
  const [gRows] = await q.query(
    'SELECT id, menu_id, group_type, name, min_select, max_select FROM combo_groups WHERE menu_id IN (?) ORDER BY sort_order, id', [comboIds]);
  const byGroup = new Map();
  for (const g of gRows) {
    const def = defs.get(String(g.menu_id));
    if (!def) continue;
    const grp = {
      id: String(g.id), name: g.name || '', type: g.group_type === 'fixed' ? 'fixed' : 'choice',
      min: Number(g.min_select) || 0, max: Number(g.max_select) || 0, options: new Map(),
    };
    def.groups.push(grp);
    byGroup.set(grp.id, grp);
  }
  if (byGroup.size) {
    const [iRows] = await q.query(
      'SELECT cgi.group_id, cgi.menu_item_id, cgi.qty, mi.name AS item_name, COALESCE(mi.active,1) AS item_active ' +
      'FROM combo_group_items cgi LEFT JOIN menu mi ON mi.id = cgi.menu_item_id ' +
      'WHERE cgi.group_id IN (?) ORDER BY cgi.sort_order, cgi.id', [[...byGroup.keys()]]);
    for (const it of iRows) {
      const grp = byGroup.get(String(it.group_id));
      if (grp) grp.options.set(String(it.menu_item_id), {
        name: it.item_name || String(it.menu_item_id),
        qty: Number(it.qty) || 1,
        active: !(it.item_active === 0 || it.item_active === false),
      });
    }
  }
  return defs;
}

// ── Channels — the ERP-managed price-resolution chain, server-side ───────────
// Replicates the legacy cashier exactly (public/pos/app.js _doSetChannel +
// _posApplyChannelPrices, backed by routes/channel-menu.js):
//   use_full_menu=1 → every active menu item; price = channel price list (when
//                     linked + active + date-valid) else base menu price.
//                     Per-item channel_menu_items overrides are IGNORED — the
//                     legacy full-menu branch clears channelOverrideMap.
//   use_full_menu=0 → ONLY channel_menu_items rows with is_available=1 (the
//                     owner's "channels are independent" rule: zero configured
//                     items = an EMPTY grid, never a silent MAIN fallback);
//                     price = override_price > price-list price > base.
async function _loadActiveChannel(q, channelId) {
  const [rows] = await q.query(
    'SELECT id, code, name, name_en, channel_type, is_active, price_list_id, COALESCE(use_full_menu,0) AS use_full_menu ' +
    'FROM sales_channels WHERE id=? LIMIT 1', [channelId]);
  if (!rows.length) throw _err('VALIDATION_ERROR', 'قناة البيع غير موجودة: ' + channelId);
  if (!rows[0].is_active) throw _err('VALIDATION_ERROR', 'قناة البيع "' + rows[0].name + '" غير نشطة');
  return rows[0];
}

async function _cashierBranchId(q, user) {
  const uname = _userName(user);
  if (!uname) return null;
  const [u] = await q.query('SELECT branch_id, default_branch_id FROM users WHERE username = ? LIMIT 1', [uname]);
  return u.length ? (u[0].branch_id || u[0].default_branch_id || null) : null;
}

// Brand/branch scope fix — resolve the cashier's BRAND (not just branch):
// users.brand_id directly if set, else the brand of whichever branch they
// belong to (COALESCE(users.branch_id, users.default_branch_id) → branches.brand_id).
// null means "no brand context" — the caller then only sees NULL-brand rows.
async function _cashierBrandId(q, user) {
  const uname = _userName(user);
  if (!uname) return null;
  const [u] = await q.query('SELECT brand_id, branch_id, default_branch_id FROM users WHERE username = ? LIMIT 1', [uname]);
  if (!u.length) return null;
  if (u[0].brand_id) return u[0].brand_id;
  const branchId = u[0].branch_id || u[0].default_branch_id || null;
  if (!branchId) return null;
  const [b] = await q.query('SELECT brand_id FROM branches WHERE id = ? LIMIT 1', [branchId]);
  return b.length ? (b[0].brand_id || null) : null;
}

// Resolve the effective brand scope for a request. EVERY caller — INCLUDING
// admin/manager — defaults to their OWN resolved brand; there is no blanket
// supervisor bypass. ?brandId=<id> or ?allBranches=1 asks for a wider scope,
// honored ONLY when the caller holds BRAND_SCOPE_CAP (checked inline via
// hasCapability — this is conditional on a query flag, not a route-level
// requireCapability gate). Without the capability the params are silently
// ignored and default (own-brand) scoping still applies — never a silent
// widening of access.
async function _resolveBrandScope(q, req) {
  const rawBrandId = req.query && req.query.brandId != null ? String(req.query.brandId).trim() : '';
  const wantsAll = /^(1|true|on|yes)$/i.test(String((req.query && req.query.allBranches) || '').trim());
  if (rawBrandId || wantsAll) {
    let ok = false;
    try { ok = await hasCapability(req.user, BRAND_SCOPE_CAP); } catch (_) { ok = false; }
    if (ok) {
      return rawBrandId ? { brandId: rawBrandId.slice(0, 50), allBrands: false } : { brandId: null, allBrands: true };
    }
    // No capability → bypass params ignored; fall through to default scope.
  }
  const brandId = await _cashierBrandId(q, req.user);
  if (brandId == null) {
    // No resolvable brand context for this caller (never assigned a brand or
    // a branch with a brand). Do NOT restrict to brand_id-IS-NULL-only rows —
    // today's baseline (pre-scope-fix) had zero scoping at all, so "can't
    // determine brand -> show everything" is never a security regression,
    // and it prevents any untagged admin/manager/cashier account from seeing
    // an empty catalog the moment this scope fix ships. Real cross-brand
    // isolation still holds for every account that DOES have a resolvable
    // brand (the common case going forward).
    return { brandId: null, allBrands: true };
  }
  return { brandId, allBrands: false };
}

async function _channelPricing(q, channel, branchId) {
  const out = { priceListId: null, priceListName: null, plMap: {}, overrideMap: null, availableSet: null };
  if (!channel) return out;
  if (channel.price_list_id) {
    const [pl] = await q.query('SELECT id, name, is_active FROM price_lists WHERE id=? LIMIT 1', [channel.price_list_id]);
    if (pl.length && pl[0].is_active !== 0) {
      out.priceListId = pl[0].id;
      out.priceListName = pl[0].name || '';
      // Same date window routes/channel-menu.js applies to price_list_items.
      const today = new Date().toISOString().slice(0, 10);
      const [plItems] = await q.query(
        'SELECT item_id, price FROM price_list_items WHERE price_list_id=? AND item_id IS NOT NULL' +
        ' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)',
        [pl[0].id, today, today]);
      for (const li of plItems) out.plMap[String(li.item_id)] = Number(li.price) || 0;
    }
  }
  if (!channel.use_full_menu) {
    out.overrideMap = {};
    out.availableSet = new Set();
    const conds = ['channel_id = ?']; const params = [channel.id];
    if (branchId) { conds.push('(branch_id = ? OR branch_id IS NULL)'); params.push(branchId); }
    const [rows] = await q.query(
      'SELECT menu_item_id, is_available, override_price FROM channel_menu_items WHERE ' + conds.join(' AND '), params);
    for (const r of rows) {
      if (!r.is_available) continue;
      out.availableSet.add(String(r.menu_item_id));
      if (r.override_price != null) out.overrideMap[String(r.menu_item_id)] = Number(r.override_price);
    }
  }
  return out;
}

// Effective price + provenance for one item under a channel.
// source: null (base menu price) | 'override' (channel_menu_items.override_price)
//         | the price list NAME (price came from the channel's price list).
function _channelPriceFor(pricing, menuId, basePrice) {
  const key = String(menuId);
  if (pricing.overrideMap && pricing.overrideMap[key] != null) return { price: pricing.overrideMap[key], source: 'override' };
  if (pricing.plMap[key] != null) return { price: pricing.plMap[key], source: pricing.priceListName || 'قائمة أسعار' };
  return { price: Number(basePrice) || 0, source: null };
}

// Validate + normalize the incoming lines against the LIVE menu: existence,
// active flag (inactive items are unsellable), qty/price sanity. vat_category
// comes from the menu — never trusted from the client. Combo lines carry
// server-validated choices (see _validateComboChoices). When the order rides a
// sales channel, `chPricing` makes the CHANNEL price the default for lines
// that omit unitPrice (an explicit client unitPrice still wins — manual price
// edits are part of the existing contract).
async function _normalizeLines(q, rawLines, chPricing) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw _err('VALIDATION_ERROR', 'السلة فارغة — أضف صنفًا واحدًا على الأقل');
  if (rawLines.length > 200) throw _err('VALIDATION_ERROR', 'السلة كبيرة جدًا');
  const ids = [...new Set(rawLines.map((l) => String(l.menuId || l.menu_id || '')).filter(Boolean))];
  if (!ids.length) throw _err('VALIDATION_ERROR', 'أسطر بلا معرف صنف');
  const [menu] = await q.query('SELECT id, name, price, active, tax_category, COALESCE(is_combo,0) AS is_combo FROM menu WHERE id IN (?)', [ids]);
  const byId = new Map(menu.map((m) => [String(m.id), m]));
  const comboDefs = await _loadComboDefs(q, menu.filter((m) => Number(m.is_combo) === 1).map((m) => String(m.id)));
  const out = [];
  let sort = 0;
  for (const l of rawLines) {
    const menuId = String(l.menuId || l.menu_id || '');
    const m = byId.get(menuId);
    if (!m) throw _err('VALIDATION_ERROR', 'صنف غير موجود في القائمة: ' + menuId);
    if (m.active === 0 || m.active === false) throw _err('VALIDATION_ERROR', 'الصنف "' + m.name + '" غير نشط — لا يمكن بيعه');
    // Combos: validate the picks against the stored definition; non-combo lines
    // must not smuggle choices (silent-drop would hide a client bug).
    let comboChoicesJson = null;
    if (Number(m.is_combo) === 1) {
      const legacyChoices = _validateComboChoices(m, comboDefs.get(menuId), l.comboChoices);
      comboChoicesJson = legacyChoices.length ? JSON.stringify(legacyChoices) : null;
    } else if (l.comboChoices != null && (typeof l.comboChoices !== 'object' || Array.isArray(l.comboChoices) || Object.keys(l.comboChoices).length)) {
      throw _err('VALIDATION_ERROR', 'الصنف "' + m.name + '" ليس عرضًا — لا تُقبل خيارات عرض عليه');
    }
    const enteredQty = Number(l.qty);
    if (!Number.isFinite(enteredQty) || enteredQty <= 0) throw _err('VALIDATION_ERROR', 'كمية غير صالحة للصنف "' + m.name + '"');
    // Phase U — expand-to-base (owner decision): a line may be entered in a major
    // unit (e.g. scan a carton barcode). qty flowing to stock/sales is ALWAYS base
    // (enteredQty × factor); price is the base price so the line total equals
    // enteredQty × (factor × basePrice) — i.e. price per major unit = factor × base.
    // No unit-price table. Server recomputes base; a client mismatch is rejected.
    let factor = 1, enteredUnitId = null, enteredUnitCode = null;
    if (l.unitFactor != null || l.enteredUnitCode != null || l.enteredUnitId != null) {
      factor = Number(l.unitFactor != null ? l.unitFactor : 1);
      if (!UC.isValidFactor(factor)) throw _err('INVALID_CONVERSION_FACTOR', 'عامل تحويل غير صالح للصنف "' + m.name + '"');
      enteredUnitId = l.enteredUnitId != null ? String(l.enteredUnitId).slice(0, 50) : null;
      enteredUnitCode = l.enteredUnitCode != null ? String(l.enteredUnitCode).slice(0, 30).toUpperCase() : null;
    }
    const qty = UC.round(enteredQty * factor, 6);
    if (l.baseQty != null && UC.round(Number(l.baseQty), 6) !== qty) throw _err('UNIT_CONVERSION_CONFLICT', 'الكمية الأساسية المُرسلة لا تطابق المحسوبة للصنف "' + m.name + '"');
    const defaultPrice = chPricing ? _channelPriceFor(chPricing, menuId, m.price).price : Number(m.price);
    const unitPrice = Number(l.unitPrice != null ? l.unitPrice : defaultPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw _err('VALIDATION_ERROR', 'سعر غير صالح للصنف "' + m.name + '"');
    const lineDiscount = Math.max(0, Number(l.lineDiscount) || 0);
    out.push({
      menuId, nameSnapshot: m.name, qty, unitPrice, lineDiscount,
      vatCategory: ['S', 'Z', 'E', 'O'].includes(m.tax_category) ? m.tax_category : 'S',
      notes: (l.notes || '').toString().slice(0, 300) || null, sort: sort++,
      enteredQty, enteredUnitId, enteredUnitCode, conversionFactorSnapshot: factor,
      comboChoicesJson,
    });
  }
  return out;
}

async function _replaceLines(conn, orderId, lines) {
  await conn.query('DELETE FROM pos_order_lines WHERE order_id=?', [orderId]);
  for (const l of lines) {
    await conn.query(
      'INSERT INTO pos_order_lines (id, order_id, menu_id, name_snapshot, qty, unit_price, line_discount, vat_category, notes, sort, entered_qty, entered_unit_id, entered_unit_code, conversion_factor_snapshot, combo_choices_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ['PL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), orderId, l.menuId, l.nameSnapshot, l.qty, l.unitPrice, l.lineDiscount, l.vatCategory, l.notes, l.sort,
       l.enteredQty != null ? l.enteredQty : l.qty, l.enteredUnitId != null ? l.enteredUnitId : null, l.enteredUnitCode != null ? l.enteredUnitCode : null, l.conversionFactorSnapshot != null ? l.conversionFactorSnapshot : 1,
       l.comboChoicesJson != null ? l.comboChoicesJson : null]);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Internal operations — ONE logic path shared by HTTP handlers and /sync.
// Each returns a JSON-able result or throws a coded error.
// ════════════════════════════════════════════════════════════════════════════

async function doUpsert(user, body) {
  const actor = _userName(user);
  const b = body || {};
  const id = String(b.id || '').trim();
  if (!ULID_RE.test(id)) throw _err('VALIDATION_ERROR', 'معرف الطلب (id) مطلوب — ULID من العميل');
  // Channels: an order's channel must be a REAL, ACTIVE sales channel. The
  // channel NAME is resolved server-side from the DB (never trusted from the
  // client when an id is given), and the channel's price chain provides the
  // default unit price for lines that omit unitPrice.
  const channelId = b.channelId != null && String(b.channelId).trim() !== '' ? String(b.channelId).trim().slice(0, 50) : null;
  let channel = null; let chPricing = null;
  if (channelId) {
    channel = await _loadActiveChannel(db, channelId);
    let branchId = null;
    try { branchId = await _cashierBranchId(db, user); } catch (e) { console.error('[pos-v2] branch lookup failed (channel pricing uses global rows):', e.message); }
    chPricing = await _channelPricing(db, channel, branchId);
  }
  const channelName = channel ? String(channel.name || '').slice(0, 100) : ((b.channelName || '').toString().slice(0, 100) || null);
  const lines = await _normalizeLines(db, b.lines, chPricing);
  const discountType = ['PERCENT', 'FIXED'].includes(b.discountType) ? b.discountType : null;
  const discountValue = discountType ? Math.max(0, Number(b.discountValue) || 0) : 0;
  const totals = M.cartTotals(lines, discountType ? { type: discountType, value: discountValue } : null);
  const orderType = M.normalizeOrderType(b.orderType);
  const shiftId = b.shiftId != null ? (String(b.shiftId).trim().slice(0, 40) || null) : null;
  const expected = b.expectedVersion != null ? (parseInt(b.expectedVersion, 10)) : null;

  const out = await db.withTransaction(async (conn) => {
    const existing = await _loadOrder(id, conn); // FOR UPDATE
    if (!existing) {
      // Brand/branch scope fix — snapshot the cashier's branch at CREATION
      // time only (never rewritten on later edits), same convention as
      // name_snapshot / channel_name. Powers the brand-scoped GET /orders.
      const branchId = await _cashierBranchId(conn, user);
      await conn.query(
        `INSERT INTO pos_orders (id, status, order_type, table_no, shift_id, username, device_id, warehouse_id, branch_id, channel_id, channel_name, customer_id,
           discount_type, discount_value, discount_name, subtotal, line_discount_total, discount_total, vat_total, total, note, origin, version)
         VALUES (?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        [id, orderType, (b.tableNo || '').toString().slice(0, 20) || null, shiftId, actor,
         (b.deviceId || '').toString().slice(0, 60) || null,
         (b.warehouseId || '').toString().slice(0, 50) || null,
         branchId,
         channelId,
         channelName,
         (b.customerId || '').toString().slice(0, 50) || null,
         discountType, discountValue, (b.discountName || '').toString().slice(0, 100) || null,
         totals.subtotal, totals.lineDiscountTotal, totals.discountAmount, totals.vatTotal, totals.total,
         (b.note || '').toString().slice(0, 300) || null,
         b.origin === 'offline' ? 'offline' : 'online']);
      await _replaceLines(conn, id, lines);
      return { version: 1, created: true };
    }
    M.assertCanEdit(existing.status);
    if (!_userIsSuper(user) && existing.username && existing.username !== actor) throw _err('PERMISSION_DENIED', 'هذا الطلب يخص كاشيرًا آخر');
    if (!Number.isFinite(expected)) throw _err('VALIDATION_ERROR', 'expectedVersion مطلوب لتعديل طلب موجود');
    const [r] = await conn.query(
      `UPDATE pos_orders SET order_type=?, table_no=?, shift_id=?, warehouse_id=?, channel_id=?, channel_name=?, customer_id=?,
         discount_type=?, discount_value=?, discount_name=?, subtotal=?, line_discount_total=?, discount_total=?, vat_total=?, total=?, note=?, version=version+1
       WHERE id=? AND status='open' AND version=?`,
      [orderType, (b.tableNo || '').toString().slice(0, 20) || null, shiftId,
       (b.warehouseId || '').toString().slice(0, 50) || null,
       channelId,
       channelName,
       (b.customerId || '').toString().slice(0, 50) || null,
       discountType, discountValue, (b.discountName || '').toString().slice(0, 100) || null,
       totals.subtotal, totals.lineDiscountTotal, totals.discountAmount, totals.vatTotal, totals.total,
       (b.note || '').toString().slice(0, 300) || null, id, expected]);
    if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّر الطلب منذ آخر تحميل (جهاز آخر؟) — نسخة الخادم هي المعتمدة');
    await _replaceLines(conn, id, lines);
    return { version: expected + 1, created: false };
  });
  return {
    success: true, created: out.created, status: 'open',
    data: { id, version: out.version, totals: { subtotal: totals.subtotal, discountAmount: totals.discountAmount, vatTotal: totals.vatTotal, total: totals.total } },
    version: out.version,
  };
}

async function doTransition(user, id, action, body) {
  const actor = _userName(user);
  const b = body || {};
  const expected = b.expectedVersion != null ? parseInt(b.expectedVersion, 10) : null;
  return db.withTransaction(async (conn) => {
    const o = await _loadOrder(id, conn); // FOR UPDATE
    if (!o) { const e = new Error('الطلب غير موجود'); e.status = 404; throw e; }
    if (!_userIsSuper(user) && o.username && o.username !== actor) throw _err('PERMISSION_DENIED', 'هذا الطلب يخص كاشيرًا آخر');
    if (Number.isFinite(expected) && Number(o.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر الطلب — أعد التحميل');
    let sql, params, to;
    if (action === 'hold') {
      M.assertCanHold(o.status);
      sql = "UPDATE pos_orders SET status='held', held_at=NOW(), version=version+1 WHERE id=? AND status='open'"; params = [id]; to = 'held';
    } else if (action === 'resume') {
      M.assertCanResume(o.status);
      sql = "UPDATE pos_orders SET status='open', held_at=NULL, device_id=?, version=version+1 WHERE id=? AND status='held'";
      params = [(b.deviceId || '').toString().slice(0, 60) || null, id]; to = 'open';
    } else if (action === 'reopen') {
      M.assertCanReopen(o.status);
      sql = "UPDATE pos_orders SET status='open', submitted_at=NULL, version=version+1 WHERE id=? AND status='submitted'"; params = [id]; to = 'open';
    } else if (action === 'void') {
      M.assertCanVoid(o.status);
      const reason = String(b.reason || '').trim();
      if (!reason) throw _err('VALIDATION_ERROR', 'سبب الإلغاء إلزامي');
      sql = "UPDATE pos_orders SET status='voided', voided_at=NOW(), void_reason=?, version=version+1 WHERE id=? AND status IN ('open','held')";
      params = [reason.slice(0, 300), id]; to = 'voided';
    } else {
      throw _err('VALIDATION_ERROR', 'إجراء غير معروف: ' + action);
    }
    const [r] = await conn.query(sql, params);
    if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الطلب — أعد التحميل');
    if (action === 'reopen') await conn.query('DELETE FROM pos_payments WHERE order_id=?', [id]);
    return { success: true, data: { id }, status: to, version: Number(o.version) + 1 };
  });
}

async function doSubmit(user, id, body) {
  const actor = _userName(user);
  const b = body || {};
  const expected = b.expectedVersion != null ? parseInt(b.expectedVersion, 10) : null;
  return db.withTransaction(async (conn) => {
    const o = await _loadOrder(id, conn); // FOR UPDATE
    if (!o) { const e = new Error('الطلب غير موجود'); e.status = 404; throw e; }
    if (!_userIsSuper(user) && o.username && o.username !== actor) throw _err('PERMISSION_DENIED', 'هذا الطلب يخص كاشيرًا آخر');
    M.assertCanSubmit(o.status);
    if (Number.isFinite(expected) && Number(o.version) !== expected) throw _err('VERSION_CONFLICT', 'تغيّر الطلب — أعد التحميل');
    if (!o.shift_id) throw _err('VALIDATION_ERROR', 'لا يمكن الدفع بلا وردية مفتوحة — افتح وردية أولًا');
    const lineRows = await _loadLines(id, conn);
    if (!lineRows.length) throw _err('VALIDATION_ERROR', 'السلة فارغة');
    const lines = _linesForMath(lineRows);
    const totals = M.cartTotals(lines, o.discount_type ? { type: o.discount_type, value: Number(o.discount_value) } : null);

    // SERVER-SIDE discount ceiling: above the cashier limit needs a manager.
    if (totals.discountAmount > 0 && !_userIsSuper(user)) {
      const pct = totals.subtotal > 0 ? (totals.discountAmount / totals.subtotal) * 100 : 0;
      if (pct > MAX_CASHIER_DISC_PCT + 1e-9) {
        throw _err('PERMISSION_DENIED', 'الخصم (' + M.round2(pct) + '%) يتجاوز حد الكاشير (' + MAX_CASHIER_DISC_PCT + '%) — يتطلب مديرًا');
      }
    }
    // Owner-configured payment methods (ERP → الإعدادات → طرق الدفع): valid
    // methods = built-ins ∪ ACTIVE payment_methods rows. 'Split' rows are
    // excluded — V2 splits natively via multiple payment legs. A load failure
    // is loud and degrades to built-ins only (never a silent open door).
    let ownerMethods = [];
    try {
      const [pmRows] = await conn.query('SELECT id, name, name_ar, group_type FROM payment_methods WHERE is_active = 1');
      ownerMethods = pmRows
        .filter((p) => String(p.name || '').toLowerCase() !== 'split')
        .map((p) => ({ id: String(p.id), name: p.name, nameAr: p.name_ar || p.name, groupType: p.group_type || 'cash', requiresNote: String(p.group_type || '') === 'other' }));
    } catch (e) {
      console.error('[pos-v2] payment_methods load failed (built-in methods only):', e.message);
    }
    const payments = Array.isArray(b.payments) ? b.payments.map((p) => ({ method: String(p.method), amount: Number(p.amount) })) : [];
    M.validatePayments(payments, totals.total, ownerMethods);
    // 'other'-group methods REQUIRE a payment note (≥3 chars) — it flows into
    // the legacy payload's paymentNotes → sales.payment_notes (the audit trail
    // for ad-hoc tenders).
    const noteMethod = M.paymentNoteRequirement(payments, ownerMethods);
    if (noteMethod && String(b.paymentNotes || '').trim().length < 3) {
      throw _err('VALIDATION_ERROR', 'طريقة الدفع "' + (noteMethod.nameAr || noteMethod.name) + '" تتطلب ملاحظة دفع (3 أحرف على الأقل)');
    }
    // Credit sales are supervisor-gated (AR exposure).
    if (payments.some((p) => p.method === 'credit') && !_userIsSuper(user)) throw _err('PERMISSION_DENIED', 'البيع الآجل يتطلب مشرفًا/مديرًا');
    // Order-to-Cash: a credit sale MUST be attached to a real customer (the AR
    // subledger has nowhere to book it otherwise). Flag-gated so the legacy POS
    // (flag OFF) keeps its prior behavior (customer name/phone in the note). The
    // /api/sales creditSaleGate is the security backstop; this just fails earlier
    // with a clear message before the financial write.
    if (/^(1|true|on|yes)$/i.test(String(process.env.ORDER_TO_CASH_ENABLE || '').trim())
        && payments.some((p) => p.method === 'credit') && !o.customer_id) {
      throw _err('VALIDATION_ERROR', 'البيع الآجل يتطلب اختيار عميل');
    }

    await conn.query('DELETE FROM pos_payments WHERE order_id=?', [id]);
    for (const p of payments) {
      await conn.query('INSERT INTO pos_payments (id, order_id, method, amount, ref) VALUES (?,?,?,?,?)',
        ['PP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), id, String(p.method).slice(0, 50), M.round2(p.amount), (b.ref || '').toString().slice(0, 100) || null]);
    }
    const [r] = await conn.query(
      "UPDATE pos_orders SET status='submitted', submitted_at=NOW(), subtotal=?, line_discount_total=?, discount_total=?, vat_total=?, total=?, version=version+1 WHERE id=? AND status='open' AND version=?",
      [totals.subtotal, totals.lineDiscountTotal, totals.discountAmount, totals.vatTotal, totals.total, id, o.version]);
    if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الطلب أثناء الإرسال');

    const legacyPayload = M.buildLegacySalePayload(_orderForMath(o), lines, payments, {
      cashTendered: Number(b.cashTendered) || 0, changeDue: Number(b.changeDue) || 0,
      paymentNotes: (b.paymentNotes || '').toString().slice(0, 300) || undefined,
      ownerMethods,
    });
    return { success: true, data: { id, legacyPayload, total: totals.total }, status: 'submitted', version: Number(o.version) + 1 };
  });
}

async function doComplete(user, id, body) {
  const saleId = String((body && body.saleId) || '').trim();
  const invoiceNumber = String((body && body.invoiceNumber) || '').trim() || null;
  if (!saleId) throw _err('VALIDATION_ERROR', 'saleId مطلوب');
  return db.withTransaction(async (conn) => {
    const o = await _loadOrder(id, conn); // FOR UPDATE
    if (!o) { const e = new Error('الطلب غير موجود'); e.status = 404; throw e; }
    if (o.status === 'completed') {
      if (o.sale_id === saleId) return { success: true, idempotent: true, data: { id, saleId }, status: 'completed', version: Number(o.version) };
      throw _err('VERSION_CONFLICT', 'الطلب مكتمل ببيع مختلف (' + o.sale_id + ')');
    }
    M.assertCanComplete(o.status);
    // Belt-and-braces: the sale must exist and reference THIS order id.
    const [sale] = await conn.query('SELECT id, client_order_id, invoice_number FROM sales WHERE id=? LIMIT 1', [saleId]);
    if (!sale.length) throw _err('VALIDATION_ERROR', 'البيع غير موجود: ' + saleId);
    if (sale[0].client_order_id && sale[0].client_order_id !== id) throw _err('VALIDATION_ERROR', 'البيع مرتبط بطلب آخر');
    const [r] = await conn.query(
      "UPDATE pos_orders SET status='completed', completed_at=NOW(), sale_id=?, invoice_number=?, version=version+1 WHERE id=? AND status='submitted'",
      [saleId, invoiceNumber || sale[0].invoice_number || null, id]);
    if (!r || r.affectedRows !== 1) throw _err('VERSION_CONFLICT', 'تغيّرت حالة الطلب أثناء الإكمال');
    return { success: true, idempotent: false, data: { id, saleId }, status: 'completed', version: Number(o.version) + 1 };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CATALOG — menu + categories, ETag-cached for the offline-first client.
// ════════════════════════════════════════════════════════════════════════════
router.get('/catalog', POS, async (req, res) => {
  try {
    // Channels — ?channelId= resolves every item price through the ERP channel
    // chain (override > price list > base; see _channelPricing) and, for a
    // non-full-menu channel, restricts the item grid to the channel's own
    // configured items. Unknown/inactive channel → 422, never a silent
    // full-menu fallback.
    const reqChannelId = String(req.query.channelId || '').trim();
    let channel = null; let chPricing = null;
    if (reqChannelId) {
      channel = await _loadActiveChannel(db, reqChannelId);
      let branchId = null;
      try { branchId = await _cashierBranchId(db, req.user); } catch (e) { console.error('[pos-v2] branch lookup failed (channel pricing uses global rows):', e.message); }
      chPricing = await _channelPricing(db, channel, branchId);
    }

    // Brand/branch scope fix — EVERY caller (including admin/manager) is
    // scoped by default to their own resolved brand; menu.brand_id IS NULL
    // rows are unscoped/global and stay visible to everyone. The
    // ?brandId=/?allBranches=1 bypass only widens this for a holder of
    // BRAND_SCOPE_CAP (see _resolveBrandScope) — silently ignored otherwise.
    const brandScope = await _resolveBrandScope(db, req);
    const brandCond = brandScope.allBrands ? '' : ' AND (menu.brand_id IS NULL OR menu.brand_id = ?)';
    const brandParams = brandScope.allBrands ? [] : [brandScope.brandId];

    // close/d-images — the catalog carries an image VERSION, never the image.
    // menu.image_data is a base64 data-URL in a LONGTEXT (66MB across the live
    // catalog); shipping it here is exactly the legacy full-menu-in-localStorage
    // problem this client exists to escape. Instead each item exposes an 8-char
    // SHA1 prefix: the client fetches bytes from GET /item-image/:id?v=<version>
    // (immutable-cached), and an image edit changes the version — which changes
    // data.items and therefore this route's ETag, invalidating cached catalogs.
    // Measured on the live 2,000-row / 68MB-of-blobs table: ~28ms → ~100ms.
    const [items] = await db.query(
      "SELECT id, name, name_en, price, category, active, tax_category, stock, COALESCE(is_combo,0) AS is_combo, " +
      "CASE WHEN image_data IS NULL OR image_data='' THEN NULL ELSE SUBSTRING(SHA1(image_data),1,8) END AS image_ver " +
      "FROM menu WHERE COALESCE(is_deleted,0)=0" + brandCond + " ORDER BY category, name", brandParams);

    // Bilingual — AR→EN category overlay (menu_category_i18n). Additive and
    // fail-soft: a missing/mid-migration table must not cost the cashier the
    // whole catalog, only the categoryEn field (stays null).
    const categoryEnMap = {};
    try {
      const cats = [...new Set(items.map((m) => m.category || 'عام'))];
      if (cats.length) {
        const [catRows] = await db.query(
          'SELECT category_ar, category_en FROM menu_category_i18n WHERE category_ar IN (?)', [cats]);
        for (const c of catRows) categoryEnMap[c.category_ar] = c.category_en || null;
      }
    } catch (e) {
      console.error('[pos-v2] menu_category_i18n load failed (catalog ships without categoryEn):', e.message);
    }
    let vatRate = 15;
    try {
      // Was: SELECT `value` ... WHERE `key`=... — columns that do not exist. The
      // query threw on every call and a bare catch swallowed it, pinning the
      // React POS to 15% no matter what the owner configured (it then flowed to
      // the receipt while /api/sales booked the real rate).
      const [vr] = await db.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'VATRate' LIMIT 1");
      if (vr.length) vatRate = Number(vr[0].setting_value) || 15;
    } catch (e) {
      console.error('[pos-v2] VATRate lookup failed; falling back to 15%:', e.message);
    }

    // Phase U — attach the sellable units (base + majors like carton) per catalog
    // item, keyed by the catalog id (= the stock item id for imported goods), plus
    // the per-unit barcode (item_units.barcode_id → item_barcodes.code) and the
    // primary barcode. Resolved offline so the cashier can scan a carton barcode
    // with no round-trip. Fails soft: a missing units/barcode row → base-only item.
    const ids = items.map((m) => String(m.id));
    const unitsByItem = {}; const primaryBc = {};
    if (ids.length) {
      try {
        const [us] = await db.query(
          'SELECT iu.item_id, iu.id AS unit_id, iu.unit_code, iu.unit_name, iu.is_base, iu.conversion_to_base, ib.code AS barcode, un.name_en AS unit_name_en ' +
          'FROM item_units iu LEFT JOIN item_barcodes ib ON ib.id=iu.barcode_id LEFT JOIN units un ON un.id=iu.unit_id ' +
          'WHERE iu.item_id IN (?) AND iu.is_active=1 AND iu.allow_sale=1 ORDER BY iu.is_base DESC, iu.conversion_to_base ASC', [ids]);
        for (const u of us) {
          (unitsByItem[u.item_id] = unitsByItem[u.item_id] || []).push({
            unitId: u.unit_id, unitCode: u.unit_code, unitName: u.unit_name,
            // unitNameEn resolves via the master `units` table (units.id =
            // item_units.unit_id). unit_id is an honest optional link — a unit
            // never wired to the master row stays null here, not a bug.
            unitNameEn: u.unit_name_en ?? null,
            isBase: u.is_base === 1 || u.is_base === true, factor: Number(u.conversion_to_base), barcode: u.barcode || null,
          });
        }
      } catch (_) { /* item_units not present → base-only */ }
      try {
        const [pb] = await db.query("SELECT item_id, code FROM item_barcodes WHERE item_id IN (?) AND is_primary=1", [ids]);
        for (const b of pb) primaryBc[b.item_id] = b.code;
      } catch (_) { /* item_barcodes not present */ }
    }

    // Combos (العروض) — full definitions so the React POS can open the chooser
    // offline: fixed components (always consumed) + choice groups (min/max +
    // options). Derived from the SAME tables routes/sales.js expands at
    // deduction time (combo_groups / combo_group_items on is_combo=1 menu
    // rows). Combo price is FIXED (the menu row's price) — options carry
    // priceDelta: 0 today; the field exists so a future per-option surcharge
    // is additive, not a shape break. Inactive options ship with active:false
    // (the client hides them, exactly like the legacy chooser) and are
    // REJECTED server-side at upsert.
    let combos = [];
    try {
      let [comboRows] = await db.query(
        "SELECT id, name, name_en, price FROM menu WHERE COALESCE(is_combo,0)=1 AND COALESCE(is_deleted,0)=0" + brandCond + " ORDER BY category, name", brandParams);
      // A non-full-menu channel restricts combos exactly like plain items.
      if (chPricing && chPricing.availableSet) comboRows = comboRows.filter((c) => chPricing.availableSet.has(String(c.id)));
      if (comboRows.length) {
        const defs = await _loadComboDefs(db, comboRows.map((c) => String(c.id)));
        combos = comboRows.map((c) => {
          const def = defs.get(String(c.id)) || { groups: [] };
          const fixedComponents = [];
          const groups = [];
          for (const g of def.groups) {
            const opts = [...g.options.entries()];
            if (g.type === 'fixed') {
              for (const [mid, o] of opts) fixedComponents.push({ menuId: mid, name: o.name, qty: o.qty });
            } else {
              groups.push({
                id: g.id, name: g.name, min: g.min, max: g.max,
                options: opts.map(([mid, o]) => ({ menuId: mid, name: o.name, qty: o.qty, priceDelta: 0, active: o.active })),
              });
            }
          }
          // Combo price is FIXED but still channel-priced like any menu row.
          const resolved = chPricing ? _channelPriceFor(chPricing, c.id, c.price) : { price: Number(c.price), source: null };
          return { id: String(c.id), menuId: String(c.id), name: c.name, nameEn: c.name_en ?? null, price: resolved.price, priceSource: resolved.source, fixedComponents, groups };
        });
      }
    } catch (e) {
      // Loud, and the catalog ships without combos rather than 500ing the whole
      // grid — a combo-tables schema gap must not cost the cashier the menu.
      console.error('[pos-v2] combos load failed (catalog ships without combos):', e.message);
      combos = [];
    }

    // Receipt identity, resolved for THIS cashier's branch and shipped inside the
    // catalog because the catalog is the one payload the client already caches
    // for offline use. Until now the React receipt derived the seller name from
    // document.title and printed none of the owner-configured fields — the API
    // returned them (routes/sales.js /invoice/:orderId) but only AFTER a sale,
    // over the network, which is exactly what an offline receipt cannot do.
    let identity = null;
    let receiptShowFields = invoiceIdentity.showFields(null);
    // Print preferences (paper width / auto-print). Global-only settings, and
    // NEVER part of `identity` — the identity is snapshotted onto every issued
    // invoice while the paper size belongs to whatever printer prints TODAY.
    // Contract with the receipt renderer: { paperWidth: '58'|'80'|'A4', autoPrint: '1'|'0' }.
    let receiptSettings = invoiceIdentity.normalizeReceiptSettings(null, null);
    try {
      let scope = null;
      const uname = _userName(req.user);
      if (uname) {
        const [u] = await db.query('SELECT branch_id, default_branch_id FROM users WHERE username = ? LIMIT 1', [uname]);
        if (u.length) scope = { branchId: u[0].branch_id || u[0].default_branch_id || null };
      }
      const resolved = await invoiceIdentity.resolveIdentity(db, scope);
      identity = resolved.identity;
      receiptSettings = resolved.receiptSettings;
      const [sf] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'ReceiptShowFields' LIMIT 1");
      receiptShowFields = invoiceIdentity.showFields(sf.length ? sf[0].setting_value : null);
    } catch (e) {
      // Loud, and identity stays null: the receipt renderer treats a missing
      // identity as "print what you have", never as fabricated seller data.
      console.error('[pos-v2] receipt identity resolution failed:', e.message);
    }

    // Owner opt-out for the void approval modal (RequireManagerApprovalForVoid
    // = '0' → any cashier voids without manager credentials). The SERVER gate
    // (routes/sales.js:_requireManagerApproval) reads the same setting and
    // remains the enforcement point — this key only lets the client skip a
    // dialog the server would wave through anyway. Defaults to TRUE (gated)
    // on any read failure; VOID only — returns are never opted out.
    let requireVoidApproval = true;
    try {
      const [va] = await db.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'RequireManagerApprovalForVoid' LIMIT 1");
      if (va.length && String(va[0].setting_value).trim() === '0') requireVoidApproval = false;
    } catch (_) { /* fail closed — keep the dialog */ }

    // Owner payment methods for the tender tiles (legacy: the POS loaded
    // GET /api/settings/payment-methods-full at boot). ACTIVE only; literal
    // 'Split' rows are excluded (V2 splits via multiple payment legs, exactly
    // like the legacy tile filter). requiresNote mirrors the /submit rule:
    // 'other'-group methods demand a payment note ≥3 chars.
    let paymentMethods = [];
    try {
      const [pmRows] = await db.query(
        'SELECT id, name, name_ar, icon, color, group_type FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, name');
      paymentMethods = pmRows
        .filter((p) => String(p.name || '').toLowerCase() !== 'split')
        .map((p) => ({
          id: p.id, name: p.name, nameAr: p.name_ar || p.name,
          icon: p.icon || 'fa-money-bill', color: p.color || '#3b82f6',
          groupType: p.group_type || 'cash',
          requiresNote: String(p.group_type || '') === 'other',
        }));
    } catch (e) {
      // Loud fallback: the client renders its built-in tiles (cash/card/credit).
      console.error('[pos-v2] payment_methods load failed (catalog ships without owner methods):', e.message);
    }

    // Active channels for the switcher (legacy: GET /api/sales-channels/active).
    let channels = [];
    try {
      const [chRows] = await db.query(
        'SELECT id, name, name_en, code, COALESCE(use_full_menu,0) AS use_full_menu FROM sales_channels WHERE is_active = 1 ORDER BY display_order, name');
      channels = chRows.map((c) => ({ id: c.id, name: c.name, nameEn: c.name_en ?? null, code: c.code, useFullMenu: !!c.use_full_menu }));
    } catch (e) {
      // Loud fallback: the catalog still serves the grid; the switcher is empty.
      console.error('[pos-v2] channels load failed (catalog ships without channels):', e.message);
    }

    const visibleItems = items.filter((m) => !chPricing || !chPricing.availableSet || chPricing.availableSet.has(String(m.id)));
    const data = {
      items: visibleItems.map((m) => {
        const units = unitsByItem[m.id] || [];
        const base = units.find((u) => u.isBase);
        const resolved = chPricing ? _channelPriceFor(chPricing, m.id, m.price) : { price: Number(m.price), source: null };
        return {
          id: String(m.id), name: m.name, nameEn: m.name_en ?? null, price: resolved.price, category: m.category || 'عام',
          categoryEn: categoryEnMap[m.category || 'عام'] ?? null,
          active: !(m.active === 0 || m.active === false),
          taxCategory: ['S', 'Z', 'E', 'O'].includes(m.tax_category) ? m.tax_category : 'S',
          basePrice: Number(m.price), warehouseQty: m.stock == null ? null : Number(m.stock),
          // Price provenance under a channel: null = base menu price;
          // 'override' = per-channel manual override; otherwise the NAME of the
          // channel's price list that supplied the price.
          priceSource: resolved.source,
          barcode: primaryBc[m.id] || null,
          baseUnitName: base ? base.unitName : null,
          units, // [] when no multi-unit config → cashier treats it as single-unit
          imageVersion: m.image_ver ?? null, // 8-char SHA1 prefix; bytes via /item-image/:id
          isCombo: Number(m.is_combo) === 1, // tap opens the combo chooser (definition in data.combos)
        };
      }),
      combos,
      paymentMethods,
      channels,
      // Echo of the requested channel (badge + price-list chip in the client).
      channel: channel ? {
        id: channel.id, name: channel.name, nameEn: channel.name_en ?? null, useFullMenu: !!channel.use_full_menu,
        priceListId: chPricing ? chPricing.priceListId : null,
        priceListName: chPricing ? chPricing.priceListName : null,
      } : null,
      categories: [...new Set(visibleItems.map((m) => m.category || 'عام'))],
      vatRate,
      maxCashierDiscountPct: MAX_CASHIER_DISC_PCT,
      identity,
      receiptShowFields,
      receiptSettings,
      requireVoidApproval,
      serverTime: new Date().toISOString(),
    };
    // identity is part of the ETag: an owner editing the receipt header must
    // reach cached offline clients on their next sync, not never. Same for the
    // print preferences, the void-approval opt-out, and the channel/combo/
    // payment-method parts — any owner change must reach cached offline clients.
    const etag = '"' + crypto.createHash('sha1').update(JSON.stringify({ i: data.items, c: data.combos, pm: data.paymentMethods, ch: data.channels, cn: data.channel, sel: reqChannelId || null, v: data.vatRate, id: identity, sf: receiptShowFields, rs: receiptSettings, va: requireVoidApproval })).digest('hex') + '"';
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.json({ success: true, data });
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// ITEM IMAGE — menu.image_data (a base64 data-URL in a LONGTEXT, kept for
// legacy compatibility) served as REAL bytes, one item at a time. The rule the
// catalog route lives by: the LONGTEXT never rides in the catalog payload —
// clients get `imageVersion` there and fetch bytes here, immutable-cached
// (?v=<imageVersion> busts the cache when the owner edits the image).
// Corrupt/absent stored data → 404, never a 500: a broken image must cost the
// grid one thumbnail, not the whole request.
// ════════════════════════════════════════════════════════════════════════════
const IMG_DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;
router.get('/item-image/:id', POS, async (req, res) => {
  try {
    const id = String(req.params.id || '').slice(0, 50);
    const [rows] = await db.query('SELECT image_data FROM menu WHERE id=? LIMIT 1', [id]);
    const raw = rows.length ? rows[0].image_data : null;
    if (!raw) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'لا توجد صورة لهذا الصنف' });
    const m = IMG_DATA_URL_RE.exec(String(raw));
    let b64 = null; let bytes = null;
    if (m) {
      b64 = m[2].replace(/\s+/g, '');
      const buf = Buffer.from(b64, 'base64'); // charset already constrained by the regex
      if (buf.length > 0) bytes = buf;
    }
    if (!bytes) {
      console.error('[pos-v2] item-image: stored image_data is not a valid base64 data-URL for menu id', id);
      return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'الصورة المخزّنة تالفة' });
    }
    // ETag = sha1 of the base64 payload (content-addressed, independent of the
    // catalog's imageVersion which hashes the full data-URL). Set on the 304 too.
    const etag = '"' + crypto.createHash('sha1').update(b64).digest('hex') + '"';
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.setHeader('Content-Type', 'image/' + (m[1] === 'jpg' ? 'jpeg' : m[1]));
    res.send(bytes);
  } catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// LIST + DETAIL (held-orders board, shift review)
// ════════════════════════════════════════════════════════════════════════════
router.get('/orders', POS, async (req, res) => {
  try {
    const where = []; const params = [];
    const status = String(req.query.status || '');
    if (M.STATUSES.includes(status)) { where.push('pos_orders.status=?'); params.push(status); }
    else { where.push("pos_orders.status IN ('open','held','submitted')"); }
    if (req.query.shiftId) { where.push('pos_orders.shift_id=?'); params.push(String(req.query.shiftId).slice(0, 40)); }
    let join = '';
    if (!_userIsSuper(req.user)) {
      // Cashiers/employees always see only their own orders — unchanged.
      where.push('pos_orders.username=?'); params.push(_userName(req.user));
    } else {
      // Supervisors: brand-scoped by DEFAULT via the order's branch snapshot
      // (branch_id) joined to branches.brand_id. NULL branch_id (pre-migration
      // rows) and NULL-brand branches stay visible to everyone — same
      // "unscoped = global" rule the catalog applies. ?brandId=/?allBranches=1
      // bypass requires BRAND_SCOPE_CAP (see _resolveBrandScope).
      const scope = await _resolveBrandScope(db, req);
      if (!scope.allBrands) {
        join = ' LEFT JOIN branches ON branches.id = pos_orders.branch_id';
        where.push('(pos_orders.branch_id IS NULL OR branches.brand_id IS NULL OR branches.brand_id = ?)');
        params.push(scope.brandId);
      }
    }
    const [rows] = await db.query(
      'SELECT pos_orders.* FROM pos_orders' + join + ' WHERE ' + where.join(' AND ') + ' ORDER BY pos_orders.updated_at DESC LIMIT 200', params);
    const ids = rows.map((r) => r.id);
    let lines = [];
    if (ids.length) { const [lr] = await db.query('SELECT * FROM pos_order_lines WHERE order_id IN (?) ORDER BY sort, id', [ids]); lines = lr; }
    res.json({ success: true, data: rows.map((o) => _publicOrder(o, lines.filter((l) => l.order_id === o.id), [])) });
  } catch (e) { _catch(res, e); }
});

router.get('/orders/:id', POS, async (req, res) => {
  try {
    const o = await _loadOrder(req.params.id);
    if (!o) { const e = new Error('الطلب غير موجود'); e.status = 404; throw e; }
    if (!_userIsSuper(req.user) && o.username && o.username !== _userName(req.user)) return _fail(res, 'PERMISSION_DENIED', 'هذا الطلب يخص كاشيرًا آخر');
    // Supervisors: same brand-scope as the list route, with the same
    // allBranches+capability bypass. Reuses PERMISSION_DENIED — no new code.
    if (_userIsSuper(req.user) && o.branch_id) {
      const scope = await _resolveBrandScope(db, req);
      if (!scope.allBrands) {
        const [br] = await db.query('SELECT brand_id FROM branches WHERE id=? LIMIT 1', [o.branch_id]);
        const orderBrandId = br.length ? br[0].brand_id : null;
        if (orderBrandId != null && orderBrandId !== scope.brandId) {
          return _fail(res, 'PERMISSION_DENIED', 'هذا الطلب خارج نطاق البراند الخاص بك');
        }
      }
    }
    res.json({ success: true, data: _publicOrder(o, await _loadLines(o.id), await _loadPayments(o.id)) });
  } catch (e) { _catch(res, e); }
});

// ── HTTP handlers → internal ops ─────────────────────────────────────────────
router.post('/orders', POS, async (req, res) => {
  try {
    const body = Object.assign({}, req.body);
    if (body.expectedVersion == null && req.get('If-Match')) body.expectedVersion = req.get('If-Match');
    const out = await doUpsert(req.user, body);
    res.status(out.created ? 201 : 200).json(out);
  } catch (e) { _catch(res, e); }
});
for (const action of ['hold', 'resume', 'reopen', 'void']) {
  router.post(`/orders/:id/${action}`, POS, async (req, res) => {
    try { res.json(await doTransition(req.user, req.params.id, action, req.body)); }
    catch (e) { _catch(res, e); }
  });
}
router.post('/orders/:id/submit', POS, async (req, res) => {
  let idemId = null;
  try {
    const key = IDEM.readKey(req);
    const idem = await IDEM.begin(db, 'pos:submit', req.params.id, key, _userName(req.user), req.body || {});
    if (idem.mode === 'replay') return res.status(idem.statusCode || 200).json(idem.body);
    if (idem.mode === 'conflict') return _fail(res, 'IDEMPOTENCY_CONFLICT', 'طلب إرسال مكرر');
    if (idem.mode === 'proceed') idemId = idem.idemId;
    const out = await doSubmit(req.user, req.params.id, req.body);
    if (idemId) await IDEM.complete(db, idemId, 200, out);
    res.json(out);
  } catch (e) {
    if (idemId) await IDEM.abort(db, idemId).catch(() => {});
    _catch(res, e);
  }
});
router.post('/orders/:id/complete', POS, async (req, res) => {
  try { res.json(await doComplete(req.user, req.params.id, req.body)); }
  catch (e) { _catch(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// SYNC — batch replay of OFFLINE V2 ops. The financial checkout itself replays
// against legacy /api/sales directly from the client (clientOrderId dedupe) —
// sync never posts money. Per-op idempotency via idempotency_keys (opId).
// ════════════════════════════════════════════════════════════════════════════
const SYNC_OPS = new Set(['upsert', 'hold', 'resume', 'reopen', 'void', 'complete']);
router.post('/sync', POS, async (req, res) => {
  const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops : [];
  if (!ops.length) return _fail(res, 'VALIDATION_ERROR', 'ops مطلوبة');
  if (ops.length > 100) return _fail(res, 'VALIDATION_ERROR', 'حد المزامنة 100 عملية لكل دفعة');
  const results = [];
  for (const op of ops) {
    const opId = String(op.opId || '').slice(0, 80);
    const type = String(op.type || '');
    const orderId = String(op.orderId || (op.payload && op.payload.id) || '');
    // CO-1: the reservation this op opened, so the catch below can ABORT it.
    // Without that, any throw left idempotency_keys with status_code IS NULL —
    // an in-progress reservation that never completes — so the client's own
    // legitimate retry of the SAME opId came back IDEMPOTENCY_CONFLICT forever
    // and the op could never drain. /orders/:id/submit already aborts; /sync
    // did not, and /sync is the path every offline upsert takes.
    let syncIdemId = null;
    try {
      if (!opId) throw _err('VALIDATION_ERROR', 'opId مطلوب');
      if (!SYNC_OPS.has(type)) throw _err('VALIDATION_ERROR', 'نوع عملية غير مدعوم في المزامنة: ' + type);
      const idem = await IDEM.begin(db, 'pos:sync:' + type, orderId, opId, _userName(req.user), op.payload || {});
      if (idem.mode === 'replay') { results.push({ opId, ok: true, replay: true, result: idem.body }); continue; }
      if (idem.mode === 'conflict') { results.push({ opId, ok: false, code: 'IDEMPOTENCY_CONFLICT', error: 'عملية قيد التنفيذ أو بمحتوى مختلف' }); continue; }
      if (idem.mode === 'proceed') syncIdemId = idem.idemId;
      let result;
      const payload = Object.assign({}, op.payload, type === 'upsert' ? { origin: 'offline' } : null);
      if (type === 'upsert') result = await doUpsert(req.user, payload);
      else if (type === 'complete') result = await doComplete(req.user, orderId, payload);
      else result = await doTransition(req.user, orderId, type, payload);
      if (idem.mode === 'proceed') { await IDEM.complete(db, idem.idemId, 200, result); syncIdemId = null; }
      results.push({ opId, ok: result.success !== false, result });
    } catch (e) {
      if (syncIdemId) await IDEM.abort(db, syncIdemId).catch(() => {});
      results.push({ opId, ok: false, code: e.code || 'SERVER_ERROR', error: e.message });
    }
  }
  res.json({ success: results.every((r) => r.ok), results });
});

// ════════════════════════════════════════════════════════════════════════════
// SHIFT SUMMARY — V2 orders per shift (held board + completion reconciliation)
// ════════════════════════════════════════════════════════════════════════════
router.get('/shift-summary/:shiftId', POS, async (req, res) => {
  try {
    const shiftId = String(req.params.shiftId || '').slice(0, 40);
    const [agg] = await db.query(
      'SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM pos_orders WHERE shift_id=? GROUP BY status', [shiftId]);
    const [pay] = await db.query(
      "SELECT p.method, COALESCE(SUM(p.amount),0) AS amount FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.shift_id=? AND o.status='completed' GROUP BY p.method", [shiftId]);
    res.json({
      success: true,
      data: {
        byStatus: Object.fromEntries(agg.map((r) => [r.status, { count: Number(r.n), amount: Number(r.amount) }])),
        completedByMethod: Object.fromEntries(pay.map((r) => [r.method, Number(r.amount)])),
      },
    });
  } catch (e) { _catch(res, e); }
});

module.exports = router;
