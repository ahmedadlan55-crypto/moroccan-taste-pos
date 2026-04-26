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

    const token = jwt.sign({
      id: user.id, username: user.username, role: user.role,
      brandId: user.brand_id || '', branchId: user.branch_id || '',
      default_warehouse_id: user.default_warehouse_id || ''
    }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({
      success: true, username: user.username, role: user.role, token,
      brandId: user.brand_id || '', branchId: user.branch_id || '',
      warehouseId: user.default_warehouse_id || ''
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});


// Refresh token — verify user still exists and is active before reissuing
router.post('/refresh-token', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.json({ success: false });
    const oldToken = authHeader.split(' ')[1];
    const decoded = jwt.verify(oldToken, process.env.JWT_SECRET, { ignoreExpiration: true });
    // Verify user still exists and is active in database
    const [users] = await db.query('SELECT id, username, role, active, brand_id, branch_id FROM users WHERE username = ?', [decoded.username]);
    if (!users.length || !users[0].active) return res.json({ success: false, error: 'الحساب غير نشط أو محذوف' });
    const user = users[0];
    // Issue new token with CURRENT role (not old one — in case role changed)
    const token = jwt.sign({
      id: user.id, username: user.username, role: user.role,
      brandId: user.brand_id || '', branchId: user.branch_id || ''
    }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, role: user.role });
  } catch (e) { res.json({ success: false }); }
});

// Get initial app data
router.get('/init/:username', async (req, res) => {
  try {
    const [settings] = await db.query('SELECT setting_key, setting_value FROM settings');
    const settingsObj = {};
    settings.forEach(s => { settingsObj[s.setting_key] = s.setting_value; });

    // Get user's brand_id, branch_id, warehouse_id
    const [userRow] = await db.query('SELECT brand_id, branch_id, default_warehouse_id FROM users WHERE username = ?', [req.params.username]);
    const userBrandId = userRow.length ? userRow[0].brand_id : '';
    const userBranchId = userRow.length ? userRow[0].branch_id : '';
    const userWarehouseId = userRow.length ? userRow[0].default_warehouse_id : '';

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
      warehouseId: userWarehouseId || '',
      currentUser: {
        username: req.params.username,
        displayName: me.name || '',
        role: myRole,
        // V3 SECURITY FIX: Developer flag is ONLY for the primary 'admin' account
        // OR users explicitly granted via meta. NOT auto-granted for any 'admin' role
        // (مدير مؤسسة ≠ مطور).
        isDeveloper: !!me.isDeveloper || req.params.username === 'admin',
        brandId: userBrandId || '',
        branchId: userBranchId || '',
        warehouseId: userWarehouseId || ''
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
    // Detect optional columns (phone/full_name were added via migration)
    let hasPhone = true, hasFullName = true, hasCanChange = true, hasDefBranch = true;
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'phone'"); hasPhone = !!c.length; } catch(e) { hasPhone = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'full_name'"); hasFullName = !!c.length; } catch(e) { hasFullName = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'can_change_branch'"); hasCanChange = !!c.length; } catch(e) { hasCanChange = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'default_branch_id'"); hasDefBranch = !!c.length; } catch(e) { hasDefBranch = false; }

    const extraCols = [
      hasPhone     ? 'u.phone'             : "'' AS phone",
      hasFullName  ? 'u.full_name'         : "'' AS full_name",
      hasCanChange ? 'u.can_change_branch' : '0 AS can_change_branch',
      hasDefBranch ? 'u.default_branch_id' : 'NULL AS default_branch_id'
    ];
    const [users] = await db.query(`
      SELECT u.id, u.username, u.role, u.active, u.created_at, u.email,
        u.brand_id, u.branch_id, u.default_warehouse_id, u.position_id,
        ${extraCols.join(', ')},
        COALESCE(br.name,'') AS branchName, COALESCE(bd.name,'') AS brandName,
        COALESCE(p.name,'') AS positionName,
        COALESCE(wh.name,'') AS warehouseName
      FROM users u
      LEFT JOIN branches br ON u.branch_id = br.id
      LEFT JOIN brands bd ON u.brand_id = bd.id
      LEFT JOIN positions p ON u.position_id = p.id
      LEFT JOIN warehouses wh ON u.default_warehouse_id = wh.id
      ORDER BY u.created_at DESC
    `);
    const meta = await getUserMeta();
    res.json(users.map(u => {
      const m = meta[u.username] || {};
      const fallbackName = u.username === 'admin' ? 'مدير النظام' : '';
      return {
        username: u.username,
        role: u.role,
        active: !!u.active,
        createdAt: u.created_at,
        displayName: u.full_name || m.name || fallbackName,
        // V3 SECURITY FIX: Developer flag = ONLY for primary 'admin' account
        // OR users explicitly granted via meta. NOT for any 'admin' role.
        isDeveloper: !!m.isDeveloper || u.username === 'admin',
        email: u.email || '',
        phone: u.phone || '',
        brandId: u.brand_id || '', brandName: u.brandName || '',
        branchId: u.branch_id || '', branchName: u.branchName || '',
        defaultBranchId: u.default_branch_id || u.branch_id || '',
        warehouseId: u.default_warehouse_id || '',
        defaultWarehouseId: u.default_warehouse_id || '',
        defaultWarehouseName: u.warehouseName || '',
        canChangeBranch: !!u.can_change_branch,
        positionId: u.position_id || '', positionName: u.positionName || ''
      };
    }));
  } catch (e) { res.json([]); }
});

