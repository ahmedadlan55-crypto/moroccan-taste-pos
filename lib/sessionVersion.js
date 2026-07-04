'use strict';
/*
 * lib/sessionVersion.js — token_version gate with a tiny in-memory cache.
 *
 * A JWT carries the user's tokenVersion at issue time. When a user changes
 * their password we bump users.token_version, which INVALIDATES every previously
 * issued token (they carry the old version). To avoid a DB round-trip on every
 * authenticated request (hot path for a POS), the current version is cached per
 * user id for a short TTL — so a password change revokes other sessions within
 * at most TTL_MS (default 15s), which is an acceptable propagation delay.
 *
 * Fail-open on DB errors (returns true) so an infra blip never locks everyone
 * out; a genuinely mismatched version still returns false and forces re-login.
 */
const db = require('../db/connection');
const TTL_MS = Number(process.env.TOKEN_VERSION_CACHE_MS) || 15000;
const cache = new Map(); // id -> { version, at }

async function currentVersion(userId) {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.at < TTL_MS) return hit.version;
  try {
    const [rows] = await db.query('SELECT token_version FROM users WHERE id=? LIMIT 1', [userId]);
    const v = rows.length ? (Number(rows[0].token_version) || 1) : 1;
    cache.set(userId, { version: v, at: now });
    return v;
  } catch (_) {
    return null; // unknown → caller fails open
  }
}

// True when the token's version still matches the user's current version.
async function isTokenCurrent(decoded) {
  if (!decoded || decoded.id == null) return true; // no id claim → nothing to check
  // Tokens issued before this feature have no tokenVersion → treat as version 1.
  const tokenVer = Number(decoded.tokenVersion != null ? decoded.tokenVersion : 1) || 1;
  const cur = await currentVersion(decoded.id);
  if (cur == null) return true; // DB error → fail open
  return tokenVer === cur;
}

function bump(userId) { cache.delete(userId); } // force refresh after a change

module.exports = { isTokenCurrent, currentVersion, bump, TTL_MS };
