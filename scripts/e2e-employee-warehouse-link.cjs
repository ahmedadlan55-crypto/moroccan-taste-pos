/* Final Warehouse Rollout — employee-portal gap closure E2E.

   Proves the «إدارة المستودعات» entry in the EMPLOYEE portal (/employee/) appears
   ONLY for users the server confirms have Warehouse Scope (V2 enabled AND a
   warehouse assignment, via /api/warehouse-nav), is NEVER shown to cashiers or
   no-scope users, and — when clicked — opens /warehouse in the SAME session by
   mirroring the existing JWT (localStorage.pos_token) without any re-login.

   Gate (frontend) = server v2Allowed === true  AND  role !== 'cashier'.
   No new permission is granted: RBAC in the backend governs actions inside.

   Boots server.js with WAREHOUSE_V2_ENABLED=1 (real /api/warehouse-nav sanity),
   then drives the portal with the browser mocking /api/warehouse-nav to each
   persona's server-truth answer so the FRONTEND gate is what's under test.

   Matrix: {admin(scoped), employee(scoped), cashier(scoped), employee(no-scope)}
           × {desktop 1440, mobile 390}. Plus the same-session click assertion.
   Zero console errors. FAILS if a forbidden persona ever shows the link.

   Run: node scripts/e2e-employee-warehouse-link.cjs   (MariaDB on 3307 running)
*/
'use strict';
const { chromium } = require('C:/tmp/warehouse-v2-inventory-transactions/node_modules/playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
try { require('dotenv').config(); } catch (_) {}
const jwt = require('jsonwebtoken');

const PORT = 3993;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, '..', 'artifacts', 'screenshots', 'employee-warehouse-link');
fs.mkdirSync(OUT, { recursive: true });

const SECRET = process.env.JWT_SECRET;
function tok(payload) { return jwt.sign(payload, SECRET, { expiresIn: '2h' }); }
// Forged-but-valid JWTs (same secret) — id/role only; the personas' scope is
// supplied by the mocked /api/warehouse-nav so the test is DB-independent.
const T_ADMIN = tok({ id: 0, username: 'admin', role: 'admin', isDeveloper: true });
const T_EMP = tok({ id: 999501, username: 'emp_scoped_test', role: 'employee' });
const T_CASHIER = tok({ id: 999502, username: 'cashier_test', role: 'cashier' });
const T_NOSCOPE = tok({ id: 999503, username: 'emp_noscope_test', role: 'employee' });

let pass = 0, fail = 0; const failures = [];
function check(name, cond, extra) { if (cond) { pass++; console.log('  ✅', name); } else { fail++; failures.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }
function api(pathname, token) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (s) => { let b = ''; s.on('data', (c) => b += c); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); r.end();
  });
}
function waitForServer() { return new Promise(async (res) => { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => { http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)); }); if (ok) return res(true); await new Promise((z) => setTimeout(z, 500)); } res(false); }); }

// Loads /employee/ as a persona: seeds emp_token/emp_session, clears any mirror,
// mocks /api/warehouse-nav → navAnswer, waits for applyWhNav to settle.
async function loadEmployee(ctx, token, session, navAnswer) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push('PAGEERR: ' + String((e && e.stack) || e).slice(0, 300)));
  await page.route('**/api/warehouse-nav*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(navAnswer) }));
  // NOTE: addInitScript runs before EVERY document in the context (incl. the
  // /warehouse navigation in Part C). It must therefore only SEED the employee
  // session — it must NOT touch pos_token/pos_session, or it would wipe the very
  // mirror we navigate to assert. Fresh contexts already start with them empty.
  await ctx.addInitScript(([t, s]) => {
    try {
      localStorage.setItem('emp_token', t);
      localStorage.setItem('emp_session', s);
      try { const o = JSON.parse(s); localStorage.setItem('emp_role', o.role || ''); localStorage.setItem('emp_username', o.username || ''); } catch (_) {}
      localStorage.removeItem('emp_wh_v2_allowed');
    } catch (e) {}
  }, [token, JSON.stringify(session)]);
  await page.goto(BASE + '/employee/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#whNavBtn', { state: 'attached', timeout: 20000 }).catch(() => {});
  // Deterministically wait until applyWhNav() has SETTLED for this persona:
  //  • cashier → synchronous hide (role check, no fetch/cache write)
  //  • everyone else → the mocked /api/warehouse-nav has resolved and written
  //    the emp_wh_v2_allowed cache, so the button's display is now final.
  await page.waitForFunction(() => {
    const btn = document.getElementById('whNavBtn');
    if (!btn) return false;
    const role = (localStorage.getItem('emp_role') || '').toLowerCase();
    if (role === 'cashier') return true;
    return localStorage.getItem('emp_wh_v2_allowed') !== null;
  }, { timeout: 10000 }).catch(() => {});
  return { page, errs };
}
function btnState(page) {
  return page.evaluate(() => {
    const el = document.getElementById('whNavBtn');
    if (!el) return { present: false };
    const s = getComputedStyle(el);
    const visible = s.display !== 'none' && s.visibility !== 'hidden';
    return { present: true, visible, display: s.display, onclick: !!el.getAttribute('onclick'), label: (el.textContent || '').trim() };
  });
}
function cleanErrs(errs) { return errs.filter((e) => !/favicon|manifest|401|403|404|Failed to load resource|net::|ResizeObserver|my-profile|hr\/|home/i.test(e)); }

