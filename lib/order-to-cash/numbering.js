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

/** Coerce a Date | 'YYYY-MM-DD' | ISO string to a Date (undefined → now inside nextDocNumber). */
function _asDate(when) {
  if (when == null) return undefined;
  if (when instanceof Date) return isNaN(when.getTime()) ? undefined : when;
  const d = new Date(when);
  return isNaN(d.getTime()) ? undefined : d;
}

async function nextNumber(conn, key, when) {
  const prefix = PREFIX[key];
  if (!prefix) throw new Error(`no numbering prefix for ${key}`);
  return nextDocNumber(conn, prefix, _asDate(when));
}

module.exports = { nextNumber, PREFIX };
