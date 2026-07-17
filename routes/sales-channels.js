// ═══════════════════════════════════════════════════════════════════
// SALES CHANNELS — multi-channel pricing (main menu / Hangerstation / Keeta / app / phone)
// Each channel can be linked to a specific price list to enforce
// "no price-mixing in same invoice" rule.
// ═══════════════════════════════════════════════════════════════════

const router = require('express').Router();
const db = require('../db/connection');
// G-SALES hardening — channel writes are pricing/GL configuration: gated by the
// live `channels.manage` capability (pattern: routes/order-to-cash/returns.js).
const requireCapability = require('../middleware/requireCapability');

// v5.10.29 — Idempotent migration: add use_full_menu column to
// sales_channels. Existing MAIN/dine_in channels default to TRUE so they
// keep showing the entire catalog (this is what the system has always
// done implicitly). Every NEW channel defaults to FALSE — a truly
// independent menu that the admin must populate. The cashier honors
// this flag explicitly and no longer "silently" falls back to MAIN
// when a channel has zero items (the original "non-independence" UX bug
// the owner kept reporting).
let _useFullMenuColumnEnsured = false;
async function _ensureUseFullMenuColumn() {
  if (_useFullMenuColumnEnsured) return;
  try {
    const [cols] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_channels' AND COLUMN_NAME = 'use_full_menu'");
    if (!cols.length) {
      await db.query("ALTER TABLE sales_channels ADD COLUMN use_full_menu TINYINT(1) NOT NULL DEFAULT 0");
      // Backfill: MAIN code OR dine_in type stays TRUE (legacy implicit behavior)
      await db.query(
        "UPDATE sales_channels SET use_full_menu = 1 " +
        "WHERE UPPER(COALESCE(code,'')) = 'MAIN' OR LOWER(COALESCE(channel_type,'')) = 'dine_in'");
      console.log('[sales-channels] v5.10.29 added use_full_menu column + backfilled MAIN/dine_in');
    }
    _useFullMenuColumnEnsured = true;
  } catch (e) {
    console.warn('[sales-channels] v5.10.29 use_full_menu migration skipped:', e.message);
  }
}
// Run the migration on first request that touches this router
router.use(async (req, res, next) => {
  if (!_useFullMenuColumnEnsured) await _ensureUseFullMenuColumn();
  next();
});

// List all channels with linked price-list name
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT c.*, pl.name AS price_list_name
        FROM sales_channels c
        LEFT JOIN price_lists pl ON pl.id = c.price_list_id
       ORDER BY c.display_order, c.name
    `);
    res.json(rows.map(c => ({
      id: c.id, code: c.code, name: c.name, nameEn: c.name_en,
      channelType: c.channel_type, priceListId: c.price_list_id,
      priceListName: c.price_list_name || null,
      icon: c.icon || 'fa-store', color: c.color || '#3b82f6',
      commissionPct: Number(c.commission_pct || 0),
      serviceFeePct: Number(c.service_fee_pct || 0),
      glRevenueAccount: c.gl_revenue_account, glCommissionAccount: c.gl_commission_account,
      requiresExternalRef: !!c.requires_external_ref,
      allowDiscount: c.allow_discount !== 0,
      isActive: !!c.is_active,
      displayOrder: c.display_order,
      notes: c.notes || '',
      // v5.10.29 — explicit "full menu vs independent" flag. When TRUE
      // the cashier ignores channel_menu_items and shows every active
      // menu row (MAIN/dine_in default). When FALSE the cashier shows
      // ONLY this channel's configured items — no silent fallback.
      useFullMenu: !!c.use_full_menu
    })));
  } catch (e) {
    // G-SALES error honesty — was HTTP 200 with an empty channels list.
    console.error('[GET /sales-channels]', e.message);
    res.status(500).json({ error: e.message, channels: [] });
  }
});

// Active only (used by POS)
router.get('/active', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT c.*, pl.name AS price_list_name
        FROM sales_channels c
        LEFT JOIN price_lists pl ON pl.id = c.price_list_id
       WHERE c.is_active = 1
       ORDER BY c.display_order, c.name
    `);
    res.json(rows.map(c => ({
      id: c.id, code: c.code, name: c.name,
      channelType: c.channel_type, priceListId: c.price_list_id,
      priceListName: c.price_list_name || null,
      icon: c.icon || 'fa-store', color: c.color || '#3b82f6',
      commissionPct: Number(c.commission_pct || 0),
      serviceFeePct: Number(c.service_fee_pct || 0),
      requiresExternalRef: !!c.requires_external_ref,
      allowDiscount: c.allow_discount !== 0,
      // v5.10.29 — same explicit flag for the cashier path
      useFullMenu: !!c.use_full_menu
    })));
  } catch (e) {
    // G-SALES error honesty — the POS read "no active channels" out of a DB
    // failure and silently fell back to default pricing. Surface it.
    console.error('[GET /sales-channels/active]', e.message);
    res.status(500).json({ success: false, error: 'تعذّر تحميل قنوات البيع' });
  }
});

