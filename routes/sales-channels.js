// ═══════════════════════════════════════════════════════════════════
// SALES CHANNELS — multi-channel pricing (main menu / Hangerstation / Keeta / app / phone)
// Each channel can be linked to a specific price list to enforce
// "no price-mixing in same invoice" rule.
// ═══════════════════════════════════════════════════════════════════

const router = require('express').Router();
const db = require('../db/connection');

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
      notes: c.notes || ''
    })));
  } catch (e) {
    res.json({ error: e.message, channels: [] });
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
      allowDiscount: c.allow_discount !== 0
    })));
  } catch (e) { res.json([]); }
});

// Create or update
router.post('/', async (req, res) => {
  try {
    const {
      id, code, name, nameEn, channelType, priceListId,
      icon, color, commissionPct, serviceFeePct,
      glRevenueAccount, glCommissionAccount,
      requiresExternalRef, allowDiscount, isActive, displayOrder, notes
    } = req.body;

    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (!code) return res.json({ success: false, error: 'الرمز مطلوب' });

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
      notes || ''
    ];

    if (id) {
      await db.query(
        `UPDATE sales_channels SET
           code=?, name=?, name_en=?, channel_type=?,
           price_list_id=?, icon=?, color=?,
           commission_pct=?, service_fee_pct=?,
           gl_revenue_account=?, gl_commission_account=?,
           requires_external_ref=?, allow_discount=?,
           is_active=?, display_order=?, notes=?
         WHERE id=?`,
        params.concat([id])
      );
      return res.json({ success: true, id });
    }

    // Check for duplicate code
    const [existing] = await db.query('SELECT id FROM sales_channels WHERE code = ?', [code]);
    if (existing.length) return res.json({ success: false, error: 'هذا الرمز مستخدم مسبقاً' });

    const newId = 'CH-' + Date.now();
    await db.query(
      `INSERT INTO sales_channels (
         id, code, name, name_en, channel_type,
         price_list_id, icon, color,
         commission_pct, service_fee_pct,
         gl_revenue_account, gl_commission_account,
         requires_external_ref, allow_discount,
         is_active, display_order, notes
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId].concat(params)
    );
    res.json({ success: true, id: newId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete (only if no sales linked — soft check)
router.delete('/:id', async (req, res) => {
  try {
    // Optional: check if sales reference this channel before deleting
    try {
      const [linked] = await db.query("SELECT COUNT(*) AS c FROM sales WHERE channel_id = ?", [req.params.id]);
      if (linked[0] && linked[0].c > 0) {
        return res.json({ success: false, error: 'لا يمكن حذف القناة — مرتبطة بمبيعات (' + linked[0].c + ')' });
      }
    } catch(_) { /* sales.channel_id might not exist yet — ignore */ }

    await db.query('DELETE FROM sales_channels WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Toggle active flag
router.patch('/:id/toggle', async (req, res) => {
  try {
    await db.query('UPDATE sales_channels SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
