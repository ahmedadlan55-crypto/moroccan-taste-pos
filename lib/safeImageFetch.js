/**
 * lib/safeImageFetch.js — SSRF-safe HTTP(S) fetcher for the image sourcing
 * pipeline. Dependency-free like lib/s3Storage.js (only Node built-ins).
 *
 * This module is deliberately narrow: it does ONE thing — fetch bytes (or
 * JSON) from an ALLOWLISTED https host without letting the target
 * redirect it, DNS-rebind it, or flood it into fetching an internal
 * address. It does NOT decode images, validate magic bytes, or hash
 * anything — that's the caller's job (lib/image-sourcing-worker.js), kept
 * separate on purpose so this file stays auditable as "just safe transport".
 *
 * Defenses, applied on EVERY hop (including redirects):
 *   1. Protocol must be exactly 'https:'.
 *   2. Hostname must be in an explicit ALLOWLIST (never a blocklist).
 *   3. DNS-resolve the hostname and reject if ANY resolved address is
 *      private/loopback/link-local/CGNAT/ULA (see _isPrivateIp).
 *   4. Pin the TCP connection to the exact address we just validated via
 *      the `lookup` option — defeats a DNS-rebinding TOCTOU where the
 *      name resolves to a public IP during our check and a private IP
 *      when Node actually dials it.
 *   5. 8s hard timeout.
 *   6. 5MB hard cap enforced mid-stream on 'data' events — never trusts
 *      Content-Length alone.
 *   7. Redirects (3xx) are followed manually, capped at 3 hops, and the
 *      redirect target is re-validated from scratch (steps 1-4) — never
 *      blindly followed.
 *   8. Any non-2xx final status is rejected.
 *
 * Owner D — bilingual-i18n-images.
 */
'use strict';

const https = require('https');
const dns = require('dns').promises;
const net = require('net');

// ── 1. Explicit ALLOWLIST (never a blocklist) ─────────────────────────
const ALLOWED_HOSTS = new Set([
  'world.openfoodfacts.org',
  'images.openfoodfacts.org'
]);

const REQUEST_TIMEOUT_MS = 8000;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_REDIRECTS = 3;

// ─── Private/internal IP range checking ───────────────────────────────
function _ipv4ToLong(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function _ipv4InCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (_ipv4ToLong(ip) & mask) === (_ipv4ToLong(base) & mask);
}

/**
 * Returns true if `ip` is private/loopback/link-local/CGNAT/ULA (i.e. NOT
 * safe to let a background worker connect to). Fails CLOSED — anything it
 * cannot parse as a recognized public-range IPv4/IPv6 address is treated
 * as private. Exported for direct unit testing.
 */
function _isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  let addr = ip.trim();

  // IPv4-mapped IPv6 forms: ::ffff:a.b.c.d  (and the rarer ::a.b.c.d)
  const mapped = addr.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) addr = mapped[1];

  if (net.isIPv4(addr)) {
    if (_ipv4InCidr(addr, '10.0.0.0', 8)) return true;      // RFC1918
    if (_ipv4InCidr(addr, '172.16.0.0', 12)) return true;   // RFC1918
    if (_ipv4InCidr(addr, '192.168.0.0', 16)) return true;  // RFC1918
    if (_ipv4InCidr(addr, '127.0.0.0', 8)) return true;     // loopback
    if (_ipv4InCidr(addr, '169.254.0.0', 16)) return true;  // link-local
    if (_ipv4InCidr(addr, '100.64.0.0', 10)) return true;   // CGNAT (RFC6598)
    if (_ipv4InCidr(addr, '0.0.0.0', 8)) return true;       // "this" network
    return false;
  }

  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true; // loopback
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;               // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;                // fc00::/7 ULA
    return false;
  }

  return true; // unparseable → fail closed
}

function _validateUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    throw new Error('SSRF_BLOCKED: invalid URL');
  }
  if (u.protocol !== 'https:') {
    throw new Error('SSRF_BLOCKED: protocol must be https, got ' + u.protocol);
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error('SSRF_BLOCKED: host not in allowlist: ' + u.hostname);
  }
  return u;
}

/**
 * DNS-resolve hostname and reject if any candidate address is private.
 * Returns the address the caller should PIN the connection to.
 */
async function _resolveAndValidateHost(hostname) {
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    throw new Error('SSRF_BLOCKED: DNS resolution failed for ' + hostname + ': ' + e.message);
  }
  if (!records || !records.length) {
    throw new Error('SSRF_BLOCKED: no addresses resolved for ' + hostname);
  }
  for (const r of records) {
    if (_isPrivateIp(r.address)) {
      throw new Error('SSRF_BLOCKED: ' + hostname + ' resolved to a private/internal address (' + r.address + ')');
    }
  }
  return records[0].address;
}

