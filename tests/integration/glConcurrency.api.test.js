/**
 * Phase 3A.1 — GL journal-numbering concurrency test.
 *
 * Posts 100 GL journals CONCURRENTLY (each in its own db.withTransaction) and
 * proves the new DB-atomic numbering (lib/glPosting + gl_journal_seq):
 *   • every journal_number is unique (no duplicates),
 *   • every journal is balanced (Σdebit = Σcredit on its gl_entries),
 *   • exactly N journals persist (no loss / no overwrite),
 *   • no reliance on created_at ordering and NO sleeps anywhere.
 *
 * Run: node tests/integration/glConcurrency.api.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const mysql = require('mysql2/promise');
const db = require('../../db/connection');
const gl = require('../../lib/glPosting');

// Dedicated pool with an UNLIMITED queue so we can fire all N at once (the app
// pool caps queueLimit=50). 40 connections → 40-way real contention on the
// gl_journal_seq counter; the rest queue. This stresses the NUMBERING, not the
// pool config.
function _dbCfg() {
  const u = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (u) { try { const x = new URL(u); return { host: x.hostname, port: Number(x.port || 3306), user: decodeURIComponent(x.username || ''), password: decodeURIComponent(x.password || ''), database: (x.pathname || '/').slice(1) }; } catch (_) {} }
  return {
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || process.env.DB_NAME || 'moroccan_taste_pos',
  };
}
const tpool = mysql.createPool(Object.assign(_dbCfg(), { waitForConnections: true, connectionLimit: 40, queueLimit: 0, charset: 'utf8mb4' }));
// EXACT production transaction semantics (incl. bounded deadlock retry) — the
// factory is shared from db/connection so the mirror can never drift.
tpool.withTransaction = db.makeWithTransaction(tpool);

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }

const N = 100;
const AMT = 100;
const REF = 'GLCONC';

async function cleanup() {
  try { await db.query("DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type=?", [REF]); } catch (_) {}
  try { await db.query("DELETE FROM gl_journals WHERE reference_type=?", [REF]); } catch (_) {}
}

(async () => {
  console.log('\n═══ GL numbering concurrency (' + N + ' parallel posts) ═══\n');
  let exitCode = 0;
  try {
    // Mirror the boot migration (idempotent) so the test is self-sufficient.
    await db.query('CREATE TABLE IF NOT EXISTS gl_journal_seq (period_key VARCHAR(20) PRIMARY KEY, last_serial INT NOT NULL DEFAULT 0) ENGINE=InnoDB');
    await cleanup();
    // Pre-seed CORE accounts (1200/1210) so concurrent posters all resolve them.
    await gl.ensureCoreAccounts(db);

    const today = new Date().toISOString().slice(0, 10);
    const tasks = Array.from({ length: N }, (_, i) =>
      tpool.withTransaction(async (conn) =>
        gl.postJournal(conn, {
          journalDate: today,
          referenceType: REF,
          referenceId: 'GLC-' + i,
          description: 'concurrency probe ' + i,
          postedBy: 'gltester',
          entries: [
            { accountCode: gl.CORE_ACCOUNTS.INVENTORY.code, debit: AMT, credit: 0 },
            { accountCode: gl.CORE_ACCOUNTS.BRANCH_INVENTORY.code, debit: 0, credit: AMT },
          ],
        }),
      ),
    );
    const results = await Promise.all(tasks);
    const ok = results.filter((r) => r && r.success);
    check('all ' + N + ' postJournal calls succeeded', ok.length === N, { ok: ok.length, firstFail: results.find((r) => !r || !r.success) });

    const nums = ok.map((r) => r.journalNumber);
    check('returned journal numbers are all unique', new Set(nums).size === nums.length, { count: nums.length, unique: new Set(nums).size });

    // Verify persistence + balance straight from the DB.
    const [rows] = await db.query(
      "SELECT j.id, j.journal_number, " +
      "(SELECT COALESCE(SUM(debit),0)  FROM gl_entries WHERE journal_id=j.id) AS sd, " +
      "(SELECT COALESCE(SUM(credit),0) FROM gl_entries WHERE journal_id=j.id) AS sc " +
      "FROM gl_journals j WHERE j.reference_type=?", [REF]);
    check('exactly ' + N + ' journals persisted (no loss / no overwrite)', rows.length === N, rows.length);
    check('persisted journal_numbers all unique', new Set(rows.map((r) => r.journal_number)).size === rows.length);
    const balanced = rows.every((r) => Math.abs(Number(r.sd) - Number(r.sc)) < 0.01 && Math.abs(Number(r.sd) - AMT) < 0.01);
    check('every persisted journal is balanced (Σdebit = Σcredit = ' + AMT + ')', balanced);
    check('each journal has its 2 entries (no partial writes)', rows.every((r) => Number(r.sd) === AMT), { bad: rows.filter((r) => Number(r.sd) !== AMT).length });

    console.log('\n═══════════════════════════════════════════');
    console.log('Total: ' + (_p + _f) + ' | Passed: ' + _p + ' | Failed: ' + _f);
    console.log('═══════════════════════════════════════════');
    exitCode = _f > 0 ? 1 : 0;
  } catch (e) { console.error('FATAL', e); exitCode = 2; }
  finally { await cleanup(); try { await tpool.end(); } catch (_) {} }
  process.exit(exitCode);
})();
