/* Final Warehouse Rollout E2E + guard. Proves the shell shows EXACTLY ONE
   warehouse section for AUTHORIZED users (V2 enabled AND Warehouse Scope), ZERO
   for users with no warehouse scope, the LEGACY inventory/warehouse UI is hidden
   for EVERYONE while V2 is on (rollback-internal only), and it FAILS if more than
   one warehouse item ever appears.

   Gate = V2 enabled AND Warehouse Scope (admin/dev = global; others = ≥1 granted
   warehouse). RBAC governs actions inside the v2 routes, not the nav. NOT canary.

   Boots server.js with WAREHOUSE_V2_ENABLED=1, WAREHOUSE_V2_CANARY_USERS=* (open),
   WAREHOUSE_SCOPE_ENFORCE=1. Part A hits the REAL endpoint (admin=global→allowed,
   a no-scope user→denied). Part B drives the REAL admin shell (authorized → 1 =
   /warehouse, legacy hidden). Part C mocks unauthorized (→ 0, legacy hidden). Part
   D mocks V2-off (→ legacy shown = rollback). Every DOM case asserts ≤1. Zero
   console errors.

   Run: node scripts/e2e-warehouse-single-nav.cjs   (MariaDB on 3307 must be running)
*/
'use strict';
const { chromium } = require('C:/tmp/warehouse-v2-inventory-transactions/node_modules/playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
try { require('dotenv').config(); } catch (_) {}
const jwt = require('jsonwebtoken');

const PORT = 3992;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, '..', 'artifacts', 'screenshots', 'warehouse-single-nav');
fs.mkdirSync(OUT, { recursive: true });
const adminTok = jwt.sign({ id: 0, username: 'admin', role: 'admin', isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: '2h' });
const noScopeTok = jwt.sign({ id: 999002, username: 'wh_noscope_test', role: 'employee' }, process.env.JWT_SECRET, { expiresIn: '2h' });

let pass = 0, fail = 0; const failures = [];
function check(name, cond, extra) { if (cond) { pass++; console.log('  ✅', name); } else { fail++; failures.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }
function api(pathname, token) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (s) => { let b = ''; s.on('data', (c) => b += c); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); r.end();
  });
}
function waitForServer() { return new Promise(async (res) => { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => { http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)); }); if (ok) return res(true); await new Promise((z) => setTimeout(z, 500)); } res(false); }); }

function countWarehouseNav(page) {
  return page.evaluate(() => {
    // element's OWN computed display (independent of the sidebar collapsing on mobile)
    function visible(el) { if (!el) return false; var s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; }
    var out = { v2: 0, legacy: 0, total: 0, v2Href: null, whEnabled: window._whV2Enabled, whActive: window._whV2Active };
    document.querySelectorAll('[data-wh-v2-link]').forEach(function (el) { if (visible(el)) { out.v2++; out.v2Href = el.getAttribute('href'); } });
    document.querySelectorAll('.nav-item.has-submenu[data-wh-legacy-nav]').forEach(function (el) { if (visible(el)) out.legacy++; });
    out.total = out.v2 + out.legacy;
    return out;
  });
}
async function loadShell(ctx, token, routeMock) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push('PAGEERR: ' + String(e).slice(0, 200)));
  if (routeMock) await page.route('**/api/warehouse-nav*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(routeMock) }));
  await ctx.addInitScript(([t]) => { try { localStorage.setItem('pos_token', t); localStorage.setItem('pos_session', JSON.stringify({ user: 'admin', role: 'admin' })); localStorage.setItem('pos_is_developer', '1'); localStorage.removeItem('wh_v2_flag'); localStorage.removeItem('wh_v2_allowed'); } catch (e) {} }, [token]);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => window._whV2Enabled !== undefined, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700);
  return { page, errs };
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Final warehouse rollout E2E (canary=*, gate=V2+Scope, V2=1) ═══\n');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'test', WAREHOUSE_V2_ENABLED: '1', POS_V2_ENABLED: '0', WAREHOUSE_SCOPE_ENFORCE: '1', WAREHOUSE_V2_CANARY_USERS: '*' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', (d) => { const s = String(d); if (/error|throw/i.test(s) && !/utf8mb4|AUDIT/.test(s)) process.stdout.write('[srv] ' + s); });
  let browser;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── Part A: REAL endpoint (gate = V2 + Warehouse Scope, not canary) ────
    const a1 = await api('/api/warehouse-nav', adminTok);
    check('API: admin (global scope) → v2Enabled=true & v2Allowed=true', a1.status === 200 && a1.body && a1.body.v2Enabled === true && a1.body.v2Allowed === true, a1.body);
    const a2 = await api('/api/warehouse-nav', noScopeTok);
    check('API: no-scope user → v2Enabled=true & v2Allowed=false', a2.status === 200 && a2.body && a2.body.v2Enabled === true && a2.body.v2Allowed === false, a2.body);

    browser = await chromium.launch();

    // ── Part B: authorized admin shell → exactly ONE (/warehouse) ──────────
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
      const { page, errs } = await loadShell(ctx, adminTok, null);
      const c = await countWarehouseNav(page);
      check('authorized: exactly ONE warehouse nav item', c.total === 1, c);
      check('authorized: the one item is «إدارة المستودعات» → /warehouse (legacy hidden)', c.v2 === 1 && c.legacy === 0 && c.v2Href === '/warehouse', c);
      check('authorized: NEVER more than one (invariant)', c.total <= 1, c);
      check('authorized: zero console errors', errs.filter((e) => !/favicon|manifest|401|ResizeObserver/.test(e)).length === 0, errs.slice(0, 4));
      await page.screenshot({ path: path.join(OUT, 'authorized-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
      const cm = await countWarehouseNav(page);
      check('authorized mobile: still ≤1 (v2 shown, legacy hidden)', cm.total <= 1 && cm.v2 === 1 && cm.legacy === 0, cm);
      await ctx.close();
    }

    // ── Part C: no-scope / unauthorized → ZERO, legacy hidden for everyone ─
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
      const { page, errs } = await loadShell(ctx, adminTok, { v2Enabled: true, v2Allowed: false });
      const c = await countWarehouseNav(page);
      check('unauthorized (no scope): /warehouse hidden AND legacy hidden → ZERO', c.v2 === 0 && c.legacy === 0 && c.total === 0, c);
      check('unauthorized: NEVER more than one (invariant)', c.total <= 1, c);
      check('unauthorized: zero console errors', errs.filter((e) => !/favicon|manifest|401|ResizeObserver/.test(e)).length === 0, errs.slice(0, 4));
      await page.screenshot({ path: path.join(OUT, 'noscope-zero-desktop.png') });
      await ctx.close();
    }

    // ── Part D: V2 OFF → legacy returns (rollback), v2 link hidden ─────────
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
      const { page } = await loadShell(ctx, adminTok, { v2Enabled: false, v2Allowed: false });
      const c = await countWarehouseNav(page);
      check('V2 OFF (rollback): /warehouse hidden, legacy shown (≤1)', c.v2 === 0 && c.legacy === 1 && c.total <= 1, c);
      await ctx.close();
    }

    console.log('\nScreenshots: ' + OUT);
  } catch (e) { console.error('FATAL', e && e.stack ? e.stack : e); fail++; }
  finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }
  console.log(`\n${fail === 0 ? '✅' : '❌'} warehouse-rollout: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
