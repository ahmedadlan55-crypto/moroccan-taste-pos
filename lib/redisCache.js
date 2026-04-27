/**
 * V4 — Optional Redis cache for hot reads (counters, permissions, etc.)
 * If REDIS_URL env var is set, cached values are stored there with TTL.
 * Otherwise this module is a no-op (get always returns null).
 *
 * Required env var:
 *   REDIS_URL — e.g. redis://default:password@host:port
 *               (Railway auto-provides this when you add Redis service)
 */

'use strict';

let _client = null;
let _enabled = false;
let _connecting = false;

const TTL = {
  COUNTERS: 30,         // 30 seconds — counters change often
  PERMISSIONS: 60,      // 1 minute — perms rarely change
  USER_META: 300,       // 5 minutes — user roles/positions
  WORKFLOW_STEP: 600    // 10 minutes — workflow definitions barely change
};

async function _ensureClient() {
  if (_client) return _client;
  if (_connecting) {
    // Wait for in-flight connection
    while (_connecting) await new Promise(r => setTimeout(r, 50));
    return _client;
  }
  if (!process.env.REDIS_URL) {
    _enabled = false;
    return null;
  }
  _connecting = true;
  try {
    let redis;
    try { redis = require('redis'); } catch(e) {
      console.log('[redis] redis package not installed; cache disabled. Run: npm install redis');
      _enabled = false;
      _connecting = false;
      return null;
    }
    _client = redis.createClient({ url: process.env.REDIS_URL });
    _client.on('error', (err) => console.warn('[redis] client error:', err.message));
    await _client.connect();
    _enabled = true;
    console.log('[redis] connected — cache enabled');
  } catch (e) {
    console.warn('[redis] connection failed, falling back to direct DB:', e.message);
    _enabled = false;
    _client = null;
  } finally {
    _connecting = false;
  }
  return _client;
}

// Try to connect on module load (non-blocking)
_ensureClient().catch(() => {});

/**
 * Get a cached value. Returns null on miss or if Redis disabled.
 */
async function get(key) {
  try {
    const c = await _ensureClient();
    if (!c) return null;
    const val = await c.get(key);
    return val ? JSON.parse(val) : null;
  } catch (e) {
    console.warn('[redis get]', key, e.message);
    return null;
  }
}

/**
 * Set a value with TTL (seconds).
 */
async function set(key, value, ttlSeconds) {
  try {
    const c = await _ensureClient();
    if (!c) return false;
    await c.set(key, JSON.stringify(value), { EX: ttlSeconds || 60 });
    return true;
  } catch (e) {
    console.warn('[redis set]', key, e.message);
    return false;
  }
}

/**
 * Delete one or more keys.
 */
async function del(...keys) {
  try {
    const c = await _ensureClient();
    if (!c) return 0;
    return await c.del(keys);
  } catch (e) {
    return 0;
  }
}

/**
 * Cache wrapper: returns cached value if present, else calls loader() and caches result.
 */
async function getOrLoad(key, ttlSeconds, loader) {
  const cached = await get(key);
  if (cached !== null) return cached;
  const fresh = await loader();
  if (fresh !== null && fresh !== undefined) {
    await set(key, fresh, ttlSeconds);
  }
  return fresh;
}

/**
 * Invalidate all keys with a prefix (used when a user's data changes).
 */
async function invalidatePattern(pattern) {
  try {
    const c = await _ensureClient();
    if (!c) return 0;
    const keys = [];
    for await (const key of c.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      keys.push(key);
    }
    if (keys.length) await c.del(keys);
    return keys.length;
  } catch (e) {
    return 0;
  }
}

function isEnabled() { return _enabled; }

module.exports = {
  TTL,
  get, set, del, getOrLoad, invalidatePattern,
  isEnabled
};
