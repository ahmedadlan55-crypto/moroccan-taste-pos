/**
 * services/order-to-cash/TransitionExecutor.js
 *
 * Generic, safe executor for every O2C state transition. One call =
 *   1 transaction · idempotency replay · FOR UPDATE lock · state-machine guard
 *   · optimistic version check (conditional UPDATE) · side effects (GL/AR/stock)
 *   · one ar_events row · full rollback on any failure.
 *
 * RBAC (requireCapability) + branch/warehouse scope are enforced at the route
 * layer BEFORE this runs; here we own the atomicity + concurrency invariants.
 * Actor is ALWAYS supplied from the JWT by the route — never the request body.
 */
'use strict';

const db = require('../../db/connection');
const SM = require('../../lib/order-to-cash/stateMachine');
const events = require('../../lib/order-to-cash/events');
const { err } = require('../../lib/order-to-cash/errors');

async function runTransition(o) {
  const {
    docType, table, id, action, actor, actorId,
    expectedVersion, idempotencyKey, actorColumns, perform,
    statusColumn = 'status', versionColumn = 'version',
  } = o;

  async function replay(conn) {
    const prior = await events.findByIdempotency(conn, docType, idempotencyKey);
    if (!prior) return null;
    const [cur] = await conn.query(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
    const row = cur[0] || {};
    return {
      replayed: true, row, toStatus: prior.to_status,
      newVersion: row[versionColumn] != null ? Number(row[versionColumn]) : null,
      result: { journalIds: prior.gl_journal_id ? [prior.gl_journal_id] : [] },
      event: prior,
    };
  }

  try {
    return await _run();
  } catch (e) {
    // Concurrent same-key race: the loser rolled back (state-machine reject or
    // UNIQUE(entity_type, idempotency_key) on the event INSERT). If a prior event
    // for this key now exists, the operation already succeeded → clean replay.
    if (idempotencyKey) {
      const r = await replay(db);
      if (r) return r;
    }
    throw e;
  }

  function _run() {
    return db.withTransaction(async (conn) => {
      // 1. idempotency replay
      if (idempotencyKey) {
        const prior = await events.findByIdempotency(conn, docType, idempotencyKey);
        if (prior) {
          const [cur] = await conn.query(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
          const row = cur[0] || {};
          return {
            replayed: true, row, toStatus: prior.to_status,
            newVersion: row[versionColumn] != null ? Number(row[versionColumn]) : null,
            result: { journalIds: prior.gl_journal_id ? [prior.gl_journal_id] : [] },
            event: prior,
          };
        }
      }

      // 2. lock the document row
      const [rows] = await conn.query(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [id]);
      if (!rows.length) throw err('NOT_FOUND', 'المستند غير موجود');
      const row = rows[0];
      const fromStatus = row[statusColumn];

      // 3. optimistic concurrency
      if (expectedVersion != null && expectedVersion !== '' && Number(row[versionColumn]) !== Number(expectedVersion)) {
        throw err('VERSION_CONFLICT', 'تغيّر المستند منذ آخر قراءة، أعد التحميل');
      }

      // 4. state-machine guard
      const toStatus = SM.next(docType, fromStatus, action);

      // 5. side effects (GL / AR / stock)
      const result = (await perform(conn, row, toStatus)) || {};

      // 6. conditional UPDATE (version bump + actor stamp + extra sets)
      const sets = [`\`${statusColumn}\` = ?`, `\`${versionColumn}\` = \`${versionColumn}\` + 1`];
      const params = [toStatus];
      if (actorColumns && actorColumns.by) { sets.push(`\`${actorColumns.by}\` = ?`); params.push(actor || ''); }
      if (actorColumns && actorColumns.at) { sets.push(`\`${actorColumns.at}\` = NOW()`); }
      for (const [col, val] of Object.entries(result.extraSets || {})) { sets.push(`\`${col}\` = ?`); params.push(val); }
      params.push(id, Number(row[versionColumn]));
      const [upd] = await conn.query(
        `UPDATE \`${table}\` SET ${sets.join(', ')} WHERE id = ? AND \`${versionColumn}\` = ?`, params);
      if (upd.affectedRows === 0) throw err('VERSION_CONFLICT', 'تغيّر المستند أثناء المعالجة');

      // 7. audit event (also the idempotency record)
      const journalIds = Array.isArray(result.journalIds) ? result.journalIds : [];
      const event = await events.recordEvent(conn, {
        documentType: docType, documentId: id, action, fromStatus, toStatus,
        actor, actorId, idempotencyKey, payload: result.payload || null, glJournalId: journalIds[0] || null,
      });

      return { replayed: false, row, fromStatus, toStatus, newVersion: Number(row[versionColumn]) + 1, result, event };
    });
  }
}

module.exports = { runTransition };
