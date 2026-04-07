const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');
const path = require('path');
const verifyToken = require('./authMiddleware');

// Serve protected app template
router.get('/template', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/app-content.html'));
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await db.query('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
    if (!rows.length) return res.json({ success: false, error: 'Invalid credentials' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.json({ success: false, error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, username: user.username, role: user.role, token });
  } catch (e) { res.json({ success: false, error: e.message }); }
});


// Get initial app data
router.get('/init/:username', async (req, res) => {
  try {
    const [settings] = await db.query('SELECT setting_key, setting_value FROM settings');
    const settingsObj = {};
    settings.forEach(s => { settingsObj[s.setting_key] = s.setting_value; });

    const [menu] = await db.query('SELECT * FROM menu WHERE active = 1 ORDER BY category, name');
    const [payMethods] = await db.query('SELECT * FROM payment_methods ORDER BY sort_order');
    const [users] = await db.query('SELECT username FROM users WHERE active = 1');

    // Check open shift
    const [shifts] = await db.query('SELECT id FROM shifts WHERE username = ? AND status = "OPEN"', [req.params.username]);

    // Lookup metadata + role for current user
    let userMeta = {};
    try {
      const metaRow = settingsObj.user_meta;
      if (metaRow) userMeta = JSON.parse(metaRow) || {};
    } catch (e) {}
    const me = userMeta[req.params.username] || {};
    const [meRows] = await db.query('SELECT role FROM users WHERE username = ?', [req.params.username]);
    const myRole = meRows.length ? meRows[0].role : 'cashier';

    res.json({
      settings: {
        name: settingsObj.CompanyName || 'Moroccan Taste',
        taxNumber: settingsObj.TaxNumber || '',
        currency: settingsObj.Currency || 'SAR',
        logo: settingsObj.logo || ''
      },
      kitaFeeRate: Number(settingsObj.KitaServiceFee) || 0,
      menu: menu.map(m => ({
        id: m.id, name: m.name, price: Number(m.price), category: m.category,
        cost: Number(m.cost), stock: m.stock, minStock: m.min_stock, active: m.active
      })),
      activeShiftId: shifts.length ? shifts[0].id : '',
      usernames: users.map(u => u.username),
      currentUser: {
        username: req.params.username,
        displayName: me.name || '',
        role: myRole,
        isDeveloper: !!me.isDeveloper || myRole === 'admin'
      },
      userMeta: userMeta,
      paymentMethods: payMethods.map(p => ({
        ID: p.id, Name: p.name, NameAR: p.name_ar, Icon: p.icon,
        IsActive: p.is_active, ServiceFeeRate: Number(p.service_fee_rate), SortOrder: p.sort_order
      }))
    });
  } catch (e) { res.json({ error: e.message }); }
});

// ─── User metadata helpers (display name + developer flag) ───
// Stored as JSON in the existing settings table — no schema change required.
async function getUserMeta() {
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
    if (!rows.length || !rows[0].setting_value) return {};
    return JSON.parse(rows[0].setting_value) || {};
  } catch (e) { return {}; }
}
async function setUserMeta(meta) {
  const json = JSON.stringify(meta || {});
  await db.query(
    "INSERT INTO settings (setting_key, setting_value) VALUES ('user_meta', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
    [json, json]
  );
}

// ─── Users CRUD ───
// GET /api/auth/users — list users with display name + developer flag
router.get('/users', async (req, res) => {
  try {
    const [users] = await db.query('SELECT id, username, role, active, created_at FROM users ORDER BY created_at DESC');
    const meta = await getUserMeta();
    res.json(users.map(u => {
      const m = meta[u.username] || {};
      // Default the seed admin user to "مدير النظام" so the row never looks empty,
      // and treat any admin-role user as a developer by default (matches auth/init).
      const fallbackName = u.username === 'admin' ? 'مدير النظام' : '';
      return {
        username: u.username,
        role: u.role,
        active: !!u.active,
        createdAt: u.created_at,
        displayName: m.name || fallbackName,
        isDeveloper: !!m.isDeveloper || u.role === 'admin'
      };
    }));
  } catch (e) { res.json([]); }
});

