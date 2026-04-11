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
app.use(helmet({ contentSecurityPolicy: false }));
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
  // GL account link on custody expenses
  await addColumnIfMissing('custody_expenses', 'gl_account_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('custody_expenses', 'gl_account_name', "VARCHAR(200) DEFAULT ''");

  // Extend custody_expenses status ENUM to include override_pending + returned
  try { await db.query("ALTER TABLE custody_expenses MODIFY COLUMN status ENUM('pending','approved','rejected','posted','override_pending','returned') DEFAULT 'pending'"); } catch(e) {}

  // Seed cost settings into the existing key-value settings table
  try {
    await db.query(`INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
      ('costing_method','WEIGHTED_AVERAGE'),
      ('default_pricing_mode','fixed'),
      ('default_markup_pct','30'),
      ('BranchName','')`);
  } catch (e) { console.log('[DB] Cost settings seed:', e.message.substring(0, 80)); }
}

app.listen(PORT, async () => {
  console.log(`Moroccan Taste POS running on port ${PORT}`);
  await autoInitDB();
});
