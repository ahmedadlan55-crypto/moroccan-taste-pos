/**
 * lib/order-to-cash/events.js — ar_events domain log + idempotency replay.
 * Every state transition writes exactly one event in the same transaction as the
 * change. UNIQUE(entity_type, idempotency_key) makes a retried mutation with the
 * same Idempotency-Key a safe no-op replay. Param names mirror the procurement
 * events module (documentType/documentId) so the forked TransitionExecutor stays
 * byte-compatible; they map to ar_events.entity_type / entity_id.
 */
'use strict';

function _genId() {
  return 'ARE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

async function findByIdempotency(conn, entityType, idempotencyKey) {
  if (!idempotencyKey) return null;
  const [rows] = await conn.query(
    'SELECT * FROM ar_events WHERE entity_type = ? AND idempotency_key = ? LIMIT 1',
    [entityType, idempotencyKey]);
  return rows[0] || null;
}

async function recordEvent(conn, {
  documentType, documentId, action, fromStatus = null, toStatus = null,
  actor = null, actorId = null, idempotencyKey = null, payload = null, glJournalId = null,
}) {
  const id = _genId();
  await conn.query(
    `INSERT INTO ar_events
       (id, entity_type, entity_id, event_type, from_status, to_status, actor_id, actor_username, idempotency_key, payload_json, gl_journal_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, documentType, documentId, action, fromStatus, toStatus, actorId, actor, idempotencyKey,
     payload != null ? JSON.stringify(_redact(payload)) : null, glJournalId]);
  return { id, entity_type: documentType, entity_id: documentId, event_type: action, from_status: fromStatus, to_status: toStatus, actor_username: actor, gl_journal_id: glJournalId };
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

module.exports = { findByIdempotency, recordEvent, timeline };
