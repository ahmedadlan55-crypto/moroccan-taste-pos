'use strict';
/* READ-ONLY admin credential-exposure check on PRODUCTION.
   Reads the admin bcrypt hash and locally bcrypt.compare()s it against a list
   of KNOWN-EXPOSED defaults. All must be FALSE → the prod admin is not using
   any exposed/default password. No login attempt (so failed_attempts is never
   incremented and the account cannot be locked). The hash is never printed. */
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const DEFAULTS = ['admin123', 'admin', 'password', 'Admin@123', 'admin1234', '123456', 'changeme', 'admin@123'];
(async () => {
  const c = await mysql.createConnection({
    host: process.env.PROD_DB_HOST, port: +process.env.PROD_DB_PORT,
    user: process.env.PROD_DB_USER, password: process.env.PROD_DB_PASSWORD,
    database: process.env.PROD_DB_NAME, dateStrings: true,
  });
  const [rows] = await c.query("SELECT id, username, role, active, password, failed_attempts, locked_until, LENGTH(password) hashlen, LEFT(password,4) algo FROM users WHERE username='admin' LIMIT 1");
  if (!rows.length) { console.log('NO_ADMIN_ROW'); await c.end(); process.exit(2); }
  const u = rows[0];
  const results = {};
  let anyMatch = false;
  for (const d of DEFAULTS) {
    let m = false;
    try { m = await bcrypt.compare(d, u.password); } catch (_) { m = false; }
    results[d] = m;
    if (m) anyMatch = true;
  }
  await c.end();
  // Report WITHOUT the hash: only the boolean matrix + metadata.
  console.log('admin row: id=' + u.id, 'role=' + u.role, 'active=' + u.active,
    'hashAlgo=' + u.algo, 'hashLen=' + u.hashlen,
    'failed_attempts=' + u.failed_attempts, 'locked_until=' + (u.locked_until || 'null'));
  console.log('default-password match matrix (all must be false):');
  for (const d of DEFAULTS) console.log('  ' + JSON.stringify(d) + ' -> ' + results[d]);
  console.log('ANY_DEFAULT_MATCHES:', anyMatch);
  console.log('VERDICT:', anyMatch ? 'FAIL — admin uses an exposed default!' : 'PASS — admin does NOT use any known exposed default (bcrypt hash, not a default).');
  process.exit(anyMatch ? 3 : 0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
