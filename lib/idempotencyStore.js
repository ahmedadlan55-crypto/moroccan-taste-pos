/**
 * Idempotency reservation store — Phase 3B.
 *
 * The same RESERVATION pattern hardened for transfers in Phase 3A.1, extracted
 * into a reusable module (takes the `db`/connection explicitly) so the new
 * inventory-transaction router can share it without importing route code.
 *
 *   1. begin() INSERTs a reservation row keyed by sha1(scope|doc|user|client-key).
 *      The UNIQUE PK is the race guard — only ONE concurrent request wins.
 *   2. On a duplicate key: same key + DIFFERENT payload → {mode:'conflict'}
 *      (→ IDEMPOTENCY_CONFLICT); a COMPLETED reservation → {mode:'replay'};
 *      an in-progress one → {mode:'conflict'} (the original is still running).
 *   3. complete() stores the response; abort() DELETEs a still-in-progress
 *      reservation so a transient FAILURE is never cached as a permanent success.
 *
 * Retention: lib/idempotencyRetention sweeps COMPLETED rows past the horizon.
 */
'use strict';
const crypto = require('crypto');

function readKey(req) {
  const k = (req && req.get && (req.get('Idempotency-Key') || req.get('X-Idempotency-Key'))) || '';
  return k ? String(k).slice(0, 120) : '';
}

function isDupErr(e) {
  return !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /duplicate entry/i.test(e.message || ''));
}

function stableStringify(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

function bodyHash(body) {
  try { return crypto.createHash('sha256').update(stableStringify(body || {})).digest('hex'); }
  catch (_) { return ''; }
}

function reservationId(scope, docId, username, key) {
  return 'tx:' + crypto.createHash('sha1').update([scope, docId || '', username || '', key].join('|')).digest('hex');
}

// begin(db, scope, docId, key, username, body) → one of:
//   { mode:'none' }                         — no key; proceed normally
//   { mode:'proceed', idemId }              — reservation taken; do the work
//   { mode:'replay', statusCode, body }     — completed before; replay it
//   { mode:'conflict' }                     — same key+different payload / in-progress
async function begin(db, scope, docId, key, username, body) {
  if (!key) return { mode: 'none' };
  const idemId = reservationId(scope, docId, username, key);
  const hash = bodyHash(body);
  try {
    await db.query(
      'INSERT INTO idempotency_keys (id, username, endpoint, request_hash, status_code) VALUES (?,?,?,?,NULL)',
      [idemId, username || '', scope, hash]
    );
    return { mode: 'proceed', idemId };
  } catch (e) {
    if (!isDupErr(e)) return { mode: 'proceed', idemId }; // table/other issue → never block the op
    let row = null;
    try {
      const [rows] = await db.query('SELECT request_hash, response_json, status_code FROM idempotency_keys WHERE id=? LIMIT 1', [idemId]);
      row = rows[0];
    } catch (_) {}
    if (!row) return { mode: 'proceed', idemId };
    if (row.request_hash && hash && row.request_hash !== hash) return { mode: 'conflict' };
    if (row.status_code != null && row.response_json != null) {
      let parsed = null; try { parsed = JSON.parse(row.response_json); } catch (_) {}
      return { mode: 'replay', statusCode: Number(row.status_code) || 200, body: parsed };
    }
    return { mode: 'conflict' };
  }
}

async function complete(db, idemId, statusCode, body) {
  if (!idemId) return;
  try { await db.query('UPDATE idempotency_keys SET response_json=?, status_code=? WHERE id=?', [JSON.stringify(body), statusCode, idemId]); }
  catch (_) {}
}

async function abort(db, idemId) {
  if (!idemId) return;
  // Only delete a still-in-progress reservation (never a completed result).
  try { await db.query('DELETE FROM idempotency_keys WHERE id=? AND status_code IS NULL', [idemId]); }
  catch (_) {}
}

module.exports = { readKey, isDupErr, stableStringify, bodyHash, reservationId, begin, complete, abort };