// POST /api/auth/users — add new user (username = employee number)
router.post('/users', async (req, res) => {
  try {
    const { username, password, role, displayName, isDeveloper } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان' });

    const hash = await bcrypt.hash(password, 10);
    // Map developer to admin role at the DB level (ENUM doesn't allow new values)
    const dbRole = ['admin', 'cashier', 'manager'].indexOf(role) >= 0 ? role : 'cashier';

    await db.query(
      'INSERT INTO users (username, password, role, active) VALUES (?, ?, ?, 1)',
      [username, hash, dbRole]
    );

    if (displayName || isDeveloper) {
      const meta = await getUserMeta();
      meta[username] = meta[username] || {};
      if (displayName) meta[username].name = displayName;
      if (isDeveloper) meta[username].isDeveloper = true;
      await setUserMeta(meta);
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// PUT /api/auth/users/:username — update display name, password, role
router.put('/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { displayName, password, role, isDeveloper } = req.body;

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password = ? WHERE username = ?', [hash, username]);
    }
    if (role && ['admin', 'cashier', 'manager'].indexOf(role) >= 0) {
      await db.query('UPDATE users SET role = ? WHERE username = ?', [role, username]);
    }
    if (displayName !== undefined || isDeveloper !== undefined) {
      const meta = await getUserMeta();
      meta[username] = meta[username] || {};
      if (displayName !== undefined) meta[username].name = displayName;
      if (isDeveloper !== undefined) meta[username].isDeveloper = !!isDeveloper;
      await setUserMeta(meta);
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// POST /api/auth/users/:username/toggle — toggle active
router.post('/users/:username/toggle', async (req, res) => {
  try {
    if (req.params.username === 'admin') return res.json({ success: false, error: 'لا يمكن إيقاف المستخدم admin' });
    await db.query('UPDATE users SET active = 1 - active WHERE username = ?', [req.params.username]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// DELETE /api/auth/users/:username
router.delete('/users/:username', async (req, res) => {
  try {
    if (req.params.username === 'admin') return res.json({ success: false, error: 'لا يمكن حذف المستخدم admin' });
    await db.query('DELETE FROM users WHERE username = ?', [req.params.username]);
    // Also remove from meta
    const meta = await getUserMeta();
    if (meta[req.params.username]) {
      delete meta[req.params.username];
      await setUserMeta(meta);
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// POST /api/auth/reset-db — DEVELOPER ONLY: wipe all transactional data
router.post('/reset-db', async (req, res) => {
  try {
    const { confirm, username, password } = req.body;

    if (confirm !== 'YES_RESET_ALL_DATA') {
      return res.json({ success: false, error: 'تأكيد غير صالح' });
    }
    if (!username || !password) {
      return res.json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان للتأكيد' });
    }

    // Re-verify the requesting user with username + password (defence in depth)
    const [users] = await db.query('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
    if (!users.length) return res.json({ success: false, error: 'المستخدم غير موجود' });
    const valid = await bcrypt.compare(password, users[0].password);
    if (!valid) return res.json({ success: false, error: 'كلمة المرور غير صحيحة' });

    // Verify developer flag from user_meta (or admin role as fallback)
    const meta = await getUserMeta();
    const userMeta = meta[username] || {};
    const isDev = !!userMeta.isDeveloper || users[0].role === 'admin';
    if (!isDev) {
      return res.json({ success: false, error: 'هذه العملية متاحة للمطور فقط' });
    }

    // Wipe transactional data — keep users, settings, payment_methods
    const tables = [
      'sales_items', 'sales',
      'inventory_movements',
      'recipe', 'menu',
      'inv_items',
      'shifts',
      'expenses',
      'purchases',
      'po_lines', 'purchase_orders',
      'gl_entries', 'gl_journals',
      'vat_reports',
      'audit_log'
    ];
    const wiped = [];
    for (const t of tables) {
      try {
        await db.query(`DELETE FROM ${t}`);
        wiped.push(t);
      } catch (e) {
        // Table may not exist — ignore
      }
    }

    res.json({ success: true, wiped });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
