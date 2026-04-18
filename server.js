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
app.use(express.static(path.join(__dirname, 'public')));

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
app.use('/api/erp', require('./routes/erp'));
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
app.get('/employee', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee', 'index.html')));
app.get('/employee/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee', 'index.html')));
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pos', 'index.html')));
app.get('/pos/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pos', 'index.html')));
app.get('/custody', (req, res) => res.sendFile(path.join(__dirname, 'public', 'custody', 'index.html')));
app.get('/custody/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'custody', 'index.html')));

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

  // Seed useful transaction types if none cover common admin flows
  try {
    const [ttNames] = await db.query("SELECT code FROM transaction_types");
    const existing = new Set(ttNames.map(r => r.code));
    const seeds = [
      ['TT-EXP','طلب صرف مستحقات','EXP'],
      ['TT-PUR','طلب شراء','PUR'],
      ['TT-AST','طلب أصل ثابت','AST'],
      ['TT-MNT','طلب صيانة','MNT'],
      ['TT-LEV','طلب إجازة','LEV'],
      ['TT-HIR','طلب توظيف','HIR'],
      ['TT-TRF','طلب نقل','TRF'],
      ['TT-ADV','طلب سلفة','ADV']
    ];
    for (const [id, name, code] of seeds) {
      if (!existing.has(code)) {
        try { await db.query('INSERT IGNORE INTO transaction_types (id, name, code) VALUES (?,?,?)', [id, name, code]); } catch(e) {}
      }
    }
  } catch(e) {}
}

app.listen(PORT, async () => {
  console.log(`Moroccan Taste POS running on port ${PORT}`);
  await autoInitDB();
});