/**
 * Reads a Node Readable stream into a Buffer, enforcing `maxBytes` MID-STREAM
 * (checked on every 'data' event) rather than trusting Content-Length. Pulled
 * out of _requestOnce so it can be exercised directly against a plain local
 * HTTP server in tests, independent of the SSRF allowlist/DNS-pinning logic.
 * Exported for direct unit testing.
 */
function _readWithCap(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    stream.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        if (typeof stream.destroy === 'function') stream.destroy();
        return done(reject, new Error('SIZE_CAP_EXCEEDED: response exceeded ' + maxBytes + ' bytes'));
      }
      chunks.push(chunk);
    });
    stream.on('end', () => done(resolve, Buffer.concat(chunks)));
    stream.on('error', (e) => done(reject, e));
  });
}

function _requestOnce(urlStr, pinnedIp) {
  const u = new URL(urlStr); // already validated by the caller
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      servername: u.hostname, // correct SNI/cert validation even though we pin the socket
      // Pin the TCP connection to the address we already validated — this is
      // what defeats a DNS-rebinding TOCTOU (defense #4 above). Node 18+'s
      // Happy Eyeballs connector calls this with options.all=true and expects
      // an ARRAY of {address,family} back, not the classic (err,address,family)
      // triple — support both shapes so this works across Node versions.
      lookup: (_hostname, options, callback) => {
        const family = net.isIPv6(pinnedIp) ? 6 : 4;
        if (options && options.all) {
          callback(null, [{ address: pinnedIp, family }]);
        } else {
          callback(null, pinnedIp, family);
        }
      },
      headers: {
        'User-Agent': 'MoroccanTastePOS-ImageSourcing/1.0 (+internal)',
        Accept: '*/*'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      const status = res.statusCode || 0;

      // Redirects — resolved by the caller so it can re-validate the target.
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return done(resolve, { redirectTo: res.headers.location });
      }

      if (status < 200 || status >= 300) {
        res.resume();
        return done(reject, new Error('HTTP_ERROR: non-2xx status ' + status));
      }

      const contentType = res.headers['content-type'] || '';
      _readWithCap(res, MAX_BYTES)
        .then((buffer) => done(resolve, { buffer, contentType }))
        .catch((e) => { req.destroy(); done(reject, e); });
    });

    req.on('timeout', () => {
      req.destroy();
      done(reject, new Error('TIMEOUT: request exceeded ' + REQUEST_TIMEOUT_MS + 'ms'));
    });
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}

/**
 * Core fetch used by both the binary and JSON entry points. Validates +
 * resolves + pins on every hop, follows redirects up to MAX_REDIRECTS.
 */
async function _fetchWithRedirects(urlStr) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = _validateUrl(current);               // protocol + allowlist
    const pinnedIp = await _resolveAndValidateHost(u.hostname); // DNS + private-IP check
    const result = await _requestOnce(u.toString(), pinnedIp);
    if (result.redirectTo) {
      if (hop === MAX_REDIRECTS) throw new Error('TOO_MANY_REDIRECTS: exceeded ' + MAX_REDIRECTS + ' hops');
      // Resolve relative Location headers against the current URL, then loop
      // back to the top so the NEW target gets the full validation again.
      current = new URL(result.redirectTo, current).toString();
      continue;
    }
    return result;
  }
  throw new Error('TOO_MANY_REDIRECTS: exceeded ' + MAX_REDIRECTS + ' hops');
}

/**
 * Fetch raw bytes from an allowlisted https URL. Returns
 * { buffer: Buffer, contentType: string }. Throws on any SSRF-guard
 * rejection, timeout, size-cap breach, or non-2xx status.
 */
async function fetchImageSafely(url) {
  const { buffer, contentType } = await _fetchWithRedirects(url);
  return { buffer, contentType };
}

/**
 * Fetch and JSON-parse an allowlisted https URL (e.g. the Open Food Facts
 * product API). Same allowlist/private-IP/redirect/size-cap guarantees as
 * fetchImageSafely — this is a thin sibling, not a separate code path.
 */
async function fetchJsonSafely(url) {
  const { buffer, contentType } = await _fetchWithRedirects(url);
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch (e) {
    throw new Error('INVALID_JSON: ' + e.message);
  }
  return { json, contentType };
}

module.exports = {
  fetchImageSafely,
  fetchJsonSafely,
  ALLOWED_HOSTS,
  MAX_BYTES,
  // Exported for direct unit testing (no network needed).
  _isPrivateIp,
  _validateUrl,
  _resolveAndValidateHost,
  _readWithCap
};
