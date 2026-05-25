const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');
const path = require('path');
const verifyToken = require('./authMiddleware');
// v5.11.6 — geo-fence + attendance helpers are no longer used here.
// They live exclusively in routes/hr.js POST /my-clock so attendance
// becomes a separate, intentional action from authentication.
// v6.2.0 Wave F.5 — 2FA required for admin / developer
const { generateSecret: _genTotpSecret, verifyTOTP, generateOTPAuthURI: _genOtpUri } = require('../lib/twoFactor');

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

    // v5.12.2 — record device brand/model/os in audit_log so admins can
    // see who logged in from which device. Tolerant of missing device_*
    // columns on older deployed schemas.
    try {
      var dev = req.body && req.body.device || {};
      var ua  = (dev.ua || req.headers['user-agent'] || '').slice(0, 500);
      await db.query(
        'INSERT INTO audit_log (id, user_id, username, action, table_name, record_id, ip_address, device_info, device_brand, device_model, device_os) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'AUD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          user.id, user.username, 'login', 'users', String(user.id),
          ip, ua,
          (dev.brand || '').slice(0, 50),
          (dev.model || '').slice(0, 120),
          (dev.os    || '').slice(0, 80)
        ]
      );
    } catch (e) { /* audit_log columns may be missing on older schemas — ignore */ }

    // V5.4.3: include isDeveloper in JWT + login response so frontend can gate UI buttons
    const isDev = !!user.is_developer || user.username === 'admin' || user.role === 'developer';

    // v6.3.1 — 2FA is now OPT-IN, not mandatory.
    // v6.2.0 forced every admin/developer through a mandatory enrollment
    // flow (requires2faSetup + setupToken), but the front-end has no UI
    // to complete that enrollment yet — the admin was locked out with a
    // bare red "undefined" toast. Reverted to a simpler contract:
    //   • If the user voluntarily set a totp_secret (via /2fa/setup
    //     + /2fa/verify, or by an admin populating the field), the
    //     login still requires the 6-digit code on every request.
    //   • Otherwise login proceeds as it did before v6.2.0 — no
    //     enrollment gate, no lock-out.
    // When the dedicated Settings → Security UI is built, it will use
    // the same /2fa/setup + /2fa/verify endpoints to enable the secret
    // for anyone who wants the protection.
    if (user.totp_secret) {
      const code = (req.body && (req.body.totpCode || req.body.code)) || '';
      if (!code) {
        return res.json({
          success: false,
          requires2faCode: true,
          username: user.username,
          error: 'يَرجى إدخال رَمز التَّحقُّق الثُّنائي من Google Authenticator'
        });
      }
      try {
        if (!verifyTOTP(user.totp_secret, code)) {
          return res.json({ success: false, error: 'رَمز التَّحقُّق الثُّنائي غير صحيح' });
        }
      } catch (e) {
        return res.json({ success: false, error: 'فشل التَّحقُّق الثُّنائي: ' + e.message });
      }
    }

    // v5.12.2 — record device brand/model/os in audit_log so admins can
    // see who logged in from which device. Tolerant of missing device_*
    // columns on older deployed schemas.
    try {
      var dev2 = req.body && req.body.device || {};
      var ua2  = (dev2.ua || req.headers['user-agent'] || '').slice(0, 500);
      await db.query(
        'INSERT INTO audit_log (id, user_id, username, action, table_name, record_id, ip_address, device_info, device_brand, device_model, device_os) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'AUD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          user.id, user.username, 'login_success', 'users', String(user.id),
          ip, ua2,
          (dev2.brand || '').slice(0, 50),
          (dev2.model || '').slice(0, 120),
          (dev2.os    || '').slice(0, 80)
        ]
      );
    } catch (_) {}

    // v5.11.6 — Login is OPEN to any user with valid credentials. The
    // geo-fence was relocated to the explicit clock-in/clock-out endpoint.

    const token = jwt.sign({
      id: user.id, username: user.username, role: user.role,
      isDeveloper: isDev,
      brandId: user.brand_id || '', branchId: user.branch_id || '',
      default_warehouse_id: user.default_warehouse_id || '',
      employeeId: user.employee_id || ''
    }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.json({
      success: true, username: user.username, role: user.role, token,
      isDeveloper: isDev,
      brandId: user.brand_id || '', branchId: user.branch_id || '',
      warehouseId: user.default_warehouse_id || '',
      employeeId: user.employee_id || ''
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// v5.11.6 — Logout endpoint. Pure session-end action: no geo-fence
// gate (off-site users must be able to sign out cleanly) and no auto
// clock-out — attendance is handled exclusively via POST /api/hr/my-clock
// which the employee triggers explicitly from the portal.
router.post('/logout', verifyToken, async (req, res) => {
  try {
    const user = req.user || {};
    try {
      const ip = req.ip || req.connection.remoteAddress || 'unknown';
      await db.query(
        'INSERT INTO audit_log (id, user_id, username, action, table_name, record_id, ip_address) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          'AUD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          user.id || null, user.username || '', 'logout', 'users',
          String(user.id || ''), ip
        ]
      );
    } catch (_) { /* tolerate older audit_log schemas */ }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
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

    // v5.16.3 — The is_semi_finished filter was REMOVED to work around
    // a deployment where every item was flagged semi-finished and the
    // cashier saw an empty grid. That was the wrong tradeoff.
    //
    // v6.4.5 — RESTORED. Per owner spec: "المُنتجات الغير تامة هي مَواد
    // نِصف مَصنوعة ممنوع تَتواجد في المنيو — هي تُعامَل مُعامَلة المَواد
    // الخام". Semi-finished items (e.g. "cold drink base", "براد شاي
    // مغربي") are intermediate production outputs. They:
    //   • have their own recipe (raw materials → semi-finished output)
    //   • are transferred between branches as inventory
    //   • are consumed by FINISHED items via menu.consumes_semi_id
    //     (routes/sales.js line ~480 deducts them on each sale)
    // They MUST NOT appear in the cashier grid. The defensive fallback
    // (see "guard 0 rows" block below) catches the all-semi misconfig
    // case explicitly rather than silently violating the rule.
    //
    // v6.4.4 — Orphan items (brand_id NULL/'') with a branded twin are
    // suppressed so the user with a brand doesn't see both copies.
    const menuQuery = userBrandId
      ? `SELECT m.* FROM menu m
           WHERE m.active = 1
             AND (m.is_semi_finished IS NULL OR m.is_semi_finished = 0)
             AND (
               m.brand_id = ?
               OR (
                 (m.brand_id IS NULL OR m.brand_id = '')
                 AND NOT EXISTS (
                   SELECT 1 FROM menu m2
                    WHERE m2.name = m.name
                      AND m2.brand_id = ?
                      AND m2.active = 1
                 )
               )
             )
           ORDER BY m.category, m.name`
      : `SELECT m.* FROM menu m
           WHERE m.active = 1
             AND (m.is_semi_finished IS NULL OR m.is_semi_finished = 0)
           ORDER BY m.category, m.name`;
    const menuParams = userBrandId ? [userBrandId, userBrandId] : [];
    let [menu] = await db.query(menuQuery, menuParams);

    // v6.4.5 — Defensive guard: if the filter wiped EVERY row, the data
    // is misconfigured (every item flagged is_semi_finished=1). Don't
    // silently violate the no-semi-in-cashier rule by serving them —
    // instead log a critical warning so the owner can investigate, and
    // return whatever finished items exist outside the brand (best
    // effort) so the cashier isn't completely dark.
    if (!menu.length) {
      try {
        const [diag] = await db.query(
          `SELECT
             SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_total,
             SUM(CASE WHEN active = 1 AND (is_semi_finished IS NULL OR is_semi_finished = 0) THEN 1 ELSE 0 END) AS finished_total,
             SUM(CASE WHEN active = 1 AND is_semi_finished = 1 THEN 1 ELSE 0 END) AS semi_total
           FROM menu`
        );
        const d = diag[0] || {};
        console.warn(
          '[init/menu] empty grid for user=%s brand=%s — active=%s finished=%s semi=%s. ' +
          'If finished=0 the menu is mis-flagged (every item is semi). Fix in /menu admin: set is_semi_finished=0 on real sellables.',
          req.params.username, userBrandId || '(none)',
          d.active_total || 0, d.finished_total || 0, d.semi_total || 0
        );
      } catch (e) { /* diagnostics best-effort */ }
    }
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

    // V5.7.9 — also fetch branch address (location) for the current user so the
    //          POS receipt can show "Welcome to {branch} — {address}" without an extra round-trip.
    let currentBranchAddress = '';
    try {
      if (userBranchId) {
        const [br] = await db.query('SELECT location FROM branches WHERE id = ?', [userBranchId]);
        if (br.length) currentBranchAddress = br[0].location || '';
      }
    } catch (_) { /* branches table may be empty on fresh installs — ignore */ }

    res.json({
      settings: {
        name: settingsObj.CompanyName || 'Moroccan Taste',
        taxNumber: settingsObj.TaxNumber || '',
        currency: settingsObj.Currency || 'SAR',
        logo: settingsObj.logo || '',
        branchName: settingsObj.BranchName || '',
        // V5.7.9 — global contact (printed on every receipt footer)
        companyPhone: settingsObj.CompanyPhone || '',
        companyEmail: settingsObj.CompanyEmail || '',
        // V5.7.9 — current user's branch address (for receipt header)
        branchAddress: currentBranchAddress
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
    // v6.18.1 (Wave 2) — detect the new HR people-record columns too
    let hasIqama = true, hasIban = true, hasJobTitle = true;
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'phone'"); hasPhone = !!c.length; } catch(e) { hasPhone = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'full_name'"); hasFullName = !!c.length; } catch(e) { hasFullName = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'can_change_branch'"); hasCanChange = !!c.length; } catch(e) { hasCanChange = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'default_branch_id'"); hasDefBranch = !!c.length; } catch(e) { hasDefBranch = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'iqama_number'");   hasIqama   = !!c.length; } catch(e) { hasIqama   = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'iban'");           hasIban    = !!c.length; } catch(e) { hasIban    = false; }
    try { const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'job_title_code'"); hasJobTitle= !!c.length; } catch(e) { hasJobTitle= false; }

    const extraCols = [
      hasPhone     ? 'u.phone'             : "'' AS phone",
      hasFullName  ? 'u.full_name'         : "'' AS full_name",
      hasCanChange ? 'u.can_change_branch' : '0 AS can_change_branch',
      hasDefBranch ? 'u.default_branch_id' : 'NULL AS default_branch_id',
      hasIqama     ? 'u.iqama_number'      : "'' AS iqama_number",
      hasIban      ? 'u.iban'              : "'' AS iban",
      hasJobTitle  ? 'u.job_title_code'    : "'' AS job_title_code"
    ];
    // v6.18.1 — Join hr_job_titles for the canonical Arabic title.
    // LEFT JOIN keeps users with no job_title_code visible (NULL → '').
    const joinJobTitle = hasJobTitle
      ? "LEFT JOIN hr_job_titles jt ON jt.code = u.job_title_code"
      : "";
    const jobTitleCol = hasJobTitle
      ? "COALESCE(jt.name_ar,'') AS jobTitleName"
      : "'' AS jobTitleName";
    const [users] = await db.query(`
      SELECT u.id, u.username, u.role, u.active, u.created_at, u.email,
        u.brand_id, u.branch_id, u.default_warehouse_id, u.position_id,
        ${extraCols.join(', ')},
        COALESCE(br.name,'') AS branchName, COALESCE(bd.name,'') AS brandName,
        COALESCE(p.name,'') AS positionName,
        COALESCE(wh.name,'') AS warehouseName,
        ${jobTitleCol}
      FROM users u
      LEFT JOIN branches br ON u.branch_id = br.id
      LEFT JOIN brands bd ON u.brand_id = bd.id
      LEFT JOIN positions p ON u.position_id = p.id
      LEFT JOIN warehouses wh ON u.default_warehouse_id = wh.id
      ${joinJobTitle}
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
        // v6.18.1 — new people-record fields
        iqamaNumber: u.iqama_number || '',
        iban: u.iban || '',
        jobTitleCode: u.job_title_code || '',
        jobTitleName: u.jobTitleName || '',
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
    // v6.18.1 (Wave 2) — new HR people-record fields.  Soft-validated in
    // this wave (format-checked when provided, but not yet required).
    // Wave 3 will switch them to REQUIRED once existing users are
    // backfilled with shell employee records.
    const iqamaNumber  = (req.body.iqamaNumber  || req.body.iqama_number  || '').trim();
    const iban         = (req.body.iban         || '').trim();
    const jobTitleCode = (req.body.jobTitleCode || req.body.job_title_code || '').trim();
    if (!username || !password) return res.json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    // Password validation
    if (password.length < 6) return res.json({ success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    if (!/[a-zA-Z]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على حروف' });
    if (!/[0-9]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على أرقام' });
    if (!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>\/?]/.test(password)) return res.json({ success: false, error: 'كلمة المرور يجب أن تحتوي على رمز خاص (!@#$...)' });
    // v6.18.1 — Format checks (only when value is provided).  Saudi
    // iqama / national ID is always 10 digits; SA IBAN is "SA" + 22
    // digits.  Empty values are accepted in Wave 2 to keep backward
    // compat with existing UIs.
    if (iqamaNumber && !/^\d{10}$/.test(iqamaNumber)) {
      return res.json({ success: false, error: 'رقم الإقامة/الهوية يجب أن يكون 10 أرقام' });
    }
    if (iban && !/^SA\d{22}$/i.test(iban)) {
      return res.json({ success: false, error: 'رقم الـIBAN يجب أن يبدأ بـSA و22 رقماً (إجمالي 24 خانة)' });
    }
    if (jobTitleCode) {
      try {
        const [jt] = await db.query('SELECT 1 FROM hr_job_titles WHERE code = ? AND is_active = 1 LIMIT 1', [jobTitleCode]);
        if (!jt.length) return res.json({ success: false, error: 'المسمى الوظيفي غير معرَّف في قائمة المسميات' });
      } catch (jtErr) { /* table not yet migrated — tolerate */ }
    }

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
    // v6.18.1 — Persist the new HR fields when provided.  try/catch each
    // separately so a single missing column on an old schema doesn't
    // break the insert chain.
    if (iqamaNumber)  { try { await db.query('UPDATE users SET iqama_number   = ? WHERE username = ?', [iqamaNumber,  username]); } catch(e) {} }
    if (iban)         { try { await db.query('UPDATE users SET iban           = ? WHERE username = ?', [iban,         username]); } catch(e) {} }
    if (jobTitleCode) { try { await db.query('UPDATE users SET job_title_code = ? WHERE username = ?', [jobTitleCode, username]); } catch(e) {} }

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
    // v6.18.1 (Wave 2) — HR people-record fields, same format checks as POST.
    if (req.body.iqamaNumber !== undefined || req.body.iqama_number !== undefined) {
      const iqamaNumber = (req.body.iqamaNumber || req.body.iqama_number || '').trim();
      if (iqamaNumber && !/^\d{10}$/.test(iqamaNumber)) {
        return res.json({ success: false, error: 'رقم الإقامة/الهوية يجب أن يكون 10 أرقام' });
      }
      try { await db.query('UPDATE users SET iqama_number = ? WHERE username = ?', [iqamaNumber || null, username]); } catch(e) {}
    }
    if (req.body.iban !== undefined) {
      const iban = (req.body.iban || '').trim();
      if (iban && !/^SA\d{22}$/i.test(iban)) {
        return res.json({ success: false, error: 'رقم الـIBAN يجب أن يبدأ بـSA و22 رقماً (إجمالي 24 خانة)' });
      }
      try { await db.query('UPDATE users SET iban = ? WHERE username = ?', [iban || null, username]); } catch(e) {}
    }
    if (req.body.jobTitleCode !== undefined || req.body.job_title_code !== undefined) {
      const jobTitleCode = (req.body.jobTitleCode || req.body.job_title_code || '').trim();
      if (jobTitleCode) {
        try {
          const [jt] = await db.query('SELECT 1 FROM hr_job_titles WHERE code = ? AND is_active = 1 LIMIT 1', [jobTitleCode]);
          if (!jt.length) return res.json({ success: false, error: 'المسمى الوظيفي غير معرَّف في قائمة المسميات' });
        } catch (jtErr) { /* table not yet migrated — tolerate */ }
      }
      try { await db.query('UPDATE users SET job_title_code = ? WHERE username = ?', [jobTitleCode || null, username]); } catch(e) {}
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

// V5.7.12 — Granular wipe sections
// ────────────────────────────────────────────────────────────
// Each section is an independently-checkable group. Tables are listed
// children-first so the loop succeeds even with FOREIGN_KEY_CHECKS=1.
// NEVER WIPED: users, settings, brands, branches, warehouses, user_branches,
//              user_brands, user_warehouses, user_meta, position_workflow_steps
//              (these are foundational + would brick the system).
const RESET_SECTIONS = {
  sales:           { label: 'المبيعات والفواتير',          tables: ['sales_items', 'sales'] },
  shifts:          { label: 'الورديات والإقفالات',          tables: ['shift_close_denominations', 'shifts'] },
  inventory:       { label: 'حركات المخزون والجرد',         tables: ['inventory_movements', 'stocktake_items', 'stocktakes'] },
  inv_items:       { label: 'المواد الخام',                tables: ['inv_items'] },
  menu:            { label: 'أصناف المنيو',                tables: ['menu'] },
  recipes:         { label: 'الوصفات (Recipes + BOM)',     tables: ['recipe', 'bom_items', 'bom'] },
  purchases:       { label: 'المشتريات وأوامر الشراء',      tables: ['po_lines', 'purchase_orders', 'purchases'] },
  expenses:        { label: 'المصروفات',                   tables: ['expenses'] },
  custody:         { label: 'العهد والمسؤولين',             tables: ['custody_movements', 'custody_holders'] },
  accounting:      { label: 'القيود المحاسبية والـ GL',     tables: ['gl_entries', 'gl_journals'] },
  tax:             { label: 'تقارير الضريبة و ZATCA',       tables: ['vat_reports', 'zatca_archive'] },
  transactions:    { label: 'معاملات النظام (Workflow)',    tables: ['transaction_attachments', 'transaction_replies', 'transaction_approvals', 'transaction_recipients', 'transactions'] },
  customers:       { label: 'العملاء وذممهم',              tables: ['customer_payments', 'customers'] },
  suppliers:       { label: 'الموردين وذممهم',             tables: ['supplier_payments', 'suppliers'] },
  audit:           { label: 'سجل التدقيق (Audit Log)',     tables: ['audit_logs', 'audit_log'] },
  channels:        { label: 'قنوات البيع',                 tables: ['sales_channels'] },
  payment_methods: { label: 'طرق الدفع',                  tables: ['branch_payment_methods', 'payment_methods'] },
  discounts:       { label: 'الخصومات',                   tables: ['branch_discounts', 'discounts_v2'] },
  price_lists:     { label: 'قوائم الأسعار',               tables: ['price_list_items', 'price_lists'] }
};

// GET /api/auth/reset-db/sections — list available sections (used by frontend to render checkboxes)
router.get('/reset-db/sections', (req, res) => {
  const out = Object.keys(RESET_SECTIONS).map(key => ({
    key: key,
    label: RESET_SECTIONS[key].label,
    tables: RESET_SECTIONS[key].tables
  }));
  res.json({ sections: out });
});

// POST /api/auth/reset-db — DEVELOPER ONLY: wipe selected sections (or legacy full-wipe)
router.post('/reset-db', async (req, res) => {
  try {
    const { confirm, username, password, doubleConfirm, sections } = req.body;

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

    // V5.7.12 — Build the table list from selected sections.
    // If `sections` is omitted/empty, fall back to the legacy "wipe everything
    // transactional" behavior (back-compat for older clients).
    let tablesToWipe = [];
    let chosenSections = [];
    if (Array.isArray(sections) && sections.length) {
      sections.forEach(key => {
        const sec = RESET_SECTIONS[key];
        if (sec) {
          chosenSections.push(key);
          sec.tables.forEach(t => { if (tablesToWipe.indexOf(t) === -1) tablesToWipe.push(t); });
        }
      });
      if (!tablesToWipe.length) {
        return res.json({ success: false, error: 'لم يتم اختيار أي قسم صالح للمسح' });
      }
    } else {
      // Legacy full wipe — same list as before
      chosenSections = ['(legacy full wipe)'];
      tablesToWipe = [
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
    }

    // V5.7.12 — disable FK checks for the duration so children/parents can be
    // wiped in any order without violating constraints. Re-enable after.
    const wiped = [];
    const failed = [];
    let fkSwitched = false;
    try {
      await db.query('SET FOREIGN_KEY_CHECKS = 0');
      fkSwitched = true;
      for (const t of tablesToWipe) {
        try {
          await db.query(`DELETE FROM \`${t}\``);
          wiped.push(t);
        } catch (e) {
          // Table may not exist on this schema — record but don't abort
          failed.push({ table: t, error: e.message });
        }
      }
    } finally {
      if (fkSwitched) {
        try { await db.query('SET FOREIGN_KEY_CHECKS = 1'); } catch (_) {}
      }
    }

    // Audit the wipe (best-effort — audit_log itself might be in the wipe list)
    try {
      await db.query(
        `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at)
         VALUES (?, 'developer_reset_db', 'system', 'reset', ?, NOW())`,
        [username, JSON.stringify({ sections: chosenSections, wiped, failed })]
      );
    } catch (_) {}

    res.json({ success: true, sections: chosenSections, wiped, failed });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════
// TWO-FACTOR AUTHENTICATION (2FA)
// (verifyTOTP imported at top of file; alias generateSecret + generateOTPAuthURI here)
// ═══════════════════════════════════════
const generateSecret = _genTotpSecret;
const generateOTPAuthURI = _genOtpUri;

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

// v6.4.0 — GET /api/auth/2fa/status?username= — does this user have 2FA on?
// Returns { enabled: bool, hasSecret: bool } without revealing the secret.
router.get('/2fa/status', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || req.query.username;
    if (!username) return res.json({ enabled: false });
    const [rows] = await db.query(
      'SELECT totp_secret FROM users WHERE username = ? LIMIT 1', [username]
    );
    const enabled = rows.length && rows[0].totp_secret != null && rows[0].totp_secret !== '';
    res.json({ enabled: !!enabled, hasSecret: !!enabled });
  } catch (e) { res.json({ enabled: false, error: e.message }); }
});

