'use strict';
/* Integration — /api/menu is no longer anonymous (real server + DB).
 *
 * What this locks in (menu-hardening):
 *   · The global /api gate (server.js) used to blanket-exempt everything under
 *     /menu so the POS could read the catalog without a token. That served
 *     every item's cost, margin inputs, tax flags and the base64 product image
 *     bytes to ANY anonymous caller. The exemption is gone: every /api/menu
 *     read now 401s without a Bearer token — the root list, /all, /categories
 *     and the single-item read alike.
 *   · A valid ERP token still gets its catalog (200, array), and the rows it
 *     gets carry NO imageData key (the "66MB rule" — bytes stay in MySQL; see
 *     tests/menuApiHardening.test.js for the router-level pin).
 *   · A CASHIER token keeps its catalog read: middleware/posPortalScope.js
 *     already allows GET /menu(/.*)? and was deliberately not widened — so a
 *     cashier write to /api/menu is still refused by the scope (403), never
 *     admitted by the gate change.
 *
 * Run: node tests/integration/menuAuth.api.test.js   (MySQL must be up)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3978;
const ADMIN = 'itest_menuauth_admin';
const CASHIER = 'itest_menuauth_cashier';
const PW = 'MenuAuth#Test!2026';
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j, raw: b }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function cleanup() {
  try { await db.query('DELETE FROM users WHERE username IN (?,?)', [ADMIN, CASHIER]); } catch (_) {}
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ /api/menu behind the JWT gate ═══');

    // ── (a) anonymous: every menu read is refused ──
    for (const p of ['/api/menu', '/api/menu/all', '/api/menu/categories', '/api/menu/combos', '/api/menu/SOME-ID']) {
      const r = await call('GET', p, null);
      check('anonymous GET ' + p + ' → 401', r.status === 401, { status: r.status, body: r.body });
    }
    const anonPost = await call('POST', '/api/menu', null, { name: 'HACKED', price: 1 });
    check('anonymous POST /api/menu → 401 (writes were already inline-verified; now the gate refuses first)',
      anonPost.status === 401, { status: anonPost.status, body: anonPost.body });
    // A junk token is not a token.
    const junk = await call('GET', '/api/menu', 'not-a-jwt');
    check('GET /api/menu with a malformed token → 401', junk.status === 401, { status: junk.status });

    // ── (b) a valid ERP token gets the catalog, byte-free ──
    const admin = await login(ADMIN);
    check('admin authenticates', !!admin);
    const list = await call('GET', '/api/menu', admin);
    check('admin GET /api/menu → 200 array', list.status === 200 && Array.isArray(list.body), { status: list.status });
    check('admin rows carry hasImage/imageVer and NO imageData key (bytes stay in MySQL)',
      Array.isArray(list.body) && list.body.every((r) => typeof r.hasImage === 'boolean' && 'imageVer' in r && !Object.prototype.hasOwnProperty.call(r, 'imageData')),
      Array.isArray(list.body) && list.body.length ? Object.keys(list.body[0]) : list.body);
    const all = await call('GET', '/api/menu/all', admin);
    check('admin GET /api/menu/all → 200 array', all.status === 200 && Array.isArray(all.body), { status: all.status });
    check('admin /all rows carry NO imageData key either',
      Array.isArray(all.body) && all.body.every((r) => !Object.prototype.hasOwnProperty.call(r, 'imageData')));
    const cats = await call('GET', '/api/menu/categories', admin);
    check('admin GET /api/menu/categories → 200 (the gate change broke no authed read)', cats.status === 200 && Array.isArray(cats.body), { status: cats.status });

    // ── (c) the cashier scope is untouched: reads allowed, writes refused ──
    const cashier = await login(CASHIER);
    check('cashier authenticates', !!cashier);
    const cList = await call('GET', '/api/menu', cashier);
    check('cashier GET /api/menu → 200 (posPortalScope allows GET /menu(/.*)?)', cList.status === 200 && Array.isArray(cList.body), { status: cList.status, body: cList.body });
    const cPost = await call('POST', '/api/menu', cashier, { name: 'HACKED', price: 1 });
    check('cashier POST /api/menu → 403 (scope was not widened by the gate change)', cPost.status === 403, { status: cPost.status, body: cPost.body });

    console.log(`\n${fail === 0 ? '✅' : '❌'} menuAuth: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
