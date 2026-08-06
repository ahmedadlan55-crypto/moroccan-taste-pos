/**
 * glDoublePost.api.test.js — FC-P1 proof that POST /api/erp/gl/journals/:id/post
 * is race-safe over HTTP. Before FC-P1 the handler read status, then applied
 * balance updates outside any transaction/lock, so N concurrent posts each saw
 * status='approved' and applied the balances N times (double-post).
 *
 * This fires N=20 concurrent posts at ONE approved journal and asserts:
 *   • exactly ONE request succeeds, the rest are rejected (already-posted / not-approved)
 *   • the debit account's stored balance moved by EXACTLY one journal's amount
 *   • the journal ends in status 'posted'
 *
 * Spawns its own server (PORT 3242) against the .env DB; self-cleans.
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
const PORT = 3242;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' });

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
function api(method, pathname, body) {
  return fetch(BASE + '/api' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
async function j(method, pathname, body) {
  const r = await api(method, pathname, body);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
async function balanceOf(id) {
  const r = await j('GET', '/erp/gl/accounts');
  const a = Array.isArray(r.data) ? r.data.find((x) => x.id === id) : null;
  return a ? Number(a.balance) || 0 : null;
}

async function main() {
  console.log('\n═══ GL double-post race (20 concurrent posts → single application) ═══\n');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });

  const A = 'GLDP-A-' + Date.now();
  const B = 'GLDP-B-' + Date.now();
  let jid = null;
  try {
    check('server up', await waitUp(240));

    await j('POST', '/erp/gl/accounts', { id: A, code: A, nameAr: A, type: 'asset', parentId: null });
    await j('POST', '/erp/gl/accounts', { id: B, code: B, nameAr: B, type: 'asset', parentId: null });

    const beforeA = await balanceOf(A);
    check('read initial balance', beforeA !== null, { beforeA });

    const created = await j('POST', '/erp/gl/journals', {
      journalDate: '2026-01-07', description: 'double-post probe',
      entries: [
        { accountId: A, accountCode: A, accountName: A, debit: 100, credit: 0 },
        { accountId: B, accountCode: B, accountName: B, debit: 0, credit: 100 },
      ],
    });
    jid = created.data && created.data.id;
    check('journal created', !!jid, created.data);
    const appr = await j('POST', `/erp/gl/journals/${jid}/approve`, {});
    check('journal approved', appr.data && appr.data.success === true, appr.data);

    // Fire N concurrent posts at the SAME approved journal.
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => j('POST', `/erp/gl/journals/${jid}/post`, {}))
    );
    const successes = results.filter((r) => r.data && r.data.success === true).length;
    check('exactly one post succeeded', successes === 1, { successes, of: N });

    const afterA = await balanceOf(A);
    check('debit balance moved by EXACTLY one journal (+100)', afterA - beforeA === 100, { beforeA, afterA, delta: afterA - beforeA });

    const listed = await j('GET', '/erp/gl/journals');
    const row = Array.isArray(listed.data) ? listed.data.find((r) => r.id === jid) : null;
    check('journal ends posted', !!row && row.status === 'posted', row && { status: row.status });

  } catch (e) {
    check('no exception', false, e && e.message);
    console.log(childLog.slice(-2000));
  } finally {
    try { if (jid) await api('DELETE', '/erp/gl/journals/' + jid); } catch (_) {}
    try { await api('DELETE', '/erp/gl/accounts/' + A); } catch (_) {}
    try { await api('DELETE', '/erp/gl/accounts/' + B); } catch (_) {}
    child.kill('SIGKILL');
  }

  console.log(`\n─── ${_p} passed, ${_f} failed ───\n`);
  process.exit(_f ? 1 : 0);
}

main();