// V5.7.8 — Smart auto-code generator for sales channels.
// Strategy:
//   1. If name has Latin letters → take first word + uppercase, slice 8 chars
//   2. If name is Arabic → use channel_type prefix
//   3. Append numeric suffix (-2, -3, ...) until unique in DB
// Example outputs:
//   "Hunger Station" + delivery → "HUNGER" or "HUNGER-2" if collision
//   "هنقرستيشن"      + aggregator → "AGG" or "AGG-2"
//   "" (no name)     + dine_in   → "DINE-1"
const _typePrefixMap = {
  dine_in:    'DINE',
  takeaway:   'TAKE',
  delivery:   'DELIV',
  aggregator: 'AGG',
  phone:      'PHONE',
  app:        'APP',
  online:     'WEB'
};
function _slugifyName(s){
  if (!s) return '';
  // Take only ASCII alphanumeric + uppercase. Strip accents/diacritics.
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.toUpperCase())
    .join('-')
    .slice(0, 16);
}
async function _generateChannelCode(name, channelType, excludeId) {
  // Try name-based first
  let base = _slugifyName(name);
  // If name is purely Arabic / no Latin chars, fall back to type prefix
  if (!base || base.length < 2) {
    base = _typePrefixMap[channelType] || 'CH';
  }
  // Check uniqueness — append -N if needed
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : (base + '-' + (i + 1));
    const params = [candidate];
    let sql = 'SELECT id FROM sales_channels WHERE code = ?';
    if (excludeId) { sql += ' AND id != ?'; params.push(excludeId); }
    const [r] = await db.query(sql, params);
    if (!r.length) return candidate;
  }
  // Last resort — timestamp-based
  return (base || 'CH') + '-' + Date.now();
}

