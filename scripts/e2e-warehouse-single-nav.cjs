/* Single-warehouse-nav E2E + guard. Proves the main shell shows EXACTLY ONE
   warehouse section and FAILS if more than one ever appears.

   Root cause fixed: _applyWhV2Nav() now hides the legacy inventory/warehouse
   submenu ([data-wh-legacy-nav]) whenever it shows the /warehouse link, and it
   decides per-user from the authenticated GET /api/warehouse-nav (canary), so:
     • canary-eligible (admin,5000) → «إدارة المستودعات» → /warehouse ; legacy HIDDEN
     • everyone else                → /warehouse hidden ; legacy stays (their UI)

   Boots server.js with WAREHOUSE_V2_ENABLED=1 + WAREHOUSE_V2_CANARY_USERS=admin,5000
   (mirrors prod). Part A hits the REAL endpoint per user. Part B drives the REAL
   admin shell (canary → 1 = /warehouse). Part C mocks /api/warehouse-nav→denied on
   the same session to exercise the non-canary branch (→ 1 = legacy). Every DOM case
   asserts visibleWarehouseItems ≤ 1 (the hard invariant). Zero console errors.

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

const PORT = 3991;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, '..', 'artifacts', 'screenshots', 'warehouse-single-nav');
fs.mkdirSync(OUT, { recursive: true });
const adminTok = jwt.sign({ id: 0, username: 'admin', role: 'admin', isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: '2h' });
const nonCanaryTok = jwt.sign({ id: 999001, username: 'wh_noncanary_test', role: 'manager' }, process.env.JWT_SECRET, { expiresIn: '2h' });

let pass = 0, fail = 0; const failures = [];
function check(name, cond, extra) { if (cond) { pass++; console.log('  ✅', name); } else { fail++; failures.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }
function api(pathname, token) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (s) => { let b = ''; s.on('data', (c) => b += c); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); r.end();
  });
}
function waitForServer() { return new Promise(async (res) => { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => { http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)); }); if (ok) return res(true); await new Promise((z) => setTimeout(z, 500)); } res(false); }); }

// count VISIBLE warehouse sidebar entries: the /warehouse link + the legacy group
function countWarehouseNav(page) {
  return page.evaluate(() => {
    // "shown by our toggle logic" — the element's OWN computed display, which is
    // independent of the sidebar being collapsed on mobile (an ancestor concern).
    // This is the correct measure of "how many warehouse sections are enabled".
    function visible(el) {
      if (!el) return false;
      var s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    }
    var out = { v2: 0, legacy: 0, total: 0, whActive: window._whV2Active, v2Href: null };
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
  // wait until _applyWhV2Nav has resolved (sets window._whV2Active) + sidebar present
  await page.waitForSelector('.sidebar', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => window._whV2Active !== undefined, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700); // let permission-based hiding settle
  return { page, errs };
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Single warehouse nav E2E (canary=admin,5000, V2=1) ═══\n');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'test', WAREHOUSE_V2_ENABLED: '1', POS_V2_ENABLED: '0', WAREHOUSE_SCOPE_ENFORCE: '0', WAREHOUSE_V2_CANARY_USERS: 'admin,5000' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', (d) => { const s = String(d); if (/error|throw/i.test(s) && !/utf8mb4/.test(s)) process.stdout.write('[srv] ' + s); });
  let browser;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── Part A: REAL endpoint truth (per-user canary) ──────────────────────
    const a1 = await api('/api/warehouse-nav', adminTok);
    check('API: admin(canary) → v2Enabled=true & v2Allowed=true', a1.status === 200 && a1.body && a1.body.v2Enabled === true && a1.body.v2Allowed === true, a1.body);
    const a2 = await api('/api/warehouse-nav', nonCanaryTok);
    check('API: non-canary(manager) → v2Enabled=true & v2Allowed=false', a2.status === 200 && a2.body && a2.body.v2Enabled === true && a2.body.v2Allowed === false, a2.body);

    browser = await chromium.launch();

    // ── Part B: REAL admin shell — canary → exactly ONE (/warehouse) ───────
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
      const { page, errs } = await loadShell(ctx, adminTok, null);
      const c = await countWarehouseNav(page);
      check('admin(canary): exactly ONE warehouse nav item', c.total === 1, c);
      check('admin(canary): the one item is the /warehouse link (legacy hidden)', c.v2 === 1 && c.legacy === 0 && c.v2Href === '/warehouse', c);
      check('admin(canary): NEVER more than one (invariant)', c.total <= 1, c);
      check('admin(canary): zero console errors', errs.filter((e) => !/favicon|manifest|401|ResizeObserver/.test(e)).length === 0, errs.slice(0, 4));
      await page.screenshot({ path: path.join(OUT, 'admin-canary-desktop.png') });
      // mobile viewport — still exactly one
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      const cm = await countWarehouseNav(page);
      check('admin(canary) mobile: still ≤1 warehouse item', cm.total <= 1 && cm.v2 === 1, cm);
      await page.screenshot({ path: path.join(OUT, 'admin-canary-mobile.png') });
      await ctx.close();
    }

    // ── Part C: non-canary branch (mock /api/warehouse-nav → denied) ───────
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
      const { page, errs } = await loadShell(ctx, adminTok, { v2Enabled: true, v2Allowed: false });
      const c = await countWarehouseNav(page);
      check('non-canary: /warehouse link is HIDDEN', c.v2 === 0, c);
      check('non-canary: shows the legacy section only (exactly one)', c.legacy === 1 && c.total === 1, c);
      check('non-canary: NEVER more than one (invariant)', c.total <= 1, c);
      check('non-canary: zero console errors', errs.filter((e) => !/favicon|manifest|401|ResizeObserver/.test(e)).length === 0, errs.slice(0, 4));
      await page.screenshot({ path: path.join(OUT, 'noncanary-legacy-desktop.png') });
      await ctx.close();
    }

    // ── Part D: flag OFF (V2 disabled) → legacy only, never the v2 link ────
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
      const { page } = await loadShell(ctx, adminTok, { v2Enabled: false, v2Allowed: true });
      const c = await countWarehouseNav(page);
      check('flag OFF: /warehouse hidden, legacy only (≤1)', c.v2 === 0 && c.total <= 1, c);
      await ctx.close();
    }

    console.log('\nScreenshots: ' + OUT);
  } catch (e) { console.error('FATAL', e && e.stack ? e.stack : e); fail++; }
  finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }
  console.log(`\n${fail === 0 ? '✅' : '❌'} warehouse-single-nav: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
