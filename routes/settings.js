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

module.exports = router;