(async () => {
  if (!SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Employee-portal warehouse link E2E (gate = server-scope ∧ role≠cashier) ═══\n');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'test', WAREHOUSE_V2_ENABLED: '1', POS_V2_ENABLED: '0', WAREHOUSE_SCOPE_ENFORCE: '1', WAREHOUSE_V2_CANARY_USERS: '*' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', (d) => { const s = String(d); if (/error|throw/i.test(s) && !/utf8mb4|AUDIT/.test(s)) process.stdout.write('[srv] ' + s); });
  let browser;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── Part A: real /api/warehouse-nav still behaves (unchanged contract) ──
    const a1 = await api('/api/warehouse-nav', T_ADMIN);
    check('API: admin (global) → v2Enabled=true & v2Allowed=true', a1.status === 200 && a1.body && a1.body.v2Enabled === true && a1.body.v2Allowed === true, a1.body);
    const a2 = await api('/api/warehouse-nav', T_NOSCOPE);
    check('API: no-scope employee → v2Enabled=true & v2Allowed=false', a2.status === 200 && a2.body && a2.body.v2Enabled === true && a2.body.v2Allowed === false, a2.body);

    browser = await chromium.launch();

    const personas = [
      { key: 'admin-scoped', token: T_ADMIN, session: { username: 'admin', role: 'admin', isDeveloper: true }, nav: { v2Enabled: true, v2Allowed: true }, expectVisible: true },
      { key: 'employee-scoped', token: T_EMP, session: { username: 'emp_scoped_test', role: 'employee' }, nav: { v2Enabled: true, v2Allowed: true }, expectVisible: true },
      { key: 'cashier-scoped', token: T_CASHIER, session: { username: 'cashier_test', role: 'cashier' }, nav: { v2Enabled: true, v2Allowed: true }, expectVisible: false },
      { key: 'employee-noscope', token: T_NOSCOPE, session: { username: 'emp_noscope_test', role: 'employee' }, nav: { v2Enabled: true, v2Allowed: false }, expectVisible: false },
    ];
    const viewports = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }];

    for (const p of personas) {
      for (const v of viewports) {
        const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, locale: 'ar' });
        const { page, errs } = await loadEmployee(ctx, p.token, p.session, p.nav);
        const st = await btnState(page);
        const okVis = st.present && st.visible === p.expectVisible;
        check(`${p.key} @ ${v.name}: link ${p.expectVisible ? 'VISIBLE' : 'HIDDEN'}`, okVis, st);
        if (p.expectVisible && v.name === 'desktop') {
          check(`${p.key}: label is «إدارة المستودعات» family (warehouse)`, /مستودع|Warehouse/i.test(st.label || ''), st);
        }
        check(`${p.key} @ ${v.name}: zero console errors`, cleanErrs(errs).length === 0, cleanErrs(errs).slice(0, 4));
        await page.screenshot({ path: path.join(OUT, `${p.key}-${v.name}.png`) });
        await ctx.close();
      }
    }

    // ── Part C: same-session open — real click mirrors the JWT then routes to /warehouse ──
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
      const emp = personas[1];
      const { page } = await loadEmployee(ctx, emp.token, emp.session, emp.nav);
      // Stub /warehouse as a same-origin page so navigation completes without the built
      // SPA; localStorage persists across it, so we can read the mirror afterwards.
      await page.route('**/warehouse', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>wh-stub</title><body>warehouse</body>' }));
      const before = await page.evaluate(() => ({ pos: localStorage.getItem('pos_token'), emp: localStorage.getItem('emp_token'), sess: localStorage.getItem('emp_session') }));
      check('same-session: pos_token empty before click (proves it is mirrored, not pre-set)', !before.pos, { pos: before.pos });
      // REAL user click on the actual button; wait for the resulting navigation.
      await Promise.all([
        page.waitForURL('**/warehouse', { timeout: 8000 }).catch(() => {}),
        page.click('#whNavBtn'),
      ]);
      check('same-session: click navigated to /warehouse', /\/warehouse\b/.test(page.url()), page.url());
      const after = await page.evaluate(() => ({ pos: localStorage.getItem('pos_token'), posSess: localStorage.getItem('pos_session') }));
      check('same-session: emp_token mirrored → pos_token (identical JWT, no re-login)', after.pos && after.pos === before.emp, { pos: (after.pos || '').slice(0, 12), emp: (before.emp || '').slice(0, 12) });
      check('same-session: emp_session mirrored → pos_session', after.posSess && after.posSess === before.sess, after.posSess);
      await ctx.close();
    }

    // ── Part D: logout fully clears the mirrored session ──
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
      const emp = personas[1];
      const { page } = await loadEmployee(ctx, emp.token, emp.session, emp.nav);
      // Seed a mirrored session directly (as openWarehouse would have), then log out.
      const gone = await page.evaluate(() => {
        localStorage.setItem('pos_token', localStorage.getItem('emp_token'));
        localStorage.setItem('pos_session', localStorage.getItem('emp_session'));
        localStorage.setItem('emp_wh_v2_allowed', '1');
        // doLogout() ends with location.reload(); stub it so evaluate returns cleanly.
        const _reload = location.reload; try { Object.defineProperty(location, 'reload', { configurable: true, value: function () {} }); } catch (_) {}
        try { window.doLogout && window.doLogout(); } catch (_) {}
        return { emp: localStorage.getItem('emp_token'), pos: localStorage.getItem('pos_token'), posSess: localStorage.getItem('pos_session'), cache: localStorage.getItem('emp_wh_v2_allowed') };
      });
      check('logout: emp_token, pos_token, pos_session, wh-cache all cleared', !gone.emp && !gone.pos && !gone.posSess && !gone.cache, gone);
      await ctx.close();
    }

    console.log('\nScreenshots: ' + OUT);
  } catch (e) { console.error('FATAL', e && e.stack ? e.stack : e); fail++; }
  finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }
  console.log(`\n${fail === 0 ? '✅' : '❌'} employee-warehouse-link: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
