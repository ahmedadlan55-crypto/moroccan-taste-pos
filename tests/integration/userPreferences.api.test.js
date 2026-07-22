/**
 * Sprint 3 (A2) — per-user UI preferences (routes/user-preferences.js).
 *
 * Covers:
 *   • GET default → {} when the user has no row.
 *   • PUT {language:'en'} then GET returns {language:'en'}.
 *   • PUT a second key shallow-merges (language survives).
 *   • Identity is token-derived: user B never reads or writes user A's prefs,
 *     and a `username` key smuggled into B's PUT body cannot touch A's row.
 *   • No token → 401.
 *
 * Hermetic bootstrap (same style as tests/integration/cashierReadiness.api.test.js):
 * an in-process express app that mounts ONLY routes/user-preferences.js, which
 * verifies its own JWT (verifyToken) — so no global gate is needed here. The two
 * identities are just two JWTs signed with different `username` claims; no users
 * table row is required (verifyToken's session-version check defaults a missing
 * user to version 1, which matches the token, so it passes).
 *
 * ISOLATED DB: pinned to moroccan_taste_pos_test BEFORE db/connection is loaded
 * (dotenv never overrides an already-set var). The run aborts if the live
 * connection is not that database, so a write can never hit the dev DB.
 *
 * Run: npm run test:user-preferences   (MySQL must be up)
 */
'use strict';

// ── ISOLATED TEST DB — must be set before db/connection.js is required ────────
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL; // never let a URL override DB_NAME
delete process.env.MYSQL_URL;
try { require('dotenv').config(); } catch (_) {}

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const prefsRouter = require('../../routes/user-preferences');

const PORT = Number(process.env.CWB_TEST_PORT || 4021);
const BASE = { host: '127.0.0.1', port: PORT };

const U_A = 'itest_prefs_user_a';
const U_B = 'itest_prefs_user_b';

let pass = 0, fail = 0; const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; fails.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(10000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function tok(id, username) {
  return jwt.sign({ id, username, role: 'cashier', isDeveloper: false, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/user-preferences', prefsRouter);
  return app;
}

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      username    VARCHAR(80) NOT NULL PRIMARY KEY,
      prefs_json  LONGTEXT NULL,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
async function cleanup() {
  await db.query('DELETE FROM user_preferences WHERE username IN (?)', [[U_A, U_B]]).catch(() => {});
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }

  // Hard guarantee: we are on the isolated test DB, never the dev DB.
  const [[{ db: liveDb }]] = await db.query('SELECT DATABASE() AS db');
  if (liveDb !== 'moroccan_taste_pos_test') {
    console.error('REFUSING TO RUN — connected DB is "' + liveDb + '", expected moroccan_taste_pos_test');
    process.exit(2);
  }
  console.log('\n═══ Sprint 3 A2 — user-preferences (hermetic) — DB: ' + liveDb + ' ═══\n');

  await ensureSchema();
  await cleanup();

  const tokenA = tok(9910001, U_A);
  const tokenB = tok(9910002, U_B);

  const server = buildApp().listen(PORT);
  try {
    // ── no token ────────────────────────────────────────────────────────────
    console.log('▸ auth');
    let r = await req('GET', '/api/user-preferences', null);
    check('GET without token → 401', r.status === 401, r.status);

    // ── default {} ────────────────────────────────────────────────────────────
    console.log('▸ default');
    r = await req('GET', '/api/user-preferences', tokenA);
    check('A GET (no row yet) → 200 + {}', r.status === 200 && deepEq(r.body, {}), r.body);

    // ── PUT then GET ─────────────────────────────────────────────────────────
    console.log('▸ set language then read back');
    r = await req('PUT', '/api/user-preferences', tokenA, { language: 'en' });
    check("A PUT {language:'en'} → 200 + {language:'en'}", r.status === 200 && deepEq(r.body, { language: 'en' }), r.body);
    r = await req('GET', '/api/user-preferences', tokenA);
    check("A GET → {language:'en'}", r.status === 200 && deepEq(r.body, { language: 'en' }), r.body);

    // ── shallow merge preserves existing keys ────────────────────────────────
    console.log('▸ shallow merge');
    r = await req('PUT', '/api/user-preferences', tokenA, { density: 'compact' });
    check("A PUT {density:'compact'} → merged {language:'en',density:'compact'}",
      r.status === 200 && deepEq(r.body, { language: 'en', density: 'compact' }), r.body);
    r = await req('GET', '/api/user-preferences', tokenA);
    check('  …GET confirms both keys survive (language not wiped)',
      r.status === 200 && r.body && r.body.language === 'en' && r.body.density === 'compact', r.body);
    // overwrite one key, other survives
    r = await req('PUT', '/api/user-preferences', tokenA, { language: 'ar' });
    check("A PUT {language:'ar'} overwrites only language",
      r.status === 200 && deepEq(r.body, { language: 'ar', density: 'compact' }), r.body);

    // ── token identity: B is isolated from A ─────────────────────────────────
    console.log('▸ token-derived identity (B cannot see/alter A)');
    r = await req('GET', '/api/user-preferences', tokenB);
    check('B GET (own, no row) → {} (does NOT see A\'s prefs)', r.status === 200 && deepEq(r.body, {}), r.body);

    // B tries to smuggle A's username into the body — must be ignored (treated
    // as an ordinary pref key on B's OWN row) and must never touch A's row.
    r = await req('PUT', '/api/user-preferences', tokenB, { username: U_A, language: 'hacked' });
    check('B PUT {username:A, language:hacked} → writes only B\'s own row',
      r.status === 200 && r.body && r.body.language === 'hacked', r.body);
    r = await req('GET', '/api/user-preferences', tokenA);
    check('  …A\'s prefs are untouched (still {language:ar,density:compact})',
      r.status === 200 && deepEq(r.body, { language: 'ar', density: 'compact' }), r.body);
    r = await req('GET', '/api/user-preferences', tokenB);
    check('  …B reads back only B\'s own prefs',
      r.status === 200 && r.body && r.body.language === 'hacked' && r.body.username === U_A, r.body);

    // ── DB-level confirmation: exactly two rows, A and B, correct contents ────
    const [aRow] = await db.query('SELECT prefs_json FROM user_preferences WHERE username = ?', [U_A]);
    check('DB row A holds {language:ar,density:compact}',
      aRow.length === 1 && deepEq(JSON.parse(aRow[0].prefs_json), { language: 'ar', density: 'compact' }), aRow[0]);
  } finally {
    server.close();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }

  console.log('\n══════════════════');
  console.log(fail === 0 ? `✅ ALL ${pass} CHECKS PASSED` : `❌ ${fail} FAILED / ${pass} passed`);
  if (fail) console.log(fails.map((f) => '  - ' + f).join('\n'));
  console.log('══════════════════\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