// v6.2.0 Wave F.5 — Initial 2FA enrollment for admin / developer.
// Flow:
//   1. Admin logs in → backend responds requires2faSetup + setupToken.
//   2. Frontend calls POST /api/auth/2fa/enroll with the setupToken,
//      the secret displayed in the QR, and the first valid TOTP code.
//   3. Backend validates the setupToken + the code, persists the secret,
//      and returns a real JWT — the admin is now fully logged in.
router.post('/2fa/enroll', async (req, res) => {
  try {
    const { setupToken, secret, code } = req.body || {};
    if (!setupToken || !secret || !code) {
      return res.json({ success: false, error: 'setupToken/secret/code required' });
    }
    let payload;
    try {
      payload = jwt.verify(setupToken, process.env.JWT_SECRET);
    } catch (e) {
      return res.json({ success: false, error: 'انتهت صلاحية رمز الإعداد، يرجى المحاولة من جديد' });
    }
    if (payload.intent !== '2fa-setup') {
      return res.json({ success: false, error: 'رمز إعداد غير صالح' });
    }
    if (!verifyTOTP(secret, code)) {
      return res.json({ success: false, error: 'الرَّمز غير صحيح — تأكَّد من المُزامنة مع تَطبيق Google Authenticator' });
    }
    // Persist + issue real JWT
    const [users] = await db.query(
      'SELECT id, username, role, brand_id, branch_id, default_warehouse_id, employee_id, is_developer FROM users WHERE username = ? AND active = 1',
      [payload.username]
    );
    if (!users.length) return res.json({ success: false, error: 'user-not-found' });
    const user = users[0];
    await db.query('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, user.id]);
    const isDev = !!user.is_developer || user.username === 'admin' || user.role === 'developer';
    const token = jwt.sign({
      id: user.id, username: user.username, role: user.role,
      isDeveloper: isDev,
      brandId: user.brand_id || '', branchId: user.branch_id || '',
      default_warehouse_id: user.default_warehouse_id || '',
      employeeId: user.employee_id || ''
    }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({
      success: true, token, username: user.username, role: user.role,
      isDeveloper: isDev,
      brandId: user.brand_id || '', branchId: user.branch_id || '',
      warehouseId: user.default_warehouse_id || '',
      employeeId: user.employee_id || ''
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
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

// ─── v6.2.0 Wave F.4 — Audit chain verification ───
// GET /api/auth/audit/verify?fromId=&limit=
// Walks the audit_log hash chain and reports any row whose stored
// record_hash doesn't match the recomputed value. Tampering (manual
// UPDATEs in the DB) is detected with brokenAt: <id>.
const { verifyAuditChain } = require('../lib/auditLogger');
router.get('/audit/verify', verifyToken, async (req, res) => {
  try {
    // Only admin / developer can run this
    const requester = (req.user && req.user.username) || '';
    if (requester !== 'admin' && !req.user.isDeveloper) {
      return res.status(403).json({ success: false, error: 'admin only' });
    }
    const result = await verifyAuditChain({
      fromId: Number(req.query.fromId) || 0,
      limit:  Number(req.query.limit)  || 1000
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
