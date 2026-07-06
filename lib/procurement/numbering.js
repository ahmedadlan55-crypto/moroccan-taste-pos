/**
 * lib/procurement/numbering.js — document numbering for the P2P cycle.
 * Thin wrapper over lib/docNumber.js (atomic doc_counters). MUST be called with
 * the transaction connection so numbering is atomic with the document insert.
 */
'use strict';

const { nextDocNumber } = require('../docNumber');

const PREFIX = {
  po: 'PO',
  grn: 'GRN',
  supplier_invoice: 'SINV',
  payment: 'PPAY',
  return: 'PRET',
};

async function nextNumber(conn, docType, when) {
  const prefix = PREFIX[docType];
  if (!prefix) throw new Error(`no numbering prefix for ${docType}`);
  return nextDocNumber(conn, prefix, when);
}

module.exports = { nextNumber, PREFIX };
