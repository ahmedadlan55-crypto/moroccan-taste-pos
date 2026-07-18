'use strict';
/* Integration — Custody ADMIN authority (real server + DB, synthesized fixtures).
 *
 * Covers the custody-officers management contract the new React screen fronts,
 * plus the mount/portal authorization boundary around custody self-service:
 *
 *   (1) DUPLICATE-LINK guard on POST /api/custody/users — a login account may be
 *       linked to at most ONE active custodian. A second active link → 409
 *       { code:'DUPLICATE_LINK' } and NO second row is written. Self is excluded
 *       on update, and a link frees up once the previous holder is deactivated.
 *
 *   (2) Mount + OR-check authorization around /api/custody/my-custody:
 *       • the /api/custody mount is requireRole('admin','manager','custody') —
 *         ROLE-ONLY. An employee-role user with custody_portal=1 is 403 at the
 *         MOUNT (self-service AND admin endpoints alike): the portal flag does
 *         NOT open the mount. ← documents a real gap: routes/custody.js:~210's
 *         `role==='custody' || custody_portal===1` OR-check is UNREACHABLE for a
 *         non-{admin,manager,custody} role, because server.js:750 blocks it first.
 *       • among mount-passing roles, the OR-check's custody_portal===1 branch IS
 *         the deciding factor: a MANAGER (role≠'custody') with custody_portal=1
 *         reaches self-service (eligible via the flag), while the same manager
 *         with custody_portal=0 and no linked custodian gets { noCustody:true }.
 *         → proves "the portal flag is sufficient for self-service without
 *         role==='custody'".
 *       • the custody HOLDER (role='custody') reaches self-service but is 403 on
 *         every admin /custody/users* endpoint → proves the portal/holder does
 *         NOT grant admin rights over other custodians.
 *
 * Run: node tests/integration/custodyAdmin.api.test.js   (port 3975)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3975;
const PW = 'Custody#Admin!2026';

// Fixture users (all ITEST-prefixed identifiers for safe cleanup).
const MGR = 'itest_ca_mgr';           // role manager — custody admin
const LINK1 = 'itest_ca_link1';       // login account to be linked to a custodian
const EMP_PORTAL = 'itest_ca_empportal';   // role employee + custody_portal=1
const CUST_ROLE = 'itest_ca_custrole';     // role custody
const MGR_PORTAL = 'itest_ca_mgrportal';   // role manager + custody_portal=1 (no linked row)
const MGR_NOPORTAL = 'itest_ca_mgrnoportal'; // role manager + custody_portal=0 (no linked row)
const ALL_USERS = [MGR, LINK1, EMP_PORTAL, CUST_ROLE, MGR_PORTAL, MGR_NOPORTAL];

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); }
}

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

const countActiveLinks = async (u) => {
  const [r] = await db.query('SELECT COUNT(*) n FROM custody_users WHERE linked_username=? AND is_active=1', [u]);
  return Number(r[0].n);
};

async function cleanup() {
  try {
    const [cus] = await db.query(
      "SELECT id FROM custody_users WHERE name LIKE 'ITEST-CA%' OR linked_username LIKE 'itest_ca_%'");
    for (const c of cus) {
      const [cds] = await db.query('SELECT id FROM custodies WHERE user_id=?', [c.id]);
      for (const cd of cds) {
        const [tops] = await db.query('SELECT id FROM custody_topups WHERE custody_id=?', [cd.id]);
        for (const t of tops) {
          const [js] = await db.query("SELECT id FROM gl_journals WHERE reference_type='custody_topup' AND reference_id=?", [t.id]);
          for (const j of js) {
            await db.query('DELETE FROM gl_entries WHERE journal_id=?', [j.id]).catch(() => {});
            await db.query('DELETE FROM gl_journals WHERE id=?', [j.id]).catch(() => {});
          }
        }
        await db.query('DELETE FROM custody_expenses WHERE custody_id=?', [cd.id]).catch(() => {});
        await db.query('DELETE FROM custody_topups WHERE custody_id=?', [cd.id]).catch(() => {});
        await db.query('DELETE FROM custodies WHERE id=?', [cd.id]).catch(() => {});
      }
    }
    await db.query("DELETE FROM custody_users WHERE name LIKE 'ITEST-CA%' OR linked_username LIKE 'itest_ca_%'").catch(() => {});
    await db.query("DELETE FROM gl_accounts WHERE name_ar LIKE 'عهدة ITEST-CA%'").catch(() => {});
    await db.query("DELETE FROM gl_accounts WHERE name_ar LIKE 'عهدة itest_ca_%'").catch(() => {});
  } catch (_) {}
  for (const u of ALL_USERS) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
}

async function mkUser(username, role, custodyPortal) {
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active,custody_portal) VALUES (?,?,?,1,?)',
    [username, hash, role, custodyPortal ? 1 : 0]);
}

(async () => {
  await cleanup();
  await mkUser(MGR, 'manager', 0);
  await mkUser(LINK1, 'employee', 0);
  await mkUser(EMP_PORTAL, 'employee', 1);
  await mkUser(CUST_ROLE, 'custody', 0);
  await mkUser(MGR_PORTAL, 'manager', 1);
  await mkUser(MGR_NOPORTAL, 'manager', 0);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ custody admin (duplicate-link + mount/portal authorization) ═══');

    const mgr = await login(MGR);
    const empPortal = await login(EMP_PORTAL);
    const custRole = await login(CUST_ROLE);
    const mgrPortal = await login(MGR_PORTAL);
    const mgrNoPortal = await login(MGR_NOPORTAL);
    check('fixtures authenticate (mgr / emp+portal / custody / mgr+portal / mgr-noportal)',
      !!mgr && !!empPortal && !!custRole && !!mgrPortal && !!mgrNoPortal);

    // ── (1) DUPLICATE-LINK guard on POST /custody/users ──────────────────────
    const c1 = await call('POST', '/api/custody/users', mgr, { name: 'ITEST-CA One', linkedUsername: LINK1 });
    check('(1) manager creates custodian #1 linked to LINK1', c1.body && c1.body.success === true && !!c1.body.id, c1.body);
    const id1 = c1.body && c1.body.id;
    check('(1) exactly one active custodian holds LINK1 after the first link', (await countActiveLinks(LINK1)) === 1);

    const dup = await call('POST', '/api/custody/users', mgr, { name: 'ITEST-CA Two', linkedUsername: LINK1 });
    check('(1) a SECOND active link to LINK1 is refused with 409 DUPLICATE_LINK',
      dup.status === 409 && dup.body && dup.body.code === 'DUPLICATE_LINK', { status: dup.status, body: dup.body });
    check('(1) …and NO second custodian row was written (still exactly one active link)',
      (await countActiveLinks(LINK1)) === 1);
    const [dupRows] = await db.query('SELECT COUNT(*) n FROM custody_users WHERE name=?', ['ITEST-CA Two']);
    check('(1) …the rejected "ITEST-CA Two" row does not exist at all', Number(dupRows[0].n) === 0, dupRows[0]);

    // Self is excluded on update — relinking a row to its OWN username is fine.
    const selfUpd = await call('POST', '/api/custody/users', mgr, { id: id1, name: 'ITEST-CA One Edited', linkedUsername: LINK1 });
    check('(1) updating custodian #1 to keep its OWN link is allowed (self excluded)',
      selfUpd.body && selfUpd.body.success === true, selfUpd.body);

    // is_active=1 scoping — deactivate #1, then the link is free to reuse.
    const off1 = await call('POST', '/api/custody/users/' + encodeURIComponent(id1) + '/toggle', mgr, {});
    check('(1) custodian #1 can be deactivated', off1.body && off1.body.success === true, off1.body);
    check('(1) …no ACTIVE custodian holds LINK1 while #1 is inactive', (await countActiveLinks(LINK1)) === 0);
    const c3 = await call('POST', '/api/custody/users', mgr, { name: 'ITEST-CA Three', linkedUsername: LINK1 });
    check('(1) a NEW custodian may take LINK1 once the previous holder is inactive',
      c3.body && c3.body.success === true, c3.body);
    check('(1) …and again exactly one active custodian holds LINK1', (await countActiveLinks(LINK1)) === 1);

    // ── (2) mount + OR-check authorization ───────────────────────────────────
    // Employee + custody_portal=1 → 403 at the MOUNT (portal flag ≠ mount pass).
    const empSelf = await call('GET', '/api/custody/my-custody', empPortal);
    check('(2) employee+custody_portal=1 is 403 at the mount on self-service (documents the gap)',
      empSelf.status === 403, { status: empSelf.status, body: empSelf.body });
    const empAdmin = await call('GET', '/api/custody/users', empPortal);
    check('(2) employee+custody_portal=1 is 403 on admin endpoints too (mount role-only)',
      empAdmin.status === 403, { status: empAdmin.status });

    // Manager+portal reaches self-service via the custody_portal===1 branch
    // (role≠'custody'); manager-without-portal (no linked row) is NOT eligible.
    const mgrPortalSelf = await call('GET', '/api/custody/my-custody', mgrPortal);
    check('(2) manager+custody_portal=1 (role≠custody) reaches self-service via the portal-flag branch',
      mgrPortalSelf.status === 200 && mgrPortalSelf.body && mgrPortalSelf.body.success === true,
      { status: mgrPortalSelf.status, body: mgrPortalSelf.body && { success: mgrPortalSelf.body.success, noCustody: mgrPortalSelf.body.noCustody } });
    const mgrNoPortalSelf = await call('GET', '/api/custody/my-custody', mgrNoPortal);
    check('(2) manager+custody_portal=0 with no linked custodian is NOT eligible (noCustody)',
      mgrNoPortalSelf.status === 200 && mgrNoPortalSelf.body && mgrNoPortalSelf.body.noCustody === true,
      { status: mgrNoPortalSelf.status, body: mgrNoPortalSelf.body });

    // The custody HOLDER reaches self-service but has NO admin authority.
    const custSelf = await call('GET', '/api/custody/my-custody', custRole);
    check('(2) the custody holder reaches their own self-service portal',
      custSelf.status === 200 && custSelf.body && custSelf.body.success === true,
      { status: custSelf.status, body: custSelf.body && { success: custSelf.body.success, noCustody: custSelf.body.noCustody } });
    const custList = await call('GET', '/api/custody/users', custRole);
    check('(2) the custody holder is 403 on GET /custody/users (admin directory)', custList.status === 403, { status: custList.status });
    const custCreate = await call('POST', '/api/custody/users', custRole, { name: 'ITEST-CA Hacker' });
    check('(2) the custody holder is 403 on POST /custody/users (create custodian)', custCreate.status === 403, { status: custCreate.status });
    const custToggle = await call('POST', '/api/custody/users/' + encodeURIComponent(id1) + '/toggle', custRole, {});
    check('(2) the custody holder is 403 on POST /custody/users/:id/toggle', custToggle.status === 403, { status: custToggle.status });
    const custDelete = await call('DELETE', '/api/custody/users/' + encodeURIComponent(id1), custRole);
    check('(2) the custody holder is 403 on DELETE /custody/users/:id', custDelete.status === 403, { status: custDelete.status });
    // The holder's blocked create must not have leaked a row.
    const [hackRows] = await db.query('SELECT COUNT(*) n FROM custody_users WHERE name=?', ['ITEST-CA Hacker']);
    check('(2) …the holder\'s blocked create wrote nothing', Number(hackRows[0].n) === 0, hackRows[0]);

    console.log(`\n${fail === 0 ? '✅' : '❌'} custodyAdmin: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