// V5.7.8 — Public helper endpoint: suggest a code for given name + type.
// Used by the frontend to show a live preview as user types the name.
router.get('/__suggest-code', async (req, res) => {
  try {
    const name = req.query.name || '';
    const channelType = req.query.channelType || 'dine_in';
    const excludeId = req.query.excludeId || null;
    const code = await _generateChannelCode(name, channelType, excludeId);
    res.json({ code: code });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create or update — G-SALES: `channels.manage` (sensitive; manager/admin).
router.post('/', requireCapability('channels.manage'), async (req, res) => {
  try {
    const {
      id, name, nameEn, channelType, priceListId,
      icon, color, commissionPct, serviceFeePct,
      glRevenueAccount, glCommissionAccount,
      requiresExternalRef, allowDiscount, isActive, displayOrder, notes,
      // v5.10.29 — explicit independence flag from the admin form
      useFullMenu
    } = req.body;
    let { code } = req.body;

    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });

    // V5.7.8 — auto-generate code if not provided (or empty/whitespace)
    let codeWasAutoGenerated = false;
    if (!code || !String(code).trim()) {
      code = await _generateChannelCode(name, channelType || 'dine_in', null);
      codeWasAutoGenerated = true;
    }

    // v5.10.29 — Default for useFullMenu:
    //   • Explicit value from request wins
    //   • MAIN code or dine_in type → TRUE (legacy implicit behavior)
    //   • Everything else → FALSE (truly independent menu)
    let useFullMenuFlag;
    if (useFullMenu !== undefined && useFullMenu !== null) {
      useFullMenuFlag = useFullMenu ? 1 : 0;
    } else {
      const isMainLike = String(code || '').toUpperCase() === 'MAIN' ||
                         String(channelType || '').toLowerCase() === 'dine_in';
      useFullMenuFlag = isMainLike ? 1 : 0;
    }

    const params = [
      code, name, nameEn || name, channelType || 'dine_in',
      priceListId || null,
      icon || 'fa-store', color || '#3b82f6',
      commissionPct || 0, serviceFeePct || 0,
      glRevenueAccount || null, glCommissionAccount || null,
      requiresExternalRef ? 1 : 0,
      allowDiscount !== false ? 1 : 0,
      isActive !== false ? 1 : 0,
      displayOrder || 0,
      notes || '',
      useFullMenuFlag
    ];

    if (id) {
      await db.query(
        `UPDATE sales_channels SET
           code=?, name=?, name_en=?, channel_type=?,
           price_list_id=?, icon=?, color=?,
           commission_pct=?, service_fee_pct=?,
           gl_revenue_account=?, gl_commission_account=?,
           requires_external_ref=?, allow_discount=?,
           is_active=?, display_order=?, notes=?,
           use_full_menu=?
         WHERE id=?`,
        params.concat([id])
      );
      return res.json({ success: true, id, code: code, codeWasAutoGenerated });
    }

    // Check for duplicate code (race-condition guard — auto-gen already checked, but user-supplied might collide)
    const [existing] = await db.query('SELECT id FROM sales_channels WHERE code = ?', [code]);
    if (existing.length) {
      // If the user EXPLICITLY supplied this code, fail clearly. If we auto-generated and somehow collided, regenerate.
      if (codeWasAutoGenerated) {
        code = await _generateChannelCode(name, channelType || 'dine_in', null);
        params[0] = code;  // update the params array
      } else {
        return res.json({ success: false, error: 'هذا الرمز مستخدم مسبقاً: ' + code });
      }
    }

    const newId = 'CH-' + Date.now();
    await db.query(
      `INSERT INTO sales_channels (
         id, code, name, name_en, channel_type,
         price_list_id, icon, color,
         commission_pct, service_fee_pct,
         gl_revenue_account, gl_commission_account,
         requires_external_ref, allow_discount,
         is_active, display_order, notes,
         use_full_menu
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId].concat(params)
    );
    res.json({ success: true, id: newId, code: code, codeWasAutoGenerated });
  } catch (e) {
    // G-SALES error honesty — was res.json({success:false}) with HTTP 200.
    console.error('[POST /sales-channels]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// V5.7.3 — Explicit PUT endpoint for editing (cleaner REST + accepts partial updates)
//   Body: any subset of channel fields; only provided fields are updated.
//   Backend validates the new code is unique IF the user changed it.
router.put('/:id', requireCapability('channels.manage'), async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    // Verify the channel exists
    const [existing] = await db.query('SELECT id, code FROM sales_channels WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ success: false, error: 'القناة غير موجودة' });

    // If code changed, check for duplicate
    if (b.code && b.code !== existing[0].code) {
      const [dup] = await db.query('SELECT id FROM sales_channels WHERE code = ? AND id != ?', [b.code, id]);
      if (dup.length) return res.status(409).json({ success: false, error: 'هذا الرمز مستخدم في قناة أخرى' });
    }

    // Build dynamic UPDATE based on provided fields
    const fieldMap = {
      code: 'code', name: 'name', nameEn: 'name_en', channelType: 'channel_type',
      priceListId: 'price_list_id', icon: 'icon', color: 'color',
      commissionPct: 'commission_pct', serviceFeePct: 'service_fee_pct',
      glRevenueAccount: 'gl_revenue_account', glCommissionAccount: 'gl_commission_account',
      displayOrder: 'display_order', notes: 'notes'
    };
    const boolMap = {
      requiresExternalRef: 'requires_external_ref',
      allowDiscount: 'allow_discount',
      isActive: 'is_active',
      // v5.10.29 — toggle the "show full menu vs only configured items" flag
      useFullMenu: 'use_full_menu'
    };
    const sets = []; const params = [];
    for (const [k, col] of Object.entries(fieldMap)) {
      if (k in b) { sets.push(`${col}=?`); params.push(b[k] === '' ? null : b[k]); }
    }
    for (const [k, col] of Object.entries(boolMap)) {
      if (k in b) { sets.push(`${col}=?`); params.push(b[k] ? 1 : 0); }
    }
    if (!sets.length) return res.json({ success: true, noop: true, message: 'لا تغييرات' });
    params.push(id);
    await db.query(`UPDATE sales_channels SET ${sets.join(',')} WHERE id = ?`, params);

    // Audit
    try {
      const username = (req.user && req.user.username) || 'system';
      await db.query(
        `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at)
         VALUES (?, 'channel_update', 'sales_channel', ?, ?, NOW())`,
        [username, id, JSON.stringify({ changed: Object.keys(b) })]);
    } catch(_) { /* best-effort audit trail — must not block the update */ }
    res.json({ success: true, id, updated: sets.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Delete (only if no sales linked — soft check)
router.delete('/:id', requireCapability('channels.manage'), async (req, res) => {
  try {
    // Optional: check if sales reference this channel before deleting
    try {
      const [linked] = await db.query("SELECT COUNT(*) AS c FROM sales WHERE channel_id = ?", [req.params.id]);
      if (linked[0] && linked[0].c > 0) {
        return res.json({ success: false, error: 'لا يمكن حذف القناة — مرتبطة بمبيعات (' + linked[0].c + ')' });
      }
    } catch(_) { /* cosmetic schema tolerance — sales.channel_id might not exist yet */ }

    await db.query('DELETE FROM sales_channels WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    // G-SALES error honesty — destructive endpoint must never mask failure as 200.
    console.error('[DELETE /sales-channels/:id]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Toggle active flag
router.patch('/:id/toggle', requireCapability('channels.manage'), async (req, res) => {
  try {
    await db.query('UPDATE sales_channels SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    // G-SALES error honesty — was res.json({success:false}) with HTTP 200.
    console.error('[PATCH /sales-channels/:id/toggle]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
