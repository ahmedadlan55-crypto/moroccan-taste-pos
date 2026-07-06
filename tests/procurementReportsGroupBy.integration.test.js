'use strict';
/**
 * tests/procurementReportsGroupBy.integration.test.js
 *
 * Reproduces the PRODUCTION MySQL strictness that MariaDB's lenient default hides:
 * runs the procurement purchase-analysis report under sql_mode=ONLY_FULL_GROUP_BY
 * AND with mixed id collations (utf8mb4_unicode_ci vs utf8mb4_general_ci), exactly
 * like production. Proves:
 *   • the OLD query is rejected by ONLY_FULL_GROUP_BY (regression guard),
 *   • the FIXED query (imported from reports.js — single source of truth) runs and
 *     aggregates correctly across the edge cases,
 *   • internal DB errors are sanitized (no SQL/table/stack leaks to the client).
 *
 * Local MariaDB only (DB_HOST/DB_PORT from .env). Run:
 *   node tests/procurementReportsGroupBy.integration.test.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const { PURCHASE_ANALYSIS_SQL } = require('../routes/procurement/reports');
const E = require('../lib/procurement/errors');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.error('  ✗', m); } }

const STRICT = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';
const SCHEMA = 'proc_pa_groupby_test';

// The pre-fix query — kept here ONLY to prove strict mode rejects it.
const OLD_BUGGY_SQL =
  `SELECT supplier_id, supplier_name, COUNT(*) AS invoices, COALESCE(SUM(total_amount),0) AS spend
     FROM supplier_invoices WHERE status NOT IN ('cancelled','draft')
     GROUP BY supplier_id ORDER BY spend DESC LIMIT 500`;

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true,
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${SCHEMA}\``);
  await conn.query(`CREATE DATABASE \`${SCHEMA}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${SCHEMA}\``);
  // Mixed collations on purpose — mirrors prod: an un-forced join would throw
  // "Illegal mix of collations"; the query's explicit COLLATE must resolve it.
  await conn.query("CREATE TABLE suppliers (id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY, name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci)");
  await conn.query("CREATE TABLE supplier_invoices (id INT AUTO_INCREMENT PRIMARY KEY, supplier_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL, supplier_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, total_amount DECIMAL(14,2), status VARCHAR(32))");
  await conn.query("INSERT INTO suppliers (id,name) VALUES ('S1','مورد ألف'),('S2','مورد باء'),('S3','مورد ألف')");
  // S1: 2 invoices (varying snapshot). S2: 2 (one is a 0%-VAT invoice, total=net).
  // S3: similar name to S1, distinct id. SUP-GONE: orphan (no supplier row).
  // NULL supplier_id. Plus excluded cancelled/draft rows.
  await conn.query(
    "INSERT INTO supplier_invoices (supplier_id,supplier_name,total_amount,status) VALUES " +
    "('S1','مورد ألف',100.00,'approved')," +
    "('S1','Mawrid Alef snapshot',200.30,'posted')," +
    "('S2','مورد باء',50.00,'approved')," +
    "('S2','ضريبة صفر',30.00,'approved')," +
    "('S3','مورد ألف',10.00,'approved')," +
    "('SUP-GONE','مورد محذوف',25.00,'approved')," +
    "(NULL,'بدون مورد',5.00,'approved')," +
    "('S1','ملغاة',999.00,'cancelled')," +
    "('S2','مسودة',888.00,'draft')");

  await conn.query(`SET SESSION sql_mode = '${STRICT}'`);
  const [[chk]] = await conn.query('SELECT @@session.sql_mode sm');
  ok(/ONLY_FULL_GROUP_BY/.test(chk.sm), 'session sql_mode has ONLY_FULL_GROUP_BY');

  // 1) OLD query must FAIL under strict mode (bug reproduction + regression guard)
  let oldThrew = false;
  try { await conn.query(OLD_BUGGY_SQL); }
  catch (e) { oldThrew = e.errno === 1055 || /only_full_group_by|group by|nonaggregated/i.test(e.message); }
  ok(oldThrew, 'legacy query rejected by ONLY_FULL_GROUP_BY (regression guard)');

  // 2) FIXED query runs and aggregates correctly (also proves the COLLATE fix)
  const [rows] = await conn.query(PURCHASE_ANALYSIS_SQL);
  const by = {}; for (const r of rows) by[r.supplier_id == null ? 'NULL' : r.supplier_id] = r;
  ok(rows.length === 5, `5 supplier groups (got ${rows.length})`);
  ok(by.S1 && Number(by.S1.invoices) === 2 && Math.abs(Number(by.S1.spend) - 300.30) < 0.001, 'S1: 2 invoices, spend 300.30');
  ok(by.S1 && by.S1.supplier_name === 'مورد ألف', 'S1: canonical suppliers.name used');
  ok(by.S2 && Number(by.S2.invoices) === 2 && Math.abs(Number(by.S2.spend) - 80.00) < 0.001, 'S2: 2 invoices incl. 0%-VAT, spend 80.00');
  ok(by.S3 && by.S3.supplier_id === 'S3' && by.S3.supplier_name === 'مورد ألف', 'S3: similar name is a DISTINCT row by supplier_id');
  ok(by['SUP-GONE'] && by['SUP-GONE'].supplier_name === 'مورد محذوف', 'orphan invoice → snapshot name fallback');
  ok(by.NULL && Number(by.NULL.spend) === 5 && by.NULL.supplier_name === 'بدون مورد', 'NULL supplier_id → one group, snapshot name');
  ok(!rows.some((r) => Number(r.spend) === 999 || Number(r.spend) === 888), 'cancelled/draft excluded');
  ok(Number(rows[0].spend) >= Number(rows[rows.length - 1].spend), 'ordered by spend desc');

  // 3) empty dataset → no error, zero rows
  await conn.query('DELETE FROM supplier_invoices');
  const [empty] = await conn.query(PURCHASE_ANALYSIS_SQL);
  ok(empty.length === 0, 'empty dataset → 0 rows, no error');

  await conn.query(`DROP DATABASE IF EXISTS \`${SCHEMA}\``);
  await conn.end();

  // 4) error sanitization — internal DB error must not leak to the client
  const dbErr = new Error('Expression #2 of SELECT list is not in GROUP BY clause ... incompatible with sql_mode=only_full_group_by');
  dbErr.code = 'ER_WRONG_FIELD_WITH_GROUP'; dbErr.errno = 1055; dbErr.sqlMessage = dbErr.message;
  dbErr.sql = 'SELECT supplier_name FROM supplier_invoices GROUP BY supplier_id';
  ok(E.isInternalError(dbErr) === true, 'DB error classified internal');
  ok(E.isInternalError(new TypeError('x is undefined')) === true, 'TypeError classified internal');
  ok(E.isInternalError(E.err('VALIDATION_ERROR', 'اسم المورد مطلوب')) === false, 'ProcurementError not internal');
  const eb = E.errorBody(dbErr);
  ok(eb.http === 500, 'internal error → HTTP 500');
  ok(eb.body.code === 'INTERNAL_ERROR', 'internal error → code INTERNAL_ERROR');
  ok(typeof eb.body.correlationId === 'string' && eb.body.correlationId.length > 0, 'internal error → correlationId present');
  ok(!/group by|only_full_group_by|nonaggregated|select |sqlmessage|supplier_invoices|errno/i.test(JSON.stringify(eb.body)), 'internal error body leaks NO SQL/table/technical detail');
  ok(/تعذّر/.test(eb.body.error), 'internal error body is a friendly Arabic message');
  const vb = E.errorBody(E.err('VALIDATION_ERROR', 'اسم المورد مطلوب'));
  ok(vb.http === 422 && vb.body.error === 'اسم المورد مطلوب', 'domain validation message preserved');

  console.log(`\nprocurementReportsGroupBy: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e.message, '\n', e.stack); process.exit(1); });
