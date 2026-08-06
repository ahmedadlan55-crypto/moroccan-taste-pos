#!/usr/bin/env node
'use strict';

/** Contract: one inventory control account; detail stays in the subledger. */
const fs = require('fs');
const path = require('path');
const { CORE_ACCOUNTS } = require('../lib/glPosting');
const chart = require('../db/coa-saudi-canonical');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('db/migrations/0036_coa_saudi_canonical_rebuild.sql');
const erp = read('routes/erp.js');
const server = read('server.js');
let passed = 0;
const failures = [];
function check(name, value, detail) {
  if (value) { passed += 1; return; }
  failures.push(name + (detail === undefined ? '' : ` → ${JSON.stringify(detail)}`));
  console.error('  ✗ ' + name);
}

for (const name of ['INVENTORY', 'BRANCH_INVENTORY', 'WIP', 'FINISHED_GOODS']) {
  check(`${name} resolves to 113100`, CORE_ACCOUNTS[name].code === '113100', CORE_ACCOUNTS[name]);
  check(`${name} is under 113000`, CORE_ACCOUNTS[name].parent === '113000', CORE_ACCOUNTS[name]);
}
check('operational aliases do not create GL accounts',
  ['BRANCH_INVENTORY', 'WIP', 'FINISHED_GOODS'].every((name) => CORE_ACCOUNTS[name].aliasOf === 'INVENTORY'));

const inventoryLeaves = chart.filter((row) => row.kind === 'leaf' && row.reportSection === 'inventory');
check('canonical chart contains one inventory posting leaf',
  inventoryLeaves.length === 1 && inventoryLeaves[0].code === '113100', inventoryLeaves);
check('inventory folder is structural and non-postable',
  chart.some((row) => row.code === '113000' && row.kind === 'folder'));
check('template contains no account per warehouse, item or production stage',
  !chart.some((row) => /warehouse|branch inventory|raw material inventory|finished goods inventory|work in progress/i.test(row.nameEn)));
check('runtime repair points at the canonical inventory folder',
  /INVENTORY_GROUP_CODE\s*=\s*'113000'/.test(erp));
check('runtime repair never creates a chart account',
  !/INSERT(?:\s+IGNORE)?\s+INTO\s+gl_accounts/i.test(erp.slice(
    erp.indexOf('async function _repairInventoryClassification'),
    erp.indexOf('router._repairInventoryClassification'))));
check('boot no longer revives the four old inventory posting codes as a set',
  !/code IN \('1200','1210','1220','1230'\)/.test(server));

check('canonical migration never deletes accounts or posted ledger entries',
  !/DELETE\s+FROM\s+gl_accounts|DELETE\s+FROM\s+gl_entries|UPDATE\s+gl_entries/i.test(migration));
check('legacy accounts are archived with audit metadata',
  /status='archived'/.test(migration) && /archived_by='migration:0036'/.test(migration));
check('balances move through one auditable transition journal',
  /COA36-TRANSITION/.test(migration) && /status='posted'/.test(migration));
check('migration asserts exactly one postable inventory account',
  /report_section='inventory' AND is_postable=1\)<>1/.test(migration));
check('old codes remain usable as aliases', /INSERT INTO account_code_aliases/.test(migration));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ one inventory control account (113100); operational detail remains in dimensions');