// POST /api/auth/users — add new user (username = employee number)
router.post('/users', async (req, res) => {
  try {
    const { username, password, role, displayName, isDeveloper, email, brandId, branchId, phone } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    // Password validation
    if (password.length < 6) return res.json({ success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    if (!/[a-zA-Z]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على حروف' });
    if (!/[0-9]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على أرقام' });
    if (!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>\/?]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على رمز خاص (!@#$...)' });

    const hash = await bcrypt.hash(password, 10);
    const dbRole = ['admin', 'cashier', 'manager', 'custody', 'employee'].indexOf(role) >= 0 ? role : 'cashier';

    // V3: explicit defaultWarehouseId from request OR auto-derive from branch's warehouse
    let defaultWarehouseId = req.body.defaultWarehouseId || null;
    if (!defaultWarehouseId && branchId) {
      const [branchRow] = await db.query('SELECT warehouse_id FROM branches WHERE id = ?', [branchId]);
      if (branchRow.length && branchRow[0].warehouse_id) defaultWarehouseId = branchRow[0].warehouse_id;
    }

    const positionId = req.body.positionId || null;
    const canChangeBranch = req.body.canChangeBranch ? 1 : 0;
    await db.query(
      'INSERT INTO users (username, password, role, active, email, brand_id, branch_id, default_branch_id, default_warehouse_id, position_id, can_change_branch) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
      [username, hash, dbRole, email||'', brandId||null, branchId||null, branchId||null, defaultWarehouseId, positionId, canChangeBranch]
    );
    // Apply optional extras (phone + full_name) — tolerate old schemas without the columns
    if (phone) { try { await db.query('UPDATE users SET phone = ? WHERE username = ?', [phone, username]); } catch(e) {} }
    if (displayName) { try { await db.query('UPDATE users SET full_name = ? WHERE username = ?', [displayName, username]); } catch(e) {} }

    if (displayName || isDeveloper) {
      const meta = await getUserMeta();
      meta[username] = meta[username] || {};
      if (displayName) meta[username].name = displayName;
      // V3 SECURITY: Developer flag can ONLY be granted by the primary 'admin'
      // account. Block anyone else from granting it.
      const grantedBy = (req.user && req.user.username) || '';
      if (isDeveloper && grantedBy === 'admin') meta[username].isDeveloper = true;
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

// PUT /api/auth/users/:username — update display name, password, role, and everything else
router.put('/users/:username', async (req, res) => {
  try {
    let { username } = req.params;
    const {
      displayName, password, role, isDeveloper,
      email, brandId, branchId, positionId,
      newUsername, phone
    } = req.body;

    // Username rename (primary-key change) — cascade to related tables
    if (newUsername && newUsername !== username) {
      const safe = String(newUsername).trim();
      if (!/^[A-Za-z0-9_.@-]{2,50}$/.test(safe)) {
        return res.json({ success: false, error: 'اسم المستخدم الجديد غير صالح (أحرف/أرقام/نقطة/شرطة فقط، 2-50)' });
      }
      if (username === 'admin') return res.json({ success: false, error: 'لا يمكن تغيير اسم المستخدم admin' });
      const [taken] = await db.query('SELECT 1 FROM users WHERE username = ? LIMIT 1', [safe]);
      if (taken.length) return res.json({ success: false, error: 'اسم المستخدم الجديد مستخدم بالفعل' });

      // Apply rename atomically-ish: users table first, then cascade snapshots.
      // Foreign-key columns that reference username as text (denormalized) are
      // updated best-effort — wrap each in try/catch to tolerate older schemas.
      await db.query('UPDATE users SET username = ? WHERE username = ?', [safe, username]);
      const cascadeUpdates = [
        ['hr_employees', 'linked_username'],
        ['transactions', 'created_by'],
        ['transactions', 'current_assignee'],
        ['transactions', 'recipient_username'],
        ['transaction_steps_log', 'action_by'],
        ['txn_recipients', 'recipient_username'],
        ['custody_users', 'linked_username'],
        ['hr_advances', 'approved_by'],
        ['hr_advances', 'rejected_by'],
        ['hr_leave_requests', 'branch_approved_by'],
        ['hr_leave_requests', 'hr_approved_by'],
        ['hr_leave_requests', 'rejected_by'],
        ['audit_log', 'username']
      ];
      for (const [tbl, col] of cascadeUpdates) {
        try { await db.query('UPDATE ' + tbl + ' SET ' + col + ' = ? WHERE ' + col + ' = ?', [safe, username]); } catch(e) {}
      }

      // Migrate the user's meta entry under the new key
      try {
        const meta = await getUserMeta();
        if (meta[username]) { meta[safe] = meta[username]; delete meta[username]; await setUserMeta(meta); }
      } catch(e) {}

      username = safe;  // use the new name for the remaining updates below
    }

    if (positionId !== undefined) {
      await db.query('UPDATE users SET position_id = ? WHERE username = ?', [positionId || null, username]);
    }

    if (email !== undefined) {
      await db.query('UPDATE users SET email = ? WHERE username = ?', [email || '', username]);
    }
    if (phone !== undefined) {
      try { await db.query('UPDATE users SET phone = ? WHERE username = ?', [phone || '', username]); } catch(e) {}
    }
    if (displayName !== undefined) {
      try { await db.query('UPDATE users SET full_name = ? WHERE username = ?', [displayName || '', username]); } catch(e) {}
    }

    // Update brand + branch + warehouse (V3: explicit defaultWarehouseId from body, or auto-derive)
    if (brandId !== undefined) await db.query('UPDATE users SET brand_id = ? WHERE username = ?', [brandId || null, username]);
    if (branchId !== undefined) {
      // Resolve default warehouse: explicit > branch's warehouse > null
      let whId = req.body.defaultWarehouseId || null;
      if (!whId && branchId) {
        const [br] = await db.query('SELECT warehouse_id FROM branches WHERE id = ?', [branchId]);
        if (br.length && br[0].warehouse_id) whId = br[0].warehouse_id;
      }
      await db.query('UPDATE users SET branch_id = ?, default_branch_id = ?, default_warehouse_id = ? WHERE username = ?',
        [branchId || null, branchId || null, whId, username]);
    } else if (req.body.defaultWarehouseId !== undefined) {
      // Allow setting just the warehouse without changing branch
      await db.query('UPDATE users SET default_warehouse_id = ? WHERE username = ?', [req.body.defaultWarehouseId || null, username]);
    }
    if (req.body.canChangeBranch !== undefined) {
      try { await db.query('UPDATE users SET can_change_branch = ? WHERE username = ?', [req.body.canChangeBranch ? 1 : 0, username]); } catch(e) {}
    }

    if (password) {
      if (password.length < 6) return res.json({ success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
      if (!/[a-zA-Z]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على حروف' });
      if (!/[0-9]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على أرقام' });
      if (!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>\/?]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على رمز خاص' });
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password = ? WHERE username = ?', [hash, username]);
    }
    if (role && ['admin', 'cashier', 'manager', 'custody', 'employee'].indexOf(role) >= 0) {
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
      // V3 SECURITY: Developer flag changes require the primary 'admin' account.
      // Anyone else trying to grant/revoke is silently ignored.
      const grantedBy = (req.user && req.user.username) || '';
      if (isDeveloper !== undefined && grantedBy === 'admin' && username !== 'admin') {
        meta[username].isDeveloper = !!isDeveloper;
      } else if (isDeveloper !== undefined && username === 'admin') {
        // The primary admin account is ALWAYS a developer — cannot be revoked.
        meta[username].isDeveloper = true;
      }
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
    const { confirm, username, password, doubleConfirm } = req.body;

    // Triple verification: confirm text + password + double confirm
    if (confirm !== 'YES_RESET_ALL_DATA') {
      return res.json({ success: false, error: 'تأكيد غير صالح' });
    }
    if (doubleConfirm !== 'I_UNDERSTAND_DATA_WILL_BE_LOST') {
      return res.json({ success: false, error: 'التأكيد الثاني مطلوب' });
    }
    if (!username || !password) {
      return res.json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان للتأكيد' });
    }

    // Re-verify the requesting user with username + password
    const [users] = await db.query('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
    if (!users.length) return res.json({ success: false, error: 'المستخدم غير موجود' });
    const valid = await bcrypt.compare(password, users[0].password);
    if (!valid) return res.json({ success: false, error: 'كلمة المرور غير صحيحة' });

    // ONLY admin role can reset — developer flag alone is not enough
    if (users[0].role !== 'admin') {
      return res.json({ success: false, error: 'فقط مدير النظام (admin) يمكنه تنفيذ هذه العملية' });
    }

    // Verify developer flag from user_meta
    const meta = await getUserMeta();
    const userMeta = meta[username] || {};
    const isDev = !!userMeta.isDeveloper;
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

// ═══════════════════════════════════════
// TWO-FACTOR AUTHENTICATION (2FA)
// ═══════════════════════════════════════
const { generateSecret, verifyTOTP, generateOTPAuthURI } = require('../lib/twoFactor');

// POST /api/auth/2fa/setup — generate 2FA secret for a user
router.post('/2fa/setup', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.json({ success: false, error: 'اسم المستخدم مطلوب' });
    const secret = generateSecret();
    // Store secret in users table
    await addColumnIfMissing('users', 'totp_secret', "VARCHAR(100)");
    await db.query('UPDATE users SET totp_secret = ? WHERE username = ?', [secret, username]);
    const uri = generateOTPAuthURI(secret, username, 'MoroccanTaste');
    res.json({ success: true, secret, uri, message: 'امسح QR Code بتطبيق Google Authenticator' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// POST /api/auth/2fa/verify — verify a 2FA code
router.post('/2fa/verify', async (req, res) => {
  try {
    const { username, code } = req.body;
    if (!username || !code) return res.json({ success: false, error: 'اسم المستخدم والرمز مطلوبان' });
    const [users] = await db.query('SELECT totp_secret FROM users WHERE username = ?', [username]);
    if (!users.length || !users[0].totp_secret) return res.json({ success: false, error: 'التحقق الثنائي غير مفعّل' });
    const valid = verifyTOTP(users[0].totp_secret, code);
    res.json({ success: valid, error: valid ? undefined : 'الرمز غير صحيح' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// POST /api/auth/2fa/disable — disable 2FA for a user
router.post('/2fa/disable', async (req, res) => {
  try {
    const { username } = req.body;
    await db.query('UPDATE users SET totp_secret = NULL WHERE username = ?', [username]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Helper for migration — add column if missing
async function addColumnIfMissing(table, column, definition) {
  try {
    const [cols] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, column]
    );
    if (!cols.length) await db.query('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  } catch(e) {}
}

/* ═══════════════════════════════════════════════════════════════════
 * V3 — RBAC (Role-Based Access Control) endpoints
 * ═══════════════════════════════════════════════════════════════════ */

// GET /auth/permissions/catalog — full list of available permissions (admin only)
router.get('/permissions/catalog', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM permissions_v3 ORDER BY sort_order, id");
    res.json(rows.map(r => ({
      id: r.id, category: r.category,
      labelAr: r.label_ar, labelEn: r.label_en,
      description: r.description || '',
      isSensitive: !!r.is_sensitive,
      sortOrder: r.sort_order
    })));
  } catch(e) { res.json([]); }
});

// GET /auth/permissions/role/:role — list permissions assigned to a role
router.get('/permissions/role/:role', async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT permission_id FROM role_permissions WHERE role = ?",
      [req.params.role]
    );
    res.json(rows.map(r => r.permission_id));
  } catch(e) { res.json([]); }
});

// PUT /auth/permissions/role/:role — replace role's permissions (atomic)
router.put('/permissions/role/:role', async (req, res) => {
  try {
    const grantedBy = (req.user && req.user.username) || '';
    // Only the primary 'admin' account can edit role permissions
    if (grantedBy !== 'admin') {
      return res.json({ success: false, error: 'فقط حساب المطور الرئيسي يمكنه تعديل صلاحيات الأدوار' });
    }
    const { permissionIds } = req.body;
    if (!Array.isArray(permissionIds)) {
      return res.json({ success: false, error: 'permissionIds array required' });
    }
    // Replace atomically
    await db.query("DELETE FROM role_permissions WHERE role = ?", [req.params.role]);
    for (const pid of permissionIds) {
      await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", [req.params.role, pid]);
    }
    res.json({ success: true, count: permissionIds.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /auth/permissions/me — current user's effective permissions
router.get('/permissions/me', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || req.query.username;
    if (!username) return res.json({ permissions: [], role: '' });
    const [u] = await db.query("SELECT role FROM users WHERE username = ? LIMIT 1", [username]);
    if (!u.length) return res.json({ permissions: [], role: '' });
    const role = u[0].role || 'employee';
    // Primary admin = wildcard
    if (username === 'admin') {
      const [allPerms] = await db.query("SELECT id FROM permissions_v3");
      return res.json({
        permissions: ['*'].concat(allPerms.map(p => p.id)),
        role: role,
        isPrimaryAdmin: true,
        isDeveloper: true
      });
    }
    // Build effective permissions: role permissions ∪ grants − revokes
    const [rolePerms] = await db.query("SELECT permission_id FROM role_permissions WHERE role = ?", [role]);
    const [overrides] = await db.query(
      "SELECT permission_id, grant_type FROM user_permission_overrides WHERE username = ?",
      [username]
    );
    const eff = new Set(rolePerms.map(r => r.permission_id));
    overrides.forEach(o => {
      if (o.grant_type === 'grant') eff.add(o.permission_id);
      else eff.delete(o.permission_id);
    });
    res.json({
      permissions: Array.from(eff),
      role: role,
      isPrimaryAdmin: false,
      isDeveloper: false
    });
  } catch(e) { res.json({ permissions: [], role: '', error: e.message }); }
});

// GET /auth/permissions/user/:username — get a specific user's overrides (admin only)
router.get('/permissions/user/:username', async (req, res) => {
  try {
    const grantedBy = (req.user && req.user.username) || '';
    if (grantedBy !== 'admin') return res.json({ error: 'admin only' });
    const [rows] = await db.query(
      "SELECT permission_id, grant_type, granted_by, granted_at FROM user_permission_overrides WHERE username = ?",
      [req.params.username]
    );
    res.json(rows.map(r => ({
      permissionId: r.permission_id,
      grantType: r.grant_type,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at
    })));
  } catch(e) { res.json([]); }
});

// PUT /auth/permissions/user/:username — replace user's overrides (admin only)
router.put('/permissions/user/:username', async (req, res) => {
  try {
    const grantedBy = (req.user && req.user.username) || '';
    if (grantedBy !== 'admin') {
      return res.json({ success: false, error: 'فقط حساب المطور الرئيسي يمكنه تعديل صلاحيات المستخدمين الفرديين' });
    }
    const { overrides } = req.body; // [{permissionId, grantType}]
    if (!Array.isArray(overrides)) {
      return res.json({ success: false, error: 'overrides array required' });
    }
    await db.query("DELETE FROM user_permission_overrides WHERE username = ?", [req.params.username]);
    for (const o of overrides) {
      if (!o.permissionId || !['grant','revoke'].includes(o.grantType)) continue;
      await db.query(
        "INSERT IGNORE INTO user_permission_overrides (username, permission_id, grant_type, granted_by) VALUES (?, ?, ?, ?)",
        [req.params.username, o.permissionId, o.grantType, grantedBy]
      );
    }
    res.json({ success: true, count: overrides.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
