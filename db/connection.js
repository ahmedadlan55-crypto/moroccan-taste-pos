const mysql = require('mysql2/promise');
require('dotenv').config();

// Support Railway's DATABASE_URL or individual env vars
const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
let poolConfig;

if (dbUrl) {
  console.log('[DB] Connecting via DATABASE_URL');
  poolConfig = { uri: dbUrl, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4' };
} else {
  // Railway injects: MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQL_DATABASE
  const host     = process.env.MYSQLHOST     || process.env.DB_HOST     || 'localhost';
  const port     = process.env.MYSQLPORT     || process.env.DB_PORT     || 3306;
  const user     = process.env.MYSQLUSER     || process.env.DB_USER     || 'root';
  const password = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '';
  const database = process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || process.env.DB_NAME || 'moroccan_taste_pos';

  console.log(`[DB] Connecting to MySQL at ${host}:${port} — database: "${database}" — user: "${user}"`);

  poolConfig = {
    host,
    port: Number(port),
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4'
  };
}

const pool = mysql.createPool(poolConfig);
module.exports = pool;
