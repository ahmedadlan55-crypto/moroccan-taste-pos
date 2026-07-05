/**
 * lib/procurement/events.js — procurement_events domain log + idempotency
 * replay. Every state transition writes exactly one event in the same
 * transaction as the change. The UNIQUE(document_type, idempotency_key) makes a
 * retried mutation with the same Idempotency-Key a safe no-op replay.
 */
'use strict';

function _genId() {
  return 'PE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

async function findByIdempotency(conn, documentType, idempotencyKey) {
  if (!idempotencyKey) return null;
  const [rows] = await conn.query(
    'SELECT * FROM procurement_events WHERE document_type = ? AND idempotency_key = ? LIMIT 1',
    [documentType, idempotencyKey]);
  return rows[0] || null;
}

async function recordEvent(conn, {
  documentType, documentId, action, fromStatus = null, toStatus = null,
  actor = null, idempotencyKey = null, payload = null, glJournalId = null,
}) {
  const id = _genId();
  await conn.query(
    `INSERT INTO procurement_events
       (id, document_type, document_id, action, from_status, to_status, actor, idempotency_key, payload, gl_journal_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, documentType, documentId, action, fromStatus, toStatus, actor, idempotencyKey,
     payload != null ? JSON.stringify(payload) : null, glJournalId]);
  return { id, documentType, documentId, action, fromStatus, toStatus, actor, glJournalId };
}

async function timeline(conn, documentType, documentId) {
  const [rows] = await conn.query(
    'SELECT id, action, from_status, to_status, actor, gl_journal_id, created_at FROM procurement_events WHERE document_type = ? AND document_id = ? ORDER BY created_at ASC, id ASC',
    [documentType, documentId]);
  return rows;
}

module.exports = { findByIdempotency, recordEvent, timeline };
