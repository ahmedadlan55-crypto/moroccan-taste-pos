#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/procurement/receiptTaxSnapshot');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ✅', name); }
  catch (error) { console.error('  ❌', name, '\n     ', error.message); throw error; }
}

function fakeConn(rows, onQuery) {
  return {
    async query(sql, params) {
      if (onQuery) onQuery(sql, params);
      return [rows];
    },
  };
}

(async () => {
  console.log('\n═══ Trusted GRN tax snapshots ═══');

  await test('direct receipt persists unknown tax and ignores hostile client guesses', async () => {
    let queried = false;
    const lines = [{ item_id: 'I-1', vat_rate: 99, tax_code: 'O' }];
    await T.attachTrustedTaxSnapshots(fakeConn([], () => { queried = true; }), { poId: null, lines });
    assert.equal(queried, false, 'a direct receipt has no PO tax source to query');
    assert.deepEqual({ vat_rate: lines[0].vat_rate, tax_code: lines[0].tax_code }, { vat_rate: null, tax_code: null });
  });

  await test('PO snapshot wins over malicious client VAT and preserves a non-15 rate', async () => {
    const lines = [{ po_line_id: 'L-1', item_id: 'I-1', vat_rate: 100, tax_code: 'O' }];
    let queryParams;
    await T.attachTrustedTaxSnapshots(fakeConn([
      { id: 'L-1', po_id: 'PO-1', item_id: 'I-1', vat_rate: '5.00', tax_code: 'S' },
    ], (_sql, params) => { queryParams = params; }), { poId: 'PO-1', lines });
    assert.deepEqual(queryParams, ['L-1']);
    assert.equal(lines[0].vat_rate, 5);
    assert.equal(lines[0].tax_code, 'S');
  });

  await test('zero-rated PO snapshot remains a real zero', async () => {
    const lines = [{ po_line_id: 'L-Z', item_id: 'I-Z' }];
    await T.attachTrustedTaxSnapshots(fakeConn([
      { id: 'L-Z', po_id: 'PO-Z', item_id: 'I-Z', vat_rate: 0, tax_code: 'Z' },
    ]), { poId: 'PO-Z', lines });
    assert.deepEqual({ vat_rate: lines[0].vat_rate, tax_code: lines[0].tax_code }, { vat_rate: 0, tax_code: 'Z' });
  });

  await test('PO receipt cannot omit its authoritative PO-line link', async () => {
    await assert.rejects(
      T.attachTrustedTaxSnapshots(fakeConn([]), { poId: 'PO-1', lines: [{ item_id: 'I-1' }] }),
      (error) => error.rawCode === 'VALIDATION_ERROR' && /سطر أمر الشراء/.test(error.message));
  });

  await test('a line from another PO is rejected rather than copied', async () => {
    await assert.rejects(
      T.attachTrustedTaxSnapshots(fakeConn([
        { id: 'L-1', po_id: 'PO-OTHER', item_id: 'I-1', vat_rate: 15, tax_code: 'S' },
      ]), { poId: 'PO-1', lines: [{ po_line_id: 'L-1', item_id: 'I-1' }] }),
      (error) => error.rawCode === 'VALIDATION_ERROR' && /لا ينتمي/.test(error.message));
  });

  await test('a PO-line snapshot cannot be attached to a different item', async () => {
    await assert.rejects(
      T.attachTrustedTaxSnapshots(fakeConn([
        { id: 'L-1', po_id: 'PO-1', item_id: 'I-REAL', vat_rate: 15, tax_code: 'S' },
      ]), { poId: 'PO-1', lines: [{ po_line_id: 'L-1', item_id: 'I-FAKE' }] }),
      (error) => error.rawCode === 'VALIDATION_ERROR' && /لا يطابق/.test(error.message));
  });

  await test('invalid stored tax data fails closed', async () => {
    await assert.rejects(
      T.attachTrustedTaxSnapshots(fakeConn([
        { id: 'L-1', po_id: 'PO-1', item_id: 'I-1', vat_rate: 150, tax_code: 'S' },
      ]), { poId: 'PO-1', lines: [{ po_line_id: 'L-1', item_id: 'I-1' }] }),
      (error) => error.rawCode === 'TAX_CONFIGURATION_ERROR');
    assert.throws(() => T.normalizeStoredTax({ vat_rate: 0, tax_code: 'GUESS' }),
      (error) => error.rawCode === 'TAX_CONFIGURATION_ERROR');
  });

  await test('receipt writer stores both snapshots and calls trust resolver before INSERT', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'procurement', 'receipts.js'), 'utf8');
    const attach = source.indexOf('attachTrustedTaxSnapshots');
    const insert = source.indexOf('INSERT INTO purchase_receipt_lines');
    assert(attach >= 0 && insert > attach);
    assert.match(source.slice(insert, insert + 900), /base_unit_cost,\s*vat_rate, tax_code, warehouse_id/);
    assert.match(source.slice(insert, insert + 1300), /l\.vat_rate, l\.tax_code, l\.warehouse_id/);
  });

  console.log(`\nprocurementReceiptTaxSnapshot: ${passed}/${passed} passed`);
})().catch(() => { process.exitCode = 1; });
