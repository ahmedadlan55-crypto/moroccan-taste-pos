/**
 * Phase 5B.1 — DB session-timezone integration test (real DB via db/connection).
 *
 * Proves the three-layer timezone fix without SET GLOBAL:
 *   1. EVERY pool connection has session offset = +180min (per-connection init).
 *   2. DATETIME round-trip is stable (write NOW → read back ≈ JS now, Riyadh).
 *   3. DATE-only (expiry) columns round-trip as the SAME calendar date (never
 *      shifted by timezone conversion).
 *   4. Day-boundary: a row stamped NOW() falls inside the CURDATE() day window
 *      used by reports/stocktake ranges; expiry classification agrees between
 *      SQL DATEDIFF(CURDATE()) and lib/expiryPolicy (Riyadh date-only).
 *   5. /ready gates on the EFFECTIVE session offset (200 here; and returns the
 *      offset so a drifted DB is visible immediately).
 *
 * Run: node tests/integration/dbTimezone.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const db = require('../../db/connection');
const EXP = require('../../lib/expiryPolicy');

const PORT = Number(process.env.TZ_TEST_PORT || 3195);
let _pass = 0, _fail = 0;
function check(name, cond, extra) {
  if (cond) { _pass++; console.log('  ✅', name); }
  else { _fail++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}
function get(path) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', () => resolve({ status: 0 }));
  });
}
async function waitUp() { for (let i = 0; i < 90; i++) { const r = await get('/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

const TBL = 'tz_test_5b1';

(async () => {
  console.log('\n═══ DB timezone (5B.1) ═══\n');

  // 1) every pooled connection carries the +03:00 session (grab several)
  const conns = await Promise.all([db.getConnection(), db.getConnection(), db.getConnection()]);
  try {
    for (let i = 0; i < conns.length; i++) {
      const [[r]] = await conns[i].query('SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) off, @@session.time_zone tz');
      check(`connection #${i + 1}: session offset = +180min`, Number(r.off) === 180, r);
    }
  } finally { conns.forEach((c) => c.release()); }

  // 2+3) round-trips
  await db.query(`DROP TABLE IF EXISTS ${TBL}`);
  await db.query(`CREATE TABLE ${TBL} (id INT PRIMARY KEY, dt DATETIME NULL, d DATE NULL, ts TIMESTAMP NULL DEFAULT NULL)`);
  const jsNow = new Date();
  await db.query(`INSERT INTO ${TBL} (id, dt, d, ts) VALUES (1, NOW(), '2026-12-31', NOW())`);
  const [[row]] = await db.query(`SELECT dt, d, ts, DATE_FORMAT(d, '%Y-%m-%d') dstr FROM ${TBL} WHERE id=1`);
  const dtDrift = Math.abs(new Date(row.dt).getTime() - jsNow.getTime());
  check('DATETIME NOW() round-trip ≈ JS now (drift < 15s)', dtDrift < 15000, { driftMs: dtDrift });
  check('TIMESTAMP round-trip ≈ JS now (drift < 15s)', Math.abs(new Date(row.ts).getTime() - jsNow.getTime()) < 15000);
  check("DATE-only column keeps its calendar date (expiry semantics, never shifted)", row.dstr === '2026-12-31', row.dstr);

  // 4) day-boundary: a NOW() row is inside today's CURDATE() window (report/stocktake pattern)
  const [[win]] = await db.query(`SELECT COUNT(*) n FROM ${TBL} WHERE dt >= CURDATE() AND dt < CURDATE() + INTERVAL 1 DAY`);
  check("NOW() row falls in today's CURDATE() day-window", Number(win.n) === 1, win);
  // expiry agreement: SQL DATEDIFF vs expiryPolicy daysUntil (both Riyadh date-only)
  const [[dd]] = await db.query("SELECT DATEDIFF('2026-12-31', CURDATE()) sqlDays");
  const jsDays = EXP.daysUntil('2026-12-31', new Date());
  check('SQL DATEDIFF(CURDATE()) == expiryPolicy.daysUntil (Riyadh date-only)', Number(dd.sqlDays) === jsDays, { sql: Number(dd.sqlDays), js: jsDays });
  // classification boundary sanity on the DB clock
  const [[today]] = await db.query('SELECT DATE_FORMAT(CURDATE(), "%Y-%m-%d") t');
  check('classify(today) = critical (0 days) on the DB calendar', EXP.classify(today.t, new Date()) === 'critical', today.t);

  // 5) /ready gates on effective session offset
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const ready = await get('/api/inventory/v2/ready');
    check('/ready → 200 with timezoneOk=true + offset=180', ready.status === 200 && ready.body.checks.timezoneOk === true && ready.body.checks.timezoneOffsetMin === 180, ready.body && ready.body.checks);
  } finally { try { server.kill(); } catch (_) {} }

  await db.query(`DROP TABLE IF EXISTS ${TBL}`);
  console.log('\n  ' + _pass + ' passed, ' + _fail + ' failed\n');
  try { if (db.pool && db.pool.end) await db.pool.end(); else if (db.end) await db.end(); } catch (_) {}
  process.exit(_fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); process.exit(1); });
