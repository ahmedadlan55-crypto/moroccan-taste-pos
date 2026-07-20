/**
 * Owner D — bilingual-i18n-images. Proves lib/safeImageFetch.js's SSRF
 * guards WITHOUT depending on real network egress being available in
 * whatever environment runs this suite:
 *
 *   · rejects non-HTTPS before ever attempting a connection
 *   · rejects a non-allowlisted host before ever attempting a connection
 *   · _isPrivateIp() correctly classifies every range the spec calls out:
 *     RFC1918 (10/8, 172.16/12, 192.168/16), 127/8, 169.254/16 (link-local),
 *     100.64/10 (CGNAT), IPv6 ::1, fc00::/7 (ULA), fe80::/10 (link-local),
 *     and IPv4-mapped IPv6 forms of the above — plus that real public IPs
 *     are NOT flagged.
 *   · _resolveAndValidateHost() rejects a hostname that resolves to a
 *     private address (proven via a fake DNS lookup, not real network).
 *   · the mid-stream size cap (_readWithCap) is enforced against a REAL
 *     local plain-HTTP server — this exercises the actual byte-counting
 *     logic used in production, just decoupled from the SSRF/allowlist
 *     layer (which 127.0.0.1 would otherwise legitimately trip).
 *   · a response under the cap streams through untouched.
 *
 * No live app server needed. Run:
 *   node tests/integration/safeImageFetch.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const s = require('../../lib/safeImageFetch');

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); }
}
async function rejects(fn, pattern) {
  try { await fn(); return { threw: false }; }
  catch (e) { return { threw: true, message: e.message, matched: pattern ? pattern.test(e.message) : true }; }
}

(async () => {
  console.log('\n═══ safeImageFetch SSRF guards ═══\n');
  let exitCode = 0;
  let testServer = null;
  try {
    // ── protocol allowlist — must fail BEFORE any connection attempt ──
    const r1 = await rejects(() => s.fetchImageSafely('http://world.openfoodfacts.org/x.jpg'), /SSRF_BLOCKED/);
    check('rejects non-HTTPS', r1.threw && r1.matched, r1);

    const r2 = await rejects(() => s.fetchImageSafely('https://not-on-the-list.example.com/x.jpg'), /SSRF_BLOCKED.*allowlist/);
    check('rejects a non-allowlisted host', r2.threw && r2.matched, r2);

    const r3 = await rejects(() => s.fetchImageSafely('ftp://world.openfoodfacts.org/x.jpg'), /SSRF_BLOCKED/);
    check('rejects a non-https scheme (ftp)', r3.threw && r3.matched, r3);

    const r4 = await rejects(() => s.fetchImageSafely('not a url at all'), /SSRF_BLOCKED/);
    check('rejects a malformed URL', r4.threw && r4.matched, r4);

    check('ALLOWED_HOSTS is an allowlist, not a blocklist, and starts with exactly the spec\'d two hosts',
      s.ALLOWED_HOSTS instanceof Set &&
      s.ALLOWED_HOSTS.has('world.openfoodfacts.org') &&
      s.ALLOWED_HOSTS.has('images.openfoodfacts.org'),
      Array.from(s.ALLOWED_HOSTS));

    // ── _isPrivateIp — every range the spec calls out, tested directly ──
    const ipCases = [
      // RFC1918
      ['10.0.0.1', true, '10/8'], ['10.255.255.255', true, '10/8'],
      ['172.16.0.1', true, '172.16/12'], ['172.31.255.254', true, '172.16/12'], ['172.15.255.255', false, 'just below 172.16/12'], ['172.32.0.0', false, 'just above 172.16/12'],
      ['192.168.0.1', true, '192.168/16'], ['192.169.0.1', false, 'just above 192.168/16'],
      // loopback
      ['127.0.0.1', true, 'loopback'], ['127.255.255.255', true, 'loopback'],
      // link-local
      ['169.254.1.1', true, 'link-local'],
      // CGNAT
      ['100.64.0.1', true, 'CGNAT'], ['100.127.255.255', true, 'CGNAT'], ['100.63.255.255', false, 'just below CGNAT'], ['100.128.0.0', false, 'just above CGNAT'],
      // public
      ['8.8.8.8', false, 'public (Google DNS)'], ['1.1.1.1', false, 'public (Cloudflare)'], ['151.115.132.10', false, 'public (real OFF IP)'],
      // IPv6
      ['::1', true, 'IPv6 loopback'],
      ['fc00::1', true, 'IPv6 ULA fc00::/7'], ['fd00::1', true, 'IPv6 ULA fc00::/7 (fd range)'],
      ['fe80::1', true, 'IPv6 link-local'],
      ['2001:4860:4860::8888', false, 'public IPv6 (Google DNS)'],
      // IPv4-mapped IPv6
      ['::ffff:10.0.0.1', true, 'IPv4-mapped RFC1918'],
      ['::ffff:127.0.0.1', true, 'IPv4-mapped loopback'],
      ['::ffff:192.168.1.1', true, 'IPv4-mapped RFC1918'],
      ['::ffff:8.8.8.8', false, 'IPv4-mapped public'],
      // garbage
      ['not-an-ip', true, 'unparseable → fail closed'],
      ['', true, 'empty → fail closed'],
    ];
    let allIpOk = true;
    for (const [ip, expected, label] of ipCases) {
      const got = s._isPrivateIp(ip);
      if (got !== expected) allIpOk = false;
      check(`_isPrivateIp(${JSON.stringify(ip)}) [${label}] === ${expected}`, got === expected, { got });
    }
    check('ALL private-IP range checks passed as a set', allIpOk);

    // ── _resolveAndValidateHost rejects a hostname resolving to a private
    //    address — proven with a monkey-patched dns.lookup, no real network ──
    {
      const dns = require('dns').promises;
      const originalLookup = dns.lookup;
      dns.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
      try {
        const r = await rejects(() => s._resolveAndValidateHost('world.openfoodfacts.org'), /SSRF_BLOCKED.*private/);
        check('rejects a hostname that resolves to 127.0.0.1', r.threw && r.matched, r);
      } finally {
        dns.lookup = originalLookup;
      }
      dns.lookup = async () => [{ address: '10.1.2.3', family: 4 }];
      try {
        const r = await rejects(() => s._resolveAndValidateHost('world.openfoodfacts.org'), /SSRF_BLOCKED.*private/);
        check('rejects a hostname that resolves to a 10/8 private range', r.threw && r.matched, r);
      } finally {
        dns.lookup = originalLookup;
      }
      dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
      try {
        const addr = await s._resolveAndValidateHost('world.openfoodfacts.org');
        check('accepts a hostname that resolves to a public address', addr === '8.8.8.8', addr);
      } finally {
        dns.lookup = originalLookup;
      }
    }

    // ── size cap — REAL local HTTP server, exercising the actual
    //    mid-stream byte-counting logic (_readWithCap), independent of
    //    the SSRF allowlist (127.0.0.1 is correctly rejected by that
    //    layer — this proves the cap logic itself, not the allowlist) ──
    const SMALL_CAP = 1000; // bytes, small so the test is instant
    testServer = http.createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        // Stream 3x the cap in small chunks — Content-Length is intentionally
        // omitted so the only way to catch this is mid-stream counting.
        let sent = 0;
        const total = SMALL_CAP * 3;
        const chunk = Buffer.alloc(64, 1);
        const iv = setInterval(() => {
          if (sent >= total) { clearInterval(iv); res.end(); return; }
          res.write(chunk);
          sent += chunk.length;
        }, 0);
        req.on('close', () => clearInterval(iv));
      } else if (req.url === '/small') {
        const body = Buffer.alloc(SMALL_CAP - 100, 2);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(body);
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const port = testServer.address().port;

    const bigStream = await new Promise((resolve) => {
      http.get('http://127.0.0.1:' + port + '/big', (res) => resolve(res));
    });
    const bigResult = await rejects(() => s._readWithCap(bigStream, SMALL_CAP), /SIZE_CAP_EXCEEDED/);
    check('_readWithCap rejects mid-stream once the cap is exceeded (no Content-Length to trust)', bigResult.threw && bigResult.matched, bigResult);

    const smallStream = await new Promise((resolve) => {
      http.get('http://127.0.0.1:' + port + '/small', (res) => resolve(res));
    });
    const smallBuf = await s._readWithCap(smallStream, SMALL_CAP);
    check('_readWithCap passes through a response under the cap, byte-exact', smallBuf.length === SMALL_CAP - 100, smallBuf.length);

    check('MAX_BYTES is the spec\'d 5MB', s.MAX_BYTES === 5 * 1024 * 1024, s.MAX_BYTES);
  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack);
  } finally {
    if (testServer) { try { testServer.close(); } catch (_) {} }
  }

  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  process.exit(exitCode);
})();
