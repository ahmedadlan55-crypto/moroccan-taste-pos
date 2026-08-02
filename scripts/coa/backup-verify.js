#!/usr/bin/env node
/**
 * Take a backup of the accounting-critical tables AND prove it restores.
 *
 * An untested backup is a belief, not a safety net. This dumps, then restores
 * the dump into a scratch database, then compares row counts and a content
 * checksum table by table. If the comparison fails the script exits non-zero
 * and says which table diverged — so "we have a backup" is a checked fact
 * before any migration touches real rows.
 *
 * Read-only with respect to the SOURCE database: it only ever SELECTs there.
 * The only database it writes to is the scratch one it creates and drops.
 *
 * Usage:
 *   node scripts/coa/backup-verify.js [--out <dir>] [--keep-scratch] [--all-tables]
 *
 * By default it covers the tables a CoA migration can damage. --all-tables
 * dumps the whole schema instead (slower, and the restore proof then covers
 * everything).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

// The tables a chart-of-accounts migration can plausibly damage, plus the
// ledger itself. Ordered parents-before-children only for readability; the
// dump handles ordering itself.
const CRITICAL_TABLES = [
  'gl_accounts', 'gl_entries', 'gl_journals',
  'account_roles', 'account_role_history',
  'accounting_periods', 'companies',
];

function findMysqlBin(name) {
  const fromEnv = process.env[name.toUpperCase() + '_PATH'];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const roots = ['C:/Program Files/MySQL', 'C:/Program Files (x86)/MySQL'];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const p = path.join(root, d, 'bin', name + '.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return name; // fall back to PATH
}

function argValue(args, name, dflt) {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
    database: process.env.DB_NAME,
  };
  if (!cfg.database) {
    console.error('✗ DB_NAME is not set — refusing to guess which database to back up.');
    process.exit(1);
  }

  const outDir = argValue(args, '--out', path.join(__dirname, '..', '..', 'artifacts', 'coa-backups'));
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = path.join(outDir, `${cfg.database}-${stamp}.sql`);
  const scratch = `${cfg.database}_restorecheck`;
  const allTables = args.includes('--all-tables');

  const mysqldump = findMysqlBin('mysqldump');
  const mysqlBin = findMysqlBin('mysql');

  // Credentials go through the environment, never argv — an argv password is
  // visible to every other process on the machine via the process list.
  const childEnv = { ...process.env, MYSQL_PWD: cfg.password };
  const conn = ['-h', cfg.host, '-P', String(cfg.port), '-u', cfg.user];

  console.log(`▶ dumping ${cfg.database} → ${path.basename(dumpFile)}`);
  const dumpArgs = [...conn, '--single-transaction', '--routines', '--events',
    '--default-character-set=utf8mb4', cfg.database];
  if (!allTables) dumpArgs.push(...CRITICAL_TABLES);
  const dump = spawnSync(mysqldump, dumpArgs, { env: childEnv, encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 });
  if (dump.status !== 0) {
    console.error('✗ mysqldump failed:\n' + String(dump.stderr || ''));
    process.exit(1);
  }
  fs.writeFileSync(dumpFile, dump.stdout);
  const sizeMb = (fs.statSync(dumpFile).size / 1048576).toFixed(2);
  console.log(`  wrote ${sizeMb} MB`);

  // ── restore into a scratch database and compare ──────────────────────────
  const admin = await mysql.createConnection({ ...cfg, database: undefined, multipleStatements: false });
  await admin.query(`DROP DATABASE IF EXISTS \`${scratch}\``);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  console.log(`▶ restoring into scratch database ${scratch}`);

  const restore = spawnSync(mysqlBin, [...conn, '--default-character-set=utf8mb4', scratch],
    { env: childEnv, input: fs.readFileSync(dumpFile), encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 });
  if (restore.status !== 0) {
    console.error('✗ restore failed — THE BACKUP IS NOT USABLE:\n' + String(restore.stderr || ''));
    await admin.query(`DROP DATABASE IF EXISTS \`${scratch}\``);
    await admin.end();
    process.exit(1);
  }

  // Row counts alone would pass a restore that silently corrupted values, so
  // each table is also compared by a checksum over its contents.
  const src = await mysql.createConnection(cfg);
  const dst = await mysql.createConnection({ ...cfg, database: scratch });
  const tables = allTables
    ? (await src.query('SHOW TABLES'))[0].map((r) => Object.values(r)[0])
    : CRITICAL_TABLES;

  let mismatches = 0;
  const rows = [];
  for (const t of tables) {
    const count = async (c) => {
      try { const [[r]] = await c.query(`SELECT COUNT(*) AS n FROM \`${t}\``); return r.n; }
      catch { return null; }
    };
    const checksum = async (c) => {
      try { const [[r]] = await c.query(`CHECKSUM TABLE \`${t}\``); return r.Checksum; }
      catch { return null; }
    };
    const [sn, dn] = [await count(src), await count(dst)];
    const [sc, dc] = [await checksum(src), await checksum(dst)];
    const ok = sn === dn && String(sc) === String(dc);
    if (!ok) mismatches++;
    rows.push({ table: t, sourceRows: sn, restoredRows: dn, checksumMatch: String(sc) === String(dc), ok });
  }
  console.table(rows);

  await src.end(); await dst.end();
  if (!args.includes('--keep-scratch')) {
    await admin.query(`DROP DATABASE IF EXISTS \`${scratch}\``);
    console.log(`  scratch database dropped`);
  } else {
    console.log(`  scratch database kept: ${scratch}`);
  }
  await admin.end();

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceDatabase: cfg.database, host: cfg.host,
    dumpFile: path.resolve(dumpFile), dumpSizeMb: Number(sizeMb),
    scope: allTables ? 'all-tables' : 'critical-tables',
    tables: rows, restoreVerified: mismatches === 0,
  };
  fs.writeFileSync(dumpFile.replace(/\.sql$/, '.verify.json'), JSON.stringify(manifest, null, 2));

  if (mismatches) {
    console.error(`\n✗ RESTORE PROOF FAILED — ${mismatches} table(s) differ after restore.`);
    console.error('  Do NOT run a migration against this database on the strength of this backup.\n');
    process.exit(1);
  }
  console.log(`\n✅ backup verified: ${rows.length} table(s) restored with identical row counts and checksums`);
  console.log(`   ${dumpFile}\n`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
