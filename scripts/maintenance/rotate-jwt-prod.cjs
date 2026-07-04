'use strict';
/*
 * تدوير JWT_SECRET على الإنتاج — عملية ذرّية مع اختبار واسترجاع تلقائي.
 *
 * لا يطبع/يحفظ أي سر. السر الجديد يُولّد في الذاكرة ويُضبط عبر stdin (لا في argv).
 * يحتاج: railway CLI مرتبطًا بمشروع الإنتاج، ويُشغّل من worktree فيه node_modules
 * (jsonwebtoken + https). حارس أمان: لا يعمل إلا بـ  CONFIRM_ROTATE_JWT=EXECUTE.
 *
 * التسلسل:
 *   1) يقرأ JWT_SECRET الحالي (railway variables --json) في الذاكرة → يسكّ توكن-قديم.
 *   2) يولّد سرًا جديدًا (64 بايت base64url ≈ 86 حرفًا ≥64).
 *   3) يضبطه على الإنتاج عبر stdin (يُطلق إعادة تشغيل).
 *   4) ينتظر إعادة التشغيل (/api/version.startedAt يتغيّر) + /ready 200.
 *   5) يشغّل حزمة الاختبار: /ready، login-alive، توكن قديم→401، توكن جديد→200،
 *      canary allow/deny، legacy محمي→200.
 *   6) إن فشلت الإشارات الجوهرية → استرجاع تلقائي (يعيد السر القديم) ويبلغ الفشل.
 */
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const jwt = require('jsonwebtoken');

const PROD_SERVICE = 'moroccan-taste-pos';
const BASE = process.env.PROD_BASE_URL || 'https://moroccan-taste-pos-production.up.railway.app';
const GUARD = process.env.CONFIRM_ROTATE_JWT === 'EXECUTE';

