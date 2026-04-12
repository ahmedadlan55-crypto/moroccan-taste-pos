const router = require('express').Router();
const db = require('../db/connection');

// Get all settings
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT setting_key, setting_value FROM settings');
    const settings = {};
    rows.forEach(s => { settings[s.setting_key] = s.setting_value; });
    res.json(settings);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Update settings
router.put('/', async (req, res) => {
  try {
    const settings = req.body;

    for (const [key, value] of Object.entries(settings)) {
      await db.query(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [key, value, value]
      );
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get payment methods
router.get('/payment-methods', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM payment_methods ORDER BY sort_order');
    res.json(rows.map(p => ({
      ID: p.id, Name: p.name, NameAR: p.name_ar, Icon: p.icon,
      IsActive: p.is_active, ServiceFeeRate: Number(p.service_fee_rate), SortOrder: p.sort_order
    })));
  } catch (e) {
    res.json([]);
  }
});

// Save payment methods
router.put('/payment-methods', async (req, res) => {
  try {
    const { methods } = req.body;
    if (!methods || !methods.length) return res.json({ success: false, error: 'No methods provided' });

    for (const m of methods) {
      if (m.ID) {
        await db.query(
          'UPDATE payment_methods SET name=?, name_ar=?, icon=?, is_active=?, service_fee_rate=?, sort_order=? WHERE id=?',
          [m.Name, m.NameAR || '', m.Icon || 'fa-money-bill', m.IsActive !== false, m.ServiceFeeRate || 0, m.SortOrder || 0, m.ID]
        );
      } else {
        await db.query(
          'INSERT INTO payment_methods (name, name_ar, icon, is_active, service_fee_rate, sort_order) VALUES (?,?,?,?,?,?)',
          [m.Name, m.NameAR || '', m.Icon || 'fa-money-bill', m.IsActive !== false, m.ServiceFeeRate || 0, m.SortOrder || 0]
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Delete a single payment method
router.delete('/payment-methods/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get discounts
router.get('/discounts', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'discounts'");
    if (rows.length && rows[0].setting_value) {
      res.json(JSON.parse(rows[0].setting_value));
    } else {
      res.json([]);
    }
  } catch (e) {
    res.json([]);
  }
});

// Recompute all menu costs from current ingredient prices
router.post('/recompute-costs', async (req, res) => {
  try {
    const { recomputeAllMenuCosts } = require('./pricing-utils');
    const count = await recomputeAllMenuCosts();
    res.json({ success: true, recomputed: count });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════
// ADVANCED DISCOUNTS (v2)
// ═══════════════════════════════════════

router.get('/discounts-v2', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM discounts_v2 ORDER BY display_order, name');
    res.json(rows.map(d => ({
      id: d.id, name: d.name, type: d.type, value: Number(d.value), maxAmount: Number(d.max_amount),
      minOrder: Number(d.min_order), requireApproval: !!d.require_approval, requireCode: !!d.require_code,
      code: d.code, enabled: !!d.enabled, displayOrder: d.display_order,
      validFrom: d.valid_from, validTo: d.valid_to, applyOn: d.apply_on, color: d.color
    })));
  } catch(e) { res.json([]); }
});

router.post('/discounts-v2', async (req, res) => {
  try {
    const { id, name, type, value, maxAmount, minOrder, requireApproval, requireCode, code, enabled, displayOrder, validFrom, validTo, applyOn, color } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query(
        `UPDATE discounts_v2 SET name=?, type=?, value=?, max_amount=?, min_order=?, require_approval=?, require_code=?, code=?, enabled=?, display_order=?, valid_from=?, valid_to=?, apply_on=?, color=? WHERE id=?`,
        [name, type||'percentage', value||0, maxAmount||0, minOrder||0, requireApproval?1:0, requireCode?1:0, code||'', enabled!==false?1:0, displayOrder||0, validFrom||null, validTo||null, applyOn||'invoice', color||'#8b5cf6', id]
      );
      return res.json({ success: true, id });
    }
    const newId = 'DISC-' + Date.now();
    await db.query(
      `INSERT INTO discounts_v2 (id, name, type, value, max_amount, min_order, require_approval, require_code, code, enabled, display_order, valid_from, valid_to, apply_on, color) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, type||'percentage', value||0, maxAmount||0, minOrder||0, requireApproval?1:0, requireCode?1:0, code||'', enabled!==false?1:0, displayOrder||0, validFrom||null, validTo||null, applyOn||'invoice', color||'#8b5cf6']
    );
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/discounts-v2/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM branch_discounts WHERE discount_id = ?', [req.params.id]);
    await db.query('DELETE FROM discounts_v2 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Enhanced payment methods with new fields
router.get('/payment-methods-full', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM payment_methods ORDER BY sort_order, name');
    res.json(rows.map(p => ({
      id: p.id, name: p.name, nameAr: p.name_ar, icon: p.icon, isActive: !!p.is_active,
      serviceFeeRate: Number(p.service_fee_rate), sortOrder: p.sort_order,
      type: p.type||'standard', requireReference: !!p.require_reference,
      requireTransactionNumber: !!p.require_transaction_number, requireTerminal: !!p.require_terminal,
      allowRefund: p.allow_refund!==0, allowCancel: p.allow_cancel!==0, color: p.color||'#3b82f6'
    })));
  } catch(e) { res.json([]); }
});

router.post('/payment-methods-full', async (req, res) => {
  try {
    const { id, name, nameAr, icon, isActive, serviceFeeRate, sortOrder, type, requireReference, requireTransactionNumber, requireTerminal, allowRefund, allowCancel, color } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query(
        `UPDATE payment_methods SET name=?, name_ar=?, icon=?, is_active=?, service_fee_rate=?, sort_order=?, type=?, require_reference=?, require_transaction_number=?, require_terminal=?, allow_refund=?, allow_cancel=?, color=? WHERE id=?`,
        [name, nameAr||name, icon||'fa-money-bill', isActive!==false?1:0, serviceFeeRate||0, sortOrder||0, type||'standard', requireReference?1:0, requireTransactionNumber?1:0, requireTerminal?1:0, allowRefund!==false?1:0, allowCancel!==false?1:0, color||'#3b82f6', id]
      );
      return res.json({ success: true, id });
    }
    const newId = 'PM-' + Date.now();
    await db.query(
      `INSERT INTO payment_methods (id, name, name_ar, icon, is_active, service_fee_rate, sort_order, type, require_reference, require_transaction_number, require_terminal, allow_refund, allow_cancel, color) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, nameAr||name, icon||'fa-money-bill', isActive!==false?1:0, serviceFeeRate||0, sortOrder||0, type||'standard', requireReference?1:0, requireTransactionNumber?1:0, requireTerminal?1:0, allowRefund!==false?1:0, allowCancel!==false?1:0, color||'#3b82f6']
    );
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
