/**
 * ddlHelpers.js — idempotent, cross-engine (MySQL 8 + MariaDB) DDL primitives
 * for the Procurement / P2P schema evolution.
 *
 * MySQL 8 does NOT support `ADD COLUMN IF NOT EXISTS` (MariaDB does), and the
 * versioned SQL runner aborts an entire file on the first duplicate-column
 * error — so ALTERs on existing tables must be guarded by an INFORMATION_SCHEMA
 * check first. These helpers do exactly that and are safe to run repeatedly.
 *
 * Every helper accepts a `db` that exposes `.query(sql, params) -> [rows]`
 * (the shared pool from db/connection.js, or a transaction connection).
 */
'use strict';

async function tableExists(db, table) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function columnExists(db, table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function indexExists(db, table, indexName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName]
  );
  return rows.length > 0;
}

/** Create a table only when absent. `createSql` must be a full CREATE TABLE. */
async function createTable(db, table, createSql, log) {
  if (await tableExists(db, table)) return false;
  await db.query(createSql);
  if (log) log(`  + table ${table}`);
  return true;
}

/** Add a column only when absent. `definition` is everything after the name. */
async function addColumn(db, table, column, definition, log) {
  if (!(await tableExists(db, table))) {
    throw new Error(`addColumn: base table ${table} is missing`);
  }
  if (await columnExists(db, table, column)) return false;
  await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  if (log) log(`  + ${table}.${column}`);
  return true;
}

/**
 * MODIFY a column to a new definition. Unconditional but idempotent in effect
 * (re-applying the same definition is a no-op at the data level). Tolerates the
 * case where the modification would be rejected by existing data by surfacing a
 * clear error to the caller.
 */
async function modifyColumn(db, table, column, definition, log) {
  if (!(await columnExists(db, table, column))) return false;
  await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  if (log) log(`  ~ ${table}.${column}`);
  return true;
}

/** Add a plain/unique index only when an index of that NAME is absent. */
async function addIndex(db, table, indexName, columnsSql, { unique = false } = {}, log) {
  if (await indexExists(db, table, indexName)) return false;
  const kind = unique ? 'UNIQUE INDEX' : 'INDEX';
  await db.query(`ALTER TABLE \`${table}\` ADD ${kind} \`${indexName}\` (${columnsSql})`);
  if (log) log(`  + index ${table}.${indexName}`);
  return true;
}

/** Run raw SQL (used for CREATE OR REPLACE VIEW which is inherently idempotent). */
async function run(db, sql, log, label) {
  await db.query(sql);
  if (log && label) log(`  * ${label}`);
}

module.exports = {
  tableExists, columnExists, indexExists,
  createTable, addColumn, modifyColumn, addIndex, run,
};
