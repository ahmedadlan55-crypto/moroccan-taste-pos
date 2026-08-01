require('dotenv').config();

// v7.5 (H3) — surface a weak/missing JWT secret (forgeable tokens = full
// compromise). WARN-only (never blocks boot) to stay safe on launch day; rotate
// to a random 32+ char secret in the production environment, then restart during
// a maintenance window (rotation logs everyone out).
(function _checkJwtSecret(){
  try {
    var s = process.env.JWT_SECRET || '';
    var weak = !s || s.length < 32 || /change_in_production|local_dev|secret_key|abc123|xyz789|placeholder|example|changeme/i.test(s);
    if (weak) {
      console.warn('\n[SECURITY WARNING] JWT_SECRET is missing or weak — set a random 32+ char JWT_SECRET in the production environment.\n');
    }
  } catch (_) {}
})();
// v6.0.2 Wave B.1 — Force Asia/Riyadh timezone for the entire Node process
// so `new Date()`, MySQL CURRENT_TIMESTAMP fallbacks, and any log lines
// all default to Saudi local time (ZATCA BR-DT-03). Honours an explicit
// TZ env var if the operator overrides it.
process.env.TZ = process.env.TZ || 'Asia/Riyadh';
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const jwt = require('jsonwebtoken');
// The cashier-portal boundary applied by the global /api gate below. Required
// at the top (not lazily inside the handler) so a missing/broken module is a
// BOOT failure rather than a silently unguarded API at runtime.
const posPortalScope = require('./middleware/posPortalScope');

const app = express();
// v7.x SECURITY — trust the single Railway/reverse-proxy hop so req.ip is the
// REAL client IP. Without this, express-rate-limit and the login lockout key on
// the shared proxy IP → one attacker can lock out / DoS every user at once.
app.set('trust proxy', 1);
// Closure Sprint v2 — advanced security: optional IP allowlist (settings-backed,
// fails OPEN, and a no-op unless enabled AND non-empty) applied to every /api
// request. Configured from Administration › Security. trust proxy above makes
// req.ip the real client IP for the check.
try { app.use('/api', require('./routes/security-policies').ipAllowlistMiddleware()); }
catch (e) { console.warn('[security-ip-allowlist]', e.message); }
const PORT = process.env.PORT || 3000;

// RC cutover flag — when "0", the warehouse-v2 SPA serves a maintenance notice
// and v2 WRITE endpoints return 503 (legacy UI/API remains the sole writer →
// no dual-write, no data loss). Reads stay available. Default ENABLED.
const WAREHOUSE_V2_ENABLED = String(process.env.WAREHOUSE_V2_ENABLED || '1') !== '0';

// ═══════════════════════════════════════
// SECURITY MIDDLEWARE CHAIN
// ═══════════════════════════════════════

// 1. Compression
app.use(compression());

// 1b. Correlation ID — accept an inbound X-Request-Id or generate one; echo it on
// the response and expose req.requestId for structured logs + audit + support.
const { randomUUID } = require('crypto');
app.use(function (req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.requestId = (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// 1c. Phase 5B.1 — requests_total metrics middleware mounted BEFORE every /api
// route/gate so ALL outcomes are counted (incl. 401 from the auth gate and 429
// from the rate limiter). Labels: method / normalized_route / status_class —
// bounded cardinality, never the raw URL. (Previously mounted after the
// routers, which undercounted everything they handled.)
app.use('/api/', require('./routes/metrics')._trackRequest);

// 2. Security headers (Helmet)
app.use(helmet({
  contentSecurityPolicy: false,  // Disabled — app uses inline scripts/styles extensively
  referrerPolicy: { policy: 'same-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// 3. No-cache for JS/CSS + additional security headers
app.use(function(req, res, next) {
  if (req.path.match(/\.(js|css|html)$/) || req.path.endsWith('/') || !req.path.includes('.')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=self, microphone=()');
  next();
});

// 4. CORS — restricted to allowed origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, same-origin)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0) return callback(null, true); // If not configured, allow all (dev mode)
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    // Configured allow-list + origin not on it → deny (omit CORS headers so the
    // browser blocks the cross-origin response). Empty allow-list = dev allow-all.
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 5. Body parsing with size limits — 25MB allows ~18MB raw files (base64 expansion 1.37x)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// 6. Global rate limiter for ALL API requests
const _rateLimitStore = {}; // { ip: { count, windowStart } }
// Defaults are the production values (500 / 15 min / IP) and are UNCHANGED. They
// are env-overridable only so an automated sweep (the E2E gate walks all 89 routes
// in seconds from one IP — not human behaviour) doesn't throttle ITSELF and mask
// real screen failures behind 429s. A genuine 429 still fails the gate.
const RATE_LIMIT_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 500; // requests per window per IP
app.use('/api/', function(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  if (!_rateLimitStore[ip] || now - _rateLimitStore[ip].windowStart > RATE_LIMIT_WINDOW) {
    _rateLimitStore[ip] = { count: 1, windowStart: now };
  } else {
    _rateLimitStore[ip].count++;
  }
  if (_rateLimitStore[ip].count > RATE_LIMIT_MAX) {
    return res.status(429).json({ success: false, error: 'طلبات كثيرة جداً — انتظر قليلاً' });
  }
  // Cleanup old entries every 1000 requests
  if (Math.random() < 0.001) {
    Object.keys(_rateLimitStore).forEach(function(k) {
      if (now - _rateLimitStore[k].windowStart > RATE_LIMIT_WINDOW) delete _rateLimitStore[k];
    });
  }
  next();
});

// 7. Global JWT authentication for ALL API routes EXCEPT public ones
// 7. Global JWT authentication
// Auth module is FULLY public (login, refresh, init, users CRUD)
// Other modules require token except specific paths
app.use('/api/', async function(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  // Build full path for checking
  var p = req.path || '';

  // Best-effort identity for PUBLIC paths: if a valid Bearer token is present,
  // populate req.user before the public early-returns below. Some public paths'
  // handlers (or role guards mounted on their routers) read req.user when it is
  // available; without this, an authenticated caller on a public path would be
  // treated as anonymous. This NEVER blocks: absent/invalid tokens leave
  // req.user unset and public paths still proceed anonymously. Non-public paths are
  // still hard-verified (with the session-version gate) by the strict block below.
  try {
    var _pubAuth = req.headers['authorization'];
    if (_pubAuth && _pubAuth.startsWith('Bearer ')) {
      req.user = jwt.verify(_pubAuth.split(' ')[1], process.env.JWT_SECRET);
    }
  } catch (_) { /* anonymous — ignore invalid/expired token on public paths */ }

  // FULLY PUBLIC — no token needed
  if (p === '/version') return next();                 // v6.20.0 — deploy/version marker
  if (p === '/inventory/v2/ready') return next();      // RC — readiness probe (DB + schema)
  if (p.startsWith('/auth/')) return next();           // all auth endpoints
  // v8 SECURITY (G3) — /settings is public for GET ONLY: the login pages read
  // branding (company name / logo) before auth. Every non-GET /settings request
  // now goes through the JWT gate below. This is defense-in-depth on top of
  // routes/settings.js, whose writes ALL re-verify the token inline and require
  // admin/manager (verified: no legitimate anonymous write exists there).
  if (p.startsWith('/settings') && req.method === 'GET') return next();
  if (p.startsWith('/menu')) return next();            // menu
  // v7.5 (H1 SECURITY) — /hr/my-* is NO LONGER public. It now passes through the
  // JWT gate below so the employee is identified from their token, never from a
  // spoofable ?username=. The employee portal already sends "Authorization: Bearer".
  // v4 SECURITY — /workflow/* is NO LONGER public. The old exemption claimed
  // "auth checked inside"; routes/workflow.js contained ZERO guards, so
  // `GET /api/workflow/org-tree` returned the entire staff directory (names,
  // usernames, manager chain, branches) to any unauthenticated caller, and
  // `PUT /org-tree/:id` let anyone rewrite the manager chain and grant themselves
  // can_approve_txn. Worse: because the exemption meant req.user was never set,
  // guardAdmin/guardDeveloper "compensated" by trusting ?username= — so
  // `?username=admin` authenticated as admin with NO token, on routes including
  // DELETE /transactions/__wipe-all. Every caller (employee PWA, legacy admin,
  // api-bridge, React) already sends "Authorization: Bearer".
  // v8 SECURITY (G3) — /hr/departments and /hr/leave-types are NO LONGER public.
  // The exemptions exposed the org directory (department names, structure,
  // manager links) to any unauthenticated caller. Every known consumer — the
  // legacy admin api-bridge, the React ERP people module, and the employee PWA —
  // calls them AFTER login with "Authorization: Bearer"; no pre-login page reads
  // them (verified across public/ and frontend/).
  if (p.startsWith('/i18n/')) return next();           // V5.7.13 — translation proxy (login pages too)
  // v8 SECURITY (G3) — the /shifts/:id/full-report-print exemption is REMOVED.
  // It served the full financial shift report (sales, refunds, drawer counts) to
  // anyone who guessed/shared the URL. The route itself is being made
  // token-aware in a parallel change (the print tab carries a credential instead
  // of relying on a public path); until that lands, the report requires the
  // normal Authorization header like every other /api route.

  // Try to extract and verify JWT token — HEADER ONLY. Credentials are never
  // accepted from the URL/query string (they leak into access logs, browser
  // history and proxies). The SSE client consumes /api/sse/inbox via
  // fetch()+ReadableStream with a normal Authorization header instead of
  // EventSource (which cannot send headers) — see wfStartLiveInbox in
  // public/js/erp.js.
  var authHeader = req.headers['authorization'];
  var token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.split(' ')[1];
  if (token) {
    try {
      var decoded = jwt.verify(token, process.env.JWT_SECRET);
      // Phase A — session-version gate: a password change bumps users.token_version,
      // invalidating every token issued before it (revokes other sessions).
      // v8 SECURITY (G3) — this used to fail OPEN (`catch (_) {}` + isTokenCurrent's
      // internal null→true), so a DB hiccup ACCEPTED a REVOKED token. It now fails
      // CLOSED: server.js reads currentVersion() directly (the 15s in-memory cache
      // inside lib/sessionVersion stays the fast path — the DB is only hit on a
      // cache miss) and rejects with SESSION_CHECK_FAILED when the check cannot be
      // completed. Tokens without an id claim predate the feature and carry
      // nothing to check — same as isTokenCurrent's contract.
      try {
        const _sv = require('./lib/sessionVersion');
        if (decoded.id != null) {
          const _tokenVer = Number(decoded.tokenVersion != null ? decoded.tokenVersion : 1) || 1;
          const _cur = await _sv.currentVersion(decoded.id); // cached; null = the check itself failed
          if (_cur == null) {
            console.error('[auth] session-version check FAILED (DB/cache error in sessionVersion.currentVersion) for user id=' + decoded.id + ' — failing CLOSED');
            return res.status(401).json({ success: false, code: 'SESSION_CHECK_FAILED', error: 'تعذّر التحقق من الجلسة — يرجى المحاولة مجددًا' });
          }
          if (_tokenVer !== _cur) {
            return res.status(401).json({ success: false, error: 'انتهت الجلسة — يرجى تسجيل الدخول مجددًا' });
          }
        }
      } catch (svErr) {
        console.error('[auth] session-version check threw — failing CLOSED:', svErr && (svErr.code || svErr.message));
        return res.status(401).json({ success: false, code: 'SESSION_CHECK_FAILED', error: 'تعذّر التحقق من الجلسة — يرجى المحاولة مجددًا' });
      }
      req.user = decoded;
      // v8.1 SECURITY — the cashier portal boundary. Everything above this
      // line only AUTHENTICATES; each route file was trusted to authorize
      // itself and ~80 ERP endpoints never did, so a cashier's token was a
      // fully valid back-office token (company P&L, GL ledger, audit log —
      // and even POST /erp/periods/:label/close and /erp/vat/close-quarter,
      // all reachable with curl). This denies by default for POS-only roles
      // and allows exactly what the cashier app calls, so a NEW ERP route is
      // out of a cashier's reach the moment it is written.
      return posPortalScope(req, res, next);
    } catch (err) {
      // Token invalid/expired — fall through to block
    }
  }

  // No valid token — block
  return res.status(401).json({ success: false, error: 'غير مصرح — يرجى تسجيل الدخول' });
});

// Static files (frontend) — BEFORE API routes so they're not auth-gated
// ─── PWA static assets — explicit handlers BEFORE express.static ───
// MUST come before express.static below, otherwise static serves these
// files with its own mime-type detection (which produces application/json
// for manifest.json instead of the standard application/manifest+json)
// and does NOT add Service-Worker-Allowed header.
//
// We use fs.readFile + res.send (instead of res.sendFile) to control
// 100% of the response headers — Express's sendFile re-derives the
// Content-Type from the filename and overrides ours.
var _pwaFs = require('fs');
function sendStaticAsset(filePath, contentType, extraHeaders) {
  var absPath = path.join(__dirname, 'public', filePath);
  return function(req, res) {
    _pwaFs.readFile(absPath, function(err, data) {
      if (err) return res.status(404).send('Not found');
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // JS/CSS/JSON manifests need no-cache so updates flow immediately
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (extraHeaders) Object.keys(extraHeaders).forEach(function(k){ res.setHeader(k, extraHeaders[k]); });
      res.send(data);
    });
  };
}
function sendIconFile(folder) {
  return function(req, res) {
    var file = req.params.file || '';
    if (!/^[\w.-]+\.(svg|png|ico|webp|jpg|jpeg)$/i.test(file)) return res.status(404).send('Not found');
    var contentType = 'application/octet-stream';
    if (/\.svg$/i.test(file))  contentType = 'image/svg+xml';
    if (/\.png$/i.test(file))  contentType = 'image/png';
    if (/\.ico$/i.test(file))  contentType = 'image/x-icon';
    if (/\.webp$/i.test(file)) contentType = 'image/webp';
    if (/\.(jpg|jpeg)$/i.test(file)) contentType = 'image/jpeg';
    var absPath = path.join(__dirname, 'public', folder, 'icons', file);
    _pwaFs.readFile(absPath, function(err, data) {
      if (err) return res.status(404).send('Not found');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(data);
    });
  };
}

// ── Final cutover (FC-W3): the legacy /employee PWA is RETIRED — its writes
// live in the unified app (/app/people/self-service). Installed clients still
// hold its service worker, so /employee/sw.js now serves a TOMBSTONE: it
// sweeps the employee caches (mt-emp-*), unregisters itself, and reloads its
// windows — which then hit the /employee → /app redirect below. Cache filters
// are PREFIX-scoped because the Cache API is origin-global: an unqualified
// sweep here would nuke the POS offline caches too.
app.get('/employee/sw.js', function (req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/employee/');
  res.send(
    "self.addEventListener('install',function(){self.skipWaiting();});\n" +
    "self.addEventListener('activate',function(e){e.waitUntil((async function(){\n" +
    "  var keys=await caches.keys();\n" +
    "  await Promise.all(keys.filter(function(k){return k.indexOf('mt-emp-')===0;}).map(function(k){return caches.delete(k);}));\n" +
    "  await self.registration.unregister();\n" +
    "  var cs=await self.clients.matchAll({type:'window'});\n" +
    "  cs.forEach(function(c){ c.navigate(c.url); });\n" +
    "})());});\n");
});

// NOTE: the legacy /pos PWA asset handlers are GONE — /pos now serves the React
// cashier (see the SPA mount below). Its sw.js lives at the SAME URL the legacy
// SW was registered under, so installed registers update in place; its activate
// sweeps both mt-posv2-* and the orphaned legacy mt-pos-v* caches.

// Final cutover: "/" ALWAYS lands on the unified app. Registered BEFORE
// express.static; the legacy shell it used to serve is deleted.
app.get('/', function (req, res) { res.redirect(302, '/app/'); });

// Send no-cache for HTML + JS + CSS so users always get latest code
// (CDN libs are not affected — they use their own versioned URLs)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Standalone Warehouse (v2) SPA retired (Closure Sprint v2) — its features live in
// the unified ERP at /app (inventory + purchasing). Redirect old links there.
app.all(/^\/warehouse(?:-v2)?(?:\/.*)?$/, function (req, res) { res.redirect(302, '/app/inventory'); });

// ── Cashier React app — THE POS, served at /pos (final cutover) ──────────
// The legacy /pos PWA is deleted; the React cashier owns the path. Installed
// home-screen icons (start_url /pos/) open it directly, and its service worker
// replaces the legacy one at the identical registration URL /pos/sw.js.
// /pos-v2 (the strangler-era path) permanently redirects here so old links,
// bookmarks and cached SPAs converge on the one path. Rollback is a git/Railway
// release rollback — there is no legacy UI to flag back to.
app.all(/^\/pos-v2(\/.*)?$/, function (req, res) {
  res.redirect(301, '/pos' + (req.params[0] || ''));
});
app.use('/pos', function (req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "form-action 'self'"
  ].join('; '));
  next();
});
var _posDist = path.join(__dirname, 'frontend', 'pos', 'dist');
if (_pwaFs.existsSync(path.join(_posDist, 'index.html'))) {
  app.use('/pos', express.static(_posDist, {
    setHeaders: function(res, filePath) {
      // sw.js + manifests must NEVER cache: the SW update check and the
      // precache manifest are the app's only update channels.
      if (/(sw\.js|asset-manifest\.json|manifest\.webmanifest)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (/\.html$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (/[/\\]assets[/\\]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
  app.get(/^\/pos(?:\/.*)?$/, function(req, res, next) {
    if (/\.[a-zA-Z0-9]+$/.test(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(_posDist, 'index.html'));
  });
  console.log('[pos] React cashier SPA mounted at /pos');
} else {
  console.warn('[pos] bundle not found — run: npm --prefix frontend/pos run build');
}

// Standalone Order-to-Cash (sales) SPA retired (Closure Sprint v2) — its features
// live in the unified ERP at /app (sales + customers). Redirect old links there.
// Lands on the invoices ledger: /app/sales/orders was retired with the manual
// order surface, so the old target is no longer a registered route.
app.all(/^\/sales(?:\/.*)?$/, function (req, res) { res.redirect(302, '/app/sales/invoices'); });

// ── ADLAN Back-Office (unified React SPA) — served at /app ───────────────────
// The unified Back-Office (frontend/erp) is served at /app behind
// ERP_UNIFIED_ENABLED (default ON outside production so dev/staging always sees
// it; production requires the explicit flag). It is a peer to the warehouse /
// pos / sales SPAs — path-prefixed, same JWT/session/tab. The legacy UI at /
// stays intact as the rollback path. When the flag is OFF the section is
// invisible: /app returns a 503 maintenance notice instead of a broken UI.
// Final cutover: the unified app IS the product — the strangler-era
// "explicit flag in production" default is retired with the legacy shells
// (there is no other UI to fall back to). ERP_UNIFIED_ENABLED=0 remains an
// explicit kill switch (503 maintenance notice) in every environment.
var ERP_UNIFIED_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.ERP_UNIFIED_ENABLED || '').trim());
if (!ERP_UNIFIED_ENABLED) {
  app.all(/^\/app(?:\/.*)?$/, function (req, res) {
    res.status(503).type('html').send('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>صيانة</title><body style="font-family:Tahoma,Arial,sans-serif;padding:3rem;text-align:center;color:#172033"><h2>الإدارة الموحّدة غير مُفعّلة</h2><p>استخدم النظام الحالي مؤقتًا. (ERP_UNIFIED_ENABLED=0)</p></body></html>');
  });
} else {
  // Strict CSP scoped to /app (copy of the /warehouse directives). The React SPA
  // loads ONLY hashed bundles (no inline <script>), so a strict CSP applies here
  // without touching the legacy UI. style-src keeps 'unsafe-inline' for
  // Tailwind/React element styles (style attributes, not script).
  app.use('/app', function (req, res, next) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "form-action 'self'"
    ].join('; '));
    next();
  });
  var _erpDist = path.join(__dirname, 'frontend', 'erp', 'dist');
  if (_pwaFs.existsSync(path.join(_erpDist, 'index.html'))) {
    app.use('/app', express.static(_erpDist, {
      setHeaders: function(res, filePath) {
        if (/\.html$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (/[/\\]assets[/\\]/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      }
    }));
    // A tab left open across a deployment can request a hashed chunk from the
    // previous build. Keep that failure as a real 404: the global catch-all
    // below redirects unknown paths to /app/, which would otherwise return HTML
    // with status 200 to a JavaScript import and leave navigation frozen.
    app.all(/^\/app\/assets(?:\/.*)?$/, function(req, res) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(404).type('text').send('Asset not found');
    });
    // History fallback: any extensionless path under /app (a client route like
    // /app/inventory, incl. hard refresh) returns index.html. Paths that look
    // like a file (have an extension) fall through to a normal 404.
    app.get(/^\/app(?:\/.*)?$/, function(req, res, next) {
      if (/\.[a-zA-Z0-9]+$/.test(req.path)) return next();
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(_erpDist, 'index.html'));
    });
    console.log('[erp] unified Back-Office SPA mounted at /app');
  } else {
    console.warn('[erp] bundle not found — run: npm --prefix frontend/erp run build');
  }
}

// RC hardening — surface a loud warning if warehouse-v2 is exposed WITHOUT
// per-user warehouse scope enforcement (an out-of-scope user could otherwise
// read/write any warehouse). Deliberately a warning, not a hard stop: staging
// must set WAREHOUSE_SCOPE_ENFORCE=1 (documented in the migration runbook).
if (String(process.env.WAREHOUSE_V2_ENABLED || '1') !== '0' &&
    String(process.env.WAREHOUSE_SCOPE_ENFORCE || '') !== '1') {
  console.warn('[warehouse-v2][SECURITY] V2 is ENABLED but WAREHOUSE_SCOPE_ENFORCE is not "1" — users are NOT restricted to their assigned warehouses. Set WAREHOUSE_SCOPE_ENFORCE=1 in staging/production.');
}

// Phase 5C — canary allow-list state, surfaced at boot like the scope warning
// above so the rollout wave in effect is always visible in the deploy logs.
const _v2Canary = require('./lib/v2Canary');
if (_v2Canary.config.ACTIVE) {
  console.log('[warehouse-v2] canary allow-list ACTIVE — users=%d role(s)=%d%s',
    _v2Canary.config.USERS.length, _v2Canary.config.ROLES.length,
    _v2Canary.config.ALLOW_ALL ? ' (contains "*" → full open)' : '');
} else {
  console.log('[warehouse-v2] canary allow-list OFF — v2 open to all authenticated users');
}

// v6.20.0 — Deploy/version marker. Lets us confirm EXACTLY which commit is
// live on production (ends the "is it actually deployed?" ambiguity). Railway
// injects the RAILWAY_GIT_* vars at build time.
const SERVER_BOOT_ISO = new Date().toISOString();
app.get('/api/version', (req, res) => {
  res.json({
    commit:  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'unknown',
    branch:  process.env.RAILWAY_GIT_BRANCH || 'unknown',
    message: process.env.RAILWAY_GIT_COMMIT_MESSAGE || '',
    deployId: process.env.RAILWAY_DEPLOYMENT_ID || '',
    env:     process.env.NODE_ENV || 'development',
    pid: process.pid,
    // Tier A.2 test harness (tests/helpers/testHarness.js) — when a test
    // spawns this process with TEST_HARNESS_TOKEN set, it polls this
    // endpoint and checks the token round-trips, proving the response came
    // from the exact child process it just spawned on a freshly-allocated
    // port, not a stale/unrelated server left listening there. Undefined
    // (and harmless) outside the test harness — no real deployment sets it.
    harnessToken: process.env.TEST_HARNESS_TOKEN || null,
    startedAt: SERVER_BOOT_ISO,
    now: new Date().toISOString(),
    // The shared header reads this to decide which warehouse link to render
    // (V2 section at /warehouse vs the legacy /inventory/ rollback UI) — the
    // user must never see two warehouse links at once.
    warehouseV2: WAREHOUSE_V2_ENABLED,
    // Procurement P2P — the legacy shell hides its old purchasing menu group and
    // shows a single «المشتريات والموردون» entry when this is on.
    procurementP2P: /^(1|true|on|yes)$/i.test(String(process.env.PROCUREMENT_P2P_ENABLE || '').trim()),
    // Order-to-Cash — the unified sales/customers/receivables module. When on, the
    // legacy shell hides its old sales/customers/AR entries and routes to /sales.
    orderToCash: /^(1|true|on|yes)$/i.test(String(process.env.ORDER_TO_CASH_ENABLE || '').trim())
  });
});

// Per-user warehouse navigation gate (Final Rollout). The main shell + shared
// header show EXACTLY ONE warehouse entry — «إدارة المستودعات» → /warehouse — and
// ONLY to authorized users. Authorization = V2 enabled AND the user has Warehouse
// Scope (admin/developer = global; everyone else = ≥1 explicitly-granted warehouse
// in user_warehouse_access). A user with NO warehouse scope gets NO link. This is
// the documented Scope/RBAC split: Scope decides WHICH warehouses (and whether the
// entry shows); RBAC continues to govern WHAT actions the user may take inside the
// v2 routes. NOT gated by canary — canary is `*` (open) at this stage; the legacy
// UI is hidden for everyone and kept only as an internal rollback (flag → 0).
// Authenticated (NOT in the public list above → req.user is set by the /api gate).
app.get('/api/warehouse-nav', async (req, res) => {
  if (!WAREHOUSE_V2_ENABLED) return res.json({ v2Enabled: false, v2Allowed: false });
  try {
    const _wsMw = require('./middleware/warehouseScope');
    const scope = await _wsMw.loadScope(req.user);
    const hasScope = !!(scope && (scope.all || (Array.isArray(scope.warehouseIds) && scope.warehouseIds.length > 0)));
    res.json({ v2Enabled: true, v2Allowed: hasScope });
  } catch (e) {
    // fail-closed on the nav decision — never show a link we can't verify
    res.json({ v2Enabled: true, v2Allowed: false });
  }
});

// RC ops — readiness probe. Verifies DB connectivity AND that the warehouse-v2
// schema actually migrated (lot tables/columns) + reports the DB session
// timezone. Returns 503 with the missing piece so an orchestrator never routes
// traffic to a half-migrated instance. Public (no auth), like /api/version.
const _readyDb = require('./db/connection');
// Expected Riyadh offset in minutes, derived from the pool's DB_TIME_ZONE
// ('+03:00' → 180). Named zones fall back to 180 (KSA has no DST).
const _expectedTzMin = (() => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(_readyDb.DB_TIME_ZONE || '+03:00'));
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 180;
})();
app.get('/api/inventory/v2/ready', async (req, res) => {
  const checks = { db: false, schema: false, timezone: null, timezoneOffsetMin: null, timezoneOk: false };
  const missing = [];
  try { await _readyDb.query('SELECT 1'); checks.db = true; }
  catch (e) { missing.push('db:' + (e.code || 'unreachable')); }
  if (checks.db) {
    const required = [
      ['inv_items', 'tracking_mode'], ['inventory_lots', 'lifecycle_status'],
      ['warehouse_lot_balances', 'qty'], ['inventory_lot_movements', 'inventory_movement_seq'],
    ];
    try {
      let present = 0;
      for (const [t, c] of required) {
        const [r] = await _readyDb.query('SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [t, c]);
        if (r[0] && Number(r[0].n) > 0) present++; else missing.push('schema:' + t + '.' + c);
      }
      checks.schema = present === required.length;
      // Phase 5B.1 — assert the EFFECTIVE session timezone (not the global):
      // the offset NOW()-UTC_TIMESTAMP() is what every date-boundary query
      // actually uses. The pool re-applies SET time_zone per connection, so
      // this stays green across DB restarts with no manual step.
      try {
        const [tz] = await _readyDb.query('SELECT @@session.time_zone AS tz, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS off');
        checks.timezone = tz[0] && tz[0].tz;
        checks.timezoneOffsetMin = tz[0] && Number(tz[0].off);
        checks.timezoneOk = checks.timezoneOffsetMin === _expectedTzMin;
        if (!checks.timezoneOk) missing.push('timezone:offset=' + checks.timezoneOffsetMin + ' expected=' + _expectedTzMin);
      } catch (_) { missing.push('timezone:unreadable'); }
    } catch (e) { missing.push('schema:' + (e.code || 'error')); }
  }
  const ready = checks.db && checks.schema && checks.timezoneOk;
  res.status(ready ? 200 : 503).json({ ready, checks, missing, processTz: process.env.TZ || null, at: new Date().toISOString() });
});

// 8. Audit logging middleware — auto-logs all POST/PUT/DELETE operations
const { auditMiddleware } = require('./lib/auditLogger');
app.use('/api/sales', auditMiddleware('sales'));
app.use('/api/inventory', auditMiddleware('inventory'));
app.use('/api/purchases', auditMiddleware('purchases'));
app.use('/api/erp', auditMiddleware('erp'));
app.use('/api/custody', auditMiddleware('custody'));
app.use('/api/hr', auditMiddleware('hr'));
app.use('/api/workflow', auditMiddleware('workflow'));
app.use('/api/auth', auditMiddleware('auth'));

// Phase 2A.2 — warehouse scope resolver. Runs AFTER the global /api auth gate
// (req.user is set) and BEFORE the warehouse routers, so req.guardWh /
// req.guardTransfer / req.whScopeClause are available to every inventory / erp
// (incl. warehouse-ops) / stocktake-pro route. No-op until WAREHOUSE_SCOPE_ENFORCE.
const { loadWarehouseScope } = require('./middleware/warehouseScope');
app.use('/api/inventory', loadWarehouseScope);
app.use('/api/erp', loadWarehouseScope);
app.use('/api/stocktake-pro', loadWarehouseScope);

// ── Procurement / P2P unified module (flag-gated: PROCUREMENT_P2P_ENABLE) ─────
// One namespace for suppliers + purchase orders + goods receipts + supplier
// invoices + payments + returns + reports + dashboard. Dormant by default so the
// legacy purchasing paths stay the sole stock/AP writers until the flag is
// flipped after migration + backfill. Inherits the global JWT gate (req.user).
const PROCUREMENT_P2P_ENABLE = /^(1|true|on|yes)$/i.test(String(process.env.PROCUREMENT_P2P_ENABLE || '').trim());
if (PROCUREMENT_P2P_ENABLE) {
  app.use('/api/procurement', auditMiddleware('procurement'));
  app.use('/api/procurement', loadWarehouseScope);
  app.use('/api/procurement', require('./routes/procurement'));

  // Dual-write elimination — the unified module is the SOLE writer of procurement
  // stock (goods receipts) and AP (supplier invoices + supplier payments). Every
  // LEGACY write path is blocked (GET/reads pass for historical screens).
  // Registered BEFORE the legacy routers (mounted further down) so they
  // short-circuit; reverting the flag removes every guard untouched.
  const { legacyWriteGate, supplierPaymentGate } = require('./middleware/procurementLegacyGate');
  app.use('/api/purchases', legacyWriteGate('/api/procurement/orders'));         // create / receive / revert / PO-approve / delete
  app.use('/api/ap-invoices', legacyWriteGate('/api/procurement/invoices'));     // supplier invoice create / approve / pay / lines / cancel
  app.post('/api/inventory/receive-request', legacyWriteGate('/api/procurement/receipts'));
  app.post('/api/inventory/receive-approve/:id', legacyWriteGate('/api/procurement/receipts'));
  app.use('/api/erp/payments', supplierPaymentGate('/api/procurement/payments')); // supplier-directed payments only (other treasury passes)

  // Convenience 301s — old/short procurement URLs land on the unified module.
  const _p2pTarget = '/warehouse/purchasing';
  for (const p of ['/purchasing', '/procurement', '/suppliers']) {
    app.get(p, (req, res) => res.redirect(301, _p2pTarget));
    app.get(p + '/*', (req, res) => res.redirect(301, _p2pTarget));
  }

  console.log('[procurement] P2P module MOUNTED at /api/procurement (all legacy stock/AP writers gated)');
} else {
  console.log('[procurement] P2P module dormant — set PROCUREMENT_P2P_ENABLE=1 to enable');
}

// ── Order-to-Cash unified module (flag-gated: ORDER_TO_CASH_ENABLE) ───────────
// One namespace for customers + sales orders + customer invoices + collections +
// returns + reports + dashboard, with a single AR source of truth (ar_documents).
// Dormant by default so the legacy sales/AR/cash paths stay the sole AR writers
// until migration + backfill are done and the flag is flipped. Inherits the
// global JWT gate (req.user). POS sale CREATION is intentionally NOT gated (POS is
// the financial writer); only the DUPLICATE AR/collection paths + destructive
// legacy sale-reverse are blocked.
const ORDER_TO_CASH_ENABLE = /^(1|true|on|yes)$/i.test(String(process.env.ORDER_TO_CASH_ENABLE || '').trim());
if (ORDER_TO_CASH_ENABLE) {
  app.use('/api/order-to-cash', auditMiddleware('order-to-cash'));
  app.use('/api/order-to-cash', loadWarehouseScope);
  app.use('/api/order-to-cash', require('./routes/order-to-cash'));

  // Single-writer AR — block the legacy duplicate AR/collection write paths (reads pass).
  // /api/ar-invoices needed no gate once it was deleted outright: the second
  // invoice source is gone, not merely blocked.
  const { customerReceiptGate, saleReverseGate, creditSaleGate } = require('./middleware/o2cLegacyGate');
  app.use('/api/cash', customerReceiptGate('/sales/payments'));         // customer-directed receipts → gated
  app.use('/api/sales', creditSaleGate());                             // credit sales must pass the server credit gate
  app.use('/api/sales', saleReverseGate('/sales'));                     // legacy sale reverse/delete (GL-destroying) → gated; POS create passes

  console.log('[order-to-cash] module MOUNTED at /api/order-to-cash (legacy AR/collection writers gated; POS create passes)');
} else {
  console.log('[order-to-cash] module dormant — set ORDER_TO_CASH_ENABLE=1 to enable');
}

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/shifts', require('./routes/shifts'));
// Cashier V2 — cart lifecycle ONLY (checkout money path stays /api/sales).
app.use('/api/pos/v2', require('./routes/pos-v2'));
// bilingual-i18n-images — Owner B: read-only cashier-readiness diagnostics.
// Deliberately NOT mounted under /menu* — the global /api gate above does a
// naive prefix-match on '/menu' that would otherwise make this public.
app.use('/api/cashier-readiness', require('./routes/cashier-readiness'));
// bilingual-i18n-images — Owner C: bulk product image management. Same
// /menu*-prefix-match caveat as above — mounted at its own top-level path.
app.use('/api/product-images', require('./routes/product-images'));
// Sprint 3 (A2) — per-user preferences (UI language persistence) + server-backed
// saved table views. Both at clean top-level paths (not /menu*), each chains
// its own verifyToken.
app.use('/api/user-preferences', require('./routes/user-preferences'));
app.use('/api/saved-views', require('./routes/saved-views'));
// Phase 3B — independent inventory transactions (receipts / issues / adjustments)
// at a CLEAN namespace /api/inventory/v2/* so the legacy /api/inventory/adjustments
// (delta model + legacy HTML UI) is never shadowed. Mounted BEFORE inventory.js so
// the /v2/* paths are claimed here. Inherits loadWarehouseScope (mounted above).
// Phase 3C — professional stocktake mounted at the more-specific /v2/stocktakes
// BEFORE the /v2 doc router (paths don't collide; this just claims the prefix).
// RC hardening — per-user mutation rate limiter for the whole /v2 surface
// (state-changing methods only; reads/exports pass through). Generous default
// (300/min/user) so legitimate use + tests never trip it; env-tunable.
app.use('/api/inventory/v2', require('./lib/v2Metrics').track);
app.use('/api/inventory/v2', require('./lib/v2RateLimit'));
// Phase 5C — canary allow-list. Gates the ENTIRE v2 surface (reads + writes)
// plus the v2-only read namespaces mounted further down (/analytics, /reports,
// /transfers — the legacy UI uses none of them). The public /ready probe is
// registered ABOVE and is never affected. Pass-through when no list is set.
app.use('/api/inventory/v2', _v2Canary);
app.use('/api/inventory/analytics', _v2Canary);
app.use('/api/inventory/reports', _v2Canary);
app.use('/api/inventory/transfers', _v2Canary);
// RC cutover — v2 WRITE gate. When v2 is disabled, mutations return 503 so the
// legacy system is the sole writer (no dual-write); reads stay available.
app.use('/api/inventory/v2', function (req, res, next) {
  if (WAREHOUSE_V2_ENABLED || !/^(POST|PUT|PATCH|DELETE)$/.test(req.method)) return next();
  return res.status(503).json({ success: false, code: 'V2_DISABLED', error: 'نظام warehouse-v2 معطّل مؤقتًا — لا يمكن تنفيذ عمليات كتابية. استخدم النظام القديم.' });
});
app.use('/api/inventory/v2/stocktakes', require('./routes/inventory-stocktakes'));
// Phase P1 — Production Orders V2 (full lifecycle: draft→approved→in_progress→
// completed→closed, +cancel/reverse/delete). Path-scoped mount so it inherits
// scope/canary/metrics; claimed BEFORE the sibling v2 routers.
app.use('/api/inventory/v2/production-orders', require('./routes/inventory-production'));
// Phase W2b — negative-stock policy settings (mounted BEFORE the doc router so
// /negative-policy is claimed here; sibling scoped router, canary-gated above).
app.use('/api/inventory/v2/negative-policy', require('./routes/negative-policy'));
// Phase W6 — warehouse management CRUD (create/edit/activate/deactivate/hard-
// delete guard/scope assignments). Path-scoped like the other v2 routers.
app.use('/api/inventory/v2/warehouses', require('./routes/inventory-warehouses'));
// Phase 4A — item master + replenishment (paths /items, /replenishment,
// /categories, /units don't collide with the doc router's /receipts|/issues|…).
app.use('/api/inventory/v2', require('./routes/inventory-items'));
app.use('/api/inventory/v2', require('./routes/inventory-lots'));
app.use('/api/inventory/v2', require('./routes/inventory-transactions'));
try { app.use('/api/accounting', require('./routes/accounting')); } catch (e) { console.warn('[mod:accounting]', e.message); }
// نماذج الجرد المحفوظة — saved stocktake templates (a named, reusable item set
// the owner counts periodically). Deliberately NOT under /api/inventory/v2:
// that prefix is wrapped by the canary allow-list and by the V2 WRITE gate
// above, which 503s every mutation whenever WAREHOUSE_V2_ENABLED is off — a
// register must still be able to save and edit its own count sheet then.
// Mounted BEFORE the /api/inventory catch-all router so this path is claimed
// here; it still inherits loadWarehouseScope (req.guardWh / req.whScopeClause),
// mounted on /api/inventory further up.
app.use('/api/inventory/stocktake-templates', require('./routes/stocktake-templates'));
app.use('/api/inventory', require('./routes/inventory'));
// Phase 2B — read-only Analytics + Reports (inherits the warehouse-scope
// middleware mounted on /api/inventory above; /analytics/* + /reports/* paths
// don't collide with the inventory router).
app.use('/api/inventory', require('./routes/warehouse-reports'));
// Phase 3A — scoped READ endpoints for the React /transfers grid + detail
// (list/KPIs/timeline). Mutations stay on /api/erp/stock-issues; the legacy
// GET endpoints there are untouched.
app.use('/api/inventory', require('./routes/warehouse-transfers'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/settings', require('./routes/settings'));
// Closure Sprint v2 — advanced security policies (password policy / session timeout
// / IP allowlist), settings-backed. requireCapability lives inside the route file.
try { app.use('/api/security-policies', require('./routes/security-policies')); } catch(e){ console.warn('[mod:security-policies]', e.message); }
app.use('/api/sales-channels', require('./routes/sales-channels'));
// Unified Sales Analytics (Wave 2 read path) — scope middleware + metadata/query.
// Behind the global JWT gate above; capability gate lives in routes/analytics.
try { app.use('/api/analytics', require('./routes/analytics')); } catch(e){ console.warn('[mod:analytics]', e.message); }
// V5.7.13 — translation proxy (server-side Google Translate fetch, no CORS)
try { app.use('/api/i18n', require('./routes/i18n')); } catch(e){ console.warn('[mod:i18n]', e.message); }
// ERP v3 (erp-core) is mounted first so its newer, schema-aware reports
// take precedence over any same-path legacy handler in routes/erp.js
app.use('/api/erp', require('./routes/erp-core'));
app.use('/api/erp', require('./routes/warehouse-ops'));
app.use('/api/erp', require('./routes/payments'));
app.use('/api/erp', require('./routes/notifications'));
app.use('/api/erp', require('./routes/erp'));
// v6.1.0 Wave E — ZATCA Phase 2 onboarding routes
try { app.use('/api/erp', require('./routes/erp/zatca')); } catch(e){ console.warn('[mod:erp-zatca]', e.message); }
// v6.2.0 Wave F.1+F.2+F.3 — aging reports + period close
try { app.use('/api/erp', require('./routes/erp/reports/ar-aging')); } catch(e){ console.warn('[mod:ar-aging]', e.message); }
try { app.use('/api/erp', require('./routes/erp/reports/ap-aging')); } catch(e){ console.warn('[mod:ap-aging]', e.message); }
try { app.use('/api/erp', require('./routes/erp/periods'));            } catch(e){ console.warn('[mod:periods]', e.message); }
try { app.use('/api/erp/sales-posting', require('./routes/erp/sales-posting')); } catch(e){ console.warn('[mod:sales-posting]', e.message); }
// v7.x SECURITY (RBAC) — financial/admin modules are gated to an elevated role
// at the mount point (default-deny for cashier/employee). requireRole fails
// closed: an empty/unknown role normalizes to the least-privileged 'cashier'.
const { requireRole } = require('./middleware/auth');
// V5 Enterprise modules (Real-Estate / Contracts / WorkOrders / AP-AR / Approval Matrix)
try { app.use('/api/properties', requireRole('admin','manager'), require('./routes/properties')); } catch(e){ console.warn('[mod:properties]', e.message); }
try { app.use('/api/work-orders', requireRole('admin','manager'), require('./routes/work-orders')); } catch(e){ console.warn('[mod:work-orders]', e.message); }
try { app.use('/api/ap-invoices', requireRole('admin','manager'), require('./routes/ap-invoices')); } catch(e){ console.warn('[mod:ap-inv]', e.message); }
try { app.use('/api/approval-matrix', requireRole('admin','manager'), require('./routes/approval-matrix')); } catch(e){ console.warn('[mod:matrix]', e.message); }
try { app.use('/api/budgets', requireRole('admin','manager'), require('./routes/budgets')); } catch(e){ console.warn('[mod:budgets]', e.message); }
try { app.use('/api/anomalies', requireRole('admin','manager'), require('./routes/anomalies')); } catch(e){ console.warn('[mod:anomalies]', e.message); }
try { app.use('/api/activity-log', require('./routes/activity-log')); } catch(e){ console.warn('[mod:activity-log]', e.message); }
try { app.use('/api/channel-menus', require('./routes/channel-menu')); } catch(e){ console.warn('[mod:channel-menu]', e.message); }
try { app.use('/api/stocktake-pro', require('./routes/stocktake-pro')); } catch(e){ console.warn('[mod:stocktake-pro]', e.message); }
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/custody', requireRole('admin','manager','custody'), require('./routes/custody'));
app.use('/api/cash', requireRole('admin','manager'), require('./routes/cash'));
// FC-P3 — bank reconciliation + cash-drawer closing (capability-gated inside).
app.use('/api/bank-recon', requireRole('admin','manager'), require('./routes/bank-reconciliation'));
app.use('/api/workflow', require('./routes/workflow'));
// HR is manager-territory EXCEPT the employee self-service surface: /my-* routes
// (clock in/out, leave requests, own attendance/profile/balances) derive their
// subject from the verified JWT inside the handler, so any authenticated role may
// call them — that is the whole point of self-service. Gating the mount with
// requireRole(admin,manager) 403'd every employee clock-in (the employee PWA and
// the React SelfService page both broke). /leave-types is the read the leave
// form needs. Everything else stays admin/manager.
app.use('/api/hr', (req, res, next) => {
  if (/^\/(my-|leave-types)/.test(req.path)) return next(); // JWT already verified by the global gate
  return requireRole('admin', 'manager')(req, res, next);
}, require('./routes/hr'));
// V4 — counters, SLA, SSE inbox stream, metrics, workflow-routes JSON-DSL
app.use('/api/counters', require('./routes/counters'));
const _slaRouter = require('./routes/sla');
app.use('/api/sla', _slaRouter);
app.use('/api/sse', require('./routes/sse'));
const _metricsRouter = require('./routes/metrics');
// Phase 5B.1 — the request tracker is now mounted at the TOP of the /api chain
// (see §1c near the correlation-id middleware). Mounting it here again would
// double-count every request that reaches this point.
app.use('/api/metrics', _metricsRouter);
app.use('/api/workflow-routes', require('./routes/workflowRoutes'));
// Start SLA background sweep on boot (every 30 minutes)
try { _slaRouter._startBackgroundSweep(30 * 60 * 1000); } catch(e) { console.warn('[sla] sweep start failed:', e.message); }

// Catch-all for unimplemented API routes
const { notFoundHandler, errorHandler } = require('./lib/errorHandler');
app.all('/api/*', notFoundHandler);

// Centralized error handler (MUST be last middleware)
app.use(errorHandler);

// ── Final cutover (FC-W3): every legacy shell is DELETED ─────────────────────
// /employee + /custody → their write flows live in the unified app (stream F:
// SelfServicePage attendance/leave/approvals, CustodyPage full cycle). The
// /employee tombstone SW (registered earlier, before express.static) unhooks
// installed PWAs; these redirects then land everyone on the React screens.
// /custody never had a service worker — a plain redirect suffices.
app.get(['/employee', '/employee/*'], function (req, res) { res.redirect(302, '/app/people/self-service'); });
app.get(['/custody', '/custody/*'],   function (req, res) { res.redirect(302, '/app/people/custody'); });
// /legacy (the FC-P4 rollback shell) is gone with the shell it served.
app.get(['/legacy', '/legacy/*'], function (req, res) { res.redirect(302, '/app/'); });

// Catch-all: any unknown non-API path converges on the unified app instead of
// resurrecting a deleted shell. (/api/* 404s are handled above, never here.)
app.get('*', (req, res) => {
  res.redirect(302, '/app/');
});

// Auto-initialize database tables on first run
const fs = require('fs');
const db = require('./db/connection');
// CO-5 — the migration advisory lock, shared with step 2/3 of the release chain
// (db/migrate.js). Required HERE, above autoInitDB(), so it is initialized well
// before the first call site rather than sitting in a temporal dead zone.
const { withMigrationLock } = require('./db/migrationLock');

// Phase A — mark users still on a default password with must_change_password=1
// so login routes them to the in-system change-password page (without blocking
// them from actually changing it). Cheap: only never-changed accounts, top defaults.
async function flagDefaultPasswordUsers() {
  const bcrypt = require('bcryptjs');
  const DEFAULTS = ['admin123', 'admin', 'password', '123456', 'changeme'];
  let rows;
  try {
    [rows] = await db.query(
      "SELECT id, username, password FROM users WHERE active=1 AND COALESCE(must_change_password,0)=0 AND password_changed_at IS NULL LIMIT 500"
    );
  } catch (_) { return; }
  let flagged = 0;
  for (const u of rows) {
    let hit = false;
    for (const d of DEFAULTS) { try { if (await bcrypt.compare(d, u.password)) { hit = true; break; } } catch (_) {} }
    if (hit) { try { await db.query('UPDATE users SET must_change_password=1 WHERE id=?', [u.id]); flagged++; } catch (_) {} }
  }
  if (flagged) console.log('[pw-flag] flagged ' + flagged + ' user(s) still on a default password → must_change_password=1');
}

// RC (Release-Candidate gate) — autoInitDB() deliberately never throws: its
// retry loop logs and RETURNS on final failure so the server still comes up
// for diagnostics when the DB is unreachable. That is right for `npm start`,
// but it means a caller cannot tell success from failure — and the release
// chain MUST be able to, or it would happily start a server on a half-built
// schema. This flag is the honest signal: it is set ONLY on the path that
// actually completed runMigrations() + normalizeCollations().
let __autoInitSucceeded = false;

// Companion to the flag above, closing the hole it did NOT cover.
//
// __autoInitSucceeded proves runMigrations() RAN to completion. It cannot prove
// the schema is COMPLETE, because every self-applying schema module below is
// invoked inside its own try/catch that logs and continues. So a module could
// fail outright, runMigrations() would still reach its success path, the
// MIGRATE_ONLY probe would find its five baseline tables present, and
// `scripts/release-start.js` — the Dockerfile CMD — would exit 0 and start the
// server on a schema missing whole subsystems.
//
// That was demonstrated, not theorised: with the analytics module forced to
// fail, the chain printed "[DB] analytics schema FAILED …" and then "schema
// ready (5/5 probe tables present)" and exited 0, with 2 of 15 analytics tables
// present. This release adds a column and nine indexes through that exact
// module.
//
// Each module's catch records here, and the MIGRATE_ONLY probe refuses to
// report a ready schema when it is non-empty. Deliberately NOT fatal on an
// ordinary `npm start`: the existing behaviour of coming up degraded for
// diagnostics is right for a running box, and release-start.js gates the deploy
// on MIGRATE_ONLY *before* it ever starts the server.
//
// Only a module THROWING is recorded. Several modules log internal per-statement
// warnings on a healthy empty-DB boot (party-dimension's payment_source, whose
// table is created later by the procurement runner) and still return normally —
// treating those as failures would make every clean first boot refuse to deploy.
const __schemaModuleFailures = [];
function __recordSchemaFailure(mod, e) {
  __schemaModuleFailures.push(mod + ': ' + String((e && e.message) || e).substring(0, 200));
}

async function autoInitDB() {
  // Retry loop — Railway MySQL may not be ready immediately on cold start
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const [rows] = await db.query("SHOW TABLES LIKE 'users'");
      if (!rows.length) {
        console.log('First run — creating database tables...');
        const schema = fs.readFileSync(require('path').join(__dirname, 'db/schema.sql'), 'utf8');
        // Phase 3A.1 — comment/quote-aware split. The old schema.split(';')
        // broke on a ';' INSIDE a comment (e.g. "(SOCPA/IFRS); the only valid
        // correction") or a string literal, shredding gl_journals / gl_entries /
        // inventory_movements / sales on a fresh DB. splitSqlStatements ignores
        // ';' inside '…' "…" `…`, -- line and /* */ block comments.
        const stmts = splitSqlStatements(schema).filter(s => {
          const bare = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim();
          return bare.length > 5 && !/^create\s+database/i.test(bare) && !/^use\s/i.test(bare);
        });
        for (const stmt of stmts) {
          try { await db.query(stmt); } catch (e) {
            console.log('Schema warning:', e.message.substring(0, 120));
          }
        }
        // Create initial admin user.
        // SECURITY: in production a default password is FORBIDDEN — the initial
        // admin password must come from ADMIN_INITIAL_PASSWORD (min 12 chars,
        // never logged). Without it, no admin is seeded and the operator must
        // set the env var and restart (or create the admin manually and then
        // run scripts/rotate-admin-password.js).
        const bcrypt = require('bcryptjs');
        const isProd = process.env.NODE_ENV === 'production';
        const initialPw = process.env.ADMIN_INITIAL_PASSWORD || '';
        if (isProd) {
          if (initialPw.length >= 12) {
            const hash = await bcrypt.hash(initialPw, 12);
            await db.query("INSERT IGNORE INTO users (username, password, role) VALUES ('admin', ?, 'admin')", [hash]);
            console.log('Database ready! Admin seeded from ADMIN_INITIAL_PASSWORD (value not logged).');
          } else {
            console.error('[SECURITY] Empty database in production and no valid ADMIN_INITIAL_PASSWORD (>=12 chars).');
            console.error('[SECURITY] Refusing to seed a default admin password. Set ADMIN_INITIAL_PASSWORD and restart.');
          }
        } else {
          // Local development convenience ONLY — never reached when NODE_ENV=production.
          const hash = await bcrypt.hash(initialPw.length >= 12 ? initialPw : 'admin123', 10);
          await db.query("INSERT IGNORE INTO users (username, password, role) VALUES ('admin', ?, 'admin')", [hash]);
          console.log('Database ready! Dev-only default admin created (rotate via scripts/rotate-admin-password.js before any real deployment).');
        }
      } else {
        console.log('Database connection OK — tables already exist.');
      }
      // Idempotent migrations — run on every startup, skip if already applied.
      // B5 — serialized under a DB advisory lock so concurrent instance boots
      // (Railway scale-out) can't run them / double-seed simultaneously.
      await withMigrationLock(runMigrations);
      // v6.20.0 — unify collations AFTER all tables exist (fixes mixed
      // utf8mb4_unicode_ci / utf8mb4_0900_ai_ci JOIN failures on MySQL 8).
      await normalizeCollations();
      // Procurement / P2P — auto-provision schema + GRNI account + capabilities
      // when the flag is on, so enabling PROCUREMENT_P2P_ENABLE is one switch.
      // Idempotent + additive; a failure logs but never blocks startup.
      if (PROCUREMENT_P2P_ENABLE) {
        try { await require('./scripts/procurement/migrate').run({ dryRun: false }); console.log('[procurement] schema provisioned'); }
        catch (e) { console.warn('[procurement] provisioning skipped:', e.message); }
      }
      // Phase A — flag any user still on a default password so they are routed
      // to the in-system change-password page after login (best-effort, cheap:
      // only never-changed accounts, only the top defaults).
      try { await flagDefaultPasswordUsers(); } catch (e) { console.warn('[pw-flag]', e.message); }
      __autoInitSucceeded = true; // see the flag's declaration — the ONLY honest success signal
      return; // success — exit retry loop
    } catch (e) {
      console.error(`[DB] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`[DB] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
      } else {
        console.error('[DB] Could not connect to MySQL after all retries. Check MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQL_DATABASE environment variables.');
      }
    }
  }
}

// ─── Idempotent schema migrations ───
// Checks if a column exists on a table; if not, adds it.
async function addColumnIfMissing(table, column, definition) {
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (!cols.length) {
      console.log(`[DB] Migration: adding ${table}.${column}`);
      await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  } catch (e) {
    console.log(`[DB] Migration warning (${table}.${column}):`, e.message.substring(0, 120));
  }
}

// W2-A — index counterpart of addColumnIfMissing. MySQL has no
// "CREATE INDEX IF NOT EXISTS", and a bare CREATE INDEX on an existing name is
// a hard error (1061) that would abort the migration chain, so the existence
// check is done against INFORMATION_SCHEMA.STATISTICS first. Same log-and-
// continue contract as addColumnIfMissing: a migration warning must never take
// the server down.
async function addIndexIfMissing(table, indexName, columns) {
  try {
    const [idx] = await db.query(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [table, indexName]
    );
    if (!idx.length) {
      console.log(`[DB] Migration: adding index ${table}.${indexName}`);
      await db.query(`ALTER TABLE ${table} ADD INDEX ${indexName} (${columns})`);
    }
  } catch (e) {
    console.log(`[DB] Migration warning (index ${table}.${indexName}):`, e.message.substring(0, 120));
  }
}

// v6.18.8 — Reusable defensive helper for column DEFINITION changes
// (extending an ENUM, widening a VARCHAR, changing a DEFAULT, etc.).
// Unlike addColumnIfMissing (which only ADDs absent columns), this
// runs ALTER TABLE MODIFY COLUMN unconditionally — but that's safe
// because MODIFY COLUMN is a no-op when the definition already matches
// the live column.  Use this whenever a column's shape needs to evolve
// on production without depending on an external migration runner.
//
// Why it's needed: addColumnIfMissing returns early once the column
// exists, so any subsequent change to its `definition` argument is
// invisible to long-running databases.  That's how production drifted
// onto the 4-value zatca_type ENUM forever, breaking POST /sales/:id/void
// with "Data truncated for column 'zatca_type' at row 1".
async function modifyColumnDefinition(table, column, definition) {
  try {
    await db.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
  } catch (e) {
    console.log(`[DB] MODIFY warning (${table}.${column}):`, e.message.substring(0, 120));
  }
}

// Phase 3A.1 — comment/quote-aware SQL statement splitter. Scans char-by-char
// and only treats ';' as a statement boundary when NOT inside a single/double/
// backtick-quoted string, a `--` line comment, or a `/* */` block comment. This
// replaces the naive schema.split(';') in autoInitDB, which mis-split DDL whose
// comments contain ';' (e.g. "(SOCPA/IFRS); …") — shredding gl_journals,
// gl_entries, inventory_movements, sales on a brand-new database.
function splitSqlStatements(sql) {
  const out = [];
  let cur = '', i = 0;
  const n = sql.length;
  let sq = false, dq = false, bq = false, line = false, block = false;
  while (i < n) {
    const ch = sql[i], nx = sql[i + 1];
    if (line) { cur += ch; if (ch === '\n') line = false; i++; continue; }
    if (block) { cur += ch; if (ch === '*' && nx === '/') { cur += nx; i += 2; block = false; continue; } i++; continue; }
    if (sq) { cur += ch; if (ch === '\\' && nx !== undefined) { cur += nx; i += 2; continue; } if (ch === "'") sq = false; i++; continue; }
    if (dq) { cur += ch; if (ch === '\\' && nx !== undefined) { cur += nx; i += 2; continue; } if (ch === '"') dq = false; i++; continue; }
    if (bq) { cur += ch; if (ch === '`') bq = false; i++; continue; }
    if (ch === '-' && nx === '-') { line = true; cur += ch; i++; continue; }
    if (ch === '/' && nx === '*') { block = true; cur += ch + nx; i += 2; continue; }
    if (ch === "'") { sq = true; cur += ch; i++; continue; }
    if (ch === '"') { dq = true; cur += ch; i++; continue; }
    if (ch === '`') { bq = true; cur += ch; i++; continue; }
    if (ch === ';') { out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function createTableIfMissing(tableName, createSQL) {
  try {
    const [rows] = await db.query("SHOW TABLES LIKE ?", [tableName]);
    if (!rows.length) {
      console.log(`[DB] Migration: creating table ${tableName}`);
      await db.query(createSQL);
    }
  } catch (e) {
    console.log(`[DB] Migration warning (${tableName}):`, e.message.substring(0, 120));
  }
}

// v6.20.0 — Collation normalization (root-cause fix for the "created
// transactions never appear" production bug). Railway's MySQL 8.0 defaults
// new tables to utf8mb4_0900_ai_ci, while the app connects with
// utf8mb4_unicode_ci (SET NAMES). Any JOIN comparing string columns across a
// mixed-collation pair throws "Illegal mix of collations" — which the list
// endpoints silently swallowed into an empty array, so creates succeeded but
// nothing ever showed up. This converts every base table to ONE collation.
// Idempotent: only tables that actually differ are touched (no-op afterwards).
async function normalizeCollations() {
  const TARGET = 'utf8mb4_unicode_ci';
  let conn;
  try {
    const [[meta]] = await db.query('SELECT DATABASE() AS db');
    const dbName = meta && meta.db;
    if (!dbName) { console.warn('[collation] no current database — skipped'); return; }

    const [badTables] = await db.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_COLLATION <> ?`,
      [dbName, TARGET]);
    const [badCols] = await db.query(
      `SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME <> ?`,
      [dbName, TARGET]);

    const names = Array.from(new Set([
      ...badTables.map(r => r.TABLE_NAME),
      ...badCols.map(r => r.TABLE_NAME)
    ]));
    if (!names.length) { console.log('[collation] all tables already', TARGET); return; }

    console.log(`[collation] normalizing ${names.length} table(s) to ${TARGET}: ${names.join(', ')}`);
    conn = await db.getConnection();           // SET FOREIGN_KEY_CHECKS is session-scoped — keep one connection
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 0'); } catch (_) {}
    for (const name of names) {
      try {
        await conn.query('ALTER TABLE `' + name + '` CONVERT TO CHARACTER SET utf8mb4 COLLATE ' + TARGET);
        console.log('[collation] converted', name);
      } catch (e) {
        console.warn('[collation] FAILED to convert ' + name + ':', String(e.message).substring(0, 160));
      }
    }
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch (_) {}
    console.log('[collation] normalization complete');
  } catch (e) {
    console.warn('[collation] normalization skipped:', String(e.message).substring(0, 160));
  } finally {
    if (conn) conn.release();
  }
}

// B5 — serialize concurrent boots. Two Railway instances (or a MIGRATE_ONLY
// release step racing a starting container) must not run migrations — or
// double-seed payment methods — at the same time. Hold a MySQL user-level lock
// on a DEDICATED connection for the whole run; a second booter blocks up to the
// timeout, then finds the (idempotent) migrations already applied. Fail-closed:
// if the lock cannot be obtained we THROW rather than silently skip migrations.
//
// CO-5: the implementation moved to db/migrationLock.js so that step 2/3 of the
// release chain (node db/migrate.js — the numbered migrations, a SEPARATE
// process that this function never covered) holds the SAME lock. See that file
// for why the name is qualified with the target database. It is required at the
// top of this file, next to `db`, so it exists before autoInitDB() runs.

async function runMigrations() {
  // ─── Release Gate 2026-07 — schema-drift repairs (idempotent) ───
  // (1) customers: the O2C service layer (services/order-to-cash/CustomerService.js)
  // writes payment_terms/credit_days/brand_id (+ merge uses merged_into_id), but
  // those column-adds lived ONLY in db/migrations/order-to-cash/schema.js, which
  // is invoked solely by the manual scripts/order-to-cash/migrate.js — never by
  // boot. Long-lived DBs therefore miss them ("Unknown column 'payment_terms'").
  // Same definitions as the O2C module, now on the canonical boot path.
  await addColumnIfMissing('customers', 'payment_terms', "VARCHAR(40) NOT NULL DEFAULT 'Cash'");
  await addColumnIfMissing('customers', 'credit_days', "INT NOT NULL DEFAULT 0");
  await addColumnIfMissing('customers', 'brand_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('customers', 'merged_into_id', "VARCHAR(50) NULL");
  // (2) cost_centers: two create-if-missing shapes exist — the old one here
  // (id/code/name/type, v. line ~1150) and the rich one in routes/inventory.js
  // (name_ar/name_en/branch_id/notes/created_by) that routes/erp/cost-centers.js
  // SELECTs. DBs whose table was born with the old shape never upgraded and the
  // endpoint 500s with "Unknown column 'p.name_ar'". On a FRESH DB the table
  // does not exist yet at this point (it was born later, old-shaped), so create
  // it here in the UNION of both shapes (rich + legacy name/type kept for the
  // accounting-dimensions directory which still selects `name`). Then the
  // column-adds below upgrade old-shaped DBs, with name_ar backfilled from the
  // legacy name column when it exists.
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS cost_centers (
      id          VARCHAR(50) PRIMARY KEY,
      code        VARCHAR(50) UNIQUE,
      name        VARCHAR(200) NULL,
      type        VARCHAR(50) NULL,
      name_ar     VARCHAR(200) NULL,
      name_en     VARCHAR(200) NULL,
      branch_id   VARCHAR(50) NULL,
      parent_id   VARCHAR(50) NULL,
      is_active   BOOLEAN DEFAULT TRUE,
      notes       TEXT,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by  VARCHAR(80)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  } catch (e) {
    console.log('[DB] Migration warning (cost_centers create):', e.message.substring(0, 120));
  }
  await addColumnIfMissing('cost_centers', 'name_ar', "VARCHAR(200) NULL");
  await addColumnIfMissing('cost_centers', 'name_en', "VARCHAR(200) NULL");
  await addColumnIfMissing('cost_centers', 'branch_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('cost_centers', 'notes', "TEXT NULL");
  await addColumnIfMissing('cost_centers', 'created_by', "VARCHAR(80) NULL");
  try {
    const [legacyName] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cost_centers' AND COLUMN_NAME = 'name'`);
    if (legacyName.length) {
      await db.query("UPDATE cost_centers SET name_ar = name WHERE name_ar IS NULL AND name IS NOT NULL");
    }
  } catch (e) {
    console.log('[DB] Migration warning (cost_centers backfill):', e.message.substring(0, 120));
  }
  // (3) Full O2C additive schema (7 AR/SO tables + customers evolve + the
  // v_customer_ar_balance view) — previously applied only by the manual
  // scripts/order-to-cash/migrate.js, never by boot. The service layer reads
  // the view even outside the O2C flag (CustomerService.get → derivedBalance),
  // so the schema must ride the canonical boot path. Idempotent (guarded
  // creates / CREATE OR REPLACE / INSERT IGNORE). The o2c.* capabilities seed
  // used to run right here too — moved below createTableIfMissing('permissions_v3'
  // / 'role_permissions', ...) — see the comment at that call site.
  try {
    await require('./db/migrations/order-to-cash/schema').apply(db, (m) => console.log('[o2c-schema]', m));
  } catch (e) {
    console.log('[DB] Migration warning (o2c schema):', e.message.substring(0, 160));
    __recordSchemaFailure('order-to-cash', e);
  }

  // Analytics fact/rollup schema — additive only; ALTERs ar_document_lines, so it
  // must run after the o2c apply above. Failure degrades analytics reads only.
  try {
    await require('./db/migrations/analytics/schema').apply(db, (m) => console.log('[analytics-schema]', m));
  } catch (e) {
    console.error('[DB] analytics schema FAILED (analytics reads may 500):', e.message.substring(0, 160));
    __recordSchemaFailure('analytics', e);
  }

  // The counterparty dimension on gl_entries — additive columns + indexes.
  // A failure here leaves the party silently absent, which lib/glPosting.js
  // then REFUSES to degrade past (it throws rather than dropping a party from
  // a line that carries one), so a broken migration surfaces as a loud posting
  // error instead of a quietly partyless ledger.
  try {
    await require('./db/migrations/party-dimension/schema').apply(db, (m) => console.log('[party-schema]', m));
  } catch (e) {
    console.error('[DB] party dimension FAILED:', e.message.substring(0, 160));
    __recordSchemaFailure('party-dimension', e);
  }

  // Unify the two payables accounts and backfill the party. One-shot, gated,
  // resumable — the owner runs nothing.
  const PARTY_KEY = 'PartyDimensionBootstrap_v1';
  try {
    const [done] = await db.query(
      'SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [PARTY_KEY]);
    if (!done.length) {
      const out = await require('./lib/partyDimension/bootstrap')
        .bootstrap(db, require('./lib/glPosting'), (m) => console.log(m));
      const r = out.reclassified || {};
      console.log('[party] bootstrap done — reclassified ' + (r.moved || 0) + ' supplier(s)' +
        (r.unallocated ? ', unallocated ' + r.unallocated : '') +
        (r.journal ? ' (JE ' + r.journal + ')' : '') +
        ' · backfilled ' + ((out.backfill && out.backfill.filled) || 0) + ' line(s)' +
        ' · unattributed ' + ((out.backfill && out.backfill.unattributed) || 0));
      await db.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES (?, '1') " +
        "ON DUPLICATE KEY UPDATE setting_value = '1'", [PARTY_KEY]);
    }
  } catch (e) { console.error('[party] bootstrap skipped:', e.message.substring(0, 160)); }

  // «ترحيل المبيعات» — the deferred sales-posting queue. Purely additive: it
  // creates three new tables and touches nothing existing. A failure here
  // makes `capture()` a no-op (it swallows ER_NO_SUCH_TABLE by design) rather
  // than taking the register down.
  try {
    await require('./db/migrations/sales-posting/schema').apply(db, (m) => console.log('[sales-posting-schema]', m));
  } catch (e) {
    console.error('[DB] sales-posting schema FAILED (queue capture will no-op):', e.message.substring(0, 160));
    __recordSchemaFailure('sales-posting', e);
  }

  // ── Backfill the queue for sales that predate it ─────────────────────────
  //
  // Every historical sale gets a `posted_legacy` row: it already has its own
  // journal, posted the old way, and must never be re-posted. The point is
  // not to change anything about them — it is to make the invariant "every
  // sale has a queue row" true for ALL history, which is what turns the
  // health check into evidence instead of a statement about recent sales only.
  //
  // Batched and resumable: it inserts only rows that are missing, so an
  // interrupted run resumes on the next boot and a completed one is a no-op.
  try {
    const [[pre]] = await db.query(
      `SELECT COUNT(*) AS n FROM sales s
        LEFT JOIN sales_posting_queue q ON q.source_type = 'sale' AND q.source_id = s.id
       WHERE q.id IS NULL`);
    if (Number(pre.n) > 0) {
      // The `sales` table has grown by addColumnIfMissing over many releases,
      // so which optional columns exist differs by deployment age. Ask the
      // schema rather than guessing — a first attempt hard-coded `s.subtotal`
      // and `s.tax`, which this table has never had, and the whole backfill
      // was skipped with one swallowed error line.
      const [cols] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'`);
      const has = new Set(cols.map((c) => String(c.COLUMN_NAME)));
      const col = (name, fallback) => (has.has(name) ? 's.' + name : fallback);

      // Legacy rows carry only the invoice total. net/tax are left at 0
      // deliberately: these rows are `posted_legacy`, their journals were
      // written years ago by the old path, and nothing will ever re-post them
      // — so a reconstructed split would be a guess dressed as a fact. The
      // gross is recorded because it is the one number that is unambiguous.
      const grossExpr = has.has('total_final') ? 's.total_final'
        : (has.has('total') ? 's.total' : '0');

      let done = 0;
      for (let guard = 0; guard < 500; guard++) {     // 500 × 2000 = 1M sales ceiling
        const [r] = await db.query(
          `INSERT IGNORE INTO sales_posting_queue
             (source_type, source_id, business_day, calendar_date, brand_id, branch_id,
              net_amount, tax_amount, gross_amount, cogs_amount, status, invoice_number, posted_at)
           SELECT 'sale', s.id,
                  DATE(s.order_date - INTERVAL 4 HOUR),   -- default day_close_time
                  DATE(s.order_date),
                  ${col('brand_id', 'NULL')}, ${col('branch_id', 'NULL')},
                  0, 0, COALESCE(${grossExpr}, 0), 0,
                  'posted_legacy', ${col('invoice_number', 'NULL')}, s.order_date
             FROM sales s
             LEFT JOIN sales_posting_queue q ON q.source_type = 'sale' AND q.source_id = s.id
            WHERE q.id IS NULL
            LIMIT 2000`);
        if (!r.affectedRows) break;
        done += r.affectedRows;
      }
      console.log('[sales-posting] backfilled ' + done + ' historical sale(s) as posted_legacy');
    }
    const [[gap]] = await db.query(
      `SELECT COUNT(*) AS n FROM sales s
        LEFT JOIN sales_posting_queue q ON q.source_type = 'sale' AND q.source_id = s.id
       WHERE q.id IS NULL`);
    // THE INVARIANT. Must be zero forever — a sale with no queue row is a sale
    // no batch will ever pick up.
    if (Number(gap.n) === 0) console.log('[sales-posting] invariant OK — every sale has a queue row');
    else console.error('[sales-posting] *** ' + gap.n + ' SALE(S) HAVE NO QUEUE ROW ***');
  } catch (e) {
    console.error('[sales-posting] backfill skipped:', e.message.substring(0, 160));
  }

  // Closure-stream capability declarations (db/migrations/capability-seeds/*.json)
  // moved to right after the o2c.* capabilities seed below — it INSERT
  // IGNOREs into permissions_v3 + role_permissions, which don't exist yet
  // at this point in a fresh install (createTableIfMissing for both runs
  // later in this same function). Same ordering-bug class as Tier A.2
  // Section 6 (pos_orders.branch_id) — the seed silently failed here on a
  // fresh install's first boot and only succeeded on a second restart.

  // PO lines — unit conversion columns
  await addColumnIfMissing('po_lines', 'unit', "VARCHAR(50) DEFAULT ''");
  await addColumnIfMissing('po_lines', 'conv_rate', "DECIMAL(10,2) DEFAULT 1");
  await addColumnIfMissing('po_lines', 'unit_type', "VARCHAR(10) DEFAULT 'small'");

  // Menu — pricing system columns + fix cost precision
  await addColumnIfMissing('menu', 'computed_cost', "DECIMAL(10,4) DEFAULT 0");
  // Upgrade menu.cost from DECIMAL(10,2) to DECIMAL(10,4) for tiny ingredient costs
  try { await db.query("ALTER TABLE menu MODIFY COLUMN cost DECIMAL(10,4) DEFAULT 0"); } catch(e) {}
  await addColumnIfMissing('menu', 'pricing_mode', "VARCHAR(20) DEFAULT 'fixed'");
  await addColumnIfMissing('menu', 'markup_pct', "DECIMAL(5,2) DEFAULT 30");
  // V5.7.22 — bilingual product naming (printed on receipt + admin)
  await addColumnIfMissing('menu', 'name_en', "VARCHAR(200) DEFAULT NULL");
  await addColumnIfMissing('inv_items', 'name_en', "VARCHAR(200) DEFAULT NULL");

  // ─── bilingual-i18n-images — Owner A: catalog bilingual (AR/EN) contract ───
  // (db/migrations/0013_bilingual_catalog.sql — wiring notes copied verbatim)
  await addColumnIfMissing('price_lists', 'name_en', "VARCHAR(200) DEFAULT NULL");
  await addColumnIfMissing('brands',      'name_en', "VARCHAR(200) DEFAULT NULL");
  await addColumnIfMissing('branches',    'name_en', "VARCHAR(200) DEFAULT NULL");

  await createTableIfMissing('menu_category_i18n', `
    CREATE TABLE menu_category_i18n (
      category_ar VARCHAR(100) PRIMARY KEY,
      category_en VARCHAR(100) NULL,
      updated_by VARCHAR(100) NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ─── bilingual-i18n-images — Owner A: brand/branch scope (0014) ───
  // (db/migrations/0014_brand_branch_scope.sql — wiring notes copied verbatim)
  // `shifts` is part of the baseline schema (created before runMigrations()
  // ever runs) so its column/index are safe here. `pos_orders` is NOT — it's
  // only created later in this same function (createTableIfMissing('pos_orders', ...)
  // below) — the pos_orders.branch_id column+index moved there. Tier A.2
  // corrective gate, Section 6: this ordering bug meant a fresh install's
  // FIRST boot silently swallowed the pos_orders.branch_id ADD COLUMN
  // (addColumnIfMissing logs-and-continues on "table doesn't exist"), so the
  // column only ever appeared after a SECOND server restart. Discovered via
  // tests/integration/migrationLifecycle.test.js's real server.js boot.
  await addColumnIfMissing('shifts', 'branch_id', "VARCHAR(50) NULL");
  try { await db.query('CREATE INDEX idx_shifts_branch ON shifts(branch_id)'); } catch (e) {}

  // ─── bilingual-i18n-images — Owner D: name_en backfill provenance (0015) ───
  // (db/migrations/0015_name_en_backfill.sql — wiring notes copied verbatim)
  await addColumnIfMissing('menu', 'name_en_source', "ENUM('owner','machine_translation','transliteration') NULL");
  await addColumnIfMissing('menu', 'name_en_needs_review', "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumnIfMissing('menu', 'name_en_reviewed_by', "VARCHAR(100) NULL");
  await addColumnIfMissing('menu', 'name_en_reviewed_at', "DATETIME NULL");
  await createTableIfMissing('name_en_backfill_queue', `
    CREATE TABLE name_en_backfill_queue (
      id VARCHAR(50) PRIMARY KEY,
      menu_id VARCHAR(50) NOT NULL,
      status ENUM('pending','running','done','failed','skipped') NOT NULL DEFAULT 'pending',
      attempt_count INT NOT NULL DEFAULT 0,
      next_attempt_at DATETIME NOT NULL,
      last_error VARCHAR(1000) NULL,
      source_used ENUM('machine_translation','transliteration') NULL,
      proposed_name_en VARCHAR(200) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_nebq_status (status, next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ─── bilingual-i18n-images — Owner D: image sourcing pipeline (0016) ───
  // (db/migrations/0016_image_sourcing_pipeline.sql — wiring notes copied
  // verbatim; table bodies copied from the file's CREATE TABLE statements)
  await createTableIfMissing('image_sourcing_jobs', `
    CREATE TABLE image_sourcing_jobs (
      id                 VARCHAR(50) NOT NULL PRIMARY KEY,
      status             ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
      dry_run            TINYINT(1) NOT NULL DEFAULT 1,
      filter_json        LONGTEXT NULL,
      total_items        INT NOT NULL DEFAULT 0,
      processed_items    INT NOT NULL DEFAULT 0,
      matched_items      INT NOT NULL DEFAULT 0,
      queued_for_review  INT NOT NULL DEFAULT 0,
      created_by         VARCHAR(100) NULL,
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at        DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await createTableIfMissing('image_sourcing_queue', `
    CREATE TABLE image_sourcing_queue (
      id                VARCHAR(50) NOT NULL PRIMARY KEY,
      job_id            VARCHAR(50) NOT NULL,
      menu_id           VARCHAR(50) NOT NULL,
      status            ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
      attempt_count     INT NOT NULL DEFAULT 0,
      next_attempt_at   DATETIME NOT NULL,
      last_error        VARCHAR(1000) NULL,
      INDEX idx_isq_status (status, next_attempt_at),
      INDEX idx_isq_job (job_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await createTableIfMissing('image_candidates', `
    CREATE TABLE image_candidates (
      id               VARCHAR(50) NOT NULL PRIMARY KEY,
      menu_id          VARCHAR(50) NOT NULL,
      job_id           VARCHAR(50) NOT NULL,
      source_provider  VARCHAR(50) NOT NULL,
      source_url       VARCHAR(1000) NOT NULL,
      query_used       VARCHAR(300) NULL,
      license          VARCHAR(100) NULL,
      attribution      VARCHAR(500) NULL,
      author           VARCHAR(200) NULL,
      confidence       DECIMAL(5,4) NOT NULL DEFAULT 0,
      sha256           CHAR(64) NOT NULL,
      phash            CHAR(16) NOT NULL,
      mime             VARCHAR(30) NOT NULL,
      bytes            INT NOT NULL,
      review_status    ENUM('pending','approved','rejected','auto_applied') NOT NULL DEFAULT 'pending',
      reviewer         VARCHAR(100) NULL,
      reviewed_at      DATETIME NULL,
      applied_at       DATETIME NULL,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_candidate_dedupe (menu_id, sha256),
      INDEX idx_ic_phash (phash),
      INDEX idx_ic_review (review_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await createTableIfMissing('image_sourcing_rollback', `
    CREATE TABLE image_sourcing_rollback (
      id               VARCHAR(50) NOT NULL PRIMARY KEY,
      menu_id          VARCHAR(50) NOT NULL,
      job_id           VARCHAR(50) NOT NULL,
      prev_image_data  LONGTEXT NULL,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ─── Semi-finished products (منتجات غير تامة / نصف مصنعة) ───
  // is_semi_finished = TRUE → this menu row is an intermediate (e.g. براد شاي مغربي)
  // production_unit   = display unit for production output (براد، لتر، صحن، قطعة)
  // consumes_semi_id  = if TRUE finished product, points to the semi-finished it consumes
  // consumes_semi_qty = how many units of semi consumed per 1 of this finished product
  // production_warehouse_id = default warehouse where this is produced into
  await addColumnIfMissing('menu', 'is_semi_finished', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('menu', 'production_unit', "VARCHAR(30) DEFAULT 'pcs'");
  await addColumnIfMissing('menu', 'consumes_semi_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('menu', 'consumes_semi_qty', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('menu', 'production_warehouse_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('menu', 'sales_warehouse_id', "VARCHAR(50) DEFAULT NULL");
  // v5.10.16 — big/small unit + conversion + batch yield. Lets semi-
  // finished products be inventoried like raw materials (e.g. produced
  // in 5 LTR batches, consumed by recipes in 100 ML increments). Also
  // applies to finished products that need bulk packaging metadata.
  await addColumnIfMissing('menu', 'unit',          "VARCHAR(30) DEFAULT NULL");      // small unit (consumption)
  await addColumnIfMissing('menu', 'big_unit',      "VARCHAR(30) DEFAULT NULL");      // big unit (production / batch)
  await addColumnIfMissing('menu', 'conv_rate',     "DECIMAL(14,4) DEFAULT 1");       // small per big
  await addColumnIfMissing('menu', 'yield_quantity', "DECIMAL(14,4) DEFAULT 1");      // produced per batch
  await addColumnIfMissing('menu', 'yield_unit',    "VARCHAR(30) DEFAULT NULL");
  // v7.4 — soft-delete flag. Menu rows are never hard-deleted any more (that
  // orphaned sales history + BOM/channel refs and let stale POS caches sell a
  // "ghost" item). is_deleted=1 hides the row from POS + admin everywhere.
  await addColumnIfMissing('menu', 'is_deleted',    "TINYINT(1) NOT NULL DEFAULT 0");

  // Index for finding semi-finished consumers
  try { await db.query('CREATE INDEX idx_menu_semi_id ON menu(is_semi_finished)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_menu_consumes_semi ON menu(consumes_semi_id)'); } catch(e) {}

  // Purchase lots — for future FIFO support (populated on receive, not consumed yet)
  await createTableIfMissing('purchase_lots', `
    CREATE TABLE purchase_lots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      inv_item_id VARCHAR(50) NOT NULL,
      purchase_id VARCHAR(50),
      received_date DATETIME,
      qty_received DECIMAL(12,2) DEFAULT 0,
      qty_remaining DECIMAL(12,2) DEFAULT 0,
      unit_cost DECIMAL(10,4) DEFAULT 0,
      FOREIGN KEY (inv_item_id) REFERENCES inv_items(id) ON DELETE CASCADE,
      INDEX idx_lots_item (inv_item_id),
      INDEX idx_lots_purchase (purchase_id)
    ) ENGINE=InnoDB
  `);

  // Stocktake tables
  await createTableIfMissing('stocktakes', `
    CREATE TABLE stocktakes (
      id VARCHAR(50) PRIMARY KEY,
      stocktake_date DATETIME,
      username VARCHAR(100),
      notes TEXT,
      status ENUM('completed') DEFAULT 'completed',
      items_count INT DEFAULT 0,
      total_variance DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('stocktake_items', `
    CREATE TABLE stocktake_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      stocktake_id VARCHAR(50) NOT NULL,
      inv_item_id VARCHAR(50),
      inv_item_name VARCHAR(200),
      unit VARCHAR(50),
      system_qty DECIMAL(12,2) DEFAULT 0,
      actual_qty DECIMAL(12,2) DEFAULT 0,
      variance DECIMAL(12,2) DEFAULT 0,
      FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Stock adjustment tables (تعديل كمية — تالف / إداري / تسويات)
  await createTableIfMissing('stock_adjustments', `
    CREATE TABLE stock_adjustments (
      id VARCHAR(50) PRIMARY KEY,
      adjustment_date DATETIME,
      reason ENUM('damaged','admin','settlement') DEFAULT 'damaged',
      reason_notes TEXT,
      username VARCHAR(100),
      status ENUM('pending','approved') DEFAULT 'pending',
      items_count INT DEFAULT 0,
      total_cost DECIMAL(12,2) DEFAULT 0,
      approved_by VARCHAR(100),
      approved_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('stock_adjustment_items', `
    CREATE TABLE stock_adjustment_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      adjustment_id VARCHAR(50) NOT NULL,
      inv_item_id VARCHAR(50),
      inv_item_name VARCHAR(200),
      unit VARCHAR(50),
      qty DECIMAL(12,2) DEFAULT 0,
      unit_cost DECIMAL(10,4) DEFAULT 0,
      total_cost DECIMAL(12,2) DEFAULT 0,
      stock_before DECIMAL(12,2) DEFAULT 0,
      stock_after DECIMAL(12,2) DEFAULT 0,
      FOREIGN KEY (adjustment_id) REFERENCES stock_adjustments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Shortage requests tables
  await createTableIfMissing('shortage_requests', `
    CREATE TABLE shortage_requests (
      id VARCHAR(50) PRIMARY KEY,
      request_number VARCHAR(20),
      request_date DATETIME,
      username VARCHAR(100),
      notes TEXT,
      status ENUM('pending','approved','rejected','converted','partially_received','fully_received','closed') DEFAULT 'pending',
      supply_mode ENUM('parent_company','warehouse') DEFAULT 'parent_company',
      total_items INT DEFAULT 0,
      approved_by VARCHAR(100),
      approved_at DATETIME,
      po_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('shortage_items', `
    CREATE TABLE shortage_items (
      id VARCHAR(50) PRIMARY KEY,
      request_id VARCHAR(50) NOT NULL,
      inv_item_id VARCHAR(50),
      inv_item_name VARCHAR(200),
      unit VARCHAR(50),
      current_qty DECIMAL(12,2) DEFAULT 0,
      min_qty DECIMAL(12,2) DEFAULT 0,
      requested_qty DECIMAL(12,2) DEFAULT 0,
      unit_price DECIMAL(10,4) DEFAULT 0,
      FOREIGN KEY (request_id) REFERENCES shortage_requests(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Cost centers table
  await createTableIfMissing('cost_centers', `
    CREATE TABLE cost_centers (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) NOT NULL,
      name VARCHAR(200) NOT NULL,
      type ENUM('branch','department','project') DEFAULT 'branch',
      parent_id VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Warehouses table (multi-warehouse)
  await createTableIfMissing('warehouses', `
    CREATE TABLE warehouses (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) NOT NULL,
      name VARCHAR(200) NOT NULL,
      type ENUM('branch','main','production','waste','raw','finished') DEFAULT 'branch',
      branch_id VARCHAR(50),
      location VARCHAR(200),
      manager VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Warehouses: add brand + cost center columns
  await addColumnIfMissing('warehouses', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('warehouses', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('warehouses', 'name_en', "VARCHAR(200) NULL"); // B3 — bilingual warehouse name

  // Warehouse stock (per-warehouse inventory)
  await createTableIfMissing('warehouse_stock', `
    CREATE TABLE warehouse_stock (
      id VARCHAR(50) PRIMARY KEY,
      warehouse_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      qty DECIMAL(12,2) DEFAULT 0,
      UNIQUE KEY uq_wh_item (warehouse_id, item_id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Warehouse transfers
  await createTableIfMissing('warehouse_transfers', `
    CREATE TABLE warehouse_transfers (
      id VARCHAR(50) PRIMARY KEY,
      transfer_number VARCHAR(20),
      from_warehouse_id VARCHAR(50),
      to_warehouse_id VARCHAR(50),
      transfer_date DATETIME,
      status ENUM('draft','approved','completed','cancelled') DEFAULT 'draft',
      items_json LONGTEXT,
      notes TEXT,
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Phase 2A.2 — per-user warehouse access (membership only; operation rights
  // stay in RBAC). admin/developer get IMPLICIT all-access in code, so they
  // need no rows here. A user with NO row sees no warehouse once enforcement
  // is on (WAREHOUSE_SCOPE_ENFORCE). Idempotent; safe to re-run.
  await createTableIfMissing('user_warehouse_access', `
    CREATE TABLE user_warehouse_access (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(100),
      UNIQUE KEY uq_user_warehouse (user_id, warehouse_id),
      KEY idx_uwa_user (user_id),
      KEY idx_uwa_warehouse (warehouse_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // FKs are best-effort: the project does not enforce a warehouses(branch_id)
  // FK, and a legacy DB with a mismatched engine/charset must not break boot.
  try {
    const [fk] = await db.query(
      "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_warehouse_access' AND CONSTRAINT_TYPE='FOREIGN KEY' LIMIT 1");
    if (!fk.length) {
      await db.query("ALTER TABLE user_warehouse_access ADD CONSTRAINT fk_uwa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE");
      await db.query("ALTER TABLE user_warehouse_access ADD CONSTRAINT fk_uwa_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE");
    }
  } catch (e) { console.log('[DB] user_warehouse_access FK skipped:', String(e.message).substring(0, 120)); }

  // Branches: add new columns
  await addColumnIfMissing('branches', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('branches', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('branches', 'manager', "VARCHAR(100)");
  await addColumnIfMissing('branches', 'supply_mode', "ENUM('parent_company','warehouse','auto') DEFAULT 'parent_company'");

  // Custody expenses: cost_center_id/cost_center_name/pre_approval_status
  // moved to right after createTableIfMissing('custody_expenses', ...) below
  // — `custody_expenses` is not part of the baseline schema, it's only
  // created later in this same function, so on a fresh install these ADD
  // COLUMNs silently failed here (addColumnIfMissing logs-and-continues on
  // "table doesn't exist") and only appeared after a second server restart.
  // Same ordering-bug class as Tier A.2 Section 6 (pos_orders.branch_id).

  // ═══════════════════════════════════════
  // WORKFLOW ENGINE TABLES (نظام المعاملات)
  // ═══════════════════════════════════════

  // Administrative positions (المناصب الإدارية)
  await createTableIfMissing('positions', `
    CREATE TABLE positions (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      level INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Permissions (الصلاحيات)
  await createTableIfMissing('permissions', `
    CREATE TABLE permissions (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(100) NOT NULL UNIQUE,
      description VARCHAR(200)
    ) ENGINE=InnoDB
  `);

  // Position-Permission mapping
  await createTableIfMissing('position_permissions', `
    CREATE TABLE position_permissions (
      id VARCHAR(50) PRIMARY KEY,
      position_id VARCHAR(50) NOT NULL,
      permission_id VARCHAR(50) NOT NULL,
      UNIQUE KEY uq_pos_perm (position_id, permission_id)
    ) ENGINE=InnoDB
  `);

  // Transaction types (أنواع المعاملات)
  await createTableIfMissing('transaction_types', `
    CREATE TABLE transaction_types (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(50) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Workflow definitions (خطوات المعاملة)
  await createTableIfMissing('workflow_definitions', `
    CREATE TABLE workflow_definitions (
      id VARCHAR(50) PRIMARY KEY,
      transaction_type_id VARCHAR(50) NOT NULL,
      step_order INT NOT NULL,
      step_name VARCHAR(200) NOT NULL,
      required_position_id VARCHAR(50),
      can_edit_amount BOOLEAN DEFAULT FALSE,
      can_return_to_previous BOOLEAN DEFAULT TRUE,
      is_final_step BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (transaction_type_id) REFERENCES transaction_types(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Workflow step users (optional — specific user for step)
  await createTableIfMissing('workflow_step_users', `
    CREATE TABLE workflow_step_users (
      id VARCHAR(50) PRIMARY KEY,
      workflow_definition_id VARCHAR(50) NOT NULL,
      user_id VARCHAR(50) NOT NULL,
      FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Transactions (المعاملات)
  await createTableIfMissing('transactions', `
    CREATE TABLE transactions (
      id VARCHAR(50) PRIMARY KEY,
      transaction_number VARCHAR(20),
      transaction_type_id VARCHAR(50) NOT NULL,
      created_by VARCHAR(100),
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      title VARCHAR(300) NOT NULL,
      description TEXT,
      amount DECIMAL(12,2) DEFAULT 0,
      status ENUM('draft','pending','in_progress','rejected','approved','closed') DEFAULT 'draft',
      current_step_id VARCHAR(50),
      attachment LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (transaction_type_id) REFERENCES transaction_types(id)
    ) ENGINE=InnoDB
  `);

  // Transaction steps log (سجل الحركات)
  await createTableIfMissing('transaction_steps_log', `
    CREATE TABLE transaction_steps_log (
      id VARCHAR(50) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      workflow_definition_id VARCHAR(50),
      action_by VARCHAR(100),
      action_type ENUM('create','approve','reject','return','forward','close') NOT NULL,
      action_note TEXT,
      attachment LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Link users to positions
  await addColumnIfMissing('users', 'position_id', "VARCHAR(50)");

  // Transaction enhancements — accounting link + recipient
  await addColumnIfMissing('transactions', 'account_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'account_code', "VARCHAR(20)");
  await addColumnIfMissing('transactions', 'account_name', "VARCHAR(200)");
  await addColumnIfMissing('transactions', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'cost_center_name', "VARCHAR(200)");
  await addColumnIfMissing('transactions', 'recipient_username', "VARCHAR(100)");
  await addColumnIfMissing('transactions', 'sender_name', "VARCHAR(200)");
  await addColumnIfMissing('transactions', 'sender_position', "VARCHAR(200)");
  await addColumnIfMissing('transaction_steps_log', 'attachment', "LONGTEXT");
  await addColumnIfMissing('transaction_steps_log', 'position_name', "VARCHAR(200)");

  // ─── V3: CEO approval tracking ───
  // Set when a transaction passes through any position with level >= 9 (CEO/owner)
  await addColumnIfMissing('transactions', 'passed_ceo_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('transactions', 'passed_ceo_by', "VARCHAR(100) DEFAULT NULL");

  // ─── V3.1: Returned-for-edit tracking ───
  // Distinct from "rejected": the reviewer wants the creator to fix something
  // and resubmit. Creator should be able to edit + re-send. Status reads "مرجعة للتعديل".
  await addColumnIfMissing('transactions', 'returned_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('transactions', 'returned_by', "VARCHAR(100) DEFAULT NULL");
  await addColumnIfMissing('transactions', 'returned_reason', "VARCHAR(500) DEFAULT NULL");
  await addColumnIfMissing('transactions', 'return_count', "INT DEFAULT 0");
  // v8 SAFETY (G3) — the V3.1 "extend to include 'returned'" ALTER that lived here
  // was DELETED. Relative to the V4.1 statement just below it, it NARROWED the
  // enum (its list lacked 'created' and 'replied'), and MySQL runs MODIFY COLUMN
  // as a table rebuild: on every boot, any row sitting in 'created' or 'replied'
  // during the narrow pass could be coerced ('' / first member) before the V4.1
  // statement re-widened the enum microseconds later. The V4.1 ALTER below is a
  // superset (it includes 'returned'), so nothing is lost by dropping this one.

  // ═══════════════════════════════════════════════════════════════════
  // V4 — Workflow Engine (Full Plan Execution)
  // 8-state machine + optimistic locking + counters + SLA + per-recipient sub-status
  // ═══════════════════════════════════════════════════════════════════

  // V4.1 — extend status ENUM to 8 states (added: 'created', 'replied')
  try {
    await db.query("ALTER TABLE transactions MODIFY COLUMN status ENUM('draft','pending','created','in_progress','replied','returned','rejected','approved','closed') DEFAULT 'draft'");
  } catch(e) { /* tolerate */ }

  // V4.2 — Optimistic concurrency control (prevents race conditions)
  await addColumnIfMissing('transactions', 'version', "INT DEFAULT 0 NOT NULL");

  // V4.3 — Track returned-to step (resume at correct point on resubmit)
  await addColumnIfMissing('transactions', 'returned_to_step_id', "VARCHAR(50) DEFAULT NULL");

  // V4.4 — First view tracking (created → in_progress trigger)
  await addColumnIfMissing('transactions', 'first_viewed_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('transactions', 'first_viewed_by', "VARCHAR(100) DEFAULT NULL");

  // V4.5 — SLA tracking
  await addColumnIfMissing('transactions', 'sla_hours', "INT DEFAULT 72");
  await addColumnIfMissing('transactions', 'due_date', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('transactions', 'escalated_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('transactions', 'escalation_count', "INT DEFAULT 0");

  // V4.6 — Per-recipient sub-status (multi-recipient awareness). Moved to
  // right after createTableIfMissing('txn_recipients', ...) further down —
  // `txn_recipients` isn't part of the baseline schema, it's only created
  // later in this same function, so on a fresh install these ADD COLUMNs
  // silently failed here (addColumnIfMissing logs-and-continues on "table
  // doesn't exist") and only appeared after a second server restart. Same
  // ordering-bug class as Tier A.2 Section 6 (pos_orders.branch_id).

  // V4.7 — Reply-stage linking (so we can enforce "one reply per stage per
  // actor"). Moved to right after createTableIfMissing('transaction_replies',
  // ...) further up in this function, for the same reason as V4.6 above —
  // `transaction_replies` is created later than this line.

  // V4.8 — Action log enhancements (link reply + step + previous step for return)
  await addColumnIfMissing('transaction_steps_log', 'reply_id', "VARCHAR(60) DEFAULT NULL");
  await addColumnIfMissing('transaction_steps_log', 'from_step_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('transaction_steps_log', 'to_step_id', "VARCHAR(50) DEFAULT NULL");

  // Tier A.3 Release Gate — current_assignee/subject/content_html are
  // (idempotently) added again later in this same function (~line 4174-4185)
  // — that's still where their canonical addColumnIfMissing calls live, not
  // duplicated logic. But three things BETWEEN here and there reference them
  // first: the CREATE INDEX just below, the "counters backfill" block
  // further down (current_assignee), and the utf8mb4 MODIFY COLUMN pass
  // right after it (subject, content_html) — all three used to silently
  // no-op/skip on a fresh install (index never created, backfill silently
  // caught its own error, utf8mb4 enforcement skipped a column "that may
  // not exist yet" per its own comment) and only start working on a SECOND
  // restart, once the later addColumnIfMissing calls had already run once.
  // Ensuring the columns exist right here — before any of the three — makes
  // all of them converge on the FIRST boot, same ordering-bug class as
  // pos_orders.branch_id (Tier A.2 Section 6). addColumnIfMissing is a
  // pure no-op on the real second call further down, so nothing here
  // changes behavior for any environment that already boots cleanly today.
  await addColumnIfMissing('transactions', 'current_assignee', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('transactions', 'subject', "VARCHAR(500) DEFAULT ''");
  await addColumnIfMissing('transactions', 'content_html', "LONGTEXT");

  // V4.9 — Performance indexes
  // Inbox query (most common): WHERE current_assignee = ? AND status IN ...
  try { await db.query("CREATE INDEX idx_txn_assignee_status ON transactions (current_assignee, status, created_at DESC)"); } catch(e) {}
  // Outbox query
  try { await db.query("CREATE INDEX idx_txn_creator_status ON transactions (created_by, status, created_at DESC)"); } catch(e) {}
  // Returned items
  try { await db.query("CREATE INDEX idx_txn_returned ON transactions (status, returned_at)"); } catch(e) {}
  // Action log
  try { await db.query("CREATE INDEX idx_log_txn_actor ON transaction_steps_log (transaction_id, action_by, action_type)"); } catch(e) {}
  try { await db.query("CREATE INDEX idx_log_actor_step ON transaction_steps_log (action_by, workflow_definition_id, action_type)"); } catch(e) {}
  // Replies pagination
  try { await db.query("CREATE INDEX idx_replies_txn_created ON transaction_replies (transaction_id, created_at DESC)"); } catch(e) {}
  // SLA enforcement
  try { await db.query("CREATE INDEX idx_txn_due ON transactions (due_date, status)"); } catch(e) {}

  // V4.10.2 — FORCE recreate user_inbox_counters every boot until schema is correct.
  // Some legacy schema (probably from an older Railway deploy) has the table
  // without a `username` column, causing "Unknown column 'username'" errors.
  // Since this is just a materialization rebuilt from transactions, dropping is safe.
  // Drop dependent triggers first to avoid orphan-trigger issues.
  try { await db.query("DROP TRIGGER IF EXISTS trg_txn_counter_after_insert"); } catch(_) {}
  try { await db.query("DROP TRIGGER IF EXISTS trg_txn_counter_after_update"); } catch(_) {}
  try { await db.query("DROP TRIGGER IF EXISTS trg_txn_counter_after_delete"); } catch(_) {}
  try { await db.query("DROP TABLE IF EXISTS user_inbox_counters"); console.log('[DB] dropped legacy user_inbox_counters table'); } catch(e) { console.warn('[DB] drop user_inbox_counters:', e.message); }
  try {
    await db.query(`
      CREATE TABLE user_inbox_counters (
        username VARCHAR(100) PRIMARY KEY,
        pending_action      INT DEFAULT 0,
        returned_to_me      INT DEFAULT 0,
        awaiting_others     INT DEFAULT 0,
        overdue             INT DEFAULT 0,
        unread_replies      INT DEFAULT 0,
        total_outbox        INT DEFAULT 0,
        total_inbox         INT DEFAULT 0,
        last_computed_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[DB] created user_inbox_counters with correct schema');
  } catch(e) { console.warn('[DB] create user_inbox_counters:', e.message); }

  // V4.11 — Audit log (if not already present)
  await createTableIfMissing('audit_logs', `
    CREATE TABLE audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_username VARCHAR(100),
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(40) NOT NULL,
      entity_id VARCHAR(80),
      details TEXT,
      ip_address VARCHAR(45),
      user_agent VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_user (user_username, created_at DESC),
      INDEX idx_audit_entity (entity_type, entity_id),
      INDEX idx_audit_action (action, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // V4.12 — Notifications table (for SSE inbox + escalations)
  await createTableIfMissing('notifications', `
    CREATE TABLE notifications (
      id VARCHAR(60) PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      type VARCHAR(40) NOT NULL,
      title VARCHAR(300),
      body TEXT,
      link_type VARCHAR(40),
      link_id VARCHAR(80),
      severity ENUM('info','success','warning','danger') DEFAULT 'info',
      is_read TINYINT(1) DEFAULT 0,
      read_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_notif_user (username, is_read, created_at DESC),
      INDEX idx_notif_link (link_type, link_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // V4.13/V4.6.2 — Counter triggers REMOVED to fix collation conflict.
  // The old triggers compared user_inbox_counters.username (utf8mb4_unicode_ci)
  // with transactions.current_assignee (utf8mb4_0900_ai_ci on Railway), throwing
  // "Illegal mix of collations" on every UPDATE — silently failing
  // reply+andAdvance, return, forward, and any workflow transition.
  // Counters now compute live in routes/counters.js (no triggers needed).
  try { await db.query("DROP TRIGGER IF EXISTS trg_txn_counter_after_insert"); } catch(e) {}
  try { await db.query("DROP TRIGGER IF EXISTS trg_txn_counter_after_update"); } catch(e) {}
  try { await db.query("DROP TRIGGER IF EXISTS trg_txn_counter_after_delete"); } catch(e) {}

  // V4.15 — Soft-delete pattern (transactions can be archived without losing data)
  await addColumnIfMissing('transactions', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('transactions', 'deleted_by', "VARCHAR(100) DEFAULT NULL");
  await addColumnIfMissing('transactions', 'delete_reason', "VARCHAR(500) DEFAULT NULL");
  try { await db.query("CREATE INDEX idx_txn_deleted ON transactions (deleted_at)"); } catch(e) {}

  // V4.16 — Workflow routes JSON-DSL table (allows branching/conditional steps as JSON)
  await createTableIfMissing('workflow_routes', `
    CREATE TABLE workflow_routes (
      id VARCHAR(60) PRIMARY KEY,
      transaction_type_id VARCHAR(60),
      initiator_position_id VARCHAR(60),
      route_name VARCHAR(200),
      is_default TINYINT(1) DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      conditions JSON DEFAULT NULL,
      steps JSON NOT NULL,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_route_type_pos (transaction_type_id, initiator_position_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // V4.14 — Backfill counters from existing data (one-time)
  try {
    await db.query("DELETE FROM user_inbox_counters");
    await db.query(`
      INSERT INTO user_inbox_counters (username, pending_action, total_inbox)
      SELECT current_assignee,
             SUM(CASE WHEN status IN ('pending','created','in_progress','replied') THEN 1 ELSE 0 END),
             COUNT(*)
        FROM transactions
        WHERE current_assignee IS NOT NULL AND current_assignee != ''
        GROUP BY current_assignee
      ON DUPLICATE KEY UPDATE
        pending_action = VALUES(pending_action),
        total_inbox = VALUES(total_inbox)
    `);
    await db.query(`
      INSERT INTO user_inbox_counters (username, awaiting_others, total_outbox, returned_to_me)
      SELECT created_by,
             SUM(CASE WHEN status IN ('pending','created','in_progress','replied') THEN 1 ELSE 0 END),
             COUNT(*),
             SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END)
        FROM transactions
        WHERE created_by IS NOT NULL AND created_by != ''
        GROUP BY created_by
      ON DUPLICATE KEY UPDATE
        awaiting_others = VALUES(awaiting_others),
        total_outbox = VALUES(total_outbox),
        returned_to_me = VALUES(returned_to_me)
    `);
  } catch(e) { console.warn('[counters backfill]:', e.message); }

  // ─── V3: Transaction Replies (proper threaded comments, separate from action log) ───
  await createTableIfMissing('transaction_replies', `
    CREATE TABLE transaction_replies (
      id VARCHAR(60) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      reply_text TEXT NOT NULL,
      attachment LONGTEXT,
      author_username VARCHAR(100) NOT NULL,
      author_name VARCHAR(200),
      author_role VARCHAR(50),
      author_position VARCHAR(200),
      is_internal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_replies_txn (transaction_id),
      INDEX idx_replies_author (author_username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // V4.7 — transaction_replies.stage_step_id moved here (was mis-ordered
  // above the table's own creation — see the comment near the old location).
  // Must run AFTER the CREATE TABLE immediately above.
  await addColumnIfMissing('transaction_replies', 'stage_step_id', "VARCHAR(50) DEFAULT NULL");
  // V3.1: rich attachment metadata + ensure utf8mb4 on existing deploys
  await addColumnIfMissing('transaction_replies', 'attachment_name', "VARCHAR(255) DEFAULT NULL");
  await addColumnIfMissing('transaction_replies', 'attachment_mime', "VARCHAR(100) DEFAULT NULL");
  // V3.1 FORCE utf8mb4 on each Arabic-bearing text column individually.
  // This is more reliable than CONVERT TO TABLE which can fail silently or
  // partially. We MODIFY each column with explicit charset/collation.
  // For BLOB-like LONGTEXT/MEDIUMTEXT we skip — the data goes in/out as bytes.
  // MySQL requires CHARACTER SET / COLLATE immediately after the data type;
  // column attributes such as NOT NULL and DEFAULT must come afterwards.
  // Appending the charset after the complete declaration produced a syntax
  // error on every startup and silently skipped Arabic-column normalization.
  const _utf8mb4 = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
  const _utf8mb4Cols = [
    ['transaction_replies', 'reply_text', `TEXT ${_utf8mb4} NOT NULL`],
    ['transaction_replies', 'author_name', `VARCHAR(200) ${_utf8mb4}`],
    ['transaction_replies', 'author_position', `VARCHAR(200) ${_utf8mb4}`],
    ['transaction_replies', 'attachment_name', `VARCHAR(255) ${_utf8mb4} DEFAULT NULL`],
    ['transactions', 'title', `VARCHAR(300) ${_utf8mb4} NOT NULL`],
    ['transactions', 'subject', `VARCHAR(300) ${_utf8mb4} DEFAULT NULL`],
    ['transactions', 'description', `TEXT ${_utf8mb4}`],
    ['transactions', 'content_html', `MEDIUMTEXT ${_utf8mb4}`],
    ['transactions', 'returned_reason', `VARCHAR(500) ${_utf8mb4} DEFAULT NULL`],
    ['transactions', 'sender_name', `VARCHAR(200) ${_utf8mb4} DEFAULT NULL`],
    ['transactions', 'sender_position', `VARCHAR(200) ${_utf8mb4} DEFAULT NULL`],
    ['transactions', 'account_name', `VARCHAR(200) ${_utf8mb4} DEFAULT NULL`],
    ['transactions', 'cost_center_name', `VARCHAR(200) ${_utf8mb4} DEFAULT NULL`],
    ['transaction_steps_log', 'action_note', `TEXT ${_utf8mb4}`],
    ['transaction_steps_log', 'position_name', `VARCHAR(200) ${_utf8mb4} DEFAULT NULL`]
  ];
  for (const [table, col, declaration] of _utf8mb4Cols) {
    try {
      await db.query(`ALTER TABLE ${table} MODIFY COLUMN ${col} ${declaration}`);
    } catch(e) {
      // Tolerate: column may not exist yet in legacy deploys, OR may be a
      // type we don't recognize. Don't crash startup — just log.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[utf8mb4] ${table}.${col}:`, e.message);
      }
    }
  }
  try { await db.query("ALTER TABLE transaction_replies CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); } catch(e) {}

  // ─── V3: Memo (تعاميم) read-receipts ───
  await createTableIfMissing('memo_read_receipts', `
    CREATE TABLE memo_read_receipts (
      id VARCHAR(60) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      username VARCHAR(100) NOT NULL,
      read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_memo_user (transaction_id, username),
      INDEX idx_memo_user (username)
    ) ENGINE=InnoDB
  `);

  // ─── V3: Memo transaction type ───
  // The system already seeds 'TT-MEMO' (code='MEMO', name='مذكرة داخلية') from
  // routes/workflow.js. /memos-inbox accepts both 'MEMO' and 'MEMO_CIRCULAR'
  // codes, so no seed needed here.

  // ─── V3: RBAC (Role-Based Access Control) ───
  // Granular per-permission access. Replaces old role==='admin' checks.
  await createTableIfMissing('permissions_v3', `
    CREATE TABLE permissions_v3 (
      id VARCHAR(80) PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      label_ar VARCHAR(200) NOT NULL,
      label_en VARCHAR(200),
      description TEXT,
      is_sensitive BOOLEAN DEFAULT FALSE,
      sort_order INT DEFAULT 0,
      INDEX idx_perm_cat (category)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('role_permissions', `
    CREATE TABLE role_permissions (
      role VARCHAR(50) NOT NULL,
      permission_id VARCHAR(80) NOT NULL,
      PRIMARY KEY (role, permission_id),
      INDEX idx_rp_role (role)
    ) ENGINE=InnoDB
  `);
  // o2c.* capabilities seed (db/migrations/order-to-cash/capabilities.js)
  // moved here — it INSERT IGNOREs into permissions_v3 + role_permissions,
  // but those tables were only created just above (createTableIfMissing,
  // this same function). It used to run right after schema.apply() near the
  // top of runMigrations(), long before permissions_v3/role_permissions
  // existed on a fresh install — the INSERTs silently failed (caught by the
  // try/catch there, which just logs a warning), so o2c.* capabilities and
  // role grants never appeared until a second server restart. Same
  // ordering-bug class as Tier A.2 Section 6 (pos_orders.branch_id).
  try {
    await require('./db/migrations/order-to-cash/capabilities').seedO2CCapabilities(db, (m) => console.log('[o2c-caps]', m));
  } catch (e) {
    console.log('[DB] Migration warning (o2c capabilities):', e.message.substring(0, 160));
  }
  // Closure-stream capability declarations (db/migrations/capability-seeds/*.json)
  // — moved here from right after schema.apply() near the top of this
  // function (see the comment at the old location). Loud on failure: a
  // capability that silently fails to seed turns into a 403 for a role that
  // legitimately holds the work — the exact class of bug the one-shot
  // seeder caused before the late-seed block existed.
  try {
    await require('./db/migrations/capability-seeds/apply').applyCapabilitySeeds(db, (m) => console.log('[cap-seeds]', m));
  } catch (e) {
    console.error('[DB] capability-seeds FAILED (roles may 403 on new routes):', e.message);
  }
  await createTableIfMissing('user_permission_overrides', `
    CREATE TABLE user_permission_overrides (
      username VARCHAR(100) NOT NULL,
      permission_id VARCHAR(80) NOT NULL,
      grant_type ENUM('grant','revoke') NOT NULL,
      granted_by VARCHAR(100),
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, permission_id),
      INDEX idx_upo_user (username)
    ) ENGINE=InnoDB
  `);

  // Extend users.role ENUM to the canonical assignable set (lib/roles.js).
  // HISTORY, because this line used to be a silent fight: this ALTER once
  // listed finance/hr/inventory/purchasing, and a second, OLDER ALTER further
  // down (the employee-portal migration) re-narrowed the enum to five values
  // on every boot — both wrapped in empty catches, so the widen shipped here
  // NEVER actually survived a startup. That narrowing ALTER is now gone.
  // hr/inventory/purchasing stay grant-only (role_permissions groupings, not
  // storable roles) — making them assignable is a product decision nobody has
  // made; accountant/finance/sales are assignable per the roles directive.
  // Tier A.1 corrective gate — this exact statement re-narrowing the enum
  // on every boot is precisely the failure mode the comment above already
  // warns about (a legacy ALTER silently reverting a widening one). It just
  // happened again from the other direction: db/migrations/0016_auditor_
  // role.sql widened the enum to add 'auditor', but since THIS statement
  // runs unconditionally on every server start (unlike db/migrate.js, which
  // nothing invokes automatically — see db/migrations/README.md) it reset
  // the enum back to the 8-value list on the very next boot, breaking any
  // attempt to create/keep an auditor account. Kept in sync with 0016 here.
  // Tier A.2 corrective gate — this ALTER ran unconditionally on every
  // single boot, forever, even when the enum already matched (which is
  // every boot after the very first one). Real DDL, however cheap it
  // looks, still takes a metadata lock on `users` — a hot table read on
  // nearly every request — for no reason once the schema is already
  // correct. Now compares the column's CURRENT enum definition (read from
  // INFORMATION_SCHEMA, not assumed) against the target and only runs the
  // ALTER when they genuinely differ.
  try {
    const TARGET_ROLE_ENUM = "enum('admin','cashier','manager','custody','employee','accountant','finance','sales','auditor')";
    const [roleCol] = await db.query(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`
    );
    const currentRoleEnum = roleCol.length ? String(roleCol[0].COLUMN_TYPE || '').toLowerCase() : '';
    if (currentRoleEnum !== TARGET_ROLE_ENUM) {
      await db.query("ALTER TABLE users MODIFY COLUMN role ENUM('admin','cashier','manager','custody','employee','accountant','finance','sales','auditor') DEFAULT 'cashier'");
    }
  } catch(e) { console.error('[migrations] users.role widen failed:', e && (e.code || e.message)); }

  // Seed permissions catalog (idempotent)
  try {
    const [pcnt] = await db.query("SELECT COUNT(*) AS c FROM permissions_v3");
    if (pcnt[0].c === 0) {
      const perms = [
        // POS / Cashier
        ['pos.use', 'pos', 'استخدام شاشة الكاشير', 'Use POS', 0, 110],
        ['pos.shift_close', 'pos', 'إغلاق الشيفت', 'Close shift', 0, 120],
        ['pos.discount.apply', 'pos', 'تطبيق خصومات على الفواتير', 'Apply discounts', 0, 130],
        ['pos.refund', 'pos', 'استرجاع فواتير', 'Refund sales', 1, 140],
        // Sales
        ['sales.view', 'sales', 'عرض سجل المبيعات', 'View sales log', 0, 210],
        ['sales.delete', 'sales', 'حذف فواتير المبيعات', 'Delete sales', 1, 220],
        ['sales.reports.view', 'sales', 'عرض تقارير المبيعات', 'View sales reports', 0, 230],
        ['sales.reports.advanced', 'sales', 'عرض التقارير المتقدمة', 'View advanced reports', 0, 240],
        // Inventory
        ['inventory.view', 'inventory', 'عرض المخزون والجرد', 'View inventory', 0, 310],
        ['inventory.edit', 'inventory', 'تعديل المخزون', 'Edit inventory', 0, 320],
        ['warehouse.view', 'inventory', 'عرض المستودعات', 'View warehouses', 0, 330],
        ['warehouse.transfer', 'inventory', 'تحويل بين المستودعات', 'Warehouse transfers', 0, 340],
        ['waste.create', 'inventory', 'تسجيل قيود الهدر', 'Record waste', 0, 350],
        ['production.view', 'inventory', 'عرض أوامر الإنتاج', 'View production', 0, 360],
        ['production.create', 'inventory', 'إنشاء أمر إنتاج', 'Create production order', 0, 370],
        ['production.complete', 'inventory', 'إكمال أمر إنتاج', 'Complete production', 0, 380],
        // Purchasing
        ['purchases.view', 'purchasing', 'عرض المشتريات', 'View purchases', 0, 410],
        ['purchases.create', 'purchasing', 'إنشاء أمر شراء', 'Create PO', 0, 420],
        ['purchases.approve', 'purchasing', 'اعتماد أوامر الشراء', 'Approve PO', 1, 430],
        ['suppliers.view', 'purchasing', 'عرض الموردين', 'View suppliers', 0, 440],
        ['suppliers.edit', 'purchasing', 'تعديل الموردين', 'Edit suppliers', 0, 450],
        // Finance
        ['finance.view', 'finance', 'عرض القسم المالي', 'View finance section', 0, 510],
        ['finance.gl.view', 'finance', 'عرض القيود المحاسبية', 'View journals', 0, 520],
        ['finance.gl.create', 'finance', 'إنشاء قيود يدوية', 'Create manual journals', 1, 530],
        ['finance.gl.approve', 'finance', 'اعتماد القيود', 'Approve journals', 1, 540],
        ['finance.reports.view', 'finance', 'عرض التقارير المالية (IFRS)', 'View financial reports', 0, 550],
        ['finance.cash.view', 'finance', 'عرض النقدية والبنوك', 'View cash & banks', 0, 560],
        ['finance.cash.transfer', 'finance', 'تحويلات نقدية', 'Cash transfers', 1, 570],
        ['finance.payment.create', 'finance', 'إنشاء سداد', 'Create payment', 1, 580],
        ['finance.expenses.view', 'finance', 'عرض المصروفات', 'View expenses', 0, 590],
        ['finance.expenses.approve', 'finance', 'اعتماد المصروفات', 'Approve expenses', 1, 600],
        // HR
        ['hr.view', 'hr', 'عرض قسم الموارد البشرية', 'View HR section', 0, 610],
        ['hr.employees.view', 'hr', 'عرض الموظفين', 'View employees', 0, 620],
        ['hr.employees.edit', 'hr', 'تعديل بيانات الموظفين', 'Edit employees', 1, 630],
        ['hr.attendance.view', 'hr', 'عرض الحضور والانصراف', 'View attendance', 0, 640],
        ['hr.payroll.view', 'hr', 'عرض الرواتب', 'View payroll', 1, 650],
        ['hr.payroll.run', 'hr', 'تشغيل الرواتب', 'Run payroll', 1, 660],
        ['hr.advances.approve', 'hr', 'اعتماد السلف', 'Approve advances', 1, 670],
        // Workflow / Transactions
        ['txn.view', 'workflow', 'عرض المعاملات', 'View transactions', 0, 710],
        ['txn.create', 'workflow', 'إنشاء معاملة', 'Create transaction', 0, 720],
        ['txn.approve', 'workflow', 'الموافقة على المعاملات', 'Approve transactions', 0, 730],
        ['txn.reject', 'workflow', 'الرفض', 'Reject transactions', 0, 740],
        ['txn.return', 'workflow', 'الإرجاع', 'Return transactions', 0, 750],
        // Organization / Admin
        ['org.brands.view', 'admin', 'عرض البراندات', 'View brands', 0, 810],
        ['org.brands.edit', 'admin', 'تعديل البراندات', 'Edit brands', 1, 820],
        ['org.branches.edit', 'admin', 'تعديل الفروع', 'Edit branches', 1, 830],
        ['org.companies.edit', 'admin', 'تعديل الشركات', 'Edit companies', 1, 840],
        ['admin.users.manage', 'admin', 'إدارة المستخدمين والصلاحيات', 'Manage users & permissions', 1, 850],
        ['admin.audit.view', 'admin', 'عرض سجل العمليات', 'View audit log', 1, 860],
        // Tax / Channels
        ['tax.view', 'tax', 'عرض تقارير الضريبة وZATCA', 'View tax & ZATCA', 0, 910],
        ['payment_methods.manage', 'tax', 'إدارة طرق الدفع', 'Manage payment methods', 1, 920],
        ['channels.manage', 'tax', 'إدارة قنوات البيع', 'Manage sales channels', 1, 930],
        ['discounts.manage', 'tax', 'إدارة الخصومات', 'Manage discounts', 1, 940]
      ];
      for (const p of perms) {
        await db.query(
          'INSERT IGNORE INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive, sort_order) VALUES (?,?,?,?,?,?)',
          [p[0], p[1], p[2], p[3], p[4], p[5]]
        );
      }
    }
  } catch(e) { console.error('seed permissions_v3 failed:', e.message); }

  // ─── Late-added capabilities (v4+) ───
  // The block above is labelled "idempotent" but is really ONE-SHOT: it only
  // runs when the catalog is empty, so a capability appended to that array
  // would never reach an install that has already booted once. Anything added
  // after the first seed has to go here, where INSERT IGNORE runs every boot
  // and is genuinely idempotent.
  try {
    const latePerms = [
      // Closing or (force-)reopening an accounting period generates and reverses
      // closing journal entries. It was reachable with any valid token — the
      // /periods routes carried no capability guard at all while their /gl/*
      // neighbours did.
      ['finance.periods.manage', 'finance', 'إقفال وإعادة فتح الفترات المحاسبية', 'Close/reopen accounting periods', 1, 545],
      // The inventory valuation method decides how COGS is computed and posted
      // to the GL. POST /erp/inventory-method was reachable with any valid token.
      ['inventory.method.manage', 'inventory', 'تغيير طريقة تقييم المخزون', 'Change inventory valuation method', 1, 745],
      // /api/workflow was exempt from the JWT gate AND had no guards, so the org
      // chart + position registry were world-readable and world-writable.
      ['workflow.view', 'workflow', 'عرض الهيكل الإداري والمناصب', 'View org chart and positions', 0, 810],
      ['workflow.manage', 'workflow', 'تعديل الهيكل الإداري والمناصب وصلاحيات المعاملات', 'Manage org chart, positions and transaction rights', 1, 815],
      // Royalty accrual posts Dr 6100 / Cr 2310 to the GL. routes/erp-core.js had
      // no guard at all, so any authenticated user could approve an accrual.
      // (waste.create already existed in the catalog above — it was simply never
      // enforced on the route.)
      ['royalty.view', 'finance', 'عرض احتسابات الإتاوات', 'View royalty runs', 0, 546],
      ['royalty.manage', 'finance', 'احتساب واعتماد الإتاوات', 'Compute and approve royalty runs', 1, 547],
      // W2-A — the approver capability for a shift till movement (pay-in /
      // pay-out recorded by a cashier at the register, POST
      // /api/shifts/:shiftId/movements). Deliberately a NEW, narrow capability
      // rather than reusing finance.cash.approve: that id is referenced by
      // routes/cash.js but was never seeded into permissions_v3, so
      // hasCapability() returns false for it for EVERY non-admin — seeding it
      // here would silently widen the ERP voucher-approval surface as a side
      // effect of this change. This one grants exactly one thing: authorizing a
      // drawer movement. Cashier is NOT granted it (that is the whole point:
      // the cashier records, a manager approves).
      ['pos.cash_movement.approve', 'pos', 'اعتماد حركات نقدية على الدرج (إيداع/سحب)', 'Approve till cash movements (pay-in / pay-out)', 1, 150],
    ];
    for (const p of latePerms) {
      await db.query(
        'INSERT IGNORE INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive, sort_order) VALUES (?,?,?,?,?,?)',
        [p[0], p[1], p[2], p[3], p[4], p[5]]
      );
    }
    // Grant to the roles that already hold the neighbouring finance rights, so
    // this guard hardens the endpoint without taking the function away from the
    // people who were legitimately using it.
    for (const role of ['finance', 'manager']) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)',
        [role, 'finance.periods.manage']);
    }
    // Inventory method is an accounting control, not a warehouse chore — grant it
    // to manager only (admin bypasses the guard entirely).
    await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)',
      ['manager', 'inventory.method.manage']);
    // Reading the org chart is normal operational context (the workflow inbox and
    // the forward-to picker need it), so it goes to every role that already works
    // transactions. EDITING it grants approval rights, so it stays with manager.
    for (const role of ['manager', 'finance', 'hr', 'employee', 'accountant']) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)',
        [role, 'workflow.view']);
    }
    for (const role of ['manager', 'hr']) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)',
        [role, 'workflow.manage']);
    }
    // Royalty is a franchise-accounting function: same audience as the other
    // finance rights it sits beside.
    for (const role of ['manager', 'finance', 'accountant']) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)',
        [role, 'royalty.view']);
    }
    for (const role of ['manager', 'finance']) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)',
        [role, 'royalty.manage']);
    }
    // W2-A — approving a drawer movement is a branch-supervision act: manager
    // (admin bypasses hasCapability entirely) plus the finance roles that
    // already own the cash-voucher surface. `cashier` is deliberately absent.
    for (const role of ['manager', 'finance', 'accountant']) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)',
        [role, 'pos.cash_movement.approve']);
    }
  } catch(e) { console.error('seed late permissions failed:', e.message); }

  // Seed default role → permissions mapping (idempotent — only if empty)
  try {
    const [rcnt] = await db.query("SELECT COUNT(*) AS c FROM role_permissions");
    if (rcnt[0].c === 0) {
      // admin = ALL permissions
      const [allPerms] = await db.query("SELECT id FROM permissions_v3");
      for (const p of allPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['admin', p.id]);
      }
      // manager = nearly everything view + most actions (no admin.users.manage, no sales.delete)
      const managerPerms = allPerms
        .map(r => r.id)
        .filter(id => id !== 'admin.users.manage' && id !== 'sales.delete' && id !== 'admin.audit.view');
      for (const id of managerPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['manager', id]);
      }
      // cashier = POS + view own sales
      for (const id of ['pos.use','pos.shift_close','pos.discount.apply','sales.view','txn.view','txn.create']) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['cashier', id]);
      }
      // custody = expenses + own custody
      for (const id of ['finance.expenses.view','txn.view','txn.create']) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['custody', id]);
      }
      // employee = workflow only
      for (const id of ['txn.view','txn.create']) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['employee', id]);
      }
      // finance = all finance + sales reports + tax — NO HR / inventory edit
      const financePerms = ['finance.view','finance.gl.view','finance.gl.create','finance.gl.approve',
        'finance.reports.view','finance.cash.view','finance.cash.transfer','finance.payment.create',
        'finance.expenses.view','finance.expenses.approve','sales.view','sales.reports.view',
        'sales.reports.advanced','tax.view','txn.view','txn.create','txn.approve','txn.reject',
        'inventory.view','warehouse.view','purchases.view','suppliers.view'];
      for (const id of financePerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['finance', id]);
      }
      // hr = all HR — NO finance / inventory
      const hrPerms = ['hr.view','hr.employees.view','hr.employees.edit','hr.attendance.view',
        'hr.payroll.view','hr.payroll.run','hr.advances.approve','txn.view','txn.create','txn.approve','txn.reject'];
      for (const id of hrPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['hr', id]);
      }
      // inventory = all inventory + purchases view — NO finance / HR
      const invPerms = ['inventory.view','inventory.edit','warehouse.view','warehouse.transfer',
        'waste.create','production.view','production.create','production.complete',
        'purchases.view','suppliers.view','txn.view','txn.create'];
      for (const id of invPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['inventory', id]);
      }
      // purchasing = all purchases + suppliers + view inventory
      const pPerms = ['purchases.view','purchases.create','purchases.approve','suppliers.view',
        'suppliers.edit','inventory.view','warehouse.view','txn.view','txn.create'];
      for (const id of pPerms) {
        await db.query("INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)", ['purchasing', id]);
      }
    }
  } catch(e) { console.error('seed role_permissions failed:', e.message); }

  // FC-P1 — additive finance/GL/payroll/bankrec/ZATCA capabilities. Runs AFTER
  // permissions_v3 + role_permissions exist and are base-seeded. Idempotent
  // (INSERT IGNORE) with an explicit admin top-up + role grants, so the new
  // caps reach admin/manager/finance even on already-populated databases (the
  // base role seed only fills role_permissions when it is empty). These caps
  // are ENFORCED by requireCapability on the GL / cash / payroll / ZATCA routes.
  try {
    await require('./db/migrations/finance/capabilities').seedFinanceCapabilities(db, (m) => console.log('[fin-caps]', m));
  } catch (e) {
    console.error('seed finance capabilities failed:', e.message);
  }

  // FC-P3 — bank reconciliation + cash-drawer closing tables (greenfield).
  await createTableIfMissing('bank_statements', `
    CREATE TABLE bank_statements (
      id VARCHAR(40) PRIMARY KEY,
      bank_account_id VARCHAR(40) NOT NULL,
      period_from DATE NULL, period_to DATE NULL,
      opening_balance DECIMAL(15,2) DEFAULT 0,
      closing_balance DECIMAL(15,2) DEFAULT 0,
      status ENUM('draft','closed') DEFAULT 'draft',
      created_by VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_by VARCHAR(100), closed_at DATETIME NULL,
      INDEX idx_bs_acct (bank_account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await createTableIfMissing('bank_statement_lines', `
    CREATE TABLE bank_statement_lines (
      id VARCHAR(40) PRIMARY KEY,
      statement_id VARCHAR(40) NOT NULL,
      line_date DATE NULL, description VARCHAR(300), reference VARCHAR(100),
      amount DECIMAL(15,2) DEFAULT 0,
      match_status ENUM('unmatched','matched','adjusted') DEFAULT 'unmatched',
      matched_gl_entry_id VARCHAR(40) NULL,
      matched_by VARCHAR(100), matched_at DATETIME NULL,
      INDEX idx_bsl_stmt (statement_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await createTableIfMissing('cashbox_closings', `
    CREATE TABLE cashbox_closings (
      id VARCHAR(40) PRIMARY KEY,
      cashbox_id VARCHAR(40) NOT NULL,
      closing_date DATE NULL,
      expected_balance DECIMAL(15,2) DEFAULT 0,
      counted_amount DECIMAL(15,2) DEFAULT 0,
      difference DECIMAL(15,2) DEFAULT 0,
      notes VARCHAR(300),
      status ENUM('draft','approved') DEFAULT 'draft',
      journal_id VARCHAR(40) NULL,
      created_by VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_by VARCHAR(100), approved_at DATETIME NULL,
      INDEX idx_cc_box (cashbox_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Seed default positions
  try {
    const [posCount] = await db.query('SELECT COUNT(*) AS cnt FROM positions');
    if (posCount[0].cnt === 0) {
      await db.query("INSERT INTO positions (id, name, level) VALUES ('POS-0','موظف',1),('POS-1','محاسب',2),('POS-5','مدير فرع',3),('POS-4','مسؤول بنوك',3),('POS-2','مدير مالي',4),('POS-3','مدير تنفيذي',5),('POS-6','مدير عام',6)");
    }
  } catch(e) {}

  // Seed default permissions
  try {
    const [permCount] = await db.query('SELECT COUNT(*) AS cnt FROM permissions');
    if (permCount[0].cnt === 0) {
      await db.query("INSERT INTO permissions (id, code, description) VALUES ('PERM-1','CREATE_REQUEST','إنشاء معاملة'),('PERM-2','APPROVE','موافقة'),('PERM-3','REJECT','رفض'),('PERM-4','RETURN','إرجاع'),('PERM-5','CLOSE','إقفال'),('PERM-6','VIEW_ALL','عرض الكل')");
    }
  } catch(e) {}

  // Seed default transaction types
  try {
    const [ttCount] = await db.query('SELECT COUNT(*) AS cnt FROM transaction_types');
    if (ttCount[0].cnt === 0) {
      await db.query("INSERT INTO transaction_types (id, name, code) VALUES ('TT-1','طلب صرف مستحقات','EXPENSE_REQUEST'),('TT-2','طلب شراء','PURCHASE_REQUEST'),('TT-3','طلب أصل ثابت','ASSET_REQUEST')");
    }
  } catch(e) {}

  // Brands table (multi-brand support)
  await createTableIfMissing('brands', `
    CREATE TABLE brands (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(20),
      logo LONGTEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Add brand_id to existing tables
  await addColumnIfMissing('branches', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('menu', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('users', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('users', 'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('inv_items', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('sales', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('sales', 'branch_id', "VARCHAR(50)");

  // Create default brand if none exists
  try {
    const [brands] = await db.query('SELECT COUNT(*) AS cnt FROM brands');
    if (brands[0].cnt === 0) {
      await db.query("INSERT INTO brands (id, name, code) VALUES ('BR-DEFAULT', 'Moroccan Taste', 'MT')");
    }
  } catch(e) {}

  // Dynamic Payment Methods (advanced)
  await addColumnIfMissing('payment_methods', 'type', "VARCHAR(50) DEFAULT 'standard'");
  await addColumnIfMissing('payment_methods', 'require_reference', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('payment_methods', 'require_transaction_number', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('payment_methods', 'require_terminal', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('payment_methods', 'allow_refund', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('payment_methods', 'allow_cancel', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('payment_methods', 'color', "VARCHAR(20) DEFAULT '#3b82f6'");
  // B5 — dedup payment_methods by name (keep the lowest id) + enforce
  // UNIQUE(name) so default seeding is idempotent even on a long-lived DB that
  // may already carry duplicates from a pre-lock concurrent boot. The ALTER is a
  // no-op once the index exists.
  try {
    await db.query('DELETE p1 FROM payment_methods p1 JOIN payment_methods p2 ON p1.name = p2.name AND p1.id > p2.id');
    try { await db.query('ALTER TABLE payment_methods ADD UNIQUE KEY uq_pm_name (name)'); }
    catch (e) { if (!/duplicate key name|Duplicate key name|already exists/i.test(e.message || '')) throw e; }
  } catch (e) { console.error('[migrations] payment_methods dedup/unique:', e && (e.code || e.message)); }

  // Branch payment methods
  await createTableIfMissing('branch_payment_methods', `
    CREATE TABLE branch_payment_methods (
      id VARCHAR(50) PRIMARY KEY,
      branch_id VARCHAR(50) NOT NULL,
      payment_method_id VARCHAR(50) NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      UNIQUE KEY uq_br_pm (branch_id, payment_method_id)
    ) ENGINE=InnoDB
  `);

  // Dynamic Discounts (advanced)
  await createTableIfMissing('discounts_v2', `
    CREATE TABLE discounts_v2 (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      type ENUM('percentage','fixed','promo_code','automatic') DEFAULT 'percentage',
      value DECIMAL(10,2) DEFAULT 0,
      max_amount DECIMAL(10,2) DEFAULT 0,
      min_order DECIMAL(10,2) DEFAULT 0,
      require_approval BOOLEAN DEFAULT FALSE,
      require_code BOOLEAN DEFAULT FALSE,
      code VARCHAR(50),
      enabled BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      valid_from DATE,
      valid_to DATE,
      apply_on ENUM('invoice','item','category') DEFAULT 'invoice',
      color VARCHAR(20) DEFAULT '#8b5cf6',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Branch discounts
  await createTableIfMissing('branch_discounts', `
    CREATE TABLE branch_discounts (
      id VARCHAR(50) PRIMARY KEY,
      branch_id VARCHAR(50) NOT NULL,
      discount_id VARCHAR(50) NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      UNIQUE KEY uq_br_disc (branch_id, discount_id)
    ) ENGINE=InnoDB
  `);

  // ─── Payment Methods v3: enterprise fields (group, GL, cost center, fees, advanced flags) ───
  await addColumnIfMissing('payment_methods', 'group_type', "ENUM('cash','electronic','voucher','loyalty','transfer','other') DEFAULT 'cash'");
  await addColumnIfMissing('payment_methods', 'gl_account_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('payment_methods', 'cost_center_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('payment_methods', 'allow_manual_total', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('payment_methods', 'show_in_shift_close', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('payment_methods', 'show_in_reports', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('payment_methods', 'service_fee_type', "ENUM('percent','fixed','none') DEFAULT 'none'");
  await addColumnIfMissing('payment_methods', 'service_fee_value', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('payment_methods', 'description', "TEXT");
  await addColumnIfMissing('payment_methods', 'created_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing('payment_methods', 'updated_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  // ─── Sales Channels (المنيو الرئيسي / هنقرستيشن / كيتا / تطبيق_خاص / طلب_هاتفي) ───
  await createTableIfMissing('sales_channels', `
    CREATE TABLE sales_channels (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(50) UNIQUE,
      name VARCHAR(200) NOT NULL,
      name_en VARCHAR(200),
      channel_type ENUM('dine_in','takeaway','delivery','aggregator','phone','app','online') DEFAULT 'dine_in',
      price_list_id VARCHAR(50) DEFAULT NULL,
      icon VARCHAR(60) DEFAULT 'fa-store',
      color VARCHAR(20) DEFAULT '#3b82f6',
      commission_pct DECIMAL(5,2) DEFAULT 0,
      service_fee_pct DECIMAL(5,2) DEFAULT 0,
      gl_revenue_account VARCHAR(50) DEFAULT NULL,
      gl_commission_account VARCHAR(50) DEFAULT NULL,
      requires_external_ref BOOLEAN DEFAULT FALSE,
      allow_discount BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_channel_type (channel_type),
      INDEX idx_price_list (price_list_id)
    ) ENGINE=InnoDB
  `);

  // Seed default sales channels (idempotent)
  try {
    const [chCnt] = await db.query('SELECT COUNT(*) AS c FROM sales_channels');
    if (chCnt[0].c === 0) {
      await db.query(`INSERT INTO sales_channels (id, code, name, channel_type, icon, color, display_order, is_active) VALUES
        ('CH-MAIN','MAIN','المنيو الرئيسي','dine_in','fa-utensils','#3b82f6',1,1),
        ('CH-HUNGER','HUNGERSTATION','هنقرستيشن','aggregator','fa-motorcycle','#fbbf24',2,1),
        ('CH-KEETA','KEETA','كيتا','aggregator','fa-bicycle','#ef4444',3,1),
        ('CH-APP','APP','تطبيق خاص','app','fa-mobile-screen','#8b5cf6',4,1),
        ('CH-PHONE','PHONE','طلب هاتفي','phone','fa-phone','#10b981',5,1)`);
    }
  } catch(e) {}

  // ─── Discounts v2: GL link + permission level ───
  await addColumnIfMissing('discounts_v2', 'gl_account_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('discounts_v2', 'discount_scope', "ENUM('line','invoice','preset','manual') DEFAULT 'invoice'");
  await addColumnIfMissing('discounts_v2', 'min_role', "ENUM('cashier','manager','admin') DEFAULT 'cashier'");
  await addColumnIfMissing('discounts_v2', 'max_per_invoice', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('discounts_v2', 'show_in_pos', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('discounts_v2', 'icon', "VARCHAR(60) DEFAULT 'fa-tag'");
  await addColumnIfMissing('discounts_v2', 'description', "TEXT");

  // ─── Shift close: cash denominations table ───
  await createTableIfMissing('shift_close_denominations', `
    CREATE TABLE shift_close_denominations (
      id VARCHAR(60) PRIMARY KEY,
      shift_id VARCHAR(50) NOT NULL,
      denomination DECIMAL(10,2) NOT NULL,
      kind ENUM('coin','note') DEFAULT 'note',
      count INT DEFAULT 0,
      total DECIMAL(14,4) GENERATED ALWAYS AS (denomination * count) STORED,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_shift (shift_id)
    ) ENGINE=InnoDB
  `);

  // Shifts: dynamic payment-method totals (JSON) + cash counted
  await addColumnIfMissing('shifts', 'payment_totals_json', "LONGTEXT");
  await addColumnIfMissing('shifts', 'denominations_json', "LONGTEXT");
  await addColumnIfMissing('shifts', 'cashier_notes', "TEXT");
  await addColumnIfMissing('shifts', 'opening_float', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('shifts', 'expected_total', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('shifts', 'actual_total', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('shifts', 'variance_total', "DECIMAL(14,4) DEFAULT 0");

  // ─── Sales: V3 channel + discount tracking (for reports + GL routing) ───
  await addColumnIfMissing('sales', 'channel_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('sales', 'channel_name', "VARCHAR(200) DEFAULT NULL");
  await addColumnIfMissing('sales', 'discount_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('sales', 'discount_name', "VARCHAR(200) DEFAULT NULL");
  await addColumnIfMissing('sales', 'discount_amount', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('sales', 'discount_gl_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('sales', 'line_discounts_json', "LONGTEXT");
  try { await db.query('CREATE INDEX idx_sales_channel ON sales(channel_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_sales_discount ON sales(discount_id)'); } catch(e) {}

  // v6.17.1 — Defensive: ensure v6.11.0 sales numbering columns exist on
  // every deployment, even if db/migrations/0002_sales_numbering.sql did
  // not run (brand-new install, manual schema.sql load, replica drift, etc.).
  // Symptoms before this fix: routes/erp/customers.js:/summary returns
  // "Unknown column 'invoice_number'" which broke the customer totals
  // strip in the POS sidebar.  addColumnIfMissing is idempotent — no-op
  // when the column already exists.
  await addColumnIfMissing('sales', 'invoice_number', "VARCHAR(40) NULL");
  await addColumnIfMissing('sales', 'void_serial',    "VARCHAR(40) NULL");
  await addColumnIfMissing('sales', 'return_serial',  "VARCHAR(40) NULL");
  try { await db.query('CREATE INDEX idx_sales_invoice_number ON sales(invoice_number)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_sales_void_serial    ON sales(void_serial)');    } catch(e) {}
  try { await db.query('CREATE INDEX idx_sales_return_serial  ON sales(return_serial)');  } catch(e) {}

  // ─── V3 spec gap fixes ───
  // Warehouses: multi-brand allowed list (JSON array of brand IDs)
  await addColumnIfMissing('warehouses', 'allowed_brands', "LONGTEXT");
  // Brands: linked branches (JSON array of branch IDs)
  await addColumnIfMissing('brands', 'linked_branches', "LONGTEXT");
  // Users: explicit default_branch_id (in addition to existing branch_id)
  await addColumnIfMissing('users', 'default_branch_id', "VARCHAR(50) DEFAULT NULL");
  // Users: can change branch (default false for cashier — per spec)
  await addColumnIfMissing('users', 'can_change_branch', "BOOLEAN DEFAULT FALSE");

  // Tier A.2 corrective gate — a SECOND, conflicting audit_logs CREATE TABLE
  // definition used to live here (id VARCHAR(50), `username` not
  // `user_username`, no INDEX idx_audit_action). It was 100% dead code —
  // createTableIfMissing('audit_logs', ...) at V4.11 above (~line 1730)
  // always runs first and always wins on a fresh boot, so this definition
  // never actually created anything, ever. Its only effect was a landmine:
  // if that FIRST definition were ever removed or reordered, the table
  // would silently come up with the wrong schema (a VARCHAR(50) id and a
  // `username` column lib/auditLogger.js#logAudit/#logAuditTx don't write
  // to). Removed rather than left as confusing dead code — see the V4.11
  // definition (~line 1730) for the one canonical schema.

  // Phase 3A.1 — self-healing GL core. db/schema.sql creates gl_accounts/
  // gl_journals/gl_entries on a TRULY empty DB, but a PARTIAL DB (users table
  // present so schema.sql is skipped on boot, yet gl_* somehow absent) would
  // leave the column-ALTERs below no-op'ing against a missing table. Creating
  // them idempotently HERE — before any gl ALTER — makes boot self-heal with
  // zero manual ALTER. IF NOT EXISTS keeps two concurrent boots non-corrupting.
  await createTableIfMissing('gl_accounts', `
    CREATE TABLE IF NOT EXISTS gl_accounts (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) NOT NULL UNIQUE,
      name_ar VARCHAR(200) NOT NULL,
      name_en VARCHAR(200),
      type ENUM('asset','liability','equity','revenue','expense') NOT NULL,
      parent_id VARCHAR(50),
      level INT DEFAULT 1,
      is_active BOOLEAN DEFAULT TRUE,
      balance DECIMAL(14,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('gl_journals', `
    CREATE TABLE IF NOT EXISTS gl_journals (
      id VARCHAR(50) PRIMARY KEY,
      journal_number VARCHAR(20),
      journal_date DATE,
      reference_type VARCHAR(50),
      reference_id VARCHAR(100),
      description TEXT,
      total_debit DECIMAL(14,2) DEFAULT 0,
      total_credit DECIMAL(14,2) DEFAULT 0,
      period_id VARCHAR(50),
      status ENUM('posted','draft') DEFAULT 'posted',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(100),
      posted_by VARCHAR(100) DEFAULT '',
      posted_at DATETIME,
      reversed_by_journal_id VARCHAR(50) NULL,
      reverses_journal_id VARCHAR(50) NULL,
      reversed_at DATETIME NULL,
      reversed_by VARCHAR(100) NULL,
      brand_id VARCHAR(50) NULL,
      branch_id VARCHAR(50) NULL,
      project_id VARCHAR(50) NULL,
      cost_center_id VARCHAR(50) NULL,
      UNIQUE KEY uq_journal_number (journal_number)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('gl_entries', `
    CREATE TABLE IF NOT EXISTS gl_entries (
      id VARCHAR(50) PRIMARY KEY,
      journal_id VARCHAR(50) NOT NULL,
      account_id VARCHAR(50),
      account_code VARCHAR(20),
      account_name VARCHAR(200),
      debit DECIMAL(14,2) DEFAULT 0,
      credit DECIMAL(14,2) DEFAULT 0,
      description TEXT,
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      project_id VARCHAR(50),
      cost_center_id VARCHAR(50),
      warehouse_id VARCHAR(50),
      INDEX idx_gle_journal (journal_id)
    ) ENGINE=InnoDB
  `);
  // Phase 3A.1 — DB-atomic per-day journal sequence (replaces timestamp-ordered
  // numbering in lib/glPosting). One row per YYYYMMDD; lib/glPosting allocates
  // the next serial via an atomic increment + the UNIQUE uq_journal_number guard.
  await createTableIfMissing('gl_journal_seq', `
    CREATE TABLE IF NOT EXISTS gl_journal_seq (
      period_key VARCHAR(20) PRIMARY KEY,
      last_serial INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB
  `);

  // GL journals: add cost_center_id
  await addColumnIfMissing('gl_journals', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('gl_journals', 'cost_center_name', "VARCHAR(200)");
  // GL entries: add cost_center_id
  await addColumnIfMissing('gl_entries', 'cost_center_id', "VARCHAR(50)");

  // Extend shortage status ENUM for existing tables
  try { await db.query("ALTER TABLE shortage_requests MODIFY COLUMN status ENUM('pending','approved','rejected','converted','partially_received','fully_received','closed') DEFAULT 'pending'"); } catch(e) {}
  // Extend PO status for partial receive
  try { await db.query("ALTER TABLE purchase_orders MODIFY COLUMN status ENUM('draft','approved','received','cancelled','partially_received') DEFAULT 'draft'"); } catch(e) {}

  // Supply source setting
  try {
    await db.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('supply_source_mode','parent_company')");
  } catch(e) {}

  // Purchase receive workflow columns
  await addColumnIfMissing('purchases', 'received_items_json', "LONGTEXT");
  await addColumnIfMissing('purchases', 'receive_status', "ENUM('none','pending','approved') DEFAULT 'none'");
  await addColumnIfMissing('purchases', 'received_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('purchases', 'receive_approved_by', "VARCHAR(100) DEFAULT ''");

  // Security: account lockout columns
  await addColumnIfMissing('users', 'failed_attempts', "INT DEFAULT 0");
  await addColumnIfMissing('users', 'locked_until', "DATETIME DEFAULT NULL");
  // Phase A — in-system password change: session-version revocation + forced-change flag
  await addColumnIfMissing('users', 'token_version', "INT NOT NULL DEFAULT 1");
  await addColumnIfMissing('users', 'must_change_password', "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumnIfMissing('users', 'password_changed_at', "DATETIME NULL");

  // User roles ENUM — this used to re-assert the five-value employee-portal
  // enum here, silently REVERTING the specialized-roles widen that runs
  // earlier in this same file (both ALTERs sat in empty catches, so the fight
  // was invisible). The canonical widen — including 'employee' — lives in one
  // place now: the specialized-roles ALTER above + db/migrations/order-to-cash
  // /schema.js §12. Nothing narrows the enum anymore.

  // Custody management tables (العهد)
  await createTableIfMissing('custody_users', `
    CREATE TABLE custody_users (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      id_number VARCHAR(20),
      phone VARCHAR(20),
      job_title VARCHAR(100),
      notes TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      linked_username VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('custodies', `
    CREATE TABLE custodies (
      id VARCHAR(50) PRIMARY KEY,
      custody_number VARCHAR(20) UNIQUE,
      user_id VARCHAR(50) NOT NULL,
      user_name VARCHAR(200),
      created_date DATETIME,
      balance DECIMAL(14,2) DEFAULT 0,
      total_topups DECIMAL(14,2) DEFAULT 0,
      total_expenses DECIMAL(14,2) DEFAULT 0,
      status ENUM('active','closed') DEFAULT 'active',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES custody_users(id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('custody_topups', `
    CREATE TABLE custody_topups (
      id VARCHAR(50) PRIMARY KEY,
      custody_id VARCHAR(50) NOT NULL,
      amount DECIMAL(14,2),
      payment_method VARCHAR(50),
      receipt_image LONGTEXT,
      notes TEXT,
      created_at DATETIME,
      created_by VARCHAR(100),
      FOREIGN KEY (custody_id) REFERENCES custodies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('custody_expenses', `
    CREATE TABLE custody_expenses (
      id VARCHAR(50) PRIMARY KEY,
      custody_id VARCHAR(50) NOT NULL,
      expense_date DATE,
      description TEXT,
      amount DECIMAL(14,2),
      has_vat BOOLEAN DEFAULT FALSE,
      vat_rate DECIMAL(5,2) DEFAULT 15,
      vat_amount DECIMAL(14,2) DEFAULT 0,
      total_with_vat DECIMAL(14,2) DEFAULT 0,
      invoice_image LONGTEXT,
      notes TEXT,
      status ENUM('pending','approved','rejected','posted') DEFAULT 'pending',
      rejection_reason TEXT,
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      approved_at DATETIME,
      posted_by VARCHAR(100),
      posted_at DATETIME,
      journal_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (custody_id) REFERENCES custodies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  // custody_expenses.cost_center_id/cost_center_name/pre_approval_status
  // moved here (was mis-ordered above the table's own creation — see the
  // comment near the old location). Must run AFTER the CREATE TABLE
  // immediately above.
  await addColumnIfMissing('custody_expenses', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('custody_expenses', 'cost_center_name', "VARCHAR(200)");
  await addColumnIfMissing('custody_expenses', 'pre_approval_status', "ENUM('none','requested','approved','rejected') DEFAULT 'none'");

  // Custody close request columns + override status
  await addColumnIfMissing('custodies', 'close_requested_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('custodies', 'close_requested_at', "DATETIME");
  await addColumnIfMissing('custodies', 'close_approved_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('custodies', 'close_approved_at', "DATETIME");
  await addColumnIfMissing('custodies', 'close_notes', "TEXT");
  // Extend custodies status ENUM to include close_pending
  try { await db.query("ALTER TABLE custodies MODIFY COLUMN status ENUM('active','closed','close_pending') DEFAULT 'active'"); } catch(e) {}
  // GL journals — status workflow + attachment columns
  await addColumnIfMissing('gl_journals', 'attachment', "LONGTEXT");
  await addColumnIfMissing('gl_journals', 'notes', "TEXT");
  await addColumnIfMissing('gl_journals', 'approved_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('gl_journals', 'approved_at', "DATETIME");
  await addColumnIfMissing('gl_journals', 'posted_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('gl_journals', 'posted_at', "DATETIME");
  // v5.10.61 — period-closing entries automation: mark JEs that came from
  // the period-lock flow so the UI can show them separately + the reopen
  // flow can find and reverse them. Idempotent ALTER (addColumnIfMissing
  // checks INFORMATION_SCHEMA before adding).
  await addColumnIfMissing('gl_journals', 'is_closing_entry', "TINYINT(1) DEFAULT 0");
  await addColumnIfMissing('gl_journals', 'closing_period_id', "VARCHAR(50)");
  try { await db.query("ALTER TABLE gl_journals MODIFY COLUMN status ENUM('draft','approved','posted') DEFAULT 'draft'"); } catch(e) {}

  // GL account link on custody expenses
  await addColumnIfMissing('custody_expenses', 'gl_account_id', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfMissing('custody_expenses', 'gl_account_name', "VARCHAR(200) DEFAULT ''");

  // Extend custody_expenses status ENUM to include override_pending + returned
  try { await db.query("ALTER TABLE custody_expenses MODIFY COLUMN status ENUM('pending','approved','rejected','posted','override_pending','returned') DEFAULT 'pending'"); } catch(e) {}

  // ═══════════════════════════════════════
  // HR MODULE TABLES (نظام الموارد البشرية)
  // ═══════════════════════════════════════

  await createTableIfMissing('hr_departments', `
    CREATE TABLE hr_departments (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) NOT NULL,
      name VARCHAR(200) NOT NULL,
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      manager_employee_id VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_employees', `
    CREATE TABLE hr_employees (
      id VARCHAR(50) PRIMARY KEY,
      employee_number VARCHAR(20) NOT NULL UNIQUE,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100),
      full_name VARCHAR(200),
      national_id VARCHAR(20),
      passport_number VARCHAR(20),
      iqama_number VARCHAR(20),
      phone VARCHAR(20),
      email VARCHAR(200),
      gender ENUM('male','female') DEFAULT 'male',
      date_of_birth DATE,
      nationality VARCHAR(100),
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      department_id VARCHAR(50),
      position_id VARCHAR(50),
      job_title VARCHAR(200),
      employment_type ENUM('full_time','part_time','hourly','contract') DEFAULT 'full_time',
      salary_type ENUM('monthly','hourly') DEFAULT 'monthly',
      basic_salary DECIMAL(12,2) DEFAULT 0,
      hourly_rate DECIMAL(8,2) DEFAULT 0,
      housing_allowance DECIMAL(12,2) DEFAULT 0,
      transport_allowance DECIMAL(12,2) DEFAULT 0,
      other_allowance DECIMAL(12,2) DEFAULT 0,
      hire_date DATE,
      contract_end_date DATE,
      probation_end_date DATE,
      status ENUM('active','suspended','terminated','on_leave') DEFAULT 'active',
      termination_date DATE,
      termination_reason TEXT,
      bank_name VARCHAR(200),
      bank_account VARCHAR(50),
      bank_iban VARCHAR(50),
      emergency_contact_name VARCHAR(200),
      emergency_contact_phone VARCHAR(20),
      emergency_contact_relation VARCHAR(100),
      linked_user_id INT,
      linked_username VARCHAR(100),
      photo LONGTEXT,
      notes TEXT,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_emp_branch (branch_id),
      INDEX idx_emp_brand (brand_id),
      INDEX idx_emp_dept (department_id),
      INDEX idx_emp_status (status)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_work_schedules', `
    CREATE TABLE hr_work_schedules (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      branch_id VARCHAR(50),
      work_start TIME NOT NULL DEFAULT '08:00:00',
      work_end TIME NOT NULL DEFAULT '17:00:00',
      break_minutes INT DEFAULT 60,
      work_days VARCHAR(20) DEFAULT '0,1,2,3,4',
      grace_minutes INT DEFAULT 15,
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_attendance', `
    CREATE TABLE hr_attendance (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      attendance_date DATE NOT NULL,
      clock_in DATETIME,
      clock_out DATETIME,
      total_hours DECIMAL(5,2) DEFAULT 0,
      late_minutes INT DEFAULT 0,
      early_leave_minutes INT DEFAULT 0,
      overtime_minutes INT DEFAULT 0,
      status ENUM('present','absent','leave','holiday','weekend') DEFAULT 'present',
      source ENUM('fingerprint','pos','app','manual') DEFAULT 'manual',
      device_id VARCHAR(100),
      geo_lat DECIMAL(10,7),
      geo_lng DECIMAL(10,7),
      notes TEXT,
      modified_by VARCHAR(100),
      modified_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_date (employee_id, attendance_date),
      INDEX idx_att_date (attendance_date),
      INDEX idx_att_emp (employee_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_leave_types', `
    CREATE TABLE hr_leave_types (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(20) NOT NULL,
      default_days INT DEFAULT 0,
      is_paid BOOLEAN DEFAULT TRUE,
      requires_approval BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_leave_balances', `
    CREATE TABLE hr_leave_balances (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      leave_type_id VARCHAR(50) NOT NULL,
      year INT NOT NULL,
      total_days DECIMAL(5,1) DEFAULT 0,
      used_days DECIMAL(5,1) DEFAULT 0,
      remaining_days DECIMAL(5,1) DEFAULT 0,
      UNIQUE KEY uq_bal (employee_id, leave_type_id, year),
      INDEX idx_bal_emp (employee_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_leave_requests', `
    CREATE TABLE hr_leave_requests (
      id VARCHAR(50) PRIMARY KEY,
      request_number VARCHAR(20),
      employee_id VARCHAR(50) NOT NULL,
      leave_type_id VARCHAR(50) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      days_count DECIMAL(5,1) DEFAULT 0,
      reason TEXT,
      status ENUM('pending','branch_approved','hr_approved','rejected','cancelled') DEFAULT 'pending',
      branch_approver VARCHAR(100),
      branch_approved_at DATETIME,
      hr_approver VARCHAR(100),
      hr_approved_at DATETIME,
      rejection_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_leave_emp (employee_id),
      INDEX idx_leave_status (status)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_payroll_runs', `
    CREATE TABLE hr_payroll_runs (
      id VARCHAR(50) PRIMARY KEY,
      run_number VARCHAR(30),
      month INT NOT NULL,
      year INT NOT NULL,
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      status ENUM('draft','calculated','approved','paid') DEFAULT 'draft',
      total_gross DECIMAL(14,2) DEFAULT 0,
      total_deductions DECIMAL(14,2) DEFAULT 0,
      total_net DECIMAL(14,2) DEFAULT 0,
      employee_count INT DEFAULT 0,
      approved_by VARCHAR(100),
      approved_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by VARCHAR(100)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_payroll_items', `
    CREATE TABLE hr_payroll_items (
      id VARCHAR(50) PRIMARY KEY,
      run_id VARCHAR(50) NOT NULL,
      employee_id VARCHAR(50) NOT NULL,
      employee_name VARCHAR(200),
      employee_number VARCHAR(30),
      basic_salary DECIMAL(12,2) DEFAULT 0,
      housing_allowance DECIMAL(12,2) DEFAULT 0,
      transport_allowance DECIMAL(12,2) DEFAULT 0,
      other_allowance DECIMAL(12,2) DEFAULT 0,
      overtime_amount DECIMAL(12,2) DEFAULT 0,
      overtime_hours DECIMAL(6,2) DEFAULT 0,
      gross_salary DECIMAL(12,2) DEFAULT 0,
      absence_deduction DECIMAL(12,2) DEFAULT 0,
      late_deduction DECIMAL(12,2) DEFAULT 0,
      advance_deduction DECIMAL(12,2) DEFAULT 0,
      other_deduction DECIMAL(12,2) DEFAULT 0,
      total_deductions DECIMAL(12,2) DEFAULT 0,
      net_salary DECIMAL(12,2) DEFAULT 0,
      actual_days INT DEFAULT 0,
      absent_days INT DEFAULT 0,
      late_minutes INT DEFAULT 0,
      leave_days INT DEFAULT 0,
      INDEX idx_pi_run (run_id),
      INDEX idx_pi_emp (employee_id)
    ) ENGINE=InnoDB
  `);

  // Fix column name mismatches in existing production payroll tables
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_payroll_runs' AND COLUMN_NAME = 'period_month'`
    );
    if (cols.length) {
      await db.query(`ALTER TABLE hr_payroll_runs CHANGE period_month month INT NOT NULL`);
      await db.query(`ALTER TABLE hr_payroll_runs CHANGE period_year year INT NOT NULL`);
      console.log('[DB] Migration: renamed hr_payroll_runs period_month→month, period_year→year');
    }
  } catch (e) { console.log('[DB] Payroll runs migration:', e.message.substring(0, 120)); }
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_payroll_items' AND COLUMN_NAME = 'payroll_run_id'`
    );
    if (cols.length) {
      await db.query(`ALTER TABLE hr_payroll_items CHANGE payroll_run_id run_id VARCHAR(50) NOT NULL`);
      console.log('[DB] Migration: renamed hr_payroll_items payroll_run_id→run_id');
    }
  } catch (e) { console.log('[DB] Payroll items migration:', e.message.substring(0, 120)); }
  // Add missing columns to hr_payroll_items for existing tables
  await addColumnIfMissing('hr_payroll_items', 'employee_number', "VARCHAR(30)");
  await addColumnIfMissing('hr_payroll_items', 'overtime_hours', "DECIMAL(6,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'actual_days', "INT DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'absent_days', "INT DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'late_minutes', "INT DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'leave_days', "INT DEFAULT 0");
  // New allowance & deduction fields for payroll items
  await addColumnIfMissing('hr_payroll_items', 'food_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'communication_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'education_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'nature_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'social_insurance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_items', 'fixed_deduction', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_payroll_runs', 'journal_id_accrual', "VARCHAR(50)");
  await addColumnIfMissing('hr_payroll_runs', 'journal_id_deductions', "VARCHAR(50)");
  await addColumnIfMissing('hr_payroll_runs', 'journal_id_payment', "VARCHAR(50)");

  // Add missing columns to hr_payroll_runs for existing tables
  await addColumnIfMissing('hr_payroll_runs', 'created_by', "VARCHAR(100)");
  await addColumnIfMissing('hr_payroll_runs', 'updated_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  // hr_advances missing columns — moved to right after
  // createTableIfMissing('hr_advances', ...) below. `hr_advances` isn't part
  // of the baseline schema, it's only created later in this same function,
  // so on a fresh install these ADD COLUMNs silently failed here
  // (addColumnIfMissing logs-and-continues on "table doesn't exist") and
  // only appeared after a second server restart. Same ordering-bug class as
  // Tier A.2 Section 6 (pos_orders.branch_id).

  // hr_departments missing columns
  await addColumnIfMissing('hr_departments', 'name_en', "VARCHAR(200)");
  await addColumnIfMissing('hr_departments', 'code', "VARCHAR(50)");
  await addColumnIfMissing('hr_departments', 'branch_id', "VARCHAR(50)");
  // v8 (G3) — the hr_departments table created HERE (createTableIfMissing above)
  // never had manager_id / parent_id / description, yet routes/hr.js selected
  // them (always '') and its POST parsed then silently DROPPED them while
  // returning success:true. Additive + nullable, so existing rows are untouched;
  // routes/hr.js now actually reads/writes them.
  await addColumnIfMissing('hr_departments', 'manager_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('hr_departments', 'parent_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('hr_departments', 'description', "TEXT NULL");

  // Expand hr_exceptions ENUM to include excuse_absence (for existing tables)
  try {
    await db.query("ALTER TABLE hr_exceptions MODIFY COLUMN exception_type ENUM('ignore_late','ignore_early_leave','ignore_overtime','adjust_attendance','grant_day','excuse_absence') NOT NULL");
  } catch(e) { /* already has the value or table doesn't exist yet */ }

  await createTableIfMissing('hr_documents', `
    CREATE TABLE hr_documents (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      doc_type ENUM('contract','id','passport','iqama','certificate','medical','other') DEFAULT 'other',
      title VARCHAR(200),
      file_data LONGTEXT,
      expiry_date DATE,
      notes TEXT,
      uploaded_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_doc_emp (employee_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_advances', `
    CREATE TABLE hr_advances (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      request_date DATE,
      status ENUM('pending','approved','rejected','deducted') DEFAULT 'pending',
      approved_by VARCHAR(100),
      deduction_months INT DEFAULT 1,
      remaining_amount DECIMAL(12,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // hr_advances.remaining/monthly_deduction moved here (was mis-ordered
  // above the table's own creation — see the comment near the old location).
  // Must run AFTER the CREATE TABLE immediately above.
  await addColumnIfMissing('hr_advances', 'remaining', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_advances', 'monthly_deduction', "DECIMAL(12,2) DEFAULT 0");

  // Seed default leave types
  try {
    await db.query(`INSERT IGNORE INTO hr_leave_types (id, name, code, default_days, is_paid) VALUES
      ('LT-ANNUAL', 'إجازة سنوية', 'ANNUAL', 21, TRUE),
      ('LT-SICK', 'إجازة مرضية', 'SICK', 10, TRUE),
      ('LT-EMERGENCY', 'إجازة طارئة', 'EMERGENCY', 5, TRUE),
      ('LT-UNPAID', 'إجازة بدون راتب', 'UNPAID', 0, FALSE)`);
  } catch(e) {}

  // Seed default work schedule
  try {
    await db.query(`INSERT IGNORE INTO hr_work_schedules (id, name, work_start, work_end, break_minutes, grace_minutes, is_default) VALUES
      ('WS-DEFAULT', 'الدوام الرسمي', '08:00:00', '17:00:00', 60, 15, TRUE)`);
  } catch(e) {}

  // Users: link to employee
  await addColumnIfMissing('users', 'employee_id', "VARCHAR(50)");

  // ═══════════════════════════════════════
  // SECURITY HARDENING — Database
  // ═══════════════════════════════════════

  // Remove plain_pass column (security fix — passwords must never be stored in plain text)
  try { await db.query('ALTER TABLE users DROP COLUMN plain_pass'); } catch(e) {}

  // Tier A.2 corrective gate — a THIRD, conflicting audit_logs CREATE TABLE
  // definition used to live here (id VARCHAR(50), `username`, no
  // user_username) — same dead-code landmine as the one removed near line
  // 2445 (V4.11's definition at ~line 1730, BIGINT id / user_username, is
  // the only one that ever actually runs). See that comment for the full
  // reasoning; removed here for the same reason.

  // Soft delete columns on critical tables
  await addColumnIfMissing('sales', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('hr_employees', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('gl_journals', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('purchases', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('inv_items', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('customers', 'deleted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('suppliers', 'deleted_at', "DATETIME DEFAULT NULL");

  // Add missing performance indexes
  try { await db.query('CREATE INDEX idx_sales_username ON sales(username)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_inv_items_category ON inv_items(category)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_inv_items_stock ON inv_items(stock)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_purchases_status ON purchases(status)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_gl_entries_account ON gl_entries(account_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_expenses_category ON expenses(category)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_custody_exp_custody ON custody_expenses(custody_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_hr_emp_status ON hr_employees(status)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_hr_att_date ON hr_attendance(attendance_date)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_hr_leave_status ON hr_leave_requests(status)'); } catch(e) {}

  // 2FA support
  await addColumnIfMissing('users', 'totp_secret', "VARCHAR(100)");
  await addColumnIfMissing('users', 'totp_enabled', "BOOLEAN DEFAULT FALSE");

  // Add CHECK constraints (MySQL 8.0+)
  try { await db.query('ALTER TABLE hr_employees ADD CONSTRAINT ck_salary CHECK (basic_salary >= 0)'); } catch(e) {}
  try { await db.query('ALTER TABLE hr_payroll_items ADD CONSTRAINT ck_net CHECK (net_salary >= 0)'); } catch(e) {}
  try { await db.query('ALTER TABLE hr_advances ADD CONSTRAINT ck_advance_amt CHECK (amount > 0)'); } catch(e) {}

  // Shifts: add geolocation + device info columns
  await addColumnIfMissing('shifts', 'geo_lat', "DECIMAL(10,7)");
  await addColumnIfMissing('shifts', 'geo_lng', "DECIMAL(10,7)");
  await addColumnIfMissing('shifts', 'geo_address', "VARCHAR(300)");
  await addColumnIfMissing('shifts', 'device_info', "VARCHAR(500)");
  await addColumnIfMissing('shifts', 'ip_address', "VARCHAR(50)");

  // Branch geolocation for attendance validation
  await addColumnIfMissing('branches', 'geo_lat', "DECIMAL(10,7)");
  await addColumnIfMissing('branches', 'geo_lng', "DECIMAL(10,7)");
  await addColumnIfMissing('branches', 'geo_radius', "INT DEFAULT 100");

  // Employee work schedule
  await addColumnIfMissing('hr_employees', 'work_start', "TIME DEFAULT '08:00:00'");
  await addColumnIfMissing('hr_employees', 'work_end', "TIME DEFAULT '17:00:00'");
  await addColumnIfMissing('hr_employees', 'ignore_late_month', "VARCHAR(7)");
  await addColumnIfMissing('hr_employees', 'shift_id', "VARCHAR(50)");
  // Additional allowances & deductions for flexible contracts
  await addColumnIfMissing('hr_employees', 'food_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'communication_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'education_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'nature_allowance', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'social_insurance_rate', "DECIMAL(5,2) DEFAULT 0");
  await addColumnIfMissing('hr_employees', 'fixed_deduction', "DECIMAL(12,2) DEFAULT 0");

  // ═══ Cash Management Module ═══
  await createTableIfMissing('cash_boxes', `
    CREATE TABLE cash_boxes (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(30),
      type ENUM('main','branch','petty') DEFAULT 'branch',
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      keeper_username VARCHAR(100),
      currency VARCHAR(10) DEFAULT 'SAR',
      balance DECIMAL(14,2) DEFAULT 0,
      gl_account_id VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cb_branch (branch_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('bank_accounts', `
    CREATE TABLE bank_accounts (
      id VARCHAR(50) PRIMARY KEY,
      bank_name VARCHAR(200) NOT NULL,
      account_name VARCHAR(200),
      account_number VARCHAR(100),
      iban VARCHAR(50),
      currency VARCHAR(10) DEFAULT 'SAR',
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      balance DECIMAL(14,2) DEFAULT 0,
      gl_account_id VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('cash_receipts', `
    CREATE TABLE cash_receipts (
      id VARCHAR(50) PRIMARY KEY,
      receipt_number VARCHAR(30),
      receipt_date DATE NOT NULL,
      destination_type ENUM('cash','bank') NOT NULL,
      destination_id VARCHAR(50) NOT NULL,
      source_type ENUM('customer','employee','rent','sales','other') DEFAULT 'other',
      source_id VARCHAR(50),
      source_name VARCHAR(200),
      amount DECIMAL(14,2) NOT NULL,
      reference VARCHAR(200),
      description TEXT,
      attachment LONGTEXT,
      journal_id VARCHAR(50),
      status ENUM('draft','posted','cancelled') DEFAULT 'posted',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cr_date (receipt_date),
      INDEX idx_cr_dest (destination_type, destination_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('cash_payments', `
    CREATE TABLE cash_payments (
      id VARCHAR(50) PRIMARY KEY,
      payment_number VARCHAR(30),
      payment_date DATE NOT NULL,
      source_type ENUM('cash','bank') NOT NULL,
      source_id VARCHAR(50) NOT NULL,
      recipient_type ENUM('supplier','employee','expense','other') DEFAULT 'other',
      recipient_id VARCHAR(50),
      recipient_name VARCHAR(200),
      expense_account_id VARCHAR(50),
      amount DECIMAL(14,2) NOT NULL,
      reference VARCHAR(200),
      description TEXT,
      attachment LONGTEXT,
      journal_id VARCHAR(50),
      status ENUM('draft','posted','cancelled') DEFAULT 'posted',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cp_date (payment_date),
      INDEX idx_cp_src (source_type, source_id)
    ) ENGINE=InnoDB
  `);

  // V5.9.14 — track who approved each voucher and when, so the e-voucher
  // print template can show real signature names and the audit trail is
  // complete for posted vouchers.
  await addColumnIfMissing('cash_receipts',  'approved_by', "VARCHAR(100)");
  await addColumnIfMissing('cash_receipts',  'approved_at', "DATETIME");
  await addColumnIfMissing('cash_payments',  'approved_by', "VARCHAR(100)");
  await addColumnIfMissing('cash_payments',  'approved_at', "DATETIME");
  // V5.10.3 — manual journal-entry lines that override the auto-routed GL
  // posting. When set (JSON array of {accountId, debit, credit, description}),
  // approval uses these instead of the source-type-driven default contra.
  // Lets the bookkeeper hand-pick Dr / Cr from the COA at create time.
  await addColumnIfMissing('cash_receipts',  'manual_gl_lines', "TEXT");
  await addColumnIfMissing('cash_payments',  'manual_gl_lines', "TEXT");

  // v5.11.4 — accounting dimensions on cash vouchers. The vouchers' approval
  // step writes a journal; these columns let the dimensions captured on the
  // voucher header propagate to gl_journals + gl_entries so reports
  // sliced by brand/branch/project/cost-center include voucher activity.
  await addColumnIfMissing('cash_receipts', 'brand_id',       "VARCHAR(50)");
  await addColumnIfMissing('cash_receipts', 'branch_id',      "VARCHAR(50)");
  await addColumnIfMissing('cash_receipts', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('cash_receipts', 'project_id',     "VARCHAR(50)");
  await addColumnIfMissing('cash_payments', 'brand_id',       "VARCHAR(50)");
  await addColumnIfMissing('cash_payments', 'branch_id',      "VARCHAR(50)");
  await addColumnIfMissing('cash_payments', 'cost_center_id', "VARCHAR(50)");
  await addColumnIfMissing('cash_payments', 'project_id',     "VARCHAR(50)");

  // ─── W2-A — shift linkage on cash vouchers (till pay-in / pay-out) ───────
  // THE GAP THIS CLOSES: a cashier could not record cash in/out during a shift
  // from any client (/api/cash is mounted behind requireRole('admin','manager')),
  // and neither voucher table carried a shift reference — so a drop to the safe,
  // a float top-up or petty cash was invisible to the till and the expected-cash
  // figure at close was wrong by exactly those amounts (a leading cause of
  // unexplained shift variance). analytics_till_facts ALREADY has a shift_id
  // column and pay_in/pay_out movement types, and equations.expectedCash already
  // sums them — only this linkage was missing.
  //
  // NULLABLE + INDEXED and nothing else: every existing voucher keeps shift_id
  // NULL and behaves exactly as before (ProjectionService still projects it as a
  // shift-less branch till movement). Purely additive — never destructive.
  await addColumnIfMissing('cash_receipts', 'shift_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('cash_payments', 'shift_id', "VARCHAR(50) NULL");
  await addIndexIfMissing('cash_receipts', 'idx_cr_shift', 'shift_id');
  await addIndexIfMissing('cash_payments', 'idx_cp_shift', 'shift_id');

  // v5.10.5 — Fixed Assets registry: GL linkage + depreciation tracking +
  // project + audit columns, moved to right after createTableIfMissing('assets',
  // ...) further down. The comment that used to sit here ("the base `assets`
  // table is created earlier in server.js ~line 3388") was wrong — there is
  // only one `assets` CREATE TABLE in this file, and it's later in this same
  // function — so on a fresh install these ADD COLUMNs silently failed here
  // (addColumnIfMissing logs-and-continues on "table doesn't exist") and only
  // appeared after a second server restart. Same ordering-bug class as
  // Tier A.2 Section 6 (pos_orders.branch_id).

  // v5.10.5 — Self-heal inventory misclassification once at boot. Any
  // user-created "مخزون / منتجات تامة / WIP" account whose ancestry leads
  // to code 12 (الأصول الثابتة) instead of 112 (المخزون) is re-parented.
  // Idempotent + safe on cold start (silently skips when COA isn't seeded).
  try {
    const erpRouter = require('./routes/erp');
    if (erpRouter && typeof erpRouter._repairInventoryClassification === 'function') {
      const r = await erpRouter._repairInventoryClassification(db);
      if (r && r.ok) {
        console.log(`[migrate] inventory-classification: ok (${r.repaired.length} accounts repaired)`);
      } else if (r && r.reason) {
        console.log(`[migrate] inventory-classification: skipped (${r.reason})`);
      }
    }
  } catch(e) { console.warn('[migrate] inventory-classification: error', e.message); }
  // Existing rows shipped with status='posted' as the table default;
  // change the default to 'draft' going forward but leave existing rows alone.
  try {
    await db.query("ALTER TABLE cash_receipts MODIFY COLUMN status ENUM('draft','posted','cancelled') DEFAULT 'draft'");
    await db.query("ALTER TABLE cash_payments MODIFY COLUMN status ENUM('draft','posted','cancelled') DEFAULT 'draft'");
  } catch(e) { /* default-only change; safe to ignore on older MySQL */ }

  await createTableIfMissing('cash_transfers', `
    CREATE TABLE cash_transfers (
      id VARCHAR(50) PRIMARY KEY,
      transfer_number VARCHAR(30),
      transfer_date DATE NOT NULL,
      from_type ENUM('cash','bank') NOT NULL,
      from_id VARCHAR(50) NOT NULL,
      to_type ENUM('cash','bank') NOT NULL,
      to_id VARCHAR(50) NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      description TEXT,
      journal_id VARCHAR(50),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('advance_payments', `
    CREATE TABLE advance_payments (
      id VARCHAR(50) PRIMARY KEY,
      number VARCHAR(30),
      payment_date DATE NOT NULL,
      party_type ENUM('supplier','employee','rent','other') NOT NULL,
      party_id VARCHAR(50),
      party_name VARCHAR(200),
      total_amount DECIMAL(14,2) NOT NULL,
      settled_amount DECIMAL(14,2) DEFAULT 0,
      remaining DECIMAL(14,2) DEFAULT 0,
      source_type ENUM('cash','bank') NOT NULL,
      source_id VARCHAR(50) NOT NULL,
      description TEXT,
      status ENUM('active','fully_settled','cancelled') DEFAULT 'active',
      journal_id VARCHAR(50),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('cash_credit_notes', `
    CREATE TABLE cash_credit_notes (
      id VARCHAR(50) PRIMARY KEY,
      number VARCHAR(30),
      note_date DATE NOT NULL,
      note_type ENUM('credit','debit') NOT NULL,
      party_type ENUM('supplier','customer') NOT NULL,
      party_id VARCHAR(50),
      party_name VARCHAR(200),
      amount DECIMAL(14,2) NOT NULL,
      reason TEXT,
      journal_id VARCHAR(50),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('frozen_debts', `
    CREATE TABLE frozen_debts (
      id VARCHAR(50) PRIMARY KEY,
      number VARCHAR(30),
      freeze_date DATE NOT NULL,
      customer_id VARCHAR(50),
      customer_name VARCHAR(200),
      amount DECIMAL(14,2) NOT NULL,
      reason TEXT,
      status ENUM('frozen','recovered','written_off') DEFAULT 'frozen',
      journal_id VARCHAR(50),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // ═══ HR System Expansion: Shifts, Overtime, Exceptions, Audit ═══
  await createTableIfMissing('hr_shifts', `
    CREATE TABLE hr_shifts (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      code VARCHAR(20),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      break_minutes INT DEFAULT 60,
      grace_late_minutes INT DEFAULT 5,
      grace_early_leave_minutes INT DEFAULT 0,
      allow_overtime_before BOOLEAN DEFAULT FALSE,
      allow_overtime_after BOOLEAN DEFAULT TRUE,
      work_days VARCHAR(20) DEFAULT '0,1,2,3,4',
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  try {
    const [sCount] = await db.query('SELECT COUNT(*) AS cnt FROM hr_shifts');
    if (sCount[0].cnt === 0) {
      await db.query("INSERT INTO hr_shifts (id, name, code, start_time, end_time, break_minutes, grace_late_minutes, is_default, allow_overtime_after) VALUES ('SH-MORNING','الشفت الصباحي','MORNING','08:00:00','17:00:00',60,5,1,1),('SH-EVENING','الشفت المسائي','EVENING','16:00:00','00:00:00',60,5,0,1)");
    }
  } catch(e) {}

  await createTableIfMissing('hr_overtime_rules', `
    CREATE TABLE hr_overtime_rules (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      day_type ENUM('workday','restday','holiday') DEFAULT 'workday',
      multiplier DECIMAL(4,2) DEFAULT 1.50,
      min_minutes INT DEFAULT 30,
      require_approval BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  try {
    const [oCount] = await db.query('SELECT COUNT(*) AS cnt FROM hr_overtime_rules');
    if (oCount[0].cnt === 0) {
      await db.query("INSERT INTO hr_overtime_rules (id, name, day_type, multiplier, min_minutes, require_approval) VALUES ('OT-WORK','إضافي يوم عمل','workday',1.50,30,1),('OT-REST','إضافي يوم راحة','restday',2.00,30,1),('OT-HOLIDAY','إضافي عطلة رسمية','holiday',2.50,30,1)");
    }
  } catch(e) {}

  await createTableIfMissing('hr_overtime_entries', `
    CREATE TABLE hr_overtime_entries (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      attendance_id VARCHAR(50),
      entry_date DATE NOT NULL,
      minutes INT NOT NULL,
      rule_id VARCHAR(50),
      multiplier DECIMAL(4,2) DEFAULT 1.50,
      amount DECIMAL(12,2) DEFAULT 0,
      status ENUM('pending','approved','rejected') DEFAULT 'pending',
      approved_by VARCHAR(100),
      approved_at DATETIME,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ot_emp (employee_id),
      INDEX idx_ot_date (entry_date)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('hr_exceptions', `
    CREATE TABLE hr_exceptions (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      exception_type ENUM('ignore_late','ignore_early_leave','ignore_overtime','adjust_attendance','grant_day','excuse_absence') NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      new_clock_in TIME,
      new_clock_out TIME,
      reason TEXT,
      approved_by VARCHAR(100),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_exc_emp (employee_id),
      INDEX idx_exc_date (start_date, end_date)
    ) ENGINE=InnoDB
  `);

  // v5.11.1 — Official holidays (الإجازات الرسمية). Owner-defined
  // ranges that mark certain days as paid leave for an entire scope
  // (all employees / a brand / a single branch) AND carry an
  // overtime_multiplier applied when an employee actually clocks in
  // on a holiday day.
  await createTableIfMissing('hr_holidays', `
    CREATE TABLE hr_holidays (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      name_en VARCHAR(200),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      scope ENUM('all','brand','branch') NOT NULL DEFAULT 'all',
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      is_paid BOOLEAN DEFAULT TRUE,
      overtime_multiplier DECIMAL(4,2) DEFAULT 2.50,
      is_recurring BOOLEAN DEFAULT FALSE,
      notes TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_hol_dates (start_date, end_date),
      INDEX idx_hol_active (is_active),
      INDEX idx_hol_scope (scope, brand_id, branch_id)
    ) ENGINE=InnoDB
  `);

  // v5.11.1 — Seed Saudi public holidays the FIRST time the table is
  // created (idempotent: only inserts if id is missing). The two Eid
  // holidays use a placeholder date the owner adjusts annually (Hijri
  // dates shift); the National Day and Founding Day are fixed.
  try {
    const currentYear = new Date().getFullYear();
    const seeds = [
      {
        id: 'HOL-SA-NATIONAL',
        name: 'اليوم الوطني السعودي',
        name_en: 'Saudi National Day',
        start_date: currentYear + '-09-23',
        end_date:   currentYear + '-09-23',
        is_recurring: 1
      },
      {
        id: 'HOL-SA-FOUNDING',
        name: 'يوم التأسيس',
        name_en: 'Founding Day',
        start_date: currentYear + '-02-22',
        end_date:   currentYear + '-02-22',
        is_recurring: 1
      },
      {
        id: 'HOL-SA-EID-FITR',
        name: 'عيد الفطر المبارك (يُحدَّث سنوياً)',
        name_en: 'Eid al-Fitr (update annually)',
        start_date: currentYear + '-04-10',
        end_date:   currentYear + '-04-13',
        is_recurring: 0
      },
      {
        id: 'HOL-SA-EID-ADHA',
        name: 'عيد الأضحى المبارك (يُحدَّث سنوياً)',
        name_en: 'Eid al-Adha (update annually)',
        start_date: currentYear + '-06-16',
        end_date:   currentYear + '-06-19',
        is_recurring: 0
      }
    ];
    for (const h of seeds) {
      const [exists] = await db.query('SELECT id FROM hr_holidays WHERE id = ?', [h.id]);
      if (exists.length) continue;
      await db.query(
        'INSERT INTO hr_holidays (id, name, name_en, start_date, end_date, scope, is_paid, overtime_multiplier, is_recurring, is_active, created_by) ' +
        'VALUES (?, ?, ?, ?, ?, "all", 1, 2.50, ?, 1, "system-seed")',
        [h.id, h.name, h.name_en, h.start_date, h.end_date, h.is_recurring]
      );
    }
  } catch (e) {
    console.warn('[hr_holidays seed] non-fatal:', e.message);
  }

  await createTableIfMissing('hr_audit_log', `
    CREATE TABLE hr_audit_log (
      id VARCHAR(50) PRIMARY KEY,
      actor VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id VARCHAR(50),
      details TEXT,
      ip VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_entity (entity_type, entity_id),
      INDEX idx_audit_date (created_at)
    ) ENGINE=InnoDB
  `);

  // Enhance hr_attendance with extra fields for proper calculation
  await addColumnIfMissing('hr_attendance', 'early_leave_minutes', "INT DEFAULT 0");
  await addColumnIfMissing('hr_attendance', 'overtime_minutes', "INT DEFAULT 0");
  await addColumnIfMissing('hr_attendance', 'shift_id', "VARCHAR(50)");
  await addColumnIfMissing('hr_attendance', 'is_adjusted', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_attendance', 'adjustment_reason', "TEXT");

  // Fix device_id column size
  try { await db.query('ALTER TABLE hr_attendance MODIFY COLUMN device_id VARCHAR(500)'); } catch(e) {}

  // Users: email + warehouse link
  await addColumnIfMissing('users', 'email', "VARCHAR(200)");
  await addColumnIfMissing('users', 'default_warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('users', 'phone', "VARCHAR(30)");
  await addColumnIfMissing('users', 'full_name', "VARCHAR(200)");

  // v6.18.0 (Wave 1) — HR people-record fields.  Mirrors what migration
  // 0004_hr_job_titles.sql ALTERs.  Defensive: addColumnIfMissing is a
  // no-op when the migration framework already applied it.  All four
  // columns are NULL so existing users don't block startup; Wave 2 (a
  // later migration) will start enforcing them on insert/update.
  await addColumnIfMissing('users', 'iqama_number',   "VARCHAR(30)");
  await addColumnIfMissing('users', 'iban',           "VARCHAR(50)");
  await addColumnIfMissing('users', 'job_title_code', "VARCHAR(30)");

  // v6.18.0 (Wave 1) — Canonical job-titles lookup table.  Same shape
  // as migration 0004_hr_job_titles.sql so a brand-new database that
  // skips the framework still gets the seed.  Idempotent.
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS hr_job_titles (
      id           VARCHAR(50)  NOT NULL PRIMARY KEY,
      code         VARCHAR(30)  NOT NULL UNIQUE,
      name_ar      VARCHAR(100) NOT NULL,
      name_en      VARCHAR(100) NOT NULL,
      rank_level   INT          NOT NULL DEFAULT 7,
      category     ENUM('management','operations','finance','support','kitchen','warehouse','hr','it') NOT NULL DEFAULT 'operations',
      default_role ENUM('admin','manager','cashier','custody','employee') NOT NULL DEFAULT 'employee',
      is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_jt_rank     (rank_level),
      INDEX idx_jt_category (category),
      INDEX idx_jt_active   (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // Seed the 20 canonical Saudi-restaurant job titles.  INSERT IGNORE so
    // a re-run doesn't error on the existing unique `code` constraint.
    await db.query(`INSERT IGNORE INTO hr_job_titles
      (id, code, name_ar, name_en, rank_level, category, default_role) VALUES
      ('jt-owner',        'OWNER',        'المالك',                'Owner',               1,  'management', 'admin'),
      ('jt-gm',           'GM',           'المدير العام',          'General Manager',     2,  'management', 'admin'),
      ('jt-ops-mgr',      'OPS_MGR',      'مدير العمليات',         'Operations Manager',  3,  'management', 'manager'),
      ('jt-branch-mgr',   'BRANCH_MGR',   'مدير فرع',              'Branch Manager',      4,  'management', 'manager'),
      ('jt-shift-sup',    'SHIFT_SUP',    'مشرف وردية',            'Shift Supervisor',    5,  'operations', 'manager'),
      ('jt-chef-head',    'CHEF_HEAD',    'رئيس الطباخين',         'Head Chef',           5,  'kitchen',    'manager'),
      ('jt-accountant',   'ACCOUNTANT',   'محاسب',                 'Accountant',          6,  'finance',    'custody'),
      ('jt-hr-officer',   'HR_OFFICER',   'مسؤول موارد بشرية',     'HR Officer',          6,  'hr',         'manager'),
      ('jt-sr-cashier',   'SR_CASHIER',   'كاشير أول',             'Senior Cashier',      6,  'operations', 'cashier'),
      ('jt-wh-keeper',    'WH_KEEPER',    'أمين مستودع',           'Warehouse Keeper',    6,  'warehouse',  'custody'),
      ('jt-cashier',      'CASHIER',      'كاشير',                 'Cashier',             7,  'operations', 'cashier'),
      ('jt-sr-server',    'SR_SERVER',    'نادل أول',              'Senior Server',       7,  'operations', 'employee'),
      ('jt-chef-sous',    'CHEF_SOUS',    'طاهٍ ثانٍ',             'Sous Chef',           7,  'kitchen',    'employee'),
      ('jt-it-tech',      'IT_TECH',      'فني تقنية',             'IT Technician',       7,  'it',         'employee'),
      ('jt-server',       'SERVER',       'نادل',                  'Server',              8,  'operations', 'employee'),
      ('jt-cook',         'COOK',         'طاهٍ',                  'Cook',                8,  'kitchen',    'employee'),
      ('jt-stocktaker',   'STOCKTAKER',   'جردة',                  'Stocktaker',          8,  'warehouse',  'employee'),
      ('jt-kitchen-help', 'KITCHEN_HELP', 'مساعد مطبخ',            'Kitchen Helper',      9,  'kitchen',    'employee'),
      ('jt-delivery',     'DELIVERY',     'سائق توصيل',            'Delivery Driver',     9,  'operations', 'employee'),
      ('jt-cleaner',      'CLEANER',      'عامل نظافة',            'Cleaner',             10, 'support',    'employee')`);
  } catch (jtErr) {
    console.warn('[startup] hr_job_titles seed skipped:', jtErr && jtErr.message);
  }
  try { await db.query('CREATE INDEX idx_users_iqama_number   ON users(iqama_number)');   } catch(e) {}
  try { await db.query('CREATE INDEX idx_users_job_title_code ON users(job_title_code)'); } catch(e) {}

  // v6.18.2 (Wave 3) — Backfill the users <-> hr_employees linkage so
  // every user has a canonical "person" record.  Mirrors migration
  // 0005_user_employee_link.sql for installs that bypass the framework.
  // Every step is idempotent (re-running is safe and a no-op on already-
  // linked rows).
  try {
    await db.query("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS linked_username VARCHAR(100) NULL");
  } catch(e) {}
  try { await db.query("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS linked_user_id INT NULL"); } catch(e) {}
  try { await db.query('CREATE INDEX idx_hr_emp_linked_username ON hr_employees(linked_username)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_users_employee_id ON users(employee_id)'); } catch(e) {}

  // Step B: link users that already have a matching hr_employees row.
  try {
    await db.query(`UPDATE users u
      JOIN hr_employees e ON e.linked_username = u.username
      SET u.employee_id = e.id
      WHERE (u.employee_id IS NULL OR u.employee_id = '')`);
  } catch (e) { console.warn('[startup] backfill step B skipped:', e && e.message); }

  // Step C: create shell employees for users without one.
  try {
    await db.query(`INSERT IGNORE INTO hr_employees
      (id, employee_number, first_name, last_name, hire_date, status, job_title, linked_username, created_at)
      SELECT
        CONCAT('emp-shell-', u.username),
        CONCAT('SHELL-', LPAD(u.id, 6, '0')),
        COALESCE(NULLIF(TRIM(u.full_name), ''), u.username),
        '',
        COALESCE(DATE(u.created_at), CURDATE()),
        'active',
        'بحاجة لتحديث',
        u.username,
        COALESCE(u.created_at, NOW())
      FROM users u
      WHERE (u.employee_id IS NULL OR u.employee_id = '')`);
  } catch (e) { console.warn('[startup] backfill step C skipped:', e && e.message); }

  // v7.5 (H2) Step D — populate hr_employees.linked_user_id from the matching
  // user (Steps B/C set employee_id + linked_username but not the numeric id).
  try {
    await db.query(`UPDATE hr_employees e
      JOIN users u ON u.username = e.linked_username
      SET e.linked_user_id = u.id
      WHERE e.linked_user_id IS NULL`);
  } catch (e) { console.warn('[startup] backfill step D skipped:', e && e.message); }

  // v7.5 (H2) — enforce 1:1 (at most one employee per login account). NULL links
  // are exempt (MySQL allows multiple NULLs); pre-existing duplicates simply make
  // the index creation fail and be skipped.
  try { await db.query('CREATE UNIQUE INDEX uq_hr_emp_linked_username ON hr_employees(linked_username)'); } catch(e) {}

  // Step D: point users at the newly created shells.
  try {
    await db.query(`UPDATE users u
      JOIN hr_employees e ON e.id = CONCAT('emp-shell-', u.username)
      SET u.employee_id = e.id
      WHERE (u.employee_id IS NULL OR u.employee_id = '')`);
  } catch (e) { console.warn('[startup] backfill step D skipped:', e && e.message); }

  // Step E: nullify orphan employee_id references.
  try {
    await db.query(`UPDATE users SET employee_id = NULL
      WHERE employee_id IS NOT NULL AND employee_id != ''
        AND employee_id NOT IN (SELECT id FROM hr_employees)`);
  } catch (e) { console.warn('[startup] backfill step E skipped:', e && e.message); }

  // ═══════════════════════════════════════════════════════════════════
  // v7.7 — PORTAL ACCESS FLAGS (employee portal / custody portal)
  // ───────────────────────────────────────────────────────────────────
  // Portal access becomes an explicit, role-independent capability so an
  // admin can grant the Employee Portal and/or a standalone Custody Portal
  // to ANY user (a cashier can also have a custody account, etc.). The
  // login endpoint gates each portal by its flag. Backfill preserves the
  // current behavior: employee portal ON for staff roles that already have
  // an HR record; custody portal ON for anyone with an active custody_users
  // row or the legacy 'custody' role.
  // IMPORTANT: the backfill must run ONCE (when the column is first created),
  // NOT on every boot — otherwise it would re-enable a portal an admin has
  // intentionally turned off for a staff-role user. So detect prior existence.
  async function _colExists(table, col) {
    try {
      const [c] = await db.query(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, col]);
      return c.length > 0;
    } catch (e) { return true; /* assume exists → skip backfill on error */ }
  }
  const _empPortalExisted  = await _colExists('users', 'employee_portal');
  const _custPortalExisted = await _colExists('users', 'custody_portal');
  await addColumnIfMissing('users', 'employee_portal', "TINYINT(1) DEFAULT 0");
  await addColumnIfMissing('users', 'custody_portal',  "TINYINT(1) DEFAULT 0");
  // One-time backfill of employee_portal: staff roles OR users already linked to HR.
  if (!_empPortalExisted) {
    try {
      await db.query(`UPDATE users SET employee_portal = 1
        WHERE (role IN ('employee','cashier','manager')
               OR (employee_id IS NOT NULL AND employee_id <> '')
               OR username IN (SELECT linked_username FROM hr_employees WHERE linked_username IS NOT NULL))`);
      console.log('[startup] employee_portal one-time backfill applied');
    } catch (e) { console.warn('[startup] employee_portal backfill skipped:', e && e.message); }
  }
  // One-time backfill of custody_portal: legacy custody role OR an active custody row.
  if (!_custPortalExisted) {
    try {
      await db.query(`UPDATE users SET custody_portal = 1
        WHERE (role = 'custody'
               OR username IN (SELECT linked_username FROM custody_users WHERE linked_username IS NOT NULL AND is_active = 1))`);
      console.log('[startup] custody_portal one-time backfill applied');
    } catch (e) { console.warn('[startup] custody_portal backfill skipped:', e && e.message); }
  }

  // ═══════════════════════════════════════
  // WAREHOUSE-BASED INVENTORY RESTRUCTURE
  // ═══════════════════════════════════════
  // Link all inventory operations to specific warehouses
  await addColumnIfMissing('inventory_movements', 'warehouse_id', "VARCHAR(50)");
  // v7.1 — reference_type/reference_id link each movement to its SOURCE document
  // (sale invoice, waste WST-, adjustment ADJ-, purchase…). db/schema.sql never
  // defined these columns, yet routes/sales.js inserts into them WITHOUT a
  // try/catch — so a fresh install would throw on every sale. Guarantee they
  // exist on all deploys (idempotent: a no-op where they already exist).
  await addColumnIfMissing('inventory_movements', 'reference_type', "VARCHAR(50)");
  await addColumnIfMissing('inventory_movements', 'reference_id', "VARCHAR(100)");
  // Phase 4A (3C closure) — a MONOTONIC sequence so stocktake reconciliation can
  // window movements deterministically (seq > snapshot_seq AND seq <= counted_seq)
  // instead of the fragile 1-second movement_date. The string id (MV-<ms>-<rand>)
  // is NOT sortable. ADD COLUMN AUTO_INCREMENT backfills existing rows in PK order.
  await addColumnIfMissing('inventory_movements', 'seq', "BIGINT NOT NULL AUTO_INCREMENT UNIQUE");
  await addColumnIfMissing('stocktakes', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('stocktakes', 'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('shortage_requests', 'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('shortage_requests', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('stock_adjustments', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('purchases', 'warehouse_id', "VARCHAR(50)");
  // Performance indexes
  try { await db.query('CREATE INDEX idx_wh_stock_item ON warehouse_stock(item_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_inv_mov_wh ON inventory_movements(warehouse_id)'); } catch(e) {}

  // Seed cost settings into the existing key-value settings table
  try {
    await db.query(`INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
      ('costing_method','WEIGHTED_AVERAGE'),
      ('default_pricing_mode','fixed'),
      ('default_markup_pct','30'),
      ('BranchName',''),
      ('inventory_method','perpetual')`);
  } catch (e) { console.log('[DB] Cost settings seed:', e.message.substring(0, 80)); }

  // ═══════════════════════════════════════════════════════════════════
  // ERP CORE v3 — MULTI-BRAND MULTI-BRANCH FRANCHISE TABLES (DESIGN DOC)
  // ═══════════════════════════════════════════════════════════════════

  // 1) Companies — the legal entity owning brands/branches (multi-tenant root)
  await createTableIfMissing('companies', `
    CREATE TABLE companies (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      legal_name VARCHAR(300) DEFAULT '',
      cr_number VARCHAR(30) DEFAULT '',
      tax_number VARCHAR(30) DEFAULT '',
      country VARCHAR(50) DEFAULT 'SA',
      city VARCHAR(100) DEFAULT '',
      base_currency VARCHAR(3) DEFAULT 'SAR',
      fiscal_year_start DATE,
      logo_url TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  try {
    const [cnt] = await db.query('SELECT COUNT(*) AS c FROM companies');
    if (cnt[0].c === 0) {
      await db.query("INSERT INTO companies (id, name, base_currency, fiscal_year_start) VALUES ('CO-MAIN','الشركة الرئيسية','SAR','2026-01-01')");
    }
  } catch(e) {}

  // Link brands/branches to the company (optional — default CO-MAIN)
  await addColumnIfMissing('brands', 'company_id', "VARCHAR(50) DEFAULT 'CO-MAIN'");
  await addColumnIfMissing('brands', 'royalty_type', "ENUM('percentage','fixed','mixed','none') DEFAULT 'none'");
  await addColumnIfMissing('brands', 'royalty_value', "DECIMAL(12,4) DEFAULT 0");
  await addColumnIfMissing('brands', 'royalty_base', "ENUM('gross_sales','net_sales','none') DEFAULT 'gross_sales'");
  await addColumnIfMissing('brands', 'royalty_fixed_component', "DECIMAL(12,2) DEFAULT 0");
  await addColumnIfMissing('brands', 'franchise_fee', "DECIMAL(14,2) DEFAULT 0");
  await addColumnIfMissing('brands', 'contract_start', "DATE");
  await addColumnIfMissing('brands', 'contract_end', "DATE");
  await addColumnIfMissing('branches', 'company_id', "VARCHAR(50) DEFAULT 'CO-MAIN'");

  // 2) Item categories (hierarchical)
  await createTableIfMissing('item_categories', `
    CREATE TABLE item_categories (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      brand_id VARCHAR(50),
      parent_id VARCHAR(50),
      name VARCHAR(200) NOT NULL,
      code VARCHAR(30) DEFAULT '',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_parent (parent_id), INDEX idx_brand (brand_id)
    ) ENGINE=InnoDB
  `);

  // 3) Units + unit_conversions
  await createTableIfMissing('units', `
    CREATE TABLE units (
      id VARCHAR(20) PRIMARY KEY,
      name_ar VARCHAR(100) NOT NULL,
      name_en VARCHAR(100) DEFAULT '',
      type ENUM('weight','volume','count','length') DEFAULT 'count'
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('unit_conversions', `
    CREATE TABLE unit_conversions (
      id VARCHAR(50) PRIMARY KEY,
      from_unit VARCHAR(20) NOT NULL,
      to_unit VARCHAR(20) NOT NULL,
      factor DECIMAL(14,6) NOT NULL,
      UNIQUE KEY uq_conv (from_unit, to_unit)
    ) ENGINE=InnoDB
  `);
  try {
    const [uc] = await db.query('SELECT COUNT(*) AS c FROM units');
    if (uc[0].c === 0) {
      await db.query("INSERT INTO units (id, name_ar, name_en, type) VALUES ('KG','كيلوجرام','kg','weight'),('G','جرام','g','weight'),('L','لتر','L','volume'),('ML','مليلتر','ml','volume'),('PCS','قطعة','pcs','count'),('BOX','صندوق','box','count'),('PACK','علبة','pack','count'),('DOZ','دزينة','dozen','count')");
      await db.query("INSERT INTO unit_conversions (id, from_unit, to_unit, factor) VALUES ('UC-1','KG','G',1000),('UC-2','G','KG',0.001),('UC-3','L','ML',1000),('UC-4','ML','L',0.001),('UC-5','DOZ','PCS',12),('UC-6','PCS','DOZ',0.083333)");
    }
  } catch(e) {}

  // ── Phase U — per-item Units of Measure (base + major units, frozen factors) ──
  // Each item has exactly ONE base unit (conversion_to_base = 1). Major units
  // (carton/bag/box) carry a per-item conversion_to_base (e.g. 1 carton = 12).
  // Stock/lots/WAC/GL are ALWAYS in the base unit; documents freeze the factor.
  // References the existing `units` master by unit_code; never duplicates it.
  await createTableIfMissing('item_units', `
    CREATE TABLE item_units (
      id VARCHAR(50) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL,
      unit_id VARCHAR(20) NULL,
      unit_name VARCHAR(100) NOT NULL,
      unit_code VARCHAR(30) NOT NULL,
      is_base TINYINT(1) NOT NULL DEFAULT 0,
      conversion_to_base DECIMAL(18,6) NOT NULL DEFAULT 1,
      quantity_precision TINYINT NOT NULL DEFAULT 2,
      allow_purchase TINYINT(1) NOT NULL DEFAULT 1,
      allow_receipt TINYINT(1) NOT NULL DEFAULT 1,
      allow_issue TINYINT(1) NOT NULL DEFAULT 1,
      allow_transfer TINYINT(1) NOT NULL DEFAULT 1,
      allow_stocktake TINYINT(1) NOT NULL DEFAULT 1,
      allow_production TINYINT(1) NOT NULL DEFAULT 1,
      allow_sale TINYINT(1) NOT NULL DEFAULT 1,
      barcode_id VARCHAR(50) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(100) NULL,
      updated_at TIMESTAMP NULL,
      updated_by VARCHAR(100) NULL,
      UNIQUE KEY uq_item_unit_code (item_id, unit_code),
      INDEX idx_item_units_item (item_id),
      INDEX idx_item_units_base (item_id, is_base)
    ) ENGINE=InnoDB
  `);
  // NOTE: the per-line UoM snapshot columns are added later in _migrateUomLineColumns()
  // (invoked near the end of runMigrations, AFTER the v2 document line tables exist).

  // 4) Price lists (برند/فرع-specific pricing)
  await createTableIfMissing('price_lists', `
    CREATE TABLE price_lists (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      name VARCHAR(200) NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      valid_from DATE,
      valid_to DATE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_brand_branch (brand_id, branch_id)
    ) ENGINE=InnoDB
  `);
  // v5.16.1 — Ensure is_active exists on older deployments that
  // were created before the column was part of the CREATE TABLE
  // statement above. Default TRUE = backwards-compatible (existing
  // price lists stay active).
  await addColumnIfMissing('price_lists', 'is_active', 'BOOLEAN DEFAULT TRUE');
  await createTableIfMissing('price_list_items', `
    CREATE TABLE price_list_items (
      id VARCHAR(60) PRIMARY KEY,
      price_list_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      price DECIMAL(14,4) NOT NULL,
      min_price DECIMAL(14,4) DEFAULT 0,
      valid_from DATE,
      valid_to DATE,
      UNIQUE KEY uq_pli (price_list_id, item_id),
      INDEX idx_item (item_id)
    ) ENGINE=InnoDB
  `);

  // 5) BOM / Recipes (وصفات الإنتاج)
  await createTableIfMissing('bom', `
    CREATE TABLE bom (
      id VARCHAR(50) PRIMARY KEY,
      product_id VARCHAR(50) NOT NULL,
      version INT DEFAULT 1,
      yield_quantity DECIMAL(10,4) DEFAULT 1,
      yield_unit VARCHAR(20) DEFAULT 'PCS',
      is_active BOOLEAN DEFAULT TRUE,
      effective_from DATE,
      effective_to DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_product (product_id, is_active)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('bom_lines', `
    CREATE TABLE bom_lines (
      id VARCHAR(60) PRIMARY KEY,
      bom_id VARCHAR(50) NOT NULL,
      component_item_id VARCHAR(50) NOT NULL,
      quantity DECIMAL(12,4) NOT NULL,
      unit VARCHAR(20) DEFAULT 'PCS',
      waste_pct DECIMAL(5,2) DEFAULT 0,
      INDEX idx_bom (bom_id), INDEX idx_component (component_item_id)
    ) ENGINE=InnoDB
  `);

  // 5b) Combos / Offers (العروض — "أي سندوتش مع عصير")
  // A combo is a normal `menu` row flagged is_combo=1 (so it auto-appears in the
  // cashier grid + inherits pricing/category/soft-delete/reporting). Its makeup
  // lives in two child tables that REFERENCE other menu rows (no recipe
  // duplication): `combo_groups` holds the fixed components + the choice groups,
  // `combo_group_items` holds each referenced menu item. At sale time the combo
  // line is expanded into its components and the existing recipe-deduction
  // engine runs per component (see routes/sales.js).
  await addColumnIfMissing('menu', 'is_combo', "TINYINT(1) DEFAULT 0");
  await createTableIfMissing('combo_groups', `
    CREATE TABLE combo_groups (
      id VARCHAR(60) PRIMARY KEY,
      menu_id VARCHAR(50) NOT NULL,
      group_type ENUM('fixed','choice') NOT NULL DEFAULT 'choice',
      name VARCHAR(200) NOT NULL,
      min_select INT DEFAULT 1,
      max_select INT DEFAULT 1,
      sort_order INT DEFAULT 0,
      INDEX idx_combo (menu_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('combo_group_items', `
    CREATE TABLE combo_group_items (
      id VARCHAR(60) PRIMARY KEY,
      group_id VARCHAR(60) NOT NULL,
      menu_item_id VARCHAR(50) NOT NULL,
      qty DECIMAL(10,3) DEFAULT 1,
      sort_order INT DEFAULT 0,
      INDEX idx_group (group_id), INDEX idx_item (menu_item_id)
    ) ENGINE=InnoDB
  `);

  // 6) Purchase receipts (منفصل عن PO لدعم الاستلام الجزئي)
  await createTableIfMissing('purchase_receipts', `
    CREATE TABLE purchase_receipts (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      po_id VARCHAR(50),
      supplier_id VARCHAR(50),
      receipt_number VARCHAR(30) UNIQUE,
      receipt_date DATE NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      subtotal DECIMAL(14,2) DEFAULT 0,
      vat_amount DECIMAL(14,2) DEFAULT 0,
      total DECIMAL(14,2) DEFAULT 0,
      status ENUM('draft','posted','cancelled') DEFAULT 'draft',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_po (po_id), INDEX idx_date (receipt_date)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('purchase_receipt_lines', `
    CREATE TABLE purchase_receipt_lines (
      id VARCHAR(60) PRIMARY KEY,
      receipt_id VARCHAR(50) NOT NULL,
      po_line_id VARCHAR(50),
      item_id VARCHAR(50) NOT NULL,
      quantity DECIMAL(14,4) NOT NULL,
      unit VARCHAR(20) DEFAULT 'PCS',
      unit_cost DECIMAL(14,4) NOT NULL,
      vat_rate DECIMAL(5,2) DEFAULT 15,
      line_total DECIMAL(14,2) NOT NULL,
      INDEX idx_receipt (receipt_id), INDEX idx_item (item_id)
    ) ENGINE=InnoDB
  `);

  // 7) POS terminals
  await createTableIfMissing('pos_terminals', `
    CREATE TABLE pos_terminals (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      branch_id VARCHAR(50) NOT NULL,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(30),
      device_id VARCHAR(100),
      last_sync_at DATETIME,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_branch (branch_id)
    ) ENGINE=InnoDB
  `);

  // 8) Accounting periods (period lock)
  await createTableIfMissing('accounting_periods', `
    CREATE TABLE accounting_periods (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      period_name VARCHAR(20) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status ENUM('open','soft_closed','closed') DEFAULT 'open',
      closed_by VARCHAR(100),
      closed_at DATETIME,
      notes TEXT,
      UNIQUE KEY uq_period (company_id, period_name),
      INDEX idx_dates (start_date, end_date)
    ) ENGINE=InnoDB
  `);
  // v6.4.1 HOTFIX — earlier deployments created accounting_periods WITHOUT
  // brand_id/branch_id/period_label, so the v6.2.0 createTableIfMissing
  // below at line ~2886 was a no-op and the period-close guard in
  // routes/sales.js threw "Unknown column 'brand_id'". Defensively add
  // the missing columns + widen the status enum to include 'soft_close'
  // (no 'd') and 'locked' that the v6.2.0 endpoints write.
  // period_name is created NOT NULL by the fresh CREATE TABLE above, but a table
  // that predates it (older installs / test DBs) never gets it — the CREATE ...
  // IF NOT EXISTS is a no-op — so GET /api/erp/periods' `SELECT ... period_name`
  // threw ER_BAD_FIELD_ERROR (a hard 500). Add it idempotently as NULLABLE, which
  // is exactly how the route treats it (prefers period_name, falls back to
  // period_label). Same defensive pattern as the four siblings below.
  await addColumnIfMissing('accounting_periods', 'period_name',   'VARCHAR(20) NULL');
  await addColumnIfMissing('accounting_periods', 'period_label',  'VARCHAR(20) NULL');
  await addColumnIfMissing('accounting_periods', 'brand_id',      'VARCHAR(50) NULL');
  await addColumnIfMissing('accounting_periods', 'branch_id',     'VARCHAR(50) NULL');
  await addColumnIfMissing('accounting_periods', 'closing_notes', 'TEXT NULL');
  try {
    await db.query(
      "ALTER TABLE accounting_periods MODIFY COLUMN status ENUM('open','soft_close','soft_closed','closed','locked') NOT NULL DEFAULT 'open'"
    );
  } catch (e) { /* MySQL versions without MODIFY support — ignore */ }
  try { await db.query('CREATE INDEX idx_ap_label ON accounting_periods(period_label)'); } catch (e) {}
  try { await db.query('CREATE INDEX idx_ap_brand_branch ON accounting_periods(brand_id, branch_id)'); } catch (e) {}

  // 9) Royalty runs (franchise fee accruals)
  await createTableIfMissing('royalty_runs', `
    CREATE TABLE royalty_runs (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      brand_id VARCHAR(50) NOT NULL,
      period_id VARCHAR(50),
      run_date DATE NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      gross_sales DECIMAL(14,2) DEFAULT 0,
      net_sales DECIMAL(14,2) DEFAULT 0,
      royalty_type ENUM('percentage','fixed','mixed','none') DEFAULT 'percentage',
      royalty_value DECIMAL(12,4) DEFAULT 0,
      fixed_component DECIMAL(12,2) DEFAULT 0,
      royalty_amount DECIMAL(14,2) DEFAULT 0,
      status ENUM('draft','approved','invoiced','paid','cancelled') DEFAULT 'draft',
      gl_journal_id VARCHAR(50),
      approved_by VARCHAR(100),
      approved_at DATETIME,
      paid_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_brand_period (brand_id, period_start)
    ) ENGINE=InnoDB
  `);

  // 10) Waste entries (formalize)
  await createTableIfMissing('waste_entries', `
    CREATE TABLE waste_entries (
      id VARCHAR(50) PRIMARY KEY,
      company_id VARCHAR(50) DEFAULT 'CO-MAIN',
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      warehouse_id VARCHAR(50) NOT NULL,
      cost_center_id VARCHAR(50),
      waste_date DATE NOT NULL,
      reason ENUM('expired','damaged','spill','prep_loss','customer_return','other') DEFAULT 'other',
      total_cost DECIMAL(14,2) DEFAULT 0,
      notes TEXT,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dims (brand_id, branch_id, waste_date)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('waste_entry_items', `
    CREATE TABLE waste_entry_items (
      id VARCHAR(60) PRIMARY KEY,
      waste_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      quantity DECIMAL(14,4) NOT NULL,
      unit VARCHAR(20) DEFAULT 'PCS',
      unit_cost DECIMAL(14,4) DEFAULT 0,
      line_cost DECIMAL(14,2) DEFAULT 0,
      INDEX idx_waste (waste_id)
    ) ENGINE=InnoDB
  `);

  // 11) ZATCA Phase 2 compliance fields on sales (invoices)
  await addColumnIfMissing('sales', 'invoice_uuid', "VARCHAR(36)");
  await addColumnIfMissing('sales', 'invoice_hash', "VARCHAR(100)");
  await addColumnIfMissing('sales', 'previous_invoice_hash', "VARCHAR(100)");
  // v6.14.0 — Include 'cancellation' so POST /sales/:id/void can stamp
  // the row when the cashier cancels an order. Without this value the
  // UPDATE silently fails on STRICT_TRANS_TABLES MySQL deployments.
  // addColumnIfMissing only runs the first time the column is absent;
  // for existing deployments migration 0003 widens the enum in-place.
  await addColumnIfMissing('sales', 'zatca_type', "ENUM('standard','simplified','credit_note','debit_note','cancellation') DEFAULT 'simplified'");
  // v6.18.8 — Force-widen the ENUM on existing installs whose baseline
  // created the column with only the original 4 values ('standard',
  // 'simplified','credit_note','debit_note').  addColumnIfMissing above
  // is a no-op once the column exists, so the production schema stayed
  // at 4 values forever → POST /sales/:id/void failed with
  // "Data truncated for column 'zatca_type' at row 1".  MODIFY COLUMN
  // is idempotent (no-op when the definition already matches), so it's
  // safe to run on every server start.
  await modifyColumnDefinition('sales', 'zatca_type', "ENUM('standard','simplified','credit_note','debit_note','cancellation') DEFAULT 'simplified'");
  await addColumnIfMissing('sales', 'zatca_submitted_at', "DATETIME");
  await addColumnIfMissing('sales', 'zatca_status', "ENUM('pending','submitted','accepted','rejected') DEFAULT 'pending'");

  // 12) Item categories and cost method on inv_items
  await addColumnIfMissing('inv_items', 'category_id', "VARCHAR(50)");
  await addColumnIfMissing('inv_items', 'cost_method', "ENUM('wavg','fifo','standard') DEFAULT 'wavg'");
  await addColumnIfMissing('inv_items', 'standard_cost', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('inv_items', 'min_stock', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('inv_items', 'max_stock', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('inv_items', 'is_sellable', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('inv_items', 'is_inventoried', "BOOLEAN DEFAULT TRUE");

  // 13) Auto-seed accounting periods for current year (if not already)
  try {
    const [cp] = await db.query('SELECT COUNT(*) AS c FROM accounting_periods');
    if (cp[0].c === 0) {
      const y = new Date().getFullYear();
      for (let m = 1; m <= 12; m++) {
        const mm = String(m).padStart(2, '0');
        const last = new Date(y, m, 0).getDate();
        await db.query(
          `INSERT IGNORE INTO accounting_periods (id, period_name, start_date, end_date, status) VALUES (?,?,?,?,?)`,
          [`AP-${y}-${mm}`, `${y}-${mm}`, `${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2,'0')}`, 'open']
        );
      }
    }
  } catch(e) {}

  // ═══════════════════════════════════════
  // WORKFLOW ENGINE v2 — نظام المعاملات المتكامل
  // ═══════════════════════════════════════

  // Branch / Department short codes (for BR-DEP-TYP-YYYYMMDD-0001 numbering)
  await addColumnIfMissing('branches', 'code', "VARCHAR(10) DEFAULT ''");
  // V5.7.14 — operating-company name per branch (printed on the receipt
  // between the parent brand "Moroccan Taste" and the branch line).
  await addColumnIfMissing('branches', 'company_name', "VARCHAR(200) DEFAULT NULL");
  await addColumnIfMissing('hr_departments', 'code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('hr_departments', 'branch_id', "VARCHAR(50)");

  // Employee hierarchy / permissions
  await addColumnIfMissing('hr_employees', 'manager_id', "VARCHAR(50)");
  await addColumnIfMissing('hr_employees', 'workflow_level', "INT DEFAULT 1");
  await addColumnIfMissing('hr_employees', 'can_create_txn', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('hr_employees', 'can_approve_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'can_reject_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'can_return_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'can_forward_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'can_close_txn', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('hr_employees', 'linked_username', "VARCHAR(100)");

  // Transaction enhancements: importance, branch/dept snapshot, type code, daily serial, current assignee
  await addColumnIfMissing('transactions', 'importance', "ENUM('critical','high','medium','low') DEFAULT 'medium'");
  await addColumnIfMissing('transactions', 'branch_code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('transactions', 'branch_name', "VARCHAR(200) DEFAULT ''");
  await addColumnIfMissing('transactions', 'dept_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'dept_code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('transactions', 'dept_name', "VARCHAR(200) DEFAULT ''");
  await addColumnIfMissing('transactions', 'type_code', "VARCHAR(10) DEFAULT ''");
  await addColumnIfMissing('transactions', 'daily_serial', "INT DEFAULT 0");
  await addColumnIfMissing('transactions', 'current_assignee', "VARCHAR(100) DEFAULT ''");
  // Role snapshot — which job-title is currently responsible (independent of person)
  await addColumnIfMissing('transactions', 'current_role_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'current_role_name', "VARCHAR(200) DEFAULT ''");
  // Initiator's position — used to look up the per-position workflow chain
  await addColumnIfMissing('transactions', 'initiator_position_id', "VARCHAR(50)");

  // Enterprise-style fields (subject, secrecy, rich content, draft marker)
  await addColumnIfMissing('transactions', 'subject', "VARCHAR(500) DEFAULT ''");
  await addColumnIfMissing('transactions', 'content_secrecy', "ENUM('normal','confidential','secret','top_secret') DEFAULT 'normal'");
  await addColumnIfMissing('transactions', 'attachments_secrecy', "ENUM('normal','confidential','secret','top_secret') DEFAULT 'normal'");
  await addColumnIfMissing('transactions', 'content_html', "LONGTEXT");
  await addColumnIfMissing('transactions', 'issuing_entity_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'issuing_entity_name', "VARCHAR(300) DEFAULT ''");
  await addColumnIfMissing('transactions', 'hijri_date', "VARCHAR(20) DEFAULT ''");

  // Expense categories (نوع المصروف) — admin-maintained list used on transactions
  await createTableIfMissing('expense_categories', `
    CREATE TABLE expense_categories (
      id VARCHAR(50) PRIMARY KEY,
      code VARCHAR(20) DEFAULT '',
      name VARCHAR(200) NOT NULL,
      gl_account_code VARCHAR(20) DEFAULT '',
      gl_account_id VARCHAR(50) DEFAULT '',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // Seed common Saudi expense categories if empty
  try {
    const [ec] = await db.query('SELECT COUNT(*) AS cnt FROM expense_categories');
    if (ec[0].cnt === 0) {
      await db.query(`INSERT INTO expense_categories (id, code, name) VALUES
        ('EXP-SAL','SAL','رواتب وأجور'),
        ('EXP-RNT','RNT','إيجارات'),
        ('EXP-UTL','UTL','كهرباء ومياه'),
        ('EXP-COM','COM','اتصالات وإنترنت'),
        ('EXP-MNT','MNT','صيانة وإصلاح'),
        ('EXP-CLN','CLN','نظافة'),
        ('EXP-RAW','RAW','مواد خام ومؤن'),
        ('EXP-PKG','PKG','تعبئة وتغليف'),
        ('EXP-TRP','TRP','نقل ومواصلات'),
        ('EXP-FUL','FUL','وقود ومحروقات'),
        ('EXP-OFF','OFF','قرطاسية ومستلزمات مكتبية'),
        ('EXP-ADV','ADV','دعاية وإعلان'),
        ('EXP-GOV','GOV','رسوم حكومية'),
        ('EXP-INS','INS','تأمينات'),
        ('EXP-LEG','LEG','خدمات قانونية واستشارات'),
        ('EXP-BNK','BNK','عمولات بنكية'),
        ('EXP-AST','AST','أصول ثابتة ومعدات'),
        ('EXP-TRN','TRN','تدريب وتطوير'),
        ('EXP-HOS','HOS','ضيافة'),
        ('EXP-MSC','MSC','متفرقات')`);
    }
  } catch(e) {}

  // Transaction: expense category + read tracking + SLA due date
  await addColumnIfMissing('transactions', 'expense_category_id', "VARCHAR(50)");
  await addColumnIfMissing('transactions', 'expense_category_name', "VARCHAR(200) DEFAULT ''");
  await addColumnIfMissing('transactions', 'is_read', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('transactions', 'read_by', "VARCHAR(100) DEFAULT ''");
  await addColumnIfMissing('transactions', 'read_at', "DATETIME");
  await addColumnIfMissing('transactions', 'due_date', "DATE");
  await addColumnIfMissing('transactions', 'transaction_scope', "ENUM('internal','external') DEFAULT 'internal'");

  // Multi-recipient table (الجهات الصادر إليها)
  await createTableIfMissing('txn_recipients', `
    CREATE TABLE txn_recipients (
      id VARCHAR(60) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      recipient_type VARCHAR(30) DEFAULT 'user',
      recipient_id VARCHAR(50),
      recipient_username VARCHAR(100) DEFAULT '',
      recipient_code VARCHAR(30) DEFAULT '',
      recipient_name VARCHAR(300) DEFAULT '',
      needs_response BOOLEAN DEFAULT FALSE,
      response_received BOOLEAN DEFAULT FALSE,
      response_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_txn (transaction_id)
    ) ENGINE=InnoDB
  `);
  // V4.6 — Per-recipient sub-status columns moved here (was mis-ordered
  // above the table's own creation — see the comment near the old location).
  // Must run AFTER the CREATE TABLE immediately above.
  await addColumnIfMissing('txn_recipients', 'sub_status', "ENUM('pending','viewed','replied','approved','rejected') DEFAULT 'pending'");
  await addColumnIfMissing('txn_recipients', 'viewed_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('txn_recipients', 'acted_at', "DATETIME DEFAULT NULL");
  await addColumnIfMissing('txn_recipients', 'acted_action', "VARCHAR(40) DEFAULT NULL");

  // Transaction number column widened to fit BR-DEP-TYP-YYYYMMDD-NNNN format
  // (legacy schemas had VARCHAR(20) which truncates the v2 structured number).
  try { await db.query("ALTER TABLE transactions MODIFY COLUMN transaction_number VARCHAR(80)"); } catch(e) {}

  // GL entries — accounting dimensions per spec (brand/branch/warehouse/cost_center on every line)
  await addColumnIfMissing('gl_entries', 'brand_id', "VARCHAR(50)");
  await addColumnIfMissing('gl_entries', 'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('gl_entries', 'warehouse_id', "VARCHAR(50)");
  try { await db.query('CREATE INDEX idx_gle_dims ON gl_entries(brand_id, branch_id)'); } catch(e) {}

  // v5.12.7 — optional base64 product image stored on the menu row
  await addColumnIfMissing('menu', 'image_data', 'LONGTEXT NULL');

  // v5.13.0 — Allow standalone (custom) items in a price list with no
  // menu reference. item_id becomes nullable so a row can carry just
  // a name + price; new item_name / item_category columns hold the
  // standalone label for those rows. The original UNIQUE key on
  // (price_list_id, item_id) keeps menu-linked overrides unique while
  // permitting many NULL item_id rows (per ANSI SQL NULL semantics).
  try { await db.query('ALTER TABLE price_list_items MODIFY COLUMN item_id VARCHAR(50) NULL'); } catch(e) {}
  await addColumnIfMissing('price_list_items', 'item_name', 'VARCHAR(200) NULL');
  await addColumnIfMissing('price_list_items', 'item_category', 'VARCHAR(100) NULL');

  // v5.12.2 — channel as first-class dimension on transactions
  await addColumnIfMissing('sales',       'channel_id',   'VARCHAR(50)');
  await addColumnIfMissing('sales_items', 'channel_id',   'VARCHAR(50)');
  try { await db.query('CREATE INDEX idx_sales_channel ON sales(channel_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_sales_items_channel ON sales_items(channel_id)'); } catch(e) {}

  // ─── v5.11.4 — Customer linkage on sales + payment notes + customer gender ───
  // Wires the POS customer-capture flow (phone + name + gender) to each sale,
  // and lets the new "Other" payment method carry a free-text note. Both
  // additions are nullable so historical sales remain valid.
  await addColumnIfMissing('sales',     'customer_id',   'VARCHAR(50) NULL');
  await addColumnIfMissing('sales',     'payment_notes', 'TEXT NULL');
  await addColumnIfMissing('customers', 'gender',
    "ENUM('male','female','unknown') NOT NULL DEFAULT 'unknown'");
  try { await db.query('CREATE INDEX idx_sales_customer  ON sales(customer_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_customers_phone ON customers(phone)');   } catch(e) {}

  // ─── v6.0.1 Wave A.3 — UNIQUE constraint on gl_journals.journal_number ───
  // Closes the SELECT-then-INSERT race that could produce duplicate
  // JV-YYYYMMDD-NNNN numbers under concurrent checkouts.
  // v8 SAFETY (G3) — was `catch(e) {}`: on a DB with pre-existing duplicate
  // journal numbers the key silently never built, while the numbering code
  // above kept believing the race net existed. Tolerate only "already exists";
  // shout about anything else (do not crash boot — the sale path must stay up).
  try {
    await db.query('ALTER TABLE gl_journals ADD UNIQUE KEY uq_journal_number (journal_number)');
  } catch (e) {
    if (!e || e.code !== 'ER_DUP_KEYNAME') {
      console.error('[schema] FAILED to create gl_journals.uq_journal_number —', (e && (e.code || e.message)));
    }
  }

  // ─── gl_journals (reference_type, reference_id) — a scan on EVERY sale ───
  // `reference_id` had no index at all, yet the checkout looks its own journal
  // up by reference on every single sale: services/order-to-cash/InvoiceService.js
  // does `SELECT id FROM gl_journals WHERE reference_type='Sale' AND reference_id=?`
  // inside `linkPosSale`, which runs in the sale's own transaction. So a full
  // table scan of a monotonically growing ledger sat on the hot path, getting
  // slower with every journal ever posted. routes/sales.js's void/return path
  // (:2605) and the journals list filter (routes/erp.js:2226) hit the same
  // predicate. Not unique — a reference legitimately maps to several journals
  // (an invoice posts its revenue and COGS legs as two).
  await addIndexIfMissing('gl_journals', 'ix_glj_ref', 'reference_type, reference_id');

  // ─── v6.4.3 — De-duplicate menu items + UNIQUE (brand_id, name) ───
  // Older deployments accumulated duplicate menu rows when the same item
  // was imported twice (each import generates a fresh Date.now() id, so
  // the existing "INSERT … ON DUPLICATE KEY" was useless without a unique
  // key on the natural identity (brand_id, name)). The owner reported the
  // POS grid showing every product twice. Fix in two steps:
  //   1. One-time dedupe: keep the oldest id per (brand_id, name), drop
  //      the rest. inv_movements + sales_items keep the kept id so no
  //      historical data is lost.
  //   2. Add UNIQUE KEY (brand_id, name) so future imports collide and
  //      hit the ON DUPLICATE KEY UPDATE path instead of inserting a copy.
  try {
    await db.query(`
      DELETE m FROM menu m
      INNER JOIN menu m2
        ON COALESCE(m.brand_id,'') = COALESCE(m2.brand_id,'')
       AND m.name = m2.name
       AND m.id > m2.id
    `);
  } catch (e) { /* table may not exist on a fresh boot — ignore */ }
  try {
    await db.query('ALTER TABLE menu ADD UNIQUE KEY uq_menu_brand_name (brand_id, name)');
  } catch (e) {
    // v8 SAFETY (G3) — only "already there" is fine; anything else (e.g. the
    // dedupe above failed and duplicates remain) means imports can double
    // items again, so it must be visible in the boot log.
    if (!e || e.code !== 'ER_DUP_KEYNAME') {
      console.error('[schema] FAILED to create menu.uq_menu_brand_name —', (e && (e.code || e.message)));
    }
  }

  // ─── v6.4.4 — Silence orphan menu items that have a branded twin ───
  // The owner reported the cashier seeing 215 items when the admin
  // counted only 114. The earlier v6.4.3 dedupe handled SAME-brand
  // duplicates but didn't touch the cross-brand case: rows with
  // `brand_id IS NULL` (or '') that share a name with a branded row.
  // The cashier's previous menu query ("OR brand_id IS NULL") returned
  // BOTH, doubling the count. The query is now smarter (v6.4.4 patch
  // in routes/auth.js), but we ALSO mark such orphans active=0 here so
  // they vanish from every other consumer (reports, admin grids, etc.)
  // without losing the historical row.
  try {
    await db.query(`
      UPDATE menu m
      INNER JOIN menu m2
        ON m2.name = m.name
       AND m2.brand_id IS NOT NULL
       AND m2.brand_id <> ''
       AND m2.active = 1
      SET m.active = 0
      WHERE m.active = 1
        AND (m.brand_id IS NULL OR m.brand_id = '')
    `);
  } catch (e) { /* tolerant of partial schemas — non-fatal */ }

  // ─── v6.4.2 — Reversing-entry linkage on gl_journals ───
  // Posted journals are immutable (SOCPA/IFRS); the only way to correct
  // them is to issue a new journal with debits + credits swapped. These
  // four columns hold the two-way link between original ↔ reversal so
  // the UI can hide the Reverse action on already-reversed journals.
  await addColumnIfMissing('gl_journals', 'reversed_by_journal_id', 'VARCHAR(50) NULL');
  await addColumnIfMissing('gl_journals', 'reverses_journal_id',    'VARCHAR(50) NULL');
  await addColumnIfMissing('gl_journals', 'reversed_at',            'DATETIME NULL');
  await addColumnIfMissing('gl_journals', 'reversed_by',            'VARCHAR(100) NULL');
  try { await db.query('CREATE INDEX idx_gl_reversed_by ON gl_journals(reversed_by_journal_id)'); } catch(e) {}
  try { await db.query('CREATE INDEX idx_gl_reverses    ON gl_journals(reverses_journal_id)');    } catch(e) {}

  // ─── v6.0.2 Wave B.3 — VAT category breakdown (S/Z/E/O) ───
  // ZATCA requires per-category tax subtotals in the UBL XML. Each menu
  // item now carries its own tax_category; the sale persists a JSON
  // breakdown of net/vat per category for VAT-return reporting.
  await addColumnIfMissing('menu',  'tax_category',       "ENUM('S','Z','E','O') NOT NULL DEFAULT 'S'");
  await addColumnIfMissing('sales', 'tax_subtotals_json', 'LONGTEXT NULL');

  // ─── v7.2 — Checkout idempotency key (client_order_id) ───
  // The POS now generates a stable clientOrderId per checkout attempt and
  // sends it on every (re)try of the same sale. A UNIQUE index makes a
  // double-POST safe: the second insert hits ER_DUP_ENTRY and the handler
  // returns the original sale's success response instead of duplicating
  // the invoice, GL journal, and stock deductions.
  await addColumnIfMissing('sales', 'client_order_id', 'VARCHAR(80) NULL');
  // Partial-unique semantics: many NULL rows are allowed (legacy sales +
  // any sale where the POS omitted the key) per ANSI NULL handling, but
  // two non-NULL identical keys collide. Tolerate re-runs (key exists).
  //
  // This used to be `catch(e){}` — swallowing EVERY failure. That is unsafe:
  // the index IS the race net behind checkout idempotency. If it silently
  // fails to build (e.g. pre-existing duplicate keys), the pre-check in
  // routes/sales.js still returns "idempotent" for sequential replays while
  // two CONCURRENT posts of the same clientOrderId both insert — duplicating
  // the invoice, its GL journal and the stock relief, with nothing logged.
  // Tolerate only "already exists"; verify, and shout about anything else.
  try {
    await db.query('ALTER TABLE sales ADD UNIQUE KEY uq_sales_client_order_id (client_order_id)');
  } catch (e) {
    if (!e || e.code !== 'ER_DUP_KEYNAME') {
      console.error('[schema] FAILED to create uq_sales_client_order_id —', (e && (e.code || e.message)));
    }
  }
  try {
    const [idx] = await db.query("SHOW INDEX FROM sales WHERE Key_name = 'uq_sales_client_order_id'");
    if (!idx.length) {
      console.error(
        '[schema] *** CHECKOUT IDEMPOTENCY IS NOT ENFORCED *** unique index ' +
        'uq_sales_client_order_id is absent from `sales`. Concurrent retries of the same ' +
        'offline sale CAN double-post. Resolve duplicate client_order_id rows, then restart.'
      );
    }
  } catch (_) { /* SHOW INDEX unsupported — non-fatal */ }

  // ─── v7.3 — Cash tendered → change due (world-class cashier UX) ───
  // The POS now records how much cash the customer handed over and the
  // change given back. Stored for the receipt, the drawer reconciliation at
  // shift close, and the audit trail. NULL on card/split/legacy sales.
  await addColumnIfMissing('sales', 'cash_tendered', 'DECIMAL(12,2) NULL');
  await addColumnIfMissing('sales', 'change_due',    'DECIMAL(12,2) NULL');

  // ─── v6.20.0 — Per-product tax-inclusive flag ───
  // Owner wants to enter NEW products with their NET price (no VAT)
  // and have the system add VAT on top, displaying a whole-SAR total
  // to the customer.  Default 1 = legacy rows stay tax-inclusive
  // (preserves pre-v6.20.0 behavior so old invoices reprint correctly).
  // Mirrors db/migrations/0011_tax_inclusive.sql.
  await addColumnIfMissing('menu', 'is_tax_inclusive', "BOOLEAN NOT NULL DEFAULT 1");
  // Seed the matching settings keys (idempotent).  VATRate may already
  // exist at 15 from baseline; INSERT IGNORE keeps the existing value.
  try {
    await db.query(
      "INSERT IGNORE INTO settings (setting_key, setting_value) VALUES " +
      "('VATRate', '15'), " +
      "('SalesTaxName', 'ضريبة القيمة المضافة 15%'), " +
      "('NewProductsTaxInclusive', '0')"
    );
  } catch (e) {
    console.log('[DB] Tax settings seed warning:', e.message.substring(0, 120));
  }

  // ─── v7.1 — ZATCA tax category column on menu (S/Z/E/O) ───
  await addColumnIfMissing('menu', 'tax_category', "ENUM('S','Z','E','O') DEFAULT 'S'");

  // ─── v7.1 — unified document numbering (doc_counters) + per-op numbers ───
  try {
    await db.query(
      "CREATE TABLE IF NOT EXISTS doc_counters (" +
      "  counter_key VARCHAR(80) NOT NULL PRIMARY KEY," +
      "  last_serial INT NOT NULL DEFAULT 0," +
      "  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" +
      ") ENGINE=InnoDB"
    );
  } catch (e) { console.log('[DB] doc_counters create warning:', e.message.substring(0, 120)); }
  await addColumnIfMissing('waste_entries', 'waste_number', "VARCHAR(40)");
  // v4 — waste deducts stock AND posts to the GL, but its id was random, so a
  // retried or double-clicked POST created two entries and deducted stock twice.
  // The UNIQUE index is what makes it safe under concurrency: the loser of a race
  // gets ER_DUP_ENTRY and returns the winner's entry instead of double-writing.
  await addColumnIfMissing('waste_entries', 'idempotency_key', 'VARCHAR(80) NULL');
  try {
    const [idx] = await db.query(
      "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'waste_entries' AND INDEX_NAME = 'uq_waste_idem'");
    if (!Number(idx[0].c)) {
      await db.query('ALTER TABLE waste_entries ADD UNIQUE KEY uq_waste_idem (idempotency_key)');
      console.log('[DB] Migration: waste_entries.uq_waste_idem unique index added');
    }
  } catch (e) {
    // v8 SAFETY (G3) — this index is what makes waste POST idempotent under
    // concurrency; a quiet console.log buried the failure. Shout, don't crash.
    console.error('[schema] FAILED to create waste_entries.uq_waste_idem —', (e && (e.code || e.message)));
  }
  await addColumnIfMissing('stock_adjustments', 'adjustment_number', "VARCHAR(40)");

  // ─── v7.1 — One-time: treat ALL existing menu prices as NET (exclusive) ───
  // Owner confirmed every current price is net-of-tax; the cashier must add
  // 15% and show the inclusive amount. Legacy rows defaulted to inclusive
  // (is_tax_inclusive=1) so the net price was shown as-is. This flips them
  // ONCE (guarded by a settings flag) so per-item edits afterwards stick.
  try {
    const [done] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'MenuTaxNetMigration_v71' LIMIT 1");
    if (!done.length) {
      const [r] = await db.query("UPDATE menu SET is_tax_inclusive = 0");
      await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('MenuTaxNetMigration_v71','1') ON DUPLICATE KEY UPDATE setting_value = '1'");
      console.log('[DB] v7.1 menu-tax-net migration: flipped ' + (r.affectedRows || 0) + ' items to net (cashier now shows +15%).');
    }
  } catch (e) {
    console.log('[DB] menu-tax-net migration warning:', e.message.substring(0, 120));
  }

  // ─── v6.0.2 Wave B.6 — UNIQUE constraint on customers.phone ───
  // First deduplicate (keep the oldest row per phone), then enforce
  // UNIQUE so the upsert-by-phone flow can never produce siblings.
  try {
    await db.query(`
      DELETE c1 FROM customers c1
      INNER JOIN customers c2
      WHERE c1.phone = c2.phone
        AND c1.phone IS NOT NULL AND c1.phone <> ''
        AND c1.created_at > c2.created_at
    `);
  } catch(e) {}
  // v8 SAFETY (G3) — was `catch(e) {}`: if the dedupe above failed (or new
  // duplicates appeared between boots) the key never built and the
  // upsert-by-phone flow silently produced sibling customers again.
  try {
    await db.query('ALTER TABLE customers ADD UNIQUE KEY uq_customers_phone (phone)');
  } catch (e) {
    if (!e || e.code !== 'ER_DUP_KEYNAME') {
      console.error('[schema] FAILED to create customers.uq_customers_phone —', (e && (e.code || e.message)));
    }
  }

  // ─── v6.0.3 Wave C.3 — Inventory cost history table ───
  // Every change to inv_items.cost (purchase receipt, stocktake variance,
  // manual edit) writes a row here so we can audit cost movements and
  // restate COGS retroactively when needed.
  await createTableIfMissing('inventory_cost_history', `
    CREATE TABLE inventory_cost_history (
      id VARCHAR(50) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL,
      cost_before DECIMAL(14,4),
      cost_after  DECIMAL(14,4),
      reason ENUM('purchase','stocktake','manual','migration','sale','transfer','waste') NOT NULL,
      reference_id VARCHAR(50),
      changed_by VARCHAR(100),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ich_item (item_id, changed_at),
      INDEX idx_ich_reason (reason)
    ) ENGINE=InnoDB`);

  // ─── v6.0.3 Wave C.4 — Split payment as structured JSON ───
  // Replaces the brittle "method:amt/method:amt" string with a JSON
  // column. The old payment_method string stays as "Split" for
  // backward-compat with reports; the breakdown lives here.
  await addColumnIfMissing('sales', 'split_details_json', 'LONGTEXT NULL');

  // ─── v6.1.0 Wave E.7 — ZATCA Phase 2 onboarding + submission ───
  // CSID credentials live on the companies row (encrypted at rest using
  // lib/encryption.js). The submission queue tracks every sale + credit
  // note that needs to be sent to ZATCA.
  await addColumnIfMissing('companies', 'zatca_csid_request_id',         'VARCHAR(100) NULL');
  await addColumnIfMissing('companies', 'zatca_binary_token_encrypted',  'TEXT NULL');
  await addColumnIfMissing('companies', 'zatca_secret_encrypted',        'TEXT NULL');
  await addColumnIfMissing('companies', 'zatca_private_key_encrypted',   'LONGTEXT NULL');
  await addColumnIfMissing('companies', 'zatca_csid_status',
    "ENUM('none','compliance','production','revoked') NOT NULL DEFAULT 'none'");
  await addColumnIfMissing('companies', 'zatca_csid_obtained_at',        'DATETIME NULL');
  await addColumnIfMissing('sales',     'zatca_xml_signed',              'LONGTEXT NULL');
  await addColumnIfMissing('sales',     'zatca_response_json',           'LONGTEXT NULL');
  await addColumnIfMissing('credit_notes', 'zatca_xml_signed',           'LONGTEXT NULL');
  await addColumnIfMissing('credit_notes', 'zatca_response_json',        'LONGTEXT NULL');
  await createTableIfMissing('zatca_submission_queue', `
    CREATE TABLE zatca_submission_queue (
      id VARCHAR(50) PRIMARY KEY,
      doc_type ENUM('sale','credit_note') NOT NULL,
      doc_id VARCHAR(50) NOT NULL,
      attempt_count INT NOT NULL DEFAULT 0,
      next_attempt_at DATETIME NOT NULL,
      status ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
      last_error TEXT NULL,
      zatca_response_json LONGTEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_zq_status (status, next_attempt_at),
      INDEX idx_zq_doc (doc_type, doc_id)
    ) ENGINE=InnoDB`);

  // ─── v6.2.0 Wave F.3 — Accounting periods (lock-after-close) ───
  await createTableIfMissing('accounting_periods', `
    CREATE TABLE accounting_periods (
      id VARCHAR(50) PRIMARY KEY,
      period_label VARCHAR(20) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status ENUM('open','soft_close','closed','locked') NOT NULL DEFAULT 'open',
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      closed_by VARCHAR(100),
      closed_at DATETIME,
      closing_notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_period (period_label, brand_id, branch_id),
      INDEX idx_period_status (status, start_date, end_date)
    ) ENGINE=InnoDB`);

  // ─── v6.2.0 Wave F.4 — Audit log hash chain ───
  await addColumnIfMissing('audit_log', 'prev_hash',   'VARCHAR(100) NULL');
  await addColumnIfMissing('audit_log', 'record_hash', 'VARCHAR(100) NULL');

  // ─── v6.3.0 — Per-employee weekly off days override ───
  // Org-wide default lives in settings.weekly_off_default (CSV like '5,6');
  // NULL here means "use the org default". A non-null CSV (e.g. '2,3' for
  // Tue+Wed) lets HR give an individual employee a custom rest pattern.
  await addColumnIfMissing('hr_employees', 'weekly_off_days', 'VARCHAR(20) NULL');

  // ─── v6.0.4 Wave D — Real ZATCA-compliant Credit Notes ───
  // A Credit Note (Type 381) is a NEW invoice document in ZATCA — own
  // UUID, own hash, own QR, links back to the original via
  // original_invoice_uuid + original_invoice_hash. Previously the
  // system flagged the original sale row as `zatca_type='credit_note'`
  // which is mechanically incorrect (it mutates an immutable doc).
  await createTableIfMissing('credit_notes', `
    CREATE TABLE credit_notes (
      id VARCHAR(50) PRIMARY KEY,
      original_sale_id VARCHAR(50) NOT NULL,
      original_invoice_uuid VARCHAR(36),
      original_invoice_hash VARCHAR(100),
      -- Credit note's own ZATCA identity
      invoice_uuid VARCHAR(36),
      invoice_hash VARCHAR(100),
      previous_invoice_hash VARCHAR(100),
      zatca_type ENUM('credit_note','debit_note') NOT NULL DEFAULT 'credit_note',
      zatca_status ENUM('pending','submitted','accepted','rejected') DEFAULT 'pending',
      zatca_submitted_at DATETIME NULL,
      zatca_qr_base64 TEXT NULL,
      -- Body
      issue_date DATE NOT NULL,
      issue_time VARCHAR(10),
      total_final DECIMAL(12,2) NOT NULL DEFAULT 0,
      net_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
      vat_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
      tax_subtotals_json LONGTEXT NULL,
      reason VARCHAR(200),
      reason_code VARCHAR(40),
      items_json LONGTEXT,
      customer_id VARCHAR(50),
      brand_id    VARCHAR(50),
      branch_id   VARCHAR(50),
      username    VARCHAR(100),
      shift_id    VARCHAR(50),
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cn_original (original_sale_id),
      INDEX idx_cn_status   (zatca_status),
      INDEX idx_cn_issue_date (issue_date)
    ) ENGINE=InnoDB`);
  await addColumnIfMissing('sales', 'has_credit_note', 'BOOLEAN NOT NULL DEFAULT 0');

  // ─── v4 — Immutable receipt identity (seller block snapshot) ───
  // A tax document must not change after issue. Every company/VAT/CR/logo value
  // on a receipt used to be resolved LIVE at reprint, so editing the tax number
  // silently reprinted EVERY historical invoice with the new one and rebuilt its
  // ZATCA QR from it. Sales now pin the identity they were issued under.
  //
  // Content-addressed on purpose: the logo is a base64 data-URL (tens of KB), so
  // copying the block onto every sale row would cost ~50KB × every invoice. The
  // id is the hash of the identity's canonical JSON, so identical identity =>
  // one shared row, and changing the logo mints a new row while existing sales
  // keep pointing at the old one. Storage is O(distinct identities), not O(sales).
  await createTableIfMissing('receipt_identities', `
    CREATE TABLE receipt_identities (
      id CHAR(40) PRIMARY KEY,
      payload_json LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
  // NULL for every invoice issued before this migration — the reprint path falls
  // back to a live resolve for those, so old receipts keep printing unchanged.
  await addColumnIfMissing('sales', 'receipt_identity_id', 'CHAR(40) NULL');
  // v6.15 — persist the stamped Phase-1 TLV payload. The checkout response was
  // the ONLY place the QR ever existed: nothing stored it, so a reprint had to
  // re-derive it client-side — which is why the legacy receipt template pulls a
  // QR library from a CDN and fails offline, in a POS built around offline.
  await addColumnIfMissing('sales', 'zatca_qr_base64', 'TEXT NULL');

  // ─── v5.11.6 — Per-attendance-event device tracking ───
  // Each clock-in / clock-out remembers the brand + model + OS + UA of
  // the phone or tablet that recorded it. Owner needs this to verify
  // that the right person on the right device punched in. Clock-out
  // gets its own *_out variants because an employee may legitimately
  // clock out from a different device than they clocked in with.
  await addColumnIfMissing('hr_attendance', 'device_brand',     'VARCHAR(80) NULL');
  await addColumnIfMissing('hr_attendance', 'device_model',     'VARCHAR(120) NULL');
  await addColumnIfMissing('hr_attendance', 'device_os',        'VARCHAR(80) NULL');
  await addColumnIfMissing('hr_attendance', 'device_ua',        'VARCHAR(500) NULL');
  await addColumnIfMissing('hr_attendance', 'device_brand_out', 'VARCHAR(80) NULL');
  await addColumnIfMissing('hr_attendance', 'device_model_out', 'VARCHAR(120) NULL');
  await addColumnIfMissing('hr_attendance', 'device_os_out',    'VARCHAR(80) NULL');
  await addColumnIfMissing('hr_attendance', 'device_ua_out',    'VARCHAR(500) NULL');

  // v5.12.2 — parsed device info on shifts + audit_log
  await addColumnIfMissing('shifts',    'device_brand', 'VARCHAR(50)');
  await addColumnIfMissing('shifts',    'device_model', 'VARCHAR(120)');
  await addColumnIfMissing('shifts',    'device_os',    'VARCHAR(80)');
  await addColumnIfMissing('audit_log', 'device_brand', 'VARCHAR(50)');
  await addColumnIfMissing('audit_log', 'device_model', 'VARCHAR(120)');
  await addColumnIfMissing('audit_log', 'device_os',    'VARCHAR(80)');

  // v5.11.14 — One-time relocation of legacy auto-created accounts whose
  // parent_id points to the WRONG branch in the v5.11.8 IFRS template.
  // Earlier versions of CORE_ACCOUNTS (lib/glPosting.js) and
  // /gl/sync-inventory put inventory accounts under code 112 (which is
  // "الذمم المدينة" / AR in the new chart) and AR under 113 (Inventory) —
  // exactly the swap the user reported as "ذمم تطبيقات تحت المخزون".
  // Idempotent: only relocates rows whose parent is currently wrong.
  try {
    const [r112] = await db.query("SELECT id FROM gl_accounts WHERE code = '112' LIMIT 1");
    const [r113] = await db.query("SELECT id FROM gl_accounts WHERE code = '113' LIMIT 1");
    const [r116] = await db.query("SELECT id FROM gl_accounts WHERE code = '116' LIMIT 1");
    if (r112.length && r113.length && r116.length) {
      const id112 = r112[0].id, id113 = r113[0].id, id116 = r116[0].id;
      // Inventory legacy codes (1200/1210/1220/1230) → parent 113 (Inventory)
      const [u1] = await db.query(
        "UPDATE gl_accounts SET parent_id = ?, level = 4 " +
        "WHERE code IN ('1200','1210','1220','1230') AND (parent_id != ? OR parent_id IS NULL)",
        [id113, id113]
      );
      if (u1.affectedRows) console.log('[v5.11.14] Moved', u1.affectedRows, 'legacy inventory rows to parent 113');
      // AR legacy code (1150) → parent 112 (AR)
      const [u2] = await db.query(
        "UPDATE gl_accounts SET parent_id = ?, level = 4 WHERE code = '1150' AND (parent_id != ? OR parent_id IS NULL)",
        [id112, id112]
      );
      if (u2.affectedRows) console.log('[v5.11.14] Moved', u2.affectedRows, 'legacy AR rows to parent 112');
      // Input VAT legacy code (1290) → parent 116 (Input VAT)
      const [u3] = await db.query(
        "UPDATE gl_accounts SET parent_id = ?, level = 4 WHERE code = '1290' AND (parent_id != ? OR parent_id IS NULL)",
        [id116, id116]
      );
      if (u3.affectedRows) console.log('[v5.11.14] Moved', u3.affectedRows, 'legacy input-VAT rows to parent 116');
      // Auto-created inventory categories from /gl/sync-inventory: rows
      // named "مخزون %" with codes like 11201, 11202... that should be
      // under 113. Re-code them to 113NN AND reparent them.
      const [stuck] = await db.query(
        "SELECT id, code, name_ar FROM gl_accounts " +
        "WHERE name_ar LIKE 'مخزون %' AND code REGEXP '^112[0-9]+$' AND parent_id != ?",
        [id113]
      );
      for (const row of stuck) {
        const [last] = await db.query(
          "SELECT code FROM gl_accounts WHERE code REGEXP '^113[0-9]{2}$' ORDER BY code DESC LIMIT 1"
        );
        let n = 0;
        if (last.length) n = parseInt(String(last[0].code).slice(3), 10) || 0;
        const newCode = '113' + String(n + 1).padStart(2, '0');
        try {
          await db.query(
            "UPDATE gl_accounts SET code = ?, parent_id = ?, level = 4 WHERE id = ?",
            [newCode, id113, row.id]
          );
          console.log('[v5.11.14] Relocated "' + row.name_ar + '" from ' + row.code + ' → ' + newCode);
        } catch(e) { /* code collision: leave as-is, won't break anything */ }
      }
    }
  } catch (e) { console.log('[v5.11.14] Legacy CoA relocation skipped:', e.message.substring(0, 120)); }

  // V5.7.18 — One-time backfill: gl_entries.account_name was being saved
  //   as empty string by glPosting.js (now fixed). For all existing rows
  //   with an empty account_name, copy the gl_accounts.name_ar via JOIN.
  //   Idempotent — only updates rows that ARE empty, so reruns are no-ops.
  try {
    const [r] = await db.query(
      `UPDATE gl_entries e
         JOIN gl_accounts ga ON ga.id = e.account_id
          SET e.account_name = COALESCE(NULLIF(ga.name_ar,''), NULLIF(ga.name_en,''), e.account_code)
        WHERE e.account_name IS NULL OR e.account_name = ''`);
    if (r && r.affectedRows) console.log('[V5.7.18] Backfilled', r.affectedRows, 'gl_entries.account_name rows');
  } catch (e) { /* table may not exist yet on fresh installs — ignore */ }

  // Workflow step routing flags — role-based employee resolution rules
  await addColumnIfMissing('workflow_definitions', 'require_same_branch', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('workflow_definitions', 'require_same_department', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('workflow_definitions', 'assignment_strategy', "VARCHAR(20) DEFAULT 'least_busy'");
  await addColumnIfMissing('workflow_definitions', 'can_approve', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('workflow_definitions', 'can_reject', "BOOLEAN DEFAULT TRUE");
  await addColumnIfMissing('workflow_definitions', 'can_edit', "BOOLEAN DEFAULT FALSE");

  // Position-indexed workflow path — the primary routing source.
  // Each initiator position has its OWN isolated chain (no mixing between
  // positions). When an employee creates a transaction, we look up their
  // position_id here and use that chain; the transaction type is just a
  // label (does not affect routing).
  await createTableIfMissing('position_workflow_steps', `
    CREATE TABLE position_workflow_steps (
      id VARCHAR(60) PRIMARY KEY,
      initiator_position_id VARCHAR(50) NOT NULL,
      step_order INT NOT NULL,
      step_name VARCHAR(200) DEFAULT '',
      required_position_id VARCHAR(50),
      is_final_step BOOLEAN DEFAULT FALSE,
      can_approve BOOLEAN DEFAULT TRUE,
      can_reject BOOLEAN DEFAULT TRUE,
      can_return_to_previous BOOLEAN DEFAULT TRUE,
      can_edit BOOLEAN DEFAULT FALSE,
      can_edit_amount BOOLEAN DEFAULT FALSE,
      require_same_branch BOOLEAN DEFAULT TRUE,
      require_same_department BOOLEAN DEFAULT FALSE,
      assignment_strategy VARCHAR(20) DEFAULT 'least_busy',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_initiator (initiator_position_id, step_order)
    ) ENGINE=InnoDB
  `);

  // Daily counter per (branch, dept, type, date) — strict serial generation
  await createTableIfMissing('txn_daily_counter', `
    CREATE TABLE txn_daily_counter (
      counter_key VARCHAR(80) PRIMARY KEY,
      last_serial INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Multi-attachment table (complements single-attachment column)
  await createTableIfMissing('txn_attachments', `
    CREATE TABLE txn_attachments (
      id VARCHAR(60) PRIMARY KEY,
      transaction_id VARCHAR(50) NOT NULL,
      log_id VARCHAR(60),
      file_name VARCHAR(300),
      mime_type VARCHAR(80),
      data_url LONGTEXT,
      uploaded_by VARCHAR(100),
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_txn (transaction_id)
    ) ENGINE=InnoDB
  `);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1 — Main/Branch Warehouse Hierarchy + Stock Issues
  // ═══════════════════════════════════════════════════════════

  // Warehouses: hierarchy + main flag
  await addColumnIfMissing('warehouses', 'parent_warehouse_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('warehouses', 'is_main', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('warehouses', 'description', "VARCHAR(500)");

  // Stock Issues — central warehouse issues stock to branches/sub-warehouses
  await createTableIfMissing('stock_issues', `
    CREATE TABLE stock_issues (
      id VARCHAR(60) PRIMARY KEY,
      issue_number VARCHAR(40) NOT NULL,
      from_warehouse_id VARCHAR(50) NOT NULL,
      to_warehouse_id VARCHAR(50) NOT NULL,
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      issue_date DATE,
      status ENUM('draft','approved','issued','received','cancelled') DEFAULT 'draft',
      total_cost DECIMAL(14,4) DEFAULT 0,
      notes TEXT,
      gl_journal_id VARCHAR(60),
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      issued_by VARCHAR(100),
      received_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME,
      issued_at DATETIME,
      received_at DATETIME,
      INDEX idx_from (from_warehouse_id),
      INDEX idx_to (to_warehouse_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);
  // V5.9.7 — reversal support: extend the status enum + record who/when/why
  // and the reversing GL journal so the audit trail is complete.
  // Phase 0 (Contracts & Safety) — also add 'partially_received' so a transfer
  // can be received cumulatively across several shipments. Idempotent: MODIFY
  // to the same/superset enum is a no-op on a DB that already has it.
  try {
    await db.query(`ALTER TABLE stock_issues MODIFY COLUMN status ENUM('draft','approved','issued','partially_received','received','cancelled','reversed') DEFAULT 'draft'`);
  } catch(e) { /* enum may already include partially_received / reversed */ }
  await addColumnIfMissing('stock_issues', 'reversed_by', "VARCHAR(100)");
  await addColumnIfMissing('stock_issues', 'reversed_at', "DATETIME");
  await addColumnIfMissing('stock_issues', 'reverse_reason', "VARCHAR(500)");
  await addColumnIfMissing('stock_issues', 'reverse_gl_journal_id', "VARCHAR(60)");
  // Phase 3A — optimistic-concurrency version (bumped on every transition). The
  // legacy UI never sends a version, so the existing state-guarded UPDATE keeps
  // working; clients that DO send `expectedVersion` get a true VERSION_CONFLICT.
  await addColumnIfMissing('stock_issues', 'version', "INT NOT NULL DEFAULT 1");
  // Phase 3A — append-only audit trail; one row per lifecycle transition,
  // written inside the SAME transaction as the state change (atomic).
  await createTableIfMissing('stock_issue_events', `
    CREATE TABLE stock_issue_events (
      id VARCHAR(60) PRIMARY KEY,
      issue_id VARCHAR(60) NOT NULL,
      action VARCHAR(30) NOT NULL,
      from_status VARCHAR(30),
      to_status VARCHAR(30),
      actor VARCHAR(100),
      note VARCHAR(500),
      payload_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_issue (issue_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('stock_issue_items', `
    CREATE TABLE stock_issue_items (
      id VARCHAR(60) PRIMARY KEY,
      issue_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      qty_requested DECIMAL(14,4) DEFAULT 0,
      qty_issued DECIMAL(14,4) DEFAULT 0,
      qty_received DECIMAL(14,4) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      line_total DECIMAL(14,4) DEFAULT 0,
      notes VARCHAR(400),
      INDEX idx_issue (issue_id),
      INDEX idx_item (item_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('stock_issue_counter', `
    CREATE TABLE stock_issue_counter (
      ymd CHAR(8) NOT NULL,
      last_serial INT NOT NULL DEFAULT 0,
      PRIMARY KEY (ymd)
    ) ENGINE=InnoDB
  `);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3B — Independent inventory transactions (receipts / issues /
  // adjustments). FULLY SEPARATE from transfers (stock_issues) and from the
  // legacy delta-model adjustments (stock_adjustments) — distinct tables, a
  // distinct router (/api/inventory/v2), and distinct movement reference_types
  // (inv_receipt / inv_issue / inv_adjustment). Unified lifecycle:
  // draft → approved → posted → reversed (+ cancel before posting, delete draft).
  // All idempotent (CREATE … IF NOT EXISTS) and safe under concurrent boot.
  // posted_unit_cost freezes the line cost at posting so a reverse restores the
  // EXACT original valuation (not the drifting current WAC).
  // ═══════════════════════════════════════════════════════════
  await createTableIfMissing('inv_receipts', `
    CREATE TABLE IF NOT EXISTS inv_receipts (
      id VARCHAR(60) PRIMARY KEY,
      receipt_number VARCHAR(40) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      cost_center_id VARCHAR(50),
      receipt_date DATE,
      status ENUM('draft','approved','posted','cancelled','reversed') DEFAULT 'draft',
      source_ref VARCHAR(200),
      total_cost DECIMAL(14,4) DEFAULT 0,
      total_value DECIMAL(14,2) DEFAULT 0,
      notes TEXT,
      gl_journal_id VARCHAR(60),
      reverse_gl_journal_id VARCHAR(60),
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      posted_by VARCHAR(100),
      cancelled_by VARCHAR(100),
      reversed_by VARCHAR(100),
      cancel_reason VARCHAR(500),
      reverse_reason VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME,
      posted_at DATETIME,
      cancelled_at DATETIME,
      reversed_at DATETIME,
      UNIQUE KEY uq_receipt_number (receipt_number),
      INDEX idx_rcv_wh (warehouse_id),
      INDEX idx_rcv_status (status),
      INDEX idx_rcv_created (created_at)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('inv_receipt_items', `
    CREATE TABLE IF NOT EXISTS inv_receipt_items (
      id VARCHAR(60) PRIMARY KEY,
      receipt_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      item_name VARCHAR(200),
      unit VARCHAR(50),
      qty DECIMAL(12,2) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      line_total DECIMAL(14,2) DEFAULT 0,
      posted_unit_cost DECIMAL(14,4) DEFAULT 0,
      notes VARCHAR(400),
      INDEX idx_ri_receipt (receipt_id),
      INDEX idx_ri_item (item_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('inv_issues', `
    CREATE TABLE IF NOT EXISTS inv_issues (
      id VARCHAR(60) PRIMARY KEY,
      issue_number VARCHAR(40) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      cost_center_id VARCHAR(50),
      issue_date DATE,
      status ENUM('draft','approved','posted','cancelled','reversed') DEFAULT 'draft',
      reason VARCHAR(200),
      recipient VARCHAR(200),
      expense_account_code VARCHAR(20),
      total_cost DECIMAL(14,4) DEFAULT 0,
      total_value DECIMAL(14,2) DEFAULT 0,
      notes TEXT,
      gl_journal_id VARCHAR(60),
      reverse_gl_journal_id VARCHAR(60),
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      posted_by VARCHAR(100),
      cancelled_by VARCHAR(100),
      reversed_by VARCHAR(100),
      cancel_reason VARCHAR(500),
      reverse_reason VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME,
      posted_at DATETIME,
      cancelled_at DATETIME,
      reversed_at DATETIME,
      UNIQUE KEY uq_inv_issue_number (issue_number),
      INDEX idx_isu_wh (warehouse_id),
      INDEX idx_isu_status (status),
      INDEX idx_isu_created (created_at)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('inv_issue_items', `
    CREATE TABLE IF NOT EXISTS inv_issue_items (
      id VARCHAR(60) PRIMARY KEY,
      issue_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      item_name VARCHAR(200),
      unit VARCHAR(50),
      qty DECIMAL(12,2) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      line_total DECIMAL(14,2) DEFAULT 0,
      posted_unit_cost DECIMAL(14,4) DEFAULT 0,
      notes VARCHAR(400),
      INDEX idx_ii_issue (issue_id),
      INDEX idx_ii_item (item_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('inv_adjustments', `
    CREATE TABLE IF NOT EXISTS inv_adjustments (
      id VARCHAR(60) PRIMARY KEY,
      adjustment_number VARCHAR(40) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      cost_center_id VARCHAR(50),
      adjustment_date DATE,
      status ENUM('draft','approved','posted','cancelled','reversed') DEFAULT 'draft',
      reason VARCHAR(200),
      reference_evidence VARCHAR(500),
      total_delta_value DECIMAL(14,2) DEFAULT 0,
      total_cost DECIMAL(14,4) DEFAULT 0,
      total_value DECIMAL(14,2) DEFAULT 0,
      notes TEXT,
      gl_journal_id VARCHAR(60),
      reverse_gl_journal_id VARCHAR(60),
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(100),
      approved_by VARCHAR(100),
      posted_by VARCHAR(100),
      cancelled_by VARCHAR(100),
      reversed_by VARCHAR(100),
      cancel_reason VARCHAR(500),
      reverse_reason VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME,
      posted_at DATETIME,
      cancelled_at DATETIME,
      reversed_at DATETIME,
      UNIQUE KEY uq_adjustment_number (adjustment_number),
      INDEX idx_adv_wh (warehouse_id),
      INDEX idx_adv_status (status),
      INDEX idx_adv_created (created_at)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('inv_adjustment_items', `
    CREATE TABLE IF NOT EXISTS inv_adjustment_items (
      id VARCHAR(60) PRIMARY KEY,
      adjustment_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      item_name VARCHAR(200),
      unit VARCHAR(50),
      system_qty_snapshot DECIMAL(12,2) DEFAULT 0,
      counted_qty DECIMAL(12,2) DEFAULT 0,
      delta DECIMAL(12,2) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      delta_value DECIMAL(14,2) DEFAULT 0,
      posted_unit_cost DECIMAL(14,4) DEFAULT 0,
      notes VARCHAR(400),
      INDEX idx_ai_adj (adjustment_id),
      INDEX idx_ai_item (item_id)
    ) ENGINE=InnoDB
  `);
  // Existing-DB top-up (the create handler writes total_cost/total_value uniformly).
  await addColumnIfMissing('inv_adjustments', 'total_cost', 'DECIMAL(14,4) DEFAULT 0');
  await addColumnIfMissing('inv_adjustments', 'total_value', 'DECIMAL(14,2) DEFAULT 0');
  // Phase 3C closure — receipts now carry a mandatory reason + validated counter
  // (credit) account so STOCK_GAIN is never a silent default.
  await addColumnIfMissing('inv_receipts', 'reason', 'VARCHAR(200)');
  await addColumnIfMissing('inv_receipts', 'counter_account_code', 'VARCHAR(20)');
  // Phase W3 — link a V2 receipt back to a legacy purchase / supplier (partial
  // receiving). All nullable → standalone receipts are unaffected.
  await addColumnIfMissing('inv_receipts', 'purchase_id', 'VARCHAR(50) NULL');
  await addColumnIfMissing('inv_receipts', 'supplier_id', 'VARCHAR(50) NULL');
  try { await db.query('CREATE INDEX idx_inv_receipts_purchase ON inv_receipts (purchase_id)'); } catch (_) {}
  // Dedicated V2 partial-receive status on the legacy purchases table (does NOT
  // touch the legacy `receive_status` enum which has its own PO-approval meaning).
  try { await addColumnIfMissing('purchases', 'v2_receive_status', "ENUM('none','partial','received') NOT NULL DEFAULT 'none'"); } catch (_) {}
  // Unified append-only audit timeline for all three doc types (one row per
  // transition, written inside the SAME txn as the state change).
  await createTableIfMissing('inv_tx_events', `
    CREATE TABLE IF NOT EXISTS inv_tx_events (
      id VARCHAR(60) PRIMARY KEY,
      doc_type VARCHAR(20) NOT NULL,
      doc_id VARCHAR(60) NOT NULL,
      action VARCHAR(30) NOT NULL,
      from_status VARCHAR(30),
      to_status VARCHAR(30),
      actor VARCHAR(100),
      note VARCHAR(500),
      payload_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_evt_doc (doc_type, doc_id),
      INDEX idx_evt_created (created_at)
    ) ENGINE=InnoDB
  `);
  // Atomic per-(doc_type, day) numbering counter (RCV-/ISU-/ADV-/STK- YYYYMMDD-NNNN).
  await createTableIfMissing('inv_tx_counter', `
    CREATE TABLE IF NOT EXISTS inv_tx_counter (
      doc_type VARCHAR(20) NOT NULL,
      ymd CHAR(8) NOT NULL,
      last_serial INT NOT NULL DEFAULT 0,
      PRIMARY KEY (doc_type, ymd)
    ) ENGINE=InnoDB
  `);

  // ─── Phase W2 — negative-stock policy (settings + deficit ledger) ───────────
  // Additive, isolated. Behavior is gated at issue time by
  // NEGATIVE_STOCK_POLICY_ENABLED; with the seeded global/block row the guard is
  // behaviorally identical to today. Mirrors db/migrations/0012.
  await createTableIfMissing('negative_stock_policy', `
    CREATE TABLE IF NOT EXISTS negative_stock_policy (
      id VARCHAR(40) NOT NULL PRIMARY KEY,
      scope ENUM('global','warehouse','item') NOT NULL,
      warehouse_id VARCHAR(50) NULL,
      item_id VARCHAR(50) NULL,
      policy ENUM('block','controlled','allow') NOT NULL DEFAULT 'block',
      max_negative_qty DECIMAL(18,3) NOT NULL DEFAULT 0,
      require_reason TINYINT(1) NOT NULL DEFAULT 1,
      is_enabled TINYINT(1) NOT NULL DEFAULT 1,
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(64) NULL, updated_by VARCHAR(64) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_scope (scope, warehouse_id, item_id),
      KEY idx_warehouse (warehouse_id), KEY idx_item (item_id)
    ) ENGINE=InnoDB
  `);
  try {
    await db.query("INSERT INTO negative_stock_policy (id, scope, warehouse_id, item_id, policy, max_negative_qty, require_reason, is_enabled, created_by) " +
      "SELECT 'NSP-GLOBAL','global',NULL,NULL,'block',0,1,1,'bootstrap' FROM DUAL " +
      "WHERE NOT EXISTS (SELECT 1 FROM negative_stock_policy WHERE scope='global' AND warehouse_id IS NULL AND item_id IS NULL)");
  } catch (_) {}
  await createTableIfMissing('stock_deficits', `
    CREATE TABLE IF NOT EXISTS stock_deficits (
      id VARCHAR(40) NOT NULL PRIMARY KEY,
      warehouse_id VARCHAR(50) NOT NULL, item_id VARCHAR(50) NOT NULL,
      origin_doc_type VARCHAR(24) NOT NULL, origin_doc_id VARCHAR(50) NOT NULL,
      deficit_qty DECIMAL(18,3) NOT NULL, remaining_qty DECIMAL(18,3) NOT NULL,
      unit_cost_at_issue DECIMAL(18,4) NOT NULL DEFAULT 0,
      reason VARCHAR(400) NOT NULL,
      status ENUM('open','partial','covered','adjusted') NOT NULL DEFAULT 'open',
      created_by VARCHAR(64) NULL, approved_by VARCHAR(64) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, closed_at TIMESTAMP NULL,
      version INT NOT NULL DEFAULT 1,
      KEY idx_open (status, warehouse_id, item_id),
      KEY idx_origin (origin_doc_type, origin_doc_id)
    ) ENGINE=InnoDB
  `);

  // ─── Phase 3C — professional stocktake & reconciliation (isolated v2 tables) ───
  // The new stocktake is the single professional source going forward; it writes
  // NO stock/GL itself — at post it creates a 3B Adjustment and lets the Adjustment
  // Engine apply the variance. Legacy `stocktakes`/`stocktake_items` stay frozen.
  // counted_qty is NULLABLE: NULL = not counted yet (excluded at post, never zeroed),
  // 0 = counted and found empty. snapshot_qty/snapshot_at freeze the item list at
  // the start of counting; theoretical_qty = snapshot + net movements until counted_at.
  await createTableIfMissing('inv_stocktakes', `
    CREATE TABLE IF NOT EXISTS inv_stocktakes (
      id VARCHAR(60) PRIMARY KEY,
      stocktake_number VARCHAR(40) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      cost_center_id VARCHAR(50),
      stocktake_date DATE,
      status ENUM('draft','counting','submitted','approved','posted','cancelled') DEFAULT 'draft',
      scope_type ENUM('full','category','items') DEFAULT 'full',
      category_id VARCHAR(50),
      include_zero BOOLEAN DEFAULT FALSE,
      blind_count BOOLEAN DEFAULT FALSE,
      count_method ENUM('full','cycle','spot') DEFAULT 'full',
      variance_qty_threshold DECIMAL(12,3) DEFAULT 0,
      variance_value_threshold DECIMAL(14,2) DEFAULT 0,
      evidence_threshold DECIMAL(14,2) DEFAULT 0,
      snapshot_at DATETIME,
      snapshot_seq BIGINT DEFAULT 0,
      reason VARCHAR(200),
      reference_evidence VARCHAR(500),
      notes TEXT,
      total_lines INT DEFAULT 0,
      counted_lines INT DEFAULT 0,
      variance_lines INT DEFAULT 0,
      total_variance_value DECIMAL(14,2) DEFAULT 0,
      adjustment_id VARCHAR(60),
      adjustment_number VARCHAR(40),
      gl_journal_id VARCHAR(60),
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(100),
      submitted_by VARCHAR(100),
      submitted_at DATETIME,
      approved_by VARCHAR(100),
      approved_at DATETIME,
      recount_by VARCHAR(100),
      recount_at DATETIME,
      recount_reason VARCHAR(500),
      posted_by VARCHAR(100),
      posted_at DATETIME,
      cancelled_by VARCHAR(100),
      cancelled_at DATETIME,
      cancel_reason VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_stocktake_number (stocktake_number),
      INDEX idx_stk_wh (warehouse_id),
      INDEX idx_stk_status (status),
      INDEX idx_stk_created (created_at)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('inv_stocktake_items', `
    CREATE TABLE IF NOT EXISTS inv_stocktake_items (
      id VARCHAR(60) PRIMARY KEY,
      stocktake_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      item_name VARCHAR(200),
      unit VARCHAR(50),
      category_id VARCHAR(50),
      snapshot_qty DECIMAL(12,3) DEFAULT 0,
      counted_qty DECIMAL(12,3) NULL,
      counted_at DATETIME,
      counted_seq BIGINT DEFAULT 0,
      net_movements DECIMAL(12,3) DEFAULT 0,
      theoretical_qty DECIMAL(12,3) DEFAULT 0,
      variance DECIMAL(12,3) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      variance_value DECIMAL(14,2) DEFAULT 0,
      variance_pct DECIMAL(8,2) DEFAULT 0,
      is_flagged BOOLEAN DEFAULT FALSE,
      reason_code VARCHAR(40),
      notes VARCHAR(400),
      counted_by VARCHAR(100),
      INDEX idx_sti_stk (stocktake_id),
      INDEX idx_sti_item (item_id)
    ) ENGINE=InnoDB
  `);
  // Phase 4A (3C closure) — movement-sequence window for deterministic
  // reconciliation (existing-DB top-up; fresh DBs get them from the CREATE above).
  await addColumnIfMissing('inv_stocktakes', 'snapshot_seq', 'BIGINT DEFAULT 0');
  await addColumnIfMissing('inv_stocktake_items', 'counted_seq', 'BIGINT DEFAULT 0');

  // ─── نماذج الجرد المحفوظة — saved stocktake templates (routes/stocktake-
  // templates.js, mounted at /api/inventory/stocktake-templates) ────────────────
  // The owner's ask: a NAMED, reusable set of the materials he counts
  // periodically — create it, pick it, edit it, reuse it. Server-backed on
  // purpose: a localStorage template dies with the tablet, and he swaps tills.
  //
  // A template is ONLY a name + an ORDERED list of inv_items ids + an optional
  // warehouse scope. IT HOLDS NO QUANTITY OF ANY KIND — no counted qty, no
  // "last counted", no system qty. BLIND COUNT is a hard contract on this
  // surface (see routes/inventory-stocktakes.js's header and the blind-count
  // spec in StocktakeDialog.test.tsx), so there is deliberately no column a
  // future change could leak the previous count through.
  //
  // Scope MATCHES inv_stocktakes above (warehouse_id + brand/branch derived from
  // the warehouse row) with ONE intentional difference: warehouse_id is NULLABLE
  // = "usable from any warehouse". A count DOCUMENT must name its warehouse; a
  // reusable CHECKLIST need not, and the POS never picks one by hand (it resolves
  // one at submit time), so pinning every template would hide it on the next till.
  //
  // Additive and fully isolated — touches no existing table. createTableIfMissing
  // no-ops once the table exists, so this is safe on every boot.
  await createTableIfMissing('inv_stocktake_templates', `
    CREATE TABLE IF NOT EXISTS inv_stocktake_templates (
      id VARCHAR(60) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      warehouse_id VARCHAR(50) NULL,
      brand_id VARCHAR(50) NULL,
      branch_id VARCHAR(50) NULL,
      created_by VARCHAR(100),
      updated_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_stkt_wh (warehouse_id),
      INDEX idx_stkt_creator (created_by),
      INDEX idx_stkt_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // item_name / unit are a SNAPSHOT used only as the fallback label when the
  // inv_items row has been hard-deleted; the route prefers the LIVE name so a
  // renamed material shows its current name. UNIQUE(template_id,item_id) makes a
  // duplicated pick impossible at the storage layer, not just in the handler.
  await createTableIfMissing('inv_stocktake_template_items', `
    CREATE TABLE IF NOT EXISTS inv_stocktake_template_items (
      id VARCHAR(60) PRIMARY KEY,
      template_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      item_name VARCHAR(200),
      unit VARCHAR(50),
      sort_order INT NOT NULL DEFAULT 0,
      UNIQUE KEY uq_stkt_item (template_id, item_id),
      INDEX idx_stkti_tpl (template_id, sort_order),
      INDEX idx_stkti_item (item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ─── Phase 4A — Item Master (ADDITIVE on inv_items; never drop/rename, sales/
  // purchases/production read it) + per-warehouse replenishment rules ───────────
  // sku_norm = UPPER(TRIM(sku)) maintained by the route; UNIQUE allows multiple
  // NULLs (legacy rows have no SKU). version + audit (inv_tx_events doc_type='item').
  await addColumnIfMissing('inv_items', 'sku', "VARCHAR(100)");
  await addColumnIfMissing('inv_items', 'sku_norm', "VARCHAR(120)");
  await addColumnIfMissing('inv_items', 'version', "INT NOT NULL DEFAULT 1");
  await addColumnIfMissing('inv_items', 'default_warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('inv_items', 'description', "TEXT");
  await addColumnIfMissing('inv_items', 'notes', "VARCHAR(500)");
  try { await db.query('CREATE UNIQUE INDEX uq_inv_items_sku_norm ON inv_items (sku_norm)'); } catch (e) { /* exists or dup data */ }
  // Phase W4 — unified barcode. Primary barcode on inv_items (multiple NULLs
  // allowed by UNIQUE) + a 1:N item_barcodes table for size variants. SKU is
  // untouched. Both normalized columns are uniquely indexed for O(1) scan lookup.
  await addColumnIfMissing('inv_items', 'barcode', "VARCHAR(80)");
  await addColumnIfMissing('inv_items', 'barcode_norm', "VARCHAR(80)");
  try { await db.query('CREATE UNIQUE INDEX uq_inv_items_barcode_norm ON inv_items (barcode_norm)'); } catch (e) { /* exists or dup data */ }
  await createTableIfMissing('item_barcodes', `
    CREATE TABLE IF NOT EXISTS item_barcodes (
      id VARCHAR(40) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL,
      code VARCHAR(80) NOT NULL,
      code_norm VARCHAR(80) NOT NULL,
      size_variant VARCHAR(60) NULL,
      is_primary TINYINT(1) NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(64) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_code_norm (code_norm),
      KEY idx_item (item_id)
    ) ENGINE=InnoDB
  `);
  // Per-(warehouse, item) replenishment rules. min/reorder/max/safety/lead-time
  // are per-warehouse here (inv_items.min_stock stays the GLOBAL fallback for
  // legacy reads). The replenishment engine reads these; nothing posts stock.
  await createTableIfMissing('warehouse_item_rules', `
    CREATE TABLE IF NOT EXISTS warehouse_item_rules (
      id VARCHAR(60) PRIMARY KEY,
      warehouse_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      min_qty DECIMAL(12,3) DEFAULT 0,
      reorder_point DECIMAL(12,3) DEFAULT 0,
      reorder_qty DECIMAL(12,3) DEFAULT 0,
      max_stock DECIMAL(12,3) DEFAULT 0,
      safety_stock DECIMAL(12,3) DEFAULT 0,
      lead_time_days INT DEFAULT 0,
      is_enabled BOOLEAN DEFAULT TRUE,
      last_reviewed_at DATETIME,
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(100),
      updated_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wir_wh_item (warehouse_id, item_id),
      INDEX idx_wir_item (item_id)
    ) ENGINE=InnoDB
  `);

  // ─── Phase 4B — Lots, Expiry, FEFO & Traceability (ADDITIVE) ──────────────────
  // tracking_mode = none | lot | expiry. An item is "tracked" when mode != 'none'.
  // For tracked items the lot ledger below is the system of record and the hard
  // invariant Σ(warehouse_lot_balances.qty) = warehouse_stock.qty is enforced after
  // every transaction. `expired` is DERIVED from expiry_date, never stored.
  await addColumnIfMissing('inv_items', 'tracking_mode', "ENUM('none','lot','expiry') NOT NULL DEFAULT 'none'");
  // Master lot record — one row per (item, lot_number). lot_norm = UPPER(TRIM(lot_number)),
  // UNIQUE per item. lifecycle is a manual state machine; expiry is a date, not a status.
  await createTableIfMissing('inventory_lots', `
    CREATE TABLE IF NOT EXISTS inventory_lots (
      id VARCHAR(60) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL,
      lot_number VARCHAR(120) NOT NULL,
      lot_norm VARCHAR(140) NOT NULL,
      manufacture_date DATE NULL,
      expiry_date DATE NULL,
      lifecycle_status ENUM('active','quarantined','recalled','closed') NOT NULL DEFAULT 'active',
      source_type VARCHAR(30) NULL,
      source_id VARCHAR(100) NULL,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      notes VARCHAR(500) NULL,
      is_imported TINYINT(1) NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_lot_item_norm (item_id, lot_norm),
      INDEX idx_lot_item (item_id),
      INDEX idx_lot_expiry (expiry_date),
      INDEX idx_lot_status (lifecycle_status)
    ) ENGINE=InnoDB
  `);
  // Per-(warehouse, lot) on-hand. item_id is denormalised so the per-item invariant
  // (Σ qty WHERE warehouse_id=? AND item_id=?) is a single-table read with no join.
  await createTableIfMissing('warehouse_lot_balances', `
    CREATE TABLE IF NOT EXISTS warehouse_lot_balances (
      id VARCHAR(60) PRIMARY KEY,
      warehouse_id VARCHAR(50) NOT NULL,
      lot_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wlb_wh_lot (warehouse_id, lot_id),
      INDEX idx_wlb_wh_item (warehouse_id, item_id),
      INDEX idx_wlb_lot (lot_id)
    ) ENGINE=InnoDB
  `);
  // Lot-level ledger. Each row signs a qty (+in / -out) and links to the parent
  // inventory_movements row by seq. UNIQUE(seq, lot) prevents double-posting a lot.
  await createTableIfMissing('inventory_lot_movements', `
    CREATE TABLE IF NOT EXISTS inventory_lot_movements (
      id VARCHAR(60) PRIMARY KEY,
      inventory_movement_seq BIGINT NULL,
      movement_id VARCHAR(60) NULL,
      lot_id VARCHAR(60) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      signed_qty DECIMAL(14,3) NOT NULL,
      reference_type VARCHAR(40) NULL,
      reference_id VARCHAR(100) NULL,
      reason VARCHAR(200) NULL,
      actor VARCHAR(100) NULL,
      occurred_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ilm_seq_lot (inventory_movement_seq, lot_id),
      INDEX idx_ilm_lot (lot_id),
      INDEX idx_ilm_ref (reference_type, reference_id),
      INDEX idx_ilm_wh_item (warehouse_id, item_id)
    ) ENGINE=InnoDB
  `);
  // Per-line lot intent captured on the v2 document drafts (JSON): receipts carry
  // the received lots; issues/adjustments may carry a manual allocation (else FEFO
  // is computed at post). Parsed by routes/inventory-transactions.js at post time.
  await addColumnIfMissing('inv_receipt_items', 'lot_data', 'TEXT NULL');
  await addColumnIfMissing('inv_issue_items', 'lot_data', 'TEXT NULL');
  await addColumnIfMissing('inv_adjustment_items', 'lot_data', 'TEXT NULL');
  // Transfer lot genealogy + in-transit tracking: which source lots a transfer
  // issued, and how much of each has been received at the destination (partial-safe).
  await createTableIfMissing('lot_transfer_allocations', `
    CREATE TABLE IF NOT EXISTS lot_transfer_allocations (
      id VARCHAR(60) PRIMARY KEY,
      transfer_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      source_lot_id VARCHAR(60) NOT NULL,
      lot_number VARCHAR(120) NULL,
      expiry_date DATE NULL,
      source_warehouse_id VARCHAR(50) NOT NULL,
      dest_warehouse_id VARCHAR(50) NOT NULL,
      qty DECIMAL(14,3) NOT NULL,
      received_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_lta_transfer_lot (transfer_id, source_lot_id),
      INDEX idx_lta_transfer (transfer_id, item_id)
    ) ENGINE=InnoDB
  `);
  // Production consumption genealogy: which component lots a work order consumed.
  await createTableIfMissing('work_order_lot_consumption', `
    CREATE TABLE IF NOT EXISTS work_order_lot_consumption (
      id VARCHAR(60) PRIMARY KEY,
      work_order_id VARCHAR(60) NOT NULL,
      component_item_id VARCHAR(50) NOT NULL,
      lot_id VARCHAR(60) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      qty DECIMAL(14,3) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wolc_wo (work_order_id),
      INDEX idx_wolc_lot (lot_id)
    ) ENGINE=InnoDB
  `);
  // Lot-level stocktake counts: for a tracked item the counter enters a qty per
  // lot (or an "unknown" lot via an audited row); Σ(counted per lot)=line countedQty.
  await createTableIfMissing('inv_stocktake_lot_items', `
    CREATE TABLE IF NOT EXISTS inv_stocktake_lot_items (
      id VARCHAR(60) PRIMARY KEY,
      stocktake_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      lot_id VARCHAR(60) NULL,
      lot_number VARCHAR(120) NULL,
      expiry_date DATE NULL,
      counted_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      counted_seq BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_stli_stk_item (stocktake_id, item_id)
    ) ENGINE=InnoDB
  `);
  // Production output genealogy: links a produced finished-goods lot back to the
  // component lots that went into it (backward traceability for recall).
  await createTableIfMissing('production_output_lots', `
    CREATE TABLE IF NOT EXISTS production_output_lots (
      id VARCHAR(60) PRIMARY KEY,
      work_order_id VARCHAR(60) NOT NULL,
      output_lot_id VARCHAR(60) NOT NULL,
      component_lot_id VARCHAR(60) NULL,
      qty DECIMAL(14,3) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pol_wo (work_order_id),
      INDEX idx_pol_output (output_lot_id),
      INDEX idx_pol_component (component_lot_id)
    ) ENGINE=InnoDB
  `);

  // Phase 5A (RC) — EXPLAIN-evidenced composite index. The inventory grid's
  // last_movement subquery and the replenishment engine's out_qty/last-movement
  // subqueries all probe inventory_movements by (item_id, warehouse_id [,date]).
  // Measured on the 100k-movement perf dataset: grid sort=qty 1.93s → 0.60s,
  // replenishment 3.1s → 1.03s (0.16s per-warehouse). Build time ~0.8s (online).
  try { await db.query('CREATE INDEX idx_invmov_item_wh_date ON inventory_movements (item_id, warehouse_id, movement_date)'); } catch (e) {}

  // ═══════════════════════════════════════════════════════════
  // PHASE 2 — Production Orders
  // ═══════════════════════════════════════════════════════════

  await createTableIfMissing('production_orders', `
    CREATE TABLE production_orders (
      id VARCHAR(60) PRIMARY KEY,
      order_number VARCHAR(40) NOT NULL,
      bom_id VARCHAR(60) NOT NULL,
      product_id VARCHAR(60) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      output_warehouse_id VARCHAR(50),
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      qty_planned DECIMAL(14,4) DEFAULT 0,
      qty_produced DECIMAL(14,4) DEFAULT 0,
      qty_scrap DECIMAL(14,4) DEFAULT 0,
      status ENUM('planned','released','in_progress','completed','closed','cancelled') DEFAULT 'planned',
      materials_cost DECIMAL(14,4) DEFAULT 0,
      labor_cost DECIMAL(14,4) DEFAULT 0,
      overhead_cost DECIMAL(14,4) DEFAULT 0,
      total_cost DECIMAL(14,4) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      notes TEXT,
      gl_release_id VARCHAR(60),
      gl_complete_id VARCHAR(60),
      created_by VARCHAR(100),
      released_by VARCHAR(100),
      completed_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      planned_date DATE,
      released_at DATETIME,
      completed_at DATETIME,
      INDEX idx_bom (bom_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB
  `);
  // v7.4 (G2) — store production yield % at completion (informational/reporting).
  await addColumnIfMissing('production_orders', 'yield_pct', "DECIMAL(6,2) DEFAULT NULL");
  // v7.7 — UI redesign (production orders wizard). Additive, non-breaking columns:
  //   • cost_breakdown : descriptive JSON of the labor (workers/hours/rate) +
  //                      overhead (electricity/equipment/packaging/other) detail
  //                      entered in the create wizard / release modal. The scalar
  //                      labor_cost / overhead_cost remain the GL source of truth;
  //                      this column is purely for display on the detail page.
  //   • priority / allowed_scrap_pct / batch_number : create-time metadata so the
  //                      mockup's richer create flow round-trips. All optional.
  await addColumnIfMissing('production_orders', 'cost_breakdown',    "JSON DEFAULT NULL");
  await addColumnIfMissing('production_orders', 'priority',          "VARCHAR(20) DEFAULT 'normal'");
  await addColumnIfMissing('production_orders', 'allowed_scrap_pct', "DECIMAL(6,3) DEFAULT 0");
  await addColumnIfMissing('production_orders', 'batch_number',      "VARCHAR(80) DEFAULT NULL");
  await createTableIfMissing('production_consumption', `
    CREATE TABLE production_consumption (
      id VARCHAR(60) PRIMARY KEY,
      production_order_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      qty_planned DECIMAL(14,4) DEFAULT 0,
      qty_actual DECIMAL(14,4) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      total_cost DECIMAL(14,4) DEFAULT 0,
      lot_id VARCHAR(60),
      consumed_at DATETIME,
      INDEX idx_prod (production_order_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('production_output', `
    CREATE TABLE production_output (
      id VARCHAR(60) PRIMARY KEY,
      production_order_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      qty DECIMAL(14,4) DEFAULT 0,
      unit_cost DECIMAL(14,4) DEFAULT 0,
      total_cost DECIMAL(14,4) DEFAULT 0,
      batch_number VARCHAR(80),
      expiry_date DATE,
      produced_at DATETIME,
      INDEX idx_prod (production_order_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('production_counter', `
    CREATE TABLE production_counter (
      ymd CHAR(8) NOT NULL,
      last_serial INT NOT NULL DEFAULT 0,
      PRIMARY KEY (ymd)
    ) ENGINE=InnoDB
  `);

  // ═══════════════════════════════════════════════════════════
  // Phase P1 — Production Orders V2 (routes/inventory-production.js)
  // ═══════════════════════════════════════════════════════════
  // V2 lifecycle values are APPENDED to the ENUM (append-only → existing rows
  // keep their string values; MODIFY is a no-op when already applied). Legacy
  // writes only planned/released; V2 writes only the new set — zero overlap.
  await modifyColumnDefinition('production_orders', 'status',
    "ENUM('planned','released','in_progress','completed','closed','cancelled','draft','approved','reversed') DEFAULT 'planned'");
  // source separates V2 documents from legacy ones (belt-and-braces on top of
  // the disjoint status sets); every V2 conditional UPDATE adds AND source='v2'.
  await addColumnIfMissing('production_orders', 'source', "VARCHAR(10) NOT NULL DEFAULT 'legacy'");
  await addColumnIfMissing('production_orders', 'version', 'INT NOT NULL DEFAULT 1');
  await addColumnIfMissing('production_orders', 'approved_by', 'VARCHAR(100) NULL');
  await addColumnIfMissing('production_orders', 'approved_at', 'DATETIME NULL');
  // qty_waste = Σ output-event waste (qty_scrap kept in sync for legacy reports).
  await addColumnIfMissing('production_orders', 'qty_waste', 'DECIMAL(14,4) DEFAULT 0');
  // wip_balance = running WIP residual (Σ issues − Σ output relief); close flushes it.
  await addColumnIfMissing('production_orders', 'wip_balance', 'DECIMAL(14,4) DEFAULT 0');
  await addColumnIfMissing('production_orders', 'closed_by', 'VARCHAR(100) NULL');
  await addColumnIfMissing('production_orders', 'closed_at', 'DATETIME NULL');
  await addColumnIfMissing('production_orders', 'close_variance', 'DECIMAL(14,4) DEFAULT 0');
  await addColumnIfMissing('production_orders', 'gl_close_id', 'VARCHAR(60) NULL');
  await addColumnIfMissing('production_orders', 'cancelled_by', 'VARCHAR(100) NULL');
  await addColumnIfMissing('production_orders', 'cancelled_at', 'DATETIME NULL');
  await addColumnIfMissing('production_orders', 'cancel_reason', 'VARCHAR(500) NULL');
  await addColumnIfMissing('production_orders', 'reversed_by', 'VARCHAR(100) NULL');
  await addColumnIfMissing('production_orders', 'reversed_at', 'DATETIME NULL');
  await addColumnIfMissing('production_orders', 'reverse_reason', 'VARCHAR(500) NULL');
  // One reversing journal per original journal → array of ids.
  await addColumnIfMissing('production_orders', 'reverse_gl_ids', 'JSON DEFAULT NULL');

  // One row per PARTIAL materials issue. production_consumption stays the
  // per-component AGGREGATE (qty_planned/qty_actual); events carry their own
  // frozen costs + GL journal and are the lot-ledger reference scope
  // (inventory_lot_movements reference_type='prod_issue', reference_id=event id)
  // so each event reverses exactly.
  await createTableIfMissing('production_issue_events', `
    CREATE TABLE production_issue_events (
      id VARCHAR(60) PRIMARY KEY,
      production_order_id VARCHAR(60) NOT NULL,
      event_no INT NOT NULL,
      materials_cost DECIMAL(14,4) DEFAULT 0,
      labor_cost DECIMAL(14,4) DEFAULT 0,
      overhead_cost DECIMAL(14,4) DEFAULT 0,
      gl_journal_id VARCHAR(60) NULL,
      issued_by VARCHAR(100) NULL,
      issued_at DATETIME NULL,
      notes VARCHAR(500) NULL,
      INDEX idx_pie_po (production_order_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('production_issue_lines', `
    CREATE TABLE production_issue_lines (
      id VARCHAR(60) PRIMARY KEY,
      issue_event_id VARCHAR(60) NOT NULL,
      production_order_id VARCHAR(60) NOT NULL,
      item_id VARCHAR(50) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      qty DECIMAL(14,4) NOT NULL,
      unit_cost DECIMAL(14,4) NOT NULL,
      line_total DECIMAL(14,4) NOT NULL,
      INDEX idx_pil_event (issue_event_id),
      INDEX idx_pil_po (production_order_id, item_id)
    ) ENGINE=InnoDB
  `);
  // production_output already supports multiple rows per order; V2 extends each
  // row into a full OUTPUT EVENT (good + waste + its own journal).
  await addColumnIfMissing('production_output', 'qty_waste', 'DECIMAL(14,4) DEFAULT 0');
  await addColumnIfMissing('production_output', 'waste_cost', 'DECIMAL(14,4) DEFAULT 0');
  await addColumnIfMissing('production_output', 'gl_journal_id', 'VARCHAR(60) NULL');
  await addColumnIfMissing('production_output', 'created_by', 'VARCHAR(100) NULL');

  // ═══════════════════════════════════════════════════════════
  // Cashier V2 (routes/pos-v2.js) — CART LIFECYCLE ONLY.
  // The financial write (sale + ZATCA + GL + stock) stays the legacy
  // POST /api/sales; pos_orders.id is the clientOrderId that makes the
  // checkout replay-safe. Idempotent CREATEs — never touch legacy tables.
  // ═══════════════════════════════════════════════════════════
  await createTableIfMissing('pos_orders', `
    CREATE TABLE pos_orders (
      id VARCHAR(40) PRIMARY KEY,
      status ENUM('open','held','submitted','completed','voided') NOT NULL DEFAULT 'open',
      order_type ENUM('dine_in','takeaway','delivery') NOT NULL DEFAULT 'takeaway',
      table_no VARCHAR(20) NULL,
      shift_id VARCHAR(40) NULL,
      username VARCHAR(100) NULL,
      device_id VARCHAR(60) NULL,
      warehouse_id VARCHAR(50) NULL,
      channel_id VARCHAR(50) NULL,
      channel_name VARCHAR(100) NULL,
      customer_id VARCHAR(50) NULL,
      discount_type ENUM('PERCENT','FIXED') NULL,
      discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
      discount_name VARCHAR(100) NULL,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
      line_discount_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      vat_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      note VARCHAR(300) NULL,
      sale_id VARCHAR(50) NULL,
      invoice_number VARCHAR(40) NULL,
      origin ENUM('online','offline') NOT NULL DEFAULT 'online',
      version INT NOT NULL DEFAULT 1,
      held_at DATETIME NULL,
      submitted_at DATETIME NULL,
      completed_at DATETIME NULL,
      voided_at DATETIME NULL,
      void_reason VARCHAR(300) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_pos_shift_status (shift_id, status),
      INDEX idx_pos_status (status),
      INDEX idx_pos_sale (sale_id)
    ) ENGINE=InnoDB
  `);
  // pos_orders.branch_id + its index moved here (was mis-ordered above the
  // table's own creation — see the Tier A.2 Section 6 comment near the old
  // location). Must run AFTER the CREATE TABLE immediately above.
  await addColumnIfMissing('pos_orders', 'branch_id', "VARCHAR(50) NULL");
  try { await db.query('CREATE INDEX idx_pos_orders_branch ON pos_orders(branch_id)'); } catch (e) {}
  await createTableIfMissing('pos_order_lines', `
    CREATE TABLE pos_order_lines (
      id VARCHAR(50) PRIMARY KEY,
      order_id VARCHAR(40) NOT NULL,
      menu_id VARCHAR(50) NOT NULL,
      name_snapshot VARCHAR(200) NOT NULL,
      qty DECIMAL(10,3) NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      line_discount DECIMAL(10,2) NOT NULL DEFAULT 0,
      vat_category CHAR(1) NOT NULL DEFAULT 'S',
      notes VARCHAR(300) NULL,
      sort INT NOT NULL DEFAULT 0,
      INDEX idx_pol_order (order_id)
    ) ENGINE=InnoDB
  `);
  await createTableIfMissing('pos_payments', `
    CREATE TABLE pos_payments (
      id VARCHAR(50) PRIMARY KEY,
      order_id VARCHAR(40) NOT NULL,
      method VARCHAR(20) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      ref VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pp_order (order_id)
    ) ENGINE=InnoDB
  `);

  // ── Phase U — per-line frozen UoM snapshot columns (runs AFTER all v2 line
  // tables above exist). NULL-safe: legacy rows keep NULL and behave as base. ──
  for (const t of ['inv_receipt_items', 'inv_issue_items', 'inv_adjustment_items', 'inv_stocktake_items', 'production_issue_lines', 'production_output', 'stock_issue_items']) {
    await addColumnIfMissing(t, 'entered_qty', 'DECIMAL(18,6) NULL');
    await addColumnIfMissing(t, 'entered_unit_id', 'VARCHAR(50) NULL');
    await addColumnIfMissing(t, 'entered_unit_code', 'VARCHAR(30) NULL');
    await addColumnIfMissing(t, 'conversion_factor_snapshot', 'DECIMAL(18,6) NULL');
    await addColumnIfMissing(t, 'base_qty', 'DECIMAL(18,6) NULL');
  }
  await addColumnIfMissing('pos_order_lines', 'entered_unit_id', 'VARCHAR(50) NULL');
  await addColumnIfMissing('pos_order_lines', 'entered_unit_code', 'VARCHAR(30) NULL');
  await addColumnIfMissing('pos_order_lines', 'conversion_factor_snapshot', 'DECIMAL(18,6) NULL DEFAULT 1');
  await addColumnIfMissing('pos_order_lines', 'entered_qty', 'DECIMAL(18,6) NULL');

  // ═══════════════════════════════════════════════════════════
  // PHASE 3 — Real Cost Accounting: FIFO / WAC / Batch / Expiry
  // ═══════════════════════════════════════════════════════════

  // Purchase lots: add batch/expiry tracking
  await addColumnIfMissing('purchase_lots', 'batch_number', "VARCHAR(80)");
  await addColumnIfMissing('purchase_lots', 'expiry_date', "DATE NULL");
  await addColumnIfMissing('purchase_lots', 'warehouse_id', "VARCHAR(50)");
  await addColumnIfMissing('purchase_lots', 'received_at', "DATETIME NULL");

  // Cost history — every cost change is recorded
  await createTableIfMissing('item_cost_history', `
    CREATE TABLE item_cost_history (
      id VARCHAR(60) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL,
      warehouse_id VARCHAR(50),
      method VARCHAR(20) DEFAULT 'WAC',
      old_cost DECIMAL(14,4) DEFAULT 0,
      new_cost DECIMAL(14,4) DEFAULT 0,
      old_qty DECIMAL(14,4) DEFAULT 0,
      new_qty DECIMAL(14,4) DEFAULT 0,
      trigger_type VARCHAR(40),
      reference_id VARCHAR(60),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      changed_by VARCHAR(100),
      INDEX idx_item (item_id),
      INDEX idx_date (changed_at)
    ) ENGINE=InnoDB
  `);

  // Warehouse stock: add average cost per warehouse
  await addColumnIfMissing('warehouse_stock', 'avg_cost', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('warehouse_stock', 'last_cost', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('warehouse_stock', 'last_updated', "TIMESTAMP NULL");

  // v5.10.6 — per-warehouse history. `added_at` is when the item was
  // first registered in this warehouse (auto). `first_added_date` is
  // the user-settable historical date — for opening-balance entries
  // backdated to the actual stock-take date so reports show the right
  // running balance.
  await addColumnIfMissing('warehouse_stock', 'added_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing('warehouse_stock', 'first_added_date', "DATE NULL");
  await addColumnIfMissing('warehouse_stock', 'added_by', "VARCHAR(80)");

  // v7.1 — the `bom` table never defined `product_source`, yet routes/menu.js
  // INSERTs/UPDATEs it on every recipe-BOM save → "Unknown column" error that
  // broke creating a menu item's BOM. Add it (idempotent) so the endpoint works.
  await addColumnIfMissing('bom', 'product_source', "VARCHAR(20) DEFAULT 'menu'");

  // v5.10.7 — Self-heal ghost warehouse_stock rows that the old auto-
  // backfill polluted (qty=0, no first_added_date, no movement log).
  // The user reported "159 outside / 2 inside" — this was 157 ghost
  // rows from the legacy backfill. Idempotent + safe: only targets
  // rows we can prove the system created on its own.
  try {
    const invRouter = require('./routes/inventory');
    if (invRouter && typeof invRouter._cleanupGhostWarehouseStock === 'function') {
      const r = await invRouter._cleanupGhostWarehouseStock(db);
      if (r && r.ok) {
        console.log(`[migrate] cleanup-ghost-warehouse-stock: ok (scanned ${r.scanned}, removed ${r.removed})`);
      } else if (r && r.reason) {
        console.log(`[migrate] cleanup-ghost-warehouse-stock: skipped (${r.reason})`);
      }
    }
  } catch(e) { console.warn('[migrate] cleanup-ghost-warehouse-stock: error', e.message); }

  // ═══════════════════════════════════════════════════════════
  // PHASE C — PAYMENT FLOW
  // Unified payment records + amount-based approval routing
  // ═══════════════════════════════════════════════════════════

  await createTableIfMissing('payment_records', `
    CREATE TABLE payment_records (
      id VARCHAR(60) PRIMARY KEY,
      payment_number VARCHAR(40) NOT NULL,
      transaction_id VARCHAR(50),
      reference_type VARCHAR(40),
      reference_id VARCHAR(60),
      direction ENUM('out','in') DEFAULT 'out',
      amount DECIMAL(14,4) NOT NULL DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'SAR',
      payment_method ENUM('cash','bank','cheque','wire','card') DEFAULT 'bank',
      bank_account_id VARCHAR(50),
      cash_box_id VARCHAR(50),
      expense_account_code VARCHAR(20),
      counter_account_code VARCHAR(20),
      receipt_attachment LONGTEXT,
      receipt_number VARCHAR(80),
      receipt_date DATE,
      status ENUM('requested','authorized','paid','closed','cancelled') DEFAULT 'requested',
      gl_journal_id VARCHAR(60),
      brand_id VARCHAR(50),
      branch_id VARCHAR(50),
      cost_center_id VARCHAR(50),
      requested_by VARCHAR(100),
      authorized_by VARCHAR(100),
      paid_by VARCHAR(100),
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      authorized_at DATETIME,
      paid_at DATETIME,
      closed_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_txn (transaction_id),
      INDEX idx_status (status),
      INDEX idx_ref (reference_type, reference_id)
    ) ENGINE=InnoDB
  `);

  await createTableIfMissing('payment_counter', `
    CREATE TABLE payment_counter (
      ymd CHAR(8) NOT NULL,
      last_serial INT NOT NULL DEFAULT 0,
      PRIMARY KEY (ymd)
    ) ENGINE=InnoDB
  `);

  // Position workflow steps: amount-based routing
  await addColumnIfMissing('position_workflow_steps', 'amount_from', "DECIMAL(14,4) DEFAULT 0");
  await addColumnIfMissing('position_workflow_steps', 'amount_to',   "DECIMAL(14,4) DEFAULT NULL");
  // Multi-path support — each initiator position can have several
  // alternate workflow paths labeled by path_key + path_name.
  // 'default' = the primary path (backward compatible).
  await addColumnIfMissing('position_workflow_steps', 'path_key',   "VARCHAR(50) DEFAULT 'default'");
  await addColumnIfMissing('position_workflow_steps', 'path_name',  "VARCHAR(200) DEFAULT 'المسار الأساسي'");
  await addColumnIfMissing('position_workflow_steps', 'description',"TEXT");
  // Transactions: link to payment record (for payment-bearing flows)
  await addColumnIfMissing('transactions', 'payment_record_id', "VARCHAR(60)");
  await addColumnIfMissing('transactions', 'requires_payment', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('transactions', 'reference_type', "VARCHAR(40)");
  await addColumnIfMissing('transactions', 'reference_id', "VARCHAR(60)");

  // ═══ Brand-awareness for procurement + shortage ═══
  await addColumnIfMissing('suppliers',          'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('purchases',          'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('purchases',          'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('purchase_orders',    'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('purchase_orders',    'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('shortage_requests',  'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('shortage_requests',  'branch_id', "VARCHAR(50)");
  await addColumnIfMissing('expenses',           'brand_id',  "VARCHAR(50)");
  await addColumnIfMissing('expenses',           'branch_id', "VARCHAR(50)");

  // Notifications (Phase D preparation)
  await createTableIfMissing('notifications', `
    CREATE TABLE notifications (
      id VARCHAR(60) PRIMARY KEY,
      user_username VARCHAR(100) NOT NULL,
      type VARCHAR(40),
      title VARCHAR(300),
      body TEXT,
      link_type VARCHAR(40),
      link_id VARCHAR(60),
      is_read BOOLEAN DEFAULT FALSE,
      icon VARCHAR(40),
      icon_color VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME,
      INDEX idx_user (user_username),
      INDEX idx_unread (user_username, is_read)
    ) ENGINE=InnoDB
  `);

  // Seed default branch code if empty
  try {
    await db.query("UPDATE branches SET code = UPPER(SUBSTRING(IFNULL(name,'BR'),1,3)) WHERE code IS NULL OR code = ''");
  } catch(e) {}
  try {
    await db.query("UPDATE hr_departments SET code = UPPER(SUBSTRING(IFNULL(name,'DEP'),1,3)) WHERE code IS NULL OR code = ''");
  } catch(e) {}
  try {
    await db.query("UPDATE transaction_types SET code = UPPER(SUBSTRING(IFNULL(name,'TXN'),1,3)) WHERE code IS NULL OR code = ''");
  } catch(e) {}

  // ═══════════════════════════════════════════════════════════
  // TRANSACTION GL TEMPLATES — reusable debit/credit templates
  // One template = one type of journal (e.g. "expense_out" = Dr expense / Cr bank).
  // Referenced from transaction_types.gl_template_code so that when a
  // transaction of that type gets paid/closed, the engine knows HOW to post.
  // ═══════════════════════════════════════════════════════════
  await createTableIfMissing('transaction_gl_templates', `
    CREATE TABLE transaction_gl_templates (
      code VARCHAR(40) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      description VARCHAR(400),
      debit_account_hint VARCHAR(20),
      credit_account_hint VARCHAR(20),
      posts_on ENUM('approval','payment','receipt','stocktake','manual') DEFAULT 'payment',
      example_memo VARCHAR(300),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // ═══════════════════════════════════════════════════════════
  // APPROVAL CHAIN DEFAULTS — per transaction type + amount threshold
  // Populated so new workflows have sensible defaults without manual setup.
  // ═══════════════════════════════════════════════════════════
  await createTableIfMissing('txn_type_default_chain', `
    CREATE TABLE txn_type_default_chain (
      id VARCHAR(60) PRIMARY KEY,
      transaction_type_code VARCHAR(40) NOT NULL,
      step_order INT NOT NULL,
      role_required VARCHAR(100),
      amount_from DECIMAL(14,4) DEFAULT 0,
      amount_to DECIMAL(14,4) DEFAULT NULL,
      is_final_step BOOLEAN DEFAULT FALSE,
      INDEX idx_code (transaction_type_code, step_order)
    ) ENGINE=InnoDB
  `);

  // Extend transaction_types with category + payment flag + GL template
  await addColumnIfMissing('transaction_types', 'category',
    "ENUM('financial','administrative','procurement','operational','hr') DEFAULT 'administrative'");
  await addColumnIfMissing('transaction_types', 'requires_payment', "BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing('transaction_types', 'gl_template_code', "VARCHAR(40)");
  await addColumnIfMissing('transaction_types', 'icon', "VARCHAR(40) DEFAULT 'fa-file-alt'");
  await addColumnIfMissing('transaction_types', 'icon_color', "VARCHAR(20) DEFAULT 'info'");
  await addColumnIfMissing('transaction_types', 'description', "VARCHAR(400)");
  await addColumnIfMissing('transaction_types', 'sort_order', "INT DEFAULT 100");

  // ═══ COMPLETE TAXONOMY — 44 standard transaction types ═══
  // Categories: financial / administrative / procurement / operational / hr
  //
  // Format: [code, name_ar, category, requires_payment, gl_template, icon, icon_color, sort_order, description]
  try {
    const types = [
      // ── FINANCIAL (10) ──
      ['EXP',          'طلب صرف مصروف عام',     'financial',     1, 'expense_out',  'fa-receipt',           'warning', 110, 'مصروفات تشغيلية: كهرباء، ماء، اتصالات، قرطاسية'],
      ['PAY',          'طلب سداد مورد',          'financial',     1, 'ap_payment',   'fa-money-bill-transfer','warning', 120, 'دفع فاتورة مورد معتمدة (AP)'],
      ['REC',          'تسجيل تحصيل عميل',       'financial',     0, 'ar_receipt',   'fa-hand-holding-dollar','success', 130, 'استلام دفعة من عميل (AR)'],
      ['REF',          'طلب استرداد مبلغ',       'financial',     1, 'refund',       'fa-rotate-left',       'danger',  140, 'إرجاع مبلغ لعميل (فواتير مرتجعة)'],
      ['TRF-BANK',     'تحويل بين حسابات بنكية', 'financial',     1, 'bank_transfer','fa-right-left',        'info',    150, 'نقل رصيد بين حسابات بنكية'],
      ['TRF-CASH',     'تحويل بين صناديق نقدية', 'financial',     1, 'cash_transfer','fa-cash-register',     'info',    160, 'نقل نقد بين الفروع/الصناديق'],
      ['CUSTODY-ADD',  'تغذية عهدة',             'financial',     1, 'custody_load', 'fa-wallet',            'purple',  170, 'إضافة مبلغ لعهدة موظف'],
      ['CUSTODY-STL',  'تسوية عهدة',             'financial',     0, 'custody_stl',  'fa-scale-balanced',    'purple',  180, 'تقديم إيصالات العهدة وتسويتها'],
      ['WRITE-OFF',    'شطب ديون/أصول',          'financial',     0, 'write_off',    'fa-ban',               'danger',  190, 'شطب دين معدوم أو أصل تالف'],
      ['ADJ-JRN',      'قيد تسوية يدوي',         'financial',     0, 'manual_jrn',   'fa-pen-to-square',     'neutral', 199, 'قيد محاسبي مخصص باعتماد رسمي'],
      // ── ADMINISTRATIVE (8) ──
      ['MEMO',         'مذكرة داخلية',            'administrative', 0, null,           'fa-envelope',          'info',    210, 'تعميم أو إخطار بين الأقسام'],
      ['DECISION',     'قرار إداري',              'administrative', 0, null,           'fa-gavel',             'warning', 220, 'قرار رسمي (تعديل سياسة، إجراءات جديدة)'],
      ['LETTER',       'خطاب رسمي',               'administrative', 0, null,           'fa-envelope-open-text','info',    230, 'مراسلة خارجية (جهات حكومية، شركاء)'],
      ['CONTRACT',     'عقد جديد/تجديد',          'administrative', 0, null,           'fa-file-contract',     'purple',  240, 'عقد مع مورد أو عميل'],
      ['POLICY',       'سياسة داخلية',            'administrative', 0, null,           'fa-book',              'neutral', 250, 'وثيقة سياسة (خصم، إرجاع، عمل)'],
      ['AUDIT',        'تقرير مراجعة',            'administrative', 0, null,           'fa-magnifying-glass-chart','info',260, 'تقرير تدقيق داخلي'],
      ['COMPLAINT',    'شكوى',                    'administrative', 0, null,           'fa-triangle-exclamation','warning',270, 'شكوى من عميل أو موظف'],
      ['APPROVAL',     'طلب موافقة عامة',         'administrative', 0, null,           'fa-check-circle',      'info',    280, 'أي موافقة إدارية غير مصنفة'],
      // ── PROCUREMENT (6) ──
      ['PUR',          'طلب شراء (PR)',           'procurement',   0, null,           'fa-cart-plus',         'info',    310, 'طلب من القسم لشراء مادة — يحوَّل لـ PO'],
      ['PO',           'أمر شراء (Purchase Order)','procurement',  1, 'po',           'fa-cart-shopping',     'warning', 320, 'أمر رسمي للمورد'],
      ['GRN',          'استلام بضاعة (GRN)',      'procurement',   0, 'grn',          'fa-truck-ramp-box',    'success', 330, 'استلام فعلي من المورد'],
      ['RTV',          'إرجاع للمورد',            'procurement',   0, 'rtv',          'fa-truck-fast',        'danger',  340, 'إرجاع بضاعة تالفة للمورد'],
      ['PRICE-NEG',    'تفاوض سعر',               'procurement',   0, null,           'fa-handshake',         'neutral', 350, 'طلب مراجعة سعر مع مورد'],
      ['SUP-REG',      'تسجيل مورد جديد',         'procurement',   0, null,           'fa-user-plus',         'success', 360, 'إضافة مورد للقائمة المعتمدة'],
      // ── OPERATIONAL (9) ──
      ['SALE',         'فاتورة بيع (POS)',        'operational',   0, 'sale',         'fa-cash-register',     'success', 410, 'بيع منتج عبر الكاشير'],
      ['STK-ISS',      'إذن صرف مخزني',           'operational',   0, 'stock_issue',  'fa-truck-arrow-right', 'warning', 420, 'صرف مواد من المستودع الرئيسي للفرع'],
      ['STK-TRF',      'تحويل بين مستودعات',      'operational',   0, 'stock_trf',    'fa-shuffle',           'info',    430, 'نقل بين مخزنين'],
      ['STK-ADJ',      'تسوية جرد',               'operational',   0, 'stocktake',    'fa-clipboard-check',   'warning', 440, 'فروقات الجرد الفعلي vs النظام'],
      ['WASTE',        'تسجيل هدر',               'operational',   0, 'waste',        'fa-dumpster',          'danger',  450, 'تلف، انسكاب، انتهاء صلاحية'],
      ['PROD-ORD',     'أمر إنتاج',               'operational',   0, 'prod_release', 'fa-industry',          'purple',  460, 'تصنيع من مواد خام'],
      ['PROD-CMP',     'إكمال إنتاج',             'operational',   0, 'prod_complete','fa-flag-checkered',    'success', 470, 'تحويل WIP لمنتج تام'],
      ['MNT',          'طلب صيانة',               'operational',   1, 'expense_out',  'fa-screwdriver-wrench','warning', 480, 'صيانة معدات/أجهزة'],
      ['AST',          'طلب أصل ثابت',            'operational',   1, 'fixed_asset',  'fa-building',          'purple',  490, 'شراء معدة/أثاث/أجهزة'],
      // ── HR (11) ──
      ['HIR',          'طلب توظيف',               'hr',            0, null,           'fa-user-plus',         'success', 510, 'طلب توظيف موظف جديد'],
      ['LEV',          'طلب إجازة',               'hr',            0, null,           'fa-umbrella-beach',    'info',    520, 'سنوية/مرضية/اضطرارية'],
      ['ADV',          'طلب سلفة',                'hr',            1, 'employee_adv', 'fa-sack-dollar',       'warning', 530, 'سلفة موظف على الراتب'],
      ['LOAN',         'قرض موظف',                'hr',            1, 'employee_loan','fa-hand-holding-dollar','warning',540, 'قرض طويل الأجل من الشركة'],
      ['OVT',          'طلب ساعات إضافية',        'hr',            0, null,           'fa-clock',             'info',    550, 'احتساب overtime'],
      ['TRF-EMP',      'طلب نقل موظف',            'hr',            0, null,           'fa-person-walking-arrow-right','info',560,'نقل بين الفروع/الأقسام'],
      ['PROMO',        'طلب ترقية',               'hr',            0, null,           'fa-arrow-up-right-dots','success',570, 'ترقية موظف'],
      ['TERM',         'طلب إنهاء خدمة',          'hr',            1, 'end_of_service','fa-user-slash',       'danger',  580, 'فصل/استقالة'],
      ['WARN',         'إنذار تأديبي',            'hr',            0, null,           'fa-triangle-exclamation','danger',590, 'إنذار تأديبي'],
      ['PAYROLL',      'تشغيل الرواتب',           'hr',            1, 'payroll',      'fa-money-check-dollar','warning', 599, 'دفعة رواتب شهرية'],
      ['EOS',          'مكافأة نهاية خدمة',       'hr',            1, 'eos',          'fa-handshake-angle',   'purple',  598, 'حساب مكافأة رحيل']
    ];

    // Step 1: dedupe existing — merge duplicates keeping the first one
    try {
      // Map legacy/duplicate codes to canonical ones (keep data, delete duplicates)
      const aliasMap = {
        'PURCHASE_REQUEST': 'PUR',
        'ASSET_REQUEST':    'AST',
        'maintenance':      'MNT',
        'ceo':              'DECISION',
        'hr':               'HIR'
      };
      for (const [oldCode, newCode] of Object.entries(aliasMap)) {
        const [exists] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [newCode]);
        if (!exists.length) continue;
        const [dup] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [oldCode]);
        if (!dup.length) continue;
        // Re-point any transactions using the old code to the new code
        try {
          await db.query(
            'UPDATE transactions SET transaction_type_id = ? WHERE transaction_type_id = ?',
            [exists[0].id, dup[0].id]);
          await db.query(
            'UPDATE workflow_definitions SET transaction_type_id = ? WHERE transaction_type_id = ?',
            [exists[0].id, dup[0].id]);
        } catch(e) {}
        await db.query('DELETE FROM transaction_types WHERE id = ?', [dup[0].id]);
      }
    } catch(e) { console.warn('[txn_types dedupe]', e.message); }

    // Step 1b: FINAL cleanup — remove any aliased rows that didn't get
    // merged in the first pass (because the canonical code didn't exist
    // at the time of dedupe). Now that the seeds are about to run, we
    // also handle the reverse case: delete the old row regardless of
    // whether the canonical has been inserted yet (it will be inserted
    // in step 2 below).
    try {
      const legacyToRemove = ['TRF', 'ceo', 'hr', 'maintenance', 'PURCHASE_REQUEST', 'ASSET_REQUEST'];
      for (const legacyCode of legacyToRemove) {
        const [row] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [legacyCode]);
        if (!row.length) continue;
        // Re-point any workflow links to the canonical first
        const canonMap = { TRF: 'TRF-EMP', ceo: 'DECISION', hr: 'HIR', maintenance: 'MNT', PURCHASE_REQUEST: 'PUR', ASSET_REQUEST: 'AST' };
        const canonCode = canonMap[legacyCode];
        const [canonRow] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [canonCode]);
        if (canonRow.length) {
          try {
            await db.query('UPDATE transactions SET transaction_type_id = ? WHERE transaction_type_id = ?', [canonRow[0].id, row[0].id]);
            await db.query('UPDATE workflow_definitions SET transaction_type_id = ? WHERE transaction_type_id = ?', [canonRow[0].id, row[0].id]);
          } catch(e) {}
        }
        try { await db.query('DELETE FROM transaction_types WHERE id = ?', [row[0].id]); } catch(e) {}
      }
    } catch(e) { console.warn('[txn_types final dedupe]', e.message); }

    // Step 2: insert or update each canonical type
    for (const [code, name, category, requires_payment, gl_template, icon, iconColor, sortOrder, desc] of types) {
      const id = 'TT-' + code;
      const [existing] = await db.query('SELECT id FROM transaction_types WHERE code = ? LIMIT 1', [code]);
      if (existing.length) {
        // Update meta (keep existing id)
        try {
          await db.query(
            `UPDATE transaction_types SET name=?, category=?, requires_payment=?, gl_template_code=?,
             icon=?, icon_color=?, sort_order=?, description=? WHERE code = ?`,
            [name, category, requires_payment ? 1 : 0, gl_template, icon, iconColor, sortOrder, desc, code]);
        } catch(e) {}
      } else {
        try {
          await db.query(
            `INSERT INTO transaction_types
             (id, code, name, category, requires_payment, gl_template_code, icon, icon_color, sort_order, description)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [id, code, name, category, requires_payment ? 1 : 0, gl_template, icon, iconColor, sortOrder, desc]);
        } catch(e) {}
      }
    }
  } catch(e) { console.warn('[txn_types seed]', e.message); }

  // ═══ GL TEMPLATES SEED ═══
  // [code, name, description, debit_hint, credit_hint, posts_on, memo]
  try {
    const templates = [
      ['expense_out',    'مصروف مدفوع',              'Dr مصروف / Cr بنك أو نقد',                   '5100', '1120', 'payment',  'Expense payment'],
      ['ap_payment',     'سداد مورد',                'Dr ذمم موردين (AP) / Cr بنك',                '2100', '1120', 'payment',  'AP payment'],
      ['ar_receipt',     'تحصيل عميل',               'Dr بنك / Cr ذمم عملاء (AR)',                 '1120', '1150', 'receipt',  'AR receipt'],
      ['refund',         'استرداد لعميل',            'Dr إيراد مرتجع / Cr بنك',                    '4900', '1120', 'payment',  'Customer refund'],
      ['bank_transfer',  'تحويل بنكي',               'Dr بنك (الوجهة) / Cr بنك (المصدر)',          '1120', '1120', 'payment',  'Bank transfer'],
      ['cash_transfer',  'تحويل نقدي',               'Dr نقد (الوجهة) / Cr نقد (المصدر)',          '1110', '1110', 'payment',  'Cash transfer'],
      ['custody_load',   'تغذية عهدة',               'Dr ذمم عهدة / Cr بنك',                       '1290', '1120', 'payment',  'Custody load'],
      ['custody_stl',    'تسوية عهدة',               'Dr مصاريف / Cr ذمم عهدة',                    '5100', '1290', 'approval', 'Custody settlement'],
      ['write_off',      'شطب دين/أصول',             'Dr خسارة شطب / Cr AR أو أصل',                '5800', '1150', 'approval', 'Write-off'],
      ['manual_jrn',     'قيد تسوية يدوي',           'حسب القيد المُحرَّر',                         null,    null,  'manual',   'Manual adjustment'],
      ['sale',           'فاتورة بيع',               'Dr كاش / Cr إيراد + Cr VAT / Dr COGS / Cr مخزون', '1110','4100','manual', 'POS sale'],
      ['stock_issue',    'إذن صرف مخزني',            'Dr مخزون الفروع / Cr المخزون الرئيسي',       '1210', '1200', 'approval', 'Stock issue'],
      ['stock_trf',      'تحويل مخزون',              'Dr مخزن الوجهة / Cr مخزن المصدر',            '1200', '1200', 'approval', 'Stock transfer'],
      ['stocktake',      'تسوية جرد',                'Dr/Cr فروقات الجرد vs مخزون',                '5300', '1200', 'stocktake','Stocktake variance'],
      ['waste',          'قيد هدر',                  'Dr مصروف الهدر / Cr مخزون',                  '5200', '1200', 'approval', 'Waste posting'],
      ['prod_release',   'إطلاق إنتاج',              'Dr WIP / Cr مواد خام + عمالة + overhead',    '1220', '1200', 'approval', 'Production release'],
      ['prod_complete',  'إكمال إنتاج',              'Dr منتجات تامة / Cr WIP',                    '1230', '1220', 'approval', 'Production complete'],
      ['fixed_asset',    'شراء أصل ثابت',            'Dr أصول ثابتة / Cr بنك أو AP',               '1500', '2100', 'payment',  'Fixed asset purchase'],
      ['grn',            'استلام بضاعة',             'Dr مخزون + Dr VAT مدخلات / Cr AP',           '1200', '2100', 'receipt',  'Goods receipt'],
      ['rtv',            'إرجاع للمورد',             'Dr AP / Cr مخزون',                           '2100', '1200', 'approval', 'Return to vendor'],
      ['po',             'أمر شراء',                 '(لا قيد عند الإنشاء — يُرحَّل عند الاستلام)', null,   null,  'receipt',  'Purchase order'],
      ['employee_adv',   'سلفة موظف',                'Dr ذمم موظفين / Cr بنك',                     '1291', '1120', 'payment',  'Employee advance'],
      ['employee_loan',  'قرض موظف',                 'Dr قرض موظفين / Cr بنك',                     '1292', '1120', 'payment',  'Employee loan'],
      ['payroll',        'رواتب',                    'Dr مصاريف رواتب / Cr بنك + استقطاعات',       '5400', '1120', 'payment',  'Payroll run'],
      ['end_of_service', 'إنهاء خدمة',               'Dr مستحقات نهاية خدمة / Cr بنك',             '2400', '1120', 'payment',  'End of service'],
      ['eos',            'مكافأة نهاية خدمة',        'Dr مصاريف مكافآت / Cr نقد أو بنك',           '5410', '1120', 'payment',  'EOS benefit']
    ];
    for (const [code, name, desc, dr, cr, posts, memo] of templates) {
      try {
        await db.query(
          `INSERT INTO transaction_gl_templates (code, name, description, debit_account_hint, credit_account_hint, posts_on, example_memo)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description),
             debit_account_hint=VALUES(debit_account_hint), credit_account_hint=VALUES(credit_account_hint),
             posts_on=VALUES(posts_on), example_memo=VALUES(example_memo)`,
          [code, name, desc, dr, cr, posts, memo]);
      } catch(e) {}
    }
  } catch(e) { console.warn('[gl_templates seed]', e.message); }

  // ═══ DEFAULT APPROVAL CHAINS ═══
  // Amount-based tiers per transaction type.
  // Roles: المحاسب / مدير الفرع / المدير المالي / المدير العام
  try {
    const chains = [
      // code, step, role, amount_from, amount_to, isFinal
      // Expenses
      ['EXP', 1, 'accountant',       0,      5000,   false],
      ['EXP', 1, 'branch_manager',   5001,   50000,  false],
      ['EXP', 1, 'finance_manager',  50001,  500000, false],
      ['EXP', 1, 'ceo',              500001, null,   false],
      ['EXP', 2, 'finance_manager',  0,      null,   true],   // finalization
      // AP Payments
      ['PAY', 1, 'accountant',       0,      50000,  false],
      ['PAY', 1, 'finance_manager',  50001,  500000, false],
      ['PAY', 1, 'ceo',              500001, null,   false],
      ['PAY', 2, 'finance_manager',  0,      null,   true],
      // Purchase orders
      ['PO',  1, 'branch_manager',   0,      20000,  false],
      ['PO',  1, 'finance_manager',  20001,  200000, false],
      ['PO',  1, 'ceo',              200001, null,   false],
      ['PO',  2, 'finance_manager',  0,      null,   true],
      // Asset request
      ['AST', 1, 'branch_manager',   0,      10000,  false],
      ['AST', 1, 'finance_manager',  10001,  100000, false],
      ['AST', 1, 'ceo',              100001, null,   false],
      ['AST', 2, 'finance_manager',  0,      null,   true],
      // Maintenance
      ['MNT', 1, 'branch_manager',   0,      5000,   false],
      ['MNT', 1, 'finance_manager',  5001,   null,   false],
      ['MNT', 2, 'finance_manager',  0,      null,   true],
      // HR
      ['LEV', 1, 'branch_manager',   0,      null,   false],
      ['LEV', 2, 'hr_manager',       0,      null,   true],
      ['ADV', 1, 'branch_manager',   0,      null,   false],
      ['ADV', 2, 'finance_manager',  0,      null,   true],
      ['HIR', 1, 'hr_manager',       0,      null,   false],
      ['HIR', 2, 'ceo',              0,      null,   true],
      ['TERM',1, 'hr_manager',       0,      null,   false],
      ['TERM',2, 'ceo',              0,      null,   true],
      // Operational
      ['STK-ISS', 1, 'warehouse_keeper', 0, null, false],
      ['STK-ISS', 2, 'branch_manager',   0, null, true],
      ['WASTE',   1, 'branch_manager',   0, null, false],
      ['WASTE',   2, 'finance_manager',  0, null, true],
    ];
    for (const [code, step, role, af, at, isFinal] of chains) {
      const id = 'TTC-' + code + '-' + step + '-' + (af || 0);
      try {
        await db.query(
          `INSERT IGNORE INTO txn_type_default_chain
           (id, transaction_type_code, step_order, role_required, amount_from, amount_to, is_final_step)
           VALUES (?,?,?,?,?,?,?)`,
          [id, code, step, role, af, at, isFinal ? 1 : 0]);
      } catch(e) {}
    }
  } catch(e) { console.warn('[chain seed]', e.message); }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══ ENTERPRISE V5 — Real-Estate / Contracts / Work-Orders / AP-AR ═══
  // ═══════════════════════════════════════════════════════════════════════

  // 1) Properties (العقارات)
  await createTableIfMissing('properties', `
    CREATE TABLE properties (
      id VARCHAR(40) PRIMARY KEY,
      code VARCHAR(40) UNIQUE,
      name VARCHAR(200) NOT NULL,
      type ENUM('residential','commercial','mixed','land','warehouse','office') DEFAULT 'commercial',
      city VARCHAR(80),
      district VARCHAR(120),
      address VARCHAR(400),
      total_area DECIMAL(12,2),
      area_unit VARCHAR(10) DEFAULT 'm2',
      cost_center_id VARCHAR(40),
      brand_id VARCHAR(40),
      owner_party_id VARCHAR(40),
      status ENUM('active','under_maintenance','sold','inactive') DEFAULT 'active',
      acquired_at DATE,
      acquisition_cost DECIMAL(14,4) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(80),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_brand (brand_id),
      INDEX idx_status (status),
      INDEX idx_city (city)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 2) Property Units (شقق/محلات/مكاتب داخل العقار)
  await createTableIfMissing('property_units', `
    CREATE TABLE property_units (
      id VARCHAR(40) PRIMARY KEY,
      property_id VARCHAR(40) NOT NULL,
      code VARCHAR(40),
      unit_number VARCHAR(40),
      floor INT,
      type ENUM('apartment','shop','office','warehouse','parking','other') DEFAULT 'apartment',
      area DECIMAL(10,2),
      bedrooms INT DEFAULT 0,
      bathrooms INT DEFAULT 0,
      monthly_rent DECIMAL(12,4),
      currency VARCHAR(8) DEFAULT 'SAR',
      status ENUM('vacant','occupied','reserved','maintenance','unavailable') DEFAULT 'vacant',
      current_contract_id VARCHAR(40),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_property (property_id),
      INDEX idx_status (status),
      INDEX idx_contract (current_contract_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 3) Contracts (عقود إيجار / خدمة / توريد / عمل)
  await createTableIfMissing('contracts', `
    CREATE TABLE contracts (
      id VARCHAR(40) PRIMARY KEY,
      code VARCHAR(40) UNIQUE,
      type ENUM('lease','service','supply','employment','franchise','partnership','other') DEFAULT 'lease',
      direction ENUM('outgoing','incoming') DEFAULT 'outgoing',
      party_type ENUM('customer','vendor','employee','partner') DEFAULT 'customer',
      party_id VARCHAR(40),
      party_name VARCHAR(200),
      property_id VARCHAR(40),
      property_unit_id VARCHAR(40),
      brand_id VARCHAR(40),
      cost_center_id VARCHAR(40),
      title VARCHAR(300) NOT NULL,
      description TEXT,
      start_date DATE NOT NULL,
      end_date DATE,
      auto_renew BOOLEAN DEFAULT FALSE,
      renewal_period_months INT DEFAULT 12,
      total_value DECIMAL(14,4) DEFAULT 0,
      currency VARCHAR(8) DEFAULT 'SAR',
      payment_frequency ENUM('one_time','monthly','quarterly','semi_annual','annual') DEFAULT 'monthly',
      payment_amount DECIMAL(14,4),
      next_invoice_date DATE,
      vat_included BOOLEAN DEFAULT TRUE,
      status ENUM('draft','pending_approval','active','suspended','expired','terminated','renewed') DEFAULT 'draft',
      attachments LONGTEXT,
      terms TEXT,
      transaction_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(80),
      activated_at DATETIME,
      activated_by VARCHAR(80),
      terminated_at DATETIME,
      terminated_by VARCHAR(80),
      termination_reason TEXT,
      INDEX idx_party (party_type, party_id),
      INDEX idx_property (property_id, property_unit_id),
      INDEX idx_status (status),
      INDEX idx_next_inv (next_invoice_date),
      INDEX idx_brand (brand_id),
      INDEX idx_dates (start_date, end_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 4) was contract_invoice_schedules — recurring B2B billing, retired with the
  //    contracts ROUTE. The `contracts` table above stays: routes/properties.js
  //    still reads it for lease/unit linkage.

  // 5) Assets (الأصول الثابتة — معدات/مركبات/أجهزة للصيانة)
  await createTableIfMissing('assets', `
    CREATE TABLE assets (
      id VARCHAR(40) PRIMARY KEY,
      code VARCHAR(40) UNIQUE,
      name VARCHAR(200) NOT NULL,
      category ENUM('equipment','vehicle','furniture','it','machinery','building','other') DEFAULT 'equipment',
      brand_id VARCHAR(40),
      branch_id VARCHAR(40),
      property_id VARCHAR(40),
      cost_center_id VARCHAR(40),
      serial_number VARCHAR(120),
      manufacturer VARCHAR(120),
      model VARCHAR(120),
      purchase_date DATE,
      purchase_cost DECIMAL(14,4),
      depreciation_method ENUM('straight_line','declining','none') DEFAULT 'straight_line',
      useful_life_years INT DEFAULT 5,
      salvage_value DECIMAL(14,4) DEFAULT 0,
      current_value DECIMAL(14,4),
      warranty_expiry DATE,
      last_maintenance_date DATE,
      next_maintenance_date DATE,
      assigned_to VARCHAR(80),
      status ENUM('active','under_maintenance','retired','disposed','lost') DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_brand (brand_id),
      INDEX idx_branch (branch_id),
      INDEX idx_status (status),
      INDEX idx_next_mnt (next_maintenance_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // v5.10.5 — GL linkage + depreciation tracking + project + audit columns
  // moved here (was mis-ordered above the table's own creation — see the
  // comment near the old location). Must run AFTER the CREATE TABLE
  // immediately above.
  await addColumnIfMissing('assets', 'dep_start_month',           "DATE");
  await addColumnIfMissing('assets', 'dep_until_date',            "DATE");
  await addColumnIfMissing('assets', 'gl_asset_account_id',       "VARCHAR(40)");
  await addColumnIfMissing('assets', 'gl_dep_expense_account_id', "VARCHAR(40)");
  await addColumnIfMissing('assets', 'gl_accum_dep_account_id',   "VARCHAR(40)");
  await addColumnIfMissing('assets', 'project_id',                "VARCHAR(40)");
  await addColumnIfMissing('assets', 'created_by',                "VARCHAR(80)");
  await addColumnIfMissing('assets', 'updated_at',                "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  // 6) Work Orders (أوامر العمل والصيانة)
  await createTableIfMissing('work_orders', `
    CREATE TABLE work_orders (
      id VARCHAR(40) PRIMARY KEY,
      code VARCHAR(40) UNIQUE,
      type ENUM('maintenance','operational','installation','inspection','repair','cleaning') DEFAULT 'maintenance',
      priority ENUM('low','normal','high','critical') DEFAULT 'normal',
      title VARCHAR(300) NOT NULL,
      description TEXT,
      asset_id VARCHAR(40),
      property_id VARCHAR(40),
      property_unit_id VARCHAR(40),
      branch_id VARCHAR(40),
      brand_id VARCHAR(40),
      cost_center_id VARCHAR(40),
      requested_by VARCHAR(80),
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      assigned_to VARCHAR(80),
      assigned_at DATETIME,
      started_at DATETIME,
      completed_at DATETIME,
      closed_at DATETIME,
      due_date DATE,
      status ENUM('open','assigned','in_progress','on_hold','completed','closed','cancelled') DEFAULT 'open',
      estimated_hours DECIMAL(8,2) DEFAULT 0,
      actual_hours DECIMAL(8,2) DEFAULT 0,
      labor_cost DECIMAL(12,4) DEFAULT 0,
      parts_cost DECIMAL(12,4) DEFAULT 0,
      external_cost DECIMAL(12,4) DEFAULT 0,
      total_cost DECIMAL(12,4) DEFAULT 0,
      currency VARCHAR(8) DEFAULT 'SAR',
      transaction_id VARCHAR(50),
      attachments LONGTEXT,
      completion_notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_asset (asset_id),
      INDEX idx_branch (branch_id),
      INDEX idx_brand (brand_id),
      INDEX idx_assigned (assigned_to),
      INDEX idx_status_pri (status, priority),
      INDEX idx_due (due_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 7) Work Order Lines (بنود الأمر — مواد مستهلكة + ساعات عمل)
  await createTableIfMissing('work_order_lines', `
    CREATE TABLE work_order_lines (
      id VARCHAR(40) PRIMARY KEY,
      work_order_id VARCHAR(40) NOT NULL,
      line_type ENUM('labor','part','service','external') DEFAULT 'part',
      item_id VARCHAR(40),
      description VARCHAR(400),
      quantity DECIMAL(10,4) DEFAULT 1,
      uom VARCHAR(20),
      unit_cost DECIMAL(12,4) DEFAULT 0,
      total_cost DECIMAL(12,4) DEFAULT 0,
      stock_movement_id VARCHAR(40),
      employee_id VARCHAR(40),
      hours DECIMAL(8,2),
      hourly_rate DECIMAL(10,2),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wo (work_order_id),
      INDEX idx_type (line_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 8) Supplier Invoices (فواتير الموردين)
  await createTableIfMissing('supplier_invoices', `
    CREATE TABLE supplier_invoices (
      id VARCHAR(40) PRIMARY KEY,
      code VARCHAR(40) UNIQUE,
      supplier_id VARCHAR(40),
      supplier_name VARCHAR(200),
      vat_number VARCHAR(40),
      invoice_no VARCHAR(80),
      issue_date DATE NOT NULL,
      due_date DATE,
      brand_id VARCHAR(40),
      branch_id VARCHAR(40),
      cost_center_id VARCHAR(40),
      purchase_order_id VARCHAR(40),
      grn_id VARCHAR(40),
      currency VARCHAR(8) DEFAULT 'SAR',
      subtotal DECIMAL(14,4) DEFAULT 0,
      discount_amount DECIMAL(14,4) DEFAULT 0,
      vat_amount DECIMAL(14,4) DEFAULT 0,
      total_amount DECIMAL(14,4) DEFAULT 0,
      paid_amount DECIMAL(14,4) DEFAULT 0,
      balance_amount DECIMAL(14,4) DEFAULT 0,
      payment_terms VARCHAR(80),
      matching_status ENUM('unmatched','partial','matched','overmatched') DEFAULT 'unmatched',
      status ENUM('draft','pending_approval','approved','partially_paid','paid','overdue','cancelled') DEFAULT 'draft',
      transaction_id VARCHAR(50),
      gl_journal_id VARCHAR(60),
      attachments LONGTEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(80),
      INDEX idx_supplier (supplier_id),
      INDEX idx_brand (brand_id),
      INDEX idx_due (due_date, status),
      INDEX idx_status (status),
      INDEX idx_po (purchase_order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 9) Supplier Invoice Lines
  await createTableIfMissing('supplier_invoice_lines', `
    CREATE TABLE supplier_invoice_lines (
      id VARCHAR(40) PRIMARY KEY,
      invoice_id VARCHAR(40) NOT NULL,
      item_id VARCHAR(40),
      description VARCHAR(400),
      quantity DECIMAL(10,4) DEFAULT 1,
      uom VARCHAR(20),
      unit_price DECIMAL(12,4),
      discount_pct DECIMAL(5,2) DEFAULT 0,
      vat_pct DECIMAL(5,2) DEFAULT 15,
      line_total DECIMAL(14,4),
      account_id VARCHAR(40),
      cost_center_id VARCHAR(40),
      INDEX idx_invoice (invoice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 10) was customer_invoices + customer_invoice_lines — the manual/rental AR
  //     invoice pair behind the deleted /api/ar-invoices route. ar_documents is
  //     the single AR source of truth; scripts/order-to-cash/backfill.js still
  //     imports these tables where an existing database has them.

  // 11) Approval Policies (مصفوفة سياسات الموافقة المتقدمة)
  await createTableIfMissing('approval_policies', `
    CREATE TABLE approval_policies (
      id VARCHAR(40) PRIMARY KEY,
      transaction_type_code VARCHAR(40) NOT NULL,
      brand_id VARCHAR(40),
      branch_id VARCHAR(40),
      cost_center_id VARCHAR(40),
      amount_from DECIMAL(14,4) DEFAULT 0,
      amount_to DECIMAL(14,4),
      currency VARCHAR(8) DEFAULT 'SAR',
      step_order INT NOT NULL,
      approver_type ENUM('role','user','position','manager_of_creator','department_head') DEFAULT 'role',
      approver_value VARCHAR(120),
      sla_hours INT DEFAULT 24,
      can_approve BOOLEAN DEFAULT TRUE,
      can_reject BOOLEAN DEFAULT TRUE,
      can_return BOOLEAN DEFAULT TRUE,
      can_delegate BOOLEAN DEFAULT TRUE,
      escalate_after_hours INT,
      escalate_to_role VARCHAR(80),
      is_active BOOLEAN DEFAULT TRUE,
      notes VARCHAR(400),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(80),
      INDEX idx_type_amount (transaction_type_code, amount_from, amount_to),
      INDEX idx_scope (brand_id, branch_id),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 12) Document Reference Chain (السلسلة المرجعية بين المستندات)
  await createTableIfMissing('document_chains', `
    CREATE TABLE document_chains (
      id VARCHAR(40) PRIMARY KEY,
      chain_code VARCHAR(40),
      from_doc_type VARCHAR(40),
      from_doc_id VARCHAR(50),
      to_doc_type VARCHAR(40),
      to_doc_id VARCHAR(50),
      relationship ENUM('source','derived','related','reversal','partial') DEFAULT 'derived',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(80),
      INDEX idx_from (from_doc_type, from_doc_id),
      INDEX idx_to (to_doc_type, to_doc_id),
      INDEX idx_chain (chain_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 13) Budget Lines (الميزانيات الشهرية / السنوية لمراكز التكلفة)
  await createTableIfMissing('budget_lines', `
    CREATE TABLE budget_lines (
      id VARCHAR(40) PRIMARY KEY,
      fiscal_year INT NOT NULL,
      period_month INT,
      cost_center_id VARCHAR(40) NOT NULL,
      account_id VARCHAR(40),
      brand_id VARCHAR(40),
      budget_amount DECIMAL(14,4) DEFAULT 0,
      actual_amount DECIMAL(14,4) DEFAULT 0,
      committed_amount DECIMAL(14,4) DEFAULT 0,
      variance_amount DECIMAL(14,4) DEFAULT 0,
      variance_pct DECIMAL(6,2) DEFAULT 0,
      currency VARCHAR(8) DEFAULT 'SAR',
      threshold_warn_pct DECIMAL(5,2) DEFAULT 80,
      threshold_block_pct DECIMAL(5,2) DEFAULT 100,
      notes VARCHAR(400),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_period (fiscal_year, period_month),
      INDEX idx_cc (cost_center_id),
      INDEX idx_brand (brand_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 14) Anomaly Alerts (تنبيهات شذوذ — أساس الـ AI Layer)
  await createTableIfMissing('anomaly_alerts', `
    CREATE TABLE anomaly_alerts (
      id VARCHAR(40) PRIMARY KEY,
      detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      severity ENUM('info','low','medium','high','critical') DEFAULT 'medium',
      category ENUM('financial','operational','behavioral','compliance','duplicate') DEFAULT 'financial',
      title VARCHAR(300),
      description TEXT,
      related_doc_type VARCHAR(40),
      related_doc_id VARCHAR(60),
      score DECIMAL(5,2),
      status ENUM('open','acknowledged','dismissed','resolved') DEFAULT 'open',
      acknowledged_by VARCHAR(80),
      acknowledged_at DATETIME,
      resolution_notes TEXT,
      INDEX idx_severity (severity, status),
      INDEX idx_doc (related_doc_type, related_doc_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 15) Saved Views (لتخصيص الفلاتر والشاشات لكل مستخدم)
  await createTableIfMissing('saved_views', `
    CREATE TABLE saved_views (
      id VARCHAR(40) PRIMARY KEY,
      username VARCHAR(80) NOT NULL,
      module VARCHAR(60) NOT NULL,
      name VARCHAR(120) NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      is_shared BOOLEAN DEFAULT FALSE,
      filters_json LONGTEXT,
      columns_json LONGTEXT,
      sort_json VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_mod (username, module)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 15b) User Preferences (تفضيلات المستخدم — اللغة + إعدادات الواجهة)
  //   Sprint 3 (A2). Per-user key/value blob keyed by username (the same
  //   token-derived identity every other route uses). prefs_json stores
  //   { language: 'ar'|'en', ...arbitrary UI prefs }. Backs GET/PUT
  //   /api/user-preferences (routes/user-preferences.js). Additive + fully
  //   isolated — touches no existing table. Raw SQL reference lives in
  //   db/migrations/0017_user_preferences.sql. createTableIfMissing no-ops
  //   safely once the table exists, so this is safe to run on every boot.
  await createTableIfMissing('user_preferences', `
    CREATE TABLE user_preferences (
      username VARCHAR(80) PRIMARY KEY,
      prefs_json LONGTEXT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Enrich position_workflow_steps with policy linkage if not present
  await addColumnIfMissing('position_workflow_steps', 'policy_id', 'VARCHAR(40)');
  await addColumnIfMissing('position_workflow_steps', 'sla_hours', 'INT DEFAULT 24');

  // Seed: a sample property + unit + contract — only if tables are empty
  try {
    const [pcount] = await db.query('SELECT COUNT(*) AS c FROM properties');
    if (pcount[0].c === 0) {
      const propId = 'PROP-DEMO-001';
      await db.query(
        `INSERT IGNORE INTO properties (id,code,name,type,city,district,total_area,status,created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [propId, 'P-001', 'برج المذاق المغربي - الرياض', 'commercial', 'الرياض', 'العليا', 1200, 'active', 'system']);
      await db.query(
        `INSERT IGNORE INTO property_units (id,property_id,code,unit_number,floor,type,area,monthly_rent,status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ['UNIT-DEMO-001', propId, 'P-001-U1', 'U-101', 1, 'shop', 80, 4500, 'vacant']);
    }
  } catch(e) { /* ignore */ }

  // V5.1 — additional indexes + idempotency_keys table
  try {
    await db.query(`CREATE INDEX idx_repl_txn_author ON transaction_replies(transaction_id, author_username)`);
  } catch(e) { /* index already exists */ }
  try {
    await db.query(`CREATE INDEX idx_log_txn_step_action ON transaction_steps_log(transaction_id, workflow_definition_id, action_type)`);
  } catch(e) {}
  try {
    await db.query(`CREATE INDEX idx_txn_due_status ON transactions(due_date, status, deleted_at)`);
  } catch(e) {}

  await createTableIfMissing('idempotency_keys', `
    CREATE TABLE idempotency_keys (
      id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(80),
      endpoint VARCHAR(160),
      response_json LONGTEXT,
      status_code SMALLINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_age (username, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Phase 3A.1 — request fingerprint so the SAME key with a DIFFERENT payload is
  // rejected as IDEMPOTENCY_CONFLICT instead of replaying a mismatched result.
  await addColumnIfMissing('idempotency_keys', 'request_hash', "VARCHAR(64)");
  // House-keeping / retention policy (Phase 3B): purge COMPLETED idempotency
  // results older than IDEMPOTENCY_RETENTION_DAYS (default 30). An IN-PROGRESS
  // reservation (status_code IS NULL) is never deleted, so a live request is
  // never torn out from under itself. Runs on every boot + daily (unref'd timer).
  try {
    const _idemRetention = require('./lib/idempotencyRetention');
    await _idemRetention.cleanupIdempotencyKeys(db);
    _idemRetention.startIdempotencyCleanup(db);
  } catch(e) {}

  console.log('[v5-migrations] Real-Estate / Contracts / Work-Orders / AP-AR + V5.1 indexes ready.');

  // ═══ V5.4 — Channel-specific menus + Stocktake workflow ═══

  // 16) Channel Menu Items — controls which menu items appear in which sales channel,
  //     with optional override price + branch warehouse assignment + linked BOM.
  await createTableIfMissing('channel_menu_items', `
    CREATE TABLE channel_menu_items (
      id VARCHAR(60) PRIMARY KEY,
      channel_id VARCHAR(50) NOT NULL,
      branch_id VARCHAR(50),
      menu_item_id VARCHAR(50) NOT NULL,
      is_available BOOLEAN DEFAULT TRUE,
      override_price DECIMAL(10,4),
      daily_limit INT,
      sold_today INT DEFAULT 0,
      sort_order INT DEFAULT 100,
      sales_warehouse_id VARCHAR(50),
      bom_id VARCHAR(50),
      notes VARCHAR(400),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_channel_branch_item (channel_id, branch_id, menu_item_id),
      INDEX idx_channel (channel_id),
      INDEX idx_branch (branch_id),
      INDEX idx_item (menu_item_id),
      INDEX idx_avail (is_available)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 17) Stocktake — extend with status workflow + variance threshold + photo evidence
  try {
    await addColumnIfMissing('stocktakes', 'workflow_status',
      "ENUM('draft','in_progress','pending_approval','approved','rejected','posted','cancelled') DEFAULT 'posted'");
    await addColumnIfMissing('stocktakes', 'variance_threshold_pct', 'DECIMAL(5,2) DEFAULT 10');
    await addColumnIfMissing('stocktakes', 'submitted_by', 'VARCHAR(80)');
    await addColumnIfMissing('stocktakes', 'submitted_at', 'DATETIME');
    await addColumnIfMissing('stocktakes', 'approved_by', 'VARCHAR(80)');
    await addColumnIfMissing('stocktakes', 'approved_at', 'DATETIME');
    await addColumnIfMissing('stocktakes', 'rejected_by', 'VARCHAR(80)');
    await addColumnIfMissing('stocktakes', 'rejected_at', 'DATETIME');
    await addColumnIfMissing('stocktakes', 'rejection_reason', 'TEXT');
    await addColumnIfMissing('stocktakes', 'count_method', "ENUM('full','cycle','spot','blind') DEFAULT 'full'");
    await addColumnIfMissing('stocktakes', 'attachments', 'LONGTEXT');
    await addColumnIfMissing('stocktake_items', 'unit_cost', 'DECIMAL(12,4)');
    await addColumnIfMissing('stocktake_items', 'variance_value', 'DECIMAL(14,4)');
    await addColumnIfMissing('stocktake_items', 'variance_pct', 'DECIMAL(8,2)');
    await addColumnIfMissing('stocktake_items', 'is_flagged', 'BOOLEAN DEFAULT FALSE');
    await addColumnIfMissing('stocktake_items', 'verified_by', 'VARCHAR(80)');
    await addColumnIfMissing('stocktake_items', 'verified_at', 'DATETIME');
    await addColumnIfMissing('stocktake_items', 'photo_data', 'LONGTEXT');
    await addColumnIfMissing('stocktake_items', 'reason_code', "VARCHAR(40)");
    await addColumnIfMissing('stocktake_items', 'notes', 'VARCHAR(400)');
  } catch(e) { /* table may not exist yet */ }

  // v5.15.3 — Clean up orphaned channel_menu_items rows whose
  // menu_item_id no longer exists. Without this, the LEFT JOIN in
  // GET /channel-menus/:id leaks NULL item names into the cashier,
  // which then renders blank product cards. wipe-and-seed flows can
  // create these orphans by clearing the menu table without
  // touching channel_menu_items.
  try {
    const [orphans] = await db.query(`
      SELECT COUNT(*) AS n FROM channel_menu_items cmi
      LEFT JOIN menu m ON m.id = cmi.menu_item_id
      WHERE m.id IS NULL
    `);
    if (orphans.length && orphans[0].n > 0) {
      await db.query(`
        DELETE cmi FROM channel_menu_items cmi
        LEFT JOIN menu m ON m.id = cmi.menu_item_id
        WHERE m.id IS NULL
      `);
      console.log('[v5.15.3] cleaned ' + orphans[0].n + ' orphaned channel_menu_items rows.');
    }
  } catch (e) { /* table may not exist on a brand-new instance */ }

  console.log('[v5.4-migrations] channel_menu_items + stocktake workflow ready.');

  // ═══ V5.6 — Menu ↔ BOM integration (each finished menu item gets its own recipe) ═══
  // Adds:
  //  - menu.bom_id            FK to its dedicated recipe
  //  - menu.production_method ENUM('made_at_branch','made_at_kitchen','prepared','imported')
  //  - menu.deduct_strategy   ENUM('on_sale','on_production','none')
  //  - menu.allow_negative_stock BOOLEAN — block oversell unless explicitly allowed
  //  - bom.product_source     ENUM('menu','inv') so BOM works for both menu items AND raw items
  //  - bom.consumption_warehouse_id — where ingredients are consumed FROM
  await addColumnIfMissing('menu', 'bom_id', 'VARCHAR(50) DEFAULT NULL');
  await addColumnIfMissing('menu', 'production_method',
    "ENUM('made_at_branch','made_at_kitchen','prepared','imported') DEFAULT 'made_at_branch'");
  await addColumnIfMissing('menu', 'deduct_strategy',
    "ENUM('on_sale','on_production','none') DEFAULT 'on_sale'");
  await addColumnIfMissing('menu', 'allow_negative_stock', 'BOOLEAN DEFAULT TRUE');
  await addColumnIfMissing('menu', 'min_stock_alert', 'DECIMAL(10,3) DEFAULT 0');

  // ═══════════════════════════════════════════════════════════════════
  // 0023) Whole-riyal pricing — widen menu.price to DECIMAL(10,4).
  //
  // Prices are stored NET (is_tax_inclusive=0 on every row since v7.1), and
  // the register now advertises the VAT-INCLUSIVE amount on the product card.
  // For that amount to land on a whole riyal the stored net has to be
  // target/(1+rate) — a value that at 2 decimals frequently does not exist:
  // 11.00 SAR @ 15% needs 9.5652, and neither 9.57 (-> 11.01) nor 9.56
  // (-> 10.99) hits it. 537 of the first 5,000 integer targets are
  // unreachable at (10,2); zero are at (10,4), at 0/5/10/15% alike.
  //
  // WIDENING ONLY — every existing 2-decimal value is preserved exactly, and
  // MODIFY COLUMN is idempotent, so this is safe on every boot. See
  // db/migrations/0023_whole_riyal_pricing.sql for the full rationale.
  // ═══════════════════════════════════════════════════════════════════
  try {
    await db.query('ALTER TABLE menu MODIFY price DECIMAL(10,4) NOT NULL DEFAULT 0');
  } catch (e) {
    // Loud but non-fatal: an older MySQL or a locked table must not stop the
    // server from booting. Prices keep working at 2 decimals; only the
    // whole-riyal tuning degrades (the rounding script reports the rows it
    // could not hit rather than writing a wrong price).
    console.error('[migrate] menu.price widen to DECIMAL(10,4) failed:', e.message);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Sprint 3 Phase D3 — inventory-items + menu redesign (ADDITIVE, idempotent)
  // WIRING NOTE: route MOUNTS are unchanged — /api/menu (routes/menu.js) and
  // /api/inventory/v2 (routes/inventory-items.js) are already mounted; the new
  // /menu/list + /items/:id/assignments endpoints live inside those existing
  // routers. Only the schema is added here (established single-file convention).
  // ═══════════════════════════════════════════════════════════════════
  // (3) menu.cost_source — labels WHERE the stored cost came from so the item
  // PUT can lock a recipe-derived cost against silent manual edits. NULL until
  // stamped. It is provenance ONLY — it never reads or writes the cost NUMBER.
  await addColumnIfMissing('menu', 'cost_source', "ENUM('recipe','manual','imported') NULL");
  // One-time backfill of the LABEL only (guarded by a settings flag). A row with
  // a bom_id is recipe-costed; a row with a non-zero cost but no bom_id is manual.
  // This is pure labeling — the UPDATE touches only cost_source, never cost.
  try {
    const [csDone] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'MenuCostSourceBackfill_D3' LIMIT 1");
    if (!csDone.length) {
      await db.query("UPDATE menu SET cost_source = 'recipe' WHERE cost_source IS NULL AND bom_id IS NOT NULL");
      await db.query("UPDATE menu SET cost_source = 'manual' WHERE cost_source IS NULL AND bom_id IS NULL AND cost IS NOT NULL AND cost <> 0");
      await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('MenuCostSourceBackfill_D3','1') ON DUPLICATE KEY UPDATE setting_value = '1'");
      console.log('[DB] D3 menu.cost_source backfill: labeled existing rows (no cost VALUE changed).');
    }
  } catch (e) { console.log('[DB] D3 cost_source backfill warning:', e.message.substring(0, 120)); }

  // (4) item_warehouse_assignments — explicit item↔warehouse MEMBERSHIP, kept
  // separate from stock. warehouse_item_rules stays the min/max/reorder layer;
  // this is the "which warehouses does this item belong to" layer. is_main is
  // the per-item primary warehouse. Writing assignments NEVER touches
  // warehouse_stock balances. UNIQUE(item_id,warehouse_id).
  await createTableIfMissing('item_warehouse_assignments', `
    CREATE TABLE item_warehouse_assignments (
      id VARCHAR(60) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL,
      warehouse_id VARCHAR(50) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_main TINYINT(1) NOT NULL DEFAULT 0,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_by VARCHAR(100),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_iwa_item_wh (item_id, warehouse_id),
      INDEX idx_iwa_item (item_id),
      INDEX idx_iwa_wh (warehouse_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await addColumnIfMissing('bom', 'product_source',
    "ENUM('menu','inv') DEFAULT 'inv'");
  await addColumnIfMissing('bom', 'consumption_warehouse_id', 'VARCHAR(50)');
  try { await db.query('CREATE INDEX idx_menu_bom ON menu(bom_id)'); } catch(_) {}
  try { await db.query('CREATE INDEX idx_bom_source ON bom(product_source, product_id)'); } catch(_) {}

  console.log('[v5.6-migrations] menu↔BOM integration ready.');

  // ─── v5.10.39 — Multi-dimensional GL infrastructure ───────────────────
  // Adds dimension columns (brand_id, branch_id, project_id, cost_center_id,
  // warehouse_id) to gl_journals + gl_entries so reports can be sliced by
  // any combination, and journals can be tagged with a full reporting context.
  // Backward-compatible: all NULL on legacy rows; existing queries still work.
  await addColumnIfMissing('gl_journals', 'brand_id',   'VARCHAR(50) NULL');
  await addColumnIfMissing('gl_journals', 'branch_id',  'VARCHAR(50) NULL');
  await addColumnIfMissing('gl_journals', 'project_id', 'VARCHAR(50) NULL');
  try { await db.query('CREATE INDEX idx_jrn_dims ON gl_journals (brand_id, branch_id, project_id, cost_center_id)'); } catch(_) {}

  await addColumnIfMissing('gl_entries', 'brand_id',       'VARCHAR(50) NULL');
  await addColumnIfMissing('gl_entries', 'branch_id',      'VARCHAR(50) NULL');
  await addColumnIfMissing('gl_entries', 'project_id',     'VARCHAR(50) NULL');
  await addColumnIfMissing('gl_entries', 'cost_center_id', 'VARCHAR(50) NULL');
  await addColumnIfMissing('gl_entries', 'warehouse_id',   'VARCHAR(50) NULL');
  try { await db.query('CREATE INDEX idx_ent_dims ON gl_entries (account_id, brand_id, branch_id, project_id)'); } catch(_) {}

  // Optional: per-account dimension requirements. NULL = not required.
  // Stored as JSON array of dim names: ["brand", "branch"].
  await addColumnIfMissing('gl_accounts', 'dim_required', 'JSON DEFAULT NULL');

  // v5.10.40 — explicit folder flag. Lets the user manually designate
  // which accounts behave as folders (can have children + show "+ Add"
  // button). Default FALSE; root codes 1..5 forced to TRUE; any account
  // that already has children gets TRUE for data integrity.
  await addColumnIfMissing('gl_accounts', 'is_folder', 'BOOLEAN DEFAULT FALSE');

  // v5.10.51 — persistent display order. The Excel "الترتيب" column was
  // previously a fake (just the row index after code-sort) — edits to it
  // were silently ignored on import. Now it has a real home. NULL falls
  // to the bottom at query time. Existing rows get a sensible initial
  // value: their position in the current code-sorted view, partitioned
  // by parent. So today's tree looks identical, but every later import
  // can move rows around persistently.
  await addColumnIfMissing('gl_accounts', 'display_order', 'INT DEFAULT NULL');
  try {
    const [unset] = await db.query("SELECT COUNT(*) AS n FROM gl_accounts WHERE display_order IS NULL");
    if (unset[0] && Number(unset[0].n) > 0) {
      const [all] = await db.query("SELECT id, parent_id, code FROM gl_accounts ORDER BY COALESCE(parent_id, ''), code");
      const counters = {};
      for (const row of all) {
        const key = String(row.parent_id || '');
        counters[key] = (counters[key] || 0) + 1;
        await db.query('UPDATE gl_accounts SET display_order = ? WHERE id = ?', [counters[key], row.id]);
      }
      console.log('[v5.10.51] backfilled display_order for ' + all.length + ' accounts');
    }
  } catch (e) {
    console.error('[v5.10.51] display_order backfill failed:', e.message);
  }
  // v5.10.43 — bulletproof migration. The previous attempt used a
  // self-referencing subquery (UPDATE gl_accounts ... WHERE id IN
  // (SELECT ... FROM gl_accounts ...)) wrapped in try/catch — if
  // MySQL 5.7 rejected the construct (which it does in some configs),
  // we silently lost the migration and roots 3/4 stayed as leaves in
  // the UI. Now done in two explicit steps with NO try/catch so any
  // failure shows up in server logs.
  try {
    const [r1] = await db.query("UPDATE gl_accounts SET is_folder = 1 WHERE code IN ('1','2','3','4','5')");
    console.log('[v5.10.43] is_folder enforced for ' + (r1.affectedRows || 0) + ' root accounts (1-5)');

    const [parents] = await db.query("SELECT DISTINCT parent_id AS pid FROM gl_accounts WHERE parent_id IS NOT NULL");
    const ids = parents.map(p => p.pid).filter(Boolean);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const [r2] = await db.query(`UPDATE gl_accounts SET is_folder = 1 WHERE id IN (${placeholders})`, ids);
      console.log('[v5.10.43] is_folder enforced for ' + (r2.affectedRows || 0) + ' parent accounts');
    } else {
      console.log('[v5.10.43] no parent accounts found yet (fresh install)');
    }
  } catch (e) {
    console.error('[v5.10.43] is_folder migration FAILED:', e.message);
  }

  // ═══════════════════════════════════════════════════════════════════
  // v5.10.78 — IFRS + SOCPA Chart of Accounts restructure
  // ═══════════════════════════════════════════════════════════════════
  // Adds 4 columns that replace the previous fragile "classify by code
  // prefix" approach in the Balance Sheet generator. Every account now
  // carries its own explicit:
  //
  //   account_class   main / sub / analytical / detail
  //                   (main=الفئة, sub=رئيسي, analytical=تحليلي,
  //                   detail=تفصيلي قابل للترحيل)
  //
  //   report_section  the exact Balance Sheet / Income Statement bucket
  //                   (cash, inventory, vat_input, vat_output, eosb,
  //                   zakat, gosi, withholding, ppe, acc_dep, …)
  //
  //   tax_nature      ZATCA tax category (vat_input / vat_output /
  //                   zakat / withholding / gosi / eosb / none)
  //
  // Plus 3 indexes for tree-traversal + report-generation performance.
  // All four columns are additive: existing data + queries keep working.
  await addColumnIfMissing('gl_accounts', 'account_class',
    "ENUM('main','sub','analytical','detail') DEFAULT 'detail' " +
    "COMMENT 'main=الفئة(L1), sub=رئيسي(L2), analytical=تحليلي(L3), detail=تفصيلي قابل للترحيل(L4-5)'");
  await addColumnIfMissing('gl_accounts', 'report_section',
    "VARCHAR(40) DEFAULT NULL " +
    "COMMENT 'تَصنيف Balance Sheet مُسبق — يَستبدل prefix-matching الهَشّ'");
  await addColumnIfMissing('gl_accounts', 'tax_nature',
    "ENUM('none','vat_input','vat_output','zakat','withholding','gosi','eosb') DEFAULT 'none' " +
    "COMMENT 'تَصنيف ضريبي لـ ZATCA + تقارير ضرائب السعودية'");
  try { await db.query('CREATE INDEX idx_gl_accounts_parent ON gl_accounts(parent_id)'); } catch(e) { /* exists */ }
  try { await db.query('CREATE INDEX idx_gl_accounts_class ON gl_accounts(account_class)'); } catch(e) { /* exists */ }
  try { await db.query('CREATE INDEX idx_gl_accounts_report ON gl_accounts(report_section)'); } catch(e) { /* exists */ }

  // v5.10.78 — Backfill account_class for existing rows based on their
  // current `level` column. Idempotent — only updates rows still on the
  // DEFAULT 'detail' value, so re-running doesn't disturb manual fixes.
  try {
    const [bf1] = await db.query(
      "UPDATE gl_accounts SET account_class = CASE " +
      "  WHEN level <= 1 THEN 'main' " +
      "  WHEN level = 2  THEN 'sub' " +
      "  WHEN level = 3  THEN 'analytical' " +
      "  ELSE 'detail' END " +
      "WHERE account_class = 'detail' AND level IS NOT NULL"
    );
    console.log('[v5.10.78] backfilled account_class for ' + (bf1.affectedRows || 0) + ' accounts');
  } catch (e) { console.error('[v5.10.78] account_class backfill:', e.message); }

  // v5.10.78 — Backfill report_section for existing rows by code prefix.
  // This is the SAME heuristic the Balance Sheet used to apply at query
  // time, but now it's persisted once + indexed. Future code changes can
  // assign report_section explicitly (e.g., via the CoA editor UI).
  try {
    const codeToSection = [
      // v5.10.84 — Saudi/International standard 6-digit GGMMPP codes
      // MUST come FIRST so they win over legacy patterns. The loop
      // updates rows one at a time and short-circuits on first hit.
      ["'1001'", "'cash'"],          // 100100, 100101, 100102 ...
      ["'1002'", "'receivables'"],   // 100200, 100201 ...
      ["'1003'", "'inventory'"],     // 100300, 100310-100332 ...
      ["'1004'", "'prepaid'"],       // 100400, 100401 ...
      ["'1005'", "'ppe'"],           // 100500, 100501-100504 ...
      ["'1006'", "'acc_dep'"],       // 100600, 100601 (contra)
      ["'2001'", "'payables'"],      // 200100, 200101 ...
      ["'2002'", "'accrued'"],
      ["'2003'", "'vat_output'"],
      ["'2004'", "'long_term_debt'"],
      ["'2005'", "'eosb'"],             // v5.10.85 — IAS 19
      ["'2006'", "'customer_deposits'"],// v5.10.85
      ["'3001'", "'capital'"],
      ["'3002'", "'retained'"],
      ["'3003'", "'retained'"],
      ["'3004'", "'reserves'"],         // v5.10.85
      ["'3005'", "'drawings'"],         // v5.10.85 (contra)
      ["'4'", "'revenue'"],          // any 4xxxxx
      ["'5001'", "'cogs'"],
      ["'5002'", "'cogs'"],
      ["'5003'", "'cogs'"],
      ["'5004','5005','5006','5007','5008','5009','5010'", "'opex'"],
      // ── Legacy v5.10.81 patterns kept as fallback for un-migrated rows ──
      ["'111'", "'cash'"],
      ["'1124'", "'allowance_doubtful'"],  // contra — MUST precede 112
      ["'112'", "'receivables'"],
      ["'113'", "'inventory'"],
      ["'1161'", "'vat_input'"],           // v5.10.78 new
      ["'116'", "'vat_input'"],
      ["'114'", "'prepaid'"],
      ["'115'", "'receivables'"],          // العهد والسلف
      ["'122'", "'acc_dep'"],              // contra (PRIMARY)
      ["'124'", "'rou'"],                  // v5.10.81 — IFRS 16 Right-of-Use
      ["'121'", "'ppe'"],
      ["'123'", "'intangibles'"],          // v5.10.81 — 123 = Intangibles per template
      ["'125','126'", "'intangibles'"],
      // ── Liabilities ── v5.10.81 — Calibrated to template:
      //   211=AP, 212=Accrued, 213=Output VAT (sub: 2131 VAT15%, 2132 Net VAT),
      //   214=Customer Deposits, 215=Franchise Dues, 216=GOSI,
      //   217=Withholding, 218=Short-term Loans, 219=Current Lease Portion,
      //   221=Long-term Loans, 222=Long-term Lease (IFRS 16),
      //   223=EOSB (IAS 19).
      ["'211'", "'payables'"],
      ["'212'", "'accrued'"],
      ["'2132'", "'net_vat'"],             // more specific first
      ["'2131'", "'vat_output'"],
      ["'213'", "'vat_output'"],
      ["'214'", "'customer_deposits'"],
      ["'215'", "'other_current_liability'"],
      ["'216'", "'gosi'"],
      ["'217'", "'withholding'"],
      ["'218','219'", "'short_term_debt'"],
      ["'223'", "'eosb'"],                 // v5.10.81 — IAS 19 (corrected from stale 225)
      ["'222'", "'lease_obligation'"],     // v5.10.81 — IFRS 16
      ["'221'", "'long_term_debt'"],
      ["'22'", "'long_term_debt'"],
      // ── Equity ── v5.10.81 — Calibrated:
      //   31=Capital, 32=Retained, 33=Drawings (contra),
      //   341=Statutory, 342=General, 343=Zakat reserve (corrected from stale 345).
      ["'31'", "'capital'"],
      ["'32'", "'retained'"],
      ["'33'", "'drawings'"],              // contra
      ["'343'", "'zakat'"],                // v5.10.81 — 343 is Zakat reserve per template (was wrongly '345')
      ["'34'", "'reserves'"],
      // ── Revenue / Expense ── v5.10.81 — Calibrated:
      //   41/42/43=Revenue, 5x=COGS, 6123=EOSB expense, 624x=Gov fees,
      //   6244=Zakat paid.
      ["'4'", "'revenue'"],
      ["'5'", "'cogs'"],
      ["'6123'", "'eosb_expense'"],        // v5.10.81 — was wrongly '62141','62142'
      ["'6244'", "'zakat_paid'"],          // v5.10.81 — was wrongly '62311'
      ["'624'", "'gov_fees'"],             // v5.10.81 — was wrongly '6221x'
      ["'6'", "'opex'"]
    ];
    let totalTagged = 0;
    for (const [codes, section] of codeToSection) {
      // Use SUBSTRING comparison so prefix matching works at SQL level.
      const codeList = codes.split(',');
      for (const c of codeList) {
        const cleanCode = c.replace(/'/g, '');
        const [u] = await db.query(
          "UPDATE gl_accounts SET report_section = ? " +
          "WHERE report_section IS NULL AND code LIKE ?",
          [section.replace(/'/g, ''), cleanCode + '%']
        );
        totalTagged += u.affectedRows || 0;
      }
    }
    console.log('[v5.10.78] backfilled report_section for ' + totalTagged + ' accounts');
  } catch (e) { console.error('[v5.10.78] report_section backfill:', e.message); }

  // v5.10.80 — RE-DERIVE pass: existing installs ran the v5.10.78 backfill
  // with the swapped asset prefixes (112↔113, 1131 vs 1124, 124 vs 122)
  // so their gl_accounts rows already have INCORRECT report_section
  // values that the IS-NULL guard above cannot reach. This pass
  // overrides them in-place for the affected asset prefixes only. It is
  // idempotent (running twice is a no-op) and safe to run on every boot.
  try {
    const corrections = [
      // [pattern, exclusionPattern (optional), correctSection]
      // ── v5.10.84 NEW STANDARD (6-digit GGMMPP) — checked FIRST ──
      ['1001%', null,        'cash'],
      ['1002%', null,        'receivables'],
      ['1003%', null,        'inventory'],
      ['1004%', null,        'prepaid'],
      ['1005%', null,        'ppe'],
      ['1006%', null,        'acc_dep'],
      ['2001%', null,        'payables'],
      ['2002%', null,        'accrued'],
      ['2003%', null,        'vat_output'],
      ['2004%', null,        'long_term_debt'],
      ['2005%', null,        'eosb'],              // v5.10.85
      ['2006%', null,        'customer_deposits'], // v5.10.85
      ['3001%', null,        'capital'],
      ['3002%', null,        'retained'],
      ['3003%', null,        'retained'],
      ['3004%', null,        'reserves'],          // v5.10.85
      ['3005%', null,        'drawings'],          // v5.10.85
      ['4%',    null,        'revenue'],
      ['5001%', null,        'cogs'],
      ['5002%', null,        'cogs'],
      ['5003%', null,        'cogs'],
      ['5004%', null,        'opex'],
      ['5005%', null,        'opex'],
      ['5006%', null,        'opex'],
      ['5007%', null,        'opex'],
      ['5008%', null,        'opex'],
      ['5009%', null,        'opex'],
      ['5010%', null,        'opex'],
      // ── Legacy patterns kept as fallback ──
      ['1124%', null,        'allowance_doubtful'],
      ['112%',  '1124%',     'receivables'],
      ['113%',  null,        'inventory'],
      ['114%',  null,        'prepaid'],
      ['115%',  null,        'receivables'],
      ['116%',  null,        'vat_input'],
      ['121%',  null,        'ppe'],
      ['122%',  null,        'acc_dep'],
      ['123%',  null,        'intangibles'],
      ['124%',  null,        'rou'],
      ['2132%', null,        'net_vat'],
      ['2131%', null,        'vat_output'],
      ['213%',  '213%' ,     'vat_output'],
      ['214%',  null,        'customer_deposits'],
      ['216%',  null,        'gosi'],
      ['217%',  null,        'withholding'],
      ['218%',  null,        'short_term_debt'],
      ['219%',  null,        'short_term_debt'],
      ['221%',  null,        'long_term_debt'],
      ['222%',  null,        'lease_obligation'],
      ['223%',  null,        'eosb'],
      ['343%',  null,        'zakat'],
      ['6123%', null,        'eosb_expense'],
      ['6244%', null,        'zakat_paid'],
      ['624%',  '6244%',     'gov_fees']
    ];
    let totalFixed = 0;
    for (const [pattern, exclusion, section] of corrections) {
      let sql = "UPDATE gl_accounts SET report_section = ? WHERE code LIKE ? AND (report_section IS NULL OR report_section <> ?)";
      const args = [section, pattern, section];
      if (exclusion) {
        sql += " AND code NOT LIKE ?";
        args.push(exclusion);
      }
      const [u] = await db.query(sql, args);
      totalFixed += u.affectedRows || 0;
    }
    if (totalFixed > 0) console.log('[v5.10.80] re-derived report_section for ' + totalFixed + ' mis-tagged accounts');
  } catch (e) { console.error('[v5.10.80] report_section re-derive:', e.message); }

  // v5.10.80 — Name-based rescue pass for legacy mis-coded custody /
  // allowance / depreciation accounts whose semantic NAME contradicts
  // their code prefix. Example: an owner created "11301 عهدة ADLAN"
  // — code 11301 starts with 113 (Inventory in our template), but the
  // name "عهدة" clearly means custody (a receivable). Without this
  // rescue, the prefix-only migration above would lock it under
  // Inventory permanently. Runs LAST so it overrides the prefix pass.
  try {
    const nameRescues = [
      // [LIKE pattern on name_ar, codeLike, correctSection]
      // Depreciation accounts: "إهلاك" anywhere → acc_dep
      [['%إهلاك%', '%depreciation%'], '1%', 'acc_dep'],
      // Allowance / provision accounts under current assets → allowance_doubtful
      [['%مخصص%', '%allowance%', '%provision%'], '11%', 'allowance_doubtful'],
      // Custody / advances under current assets → receivables
      [['%عهدة%', '%سلفة%', '%سلف%', '%advance%', '%custody%'], '11%', 'receivables']
    ];
    let totalRescued = 0;
    for (const [namePatterns, codePattern, section] of nameRescues) {
      for (const namePattern of namePatterns) {
        const [u] = await db.query(
          "UPDATE gl_accounts SET report_section = ? " +
          "WHERE code LIKE ? " +
          "  AND (name_ar LIKE ? OR name_en LIKE ?) " +
          "  AND (report_section IS NULL OR report_section <> ?)",
          [section, codePattern, namePattern, namePattern, section]
        );
        totalRescued += u.affectedRows || 0;
      }
    }
    if (totalRescued > 0) console.log('[v5.10.80] name-rescued report_section for ' + totalRescued + ' accounts');
  } catch (e) { console.error('[v5.10.80] name-rescue:', e.message); }

  // ── Relocate custody accounts out of the INVENTORY subtree ───────────────
  //
  // The owner's report: «العهدة تحت بند المخزون». He was right.
  //
  // routes/custody.js and a hand-copy in routes/erp.js both created employee
  // custody accounts as `1130x` parented under `113`. But `113` is INVENTORY —
  // lib/glPosting.js:44-45 states the mapping (111 Cash · 112 AR · 113
  // Inventory · 114 Prepayments · 115 Custody · 116 Input VAT) and
  // CORE_ACCOUNTS parents 1200/1210/1220/1230 (the warehouses) under `113`.
  // So عهدة sat as a sibling of the warehouses in the tree, and the balance
  // sheet followed, because the prefix table above maps `113%` → inventory.
  // The name-rescue then flipped report_section back to receivables every
  // boot — which is the recurring "re-derived … 1 mis-tagged" log, and why
  // the tree and the balance sheet disagreed with each other.
  //
  // Both creators are fixed (custody is `115`). This moves what already
  // exists. It changes ONLY `parent_id` — no code is renumbered, so not a
  // single gl_entries row, journal, or amount is touched; renumbering would
  // rewrite account_code across posted history and is deliberately left to
  // the explicit /gl/accounts/:id/move endpoint.
  //
  // Runs once, gated on a settings key, and is a no-op on a chart that never
  // had the defect.
  try {
    const [done] = await db.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'CustodyOutOfInventory_v1' LIMIT 1");
    if (!done.length) {
      // Candidates: named like custody/advance, and currently reachable from
      // the inventory group `113` (either directly under it or under `1130`).
      const [cands] = await db.query(
        `SELECT a.id, a.code, a.name_ar, a.parent_id, p.code AS parent_code
           FROM gl_accounts a
           LEFT JOIN gl_accounts p ON p.id = a.parent_id
          WHERE (a.name_ar LIKE '%عهدة%' OR a.name_ar LIKE '%عهد %' OR a.name_ar LIKE '%سلفة%'
                 OR a.name_ar LIKE '%سلف %' OR a.name_en LIKE '%custody%' OR a.name_en LIKE '%advance%')
            AND (p.code = '113' OR p.code LIKE '113%')`);
      if (cands.length) {
        // Resolve (or create) the custody group 115 without importing the
        // route module here — boot must not depend on router load order.
        let groupId = null;
        const [g] = await db.query("SELECT id FROM gl_accounts WHERE code = '115' LIMIT 1");
        if (g.length) groupId = g[0].id;
        else {
          const [p11] = await db.query("SELECT id FROM gl_accounts WHERE code = '11' LIMIT 1");
          groupId = 'GL-115';
          await db.query(
            `INSERT IGNORE INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_folder, report_section)
             VALUES (?,?,?,?,?,?,1,?)`,
            [groupId, '115', 'العهد والسلف', 'asset', p11.length ? p11[0].id : null, p11.length ? 3 : 2, 'receivables']);
        }
        let moved = 0;
        for (const c of cands) {
          if (c.id === groupId) continue;       // never re-parent the group into itself
          await db.query(
            "UPDATE gl_accounts SET parent_id = ?, report_section = 'receivables' WHERE id = ?",
            [groupId, c.id]);
          console.log('[custody-fix] ' + c.code + ' «' + (c.name_ar || '') + '» : ' +
                      (c.parent_code || '?') + ' (مخزون) → 115 العهد والسلف');
          moved++;
        }
        // Depth changed for everything that moved.
        try { await require('./lib/coa/tree').recomputeLevels(db); } catch (_) {}
        console.log('[custody-fix] relocated ' + moved + ' custody account(s) out of the inventory subtree');
      }
      await db.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES ('CustodyOutOfInventory_v1','1') " +
        "ON DUPLICATE KEY UPDATE setting_value = '1'");
    }
  } catch (e) { console.error('[custody-fix]', e.message); }

  // ── Merge the DUPLICATE inventory group ──────────────────────────────────
  //
  // The owner's report: «لماذا هناك اثنان من المخزون في الشجرة».
  //
  // CAUSE (fixed separately, in routes/erp.js): two boot migrations held
  // opposite beliefs and both ran on every start. `_repairInventoryClassification`
  // CREATED `112 المخزون` and dragged inventory-named accounts under it; then
  // the v5.11.14 block above moved the real inventory codes 1200/1210/1220/1230
  // to `113`. Two groups named المخزون, regenerated on every restart. That
  // helper now targets `113`, so the duplicate stops being re-created — this
  // block cleans up what previous boots already made.
  //
  // `113` is the survivor, and not by preference: lib/glPosting.js is the
  // authority that WRITES every journal, and its CORE_ACCOUNTS parents the
  // warehouses under `113` (header map at :44-45 — 112 = AR · 113 = Inventory).
  //
  // WHAT THIS DOES AND DELIBERATELY DOES NOT DO:
  //   • moves inventory-named CHILDREN of `112` to `113` — re-parenting is one
  //     of only two operations that cannot corrupt posted history.
  //   • renames `112` to its true meaning ONLY IF it carries no posted entries.
  //     `gl_entries.account_name` is a frozen snapshot, so old journals keep
  //     their original label either way.
  //   • NEVER renumbers a code. `gl_entries.account_code` is denormalised
  //     across all posted history and the account statement matches on
  //     `account_id OR account_code`, so a reused code drags foreign history
  //     into a report.
  //   • NEVER deactivates. An inactive account is silently dropped from the
  //     income statement, balance sheet and cash flow — and excluded from the
  //     year-end closing entry, which is idempotent by id and would misstate
  //     retained earnings unrecoverably.
  //   • NEVER deletes. Only three real FKs exist; ~18 columns reference
  //     accounts as unconstrained strings and would dangle silently.
  //
  // If `112` holds posted entries, this REFUSES to rename it and logs the
  // balance instead: reclassifying money that has already been posted is an
  // accountant's journal entry, not a migration's UPDATE.
  try {
    const [done] = await db.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'InventoryDuplicateMerge_v1' LIMIT 1");
    if (!done.length) {
      const [a112] = await db.query("SELECT id, code, name_ar FROM gl_accounts WHERE code = '112' LIMIT 1");
      const [a113] = await db.query("SELECT id, code, name_ar FROM gl_accounts WHERE code = '113' LIMIT 1");
      if (a112.length && a113.length) {
        const id112 = a112[0].id, id113 = a113[0].id;
        const nm112 = String(a112[0].name_ar || '');
        // Only act when 112 is actually mislabelled as inventory. On a chart
        // where 112 is already AR there is nothing to merge and this is a no-op.
        if (/مخزون/.test(nm112)) {
          const [kids] = await db.query(
            "SELECT id, code, name_ar FROM gl_accounts WHERE parent_id = ?", [id112]);
          let moved = 0;
          for (const k of kids) {
            if (!/مخزون|منتجات تامة|منتجات تحت التشغيل|finished good|wip|raw material/i.test(k.name_ar || '')) continue;
            await db.query(
              "UPDATE gl_accounts SET parent_id = ?, report_section = 'inventory' WHERE id = ?", [id113, k.id]);
            console.log('[inv-merge] ' + k.code + ' «' + (k.name_ar || '') + '» : 112 → 113 (' + (a113[0].name_ar || '') + ')');
            moved++;
          }
          const [[cnt]] = await db.query(
            "SELECT COUNT(*) AS n FROM gl_entries WHERE account_id = ?", [id112]);
          if (Number(cnt.n) === 0) {
            await db.query(
              "UPDATE gl_accounts SET name_ar = 'ذمم العملاء', report_section = 'receivables' WHERE id = ?", [id112]);
            console.log('[inv-merge] 112 renamed «' + nm112 + '» → «ذمم العملاء» (no posted entries — safe)');
          } else {
            console.warn('[inv-merge] 112 «' + nm112 + '» KEPT: it carries ' + cnt.n +
              ' posted entries. Renaming it would relabel posted money. It needs a ' +
              'reclassification journal entry approved by an accountant — not a migration.');
          }
          try { await require('./lib/coa/tree').recomputeLevels(db); } catch (_) {}
          console.log('[inv-merge] moved ' + moved + ' inventory account(s) from 112 to 113');
        }
      }
      await db.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES ('InventoryDuplicateMerge_v1','1') " +
        "ON DUPLICATE KEY UPDATE setting_value = '1'");
    }
  } catch (e) { console.error('[inv-merge]', e.message); }

  // ── Bilingual inventory names + SKUs ─────────────────────────────────────
  //
  // The owner's report, with a screenshot of /app/inventory/items: the Arabic
  // name column holds ENGLISH text — «Cup Holder 2», «A-31 Cold Drinks 30oz
  // 900ML Laser Logo Black» — the English column shows «الاسم الإنجليزي مفقود»,
  // and the SKU column shows «–». The English name is right; it is in the
  // wrong column, and the right column is empty.
  //
  // This runs the repair unattended so nobody has to execute a script against
  // production. The repair itself lives in lib/inventory/bilingualNames.js —
  // shared verbatim with the CLI, because two copies of a migration are two
  // migrations that will disagree.
  //
  // Writes FOUR columns and no others: name, name_en, sku, sku_norm. Never
  // touches a row that already has Arabic, never overwrites a human-typed
  // name_en, never reissues an existing SKU. Row-by-row by primary key.
  //
  // A word the dictionary does not know stays ENGLISH rather than being
  // transliterated — «كب هولدر» is not Arabic, it is noise nobody can search.
  // Those rows keep name_en === name, which is exactly the fingerprint the
  // candidate rule uses to pick them back up on a later run once the
  // dictionary has grown. Bump the version suffix below to force that re-run.
  //
  // Failure here must never keep the restaurant from opening: the whole block
  // is caught, and a row that fails is skipped rather than aborting the rest.
  //
  // _v2: the first production run translated only 24 of 194 items fully —
  // 115 partial, 48 untranslated — because the dictionary knew PACKAGING and
  // the catalogue is a restaurant's. The food vocabulary was added and the
  // version bumped so every row is reconsidered. The partial rows are reached
  // through `name_en`, which still holds the pristine English; see the
  // candidate rule in lib/inventory/bilingualNames.js.
  //
  // _v3: the _v2 log showed `untranslated 0` but 58 partial and 23 with an
  // unverified word order. The 23 were nearly all one shape — «Pistachio
  // Sauce» → «فستق صلصة» — so the head-noun flip now performs that reorder
  // instead of only reporting it, `Box` stopped being treated as a unit, and
  // the vocabulary the log printed was added.
  const INV_NAMES_KEY = 'InventoryBilingualNames_v3';
  try {
    const [done] = await db.query(
      'SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [INV_NAMES_KEY]);
    if (!done.length) {
      const bilingual = require('./lib/inventory/bilingualNames');
      const [rows] = await db.query(bilingual.SELECT_SQL);
      const r = bilingual.planBilingualNames(rows);
      const s = r.stats;
      if (r.plan.length) {
        const res = await bilingual.applyPlan(db, r.plan);
        console.log('[inv-names] ' + res.updated + '/' + s.planned + ' item(s) fixed — ' +
          'English moved to name_en, Arabic written, ' + s.newSkus + ' SKU(s) issued' +
          (s.repairs ? ' (' + s.repairs + ' re-translated from a previous partial run)' : ''));
        console.log('[inv-names] fully translated ' + s.clean +
          ' · partial ' + s.partial + ' · word-order unverified ' + s.wordOrderRisk +
          ' · untranslated ' + s.needsReview);
        // The vocabulary the dictionary still lacks. Logged, not just stored:
        // a settings row nobody can read is not evidence, and this is the list
        // that tells the next dictionary pass exactly what to add.
        if (r.vocabulary.length) {
          console.log('[inv-names] missing vocabulary (' + r.vocabulary.length + '): ' +
            r.vocabulary.slice(0, 150).join(' '));
        }
        if (r.review.length) {
          console.log('[inv-names] untranslated names: ' +
            r.review.slice(0, 40).map((p) => p.newNameEn).join(' | '));
        }
        if (r.ordering.length) {
          console.log('[inv-names] word order to check: ' +
            r.ordering.slice(0, 25).map((p) => p.newNameEn + ' → ' + p.newNameAr).join(' | '));
        }
        if (res.failures.length) {
          console.warn('[inv-names] ' + res.failures.length + ' row(s) failed: ' +
            res.failures.slice(0, 5).map((f) => f.name + ' (' + f.error + ')').join(', '));
        }
        // Persist what a human still needs to look at, so the health screen can
        // show it instead of it living only in a boot log nobody reads.
        if (r.review.length || r.ordering.length || r.vocabulary.length) {
          await db.query(
            'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ' +
            'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
            [INV_NAMES_KEY + '_review', JSON.stringify({
              untranslated: r.review.map((p) => p.newNameEn).slice(0, 200),
              wordOrder: r.ordering.map((p) => ({ en: p.newNameEn, ar: p.newNameAr })).slice(0, 200),
              vocabulary: r.vocabulary.slice(0, 400),
            })]);
        }
      } else {
        console.log('[inv-names] no items need bilingual repair (' +
          s.alreadyArabic + ' already Arabic, ' + s.humanEnglish + ' have a typed English name)');
      }
      await db.query(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, \'1\') ' +
        'ON DUPLICATE KEY UPDATE setting_value = \'1\'', [INV_NAMES_KEY]);
    }
  } catch (e) { console.error('[inv-names]', e.message); }

  // Standing health line — runs every boot, migration or not.
  //
  // The one-shot above prints a rich report exactly once and then never again,
  // so its output scrolls out of the log window and the catalogue's real state
  // becomes unknowable without a DB session. This is two counts and a line:
  // it answers "is the catalogue bilingual yet" on any deploy, forever.
  try {
    // The defect is a name with NO Arabic at all. A name that merely CONTAINS
    // Latin is usually correct — «A-31», «30oz», «900ML» are supplier codes and
    // measurements that must survive verbatim, and «Sante», «Davinci» are brand
    // names. A first version counted any Latin character and reported 153 of
    // 195 as broken, which was alarming and wrong.
    // The Arabic class is written as an explicit code-point range, passed as a
    // parameter. `[\p{Arabic}]` is accepted by MySQL's parser and then matches
    // almost nothing — it reported 3 of 19 known-Arabic names as Arabic, and
    // bare `\p{Arabic}` fails outright with an interval-syntax error. A regex
    // that silently under-matches is worse than one that throws.
    const AR = '[؀-ۿ]';
    const [[h]] = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN name_en IS NULL OR TRIM(name_en) = '' THEN 1 ELSE 0 END) AS no_en,
              SUM(CASE WHEN sku IS NULL OR TRIM(sku) = '' THEN 1 ELSE 0 END) AS no_sku,
              SUM(CASE WHEN name NOT REGEXP ? THEN 1 ELSE 0 END) AS no_arabic,
              SUM(CASE WHEN name REGEXP ? AND name REGEXP '[A-Za-z]' THEN 1 ELSE 0 END) AS mixed
         FROM inv_items`, [AR, AR]);
    if (Number(h.total) > 0) {
      console.log('[inv-health] ' + h.total + ' items · no Arabic name ' + h.no_arabic +
        ' · missing English ' + h.no_en + ' · missing SKU ' + h.no_sku +
        ' · Arabic with Latin codes/brands ' + h.mixed + ' (expected — measurements and brands stay)');
    }
  } catch (e) { console.error('[inv-health]', e.message); }

  // Per-item override for waste GL routing. NULL = use reason→account map.
  await addColumnIfMissing('inv_items', 'waste_gl_account_id', 'VARCHAR(50) NULL');

  // v5.16.0 — Unify the inventory model. An inv_items row can now be
  // either a raw material (default — bought from a supplier) or a
  // semi-finished product (produced via a production order from a
  // recipe). All inventory flows (warehouse_stock, stock_issues
  // transfers, sales.js BOM consumption) work for both kinds; only
  // the UI distinguishes them with a chip and a filter.
  await addColumnIfMissing('inv_items', 'kind',
    "ENUM('raw','semi') DEFAULT 'raw'");
  try { await db.query('CREATE INDEX idx_inv_items_kind ON inv_items(kind)'); } catch(e) { /* index exists */ }

  // Projects catalog — first-class accounting dimension.
  await createTableIfMissing('projects', `
    CREATE TABLE projects (
      id          VARCHAR(50)  PRIMARY KEY,
      code        VARCHAR(20)  UNIQUE NOT NULL,
      name_ar     VARCHAR(200) NOT NULL,
      name_en     VARCHAR(200),
      parent_id   VARCHAR(50)  NULL,
      brand_id    VARCHAR(50)  NULL,
      branch_id   VARCHAR(50)  NULL,
      status      ENUM('active','archived','planned') DEFAULT 'active',
      start_date  DATE NULL,
      end_date    DATE NULL,
      budget      DECIMAL(14,2) DEFAULT 0,
      owner       VARCHAR(100) NULL,
      notes       TEXT,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_proj_status (status),
      INDEX idx_proj_dims (brand_id, branch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('[v5.10.39] Multi-dimensional GL columns + projects table ready.');

  // ─── v6.5.0 — Unify semi-finished inventory ───
  // Owner spec: "المُنتجات الغير تامَّة هي مَواد نِصف مَصنوعة ممنوع تَتواجد في
  // المنيو — هي تُعامَل مُعامَلة المَواد الخام". Before this release the
  // system carried two parallel representations of every semi-finished
  // item:
  //   A. menu.is_semi_finished=1                 (v5.x legacy)
  //   B. inv_items.kind='semi'                   (v5.16.0+ unified)
  // This migration makes B the only source of truth:
  //   1. Copy every active menu semi into inv_items (kind='semi') with
  //      deterministic id 'INV-SEMI-<baseId>'.
  //   2. Mirror its menu.stock into warehouse_stock at the original
  //      production_warehouse_id (if any).
  //   3. Translate every menu.consumes_semi_id pointer into a recipe row
  //      (menu_id → INV-SEMI-x, qty_used=consumes_semi_qty) so the
  //      existing raw-recipe deduction path in routes/sales.js handles
  //      the consumption automatically — no special branch needed.
  //   4. Soft-delete the menu copies (active=0) — preserves FK integrity
  //      for historical sales_items + cached references.
  // Idempotent: re-running is a no-op once the inv_items counterpart
  // exists AND the menu copy is already deactivated. Wrapped in
  // try/catch so partial schemas (fresh installs mid-migration) stay
  // non-fatal.
  try {
    const [semis] = await db.query(`
      SELECT id, name, category, cost, stock, brand_id,
             production_unit, production_warehouse_id, min_stock
      FROM menu
      WHERE is_semi_finished = 1 AND COALESCE(active, 1) = 1
    `);

    if (semis.length) {
      const semiIdMap = {}; // menuSemiId → invSemiId

      // Step 1 + 2: copy each semi into inv_items + mirror stock
      for (const s of semis) {
        const baseId = String(s.id || '').replace(/^MENU-?/i, '');
        const invId = 'INV-SEMI-' + baseId;
        semiIdMap[s.id] = invId;

        const [exists] = await db.query('SELECT id FROM inv_items WHERE id = ?', [invId]);
        if (!exists.length) {
          await db.query(`
            INSERT INTO inv_items
              (id, name, kind, category, cost, stock, min_stock, unit, brand_id, active)
            VALUES (?, ?, 'semi', ?, ?, ?, ?, ?, ?, 1)
          `, [
            invId,
            s.name,
            s.category || 'نِصف مَصنوع',
            Number(s.cost) || 0,
            Number(s.stock) || 0,
            Number(s.min_stock) || 0,
            s.production_unit || 'pcs',
            s.brand_id || null
          ]);

          if (s.production_warehouse_id && Number(s.stock) > 0) {
            const wsId = 'WS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
            const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
            try {
              await db.query(`
                INSERT INTO warehouse_stock
                  (id, warehouse_id, item_id, qty, added_at, first_added_date, added_by, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE qty = VALUES(qty), last_updated = VALUES(last_updated)
              `, [wsId, s.production_warehouse_id, invId, Number(s.stock),
                  nowIso, nowIso.slice(0, 10), 'migration-v6.5.0', nowIso]);
            } catch (_) { /* warehouse_stock row may already exist with a different id */ }
          }
        }
      }

      // Step 3: translate consumes_semi_id → recipe rows
      const [consumers] = await db.query(`
        SELECT id, name, consumes_semi_id, consumes_semi_qty
        FROM menu
        WHERE consumes_semi_id IS NOT NULL AND consumes_semi_id <> ''
      `);
      let linkedCount = 0;
      for (const c of consumers) {
        const invSemiId = semiIdMap[c.consumes_semi_id];
        if (!invSemiId) continue; // semi might have been inactive

        const [existing] = await db.query(
          'SELECT id FROM recipe WHERE menu_id = ? AND inv_item_id = ?',
          [c.id, invSemiId]
        );
        if (existing.length) continue;

        const [semiName] = await db.query('SELECT name FROM inv_items WHERE id = ?', [invSemiId]);
        await db.query(`
          INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used)
          VALUES (?, ?, ?, ?, ?)
        `, [c.id, c.name, invSemiId,
            (semiName[0] && semiName[0].name) || invSemiId,
            Number(c.consumes_semi_qty) || 0]);
        linkedCount++;
      }

      // Step 4: soft-delete the menu copies
      await db.query(`
        UPDATE menu
           SET active = 0
         WHERE is_semi_finished = 1 AND active = 1
      `);

      console.log('[v6.5.0 semi-unify] migrated %d semi-finished items + %d consumer links',
        semis.length, linkedCount);
    }

    // v7.1 — SECONDARY idempotent pass (runs EVERY boot, independent of the
    // one-time block above): ensure EVERY menu.consumes_semi_id has a recipe row
    // pointing to a kind='semi' inv_item, so the sales.js guard always detects it
    // and skips the legacy path → prevents semi double-deduction. Fills only the
    // genuinely-missing links (NOT EXISTS), so re-running creates no duplicates.
    try {
      const [unmapped] = await db.query(`
        SELECT m.id, m.name, m.consumes_semi_id, m.consumes_semi_qty
        FROM menu m
        WHERE m.consumes_semi_id IS NOT NULL AND m.consumes_semi_id <> ''
          AND NOT EXISTS (
            SELECT 1 FROM recipe r JOIN inv_items i ON i.id = r.inv_item_id
            WHERE r.menu_id = m.id AND i.kind = 'semi')
      `);
      let backfilled = 0;
      for (const m of unmapped) {
        let invSemiId = null;
        const [direct] = await db.query("SELECT id FROM inv_items WHERE id = ? AND kind = 'semi'", [m.consumes_semi_id]);
        if (direct.length) invSemiId = m.consumes_semi_id;
        else {
          const base = String(m.consumes_semi_id || '').replace(/^MENU-?/i, '');
          const [alt] = await db.query("SELECT id FROM inv_items WHERE id = ? AND kind = 'semi'", ['INV-SEMI-' + base]);
          if (alt.length) invSemiId = 'INV-SEMI-' + base;
        }
        if (!invSemiId) continue; // unresolvable — legacy path still single-deducts
        const [exists] = await db.query('SELECT id FROM recipe WHERE menu_id = ? AND inv_item_id = ?', [m.id, invSemiId]);
        if (exists.length) continue;
        const [nm] = await db.query('SELECT name FROM inv_items WHERE id = ?', [invSemiId]);
        await db.query(
          'INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used) VALUES (?,?,?,?,?)',
          [m.id, m.name, invSemiId, (nm[0] && nm[0].name) || invSemiId, Number(m.consumes_semi_qty) || 0]);
        backfilled++;
      }
      if (backfilled > 0) console.log('[v7.1 semi-link backfill] created ' + backfilled + ' missing consumes_semi recipe rows');
    } catch (e2) { console.warn('[v7.1 semi-link backfill] skipped:', e2.message); }
  } catch (e) {
    console.error('[v6.5.0 semi-unify] migration failed (non-fatal):', e.message);
  }

  // Contact master data (ZATCA-style) — structured address + explicit VAT
  // registration flag + default GL account/cost-center dimensions for
  // customers (sales side) and suppliers (purchase side), plus a new
  // supplier_beneficiaries table (the supplier's OWN bank details for
  // direct-transfer payment — distinct from `bank_accounts`, which holds the
  // company's own accounts under GL 1102). Mirrors db/migrations/0013_contact_master_data.sql.
  await addColumnIfMissing('customers', 'vat_registered', "TINYINT(1) NOT NULL DEFAULT 1");
  await addColumnIfMissing('customers', 'street', "VARCHAR(200) NULL");
  await addColumnIfMissing('customers', 'building_number', "VARCHAR(10) NULL");
  await addColumnIfMissing('customers', 'district', "VARCHAR(120) NULL");
  await addColumnIfMissing('customers', 'additional_no', "VARCHAR(10) NULL");
  await addColumnIfMissing('customers', 'postal_code', "VARCHAR(10) NULL");
  await addColumnIfMissing('customers', 'default_revenue_account_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('customers', 'default_revenue_cost_center_id', "VARCHAR(50) NULL");

  await addColumnIfMissing('suppliers', 'vat_registered', "TINYINT(1) NOT NULL DEFAULT 1");
  await addColumnIfMissing('suppliers', 'street', "VARCHAR(200) NULL");
  await addColumnIfMissing('suppliers', 'building_number', "VARCHAR(10) NULL");
  await addColumnIfMissing('suppliers', 'district', "VARCHAR(120) NULL");
  await addColumnIfMissing('suppliers', 'additional_no', "VARCHAR(10) NULL");
  await addColumnIfMissing('suppliers', 'postal_code', "VARCHAR(10) NULL");
  await addColumnIfMissing('suppliers', 'default_expense_account_id', "VARCHAR(50) NULL");
  await addColumnIfMissing('suppliers', 'default_expense_cost_center_id', "VARCHAR(50) NULL");

  await createTableIfMissing('supplier_beneficiaries', `CREATE TABLE IF NOT EXISTS supplier_beneficiaries (
    id             VARCHAR(50) NOT NULL PRIMARY KEY,
    supplier_id    VARCHAR(50) NOT NULL,
    bank_name      VARCHAR(150) NOT NULL,
    account_name   VARCHAR(150) NULL,
    account_number VARCHAR(50) NULL,
    iban           VARCHAR(34) NULL,
    is_primary     TINYINT(1) NOT NULL DEFAULT 0,
    is_active      TINYINT(1) NOT NULL DEFAULT 1,
    created_by     VARCHAR(64) NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_supplier (supplier_id),
    CONSTRAINT fk_sb_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// Phase 4A — run ALL migrations to completion BEFORE binding the port. The old
// `app.listen(PORT, async () => { await autoInitDB() })` bound the socket first,
// so /api/version answered while the schema was still incomplete — the migration
// race that forced manual CREATE/ALTER in integration tests. Now the port only
// opens once autoInitDB() (schema + runMigrations + collations) has finished, so
// a successful /api/version GUARANTEES a complete schema. autoInitDB has its own
// retry loop and returns (does not throw) on final failure, so the server still
// comes up for diagnostics even if the DB is unreachable.
(async () => {
  try {
    await autoInitDB();
  } catch (e) {
    console.error('[boot] autoInitDB error (starting anyway):', e && e.message);
  }
  // Tier A.3 Release Gate — a dedicated migration-only mode so a deploy can
  // run `MIGRATE_ONLY=1 node server.js` as its OWN release step (schema
  // provisioning), fully separate from starting the HTTP server — instead
  // of migrations only ever running as a side effect of boot. autoInitDB()
  // never throws (its own retry loop swallows a final failure and just
  // logs), so the try/catch above can't tell us whether it actually
  // succeeded — a real DB round-trip here is the only honest success
  // signal, and its failure is what turns into a non-zero exit code a
  // deploy pipeline can act on.
  if (process.env.MIGRATE_ONLY === '1' || process.env.MIGRATE_ONLY === 'true') {
    // RC (Release-Candidate gate) — this used to be a bare `SELECT 1`, which
    // proves the DB is REACHABLE and nothing else. Combined with autoInitDB()
    // swallowing its own final failure, `MIGRATE_ONLY=1` could exit 0 on a
    // schema that never finished provisioning — i.e. the release chain's
    // fail-closed guarantee was fail-OPEN in exactly the case it exists for.
    // Two independent signals are required now:
    //   1. __autoInitSucceeded — set only on autoInitDB()'s completion path,
    //      so a failure that its retry loop swallowed is still caught here.
    //   2. A real schema probe — tables provisioned at different stages of
    //      runMigrations() (baseline / legacy-only / capability infrastructure)
    //      must all actually exist. A crash partway through runMigrations()
    //      leaves the later ones missing, which (1) alone would not reveal if
    //      the crash happened outside the retry loop's try block.
    //   3. No self-applying schema module threw. Signals (1) and (2) both pass
    //      while a module has failed outright — every one runs inside its own
    //      try/catch, and none of them creates any of the five baseline tables
    //      below, so neither signal can see it. Demonstrated: with the analytics
    //      module forced to fail the chain printed the failure, then "schema
    //      ready (5/5 probe tables present)", and exited 0.
    //
    // The probe list now also names one table per self-applying module, so a
    // module that fails WITHOUT throwing (or that is skipped entirely) is caught
    // by its absent table rather than by a stack trace it never produced.
    const REQUIRED_TABLES = [
      'users', 'hr_employees', 'pos_orders', 'permissions_v3', 'role_permissions',
      'ar_documents',           // order-to-cash
      'analytics_order_facts',  // analytics — this release ships a column + 9 indexes here
      'sales_posting_queue',    // sales-posting
    ];
    try {
      if (!__autoInitSucceeded) {
        throw new Error('autoInitDB() did not reach its success path — schema provisioning failed or the DB was unreachable (see the [DB] errors above)');
      }
      if (__schemaModuleFailures.length) {
        throw new Error(
          'schema module(s) failed — refusing to certify the schema: ' + __schemaModuleFailures.join(' | '));
      }
      const [present] = await db.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
        [REQUIRED_TABLES]
      );
      const found = new Set(present.map(r => r.TABLE_NAME));
      const missing = REQUIRED_TABLES.filter(t => !found.has(t));
      if (missing.length) {
        throw new Error('schema incomplete — missing table(s): ' + missing.join(', '));
      }
      console.log('[boot] MIGRATE_ONLY=1 — schema ready (' + REQUIRED_TABLES.length + '/' + REQUIRED_TABLES.length + ' probe tables present), exiting without starting the HTTP server.');
      process.exit(0);
    } catch (e) {
      console.error('[boot] MIGRATE_ONLY=1 — schema is NOT ready:', e && e.message);
      process.exit(1);
    }
  }
  app.listen(PORT, () => {
    console.log(`Moroccan Taste POS running on port ${PORT}`);
    // v6.1.0 Wave E.6 — start the ZATCA submission worker after migrations
    // complete so it can see the new zatca_submission_queue table.
    try {
      require('./lib/zatca-worker').start();
    } catch (e) {
      console.warn('[zatca-worker] failed to start:', e.message);
    }
    // Sales Analytics — rollup refresh + projection-repair worker (same start
    // discipline: after migrations, so the analytics tables exist).
    try {
      require('./lib/analytics/worker').start();
    } catch (e) {
      console.warn('[analytics-worker] failed to start:', e.message);
    }
    // bilingual-i18n-images — Owner D: name_en backfill + image sourcing
    // workers, started the same way/place as the ZATCA worker above (after
    // migrations complete so their queue tables are guaranteed to exist).
    try {
      require('./lib/name-en-backfill-worker').start();
      // Seed the worker's queue on boot. The worker only ever drains
      // name_en_backfill_queue; without a sweep the queue stays empty and no
      // item is ever backfilled — which is exactly why menu.name_en stayed
      // blank after the English POS shipped. The sweep is INSERT IGNORE over
      // items missing name_en (it never touches `menu`), so running it on every
      // boot is idempotent and picks up newly-added items automatically.
      // Opt out with NAME_EN_BACKFILL_DISABLE_WORKER=1 (same flag as the worker).
      if (process.env.NAME_EN_BACKFILL_DISABLE_WORKER !== '1') {
        require('./scripts/name-en-backfill-sweep')
          .main()
          .catch((e) => console.warn('[name-en-backfill-sweep] boot sweep failed:', e.message));
      }
    } catch (e) {
      console.warn('[name-en-backfill-worker] failed to start:', e.message);
    }
    try {
      require('./lib/image-sourcing-worker').start();
    } catch (e) {
      console.warn('[image-sourcing-worker] failed to start:', e.message);
    }
  });
})();