function req(method, p, headers, body) {
  return new Promise((res) => {
    const u = new URL(BASE + p);
    const data = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ host: u.hostname, path: u.pathname + u.search, method, headers: h, timeout: 15000 }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, json: j, raw: b }); });
    });
    r.on('error', (e) => res({ status: 0, err: String(e) }));
    r.on('timeout', () => { r.destroy(); res({ status: 0, err: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
function railwayJson(args) { return JSON.parse(execFileSync('railway', args, { encoding: 'utf8', windowsHide: true, shell: true })); }
function setSecretStdin(value) {
  // value flows via stdin — never in argv/logs. Triggers a redeploy (no --skip-deploys).
  const r = spawnSync('railway', ['variables', '--set-from-stdin', 'JWT_SECRET', '-s', PROD_SERVICE], { input: value, encoding: 'utf8', windowsHide: true, shell: true });
  return r.status === 0;
}
async function waitRestart(prevStartedAt, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await req('GET', '/api/version');
    if (v.status === 200 && v.json && v.json.startedAt && v.json.startedAt !== prevStartedAt) {
      // service is back on a NEW start — confirm readiness
      for (let i = 0; i < 24; i++) {
        const rd = await req('GET', '/api/inventory/v2/ready');
        if (rd.status === 200) return { ok: true, startedAt: v.json.startedAt, ready: rd.json };
        await sleep(5000);
      }
      return { ok: true, startedAt: v.json.startedAt, ready: null };
    }
    await sleep(5000);
  }
  return { ok: false };
}

(async () => {
  if (!GUARD) { console.error('REFUSING: set CONFIRM_ROTATE_JWT=EXECUTE to run the production JWT rotation.'); process.exit(2); }
  const results = {};
  const claimsAdmin = { id: 1, username: 'admin', role: 'admin', isDeveloper: true };
  const claimsNonCanary = { id: 999999, username: '__jwt_noncanary_probe__', role: 'employee' };

  // 0) baseline
  const v0 = await req('GET', '/api/version');
  if (v0.status !== 200 || !v0.json) { console.error('prod /api/version not reachable — aborting'); process.exit(2); }
  const startedAt0 = v0.json.startedAt;
  console.log('prod alive. startedAt(before)=', startedAt0, 'env=', v0.json.env);

  // 1) read current secret + mint OLD token
  const vars = railwayJson(['variables', '-s', PROD_SERVICE, '--json']);
  const oldSecret = vars.JWT_SECRET;
  if (!oldSecret) { console.error('current JWT_SECRET missing — aborting'); process.exit(2); }
  const oldLen = String(oldSecret).length;
  const oldToken = jwt.sign(claimsAdmin, oldSecret, { expiresIn: '10m' });
  console.log('read current secret (len=' + oldLen + ', not printed). minted old-secret admin token.');

  // sanity: old token works NOW (pre-rotation) on a protected endpoint
  const preOld = await req('GET', '/api/auth/template', { Authorization: 'Bearer ' + oldToken });
  console.log('pre-rotation old token → /api/auth/template:', preOld.status, '(expect 200 = current secret valid)');
  results.preRotationOldTokenStatus = preOld.status;

  // 2) generate NEW secret (>=64 chars)
  const newSecret = crypto.randomBytes(64).toString('base64url');
  console.log('generated new secret (len=' + newSecret.length + ', >=64, not printed).');
  const newTokenAdmin = jwt.sign(claimsAdmin, newSecret, { expiresIn: '10m' });
  const newTokenNonCanary = jwt.sign(claimsNonCanary, newSecret, { expiresIn: '10m' });

  // 3) SET on production via stdin → triggers restart
  console.log('setting JWT_SECRET on production via stdin (value not in argv)…');
  if (!setSecretStdin(newSecret)) { console.error('railway set failed — aborting (no change committed).'); process.exit(2); }

  // 4) wait for restart + ready
  console.log('waiting for production restart + /ready …');
  const restarted = await waitRestart(startedAt0, 240000);
  if (!restarted.ok) {
    console.error('restart/ready NOT confirmed within timeout → ROLLING BACK to old secret.');
    setSecretStdin(oldSecret);
    await waitRestart(restarted.startedAt || startedAt0, 240000);
    console.error('ROLLED BACK. verify manually.');
    process.exit(3);
  }
  console.log('restarted. startedAt(after)=', restarted.startedAt, '| ready tz=', restarted.ready && restarted.ready.checks && restarted.ready.checks.timezoneOffsetMin);

  // 5) TEST BATTERY (new secret in effect)
  const ready = await req('GET', '/api/inventory/v2/ready');
  const home = await req('GET', '/');
  const loginProbe = await req('POST', '/api/auth/login', {}, { username: '__jwt_probe__', password: 'x' });
  const oldTok = await req('GET', '/api/auth/template', { Authorization: 'Bearer ' + oldToken });
  const newTok = await req('GET', '/api/auth/template', { Authorization: 'Bearer ' + newTokenAdmin });
  const canaryAllow = await req('GET', '/api/inventory/v2/lots?pageSize=1', { Authorization: 'Bearer ' + newTokenAdmin });
  const canaryDeny = await req('GET', '/api/inventory/v2/lots?pageSize=1', { Authorization: 'Bearer ' + newTokenNonCanary });

  results.ready = { status: ready.status, tz: ready.json && ready.json.checks && ready.json.checks.timezoneOffsetMin };
  results.home = home.status;
  results.loginProbe = { status: loginProbe.status, success: loginProbe.json && loginProbe.json.success };
  results.oldTokenAfter = oldTok.status;          // expect 401
  results.newTokenAfter = newTok.status;          // expect 200
  results.canaryAllow = canaryAllow.status;       // expect 200
  results.canaryDeny = { status: canaryDeny.status, code: canaryDeny.json && canaryDeny.json.code }; // expect 403 V2_CANARY_DENIED

  const coreOk = ready.status === 200 && oldTok.status === 401 && newTok.status === 200;
  console.log('\n── post-rotation tests ──');
  console.log('/ready:', results.ready.status, 'tz=' + results.ready.tz, '(expect 200/180)');
  console.log('/ (home):', results.home, '(expect 200)');
  console.log('login probe (bad creds):', results.loginProbe.status, 'success=' + results.loginProbe.success, '(expect 200/false = alive)');
  console.log('OLD-secret token → protected:', results.oldTokenAfter, '(expect 401)');
  console.log('NEW-secret token → protected:', results.newTokenAfter, '(expect 200)');
  console.log('canary ALLOW (new admin) → v2/lots:', results.canaryAllow, '(expect 200)');
  console.log('canary DENY (new non-canary) → v2/lots:', results.canaryDeny.status, results.canaryDeny.code, '(expect 403 V2_CANARY_DENIED)');

  if (!coreOk) {
    console.error('\nCORE JWT SIGNALS FAILED → ROLLING BACK to old secret.');
    setSecretStdin(oldSecret);
    await waitRestart(restarted.startedAt, 240000);
    console.error('ROLLED BACK to previous secret. Investigate. Results:', JSON.stringify(results));
    process.exit(3);
  }
  console.log('\n✅ JWT_SECRET ROTATED on production. old tokens rejected (401), new tokens accepted (200), service healthy.');
  console.log('RESULTS:', JSON.stringify(results));
  console.log('NOTE: all active sessions were invalidated by design — users must re-login. Admin password UNCHANGED by this step.');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
