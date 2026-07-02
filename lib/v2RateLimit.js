'use strict';
/**
 * ─── warehouse-v2 mutation rate limiter ──────────────────────────────────────
 *
 * Per-user, in-memory sliding-window limiter applied ONLY to state-changing
 * methods (POST/PUT/PATCH/DELETE) on the /api/inventory/v2 surface. Reads,
 * lists and CSV exports are never throttled. The global /api limiter
 * (server.js) stays as a coarse per-IP backstop; this adds a per-actor cap so
 * a single authenticated user cannot flood receipts/issues/lot-lifecycle.
 *
 * Tunable via env (read once at load):
 *   WAREHOUSE_V2_MUTATION_RATE_MAX        max mutations / window / user (default 300)
 *   WAREHOUSE_V2_MUTATION_RATE_WINDOW_MS  window length in ms          (default 60000)
 *   set MAX <= 0 to DISABLE entirely.
 *
 * Known limitation (documented in the RC audit): in-memory + single-process.
 * Behind a load balancer / multiple workers, pair with infra-level limiting.
 * The actor key is the JWT username (never a spoofable body field).
 */

function _int(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }

const WINDOW_MS = Math.max(1000, _int(process.env.WAREHOUSE_V2_MUTATION_RATE_WINDOW_MS, 60000));
const MAX = _int(process.env.WAREHOUSE_V2_MUTATION_RATE_MAX, 300);
const MUTATING = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };

const _store = new Map(); // actorKey -> { count, windowStart }

// Pure, unit-testable window check. Mutates `store` (a Map). Returns a verdict.
function check(store, key, now, windowMs, max) {
  if (max <= 0) return { limited: false, remaining: Infinity, retryAfterMs: 0 };
  let rec = store.get(key);
  if (!rec || now - rec.windowStart >= windowMs) {
    rec = { count: 0, windowStart: now };
    store.set(key, rec);
  }
  rec.count += 1;
  if (rec.count > max) {
    return { limited: true, remaining: 0, retryAfterMs: Math.max(0, windowMs - (now - rec.windowStart)) };
  }
  return { limited: false, remaining: max - rec.count, retryAfterMs: 0 };
}

function _actorKey(req) {
  return (req.user && (req.user.username || req.user.id)) || req.ip || 'anonymous';
}

function middleware(req, res, next) {
  if (!MUTATING[req.method] || MAX <= 0) return next();
  // Opportunistic cleanup so the Map never grows unbounded.
  if (_store.size > 5000) {
    const now0 = Date.now();
    for (const [k, v] of _store) { if (now0 - v.windowStart >= WINDOW_MS) _store.delete(k); }
  }
  const v = check(_store, _actorKey(req), Date.now(), WINDOW_MS, MAX);
  if (v.limited) {
    res.setHeader('Retry-After', String(Math.ceil(v.retryAfterMs / 1000)));
    return res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      error: 'طلبات كثيرة جدًا على عمليات المستودع — يُرجى المحاولة بعد قليل.',
    });
  }
  next();
}

module.exports = middleware;
module.exports.check = check;
module.exports.config = { WINDOW_MS, MAX };
module.exports._store = _store;
