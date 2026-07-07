/**
 * services/order-to-cash/CustomerMergeService.js — de-duplicate customers by an
 * explicit, audited merge (spec §Customer Master). NEVER automatic: a human with
 * customers.merge previews the impact, then applies. Apply reassigns every child
 * record (sales, ar_documents, customer_payments, ar_payment_allocations,
 * sales_orders, sales_returns) from the source to the target inside one
 * transaction, stamps source.merged_into_id, and deactivates the source. No data
 * is deleted — the source row is preserved as a tombstone pointing at the target.
 */
'use strict';

const db = require('../../db/connection');
const { err } = require('../../lib/order-to-cash/errors');
const events = require('../../lib/order-to-cash/events');
const CustomerService = require('./CustomerService');

const CHILD_TABLES = [
  ['sales', 'customer_id'],
  ['ar_documents', 'customer_id'],
  ['customer_payments', 'customer_id'],
  ['ar_payment_allocations', 'customer_id'],
  ['sales_orders', 'customer_id'],
  ['sales_returns', 'customer_id'],
];

async function preview(sourceId, targetId, conn = db) {
  if (sourceId === targetId) throw err('VALIDATION_ERROR', 'لا يمكن دمج عميل مع نفسه');
  const source = await CustomerService.get(sourceId, conn);
  const target = await CustomerService.get(targetId, conn);
  const counts = {};
  for (const [table, col] of CHILD_TABLES) {
    const [r] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${col}\` = ?`, [sourceId]);
    counts[table] = Number(r[0].n);
  }
  return {
    source: { id: source.id, name: source.name, balance: source.derived.arBalance },
    target: { id: target.id, name: target.name, balance: target.derived.arBalance },
    willReassign: counts,
    combinedBalance: source.derived.arBalance + target.derived.arBalance,
  };
}

async function apply(sourceId, targetId, actor) {
  if (sourceId === targetId) throw err('VALIDATION_ERROR', 'لا يمكن دمج عميل مع نفسه');
  return db.withTransaction(async (conn) => {
    const [s] = await conn.query('SELECT id, merged_into_id FROM customers WHERE id = ? FOR UPDATE', [sourceId]);
    if (!s.length) throw err('NOT_FOUND', 'العميل المصدر غير موجود');
    if (s[0].merged_into_id) throw err('VALIDATION_ERROR', 'العميل المصدر مدموج سابقًا');
    const [t] = await conn.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [targetId]);
    if (!t.length) throw err('NOT_FOUND', 'العميل الهدف غير موجود');

    const reassigned = {};
    for (const [table, col] of CHILD_TABLES) {
      const [r] = await conn.query(`UPDATE \`${table}\` SET \`${col}\` = ? WHERE \`${col}\` = ?`, [targetId, sourceId]);
      reassigned[table] = r.affectedRows;
    }
    await conn.query('UPDATE customers SET merged_into_id = ?, is_active = 0, updated_by = ? WHERE id = ?', [targetId, actor || '', sourceId]);
    await events.recordEvent(conn, {
      documentType: 'customer', documentId: sourceId, action: 'merge', actor,
      payload: { targetId, reassigned },
    });
    return { sourceId, targetId, reassigned };
  });
}

module.exports = { preview, apply, CHILD_TABLES };
