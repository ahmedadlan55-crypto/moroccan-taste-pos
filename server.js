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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Auto-initialize database tables on first run
const fs = require('fs');
const db = require('./db/connection');
async function autoInitDB() {
  try {
    const [rows] = await db.query("SHOW TABLES LIKE 'users'");
    if (!rows.length) {
      console.log('First run — creating database tables...');
      const schema = fs.readFileSync(require('path').join(__dirname, 'db/schema.sql'), 'utf8');
      const stmts = schema.split(';').map(s => s.trim()).filter(s => s.length > 5 && !s.startsWith('CREATE DATABASE') && !s.startsWith('USE '));
      for (const stmt of stmts) {
        try { await db.query(stmt); } catch(e) {}
      }
      // Create default admin user
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('admin123', 10);
      await db.query("INSERT IGNORE INTO users (username, password, role) VALUES ('admin', ?, 'admin')", [hash]);
      console.log('Database ready! Default login: admin / admin123');
    }
  } catch(e) { console.log('DB init note:', e.message); }
}

app.listen(PORT, async () => {
  await autoInitDB();
  console.log(`Moroccan Taste POS running on port ${PORT}`);
});
