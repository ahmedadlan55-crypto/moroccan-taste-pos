const mysql = require('mysql2/promise');
require('dotenv').config();

// Support Railway's DATABASE_URL or individual env vars
const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
let poolConfig;

if (dbUrl) {
  poolConfig = { uri: dbUrl, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4' };
} else {
  poolConfig = {
    host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
    port: process.env.DB_PORT || process.env.MYSQLPORT || 3306,
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'moroccan_taste_pos',
    waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4'
  };
}

const pool = mysql.createPool(poolConfig);
module.exports = pool;
