#!/usr/bin/env node
'use strict';
/**
 * scripts/backup/prod-dump.js — logical backup of the production DB through the
 * Railway public TCP proxy, WITHOUT mysqldump.
 *
 * WHY NOT mysqldump
 *   The proxy (maglev.proxy.rlwy.net) consistently stalls mysqldump's long
 *   streaming connection at ~5MB — full dump, --compress, even schema-only all
 *   hang. Short queries over the same proxy work fine (that is how the SHA1→SHA2
 *   hotfix was verified against prod). So this tool dumps with many SHORT
 *   chunked SELECTs on one connection inside START TRANSACTION WITH CONSISTENT
 *   SNAPSHOT, and if the proxy still drops the connection it reconnects and
 *   resumes the current table (marking the manifest `consistent:false`).
 *
 * USAGE (never put the password on the command line):
 *   set MTPOS_DUMP_URL=mysql://user:pass@host:port/db   (or MYSQL_PWD + flags)
 *   node scripts/backup/prod-dump.js --out "C:\path\prod-YYYYMMDD.sql"
 *
 * OUTPUT
 *   <out>.sql       — DROP+CREATE+multi-row INSERTs, FK checks off, utf8mb4;
 *                     views (DEFINER stripped) after all tables.
 *   <out>.manifest.json — per-table live COUNT(*) vs rows written + status.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { escape, escapeId } = require('mysql2');

const OUT = (() => {
  const i = process.argv.indexOf('--out');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return path.join(process.cwd(), `prod-dump-${new Date().toISOString().slice(0, 10)}.sql`);
})();
const CHUNK = 1000; // rows per SELECT — keeps every proxy round-trip short

function connCfg() {
  const url = process.env.MTPOS_DUMP_URL;
  const base = url
    ? (() => {
        const m = url.match(/^mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/);
        if (!m) throw new Error('MTPOS_DUMP_URL parse failed (expected mysql://user:pass@host:port/db)');
        return { user: m[1], password: m[2], host: m[3], port: Number(m[4]), database: m[5] };
      })()
    : {
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER, password: process.env.MYSQL_PWD, database: process.env.DB_NAME,
      };
  return {
    ...base,
    charset: 'utf8mb4',
    dateStrings: true,       // datetime/date/timestamp come back verbatim — no TZ mangling
    decimalNumbers: false,   // decimals as strings — exact
    connectTimeout: 20000,
    // JSON columns parse to objects by default; escape() needs the raw string
    // (explicit utf8 — the driver treats JSON as BINARY otherwise).
    typeCast: (field, next) => (field.type === 'JSON' ? field.string('utf8') : next()),
  };
}

async function freshConn() {
  const c = await mysql.createConnection(connCfg());
  await c.query("SET SESSION net_write_timeout=600, net_read_timeout=600");
  return c;
}

const isConnLoss = (e) =>
  ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(e && e.code);

(async function main() {
  let conn = await freshConn();
  const manifest = { startedAt: new Date().toISOString(), consistent: true, tables: {}, views: [] };
  const out = fs.createWriteStream(OUT, { encoding: 'utf8' });
  const w = (s) => out.write(s + '\n');

  const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
  w(`-- mt-pos production logical dump (chunked, via proxy)`);
  w(`-- server: ${v}   started: ${manifest.startedAt}`);
  w('SET NAMES utf8mb4;');
  w('SET FOREIGN_KEY_CHECKS=0;');
  w("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';");
  w('');

  // Consistent snapshot for the whole run — if the proxy drops us we reconnect,
  // finish the dump, and mark it non-atomic instead of failing.
  await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');

  const [tblRows] = await conn.query(
    "SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
  const [viewRows] = await conn.query(
    "SHOW FULL TABLES WHERE Table_type = 'VIEW'");
  const nameOf = (r) => r[Object.keys(r)[0]];
  const tables = tblRows.map(nameOf).sort();
  const views = viewRows.map(nameOf).sort();

  for (const t of tables) {
    const tick = Date.now();
    let written = 0;
    const [[cnt]] = await conn.query(`SELECT COUNT(*) AS n FROM ${escapeId(t)}`);
    const [[ddl]] = await conn.query(`SHOW CREATE TABLE ${escapeId(t)}`);
    w(`-- ─── ${t} (${cnt.n} rows) ───`);
    w(`DROP TABLE IF EXISTS ${escapeId(t)};`);
    w(ddl['Create Table'] + ';');

    // VIRTUAL/STORED GENERATED columns cannot be INSERTed — restore fails with
    // ER_GENERATED_COLUMN (bit us on shift_close_denominations.total). NOT the
    // same as EXTRA='DEFAULT_GENERATED' (a plain DEFAULT), which stays included.
    const [colRows] = await conn.query(
      `SELECT COLUMN_NAME AS name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ?
          AND EXTRA NOT REGEXP 'VIRTUAL GENERATED|STORED GENERATED'
        ORDER BY ORDINAL_POSITION`, [t]);
    const cols = colRows.map((r) => r.name);
    const colSql = cols.map((c) => escapeId(c)).join(',');
    const selectSql = `SELECT ${colSql} FROM ${escapeId(t)}`;

    for (let off = 0; ; off += CHUNK) {
      let rows;
      try {
        [rows] = await conn.query(`${selectSql} LIMIT ${CHUNK} OFFSET ${off}`);
      } catch (e) {
        if (!isConnLoss(e)) throw e;
        manifest.consistent = false; // snapshot broken — dump completes, atomicity lost
        console.warn(`  ! connection lost on ${t} @${off} — reconnecting (dump becomes non-atomic)`);
        try { conn.destroy(); } catch {}
        conn = await freshConn();
        [rows] = await conn.query(`${selectSql} LIMIT ${CHUNK} OFFSET ${off}`);
      }
      if (!rows.length) break;
      const vals = rows.map((r) => '(' + cols.map((c) => escape(r[c])).join(',') + ')');
      w(`INSERT INTO ${escapeId(t)} (${colSql}) VALUES\n` + vals.join(',\n') + ';');
      written += rows.length;
      if (rows.length < CHUNK) break;
    }
    manifest.tables[t] = { liveCount: Number(cnt.n), rowsWritten: written, ms: Date.now() - tick };
    console.log(`  ${t}: ${written}/${cnt.n} rows`);
    w('');
  }

  for (const vw of views) {
    const [[ddl]] = await conn.query(`SHOW CREATE VIEW ${escapeId(vw)}`);
    // DEFINER=`root`@`%` breaks restore onto a server without that account.
    const clean = ddl['Create View'].replace(/DEFINER=`[^`]*`@`[^`]*`\s*/g, '');
    w(`DROP VIEW IF EXISTS ${escapeId(vw)};`);
    w(clean + ';');
    manifest.views.push(vw);
    w('');
  }

  const [trigRows] = await conn.query('SHOW TRIGGERS');
  for (const tr of trigRows) {
    const [[ddl]] = await conn.query(`SHOW CREATE TRIGGER ${escapeId(tr.Trigger)}`);
    w(ddl['SQL Original Statement'].replace(/DEFINER=`[^`]*`@`[^`]*`\s*/g, '') + ';');
  }
  if (trigRows.length) w('');

  w('SET FOREIGN_KEY_CHECKS=1;');
  await conn.query('COMMIT');
  await conn.end();

  manifest.finishedAt = new Date().toISOString();
  manifest.bytes = fs.statSync(OUT).size;
  const mismatches = Object.entries(manifest.tables)
    .filter(([, x]) => x.liveCount !== x.rowsWritten);
  manifest.countMismatches = mismatches.map(([t]) => t);
  await new Promise((res) => out.end(res));
  fs.writeFileSync(OUT + '.manifest.json', JSON.stringify(manifest, null, 2));

  console.log(`\nDUMP ${mismatches.length === 0 && manifest.consistent ? 'OK' : 'DONE WITH WARNINGS'}`);
  console.log(`  file: ${OUT} (${(manifest.bytes / 1048576).toFixed(2)} MB)`);
  console.log(`  tables: ${tables.length}, views: ${views.length}, consistent snapshot: ${manifest.consistent}`);
  if (mismatches.length) console.log(`  COUNT MISMATCHES: ${manifest.countMismatches.join(', ')}`);
  process.exit(mismatches.length === 0 ? 0 : 1);
})().catch((e) => { console.error('DUMP FAILED:', e.message); process.exit(1); });
