const fs = require('fs');
const path = require('path');
const db = require('./connection');

async function initDB() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    // Split by semicolons and execute each statement
    const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      try { await db.query(stmt); } catch (e) {
        // Ignore "already exists" errors
        if (!e.message.includes('already exists') && !e.message.includes('Duplicate')) {
          console.log('SQL Warning:', e.message.substring(0, 100));
        }
      }
    }
    console.log('Database initialized successfully!');
    process.exit(0);
  } catch (e) {
    console.error('DB Init Error:', e.message);
    process.exit(1);
  }
}

initDB();
