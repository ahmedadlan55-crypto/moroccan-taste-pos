require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,
  referrerPolicy: { policy: 'same-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));
// No-cache for JS/CSS files to ensure updates are always loaded
app.use(function(req, res, next) {
  if (req.path.match(/\.(js|css)$/)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=self, microphone=()');
  next();
});
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

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
app.use('/api/workflow', require('./routes/workflow'));
app.use('/api/hr', require('./routes/hr'));

// Catch-all for unimplemented API routes — return JSON instead of HTML
app.all('/api/*', (req, res) => {
  res.json([]);
});

// SPA fallback
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

  // Seed default positions
  try {
    const [posCount] = await db.query('SELECT COUNT(*) AS cnt FROM positions');
    if (posCount[0].cnt === 0) {
      await db.query("INSERT INTO positions (id, name, level) VALUES ('POS-1','محاسب',1),('POS-2','مدير مالي',2),('POS-3','مدير تنفيذي',3),('POS-4','مسؤول بنوك',2),('POS-5','مدير فرع',2)");
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

  // Add 'custody' role to users table ENUM
  try { await db.query("ALTER TABLE users MODIFY COLUMN role ENUM('admin','cashier','manager','custody') DEFAULT 'cashier'"); } catch(e) {}

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
      run_number VARCHAR(20),
      period_month INT NOT NULL,
      period_year INT NOT NULL,
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      status ENUM('draft','calculated','approved','paid') DEFAULT 'draft',
      total_gross DECIMAL(14,2) DEFAULT 0,
      total_deductions DECIMAL(14,2) DEFAULT 0,
      total_net DECIMAL(14,2) DEFAULT 0,
      employee_count INT DEFAULT 0,
      calculated_by VARCHAR(100),
      approved_by VARCHAR(100),
      approved_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_payroll_items', `
    CREATE TABLE hr_payroll_items (
      id VARCHAR(50) PRIMARY KEY,
      payroll_run_id VARCHAR(50) NOT NULL,
      employee_id VARCHAR(50) NOT NULL,
      employee_name VARCHAR(200),
      working_days INT DEFAULT 30,
      actual_days INT DEFAULT 30,
      absent_days INT DEFAULT 0,
      leave_days_paid INT DEFAULT 0,
      leave_days_unpaid INT DEFAULT 0,
      late_minutes INT DEFAULT 0,
      early_leave_minutes INT DEFAULT 0,
      overtime_minutes INT DEFAULT 0,
      basic_salary DECIMAL(12,2) DEFAULT 0,
      housing_allowance DECIMAL(12,2) DEFAULT 0,
      transport_allowance DECIMAL(12,2) DEFAULT 0,
      other_allowance DECIMAL(12,2) DEFAULT 0,
      overtime_amount DECIMAL(12,2) DEFAULT 0,
      gross_salary DECIMAL(12,2) DEFAULT 0,
      absence_deduction DECIMAL(12,2) DEFAULT 0,
      late_deduction DECIMAL(12,2) DEFAULT 0,
      advance_deduction DECIMAL(12,2) DEFAULT 0,
      other_deduction DECIMAL(12,2) DEFAULT 0,
      total_deductions DECIMAL(12,2) DEFAULT 0,
      net_salary DECIMAL(12,2) DEFAULT 0,
      INDEX idx_pi_run (payroll_run_id),
      INDEX idx_pi_emp (employee_id)
    ) ENGINE=InnoDB
  `);

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

  // Shifts: add geolocation + device info columns
  await addColumnIfMissing('shifts', 'geo_lat', "DECIMAL(10,7)");
  await addColumnIfMissing('shifts', 'geo_lng', "DECIMAL(10,7)");
  await addColumnIfMissing('shifts', 'geo_address', "VARCHAR(300)");
  await addColumnIfMissing('shifts', 'device_info', "VARCHAR(500)");
  await addColumnIfMissing('shifts', 'ip_address', "VARCHAR(50)");

  // Users: add email + plain_pass for admin visibility
  await addColumnIfMissing('users', 'email', "VARCHAR(200)");
  await addColumnIfMissing('users', 'plain_pass', "VARCHAR(200)");

  // Seed cost settings into the existing key-value settings table
  try {
    await db.query(`INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
      ('costing_method','WEIGHTED_AVERAGE'),
      ('default_pricing_mode','fixed'),
      ('default_markup_pct','30'),
      ('BranchName',''),
      ('inventory_method','perpetual')`);
  } catch (e) { console.log('[DB] Cost settings seed:', e.message.substring(0, 80)); }
}

app.listen(PORT, async () => {
  console.log(`Moroccan Taste POS running on port ${PORT}`);
  await autoInitDB();
});
