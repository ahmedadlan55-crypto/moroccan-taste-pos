/**
 * lib/order-to-cash/numbering.js — document numbering for the O2C cycle.
 * Thin wrapper over lib/docNumber.js (atomic doc_counters). MUST be called with
 * the transaction connection so numbering is atomic with the document insert.
 */
'use strict';

const { nextDocNumber } = require('../docNumber');

const PREFIX = {
  sales_order: 'SO',
  invoice: 'SI',
  debit_note: 'DN',
  credit_note: 'CN',
  customer_payment: 'CR',
  sales_return: 'SRET',
};

async function nextNumber(conn, key, when) {
  const prefix = PREFIX[key];
  if (!prefix) throw new Error(`no numbering prefix for ${key}`);
  return nextDocNumber(conn, prefix, when);
}

module.exports = { nextNumber, PREFIX };
