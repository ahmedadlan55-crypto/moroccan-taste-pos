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
    keepAliveInitialDelay: 30000
  };
}

const pool = mysql.createPool(poolConfig);

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
