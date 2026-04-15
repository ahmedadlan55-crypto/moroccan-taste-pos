const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');
const path = require('path');
const verifyToken = require('./authMiddleware');

// ─── In-memory rate limiter (per IP) ───
const loginAttempts = {}; // { ip: { count, firstAttempt, blockedUntil } }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const BLOCK_MS = 15 * 60 * 1000;  // 15 minutes block

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts[ip];
  if (!entry) return { allowed: true };
  if (entry.blockedUntil && now < entry.blockedUntil) {
    const remaining = Math.ceil((entry.blockedUntil - now) / 60000);
    return { allowed: false, remaining };
  }
  if (now - entry.firstAttempt > WINDOW_MS) {
    delete loginAttempts[ip]; // Window expired, reset
    return { allowed: true };
  }
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_MS;
    const remaining = Math.ceil(BLOCK_MS / 60000);
    return { allowed: false, remaining };
  }
  return { allowed: true };
}
function recordFailedAttempt(ip) {
  const now = Date.now();
  if (!loginAttempts[ip] || (now - loginAttempts[ip].firstAttempt > WINDOW_MS)) {
    loginAttempts[ip] = { count: 1, firstAttempt: now };
  } else {
    loginAttempts[ip].count++;
  }
}
function clearAttempts(ip) { delete loginAttempts[ip]; }

// Serve protected app template
router.get('/template', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/app-content.html'));
});

