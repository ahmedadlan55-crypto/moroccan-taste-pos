const mysql = require('mysql2/promise');
require('dotenv').config();

// Support Railway's DATABASE_URL or individual env vars
const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
let poolConfig;

const POOL_SIZE = parseInt(process.env.DB_POOL_SIZE) || 30; // Increased from 10

if (dbUrl) {
  poolConfig = {
    uri: dbUrl,
    waitForConnections: true,
    connectionLimit: POOL_SIZE,
    queueLimit: 50,
    charset: 'utf8mb4',
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000
  };
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
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
    connectTimeout: 10000,      // 10s connection timeout
    idleTimeout: 60000          // 60s idle timeout
  };
}

const pool = mysql.createPool(poolConfig);

// V3.1 FIX — force utf8mb4 on every connection acquired from the pool.
// mysql2's `charset` option in poolConfig is sometimes not honored when
// using a URI string (Railway DATABASE_URL). Without this, Arabic bytes
// stored as utf8mb4 may be re-decoded as a different charset and turn
// into U+FFFD replacement chars on the way out. SET NAMES forces the
// 3 connection charset variables (client, connection, results) all to
// utf8mb4 explicitly.
pool.on('connection', function(conn) {
  conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci", function(err) {
    if (err) console.warn('[db] SET NAMES utf8mb4 failed:', err.message);
  });
});

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
