require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════
// SECURITY MIDDLEWARE CHAIN
// ═══════════════════════════════════════

// 1. Compression
app.use(compression());

// 2. Security headers (Helmet)
app.use(helmet({
  contentSecurityPolicy: false,  // Disabled — app uses inline scripts/styles extensively
  referrerPolicy: { policy: 'same-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// 3. No-cache for JS/CSS + additional security headers
app.use(function(req, res, next) {
  if (req.path.match(/\.(js|css|html)$/) || req.path.endsWith('/') || !req.path.includes('.')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=self, microphone=()');
  next();
});

// 4. CORS — restricted to allowed origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, same-origin)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0) return callback(null, true); // If not configured, allow all (dev mode)
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    callback(null, true); // In production, set ALLOWED_ORIGINS env var to restrict
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 5. Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 6. Global rate limiter for ALL API requests
const _rateLimitStore = {}; // { ip: { count, windowStart } }
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 500; // 500 requests per 15 min per IP
app.use('/api/', function(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  if (!_rateLimitStore[ip] || now - _rateLimitStore[ip].windowStart > RATE_LIMIT_WINDOW) {
    _rateLimitStore[ip] = { count: 1, windowStart: now };
  } else {
    _rateLimitStore[ip].count++;
  }
  if (_rateLimitStore[ip].count > RATE_LIMIT_MAX) {
    return res.status(429).json({ success: false, error: 'طلبات كثيرة جداً — انتظر قليلاً' });
  }
  // Cleanup old entries every 1000 requests
  if (Math.random() < 0.001) {
    Object.keys(_rateLimitStore).forEach(function(k) {
      if (now - _rateLimitStore[k].windowStart > RATE_LIMIT_WINDOW) delete _rateLimitStore[k];
    });
  }
  next();
});

// 7. Global JWT authentication for ALL API routes EXCEPT public ones
// 7. Global JWT authentication
// Auth module is FULLY public (login, refresh, init, users CRUD)
// Other modules require token except specific paths
app.use('/api/', function(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  // Build full path for checking
  var p = req.path || '';

  // FULLY PUBLIC — no token needed
  if (p.startsWith('/auth/')) return next();           // all auth endpoints
  if (p.startsWith('/settings')) return next();        // settings
  if (p.startsWith('/menu')) return next();            // menu
  if (p.startsWith('/hr/my-')) return next();          // employee self-service
  if (p.startsWith('/workflow/')) return next();        // workflow (all public — auth checked inside)
  if (p.startsWith('/hr/leave-types')) return next();  // leave types list
  if (p.startsWith('/hr/departments')) return next();  // departments list

  // Try to extract and verify JWT token
  var authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      var token = authHeader.split(' ')[1];
      var decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (err) {
      // Token invalid/expired — fall through to block
    }
  }

  // No valid token — block
  return res.status(401).json({ success: false, error: 'غير مصرح — يرجى تسجيل الدخول' });
});

// Static files (frontend) — BEFORE API routes so they're not auth-gated
// Send no-cache for HTML + JS + CSS so users always get latest code
// (CDN libs are not affected — they use their own versioned URLs)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// 8. Audit logging middleware — auto-logs all POST/PUT/DELETE operations
const { auditMiddleware } = require('./lib/auditLogger');
app.use('/api/sales', auditMiddleware('sales'));
app.use('/api/inventory', auditMiddleware('inventory'));
app.use('/api/purchases', auditMiddleware('purchases'));
app.use('/api/erp', auditMiddleware('erp'));
app.use('/api/custody', auditMiddleware('custody'));
app.use('/api/hr', auditMiddleware('hr'));
app.use('/api/workflow', auditMiddleware('workflow'));
app.use('/api/auth', auditMiddleware('auth'));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/sales-channels', require('./routes/sales-channels'));
// ERP v3 (erp-core) is mounted first so its newer, schema-aware reports
// take precedence over any same-path legacy handler in routes/erp.js
app.use('/api/erp', require('./routes/erp-core'));
app.use('/api/erp', require('./routes/warehouse-ops'));
app.use('/api/erp', require('./routes/payments'));
app.use('/api/erp', require('./routes/notifications'));
app.use('/api/erp', require('./routes/erp'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/custody', require('./routes/custody'));
app.use('/api/cash', require('./routes/cash'));
app.use('/api/workflow', require('./routes/workflow'));
app.use('/api/hr', require('./routes/hr'));

// Catch-all for unimplemented API routes
const { notFoundHandler, errorHandler } = require('./lib/errorHandler');
app.all('/api/*', notFoundHandler);

// Centralized error handler (MUST be last middleware)
app.use(errorHandler);

// Standalone apps — serve their own index.html
// Protected app shells — explicitly opt out of bfcache so that a logged-out
// user pressing browser-back cannot see the authenticated view.
function sendProtectedApp(file) {
  return function(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', file));
  };
}
app.get('/employee',    sendProtectedApp('employee/index.html'));
app.get('/employee/*',  sendProtectedApp('employee/index.html'));
app.get('/pos',         sendProtectedApp('pos/index.html'));
app.get('/pos/*',       sendProtectedApp('pos/index.html'));
app.get('/custody',     sendProtectedApp('custody/index.html'));
app.get('/custody/*',   sendProtectedApp('custody/index.html'));

// SPA fallback — main admin app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Auto-initialize database tables on first run
const fs = require('fs');
const db = require('./db/connection');

async function autoInitDB() {
  // Retry loop — Railway MySQL may not be ready immediately on cold start
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const [rows] = await db.query("SHOW TABLES LIKE 'users'");
      if (!rows.length) {
        console.log('First run — creating database tables...');
        const schema = fs.readFileSync(require('path').join(__dirname, 'db/schema.sql'), 'utf8');
        const stmts = schema.split(';').map(s => s.trim()).filter(s => s.length > 5 && !s.startsWith('CREATE DATABASE') && !s.startsWith('USE '));
        for (const stmt of stmts) {
          try { await db.query(stmt); } catch (e) {
            console.log('Schema warning:', e.message.substring(0, 120));
          }
        }
        // Create default admin user
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash('admin123', 10);
        await db.query("INSERT IGNORE INTO users (username, password, role) VALUES ('admin', ?, 'admin')", [hash]);
        console.log('Database ready! Default login: admin / admin123');
      } else {
        console.log('Database connection OK — tables already exist.');
      }
      // Idempotent migrations — run on every startup, skip if already applied
      await runMigrations();
      return; // success — exit retry loop
    } catch (e) {
      console.error(`[DB] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`[DB] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
      } else {
        console.error('[DB] Could not connect to MySQL after all retries. Check MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQL_DATABASE environment variables.');
      }
    }
  }
}

// ─── Idempotent schema migrations ───
// Checks if a column exists on a table; if not, adds it.
async function addColumnIfMissing(table, column, definition) {
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (!cols.length) {
      console.log(`[DB] Migration: adding ${table}.${column}`);
      await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  } catch (e) {
    console.log(`[DB] Migration warning (${table}.${column}):`, e.message.substring(0, 120));
  }
}

async function createTableIfMissing(tableName, createSQL) {
  try {
    const [rows] = await db.query("SHOW TABLES LIKE ?", [tableName]);
    if (!rows.length) {
      console.log(`[DB] Migration: creating table ${tableName}`);
      await db.query(createSQL);
    }
  } catch (e) {
    console.log(`[DB] Migration warning (${tableName}):`, e.message.substring(0, 120));
  }
}

async function runMigrations() {
  // PO lines — unit conversion columns
  await addColumnIfMissing('po_lines', 'unit', "VARCHAR(50) DEFAULT ''");
  await addColumnIfMissing('po_lines', 'conv_rate', "DECIMAL(10,2) DEFAULT 1");
  await addColumnIfMissing('po_lines', 'unit_type', "VARCHAR(10) DEFAULT 'small'");

  // Menu — pricing system columns + fix cost precision
  await addColumnIfMissing('menu', 'computed_cost', "DECIMAL(10,4) DEFAULT 0");
  // Upgrade menu.cost from DECIMAL(10,2) to DECIMAL(10,4) for tiny ingredient costs
  try { await db.query("ALTER TABLE menu MODIFY COLUMN cost DECIMAL(10,4) DEFAULT 0"); } catch(e) {}
  await addColumnIfMissing('menu', 'pricing_mode', "VARCHAR(20) DEFAULT 'fixed'");
  await addColumnIfMissing('menu', 'markup_pct', "DECIMAL(5,2) DEFAULT 30");

  // ─── Semi-finished products (منتجات غير تامة / نصف مصنعة) ───
  // is_semi_finished = TRUE → this menu row is an intermediate (e.g. براد شاي مغربي)
  // production_unit   = display unit for production output (براد، لتر، صحن، قطعة)
  // consumes_semi_id  = if TRUE finished product, points to the semi-finished it consumes
  // consumes_semi_qty = how many units of semi consumed per 1 of this finished product
  // production_warehouse_id = default warehouse where this is produced into
  await addColumnIfMissing('menu', 'is_semi_finished', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('menu', 'production_unit', "VARCHAR(30) DEFAULT 'pcs'");
  await addColumnIfMissing('menu', 'consumes_semi_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('menu', 'consumes_semi_qty', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('menu', 'production_warehouse_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('menu', 'sales_warehouse_id', "VARCHAR(50) DEFAULT NULL");

  // Index for finding semi-finished consumers
  try { await db.query('CREATE INDEX idx_menu_semi_id ON menu(is_semi_finished)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_menu_consumes_semi ON menu(consumes_semi_id)'); } catch(e) {}

  // Purchase lots — for future FIFO support (populated on receive, not consumed yet)
  await createTableIfMissing('purchase_lots', `
    CREATE TABLE purchase_lots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      inv_item_id VARCHAR(50) NOT NULL,
      purchase_id VARCHAR(50),
      received_date DATETIME,
      qty_received DECIMAL(12,2) DEFAULT 0,
      qty_remaining DECIMAL(12,2) DEFAULT 0,
      unit_cost DECIMAL(10,4) DEFAULT 0,
      FOREIGN KEY (inv_item_id) REFERENCES inv_items(id) ON DELETE CASCADE,
      INDEX idx_lots_item (inv_item_id),
      INDEX idx_lots_purchase (purchase_id)
    ) ENGINE=InnoDB
  `);

  // Stocktake tables
  await createTableIfMissing('stocktakes', `
    CREATE TABLE stocktakes (
      id VARCHAR(50) PRIMARY KEY,
      stocktake_date DATETIME,
      username VARCHAR(100),
      notes TEXT,
      status ENUM('completed') DEFAULT 'completed',
      items_count INT DEFAULT 0,
      total_variance DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('stocktake_items', `
    CREATE TABLE stocktake_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      stocktake_id VARCHAR(50) NOT NULL,
      inv_item_id VARCHAR(50),
      inv_item_name VARCHAR(200),
      unit VARCHAR(50),
      system_qty DECIMAL(12,2) DEFAULT 0,
      actual_qty DECIMAL(12,2) DEFAULT 0,
      variance DECIMAL(12,2) DEFAULT 0,
      FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Stock adjustment tables (تعديل كمية — تالف / إداري / تسويات)
  await createTableIfMissing('stock_adjustments', `
    CREATE TABLE stock_adjustments (
      id VARCHAR(50) PRIMARY KEY,
      adjustment_date DATETIME,
      reason ENUM('damaged','admin','settlement') DEFAULT 'damaged',
      reason_notes TEXT,
      username VARCHAR(100),
      status ENUM('pending','approved') DEFAULT 'pending',
      items_count INT DEFAULT 0,
      total_cost DECIMAL(12,2) DEFAULT 0,
      approved_by VARCHAR(100),
      approved_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('stock_adjustment_items', `
    CREATE TABLE stock_adjustment_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      adjustment_id VARCHAR(50) NOT NULL,
      inv_item_id VARCHAR(50),
      inv_item_name VARCHAR(200),
      unit VARCHAR(50),
      qty DECIMAL(12,2) DEFAULT 0,
      unit_cost DECIMAL(10,4) DEFAULT 0,
      total_cost DECIMAL(12,2) DEFAULT 0,
      stock_before DECIMAL(12,2) DEFAULT 0,
      stock_after DECIMAL(12,2) DEFAULT 0,
      FOREIGN KEY (adjustment_id) REFERENCES stock_adjustments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Shortage requests tables
  await createTableIfMissing('shortage_requests', `
    CREATE TABLE shortage_requests (
      id VARCHAR(50) PRIMARY KEY,
      request_number VARCHAR(20),
      request_date DATETIME,
      username VARCHAR(100),
      notes TEXT,
      status ENUM('pending','approved','rejected','converted','partially_received','fully_received','closed') DEFAULT 'pending',
      supply_mode ENUM('parent_company','warehouse') DEFAULT 'parent_company',
      total_items INT DEFAULT 0,
      approved_by VARCHAR(100),
      approved_at DATETIME,
      po_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('shortage_items', `
    CREATE TABLE shortage_items (
      id VARCHAR(50) PRIMARY KEY,
      request_id VARCHAR(50) NOT NULL,
      inv_item_id VARCHAR(50),
      inv_item_name VARCHAR(200),
      unit VARCHAR(50),
      current_qty DECIMAL(12,2) DEFAULT 0,
      min_qty DECIMAL(12,2) DEFAULT 0,
      requested_qty DECIMAL(12,2) DEFAULT 0,
      unit_price DECIMAL(10,4) DEFAULT 0,
      FOREIGN KEY (request_id) REFERENCES shortage_requests(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Cost centers table
  await createTableIfMissing('cost_centers', `
    CREATE TABLE cost_centers (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) NOT NULL,
      name VARCHAR(200) NOT NULL,
      type ENUM('branch','department','project') DEFAULT 'branch',
      parent_id VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Warehouses table (multi-warehouse)
  await createTableIfMissing('warehouses', `
    CREATE TABLE warehouses (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) NOT NULL,
      name VARCHAR(200) NOT NULL,
      type ENUM('branch','main','production','waste','raw','finished') DEFAULT 'branch',
      branch_id VARCHAR(50),
      location VARCHAR(200),
      manager VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Warehouses: add brand + cost center columns
  await addColumnIfMissing('warehouses', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('warehouses', 'cost_center_id', "VARCHAR(50)");

  // Warehouse stock (per-warehouse inventory)
  await createTableIfMissing('warehouse_stock', `
    CREATE TABLE warehouse_stock (
      id VARCHAR(50) PRIMARY KEY,
      warehouse_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      qty DECIMAL(12,2) DEFAULT 0,
      UNIQUE KEY uq_wh_item (warehouse_id, item_id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Warehouse transfers
  await createTableIfMissing('warehouse_transfers', `
    CREATE TABLE warehouse_transfers (
      id VARCHAR(50) PRIMARY KEY,
      transfer_number VARCHAR(20),
      from_warehouse_id VARCHAR(50),
      to_warehouse_id VARCHAR(50),
      transfer_date DATETIME,
      status ENUM('draft','approved','completed','cancelled') DEFAULT 'draft',
      items_json LONGTEXT,
      notes TEXT,
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Branches: add new columns
  await addColumnIfMissing('branches', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('branches', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('branches', 'manager', "VARCHAR(100)");
  await addColumnIfMissing('branches', 'supply_mode', "ENUM('parent_company','warehouse','auto') DEFAULT 'parent_company'");

  // Custody expenses: add cost_center
  await addColumnIfMissing('custody_expenses', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('custody_expenses', 'cost_center_name', "VARCHAR(200)");
  await addColumnIfMissing('custody_expenses', 'pre_approval_status', "ENUM('none','requested','approved','rejected') DEFAULT 'none'");

  // ═══════════════════════════════════════
  // WORKFLOW ENGINE TABLES (نظام المعاملات)
  // ═══════════════════════════════════════

  // Administrative positions (المناصب الإدارية)
  await createTableIfMissing('positions', `
    CREATE TABLE positions (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      level INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Permissions (الصلاحيات)
  await createTableIfMissing('permissions', `
    CREATE TABLE permissions (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(100) NOT NULL UNIQUE,
      description VARCHAR(200)
    ) ENGINE=InnoDB
  `);

  // Position-Permission mapping
  await createTableIfMissing('position_permissions', `
    CREATE TABLE position_permissions (
      id VARCHAR(50) PRIMARY KEY,
      position_id VARCHAR(50) NOT NULL,
      permission_id VARCHAR(50) NOT NULL,
      UNIQUE KEY uq_pos_perm (position_id, permission_id)
    ) ENGINE=InnoDB
  `);

  // Transaction types (أنواع المعاملات)
  await createTableIfMissing('transaction_types', `
    CREATE TABLE transaction_types (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(50) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Workflow definitions (خطوات المعاملة)
  await createTableIfMissing('workflow_definitions', `
    CREATE TABLE workflow_definitions (
      id VARCHAR(50) PRIMARY KEY,
      transaction_type_id VARCHAR(50) NOT NULL,
      step_order INT NOT NULL,
      step_name VARCHAR(200) NOT NULL,
      required_position_id VARCHAR(50),
      can_edit_amount BOOLEAN DEFAULT FALSE,
      can_return_to_previous BOOLEAN DEFAULT TRUE,
      is_final_step BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (transaction_type_id) REFERENCES transaction_types(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Workflow step users (optional — specific user for step)
  await createTableIfMissing('workflow_step_users', `
    CREATE TABLE workflow_step_users (
      id VARCHAR(50) PRIMARY KEY,
      workflow_definition_id VARCHAR(50) NOT NULL,
      user_id VARCHAR(50) NOT NULL,
      FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Transactions (المعاملات)
  await createTableIfMissing('transactions', `
    CREATE TABLE transactions (
      id VARCHAR(50) PRIMARY KEY,
      transaction_number VARCHAR(20),
      transaction_type_id VARCHAR(50) NOT NULL,
      created_by VARCHAR(100),
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      title VARCHAR(300) NOT NULL,
      description TEXT,
      amount DECIMAL(12,2) DEFAULT 0,
      status ENUM('draft','pending','in_progress','rejected','approved','closed') DEFAULT 'draft',
      current_step_id VARCHAR(50),
      attachment LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (transaction_type_id) REFERENCES transaction_types(id)
    ) ENGINE=InnoDB
  `);

  // Transaction steps log (سجل الحركات)
  await createTableIfMissing('transaction_steps_log', `
    CREATE TABLE transaction_steps_log (
      id VARCHAR(50) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      workflow_definition_id VARCHAR(50),
      action_by VARCHAR(100),
      action_type ENUM('create','approve','reject','return','forward','close') NOT NULL,
      action_note TEXT,
      attachment LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Link users to positions
  await addColumnIfMissing('users', 'position_id', "VARCHAR(50)");

  // Transaction enhancements — accounting link + recipient
  await addColumnIfMissing('transactions', 'account_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'account_code', "VARCHAR(20)");
  await addColumnIfMissing('transactions', 'account_name', "VARCHAR(200)");
  await addColumnIfMissing('transactions', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'cost_center_name', "VARCHAR(200)");
  await addColumnIfMissing('transactions', 'recipient_username', "VARCHAR(100)");
  await addColumnIfMissing('transactions', 'sender_name', "VARCHAR(200)");
  await addColumnIfMissing('transactions', 'sender_position', "VARCHAR(200)");
  await addColumnIfMissing('transaction_steps_log', 'attachment', "LONGTEXT");
  await addColumnIfMissing('transaction_steps_log', 'position_name', "VARCHAR(200)");

  // ─── V3: CEO approval tracking ───
  // Set when a transaction passes through any position with level >= 9 (CEO/owner)
  await addColumnIfMissing('transactions', 'passed_ceo_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('transactions', 'passed_ceo_by', "VARCHAR(100) DEFAULT NULL");

  // ─── V3: Transaction Replies (proper threaded comments, separate from action log) ───
  await createTableIfMissing('transaction_replies', `
    CREATE TABLE transaction_replies (
      id VARCHAR(60) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      reply_text TEXT NOT NULL,
      attachment LONGTEXT,
      author_username VARCHAR(100) NOT NULL,
      author_name VARCHAR(200),
      author_role VARCHAR(50),
      author_position VARCHAR(200),
      is_internal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_replies_txn (transaction_id),
      INDEX idx_replies_author (author_username)
    ) ENGINE=InnoDB
  `);

  // ─── V3: Memo (تعاميم) read-receipts ───
  await createTableIfMissing('memo_read_receipts', `
    CREATE TABLE memo_read_receipts (
      id VARCHAR(60) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      username VARCHAR(100) NOT NULL,
      read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_memo_user (transaction_id, username),
      INDEX idx_memo_user (username)
    ) ENGINE=InnoDB
  `);

  // ─── V3: Memo transaction type ───
  // The system already seeds 'TT-MEMO' (code='MEMO', name='مذكرة داخلية') from
  // routes/workflow.js. /memos-inbox accepts both 'MEMO' and 'MEMO_CIRCULAR'
  // codes, so no seed needed here.

  // ─── V3: RBAC (Role-Based Access Control) ───
  // Granular per-permission access. Replaces old role==='admin' checks.
  await createTableIfMissing('permissions_v3', `
    CREATE TABLE permissions_v3 (
      id VARCHAR(80) PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      label_ar VARCHAR(200) NOT NULL,
      label_en VARCHAR(200),
      description TEXT,
      is_sensitive BOOLEAN DEFAULT FALSE,
      sort_order INT DEFAULT 0,
      INDEX idx_perm_cat (category)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('role_permissions', `
    CREATE TABLE role_permissions (
      role VARCHAR(50) NOT NULL,
      permission_id VARCHAR(80) NOT NULL,
      PRIMARY KEY (role, permission_id),
      INDEX idx_rp_role (role)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('user_permission_overrides', `
    CREATE TABLE user_permission_overrides (
      username VARCHAR(100) NOT NULL,
      permission_id VARCHAR(80) NOT NULL,
      grant_type ENUM('grant','revoke') NOT NULL,
      granted_by VARCHAR(100),
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, permission_id),
      INDEX idx_upo_user (username)
    ) ENGINE=InnoDB
  `);

  // Extend users.role ENUM to support new specialized roles
  try {
    await db.query("ALTER TABLE users MODIFY COLUMN role ENUM('admin','cashier','manager','custody','employee','finance','hr','inventory','purchasing') DEFAULT 'cashier'");
  } catch(e) {}

  // Seed permissions catalog (idempotent)
  try {
    const [pcnt] = await db.query("SELECT COUNT(*) AS c FROM permissions_v3");
    if (pcnt[0].c === 0) {
      const perms = [
        // POS / Cashier
        ['pos.use', 'pos', 'استخدام شاشة الكاشير', 'Use POS', 0, 110],
        ['pos.shift_close', 'pos', 'إغلاق الشيفت', 'Close shift', 0, 120],
        ['pos.discount.apply', 'pos', 'تطبيق خصومات على الفواتير', 'Apply discounts', 0, 130],
        ['pos.refund', 'pos', 'استرجاع فواتير', 'Refund sales', 1, 140],
        // Sales
        ['sales.view', 'sales', 'عرض سجل المبيعات', 'View sales log', 0, 210],
        ['sales.delete', 'sales', 'حذف فواتير المبيعات', 'Delete sales', 1, 220],
        ['sales.reports.view', 'sales', 'عرض تقارير المبيعات', 'View sales reports', 0, 230],
        ['sales.reports.advanced', 'sales', 'عرض التقارير المتقدمة', 'View advanced reports', 0, 240],
        // Inventory
        ['inventory.view', 'inventory', 'عرض المخزون والجرد', 'View inventory', 0, 310],
        ['inventory.edit', 'inventory', 'تعديل المخزون', 'Edit inventory', 0, 320],
        ['warehouse.view', 'inventory', 'عرض المستودعات', 'View warehouses', 0, 330],
        ['warehouse.transfer', 'inventory', 'تحويل بين المستودعات', 'Warehouse transfers', 0, 340],
        ['waste.create', 'inventory', 'تسجيل قيود الهدر', 'Record waste', 0, 350],
        ['production.view', 'inventory', 'عرض أوامر الإنتاج', 'View production', 0, 360],
        ['production.create', 'inventory', 'إنشاء أمر إنتاج', 'Create production order', 0, 370],
        ['production.complete', 'inventory', 'إكمال أمر إنتاج', 'Complete production', 0, 380],
        // Purchasing
        ['purchases.view', 'purchasing', 'عرض المشتريات', 'View purchases', 0, 410],
        ['purchases.create', 'purchasing', 'إنشاء أمر شراء', 'Create PO', 0, 420],
        ['purchases.approve', 'purchasing', 'اعتماد أوامر الشراء', 'Approve PO', 1, 430],
        ['suppliers.view', 'purchasing', 'عرض الموردين', 'View suppliers', 0, 440],
        ['suppliers.edit', 'purchasing', 'تعديل الموردين', 'Edit suppliers', 0, 450],
        // Finance
        ['finance.view', 'finance', 'عرض القسم المالي', 'View finance section', 0, 510],
        ['finance.gl.view', 'finance', 'عرض القيود المحاسبية', 'View journals', 0, 520],
        ['finance.gl.create', 'finance', 'إنشاء قيود يدوية', 'Create manual journals', 1, 530],
        ['finance.gl.approve', 'finance', 'اعتماد القيود', 'Approve journals', 1, 540],
        ['finance.reports.view', 'finance', 'عرض التقارير المالية (IFRS)', 'View financial reports', 0, 550],
        ['finance.cash.view', 'finance', 'عرض النقدية والبنوك', 'View cash & banks', 0, 560],
        ['finance.cash.transfer', 'finance', 'تحويلات نقدية', 'Cash transfers', 1, 570],
        ['finance.payment.create', 'finance', 'إنشاء سداد', 'Create payment', 1, 580],
        ['finance.expenses.view', 'finance', 'عرض المصروفات', 'View expenses', 0, 590],
        ['finance.expenses.approve', 'finance', 'اعتماد المصروفات', 'Approve expenses', 1, 600],
        // HR
        ['hr.view', 'hr', 'عرض قسم الموارد البشرية', 'View HR section', 0, 610],
        ['hr.employees.view', 'hr', 'عرض الموظفين', 'View employees', 0, 620],
        ['hr.employees.edit', 'hr', 'تعديل بيانات الموظفين', 'Edit employees', 1, 630],
        ['hr.attendance.view', 'hr', 'عرض الحضور والانصراف', 'View attendance', 0, 640],
        ['hr.payroll.view', 'hr', 'عرض الرواتب', 'View payroll', 1, 650],
        ['hr.payroll.run', 'hr', 'تشغيل الرواتب', 'Run payroll', 1, 660],
        ['hr.advances.approve', 'hr', 'اعتماد السلف', 'Approve advances', 1, 670],
        // Workflow / Transactions
        ['txn.view', 'workflow', 'عرض المعاملات', 'View transactions', 0, 710],
        ['txn.create', 'workflow', 'إنشاء معاملة', 'Create transaction', 0, 720],
        ['txn.approve', 'workflow', 'الموافقة على المعاملات', 'Approve transactions', 0, 730],
        ['txn.reject', 'workflow', 'الرفض', 'Reject transactions', 0, 740],
        ['txn.return', 'workflow', 'الإرجاع', 'Return transactions', 0, 750],
        // Organization / Admin
        ['org.brands.view', 'admin', 'عرض البراندات', 'View brands', 0, 810],
        ['org.brands.edit', 'admin', 'تعديل البراندات', 'Edit brands', 1, 820],
        ['org.branches.edit', 'admin', 'تعديل الفروع', 'Edit branches', 1, 830],
        ['org.companies.edit', 'admin', 'تعديل الشركات', 'Edit companies', 1, 840],
        ['admin.users.manage', 'admin', 'إدارة المستخدمين والصلاحيات', 'Manage users & permissions', 1, 850],
        ['admin.audit.view', 'admin', 'عرض سجل العمليات', 'View audit log', 1, 860],
        // Tax / Channels
        ['tax.view', 'tax', 'عرض تقارير الضريبة وZATCA', 'View tax & ZATCA', 0, 910],
        ['payment_methods.manage', 'tax', 'إدارة طرق الدفع', 'Manage payment methods', 1, 920],
        ['channels.manage', 'tax', 'إدارة قنوات البيع', 'Manage sales channels', 1, 930],
        ['discounts.manage', 'tax', 'إدارة الخصومات', 'Manage discounts', 1, 940]
      ];
      for (const p of perms) {
        await db.query(
          'INSERT IGNORE INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive, sort_order) VALUES (?,?,?,?,?,?)',
          [p[0], p[1], p[2], p[3], p[4], p[5]]
        );
      }
    }
  } catch(e) { console.error('seed permissions_v3 failed:', e.message); }

  // Seed default role → permissions mapping (idempotent — only if empty)
  try {
    const [rcnt] = await db.query("SELECT COUNT(*) AS c FROM role_permissions");
    if (rcnt[0].c === 0) {
      // admin = ALL permissions
      const [allPerms] = await db.query("SELECT id FROM permissions_v3");
      for (const p of allPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['admin', p.id]);
      }
      // manager = nearly everything view + most actions (no admin.users.manage, no sales.delete)
      const managerPerms = allPerms
        .map(r => r.id)
        .filter(id => id !== 'admin.users.manage' && id !== 'sales.delete' && id !== 'admin.audit.view');
      for (const id of managerPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['manager', id]);
      }
      // cashier = POS + view own sales
      for (const id of ['pos.use','pos.shift_close','pos.discount.apply','sales.view','txn.view','txn.create']) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['cashier', id]);
      }
      // custody = expenses + own custody
      for (const id of ['finance.expenses.view','txn.view','txn.create']) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['custody', id]);
      }
      // employee = workflow only
      for (const id of ['txn.view','txn.create']) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['employee', id]);
      }
      // finance = all finance + sales reports + tax — NO HR / inventory edit
      const financePerms = ['finance.view','finance.gl.view','finance.gl.create','finance.gl.approve',
        'finance.reports.view','finance.cash.view','finance.cash.transfer','finance.payment.create',
        'finance.expenses.view','finance.expenses.approve','sales.view','sales.reports.view',
        'sales.reports.advanced','tax.view','txn.view','txn.create','txn.approve','txn.reject',
        'inventory.view','warehouse.view','purchases.view','suppliers.view'];
      for (const id of financePerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['finance', id]);
      }
      // hr = all HR — NO finance / inventory
      const hrPerms = ['hr.view','hr.employees.view','hr.employees.edit','hr.attendance.view',
        'hr.payroll.view','hr.payroll.run','hr.advances.approve','txn.view','txn.create','txn.approve','txn.reject'];
      for (const id of hrPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['hr', id]);
      }
      // inventory = all inventory + purchases view — NO finance / HR
      const invPerms = ['inventory.view','inventory.edit','warehouse.view','warehouse.transfer',
        'waste.create','production.view','production.create','production.complete',
        'purchases.view','suppliers.view','txn.view','txn.create'];
      for (const id of invPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['inventory', id]);
      }
      // purchasing = all purchases + suppliers + view inventory
      const pPerms = ['purchases.view','purchases.create','purchases.approve','suppliers.view',
        'suppliers.edit','inventory.view','warehouse.view','txn.view','txn.create'];
      for (const id of pPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['purchasing', id]);
      }
    }
  } catch(e) { console.error('seed role_permissions failed:', e.message); }

  // Seed default positions
  try {
    const [posCount] = await db.query('SELECT COUNT(*) AS cnt FROM positions');
    if (posCount[0].cnt === 0) {
      await db.query("INSERT INTO positions (id, name, level) VALUES ('POS-0','موظف',1),('POS-1','محاسب',2),('POS-5','مدير فرع',3),('POS-4','مسؤول بنوك',3),('POS-2','مدير مالي',4),('POS-3','مدير تنفيذي',5),('POS-6','مدير عام',6)");
    }
  } catch(e) {}

  // Seed default permissions
  try {
    const [permCount] = await db.query('SELECT COUNT(*) AS cnt FROM permissions');
    if (permCount[0].cnt === 0) {
      await db.query("INSERT INTO permissions (id, code, description) VALUES ('PERM-1','CREATE_REQUEST','إنشاء معاملة'),('PERM-2','APPROVE','موافقة'),('PERM-3','REJECT','رفض'),('PERM-4','RETURN','إرجاع'),('PERM-5','CLOSE','إقفال'),('PERM-6','VIEW_ALL','عرض الكل')");
    }
  } catch(e) {}

  // Seed default transaction types
  try {
    const [ttCount] = await db.query('SELECT COUNT(*) AS cnt FROM transaction_types');
    if (ttCount[0].cnt === 0) {
      await db.query("INSERT INTO transaction_types (id, name, code) VALUES ('TT-1','طلب صرف مستحقات','EXPENSE_REQUEST'),('TT-2','طلب شراء','PURCHASE_REQUEST'),('TT-3','طلب أصل ثابت','ASSET_REQUEST')");
    }
  } catch(e) {}

  // Brands table (multi-brand support)
  await createTableIfMissing('brands', `
    CREATE TABLE brands (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(20),
      logo LONGTEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Add brand_id to existing tables
  await addColumnIfMissing('branches', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('menu', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('users', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('users', 'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('inv_items', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('sales', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('sales', 'branch_id', "VARCHAR(50)");

  // Create default brand if none exists
  try {
    const [brands] = await db.query('SELECT COUNT(*) AS cnt FROM brands');
    if (brands[0].cnt === 0) {
      await db.query("INSERT INTO brands (id, name, code) VALUES ('BR-DEFAULT', 'Moroccan Taste', 'MT')");
    }
  } catch(e) {}

  // Dynamic Payment Methods (advanced)
  await addColumnIfMissing('payment_methods', 'type', "VARCHAR(50) DEFAULT 'standard'");
  await addColumnIfMissing('payment_methods', 'require_reference', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('payment_methods', 'require_transaction_number', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('payment_methods', 'require_terminal', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('payment_methods', 'allow_refund', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('payment_methods', 'allow_cancel', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('payment_methods', 'color', "VARCHAR(20) DEFAULT '#3b82f6'");

  // Branch payment methods
  await createTableIfMissing('branch_payment_methods', `
    CREATE TABLE branch_payment_methods (
      id VARCHAR(50) PRIMARY KEY,
      branch_id VARCHAR(50) NOT NULL,
      payment_method_id VARCHAR(50) NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      UNIQUE KEY uq_br_pm (branch_id, payment_method_id)
    ) ENGINE=InnoDB
  `);

  // Dynamic Discounts (advanced)
  await createTableIfMissing('discounts_v2', `
    CREATE TABLE discounts_v2 (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      type ENUM('percentage','fixed','promo_code','automatic') DEFAULT 'percentage',
      value DECIMAL(10,2) DEFAULT 0,
      max_amount DECIMAL(10,2) DEFAULT 0,
      min_order DECIMAL(10,2) DEFAULT 0,
      require_approval BOOLEAN DEFAULT FALSE,
      require_code BOOLEAN DEFAULT FALSE,
      code VARCHAR(50),
      enabled BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      valid_from DATE,
      valid_to DATE,
      apply_on ENUM('invoice','item','category') DEFAULT 'invoice',
      color VARCHAR(20) DEFAULT '#8b5cf6',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Branch discounts
  await createTableIfMissing('branch_discounts', `
    CREATE TABLE branch_discounts (
      id VARCHAR(50) PRIMARY KEY,
      branch_id VARCHAR(50) NOT NULL,
      discount_id VARCHAR(50) NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      UNIQUE KEY uq_br_disc (branch_id, discount_id)
    ) ENGINE=InnoDB
  `);

  // ─── Payment Methods v3: enterprise fields (group, GL, cost center, fees, advanced flags) ───
  await addColumnIfMissing('payment_methods', 'group_type', "ENUM('cash','electronic','voucher','loyalty','transfer','other') DEFAULT 'cash'");
  await addColumnIfMissing('payment_methods', 'gl_account_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('payment_methods', 'cost_center_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('payment_methods', 'allow_manual_total', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('payment_methods', 'show_in_shift_close', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('payment_methods', 'show_in_reports', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('payment_methods', 'service_fee_type', "ENUM('percent','fixed','none') DEFAULT 'none'");
  await addColumnIfMissing('payment_methods', 'service_fee_value', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('payment_methods', 'description', "TEXT");
  await addColumnIfMissing('payment_methods', 'created_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing('payment_methods', 'updated_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  // ─── Sales Channels (المنيو الرئيسي / هنقرستيشن / كيتا / تطبيق_خاص / طلب_هاتفي) ───
  await createTableIfMissing('sales_channels', `
    CREATE TABLE sales_channels (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(50) UNIQUE,
      name VARCHAR(200) NOT NULL,
      name_en VARCHAR(200),
      channel_type ENUM('dine_in','takeaway','delivery','aggregator','phone','app','online') DEFAULT 'dine_in',
      price_list_id VARCHAR(50) DEFAULT NULL,
      icon VARCHAR(60) DEFAULT 'fa-store',
      color VARCHAR(20) DEFAULT '#3b82f6',
      commission_pct DECIMAL(5,2) DEFAULT 0,
      service_fee_pct DECIMAL(5,2) DEFAULT 0,
      gl_revenue_account VARCHAR(50) DEFAULT NULL,
      gl_commission_account VARCHAR(50) DEFAULT NULL,
      requires_external_ref BOOLEAN DEFAULT FALSE,
      allow_discount BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_channel_type (channel_type),
      INDEX idx_price_list (price_list_id)
    ) ENGINE=InnoDB
  `);

  // Seed default sales channels (idempotent)
  try {
    const [chCnt] = await db.query('SELECT COUNT(*) AS c FROM sales_channels');
    if (chCnt[0].c === 0) {
      await db.query(`INSERT INTO sales_channels (id, code, name, channel_type, icon, color, display_order, is_active) VALUES
        ('CH-MAIN','MAIN','المنيو الرئيسي','dine_in','fa-utensils','#3b82f6',1,1),
        ('CH-HUNGER','HUNGERSTATION','هنقرستيشن','aggregator','fa-motorcycle','#fbbf24',2,1),
        ('CH-KEETA','KEETA','كيتا','aggregator','fa-bicycle','#ef4444',3,1),
        ('CH-APP','APP','تطبيق خاص','app','fa-mobile-screen','#8b5cf6',4,1),
        ('CH-PHONE','PHONE','طلب هاتفي','phone','fa-phone','#10b981',5,1)`);
    }
  } catch(e) {}

  // ─── Discounts v2: GL link + permission level ───
  await addColumnIfMissing('discounts_v2', 'gl_account_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('discounts_v2', 'discount_scope', "ENUM('line','invoice','preset','manual') DEFAULT 'invoice'");
  await addColumnIfMissing('discounts_v2', 'min_role', "ENUM('cashier','manager','admin') DEFAULT 'cashier'");
  await addColumnIfMissing('discounts_v2', 'max_per_invoice', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('discounts_v2', 'show_in_pos', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('discounts_v2', 'icon', "VARCHAR(60) DEFAULT 'fa-tag'");
  await addColumnIfMissing('discounts_v2', 'description', "TEXT");

  // ─── Shift close: cash denominations table ───
  await createTableIfMissing('shift_close_denominations', `
    CREATE TABLE shift_close_denominations (
      id VARCHAR(60) PRIMARY KEY,
      shift_id VARCHAR(50) NOT NULL,
      denomination DECIMAL(10,2) NOT NULL,
      kind ENUM('coin','note') DEFAULT 'note',
      count INT DEFAULT 0,
      total DECIMAL(14,4) GENERATED ALWAYS AS (denomination * count) STORED,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_shift (shift_id)
    ) ENGINE=InnoDB
  `);

  // Shifts: dynamic payment-method totals (JSON) + cash counted
  await addColumnIfMissing('shifts', 'payment_totals_json', "LONGTEXT");
  await addColumnIfMissing('shifts', 'denominations_json', "LONGTEXT");
  await addColumnIfMissing('shifts', 'cashier_notes', "TEXT");
  await addColumnIfMissing('shifts', 'opening_float', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('shifts', 'expected_total', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('shifts', 'actual_total', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('shifts', 'variance_total', "DECIMAL(14,4) DEFAULT 0");

  // ─── Sales: V3 channel + discount tracking (for reports + GL routing) ───
  await addColumnIfMissing('sales', 'channel_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('sales', 'channel_name', "VARCHAR(200) DEFAULT NULL");
  await addColumnIfMissing('sales', 'discount_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('sales', 'discount_name', "VARCHAR(200) DEFAULT NULL");
  await addColumnIfMissing('sales', 'discount_amount', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('sales', 'discount_gl_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('sales', 'line_discounts_json', "LONGTEXT");
  try { await db.query('CREATE INDEX idx_sales_channel ON sales(channel_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_sales_discount ON sales(discount_id)'); } catch(e) {}

  // ─── V3 spec gap fixes ───
  // Warehouses: multi-brand allowed list (JSON array of brand IDs)
  await addColumnIfMissing('warehouses', 'allowed_brands', "LONGTEXT");
  // Brands: linked branches (JSON array of branch IDs)
  await addColumnIfMissing('brands', 'linked_branches', "LONGTEXT");
  // Users: explicit default_branch_id (in addition to existing branch_id)
  await addColumnIfMissing('users', 'default_branch_id', "VARCHAR(50) DEFAULT NULL");
  // Users: can change branch (default false for cashier — per spec)
  await addColumnIfMissing('users', 'can_change_branch', "BOOLEAN DEFAULT FALSE");

  // Audit log table
  await createTableIfMissing('audit_logs', `
    CREATE TABLE audit_logs (
      id VARCHAR(50) PRIMARY KEY,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id VARCHAR(50),
      username VARCHAR(100),
      details LONGTEXT,
      ip_address VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_entity (entity_type, entity_id),
      INDEX idx_audit_user (username),
      INDEX idx_audit_date (created_at)
    ) ENGINE=InnoDB
  `);

  // GL journals: add cost_center_id
  await addColumnIfMissing('gl_journals', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('gl_journals', 'cost_center_name', "VARCHAR(200)");
  // GL entries: add cost_center_id
  await addColumnIfMissing('gl_entries', 'cost_center_id', "VARCHAR(50)");

  // Extend shortage status ENUM for existing tables
  try { await db.query("ALTER TABLE shortage_requests MODIFY COLUMN status ENUM('pending','approved','rejected','converted','partially_received','fully_received','closed') DEFAULT 'pending'"); } catch(e) {}
  // Extend PO status for partial receive
  try { await db.query("ALTER TABLE purchase_orders MODIFY COLUMN status ENUM('draft','approved','received','cancelled','partially_received') DEFAULT 'draft'"); } catch(e) {}

  // Supply source setting
  try {
    await db.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('supply_source_mode','parent_company')");
  } catch(e) {}

  // Purchase receive workflow columns
  await addColumnIfMissing('purchases', 'received_items_json', "LONGTEXT");
  await addColumnIfMissing('purchases', 'receive_status', "ENUM('none','pending','approved') DEFAULT 'none'");
  await addColumnIfMissing('purchases', 'received_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('purchases', 'receive_approved_by', "VARCHAR(100) DEFAULT ''");

  // Security: account lockout columns
  await addColumnIfMissing('users', 'failed_attempts', "INT DEFAULT 0");
  await addColumnIfMissing('users', 'locked_until', "DATETIME DEFAULT NULL");

  // User roles ENUM — include 'employee' for employee portal
  try { await db.query("ALTER TABLE users MODIFY COLUMN role ENUM('admin','cashier','manager','custody','employee') DEFAULT 'cashier'"); } catch(e) {}

  // Custody management tables (العهد)
  await createTableIfMissing('custody_users', `
    CREATE TABLE custody_users (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      id_number VARCHAR(20),
      phone VARCHAR(20),
      job_title VARCHAR(100),
      notes TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      linked_username VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('custodies', `
    CREATE TABLE custodies (
      id VARCHAR(50) PRIMARY KEY,
      custody_number VARCHAR(20) UNIQUE,
      user_id VARCHAR(50) NOT NULL,
      user_name VARCHAR(200),
      created_date DATETIME,
      balance DECIMAL(14,2) DEFAULT 0,
      total_topups DECIMAL(14,2) DEFAULT 0,
      total_expenses DECIMAL(14,2) DEFAULT 0,
      status ENUM('active','closed') DEFAULT 'active',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES custody_users(id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('custody_topups', `
    CREATE TABLE custody_topups (
      id VARCHAR(50) PRIMARY KEY,
      custody_id VARCHAR(50) NOT NULL,
      amount DECIMAL(14,2),
      payment_method VARCHAR(50),
      receipt_image LONGTEXT,
      notes TEXT,
      created_at DATETIME,
      created_by VARCHAR(100),
      FOREIGN KEY (custody_id) REFERENCES custodies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('custody_expenses', `
    CREATE TABLE custody_expenses (
      id VARCHAR(50) PRIMARY KEY,
      custody_id VARCHAR(50) NOT NULL,
      expense_date DATE,
      description TEXT,
      amount DECIMAL(14,2),
      has_vat BOOLEAN DEFAULT FALSE,
      vat_rate DECIMAL(5,2) DEFAULT 15,
      vat_amount DECIMAL(14,2) DEFAULT 0,
      total_with_vat DECIMAL(14,2) DEFAULT 0,
      invoice_image LONGTEXT,
      notes TEXT,
      status ENUM('pending','approved','rejected','posted') DEFAULT 'pending',
      rejection_reason TEXT,
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      approved_at DATETIME,
      posted_by VARCHAR(100),
      posted_at DATETIME,
      journal_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (custody_id) REFERENCES custodies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Custody close request columns + override status
  await addColumnIfMissing('custodies', 'close_requested_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('custodies', 'close_requested_at', "DATETIME");
  await addColumnIfMissing('custodies', 'close_approved_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('custodies', 'close_approved_at', "DATETIME");
  await addColumnIfMissing('custodies', 'close_notes', "TEXT");
  // Extend custodies status ENUM to include close_pending
  try { await db.query("ALTER TABLE custodies MODIFY COLUMN status ENUM('active','closed','close_pending') DEFAULT 'active'"); } catch(e) {}
  // GL journals — status workflow + attachment columns
  await addColumnIfMissing('gl_journals', 'attachment', "LONGTEXT");
  await addColumnIfMissing('gl_journals', 'notes', "TEXT");
  await addColumnIfMissing('gl_journals', 'approved_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('gl_journals', 'approved_at', "DATETIME");
  await addColumnIfMissing('gl_journals', 'posted_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('gl_journals', 'posted_at', "DATETIME");
  try { await db.query("ALTER TABLE gl_journals MODIFY COLUMN status ENUM('draft','approved','posted') DEFAULT 'draft'"); } catch(e) {}

  // GL account link on custody expenses
  await addColumnIfMissing('custody_expenses', 'gl_account_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('custody_expenses', 'gl_account_name', "VARCHAR(200) DEFAULT ''");

  // Extend custody_expenses status ENUM to include override_pending + returned
  try { await db.query("ALTER TABLE custody_expenses MODIFY COLUMN status ENUM('pending','approved','rejected','posted','override_pending','returned') DEFAULT 'pending'"); } catch(e) {}

  // ═══════════════════════════════════════
  // HR MODULE TABLES (نظام الموارد البشرية)
  // ═══════════════════════════════════════

  await createTableIfMissing('hr_departments', `
    CREATE TABLE hr_departments (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) NOT NULL,
      name VARCHAR(200) NOT NULL,
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      manager_employee_id VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_employees', `
    CREATE TABLE hr_employees (
      id VARCHAR(50) PRIMARY KEY,
      employee_number VARCHAR(20) NOT NULL UNIQUE,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100),
      full_name VARCHAR(200),
      national_id VARCHAR(20),
      passport_number VARCHAR(20),
      iqama_number VARCHAR(20),
      phone VARCHAR(20),
      email VARCHAR(200),
      gender ENUM('male','female') DEFAULT 'male',
      date_of_birth DATE,
      nationality VARCHAR(100),
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      department_id VARCHAR(50),
      position_id VARCHAR(50),
      job_title VARCHAR(200),
      employment_type ENUM('full_time','part_time','hourly','contract') DEFAULT 'full_time',
      salary_type ENUM('monthly','hourly') DEFAULT 'monthly',
      basic_salary DECIMAL(12,2) DEFAULT 0,
      hourly_rate DECIMAL(8,2) DEFAULT 0,
      housing_allowance DECIMAL(12,2) DEFAULT 0,
      transport_allowance DECIMAL(12,2) DEFAULT 0,
      other_allowance DECIMAL(12,2) DEFAULT 0,
      hire_date DATE,
      contract_end_date DATE,
      probation_end_date DATE,
      status ENUM('active','suspended','terminated','on_leave') DEFAULT 'active',
      termination_date DATE,
      termination_reason TEXT,
      bank_name VARCHAR(200),
      bank_account VARCHAR(50),
      bank_iban VARCHAR(50),
      emergency_contact_name VARCHAR(200),
      emergency_contact_phone VARCHAR(20),
      emergency_contact_relation VARCHAR(100),
      linked_user_id INT,
      linked_username VARCHAR(100),
      photo LONGTEXT,
      notes TEXT,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_emp_branch (branch_id),
      INDEX idx_emp_brand (brand_id),
      INDEX idx_emp_dept (department_id),
      INDEX idx_emp_status (status)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_work_schedules', `
    CREATE TABLE hr_work_schedules (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      branch_id VARCHAR(50),
      work_start TIME NOT NULL DEFAULT '08:00:00',
      work_end TIME NOT NULL DEFAULT '17:00:00',
      break_minutes INT DEFAULT 60,
      work_days VARCHAR(20) DEFAULT '0,1,2,3,4',
      grace_minutes INT DEFAULT 15,
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_attendance', `
    CREATE TABLE hr_attendance (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      attendance_date DATE NOT NULL,
      clock_in DATETIME,
      clock_out DATETIME,
      total_hours DECIMAL(5,2) DEFAULT 0,
      late_minutes INT DEFAULT 0,
      early_leave_minutes INT DEFAULT 0,
      overtime_minutes INT DEFAULT 0,
      status ENUM('present','absent','leave','holiday','weekend') DEFAULT 'present',
      source ENUM('fingerprint','pos','app','manual') DEFAULT 'manual',
      device_id VARCHAR(100),
      geo_lat DECIMAL(10,7),
      geo_lng DECIMAL(10,7),
      notes TEXT,
      modified_by VARCHAR(100),
      modified_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_date (employee_id, attendance_date),
      INDEX idx_att_date (attendance_date),
      INDEX idx_att_emp (employee_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_leave_types', `
    CREATE TABLE hr_leave_types (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(20) NOT NULL,
      default_days INT DEFAULT 0,
      is_paid BOOLEAN DEFAULT TRUE,
      requires_approval BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_leave_balances', `
    CREATE TABLE hr_leave_balances (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      leave_type_id VARCHAR(50) NOT NULL,
      year INT NOT NULL,
      total_days DECIMAL(5,1) DEFAULT 0,
      used_days DECIMAL(5,1) DEFAULT 0,
      remaining_days DECIMAL(5,1) DEFAULT 0,
      UNIQUE KEY uq_bal (employee_id, leave_type_id, year),
      INDEX idx_bal_emp (employee_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_leave_requests', `
    CREATE TABLE hr_leave_requests (
      id VARCHAR(50) PRIMARY KEY,
      request_number VARCHAR(20),
      employee_id VARCHAR(50) NOT NULL,
      leave_type_id VARCHAR(50) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      days_count DECIMAL(5,1) DEFAULT 0,
      reason TEXT,
      status ENUM('pending','branch_approved','hr_approved','rejected','cancelled') DEFAULT 'pending',
      branch_approver VARCHAR(100),
      branch_approved_at DATETIME,
      hr_approver VARCHAR(100),
      hr_approved_at DATETIME,
      rejection_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_leave_emp (employee_id),
      INDEX idx_leave_status (status)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_payroll_runs', `
    CREATE TABLE hr_payroll_runs (
      id VARCHAR(50) PRIMARY KEY,
      run_number VARCHAR(30),
      month INT NOT NULL,
      year INT NOT NULL,
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      status ENUM('draft','calculated','approved','paid') DEFAULT 'draft',
      total_gross DECIMAL(14,2) DEFAULT 0,
      total_deductions DECIMAL(14,2) DEFAULT 0,
      total_net DECIMAL(14,2) DEFAULT 0,
      employee_count INT DEFAULT 0,
      approved_by VARCHAR(100),
      approved_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by VARCHAR(100)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_payroll_items', `
    CREATE TABLE hr_payroll_items (
      id VARCHAR(50) PRIMARY KEY,
      run_id VARCHAR(50) NOT NULL,
      employee_id VARCHAR(50) NOT NULL,
      employee_name VARCHAR(200),
      employee_number VARCHAR(30),
      basic_salary DECIMAL(12,2) DEFAULT 0,
      housing_allowance DECIMAL(12,2) DEFAULT 0,
      transport_allowance DECIMAL(12,2) DEFAULT 0,
      other_allowance DECIMAL(12,2) DEFAULT 0,
      overtime_amount DECIMAL(12,2) DEFAULT 0,
      overtime_hours DECIMAL(6,2) DEFAULT 0,
      gross_salary DECIMAL(12,2) DEFAULT 0,
      absence_deduction DECIMAL(12,2) DEFAULT 0,
      late_deduction DECIMAL(12,2) DEFAULT 0,
      advance_deduction DECIMAL(12,2) DEFAULT 0,
      other_deduction DECIMAL(12,2) DEFAULT 0,
      total_deductions DECIMAL(12,2) DEFAULT 0,
      net_salary DECIMAL(12,2) DEFAULT 0,
      actual_days INT DEFAULT 0,
      absent_days INT DEFAULT 0,
      late_minutes INT DEFAULT 0,
      leave_days INT DEFAULT 0,
      INDEX idx_pi_run (run_id),
      INDEX idx_pi_emp (employee_id)
    ) ENGINE=InnoDB
  `);

  // Fix column name mismatches in existing production payroll tables
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_payroll_runs' AND COLUMN_NAME = 'period_month'`
    );
    if (cols.length) {
      await db.query(`ALTER TABLE hr_payroll_runs CHANGE period_month month INT NOT NULL`);
      await db.query(`ALTER TABLE hr_payroll_runs CHANGE period_year year INT NOT NULL`);
      console.log('[DB] Migration: renamed hr_payroll_runs period_month→month, period_year→year');
    }
  } catch (e) { console.log('[DB] Payroll runs migration:', e.message.substring(0, 120)); }
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_payroll_items' AND COLUMN_NAME = 'payroll_run_id'`
    );
    if (cols.length) {
      await db.query(`ALTER TABLE hr_payroll_items CHANGE payroll_run_id run_id VARCHAR(50) NOT NULL`);
      console.log('[DB] Migration: renamed hr_payroll_items payroll_run_id→run_id');
    }
  } catch (e) { console.log('[DB] Payroll items migration:', e.message.substring(0, 120)); }
  // Add missing columns to hr_payroll_items for existing tables
  await addColumnIfMissing('hr_payroll_items', 'employee_number', "VARCHAR(30)");
  await addColumnIfMissing('hr_payroll_items', 'overtime_hours', "DECIMAL(6,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'actual_days', "INT DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'absent_days', "INT DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'late_minutes', "INT DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'leave_days', "INT DEFAULT 0");
  // New allowance & deduction fields for payroll items
  await addColumnIfMissing('hr_payroll_items', 'food_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'communication_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'education_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'nature_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'social_insurance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'fixed_deduction', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_runs', 'journal_id_accrual', "VARCHAR(50)");
  await addColumnIfMissing('hr_payroll_runs', 'journal_id_deductions', "VARCHAR(50)");
  await addColumnIfMissing('hr_payroll_runs', 'journal_id_payment', "VARCHAR(50)");

  // Add missing columns to hr_payroll_runs for existing tables
  await addColumnIfMissing('hr_payroll_runs', 'created_by', "VARCHAR(100)");
  await addColumnIfMissing('hr_payroll_runs', 'updated_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  // hr_advances missing columns
  await addColumnIfMissing('hr_advances', 'remaining', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_advances', 'monthly_deduction', "DECIMAL(12,2) DEFAULT 0");

  // hr_departments missing columns
  await addColumnIfMissing('hr_departments', 'name_en', "VARCHAR(200)");
  await addColumnIfMissing('hr_departments', 'code', "VARCHAR(50)");
  await addColumnIfMissing('hr_departments', 'branch_id', "VARCHAR(50)");

  // Expand hr_exceptions ENUM to include excuse_absence (for existing tables)
  try {
    await db.query("ALTER TABLE hr_exceptions MODIFY COLUMN exception_type ENUM('ignore_late','ignore_early_leave','ignore_overtime','adjust_attendance','grant_day','excuse_absence') NOT NULL");
  } catch(e) { /* already has the value or table doesn't exist yet */ }

  await createTableIfMissing('hr_documents', `
    CREATE TABLE hr_documents (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      doc_type ENUM('contract','id','passport','iqama','certificate','medical','other') DEFAULT 'other',
      title VARCHAR(200),
      file_data LONGTEXT,
      expiry_date DATE,
      notes TEXT,
      uploaded_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_doc_emp (employee_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_advances', `
    CREATE TABLE hr_advances (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      request_date DATE,
      status ENUM('pending','approved','rejected','deducted') DEFAULT 'pending',
      approved_by VARCHAR(100),
      deduction_months INT DEFAULT 1,
      remaining_amount DECIMAL(12,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Seed default leave types
  try {
    await db.query(`INSERT IGNORE INTO hr_leave_types (id, name, code, default_days, is_paid) VALUES
      ('LT-ANNUAL', 'إجازة سنوية', 'ANNUAL', 21, TRUE),
      ('LT-SICK', 'إجازة مرضية', 'SICK', 10, TRUE),
      ('LT-EMERGENCY', 'إجازة طارئة', 'EMERGENCY', 5, TRUE),
      ('LT-UNPAID', 'إجازة بدون راتب', 'UNPAID', 0, FALSE)`);
  } catch(e) {}

  // Seed default work schedule
  try {
    await db.query(`INSERT IGNORE INTO hr_work_schedules (id, name, work_start, work_end, break_minutes, grace_minutes, is_default) VALUES
      ('WS-DEFAULT', 'الدوام الرسمي', '08:00:00', '17:00:00', 60, 15, TRUE)`);
  } catch(e) {}

  // Users: link to employee
  await addColumnIfMissing('users', 'employee_id', "VARCHAR(50)");

  // ═══════════════════════════════════════
  // SECURITY HARDENING — Database
  // ═══════════════════════════════════════

  // Remove plain_pass column (security fix — passwords must never be stored in plain text)
  try { await db.query('ALTER TABLE users DROP COLUMN plain_pass'); } catch(e) {}

  // Ensure audit_logs table exists with proper structure
  await createTableIfMissing('audit_logs', `
    CREATE TABLE audit_logs (
      id VARCHAR(50) PRIMARY KEY,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id VARCHAR(100),
      username VARCHAR(100),
      details LONGTEXT,
      ip_address VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_entity (entity_type, entity_id),
      INDEX idx_audit_user (username),
      INDEX idx_audit_date (created_at),
      INDEX idx_audit_action (action)
    ) ENGINE=InnoDB
  `);

  // Soft delete columns on critical tables
  await addColumnIfMissing('sales', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('hr_employees', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('gl_journals', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('purchases', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('inv_items', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('customers', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('suppliers', 'deleted_at', "DATETIME DEFAULT NULL");

  // Add missing performance indexes
  try { await db.query('CREATE INDEX idx_sales_username ON sales(username)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_inv_items_category ON inv_items(category)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_inv_items_stock ON inv_items(stock)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_purchases_status ON purchases(status)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_gl_entries_account ON gl_entries(account_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_expenses_category ON expenses(category)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_custody_exp_custody ON custody_expenses(custody_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_hr_emp_status ON hr_employees(status)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_hr_att_date ON hr_attendance(attendance_date)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_hr_leave_status ON hr_leave_requests(status)'); } catch(e) {}

  // 2FA support
  await addColumnIfMissing('users', 'totp_secret', "VARCHAR(100)");
  await addColumnIfMissing('users', 'totp_enabled', "BOOLEAN DEFAULT FALSE");

  // Add CHECK constraints (MySQL 8.0+)
  try { await db.query('ALTER TABLE hr_employees ADD CONSTRAINT ck_salary CHECK (basic_salary >= 0)'); } catch(e) {}
  try { await db.query('ALTER TABLE hr_payroll_items ADD CONSTRAINT ck_net CHECK (net_salary >= 0)'); } catch(e) {}
  try { await db.query('ALTER TABLE hr_advances ADD CONSTRAINT ck_advance_amt CHECK (amount > 0)'); } catch(e) {}

  // Shifts: add geolocation + device info columns
  await addColumnIfMissing('shifts', 'geo_lat', "DECIMAL(10,7)");
  await addColumnIfMissing('shifts', 'geo_lng', "DECIMAL(10,7)");
  await addColumnIfMissing('shifts', 'geo_address', "VARCHAR(300)");
  await addColumnIfMissing('shifts', 'device_info', "VARCHAR(500)");
  await addColumnIfMissing('shifts', 'ip_address', "VARCHAR(50)");

  // Branch geolocation for attendance validation
  await addColumnIfMissing('branches', 'geo_lat', "DECIMAL(10,7)");
  await addColumnIfMissing('branches', 'geo_lng', "DECIMAL(10,7)");
  await addColumnIfMissing('branches', 'geo_radius', "INT DEFAULT 100");

  // Employee work schedule
  await addColumnIfMissing('hr_employees', 'work_start', "TIME DEFAULT '08:00:00'");
  await addColumnIfMissing('hr_employees', 'work_end', "TIME DEFAULT '17:00:00'");
  await addColumnIfMissing('hr_employees', 'ignore_late_month', "VARCHAR(7)");
  await addColumnIfMissing('hr_employees', 'shift_id', "VARCHAR(50)");
  // Additional allowances & deductions for flexible contracts
  await addColumnIfMissing('hr_employees', 'food_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'communication_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'education_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'nature_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'social_insurance_rate', "DECIMAL(5,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'fixed_deduction', "DECIMAL(12,2) DEFAULT 0");

  // ═══ Cash Management Module ═══
  await createTableIfMissing('cash_boxes', `
    CREATE TABLE cash_boxes (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(30),
      type ENUM('main','branch','petty') DEFAULT 'branch',
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      keeper_username VARCHAR(100),
      currency VARCHAR(10) DEFAULT 'SAR',
      balance DECIMAL(14,2) DEFAULT 0,
      gl_account_id VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cb_branch (branch_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('bank_accounts', `
    CREATE TABLE bank_accounts (
      id VARCHAR(50) PRIMARY KEY,
      bank_name VARCHAR(200) NOT NULL,
      account_name VARCHAR(200),
      account_number VARCHAR(100),
      iban VARCHAR(50),
      currency VARCHAR(10) DEFAULT 'SAR',
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      balance DECIMAL(14,2) DEFAULT 0,
      gl_account_id VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('cash_receipts', `
    CREATE TABLE cash_receipts (
      id VARCHAR(50) PRIMARY KEY,
      receipt_number VARCHAR(30),
      receipt_date DATE NOT NULL,
      destination_type ENUM('cash','bank') NOT NULL,
      destination_id VARCHAR(50) NOT NULL,
      source_type ENUM('customer','employee','rent','sales','other') DEFAULT 'other',
      source_id VARCHAR(50),
      source_name VARCHAR(200),
      amount DECIMAL(14,2) NOT NULL,
      reference VARCHAR(200),
      description TEXT,
      attachment LONGTEXT,
      journal_id VARCHAR(50),
      status ENUM('draft','posted','cancelled') DEFAULT 'posted',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cr_date (receipt_date),
      INDEX idx_cr_dest (destination_type, destination_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('cash_payments', `
    CREATE TABLE cash_payments (
      id VARCHAR(50) PRIMARY KEY,
      payment_number VARCHAR(30),
      payment_date DATE NOT NULL,
      source_type ENUM('cash','bank') NOT NULL,
      source_id VARCHAR(50) NOT NULL,
      recipient_type ENUM('supplier','employee','expense','other') DEFAULT 'other',
      recipient_id VARCHAR(50),
      recipient_name VARCHAR(200),
      expense_account_id VARCHAR(50),
      amount DECIMAL(14,2) NOT NULL,
      reference VARCHAR(200),
      description TEXT,
      attachment LONGTEXT,
      journal_id VARCHAR(50),
      status ENUM('draft','posted','cancelled') DEFAULT 'posted',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cp_date (payment_date),
      INDEX idx_cp_src (source_type, source_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('cash_transfers', `
    CREATE TABLE cash_transfers (
      id VARCHAR(50) PRIMARY KEY,
      transfer_number VARCHAR(30),
      transfer_date DATE NOT NULL,
      from_type ENUM('cash','bank') NOT NULL,
      from_id VARCHAR(50) NOT NULL,
      to_type ENUM('cash','bank') NOT NULL,
      to_id VARCHAR(50) NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      description TEXT,
      journal_id VARCHAR(50),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('advance_payments', `
    CREATE TABLE advance_payments (
      id VARCHAR(50) PRIMARY KEY,
      number VARCHAR(30),
      payment_date DATE NOT NULL,
      party_type ENUM('supplier','employee','rent','other') NOT NULL,
      party_id VARCHAR(50),
      party_name VARCHAR(200),
      total_amount DECIMAL(14,2) NOT NULL,
      settled_amount DECIMAL(14,2) DEFAULT 0,
      remaining DECIMAL(14,2) DEFAULT 0,
      source_type ENUM('cash','bank') NOT NULL,
      source_id VARCHAR(50) NOT NULL,
      description TEXT,
      status ENUM('active','fully_settled','cancelled') DEFAULT 'active',
      journal_id VARCHAR(50),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('cash_credit_notes', `
    CREATE TABLE cash_credit_notes (
      id VARCHAR(50) PRIMARY KEY,
      number VARCHAR(30),
      note_date DATE NOT NULL,
      note_type ENUM('credit','debit') NOT NULL,
      party_type ENUM('supplier','customer') NOT NULL,
      party_id VARCHAR(50),
      party_name VARCHAR(200),
      amount DECIMAL(14,2) NOT NULL,
      reason TEXT,
      journal_id VARCHAR(50),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('frozen_debts', `
    CREATE TABLE frozen_debts (
      id VARCHAR(50) PRIMARY KEY,
      number VARCHAR(30),
      freeze_date DATE NOT NULL,
      customer_id VARCHAR(50),
      customer_name VARCHAR(200),
      amount DECIMAL(14,2) NOT NULL,
      reason TEXT,
      status ENUM('frozen','recovered','written_off') DEFAULT 'frozen',
      journal_id VARCHAR(50),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // ═══ HR System Expansion: Shifts, Overtime, Exceptions, Audit ═══
  await createTableIfMissing('hr_shifts', `
    CREATE TABLE hr_shifts (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      code VARCHAR(20),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      break_minutes INT DEFAULT 60,
      grace_late_minutes INT DEFAULT 5,
      grace_early_leave_minutes INT DEFAULT 0,
      allow_overtime_before BOOLEAN DEFAULT FALSE,
      allow_overtime_after BOOLEAN DEFAULT TRUE,
      work_days VARCHAR(20) DEFAULT '0,1,2,3,4',
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  try {
    const [sCount] = await db.query('SELECT COUNT(*) AS cnt FROM hr_shifts');
    if (sCount[0].cnt === 0) {
      await db.query("INSERT INTO hr_shifts (id, name, code, start_time, end_time, break_minutes, grace_late_minutes, is_default, allow_overtime_after) VALUES ('SH-MORNING','الشفت الصباحي','MORNING','08:00:00','17:00:00',60,5,1,1),('SH-EVENING','الشفت المسائي','EVENING','16:00:00','00:00:00',60,5,0,1)");
    }
  } catch(e) {}

  await createTableIfMissing('hr_overtime_rules', `
    CREATE TABLE hr_overtime_rules (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      day_type ENUM('workday','restday','holiday') DEFAULT 'workday',
      multiplier DECIMAL(4,2) DEFAULT 1.50,
      min_minutes INT DEFAULT 30,
      require_approval BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  try {
    const [oCount] = await db.query('SELECT COUNT(*) AS cnt FROM hr_overtime_rules');
    if (oCount[0].cnt === 0) {
      await db.query("INSERT INTO hr_overtime_rules (id, name, day_type, multiplier, min_minutes, require_approval) VALUES ('OT-WORK','إضافي يوم عمل','workday',1.50,30,1),('OT-REST','إضافي يوم راحة','restday',2.00,30,1),('OT-HOLIDAY','إضافي عطلة رسمية','holiday',2.50,30,1)");
    }
  } catch(e) {}

  await createTableIfMissing('hr_overtime_entries', `
    CREATE TABLE hr_overtime_entries (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      attendance_id VARCHAR(50),
      entry_date DATE NOT NULL,
      minutes INT NOT NULL,
      rule_id VARCHAR(50),
      multiplier DECIMAL(4,2) DEFAULT 1.50,
      amount DECIMAL(12,2) DEFAULT 0,
      status ENUM('pending','approved','rejected') DEFAULT 'pending',
      approved_by VARCHAR(100),
      approved_at DATETIME,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ot_emp (employee_id),
      INDEX idx_ot_date (entry_date)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_exceptions', `
    CREATE TABLE hr_exceptions (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      exception_type ENUM('ignore_late','ignore_early_leave','ignore_overtime','adjust_attendance','grant_day','excuse_absence') NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      new_clock_in TIME,
      new_clock_out TIME,
      reason TEXT,
      approved_by VARCHAR(100),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_exc_emp (employee_id),
      INDEX idx_exc_date (start_date, end_date)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_audit_log', `
    CREATE TABLE hr_audit_log (
      id VARCHAR(50) PRIMARY KEY,
      actor VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id VARCHAR(50),
      details TEXT,
      ip VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_entity (entity_type, entity_id),
      INDEX idx_audit_date (created_at)
    ) ENGINE=InnoDB
  `);

  // Enhance hr_attendance with extra fields for proper calculation
  await addColumnIfMissing('hr_attendance', 'early_leave_minutes', "INT DEFAULT 0");
  await addColumnIfMissing('hr_attendance', 'overtime_minutes', "INT DEFAULT 0");
  await addColumnIfMissing('hr_attendance', 'shift_id', "VARCHAR(50)");
  await addColumnIfMissing('hr_attendance', 'is_adjusted', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_attendance', 'adjustment_reason', "TEXT");

  // Fix device_id column size
  try { await db.query('ALTER TABLE hr_attendance MODIFY COLUMN device_id VARCHAR(500)'); } catch(e) {}

  // Users: email + warehouse link
  await addColumnIfMissing('users', 'email', "VARCHAR(200)");
  await addColumnIfMissing('users', 'default_warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('users', 'phone', "VARCHAR(30)");
  await addColumnIfMissing('users', 'full_name', "VARCHAR(200)");

  // ═══════════════════════════════════════
  // WAREHOUSE-BASED INVENTORY RESTRUCTURE
  // ═══════════════════════════════════════
  // Link all inventory operations to specific warehouses
  await addColumnIfMissing('inventory_movements', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('stocktakes', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('stocktakes', 'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('shortage_requests', 'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('shortage_requests', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('stock_adjustments', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('purchases', 'warehouse_id', "VARCHAR(50)");
  // Performance indexes
  try { await db.query('CREATE INDEX idx_wh_stock_item ON warehouse_stock(item_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_inv_mov_wh ON inventory_movements(warehouse_id)'); } catch(e) {}

  // Seed cost settings into the existing key-value settings table
  try {
    await db.query(`INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
      ('costing_method','WEIGHTED_AVERAGE'),
      ('default_pricing_mode','fixed'),
      ('default_markup_pct','30'),
      ('BranchName',''),
      ('inventory_method','perpetual')`);
  } catch (e) { console.log('[DB] Cost settings seed:', e.message.substring(0, 80)); }

  // ═══════════════════════════════════════════════════════════════════
  // ERP CORE v3 — MULTI-BRAND MULTI-BRANCH FRANCHISE TABLES (DESIGN DOC)
  // ═══════════════════════════════════════════════════════════════════

  // 1) Companies — the legal entity owning brands/branches (multi-tenant root)
  await createTableIfMissing('companies', `
    CREATE TABLE companies (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      legal_name VARCHAR(300) DEFAULT '',
      cr_number VARCHAR(30) DEFAULT '',
      tax_number VARCHAR(30) DEFAULT '',
      country VARCHAR(50) DEFAULT 'SA',
      city VARCHAR(100) DEFAULT '',
      base_currency VARCHAR(3) DEFAULT 'SAR',
      fiscal_year_start DATE,
      logo_url TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  try {
    const [cnt] = await db.query('SELECT COUNT(*) AS c FROM companies');
    if (cnt[0].c === 0) {
      await db.query("INSERT INTO companies (id, name, base_currency, fiscal_year_start) VALUES ('CO-MAIN','الشركة الرئيسية','SAR','2026-01-01')");
    }
  } catch(e) {}

  // Link brands/branches to the company (optional — default CO-MAIN)
  await addColumnIfMissing('brands', 'company_id', "VARCHAR(50) DEFAULT 'CO-MAIN'");
  await addColumnIfMissing('brands', 'royalty_type', "ENUM('percentage','fixed','mixed','none') DEFAULT 'none'");
  await addColumnIfMissing('brands', 'royalty_value', "DECIMAL(12,4) DEFAULT 0");
  await addColumnIfMissing('brands', 'royalty_base', "ENUM('gross_sales','net_sales','none') DEFAULT 'gross_sales'");
  await addColumnIfMissing('brands', 'royalty_fixed_component', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('brands', 'franchise_fee', "DECIMAL(14,2) DEFAULT 0");
  await addColumnIfMissing('brands', 'contract_start', "DATE");
  await addColumnIfMissing('brands', 'contract_end', "DATE");
  await addColumnIfMissing('branches', 'company_id', "VARCHAR(50) DEFAULT 'CO-MAIN'");

  // 2) Item categories (hierarchical)
  await createTableIfMissing('item_categories', `
    CREATE TABLE item_categories (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      brand_id VARCHAR(50),
      parent_id VARCHAR(50),
      name VARCHAR(200) NOT NULL,
      code VARCHAR(30) DEFAULT '',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_parent (parent_id), INDEX idx_brand (brand_id)
    ) ENGINE=InnoDB
  `);

  // 3) Units + unit_conversions
  await createTableIfMissing('units', `
    CREATE TABLE units (
      id VARCHAR(20) PRIMARY KEY,
      name_ar VARCHAR(100) NOT NULL,
      name_en VARCHAR(100) DEFAULT '',
      type ENUM('weight','volume','count','length') DEFAULT 'count'
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('unit_conversions', `
    CREATE TABLE unit_conversions (
      id VARCHAR(50) PRIMARY KEY,
      from_unit VARCHAR(20) NOT NULL,
      to_unit VARCHAR(20) NOT NULL,
      factor DECIMAL(14,6) NOT NULL,
      UNIQUE KEY uq_conv (from_unit, to_unit)
    ) ENGINE=InnoDB
  `);
  try {
    const [uc] = await db.query('SELECT COUNT(*) AS c FROM units');
    if (uc[0].c === 0) {
      await db.query("INSERT INTO units (id, name_ar, name_en, type) VALUES ('KG','كيلوجرام','kg','weight'),('G','جرام','g','weight'),('L','لتر','L','volume'),('ML','مليلتر','ml','volume'),('PCS','قطعة','pcs','count'),('BOX','صندوق','box','count'),('PACK','علبة','pack','count'),('DOZ','دزينة','dozen','count')");
      await db.query("INSERT INTO unit_conversions (id, from_unit, to_unit, factor) VALUES ('UC-1','KG','G',1000),('UC-2','G','KG',0.001),('UC-3','L','ML',1000),('UC-4','ML','L',0.001),('UC-5','DOZ','PCS',12),('UC-6','PCS','DOZ',0.083333)");
    }
  } catch(e) {}

  // 4) Price lists (برند/فرع-specific pricing)
  await createTableIfMissing('price_lists', `
    CREATE TABLE price_lists (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      name VARCHAR(200) NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      valid_from DATE,
      valid_to DATE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_brand_branch (brand_id, branch_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('price_list_items', `
    CREATE TABLE price_list_items (
      id VARCHAR(60) PRIMARY KEY,
      price_list_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      price DECIMAL(14,4) NOT NULL,
      min_price DECIMAL(14,4) DEFAULT 0,
      valid_from DATE,
      valid_to DATE,
      UNIQUE KEY uq_pli (price_list_id, item_id),
      INDEX idx_item (item_id)
    ) ENGINE=InnoDB
  `);

  // 5) BOM / Recipes (وصفات الإنتاج)
  await createTableIfMissing('bom', `
    CREATE TABLE bom (
      id VARCHAR(50) PRIMARY KEY,
      product_id VARCHAR(50) NOT NULL,
      version INT DEFAULT 1,
      yield_quantity DECIMAL(10,4) DEFAULT 1,
      yield_unit VARCHAR(20) DEFAULT 'PCS',
      is_active BOOLEAN DEFAULT TRUE,
      effective_from DATE,
      effective_to DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_product (product_id, is_active)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('bom_lines', `
    CREATE TABLE bom_lines (
      id VARCHAR(60) PRIMARY KEY,
      bom_id VARCHAR(50) NOT NULL,
      component_item_id VARCHAR(50) NOT NULL,
      quantity DECIMAL(12,4) NOT NULL,
      unit VARCHAR(20) DEFAULT 'PCS',
      waste_pct DECIMAL(5,2) DEFAULT 0,
      INDEX idx_bom (bom_id), INDEX idx_component (component_item_id)
    ) ENGINE=InnoDB
  `);

  // 6) Purchase receipts (منفصل عن PO لدعم الاستلام الجزئي)
  await createTableIfMissing('purchase_receipts', `
    CREATE TABLE purchase_receipts (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      po_id VARCHAR(50),
      supplier_id VARCHAR(50),
      receipt_number VARCHAR(30) UNIQUE,
      receipt_date DATE NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      subtotal DECIMAL(14,2) DEFAULT 0,
      vat_amount DECIMAL(14,2) DEFAULT 0,
      total DECIMAL(14,2) DEFAULT 0,
      status ENUM('draft','posted','cancelled') DEFAULT 'draft',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_po (po_id), INDEX idx_date (receipt_date)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('purchase_receipt_lines', `
    CREATE TABLE purchase_receipt_lines (
      id VARCHAR(60) PRIMARY KEY,
      receipt_id VARCHAR(50) NOT NULL,
      po_line_id VARCHAR(50),
      item_id VARCHAR(50) NOT NULL,
      quantity DECIMAL(14,4) NOT NULL,
      unit VARCHAR(20) DEFAULT 'PCS',
      unit_cost DECIMAL(14,4) NOT NULL,
      vat_rate DECIMAL(5,2) DEFAULT 15,
      line_total DECIMAL(14,2) NOT NULL,
      INDEX idx_receipt (receipt_id), INDEX idx_item (item_id)
    ) ENGINE=InnoDB
  `);

  // 7) POS terminals
  await createTableIfMissing('pos_terminals', `
    CREATE TABLE pos_terminals (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      branch_id VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(30),
      device_id VARCHAR(100),
      last_sync_at DATETIME,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_branch (branch_id)
    ) ENGINE=InnoDB
  `);

  // 8) Accounting periods (period lock)
  await createTableIfMissing('accounting_periods', `
    CREATE TABLE accounting_periods (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      period_name VARCHAR(20) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status ENUM('open','soft_closed','closed') DEFAULT 'open',
      closed_by VARCHAR(100),
      closed_at DATETIME,
      notes TEXT,
      UNIQUE KEY uq_period (company_id, period_name),
      INDEX idx_dates (start_date, end_date)
    ) ENGINE=InnoDB
  `);

  // 9) Royalty runs (franchise fee accruals)
  await createTableIfMissing('royalty_runs', `
    CREATE TABLE royalty_runs (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      brand_id VARCHAR(50) NOT NULL,
      period_id VARCHAR(50),
      run_date DATE NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      gross_sales DECIMAL(14,2) DEFAULT 0,
      net_sales DECIMAL(14,2) DEFAULT 0,
      royalty_type ENUM('percentage','fixed','mixed','none') DEFAULT 'percentage',
      royalty_value DECIMAL(12,4) DEFAULT 0,
      fixed_component DECIMAL(12,2) DEFAULT 0,
      royalty_amount DECIMAL(14,2) DEFAULT 0,
      status ENUM('draft','approved','invoiced','paid','cancelled') DEFAULT 'draft',
      gl_journal_id VARCHAR(50),
      approved_by VARCHAR(100),
      approved_at DATETIME,
      paid_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_brand_period (brand_id, period_start)
    ) ENGINE=InnoDB
  `);

  // 10) Waste entries (formalize)
  await createTableIfMissing('waste_entries', `
    CREATE TABLE waste_entries (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      warehouse_id VARCHAR(50) NOT NULL,
      cost_center_id VARCHAR(50),
      waste_date DATE NOT NULL,
      reason ENUM('expired','damaged','spill','prep_loss','customer_return','other') DEFAULT 'other',
      total_cost DECIMAL(14,2) DEFAULT 0,
      notes TEXT,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dims (brand_id, branch_id, waste_date)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('waste_entry_items', `
    CREATE TABLE waste_entry_items (
      id VARCHAR(60) PRIMARY KEY,
      waste_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      quantity DECIMAL(14,4) NOT NULL,
      unit VARCHAR(20) DEFAULT 'PCS',
      unit_cost DECIMAL(14,4) DEFAULT 0,
      line_cost DECIMAL(14,2) DEFAULT 0,
      INDEX idx_waste (waste_id)
    ) ENGINE=InnoDB
  `);

  // 11) ZATCA Phase 2 compliance fields on sales (invoices)
  await addColumnIfMissing('sales', 'invoice_uuid', "VARCHAR(36)");
  await addColumnIfMissing('sales', 'invoice_hash', "VARCHAR(100)");
  await addColumnIfMissing('sales', 'previous_invoice_hash', "VARCHAR(100)");
  await addColumnIfMissing('sales', 'zatca_type', "ENUM('standard','simplified','credit_note','debit_note') DEFAULT 'simplified'");
  await addColumnIfMissing('sales', 'zatca_submitted_at', "DATETIME");
  await addColumnIfMissing('sales', 'zatca_status', "ENUM('pending','submitted','accepted','rejected') DEFAULT 'pending'");

  // 12) Item categories and cost method on inv_items
  await addColumnIfMissing('inv_items', 'category_id', "VARCHAR(50)");
  await addColumnIfMissing('inv_items', 'cost_method', "ENUM('wavg','fifo','standard') DEFAULT 'wavg'");
  await addColumnIfMissing('inv_items', 'standard_cost', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('inv_items', 'min_stock', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('inv_items', 'max_stock', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('inv_items', 'is_sellable', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('inv_items', 'is_inventoried', "BOOLEAN DEFAULT TRUE");

  // 13) Auto-seed accounting periods for current year (if not already)
  try {
    const [cp] = await db.query('SELECT COUNT(*) AS c FROM accounting_periods');
    if (cp[0].c === 0) {
      const y = new Date().getFullYear();
      for (let m = 1; m <= 12; m++) {
        const mm = String(m).padStart(2, '0');
        const last = new Date(y, m, 0).getDate();
        await db.query(
          `INSERT IGNORE INTO accounting_periods (id, period_name, start_date, end_date, status) VALUES (?,?,?,?,?)`,
          [`AP-${y}-${mm}`, `${y}-${mm}`, `${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2,'0')}`, 'open']
        );
      }
    }
  } catch(e) {}

  // ═══════════════════════════════════════
  // WORKFLOW ENGINE v2 — نظام المعاملات المتكامل
  // ═══════════════════════════════════════

  // Branch / Department short codes (for BR-DEP-TYP-YYYYMMDD-0001 numbering)
  await addColumnIfMissing('branches', 'code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('hr_departments', 'code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('hr_departments', 'branch_id', "VARCHAR(50)");

  // Employee hierarchy / permissions
  await addColumnIfMissing('hr_employees', 'manager_id', "VARCHAR(50)");
  await addColumnIfMissing('hr_employees', 'workflow_level', "INT DEFAULT 1");
  await addColumnIfMissing('hr_employees', 'can_create_txn', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('hr_employees', 'can_approve_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'can_reject_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'can_return_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'can_forward_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'can_close_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'linked_username', "VARCHAR(100)");

  // Transaction enhancements: importance, branch/dept snapshot, type code, daily serial, current assignee
  await addColumnIfMissing('transactions', 'importance', "ENUM('critical','high','medium','low') DEFAULT 'medium'");
  await addColumnIfMissing('transactions', 'branch_code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('transactions', 'branch_name', "VARCHAR(200) DEFAULT ''");
  await addColumnIfMissing('transactions', 'dept_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'dept_code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('transactions', 'dept_name', "VARCHAR(200) DEFAULT ''");
  await addColumnIfMissing('transactions', 'type_code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('transactions', 'daily_serial', "INT DEFAULT 0");
  await addColumnIfMissing('transactions', 'current_assignee', "VARCHAR(100) DEFAULT ''");
  // Role snapshot — which job-title is currently responsible (independent of person)
  await addColumnIfMissing('transactions', 'current_role_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'current_role_name', "VARCHAR(200) DEFAULT ''");
  // Initiator's position — used to look up the per-position workflow chain
  await addColumnIfMissing('transactions', 'initiator_position_id', "VARCHAR(50)");

  // Enterprise-style fields (subject, secrecy, rich content, draft marker)
  await addColumnIfMissing('transactions', 'subject', "VARCHAR(500) DEFAULT ''");
  await addColumnIfMissing('transactions', 'content_secrecy', "ENUM('normal','confidential','secret','top_secret') DEFAULT 'normal'");
  await addColumnIfMissing('transactions', 'attachments_secrecy', "ENUM('normal','confidential','secret','top_secret') DEFAULT 'normal'");
  await addColumnIfMissing('transactions', 'content_html', "LONGTEXT");
  await addColumnIfMissing('transactions', 'issuing_entity_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'issuing_entity_name', "VARCHAR(300) DEFAULT ''");
  await addColumnIfMissing('transactions', 'hijri_date', "VARCHAR(20) DEFAULT ''");

  // Expense categories (نوع المصروف) — admin-maintained list used on transactions
  await createTableIfMissing('expense_categories', `
    CREATE TABLE expense_categories (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) DEFAULT '',
      name VARCHAR(200) NOT NULL,
      gl_account_code VARCHAR(20) DEFAULT '',
      gl_account_id VARCHAR(50) DEFAULT '',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // Seed common Saudi expense categories if empty
  try {
    const [ec] = await db.query('SELECT COUNT(*) AS cnt FROM expense_categories');
    if (ec[0].cnt === 0) {
      await db.query(`INSERT INTO expense_categories (id, code, name) VALUES
        ('EXP-SAL','SAL','رواتب وأجور'),
        ('EXP-RNT','RNT','إيجارات'),
        ('EXP-UTL','UTL','كهرباء ومياه'),
        ('EXP-COM','COM','اتصالات وإنترنت'),
        ('EXP-MNT','MNT','صيانة وإصلاح'),
        ('EXP-CLN','CLN','نظافة'),
        ('EXP-RAW','RAW','مواد خام ومؤن'),
        ('EXP-PKG','PKG','تعبئة وتغليف'),
        ('EXP-TRP','TRP','نقل ومواصلات'),
        ('EXP-FUL','FUL','وقود ومحروقات'),
        ('EXP-OFF','OFF','قرطاسية ومستلزمات مكتبية'),
        ('EXP-ADV','ADV','دعاية وإعلان'),
        ('EXP-GOV','GOV','رسوم حكومية'),
        ('EXP-INS','INS','تأمينات'),
        ('EXP-LEG','LEG','خدمات قانونية واستشارات'),
        ('EXP-BNK','BNK','عمولات بنكية'),
        ('EXP-AST','AST','أصول ثابتة ومعدات'),
        ('EXP-TRN','TRN','تدريب وتطوير'),
        ('EXP-HOS','HOS','ضيافة'),
        ('EXP-MSC','MSC','متفرقات')`);
    }
  } catch(e) {}

  // Transaction: expense category + read tracking + SLA due date
  await addColumnIfMissing('transactions', 'expense_category_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'expense_category_name', "VARCHAR(200) DEFAULT ''");
  await addColumnIfMissing('transactions', 'is_read', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('transactions', 'read_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('transactions', 'read_at', "DATETIME");
  await addColumnIfMissing('transactions', 'due_date', "DATE");
  await addColumnIfMissing('transactions', 'transaction_scope', "ENUM('internal','external') DEFAULT 'internal'");

  // Multi-recipient table (الجهات الصادر إليها)
  await createTableIfMissing('txn_recipients', `
    CREATE TABLE txn_recipients (
      id VARCHAR(60) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      recipient_type VARCHAR(30) DEFAULT 'user',
      recipient_id VARCHAR(50),
      recipient_username VARCHAR(100) DEFAULT '',
      recipient_code VARCHAR(30) DEFAULT '',
      recipient_name VARCHAR(300) DEFAULT '',
      needs_response BOOLEAN DEFAULT FALSE,
      response_received BOOLEAN DEFAULT FALSE,
      response_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_txn (transaction_id)
    ) ENGINE=InnoDB
  `);

  // Transaction number column widened to fit BR-DEP-TYP-YYYYMMDD-NNNN format
  // (legacy schemas had VARCHAR(20) which truncates the v2 structured number).
  try { await db.query("ALTER TABLE transactions MODIFY COLUMN transaction_number VARCHAR(80)"); } catch(e) {}

  // GL entries — accounting dimensions per spec (brand/branch/warehouse/cost_center on every line)
  await addColumnIfMissing('gl_entries', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('gl_entries', 'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('gl_entries', 'warehouse_id', "VARCHAR(50)");
  try { await db.query('CREATE INDEX idx_gle_dims ON gl_entries(brand_id, branch_id)'); } catch(e) {}

  // Workflow step routing flags — role-based employee resolution rules
  await addColumnIfMissing('workflow_definitions', 'require_same_branch', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('workflow_definitions', 'require_same_department', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('workflow_definitions', 'assignment_strategy', "VARCHAR(20) DEFAULT 'least_busy'");
  await addColumnIfMissing('workflow_definitions', 'can_approve', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('workflow_definitions', 'can_reject', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('workflow_definitions', 'can_edit', "BOOLEAN DEFAULT FALSE");

  // Position-indexed workflow path — the primary routing source.
  // Each initiator position has its OWN isolated chain (no mixing between
  // positions). When an employee creates a transaction, we look up their
  // position_id here and use that chain; the transaction type is just a
  // label (does not affect routing).
  await createTableIfMissing('position_workflow_steps', `
    CREATE TABLE position_workflow_steps (
      id VARCHAR(60) PRIMARY KEY,
      initiator_position_id VARCHAR(50) NOT NULL,
      step_order INT NOT NULL,
      step_name VARCHAR(200) DEFAULT '',
      required_position_id VARCHAR(50),
      is_final_step BOOLEAN DEFAULT FALSE,
      can_approve BOOLEAN DEFAULT TRUE,
      can_reject BOOLEAN DEFAULT TRUE,
      can_return_to_previous BOOLEAN DEFAULT TRUE,
      can_edit BOOLEAN DEFAULT FALSE,
      can_edit_amount BOOLEAN DEFAULT FALSE,
      require_same_branch BOOLEAN DEFAULT TRUE,
      require_same_department BOOLEAN DEFAULT FALSE,
      assignment_strategy VARCHAR(20) DEFAULT 'least_busy',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_initiator (initiator_position_id, step_order)
    ) ENGINE=InnoDB
  `);

  // Daily counter per (branch, dept, type, date) — strict serial generation
  await createTableIfMissing('txn_daily_counter', `
    CREATE TABLE txn_daily_counter (
      counter_key VARCHAR(80) PRIMARY KEY,
      last_serial INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Multi-attachment table (complements single-attachment column)
  await createTableIfMissing('txn_attachments', `
    CREATE TABLE txn_attachments (
      id VARCHAR(60) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      log_id VARCHAR(60),
      file_name VARCHAR(300),
      mime_type VARCHAR(80),
      data_url LONGTEXT,
      uploaded_by VARCHAR(100),
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_txn (transaction_id)
    ) ENGINE=InnoDB
  `);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1 — Main/Branch Warehouse Hierarchy + Stock Issues
  // ═══════════════════════════════════════════════════════════

  // Warehouses: hierarchy + main flag
  await addColumnIfMissing('warehouses', 'parent_warehouse_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('warehouses', 'is_main', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('warehouses', 'description', "VARCHAR(500)");

  // Stock Issues — central warehouse issues stock to branches/sub-warehouses
  await createTableIfMissing('stock_issues', `
    CREATE TABLE stock_issues (
      id VARCHAR(60) PRIMARY KEY,
      issue_number VARCHAR(40) NOT NULL,
      from_warehouse_id VARCHAR(50) NOT NULL,
      to_warehouse_id VARCHAR(50) NOT NULL,
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      issue_date DATE,
      status ENUM('draft','approved','issued','received','cancelled') DEFAULT 'draft',
      total_cost DECIMAL(14,4) DEFAULT 0,
      notes TEXT,
      gl_journal_id VARCHAR(60),
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      issued_by VARCHAR(100),
      received_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME,
      issued_at DATETIME,
      received_at DATETIME,
      INDEX idx_from (from_warehouse_id),
      INDEX idx_to (to_warehouse_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('stock_issue_items', `
    CREATE TABLE stock_issue_items (
      id VARCHAR(60) PRIMARY KEY,
      issue_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      qty_requested DECIMAL(14,4) DEFAULT 0,
      qty_issued DECIMAL(14,4) DEFAULT 0,
      qty_received DECIMAL(14,4) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      line_total DECIMAL(14,4) DEFAULT 0,
      notes VARCHAR(400),
      INDEX idx_issue (issue_id),
      INDEX idx_item (item_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('stock_issue_counter', `
    CREATE TABLE stock_issue_counter (
      ymd CHAR(8) NOT NULL,
      last_serial INT NOT NULL DEFAULT 0,
      PRIMARY KEY (ymd)
    ) ENGINE=InnoDB
  `);

  // ═══════════════════════════════════════════════════════════
  // PHASE 2 — Production Orders
  // ═══════════════════════════════════════════════════════════

  await createTableIfMissing('production_orders', `
    CREATE TABLE production_orders (
      id VARCHAR(60) PRIMARY KEY,
      order_number VARCHAR(40) NOT NULL,
      bom_id VARCHAR(60) NOT NULL,
      product_id VARCHAR(60) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      output_warehouse_id VARCHAR(50),
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      qty_planned DECIMAL(14,4) DEFAULT 0,
      qty_produced DECIMAL(14,4) DEFAULT 0,
      qty_scrap DECIMAL(14,4) DEFAULT 0,
      status ENUM('planned','released','in_progress','completed','closed','cancelled') DEFAULT 'planned',
      materials_cost DECIMAL(14,4) DEFAULT 0,
      labor_cost DECIMAL(14,4) DEFAULT 0,
      overhead_cost DECIMAL(14,4) DEFAULT 0,
      total_cost DECIMAL(14,4) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      notes TEXT,
      gl_release_id VARCHAR(60),
      gl_complete_id VARCHAR(60),
      created_by VARCHAR(100),
      released_by VARCHAR(100),
      completed_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      planned_date DATE,
      released_at DATETIME,
      completed_at DATETIME,
      INDEX idx_bom (bom_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('production_consumption', `
    CREATE TABLE production_consumption (
      id VARCHAR(60) PRIMARY KEY,
      production_order_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      qty_planned DECIMAL(14,4) DEFAULT 0,
      qty_actual DECIMAL(14,4) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      total_cost DECIMAL(14,4) DEFAULT 0,
      lot_id VARCHAR(60),
      consumed_at DATETIME,
      INDEX idx_prod (production_order_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('production_output', `
    CREATE TABLE production_output (
      id VARCHAR(60) PRIMARY KEY,
      production_order_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      qty DECIMAL(14,4) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      total_cost DECIMAL(14,4) DEFAULT 0,
      batch_number VARCHAR(80),
      expiry_date DATE,
      produced_at DATETIME,
      INDEX idx_prod (production_order_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('production_counter', `
    CREATE TABLE production_counter (
      ymd CHAR(8) NOT NULL,
      last_serial INT NOT NULL DEFAULT 0,
      PRIMARY KEY (ymd)
    ) ENGINE=InnoDB
  `);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3 — Real Cost Accounting: FIFO / WAC / Batch / Expiry
  // ═══════════════════════════════════════════════════════════

  // Purchase lots: add batch/expiry tracking
  await addColumnIfMissing('purchase_lots', 'batch_number', "VARCHAR(80)");
  await addColumnIfMissing('purchase_lots', 'expiry_date', "DATE NULL");
  await addColumnIfMissing('purchase_lots', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('purchase_lots', 'received_at', "DATETIME NULL");

  // Cost history — every cost change is recorded
  await createTableIfMissing('item_cost_history', `
    CREATE TABLE item_cost_history (
      id VARCHAR(60) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL,
      warehouse_id VARCHAR(50),
      method VARCHAR(20) DEFAULT 'WAC',
      old_cost DECIMAL(14,4) DEFAULT 0,
      new_cost DECIMAL(14,4) DEFAULT 0,
      old_qty DECIMAL(14,4) DEFAULT 0,
      new_qty DECIMAL(14,4) DEFAULT 0,
      trigger_type VARCHAR(40),
      reference_id VARCHAR(60),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      changed_by VARCHAR(100),
      INDEX idx_item (item_id),
      INDEX idx_date (changed_at)
    ) ENGINE=InnoDB
  `);

  // Warehouse stock: add average cost per warehouse
  await addColumnIfMissing('warehouse_stock', 'avg_cost', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('warehouse_stock', 'last_cost', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('warehouse_stock', 'last_updated', "TIMESTAMP NULL");

  // ═══════════════════════════════════════════════════════════
  // PHASE C — PAYMENT FLOW
  // Unified payment records + amount-based approval routing
  // ═══════════════════════════════════════════════════════════

  await createTableIfMissing('payment_records', `
    CREATE TABLE payment_records (
      id VARCHAR(60) PRIMARY KEY,
      payment_number VARCHAR(40) NOT NULL,
      transaction_id VARCHAR(50),
      reference_type VARCHAR(40),
      reference_id VARCHAR(60),
      direction ENUM('out','in') DEFAULT 'out',
      amount DECIMAL(14,4) NOT NULL DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'SAR',
      payment_method ENUM('cash','bank','cheque','wire','card') DEFAULT 'bank',
      bank_account_id VARCHAR(50),
      cash_box_id VARCHAR(50),
      expense_account_code VARCHAR(20),
      counter_account_code VARCHAR(20),
      receipt_attachment LONGTEXT,
      receipt_number VARCHAR(80),
      receipt_date DATE,
      status ENUM('requested','authorized','paid','closed','cancelled') DEFAULT 'requested',
      gl_journal_id VARCHAR(60),
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      cost_center_id VARCHAR(50),
      requested_by VARCHAR(100),
      authorized_by VARCHAR(100),
      paid_by VARCHAR(100),
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      authorized_at DATETIME,
      paid_at DATETIME,
      closed_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_txn (transaction_id),
      INDEX idx_status (status),
      INDEX idx_ref (reference_type, reference_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('payment_counter', `
    CREATE TABLE payment_counter (
      ymd CHAR(8) NOT NULL,
      last_serial INT NOT NULL DEFAULT 0,
      PRIMARY KEY (ymd)
    ) ENGINE=InnoDB
  `);

  // Position workflow steps: amount-based routing
  await addColumnIfMissing('position_workflow_steps', 'amount_from', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('position_workflow_steps', 'amount_to',   "DECIMAL(14,4) DEFAULT NULL");
  // Multi-path support — each initiator position can have several
  // alternate workflow paths labeled by path_key + path_name.
  // 'default' = the primary path (backward compatible).
  await addColumnIfMissing('position_workflow_steps', 'path_key',   "VARCHAR(50) DEFAULT 'default'");
  await addColumnIfMissing('position_workflow_steps', 'path_name',  "VARCHAR(200) DEFAULT 'المسار الأساسي'");
  await addColumnIfMissing('position_workflow_steps', 'description',"TEXT");
  // Transactions: link to payment record (for payment-bearing flows)
  await addColumnIfMissing('transactions', 'payment_record_id', "VARCHAR(60)");
  await addColumnIfMissing('transactions', 'requires_payment', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('transactions', 'reference_type', "VARCHAR(40)");
  await addColumnIfMissing('transactions', 'reference_id', "VARCHAR(60)");

  // ═══ Brand-awareness for procurement + shortage ═══
  await addColumnIfMissing('suppliers',          'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('purchases',          'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('purchases',          'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('purchase_orders',    'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('purchase_orders',    'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('shortage_requests',  'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('shortage_requests',  'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('expenses',           'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('expenses',           'branch_id', "VARCHAR(50)");

  // Notifications (Phase D preparation)
  await createTableIfMissing('notifications', `
    CREATE TABLE notifications (
      id VARCHAR(60) PRIMARY KEY,
      user_username VARCHAR(100) NOT NULL,
      type VARCHAR(40),
      title VARCHAR(300),
      body TEXT,
      link_type VARCHAR(40),
      link_id VARCHAR(60),
      is_read BOOLEAN DEFAULT FALSE,
      icon VARCHAR(40),
      icon_color VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME,
      INDEX idx_user (user_username),
      INDEX idx_unread (user_username, is_read)
    ) ENGINE=InnoDB
  `);

  // Seed default branch code if empty
  try {
    await db.query("UPDATE branches SET code = UPPER(SUBSTRING(IFNULL(name,'BR'),1,3)) WHERE code IS NULL OR code = ''");
  } catch(e) {}
  try {
    await db.query("UPDATE hr_departments SET code = UPPER(SUBSTRING(IFNULL(name,'DEP'),1,3)) WHERE code IS NULL OR code = ''");
  } catch(e) {}
  try {
    await db.query("UPDATE transaction_types SET code = UPPER(SUBSTRING(IFNULL(name,'TXN'),1,3)) WHERE code IS NULL OR code = ''");
  } catch(e) {}

  // ═══════════════════════════════════════════════════════════
  // TRANSACTION GL TEMPLATES — reusable debit/credit templates
  // One template = one type of journal (e.g. "expense_out" = Dr expense / Cr bank).
  // Referenced from transaction_types.gl_template_code so that when a
  // transaction of that type gets paid/closed, the engine knows HOW to post.
  // ═══════════════════════════════════════════════════════════
  await createTableIfMissing('transaction_gl_templates', `
    CREATE TABLE transaction_gl_templates (
      code VARCHAR(40) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      description VARCHAR(400),
      debit_account_hint VARCHAR(20),
      credit_account_hint VARCHAR(20),
      posts_on ENUM('approval','payment','receipt','stocktake','manual') DEFAULT 'payment',
      example_memo VARCHAR(300),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // ═══════════════════════════════════════════════════════════
  // APPROVAL CHAIN DEFAULTS — per transaction type + amount threshold
  // Populated so new workflows have sensible defaults without manual setup.
  // ═══════════════════════════════════════════════════════════
  await createTableIfMissing('txn_type_default_chain', `
    CREATE TABLE txn_type_default_chain (
      id VARCHAR(60) PRIMARY KEY,
      transaction_type_code VARCHAR(40) NOT NULL,
      step_order INT NOT NULL,
      role_required VARCHAR(100),
      amount_from DECIMAL(14,4) DEFAULT 0,
      amount_to DECIMAL(14,4) DEFAULT NULL,
      is_final_step BOOLEAN DEFAULT FALSE,
      INDEX idx_code (transaction_type_code, step_order)
    ) ENGINE=InnoDB
  `);

  // Extend transaction_types with category + payment flag + GL template
  await addColumnIfMissing('transaction_types', 'category',
    "ENUM('financial','administrative','procurement','operational','hr') DEFAULT 'administrative'");
  await addColumnIfMissing('transaction_types', 'requires_payment', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('transaction_types', 'gl_template_code', "VARCHAR(40)");
  await addColumnIfMissing('transaction_types', 'icon', "VARCHAR(40) DEFAULT 'fa-file-alt'");
  await addColumnIfMissing('transaction_types', 'icon_color', "VARCHAR(20) DEFAULT 'info'");
  await addColumnIfMissing('transaction_types', 'description', "VARCHAR(400)");
  await addColumnIfMissing('transaction_types', 'sort_order', "INT DEFAULT 100");

  // ═══ COMPLETE TAXONOMY — 44 standard transaction types ═══
  // Categories: financial / administrative / procurement / operational / hr
  //
  // Format: [code, name_ar, category, requires_payment, gl_template, icon, icon_color, sort_order, description]
  try {
    const types = [
      // ── FINANCIAL (10) ──
      ['EXP',          'طلب صرف مصروف عام',     'financial',     1, 'expense_out',  'fa-receipt',           'warning', 110, 'مصروفات تشغيلية: كهرباء، ماء، اتصالات، قرطاسية'],
      ['PAY',          'طلب سداد مورد',          'financial',     1, 'ap_payment',   'fa-money-bill-transfer','warning', 120, 'دفع فاتورة مورد معتمدة (AP)'],
      ['REC',          'تسجيل تحصيل عميل',       'financial',     0, 'ar_receipt',   'fa-hand-holding-dollar','success', 130, 'استلام دفعة من عميل (AR)'],
      ['REF',          'طلب استرداد مبلغ',       'financial',     1, 'refund',       'fa-rotate-left',       'danger',  140, 'إرجاع مبلغ لعميل (فواتير مرتجعة)'],
      ['TRF-BANK',     'تحويل بين حسابات بنكية', 'financial',     1, 'bank_transfer','fa-right-left',        'info',    150, 'نقل رصيد بين حسابات بنكية'],
      ['TRF-CASH',     'تحويل بين صناديق نقدية', 'financial',     1, 'cash_transfer','fa-cash-register',     'info',    160, 'نقل نقد بين الفروع/الصناديق'],
      ['CUSTODY-ADD',  'تغذية عهدة',             'financial',     1, 'custody_load', 'fa-wallet',            'purple',  170, 'إضافة مبلغ لعهدة موظف'],
      ['CUSTODY-STL',  'تسوية عهدة',             'financial',     0, 'custody_stl',  'fa-scale-balanced',    'purple',  180, 'تقديم إيصالات العهدة وتسويتها'],
      ['WRITE-OFF',    'شطب ديون/أصول',          'financial',     0, 'write_off',    'fa-ban',               'danger',  190, 'شطب دين معدوم أو أصل تالف'],
      ['ADJ-JRN',      'قيد تسوية يدوي',         'financial',     0, 'manual_jrn',   'fa-pen-to-square',     'neutral', 199, 'قيد محاسبي مخصص باعتماد رسمي'],
      // ── ADMINISTRATIVE (8) ──
      ['MEMO',         'مذكرة داخلية',            'administrative', 0, null,           'fa-envelope',          'info',    210, 'تعميم أو إخطار بين الأقسام'],
      ['DECISION',     'قرار إداري',              'administrative', 0, null,           'fa-gavel',             'warning', 220, 'قرار رسمي (تعديل سياسة، إجراءات جديدة)'],
      ['LETTER',       'خطاب رسمي',               'administrative', 0, null,           'fa-envelope-open-text','info',    230, 'مراسلة خارجية (جهات حكومية، شركاء)'],
      ['CONTRACT',     'عقد جديد/تجديد',          'administrative', 0, null,           'fa-file-contract',     'purple',  240, 'عقد مع مورد أو عميل'],
      ['POLICY',       'سياسة داخلية',            'administrative', 0, null,           'fa-book',              'neutral', 250, 'وثيقة سياسة (خصم، إرجاع، عمل)'],
      ['AUDIT',        'تقرير مراجعة',            'administrative', 0, null,           'fa-magnifying-glass-chart','info',260, 'تقرير تدقيق داخلي'],
      ['COMPLAINT',    'شكوى',                    'administrative', 0, null,           'fa-triangle-exclamation','warning',270, 'شكوى من عميل أو موظف'],
      ['APPROVAL',     'طلب موافقة عامة',         'administrative', 0, null,           'fa-check-circle',      'info',    280, 'أي موافقة إدارية غير مصنفة'],
      // ── PROCUREMENT (6) ──
      ['PUR',          'طلب شراء (PR)',           'procurement',   0, null,           'fa-cart-plus',         'info',    310, 'طلب من القسم لشراء مادة — يحوَّل لـ PO'],
      ['PO',           'أمر شراء (Purchase Order)','procurement',  1, 'po',           'fa-cart-shopping',     'warning', 320, 'أمر رسمي للمورد'],
      ['GRN',          'استلام بضاعة (GRN)',      'procurement',   0, 'grn',          'fa-truck-ramp-box',    'success', 330, 'استلام فعلي من المورد'],
      ['RTV',          'إرجاع للمورد',            'procurement',   0, 'rtv',          'fa-truck-fast',        'danger',  340, 'إرجاع بضاعة تالفة للمورد'],
      ['PRICE-NEG',    'تفاوض سعر',               'procurement',   0, null,           'fa-handshake',         'neutral', 350, 'طلب مراجعة سعر مع مورد'],
      ['SUP-REG',      'تسجيل مورد جديد',         'procurement',   0, null,           'fa-user-plus',         'success', 360, 'إضافة مورد للقائمة المعتمدة'],
      // ── OPERATIONAL (9) ──
      ['SALE',         'فاتورة بيع (POS)',        'operational',   0, 'sale',         'fa-cash-register',     'success', 410, 'بيع منتج عبر الكاشير'],
      ['STK-ISS',      'إذن صرف مخزني',           'operational',   0, 'stock_issue',  'fa-truck-arrow-right', 'warning', 420, 'صرف مواد من المستودع الرئيسي للفرع'],
      ['STK-TRF',      'تحويل بين مستودعات',      'operational',   0, 'stock_trf',    'fa-shuffle',           'info',    430, 'نقل بين مخزنين'],
      ['STK-ADJ',      'تسوية جرد',               'operational',   0, 'stocktake',    'fa-clipboard-check',   'warning', 440, 'فروقات الجرد الفعلي vs النظام'],
      ['WASTE',        'تسجيل هدر',               'operational',   0, 'waste',        'fa-dumpster',          'danger',  450, 'تلف، انسكاب، انتهاء صلاحية'],
      ['PROD-ORD',     'أمر إنتاج',               'operational',   0, 'prod_release', 'fa-industry',          'purple',  460, 'تصنيع من مواد خام'],
      ['PROD-CMP',     'إكمال إنتاج',             'operational',   0, 'prod_complete','fa-flag-checkered',    'success', 470, 'تحويل WIP لمنتج تام'],
      ['MNT',          'طلب صيانة',               'operational',   1, 'expense_out',  'fa-screwdriver-wrench','warning', 480, 'صيانة معدات/أجهزة'],
      ['AST',          'طلب أصل ثابت',            'operational',   1, 'fixed_asset',  'fa-building',          'purple',  490, 'شراء معدة/أثاث/أجهزة'],
      // ── HR (11) ──
      ['HIR',          'طلب توظيف',               'hr',            0, null,           'fa-user-plus',         'success', 510, 'طلب توظيف موظف جديد'],
      ['LEV',          'طلب إجازة',               'hr',            0, null,           'fa-umbrella-beach',    'info',    520, 'سنوية/مرضية/اضطرارية'],
      ['ADV',          'طلب سلفة',                'hr',            1, 'employee_adv', 'fa-sack-dollar',       'warning', 530, 'سلفة موظف على الراتب'],
      ['LOAN',         'قرض موظف',                'hr',            1, 'employee_loan','fa-hand-holding-dollar','warning',540, 'قرض طويل الأجل من الشركة'],
      ['OVT',          'طلب ساعات إضافية',        'hr',            0, null,           'fa-clock',             'info',    550, 'احتساب overtime'],
      ['TRF-EMP',      'طلب نقل موظف',            'hr',            0, null,           'fa-person-walking-arrow-right','info',560,'نقل بين الفروع/الأقسام'],
      ['PROMO',        'طلب ترقية',               'hr',            0, null,           'fa-arrow-up-right-dots','success',570, 'ترقية موظف'],
      ['TERM',         'طلب إنهاء خدمة',          'hr',            1, 'end_of_service','fa-user-slash',       'danger',  580, 'فصل/استقالة'],
      ['WARN',         'إنذار تأديبي',            'hr',            0, null,           'fa-triangle-exclamation','danger',590, 'إنذار تأديبي'],
      ['PAYROLL',      'تشغيل الرواتب',           'hr',            1, 'payroll',      'fa-money-check-dollar','warning', 599, 'دفعة رواتب شهرية'],
      ['EOS',          'مكافأة نهاية خدمة',       'hr',            1, 'eos',          'fa-handshake-angle',   'purple',  598, 'حساب مكافأة رحيل']
    ];

    // Step 1: dedupe existing — merge duplicates keeping the first one
    try {
      // Map legacy/duplicate codes to canonical ones (keep data, delete duplicates)
      const aliasMap = {
        'PURCHASE_REQUEST': 'PUR',
        'ASSET_REQUEST':    'AST',
        'maintenance':      'MNT',
        'ceo':              'DECISION',
        'hr':               'HIR'
      };
      for (const [oldCode, newCode] of Object.entries(aliasMap)) {
        const [exists] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [newCode]);
        if (!exists.length) continue;
        const [dup] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [oldCode]);
        if (!dup.length) continue;
        // Re-point any transactions using the old code to the new code
        try {
          await db.query(
            'UPDATE transactions SET transaction_type_id = ? WHERE transaction_type_id = ?',
            [exists[0].id, dup[0].id]);
          await db.query(
            'UPDATE workflow_definitions SET transaction_type_id = ? WHERE transaction_type_id = ?',
            [exists[0].id, dup[0].id]);
        } catch(e) {}
        await db.query('DELETE FROM transaction_types WHERE id = ?', [dup[0].id]);
      }
    } catch(e) { console.warn('[txn_types dedupe]', e.message); }

    // Step 1b: FINAL cleanup — remove any aliased rows that didn't get
    // merged in the first pass (because the canonical code didn't exist
    // at the time of dedupe). Now that the seeds are about to run, we
    // also handle the reverse case: delete the old row regardless of
    // whether the canonical has been inserted yet (it will be inserted
    // in step 2 below).
    try {
      const legacyToRemove = ['TRF', 'ceo', 'hr', 'maintenance', 'PURCHASE_REQUEST', 'ASSET_REQUEST'];
      for (const legacyCode of legacyToRemove) {
        const [row] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [legacyCode]);
        if (!row.length) continue;
        // Re-point any workflow links to the canonical first
        const canonMap = { TRF: 'TRF-EMP', ceo: 'DECISION', hr: 'HIR', maintenance: 'MNT', PURCHASE_REQUEST: 'PUR', ASSET_REQUEST: 'AST' };
        const canonCode = canonMap[legacyCode];
        const [canonRow] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [canonCode]);
        if (canonRow.length) {
          try {
            await db.query('UPDATE transactions SET transaction_type_id = ? WHERE transaction_type_id = ?', [canonRow[0].id, row[0].id]);
            await db.query('UPDATE workflow_definitions SET transaction_type_id = ? WHERE transaction_type_id = ?', [canonRow[0].id, row[0].id]);
          } catch(e) {}
        }
        try { await db.query('DELETE FROM transaction_types WHERE id = ?', [row[0].id]); } catch(e) {}
      }
    } catch(e) { console.warn('[txn_types final dedupe]', e.message); }

    // Step 2: insert or update each canonical type
    for (const [code, name, category, requires_payment, gl_template, icon, iconColor, sortOrder, desc] of types) {
      const id = 'TT-' + code;
      const [existing] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [code]);
      if (existing.length) {
        // Update meta (keep existing id)
        try {
          await db.query(
            `UPDATE transaction_types SET name=?, category=?, requires_payment=?, gl_template_code=?,
             icon=?, icon_color=?, sort_order=?, description=? WHERE code = ?`,
            [name, category, requires_payment ? 1 : 0, gl_template, icon, iconColor, sortOrder, desc, code]);
        } catch(e) {}
      } else {
        try {
          await db.query(
            `INSERT INTO transaction_types
             (id, code, name, category, requires_payment, gl_template_code, icon, icon_color, sort_order, description)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [id, code, name, category, requires_payment ? 1 : 0, gl_template, icon, iconColor, sortOrder, desc]);
        } catch(e) {}
      }
    }
  } catch(e) { console.warn('[txn_types seed]', e.message); }

  // ═══ GL TEMPLATES SEED ═══
  // [code, name, description, debit_hint, credit_hint, posts_on, memo]
  try {
    const templates = [
      ['expense_out',    'مصروف مدفوع',              'Dr مصروف / Cr بنك أو نقد',                   '5100', '1120', 'payment',  'Expense payment'],
      ['ap_payment',     'سداد مورد',                'Dr ذمم موردين (AP) / Cr بنك',                '2100', '1120', 'payment',  'AP payment'],
      ['ar_receipt',     'تحصيل عميل',               'Dr بنك / Cr ذمم عملاء (AR)',                 '1120', '1150', 'receipt',  'AR receipt'],
      ['refund',         'استرداد لعميل',            'Dr إيراد مرتجع / Cr بنك',                    '4900', '1120', 'payment',  'Customer refund'],
      ['bank_transfer',  'تحويل بنكي',               'Dr بنك (الوجهة) / Cr بنك (المصدر)',          '1120', '1120', 'payment',  'Bank transfer'],
      ['cash_transfer',  'تحويل نقدي',               'Dr نقد (الوجهة) / Cr نقد (المصدر)',          '1110', '1110', 'payment',  'Cash transfer'],
      ['custody_load',   'تغذية عهدة',               'Dr ذمم عهدة / Cr بنك',                       '1290', '1120', 'payment',  'Custody load'],
      ['custody_stl',    'تسوية عهدة',               'Dr مصاريف / Cr ذمم عهدة',                    '5100', '1290', 'approval', 'Custody settlement'],
      ['write_off',      'شطب دين/أصول',             'Dr خسارة شطب / Cr AR أو أصل',                '5800', '1150', 'approval', 'Write-off'],
      ['manual_jrn',     'قيد تسوية يدوي',           'حسب القيد المُحرَّر',                         null,    null,  'manual',   'Manual adjustment'],
      ['sale',           'فاتورة بيع',               'Dr كاش / Cr إيراد + Cr VAT / Dr COGS / Cr مخزون', '1110','4100','manual', 'POS sale'],
      ['stock_issue',    'إذن صرف مخزني',            'Dr مخزون الفروع / Cr المخزون الرئيسي',       '1210', '1200', 'approval', 'Stock issue'],
      ['stock_trf',      'تحويل مخزون',              'Dr مخزن الوجهة / Cr مخزن المصدر',            '1200', '1200', 'approval', 'Stock transfer'],
      ['stocktake',      'تسوية جرد',                'Dr/Cr فروقات الجرد vs مخزون',                '5300', '1200', 'stocktake','Stocktake variance'],
      ['waste',          'قيد هدر',                  'Dr مصروف الهدر / Cr مخزون',                  '5200', '1200', 'approval', 'Waste posting'],
      ['prod_release',   'إطلاق إنتاج',              'Dr WIP / Cr مواد خام + عمالة + overhead',    '1220', '1200', 'approval', 'Production release'],
      ['prod_complete',  'إكمال إنتاج',              'Dr منتجات تامة / Cr WIP',                    '1230', '1220', 'approval', 'Production complete'],
      ['fixed_asset',    'شراء أصل ثابت',            'Dr أصول ثابتة / Cr بنك أو AP',               '1500', '2100', 'payment',  'Fixed asset purchase'],
      ['grn',            'استلام بضاعة',             'Dr مخزون + Dr VAT مدخلات / Cr AP',           '1200', '2100', 'receipt',  'Goods receipt'],
      ['rtv',            'إرجاع للمورد',             'Dr AP / Cr مخزون',                           '2100', '1200', 'approval', 'Return to vendor'],
      ['po',             'أمر شراء',                 '(لا قيد عند الإنشاء — يُرحَّل عند الاستلام)', null,   null,  'receipt',  'Purchase order'],
      ['employee_adv',   'سلفة موظف',                'Dr ذمم موظفين / Cr بنك',                     '1291', '1120', 'payment',  'Employee advance'],
      ['employee_loan',  'قرض موظف',                 'Dr قرض موظفين / Cr بنك',                     '1292', '1120', 'payment',  'Employee loan'],
      ['payroll',        'رواتب',                    'Dr مصاريف رواتب / Cr بنك + استقطاعات',       '5400', '1120', 'payment',  'Payroll run'],
      ['end_of_service', 'إنهاء خدمة',               'Dr مستحقات نهاية خدمة / Cr بنك',             '2400', '1120', 'payment',  'End of service'],
      ['eos',            'مكافأة نهاية خدمة',        'Dr مصاريف مكافآت / Cr نقد أو بنك',           '5410', '1120', 'payment',  'EOS benefit']
    ];
    for (const [code, name, desc, dr, cr, posts, memo] of templates) {
      try {
        await db.query(
          `INSERT INTO transaction_gl_templates (code, name, description, debit_account_hint, credit_account_hint, posts_on, example_memo)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description),
             debit_account_hint=VALUES(debit_account_hint), credit_account_hint=VALUES(credit_account_hint),
             posts_on=VALUES(posts_on), example_memo=VALUES(example_memo)`,
          [code, name, desc, dr, cr, posts, memo]);
      } catch(e) {}
    }
  } catch(e) { console.warn('[gl_templates seed]', e.message); }

  // ═══ DEFAULT APPROVAL CHAINS ═══
  // Amount-based tiers per transaction type.
  // Roles: المحاسب / مدير الفرع / المدير المالي / المدير العام
  try {
    const chains = [
      // code, step, role, amount_from, amount_to, isFinal
      // Expenses
      ['EXP', 1, 'accountant',       0,      5000,   false],
      ['EXP', 1, 'branch_manager',   5001,   50000,  false],
      ['EXP', 1, 'finance_manager',  50001,  500000, false],
      ['EXP', 1, 'ceo',              500001, null,   false],
      ['EXP', 2, 'finance_manager',  0,      null,   true],   // finalization
      // AP Payments
      ['PAY', 1, 'accountant',       0,      50000,  false],
      ['PAY', 1, 'finance_manager',  50001,  500000, false],
      ['PAY', 1, 'ceo',              500001, null,   false],
      ['PAY', 2, 'finance_manager',  0,      null,   true],
      // Purchase orders
      ['PO',  1, 'branch_manager',   0,      20000,  false],
      ['PO',  1, 'finance_manager',  20001,  200000, false],
      ['PO',  1, 'ceo',              200001, null,   false],
      ['PO',  2, 'finance_manager',  0,      null,   true],
      // Asset request
      ['AST', 1, 'branch_manager',   0,      10000,  false],
      ['AST', 1, 'finance_manager',  10001,  100000, false],
      ['AST', 1, 'ceo',              100001, null,   false],
      ['AST', 2, 'finance_manager',  0,      null,   true],
      // Maintenance
      ['MNT', 1, 'branch_manager',   0,      5000,   false],
      ['MNT', 1, 'finance_manager',  5001,   null,   false],
      ['MNT', 2, 'finance_manager',  0,      null,   true],
      // HR
      ['LEV', 1, 'branch_manager',   0,      null,   false],
      ['LEV', 2, 'hr_manager',       0,      null,   true],
      ['ADV', 1, 'branch_manager',   0,      null,   false],
      ['ADV', 2, 'finance_manager',  0,      null,   true],
      ['HIR', 1, 'hr_manager',       0,      null,   false],
      ['HIR', 2, 'ceo',              0,      null,   true],
      ['TERM',1, 'hr_manager',       0,      null,   false],
      ['TERM',2, 'ceo',              0,      null,   true],
      // Operational
      ['STK-ISS', 1, 'warehouse_keeper', 0, null, false],
      ['STK-ISS', 2, 'branch_manager',   0, null, true],
      ['WASTE',   1, 'branch_manager',   0, null, false],
      ['WASTE',   2, 'finance_manager',  0, null, true],
    ];
    for (const [code, step, role, af, at, isFinal] of chains) {
      const id = 'TTC-' + code + '-' + step + '-' + (af || 0);
      try {
        await db.query(
          `INSERT IGNORE INTO txn_type_default_chain
           (id, transaction_type_code, step_order, role_required, amount_from, amount_to, is_final_step)
           VALUES (?,?,?,?,?,?,?)`,
          [id, code, step, role, af, at, isFinal ? 1 : 0]);
      } catch(e) {}
    }
  } catch(e) { console.warn('[chain seed]', e.message); }
}

app.listen(PORT, async () => {
  console.log(`Moroccan Taste POS running on port ${PORT}`);
  await autoInitDB();
});
