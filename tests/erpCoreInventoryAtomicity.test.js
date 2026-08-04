'use strict';

// Fast source-contract gate for the two legacy endpoints that can move both
// inventory and money. Integration coverage lives in wasteEntries.api.test.js;
// this guard prevents the old split-commit / destructive-delete shapes from
// being reintroduced unnoticed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'erp-core.js'), 'utf8');

function between(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `route section missing: ${start}`);
  return source.slice(a, b);
}

const reverseWaste = between("router.delete('/waste-entries/:id'", "router.post('/waste-entries'");
assert.match(reverseWaste, /db\.withTransaction\(async \(conn\)/, 'waste reversal must be transactional');
assert.match(reverseWaste, /WasteEntryReversal/, 'waste reversal must append a compensating journal');
assert.match(reverseWaste, /reversed_by_journal_id/, 'original/reversal journals must be linked');
assert.doesNotMatch(reverseWaste, /DELETE FROM (?:waste_entries|waste_entry_items|gl_entries|gl_journals)/,
  'posted waste evidence and GL rows must never be deleted');

const createWaste = between("router.post('/waste-entries'", "router.get('/waste-entries/:id/items'");
assert.match(createWaste, /gl\.postJournal\(conn,/, 'waste GL must share the stock transaction connection');
assert.match(createWaste, /CORE_ACCOUNTS\.WASTE_EXPENSE\.code/, 'waste must use the unified expense account');
assert.match(createWaste, /CORE_ACCOUNTS\.INVENTORY\.code/, 'waste must use the single 1200 inventory control account');
assert.match(createWaste, /ws\.avg_cost/, 'waste valuation must come from server-side warehouse WAC');
assert.doesNotMatch(createWaste, /Number\(it\.unitCost\)/, 'client-supplied waste cost must not be trusted');
assert.doesNotMatch(createWaste, /postingWarning/, 'GL failure must roll the entire waste transaction back');

const receipt = between("router.post('/purchase-receipts'", '// Helper: detect optional dimension columns');
assert.match(receipt, /db\.withTransaction\(async \(conn\)/, 'receipt must be transactional');
assert.match(receipt, /gl\.postJournal\(conn,/, 'receipt GL must share the stock transaction connection');
assert.match(receipt, /CORE_ACCOUNTS\.INVENTORY\.code/, 'receipt must use the single 1200 inventory account');
assert.match(receipt, /warehouse_stock/, 'receipt must update per-warehouse stock');
assert.match(receipt, /reference_type, reference_id/, 'receipt must write the standard inventory ledger shape');
assert.match(receipt, /req\.user && req\.user\.username/, 'receipt audit actor must come from JWT');
assert.doesNotMatch(receipt, /txn_type|received_quantity|postingWarning/,
  'dead legacy columns and non-fatal GL warnings must not return');

console.log('erpCoreInventoryAtomicity: 18/18 contract checks passed');
