/**
 * glSecurity.api.test.js — FC-P1 server-side GL security contract.
 *
 * Proves that the /api/erp/gl/* journal + account routes are now:
 *   1. RBAC-gated (requireCapability, permissions_v3) — a cashier is refused
 *      create/post/reverse/account-management with 403; a manager passes.
 *   2. actor-from-JWT — a spoofed body.username is IGNORED; created_by/posted_by
 *      are the authenticated user.
 *   3. posted-immutable — PUT on a posted journal → 409; /unpost → 409.
 *   4. server-validated — a line on a non-leaf or inactive account → 400; a
 *      bad-type / oversize attachment → 400.
 *
 * Spawns its own server (PORT 3241) against the .env DB. Creates a handful of
 * GLSEC-* accounts + journals and deletes them at the end (self-cleaning).
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const ENV = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2];
}
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const PORT = 3241;
const BASE = `http://127.0.0.1:${PORT}`;

const T = {
  admin:   jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
  manager: jwt.sign({ id: 900201, username: 'glsec_mgr', role: 'manager', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
  cashier: jwt.sign({ id: 900202, username: 'glsec_cash', role: 'cashier', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
};

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}

async function waitUp(secs) {
  for (let i = 0; i < secs; i++) {
    try { const r = await fetch(BASE + '/api/version'); if (r.ok) return true; } catch (_) {}
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}

function api(method, pathname, tok, body) {
  return fetch(BASE + '/api' + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
async function j(method, pathname, tok, body) {
  const r = await api(method, pathname, tok, body);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

async function main() {
  console.log('\n═══ GL security contract (RBAC · JWT actor · immutable · validation) ═══\n');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });

  const madeAccounts = [];
  const madeJournals = [];

  try {
    check('server up', await waitUp(240));

    // ── Fixtures (admin) ─────────────────────────────────────────────────────
    // Two active leaves, one inactive leaf, and a parent made non-leaf by a child.
    // NOTE: gl_accounts.code is a short column, so ids are long/unique but the
    // `code` we send is a short per-account token.
    const sfx = String(Date.now()).slice(-5);
    const A = 'GLSEC-A-' + sfx, cA = '9A' + sfx;
    const B = 'GLSEC-B-' + sfx, cB = '9B' + sfx;
    const INACT = 'GLSEC-I-' + sfx, cI = '9I' + sfx;
    const PARENT = 'GLSEC-P-' + sfx, cP = '9P' + sfx;
    const CHILD = 'GLSEC-C-' + sfx, cC = '9C' + sfx;
    for (const [id, code, extra] of [
      [A, cA, {}], [B, cB, {}], [INACT, cI, { isActive: false }], [PARENT, cP, { isFolder: true }],
    ]) {
      const r = await j('POST', '/erp/gl/accounts', T.admin, {
        id, code, nameAr: id, type: 'asset', parentId: null, level: 1, ...extra,
      });
      madeAccounts.push(id);
      if (r.data && r.data.success === false) check('fixture account ' + id, false, r.data);
    }
    // child under PARENT → PARENT becomes non-leaf
    await j('POST', '/erp/gl/accounts', T.admin, { id: CHILD, code: cC, nameAr: CHILD, type: 'asset', parentId: PARENT, level: 2 });
    madeAccounts.push(CHILD);

    // reverse resolves accounts by CODE (lib/glPosting), so entries must carry
    // the real account code, not the id.
    const codeOf = { [A]: cA, [B]: cB, [INACT]: cI, [PARENT]: cP };
    const balanced = (dAcc, cAcc) => ([
      { accountId: dAcc, accountCode: codeOf[dAcc], accountName: dAcc, debit: 100, credit: 0 },
      { accountId: cAcc, accountCode: codeOf[cAcc], accountName: cAcc, debit: 0, credit: 100 },
    ]);

    // ── 1. RBAC — cashier is refused, manager passes ─────────────────────────
    const cashCreate = await j('POST', '/erp/gl/journals', T.cashier, { journalDate: '2026-01-05', description: 'x', entries: balanced(A, B) });
    check('cashier create journal → 403', cashCreate.status === 403, cashCreate);
    const cashAcct = await j('POST', '/erp/gl/accounts', T.cashier, { code: 'Z', nameAr: 'Z', type: 'asset' });
    check('cashier manage account → 403', cashAcct.status === 403, { status: cashAcct.status });

    const mgrCreate = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'mgr create', username: 'HACKER', entries: balanced(A, B),
    });
    check('manager create journal → ok', mgrCreate.data && mgrCreate.data.success === true, mgrCreate.data);
    const jid = mgrCreate.data && mgrCreate.data.id;
    if (jid) madeJournals.push(jid);

    // ── 2. actor from JWT — body.username='HACKER' ignored ───────────────────
    const listed = await j('GET', '/erp/gl/journals', T.manager);
    const row = Array.isArray(listed.data) ? listed.data.find((r) => r.id === jid) : null;
    check('created_by = JWT user (not body HACKER)', !!row && row.createdBy === 'glsec_mgr', row && { createdBy: row.createdBy });

    // ── 3. approve + post lifecycle (manager) ────────────────────────────────
    const appr = await j('POST', `/erp/gl/journals/${jid}/approve`, T.manager, { username: 'HACKER' });
    check('manager approve → ok', appr.data && appr.data.success === true, appr.data);
    const posted = await j('POST', `/erp/gl/journals/${jid}/post`, T.manager, {});
    check('manager post → ok', posted.data && posted.data.success === true, posted.data);
    // cashier cannot post
    const cashPost = await j('POST', `/erp/gl/journals/${jid}/post`, T.cashier, {});
    check('cashier post → 403', cashPost.status === 403, { status: cashPost.status });

    // ── 4. posted is immutable — PUT → 409, unpost → 409 ─────────────────────
    const putPosted = await j('PUT', `/erp/gl/journals/${jid}`, T.manager, {
      journalDate: '2026-01-06', description: 'edit posted', entries: balanced(A, B),
    });
    check('PUT posted journal → 409', putPosted.status === 409, { status: putPosted.status, code: putPosted.data && putPosted.data.code });
    const unpost = await j('POST', `/erp/gl/journals/${jid}/unpost`, T.manager, {});
    check('unpost posted journal → 409', unpost.status === 409, { status: unpost.status, code: unpost.data && unpost.data.code });

    // cashier cannot reverse; manager can
    const cashRev = await j('POST', `/erp/gl/journals/${jid}/reverse`, T.cashier, { reason: 'x' });
    check('cashier reverse → 403', cashRev.status === 403, { status: cashRev.status });
    const mgrRev = await j('POST', `/erp/gl/journals/${jid}/reverse`, T.manager, { reason: 'correction' });
    check('manager reverse → ok', mgrRev.data && mgrRev.data.success === true, mgrRev.data);
    if (mgrRev.data && mgrRev.data.newJournalId) madeJournals.push(mgrRev.data.newJournalId);

    // ── 5. server-side line validation (manager create) ──────────────────────
    const nonLeaf = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'non-leaf', entries: balanced(PARENT, B),
    });
    check('post to non-leaf account → 400', nonLeaf.status === 400, { status: nonLeaf.status, err: nonLeaf.data && nonLeaf.data.error });
    const inactive = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'inactive', entries: balanced(INACT, B),
    });
    check('post to inactive account → 400', inactive.status === 400, { status: inactive.status, err: inactive.data && inactive.data.error });

    // ── 6. attachment validation ─────────────────────────────────────────────
    const badType = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'bad attach', attachment: 'data:text/plain;base64,AAAA', entries: balanced(A, B),
    });
    check('bad attachment type → 400', badType.status === 400, { status: badType.status });
    const huge = 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024);
    const bigAttach = await j('POST', '/erp/gl/journals', T.manager, {
      journalDate: '2026-01-05', description: 'huge attach', attachment: huge, entries: balanced(A, B),
    });
    check('oversize attachment → 400', bigAttach.status === 400, { status: bigAttach.status });

  } catch (e) {
    check('no exception', false, e && e.message);
    console.log(childLog.slice(-2000));
  } finally {
    // cleanup — delete journals (admin/dev) then accounts
    for (const id of madeJournals) { try { await api('DELETE', '/erp/gl/journals/' + id, T.admin); } catch (_) {} }
    for (const id of madeAccounts.reverse()) { try { await api('DELETE', '/erp/gl/accounts/' + id, T.admin); } catch (_) {} }
    child.kill('SIGKILL');
  }

  console.log(`\n─── ${_p} passed, ${_f} failed ───\n`);
  process.exit(_f ? 1 : 0);
}

main();
