/**
 * ddlHelpers.js — idempotent, cross-engine (MySQL 8/9 + MariaDB) DDL primitives
 * for the Order-to-Cash schema. MySQL does NOT support `ADD COLUMN IF NOT EXISTS`
 * and the runner aborts a file on the first duplicate-column error, so every
 * ALTER is guarded by an INFORMATION_SCHEMA check first. Safe to run repeatedly.
 * `db` exposes `.query(sql, params) -> [rows]` (pool or transaction connection).
 */
'use strict';

async function tableExists(db, table) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`, [table]);
  return rows.length > 0;
}
async function columnExists(db, table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`, [table, column]);
  return rows.length > 0;
}
async function indexExists(db, table, indexName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`, [table, indexName]);
  return rows.length > 0;
}
async function viewExists(db, view) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.views WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`, [view]);
  return rows.length > 0;
}
async function createTable(db, table, createSql, log) {
  if (await tableExists(db, table)) return false;
  await db.query(createSql);
  if (log) log(`  + table ${table}`);
  return true;
}
async function addColumn(db, table, column, definition, log) {
  if (!(await tableExists(db, table))) throw new Error(`addColumn: base table ${table} is missing`);
  if (await columnExists(db, table, column)) return false;
  await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  if (log) log(`  + ${table}.${column}`);
  return true;
}
async function modifyColumn(db, table, column, definition, log) {
  if (!(await columnExists(db, table, column))) return false;
  await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  if (log) log(`  ~ ${table}.${column}`);
  return true;
}
async function addIndex(db, table, indexName, columnsSql, { unique = false } = {}, log) {
  if (await indexExists(db, table, indexName)) return false;
  const kind = unique ? 'UNIQUE INDEX' : 'INDEX';
  await db.query(`ALTER TABLE \`${table}\` ADD ${kind} \`${indexName}\` (${columnsSql})`);
  if (log) log(`  + index ${table}.${indexName}`);
  return true;
}
async function run(db, sql, log, label) {
  await db.query(sql);
  if (log && label) log(`  * ${label}`);
}

module.exports = {
  tableExists, columnExists, indexExists, viewExists,
  createTable, addColumn, modifyColumn, addIndex, run,
};
