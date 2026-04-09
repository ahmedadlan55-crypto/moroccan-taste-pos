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

async function runMigrations() {
  // PO lines — unit of measurement (kg / piece / box / etc.) carried from
  // the ERP PO form through to the purchase and inventory receive screens.
  await addColumnIfMissing('po_lines', 'unit', "VARCHAR(50) DEFAULT ''");
}

app.listen(PORT, async () => {
  console.log(`Moroccan Taste POS running on port ${PORT}`);
  await autoInitDB();
});
