#!/usr/bin/env node
'use strict';

/** Contract: custody detail belongs to the custody/employee subledger. */
const fs = require('fs');
const path = require('path');
const { CORE_ACCOUNTS } = require('../lib/glPosting');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const custody = read('routes/custody.js');
const erp = read('routes/erp.js');
let passed = 0;
const failures = [];
function check(name, value) {
  if (value) { passed += 1; return; }
  failures.push(name);
  console.error('  ✗ ' + name);
}

check('custody uses the canonical employee advances control',
  CORE_ACCOUNTS.EMPLOYEE_ADVANCES.code === '112300');
check('custody control is outside the inventory namespace',
  !CORE_ACCOUNTS.EMPLOYEE_ADVANCES.code.startsWith('113'));
check('the compatibility helper returns the control account instead of inserting a child',
  /does not create a child per employee/.test(custody) &&
  !/CUSTODY_CHILD_PREFIX/.test(custody));
check('custody never inserts a gl_accounts row',
  !/INSERT(?:\s+IGNORE)?\s+INTO\s+gl_accounts/i.test(custody));
check('custody topups and expenses resolve the one control code',
  (custody.match(/CUSTODY_CONTROL_CODE/g) || []).length >= 4);
check('custody module exports only the defined canonical control code',
  custody.includes('module.exports.CUSTODY_GROUP_CODE = CUSTODY_CONTROL_CODE;') &&
  custody.includes('module.exports.CUSTODY_CONTROL_CODE = CUSTODY_CONTROL_CODE;') &&
  !custody.includes('module.exports.CUSTODY_GROUP_CODE = CUSTODY_GROUP_CODE;'));
check('ERP historic-topup repair cannot mint employee accounts',
  !/'GL-1130'|'11301'|code LIKE '1130%'/i.test(erp.slice(
    erp.indexOf("router.post('/gl/repair-topups'"),
    erp.indexOf('// ─── Cost Centers', erp.indexOf("router.post('/gl/repair-topups'")))));
check('ERP historic-topup repair fails closed without the control account',
  /CUSTODY_CONTROL_ACCOUNT_MISSING/.test(erp));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log('✅ custody is a subledger behind control account 112300');
