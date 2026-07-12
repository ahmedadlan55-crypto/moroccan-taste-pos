/**
 * sse.security.test.js — Release Gate security contract for /api/sse/*.
 *
 * The live-inbox stream authenticates with `Authorization: Bearer` ONLY
 * (consumed client-side via fetch()+ReadableStream — EventSource cannot send
 * headers and credentials in URLs are forbidden). This suite proves:
 *   1. unauthenticated connect            → 401
 *   2. JWT in the query string (?token=)  → 401 (URL credentials rejected)
 *   3. cross-user stream (?username=X)    → 403 (stream bound to token user)
 *   4. Bearer connect                     → 200 text/event-stream + hello(me)
 *   5. disconnect                          → server cleans the connection slot
 *   6. reconnect works, no token in any URL used
 *   7. /health hides other users' presence from non-admins
 *
 * NOTE on the "SSE ticket" alternative: this implementation uses direct
 * header auth (no ticket endpoint), so ticket-expiry/single-use tests do not
 * apply — their guarantee (no reusable URL credential) is covered by #2:
 * URLs carry no credential at all.
 *
 * Spawns its own server (PORT 3240) against the .env DB. Read-only: opens
 * streams and health checks; writes nothing.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

// .env reader (no dotenv dependency in test scope)
const ENV = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2];
}
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const PORT = 3240;
const BASE = `http://127.0.0.1:${PORT}`;

const adminTok = jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' });
const otherTok = jwt.sign({ id: 999901, username: 'sse_ghost_user', role: 'cashier', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' });

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

// Open the SSE stream; resolve with {status, contentType, firstFrame, ctrl}
async function openStream(headers, qs) {
  const ctrl = new AbortController();
  const url = BASE + '/api/sse/inbox' + (qs || '');
  const resp = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
  const out = { status: resp.status, contentType: resp.headers.get('content-type') || '', firstFrame: '', ctrl, url };
  if (resp.ok && resp.body) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    const t0 = Date.now();
    let buf = '';
    while (Date.now() - t0 < 5000 && buf.indexOf('\n\n') === -1) {
      const race = await Promise.race([reader.read(), new Promise((z) => setTimeout(() => z(null), 5200))]);
      if (!race || race.done) break;
      buf += dec.decode(race.value, { stream: true });
    }
    out.firstFrame = buf;
  }
  return out;
}

async function health(tok) {
  const r = await fetch(BASE + '/api/sse/health', { headers: { Authorization: 'Bearer ' + tok } });
  return r.json();
}

async function main() {
  console.log('\n═══ SSE security contract (Bearer-only, user-bound, clean disconnect) ═══\n');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });

  try {
    check('server up', await waitUp(240));

    // 1 — no auth → 401
    const r1 = await fetch(BASE + '/api/sse/inbox');
    check('unauthenticated connect → 401', r1.status === 401, { status: r1.status });

    // 2 — JWT in query string → 401 (URL credentials are NOT accepted)
    const r2 = await fetch(BASE + '/api/sse/inbox?token=' + encodeURIComponent(adminTok));
    check('?token=<valid JWT> (no header) → 401', r2.status === 401, { status: r2.status });
    const r2b = await fetch(BASE + '/api/sse/inbox?username=admin&token=' + encodeURIComponent(adminTok));
    check('?username=&token= combo (no header) → 401', r2b.status === 401, { status: r2b.status });

    // 3 — cross-user stream → 403 (both directions)
    const r3 = await fetch(BASE + '/api/sse/inbox?username=admin', { headers: { Authorization: 'Bearer ' + otherTok } });
    check('user B + ?username=admin → 403', r3.status === 403, { status: r3.status });
    const r3b = await fetch(BASE + '/api/sse/inbox?username=sse_ghost_user', { headers: { Authorization: 'Bearer ' + adminTok } });
    check('admin + ?username=<other> → 403', r3b.status === 403, { status: r3b.status });

    // 4 — Bearer connect → stream bound to the token user
    const s4 = await openStream({ Authorization: 'Bearer ' + adminTok });
    check('Bearer connect → 200', s4.status === 200, { status: s4.status });
    check('content-type text/event-stream', s4.contentType.indexOf('text/event-stream') === 0, { ct: s4.contentType });
    check('hello frame carries the TOKEN user', s4.firstFrame.indexOf('event: hello') !== -1 && s4.firstFrame.indexOf('"username":"admin"') !== -1);

    // 5 — disconnect cleans the server-side slot (observed via /health)
    const h1 = await health(adminTok);
    check('health shows the live connection', (h1.byUser && h1.byUser.admin >= 1) === true, h1);
    s4.ctrl.abort();
    let cleaned = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((z) => setTimeout(z, 500));
      const h = await health(adminTok);
      if (!h.byUser || !h.byUser.admin) { cleaned = true; break; }
    }
    check('disconnect → connection slot cleaned within 5s', cleaned);

    // 6 — reconnect works; no URL ever carried a credential
    const s6 = await openStream({ Authorization: 'Bearer ' + adminTok });
    check('reconnect → 200 + hello again', s6.status === 200 && s6.firstFrame.indexOf('event: hello') !== -1);
    check('no credential in any stream URL', s4.url.indexOf('?') === -1 && s6.url.indexOf('?') === -1, { u1: s4.url, u2: s6.url });
    s6.ctrl.abort();

    // 7 — health privacy: non-admin gets no per-user breakdown
    const h7 = await health(otherTok);
    check('non-admin /health hides byUser', h7.byUser === undefined && typeof h7.activeConnections === 'number', h7);
  } catch (e) {
    check('suite ran without crashing', false, e.message);
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`Total: ${_p + _f} | Passed: ${_p} | Failed: ${_f}`);
  console.log('═══════════════════════════════════════════');
  process.exit(_f ? 1 : 0);
}

main();
