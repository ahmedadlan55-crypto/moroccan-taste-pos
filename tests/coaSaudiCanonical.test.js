#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const chart = require('../db/coa-saudi-canonical');
const { ROLE_CATALOG } = require('../lib/accountRoleCatalog');
const { CORE_ACCOUNTS } = require('../lib/glPosting');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'db/migrations/0036_coa_saudi_canonical_rebuild.sql'), 'utf8');
const byCode = new Map(chart.map((row) => [row.code, row]));
let passed = 0;
const failures = [];
function check(name, value, detail) {
  if (value) { passed += 1; return; }
  failures.push(name + (detail === undefined ? '' : ` → ${JSON.stringify(detail)}`));
  console.error('  ✗ ' + name);
}

check('chart is concise enough for a controlled ERP ledger', chart.length <= 150, chart.length);
check('chart has exactly five roots', chart.filter((row) => !row.parentCode).length === 5);
check('all codes are six digits', chart.every((row) => /^\d{6}$/.test(row.code)));
check('all levels are 1..4', chart.every((row) => row.level >= 1 && row.level <= 4));
check('all folders have children', chart.filter((row) => row.kind === 'folder').every(
  (row) => chart.some((child) => child.parentCode === row.code)));
check('no posting leaf owns children', chart.filter((row) => row.kind === 'leaf').every(
  (row) => !chart.some((child) => child.parentCode === row.code)));
check('all parents exist and share the account type', chart.every((row) => !row.parentCode || (
  byCode.has(row.parentCode) && byCode.get(row.parentCode).type === row.type)));

const assignedRoles = new Map();
for (const row of chart) for (const role of row.roles) assignedRoles.set(role, row);
const missingRoles = Object.keys(ROLE_CATALOG).filter((role) => !assignedRoles.has(role));
const extraRoles = [...assignedRoles.keys()].filter((role) => !ROLE_CATALOG[role]);
check('every posting role has one canonical target', missingRoles.length === 0 && extraRoles.length === 0,
  { missingRoles, extraRoles });
const invalidRoleTargets = [...assignedRoles].filter(([role, row]) => {
  const definition = ROLE_CATALOG[role];
  return row.kind !== 'leaf' || !definition.allowedTypes.includes(row.type) ||
    (definition.taxNature && definition.taxNature !== row.taxNature);
});
check('role targets satisfy type, posting and tax contracts', invalidRoleTargets.length === 0,
  invalidRoleTargets.map(([role, row]) => `${role}→${row.code}`));

const invalidCore = Object.entries(CORE_ACCOUNTS).filter(([, core]) => {
  const row = byCode.get(core.code);
  return !row || row.kind !== 'leaf' || row.type !== core.type || row.parentCode !== core.parent;
});
check('every runtime core account is a canonical posting leaf', invalidCore.length === 0,
  invalidCore.map(([name, core]) => `${name}→${core.code}`));

check('migration archives instead of deleting ledger history',
  !/DELETE\s+FROM\s+gl_accounts|DELETE\s+FROM\s+gl_entries|UPDATE\s+gl_entries/i.test(migration));
check('migration has explicit aliases and transparent fallback mapping',
  /account_code_aliases/.test(migration) && /class fallback for unmapped legacy account/.test(migration));
check('migration handles a zero-balance transition as posted',
  /LEFT JOIN \([\s\S]*COALESCE\(totals\.debit_total,0\)/.test(migration));
check('migration fails closed on structure and balance invariants',
  /0036_invalid_active_chart/.test(migration) && /COA36-TRANSITION/.test(migration));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`✅ canonical Saudi/IFRS CoA: ${chart.length} accounts, ${assignedRoles.size} governed roles`);
