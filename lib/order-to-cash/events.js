/**
 * lib/order-to-cash/events.js — ar_events domain log + idempotency replay.
 * Every state transition writes exactly one event in the same transaction as the
 * change. UNIQUE(entity_type, idempotency_key) makes a retried mutation with the
 * same Idempotency-Key a safe no-op replay. Param names mirror the procurement
 * events module (documentType/documentId) so the forked TransitionExecutor stays
 * byte-compatible; they map to ar_events.entity_type / entity_id.
 */
'use strict';

const { err } = require('./errors');

function _genId() {
  return 'ARE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * The idempotency scope a key lives in. Before scoping, the UNIQUE was
 * (entity_type, idempotency_key) — one key per DOCUMENT TYPE, globally. So a
 * client reusing one key across approve→post got the approve event replayed
 * as if it were the post (HTTP 200, no credit note, no stock, no GL), and one
 * key across two different returns replayed the first's status onto the
 * second. Transitions scope to the exact document + action; creates scope to
 * '' because the client cannot know the id of a document that does not exist
 * yet — which also matches the storage reality that uq_ret_idem/uq_ar_idem/
 * uq_pay_idem are GLOBAL single-column uniques on the doc tables (branch
 * separation is the client's key-choice job; a branch-scoped event key would
 * contradict those uniques and strand cross-branch reuse on a 500).
 */
function scopeOf(documentType, action, documentId) {
  return `${documentType}:${action}:${action === 'create' ? '' : (documentId || '')}`;
}

async function findByIdempotency(conn, documentType, idempotencyKey, action, documentId) {
  if (!idempotencyKey) return null;
  // Callers that predate scoping (none in-repo, but the procurement fork
  // mirrors this signature) fall back to the legacy entity_type match.
  if (!action) {
    const [rows] = await conn.query(
      'SELECT * FROM ar_events WHERE entity_type = ? AND idempotency_key = ? LIMIT 1',
      [documentType, idempotencyKey]);
    return rows[0] || null;
  }
  const [rows] = await conn.query(
    'SELECT * FROM ar_events WHERE event_scope = ? AND idempotency_key = ? LIMIT 1',
    [scopeOf(documentType, action, documentId), idempotencyKey]);
  return rows[0] || null;
}

async function recordEvent(conn, {
  documentType, documentId, action, fromStatus = null, toStatus = null,
  actor = null, actorId = null, idempotencyKey = null, requestHash = null,
  payload = null, glJournalId = null,
}) {
  const id = _genId();
  await conn.query(
    `INSERT INTO ar_events
       (id, entity_type, entity_id, event_type, event_scope, from_status, to_status, actor_id, actor_username, idempotency_key, request_hash, payload_json, gl_journal_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, documentType, documentId, action, scopeOf(documentType, action, documentId),
     fromStatus, toStatus, actorId, actor, idempotencyKey, requestHash || null,
     payload != null ? JSON.stringify(_redact(payload)) : null, glJournalId]);
  return { id, entity_type: documentType, entity_id: documentId, event_type: action, from_status: fromStatus, to_status: toStatus, actor_username: actor, gl_journal_id: glJournalId };
}

/**
 * Prior-event lookup with the payload-fingerprint guard, for operations that
 * live OUTSIDE runTransition (creates, advance allocation). Returns the prior
 * event to replay, null to proceed, or throws 409 when the same key arrives
 * with a different payload. Callers racing on a UNIQUE must call this on the
 * POOL after ER_DUP_ENTRY — the failed transaction's REPEATABLE READ snapshot
 * predates the winner's commit and would miss it.
 */
async function findPrior(conn, documentType, action, documentId, idempotencyKey, requestHash) {
  if (!idempotencyKey) return null;
  const prior = await findByIdempotency(conn, documentType, idempotencyKey, action, documentId);
  if (!prior) return null;
  if (prior.request_hash && requestHash && prior.request_hash !== requestHash) {
    throw err('IDEMPOTENCY_KEY_REUSED', 'مفتاح Idempotency مُعاد استخدامه بمحتوى مختلف');
  }
  return prior;
}

/**
 * Replay envelope for a stored event: journalIds come from the recorded
 * payload when present (a post can produce MORE than one journal — the single
 * gl_journal_id column under-reports), falling back to gl_journal_id for
 * events that predate the payload contract. payload_json parse is guarded —
 * approve/cancel events legitimately store NULL.
 */
function replayEnvelope(prior) {
  let payload = null;
  try { payload = prior.payload_json ? JSON.parse(prior.payload_json) : null; } catch (_) { payload = null; }
  const journalIds = payload && Array.isArray(payload.journalIds) && payload.journalIds.length
    ? payload.journalIds
    : (prior.gl_journal_id ? [prior.gl_journal_id] : []);
  return { journalIds, payload };
}

async function timeline(conn, entityType, entityId) {
  const [rows] = await conn.query(
    `SELECT id, event_type, from_status, to_status, actor_username, gl_journal_id, created_at
       FROM ar_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC, id ASC`,
    [entityType, entityId]);
  return rows;
}

// Strip anything that looks like a secret before persisting a payload snapshot.
function _redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (/pass|secret|token|jwt|authorization|card|cvv|iban|pin/i.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = v && typeof v === 'object' ? _redact(v) : v;
  }
  return out;
}

module.exports = { findByIdempotency, findPrior, recordEvent, timeline, scopeOf, replayEnvelope };
