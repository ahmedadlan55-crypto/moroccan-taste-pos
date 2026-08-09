'use strict';

const { parseItemsSnapshot, historicalInvoiceItems } = require('../lib/invoiceReprint');

let passed = 0;
let failed = 0;
function check(name, condition, details) {
  if (condition) {
    passed++;
    console.log('  PASS', name);
  } else {
    failed++;
    console.error('  FAIL', name, details || '');
  }
}

console.log('\ninvoice reprint snapshot');

check('invalid/empty JSON is unavailable, not a fabricated empty invoice',
  parseItemsSnapshot('{broken') === null && parseItemsSnapshot('[]') === null);

const snapshot = JSON.stringify([{
  name: 'Historical burger', qty: 2, price: 19, total: 38,
  lineDiscount: 3, vatCategory: 'Z', taxInclusive: true,
  notes: 'No onions', enteredUnitId: 'U-BOX', enteredUnitCode: 'BOX',
  enteredUnitName: 'Box', enteredQty: 1, conversionFactorSnapshot: 2, baseQty: 2,
}]);
const staleProjection = [{ item_name: 'Today renamed burger', qty: 9, price: 99, total: 891 }];
const frozen = historicalInvoiceItems(snapshot, staleProjection, { 0: 'AR-LINE-1' });

check('items_json wins over the narrow/live projection',
  frozen[0].name === 'Historical burger' && frozen[0].qty === 2 && frozen[0].price === 19,
  frozen[0]);
check('historical UOM, note, tax convention and discount survive',
  frozen[0].enteredUnitCode === 'BOX' && frozen[0].enteredQty === 1 &&
  frozen[0].notes === 'No onions' && frozen[0].vatCategory === 'Z' &&
  frozen[0].taxInclusive === true && frozen[0].lineDiscount === 3,
  frozen[0]);
check('O2C line identity still follows the original ordinal', frozen[0].lineId === 'AR-LINE-1');

const legacy = historicalInvoiceItems(null, staleProjection, {});
check('pre-snapshot/corrupt invoice falls back without inventing detail',
  legacy.length === 1 && legacy[0].name === 'Today renamed burger' &&
  legacy[0].qty === 9 && !Object.prototype.hasOwnProperty.call(legacy[0], 'notes'),
  legacy[0]);

console.log(`invoiceReprint: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
