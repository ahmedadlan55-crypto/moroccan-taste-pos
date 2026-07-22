const fs = require('fs');
const path = require('path');
const db = require('./connection');

// Strip `--` line comments before splitting on `;`, so a comment that itself
// contains a semicolon (e.g. schema.sql's "...full column set; no
// migration-window column drift.") can't fracture the next statement.
// schema.sql has CRLF line endings — `.` never matches `\r`, so `.*` is
// already correctly bounded by the line terminator and needs NO `$` anchor.
// A `$`-anchored version (`/--.*$/`) silently fails to match any line ending
// in `\r\n`, because the trailing `\r` blocks `.*` from ever reaching the
// true end-of-string `$` — leaving the comment (and its semicolon) intact.
function stripLineComments(sql) {
  return sql.split('\n').map(line => line.replace(/--.*/, '')).join('\n');
}

async function initDB() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const statements = stripLineComments(schema)
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    const sqlErrors = [];
    for (const stmt of statements) {
      // schema.sql hardcodes "USE moroccan_taste_pos" for standalone `mysql`
      // CLI runs. db/connection.js's pool already connects to whatever
      // MYSQL_DATABASE/MYSQLDATABASE/DB_NAME resolves to, so executing this
      // statement here would silently redirect the connection away from
      // that env-configured target database onto the hardcoded literal.
      if (/^USE\s/i.test(stmt)) continue;
      try {
        await db.query(stmt);
      } catch (e) {
        // Ignore "already exists" errors — expected on a re-run against a
        // non-empty database. Anything else is a genuine syntax/parse error
        // and must be surfaced loudly, not swallowed identically to those.
        if (!e.message.includes('already exists') && !e.message.includes('Duplicate')) {
          sqlErrors.push({ message: e.message, stmt });
          console.error('SQL ERROR:', e.message.substring(0, 200));
          console.error('  in statement:', stmt.substring(0, 200));
        }
      }
    }
    if (sqlErrors.length > 0) {
      console.error(`Database initialized with ${sqlErrors.length} SQL error(s) — see above. Some tables/columns may be missing.`);
      process.exit(1);
    }
    console.log('Database initialized successfully!');
    process.exit(0);
  } catch (e) {
    console.error('DB Init Error:', e.message);
    process.exit(1);
  }
}

initDB();