// Login — with rate limiting + account lockout
router.post('/login', async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const { username, password } = req.body;

    // Rate limit check
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
      return res.json({ success: false, error: 'تم تجاوز الحد المسموح. حاول بعد ' + rateCheck.remaining + ' دقيقة' });
    }

    if (!username || !password) return res.json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان' });

    const [rows] = await db.query('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
    if (!rows.length) {
      recordFailedAttempt(ip);
      return res.json({ success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const user = rows[0];

    // Account lockout check
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.json({ success: false, error: 'الحساب مقفل. حاول بعد ' + remaining + ' دقيقة' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      recordFailedAttempt(ip);
      // Increment DB failed attempts
      const failedCount = (Number(user.failed_attempts) || 0) + 1;
      if (failedCount >= MAX_ATTEMPTS) {
        await db.query('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?',
          [failedCount, new Date(Date.now() + BLOCK_MS), user.id]);
        return res.json({ success: false, error: 'تم قفل الحساب بعد ' + MAX_ATTEMPTS + ' محاولات فاشلة. حاول بعد 15 دقيقة' });
      } else {
        await db.query('UPDATE users SET failed_attempts = ? WHERE id = ?', [failedCount, user.id]);
        return res.json({ success: false, error: 'كلمة المرور غير صحيحة. متبقي ' + (MAX_ATTEMPTS - failedCount) + ' محاولات' });
      }
    }

    // Success — reset counters
    clearAttempts(ip);
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [user.id]);

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, brandId: user.brand_id || '', branchId: user.branch_id || '' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, username: user.username, role: user.role, token, brandId: user.brand_id || '', branchId: user.branch_id || '' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});


// Refresh token (extend session while user is active)
router.post('/refresh-token', (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.json({ success: false });
    const oldToken = authHeader.split(' ')[1];
    const decoded = jwt.verify(oldToken, process.env.JWT_SECRET, { ignoreExpiration: true });
    // Issue new token with same payload
    const token = jwt.sign({ id: decoded.id, username: decoded.username, role: decoded.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } catch (e) { res.json({ success: false }); }
});

// Get initial app data
router.get('/init/:username', async (req, res) => {
  try {
    const [settings] = await db.query('SELECT setting_key, setting_value FROM settings');
    const settingsObj = {};
    settings.forEach(s => { settingsObj[s.setting_key] = s.setting_value; });

    // Get user's brand_id to filter menu
    const [userRow] = await db.query('SELECT brand_id, branch_id FROM users WHERE username = ?', [req.params.username]);
    const userBrandId = userRow.length ? userRow[0].brand_id : '';
    const userBranchId = userRow.length ? userRow[0].branch_id : '';

    // Menu filtered by brand (if user has a brand assigned)
    const menuQuery = userBrandId
      ? 'SELECT * FROM menu WHERE active = 1 AND (brand_id = ? OR brand_id IS NULL OR brand_id = "") ORDER BY category, name'
      : 'SELECT * FROM menu WHERE active = 1 ORDER BY category, name';
    const menuParams = userBrandId ? [userBrandId] : [];
    const [menu] = await db.query(menuQuery, menuParams);
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
        logo: settingsObj.logo || '',
        branchName: settingsObj.BranchName || ''
      },
      kitaFeeRate: Number(settingsObj.KitaServiceFee) || 0,
      menu: menu.map(m => ({
        id: m.id, name: m.name, price: Number(m.price), category: m.category,
        cost: Number(m.cost), stock: m.stock, minStock: m.min_stock, active: m.active,
        brandId: m.brand_id || ''
      })),
      activeShiftId: shifts.length ? shifts[0].id : '',
      usernames: users.map(u => u.username),
      brandId: userBrandId || '',
      branchId: userBranchId || '',
      currentUser: {
        username: req.params.username,
        displayName: me.name || '',
        role: myRole,
        isDeveloper: !!me.isDeveloper || myRole === 'admin',
        brandId: userBrandId || '',
        branchId: userBranchId || ''
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
    const [users] = await db.query('SELECT id, username, role, active, created_at, email, plain_pass FROM users ORDER BY created_at DESC');
    const meta = await getUserMeta();
    res.json(users.map(u => {
      const m = meta[u.username] || {};
      const fallbackName = u.username === 'admin' ? 'مدير النظام' : '';
      return {
        username: u.username,
        role: u.role,
        active: !!u.active,
        createdAt: u.created_at,
        displayName: m.name || fallbackName,
        isDeveloper: !!m.isDeveloper || u.role === 'admin',
        email: u.email || '',
        plainPass: u.plain_pass || ''
      };
    }));
  } catch (e) { res.json([]); }
});

// POST /api/auth/users — add new user (username = employee number)
router.post('/users', async (req, res) => {
  try {
    const { username, password, role, displayName, isDeveloper, email } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    // Password validation: min 6 chars, must have letter + number + special char
    if (password.length < 6) return res.json({ success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    if (!/[a-zA-Z]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على حروف' });
    if (!/[0-9]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على أرقام' });
    if (!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>\/?]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على رمز خاص (!@#$...)' });

    const hash = await bcrypt.hash(password, 10);
    const dbRole = ['admin', 'cashier', 'manager', 'custody'].indexOf(role) >= 0 ? role : 'cashier';

    await db.query(
      'INSERT INTO users (username, password, role, active, email, plain_pass) VALUES (?, ?, ?, 1, ?, ?)',
      [username, hash, dbRole, email||'', password]
    );

    if (displayName || isDeveloper) {
      const meta = await getUserMeta();
      meta[username] = meta[username] || {};
      if (displayName) meta[username].name = displayName;
      if (isDeveloper) meta[username].isDeveloper = true;
      await setUserMeta(meta);
    }

    // Auto-create custody_users record when role is custody
    if (dbRole === 'custody') {
      try {
        const cuId = 'CU-' + Date.now();
        await db.query(
          'INSERT INTO custody_users (id, name, job_title, linked_username) VALUES (?,?,?,?)',
          [cuId, displayName || username, 'مسؤول عهدة', username]
        );
      } catch(e) { /* ignore if custody_users table not yet created */ }
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
    const { displayName, password, role, isDeveloper, email } = req.body;

    if (email !== undefined) {
      await db.query('UPDATE users SET email = ? WHERE username = ?', [email || '', username]);
    }

    if (password) {
      if (password.length < 6) return res.json({ success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
      if (!/[a-zA-Z]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على حروف' });
      if (!/[0-9]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على أرقام' });
      if (!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>\/?]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على رمز خاص' });
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password = ?, plain_pass = ? WHERE username = ?', [hash, password, username]);
    }
    if (role && ['admin', 'cashier', 'manager', 'custody'].indexOf(role) >= 0) {
      await db.query('UPDATE users SET role = ? WHERE username = ?', [role, username]);
      // Auto-create custody_users record if switching to custody role
      if (role === 'custody') {
        try {
          const [existing] = await db.query('SELECT id FROM custody_users WHERE linked_username = ?', [username]);
          if (!existing.length) {
            const cuId = 'CU-' + Date.now();
            await db.query(
              'INSERT INTO custody_users (id, name, job_title, linked_username) VALUES (?,?,?,?)',
              [cuId, displayName || username, 'مسؤول عهدة', username]
            );
          }
        } catch(e) {}
      }
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
// Reset user password
router.post('/users/:username/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) return res.json({ success: false, error: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل' });
    const hashed = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password = ?, failed_attempts = 0, locked_until = NULL WHERE username = ?', [hashed, req.params.username]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

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
