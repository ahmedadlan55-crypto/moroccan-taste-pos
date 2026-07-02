const mysql = require('mysql2/promise');
require('dotenv').config();

// Support Railway's DATABASE_URL or individual env vars
const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
let poolConfig;

const POOL_SIZE = parseInt(process.env.DB_POOL_SIZE) || 30; // Increased from 10

// Phase 5B.1 — canonical DB session timezone (Riyadh, fixed offset — KSA has no
// DST). Applied at THREE layers so it survives MySQL restarts and never depends
// on SET GLOBAL or the server's system tz:
//   1. mysql2 `timezone` option → DATETIME ⇄ JS-Date conversion is explicit
//      (independent of process TZ). DATE-only columns (expiry dates) are
//      calendar values and are never shifted by this option.
//   2. `SET time_zone` on every NEW physical connection (pool 'connection'
//      event) → NOW()/CURDATE() and TIMESTAMP reads are Riyadh-local for every
//      session, including reconnections after a DB restart.
//   3. /api/inventory/v2/ready asserts the EFFECTIVE session offset (+180min).
const DB_TIME_ZONE = process.env.DB_TIME_ZONE || '+03:00';

// V3.1 — Always parse DATABASE_URL into individual fields. mysql2 ignores the
// `charset` option when using `uri:` mode, which is why Arabic was returning
// as U+FFFD on Railway (where DATABASE_URL is provided without ?charset=).
function _parseDbUrl(u) {
  try {
    const url = new URL(u);
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      database: (url.pathname || '/').slice(1)
    };
  } catch (e) {
    return null;
  }
}

if (dbUrl) {
  const parts = _parseDbUrl(dbUrl);
  if (parts) {
    poolConfig = Object.assign({}, parts, {
      waitForConnections: true,
      connectionLimit: POOL_SIZE,
      queueLimit: 50,
      charset: 'utf8mb4',                    // Honored when using individual fields
      timezone: DB_TIME_ZONE,                // explicit DATETIME conversion (layer 1)
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000,
      connectTimeout: 10000
    });
  } else {
    // Last-resort fallback if URL parsing fails
    poolConfig = {
      uri: dbUrl,
      waitForConnections: true,
      connectionLimit: POOL_SIZE,
      queueLimit: 50,
      charset: 'utf8mb4',
      timezone: DB_TIME_ZONE,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000
    };
  }
} else {
  const host     = process.env.MYSQLHOST     || process.env.DB_HOST     || 'localhost';
  const port     = process.env.MYSQLPORT     || process.env.DB_PORT     || 3306;
  const user     = process.env.MYSQLUSER     || process.env.DB_USER     || 'root';
  const password = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '';
  const database = process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || process.env.DB_NAME || 'moroccan_taste_pos';

  poolConfig = {
    host,
    port: Number(port),
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: POOL_SIZE,
    queueLimit: 50,
    charset: 'utf8mb4',
    timezone: DB_TIME_ZONE,     // explicit DATETIME conversion (layer 1)
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
    connectTimeout: 10000,      // 10s connection timeout
    idleTimeout: 60000          // 60s idle timeout
  };
}

const pool = mysql.createPool(poolConfig);

// V3.1 BELT-AND-SUSPENDERS — also run SET NAMES on every newly created
// connection. `pool.on('connection')` fires once per new physical connection.
// Even if mysql2 honored our charset config above, this guarantees the
// 3 result-set charset variables (client/connection/results) are all utf8mb4.
pool.on('connection', function(conn) {
  conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci", function(err) {
    if (err) console.warn('[db] SET NAMES utf8mb4 failed:', err.message);
  });
  // Phase 5B.1 (layer 2) — session timezone on EVERY new physical connection.
  // Survives DB restarts (each reconnect re-applies it); never needs SET GLOBAL.
  conn.query("SET time_zone = '" + DB_TIME_ZONE.replace(/[^+\-:0-9A-Za-z_\/]/g, '') + "'", function(err) {
    if (err) console.warn('[db] SET time_zone failed:', err.message);
  });
});

pool.DB_TIME_ZONE = DB_TIME_ZONE;

// Helper: execute a function inside a database transaction
pool.withTransaction = async function(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
};

module.exports = pool;
