#!/usr/bin/env node
'use strict';

/**
 * Canonical General Ledger parity gate.
 *
 * Pure fake-DB tests: no development data is read or mutated. The assertions
 * pin the accounting contract shared with Trial Balance after migration 0036:
 * canonical account mapping, one opening boundary, posting-leaf drill-down,
 * lifecycle filtering, and stable running-balance ordering.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ledger = require('../lib/reports/glLedger');

let passed = 0;
let failed = 0;
let chain = Promise.resolve();

function test(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  \u2713 ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  \u2717 ${name}`);
      console.error(`    ${error && error.stack ? error.stack : error}`);
    }
  });
}

function fakeDb(responses) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params: params || [] });
      if (index >= responses.length) throw new Error(`unexpected query #${index + 1}`);
      return [responses[index++]];
    },
  };
}

function account(id, parentId, overrides) {
  return Object.assign({
    id,
    code: id,
    name_ar: id,
    name_en: id,
    type: 'asset',
    parent_id: parentId || null,
    is_folder: 0,
    display_order: 1,
    level: parentId ? 2 : 1,
    report_section: 'other_assets',
    normal_balance: 'debit',
    is_contra: 0,
    cash_flow_activity: null,
    status: 'active',
    is_active: 1,
  }, overrides || {});
}

function entry(id, accountId, debit, credit, date) {
  const journalDate = date || '2026-01-15';
  return {
    id,
    journal_id: `J-${id}`,
    account_id: accountId,
    source_account_id: accountId,
    debit,
    credit,
    entry_desc: `entry ${id}`,
    description: `entry ${id}`,
    journal_number: `JV-${id}`,
    journal_date: journalDate,
    journal_desc: `journal ${id}`,
    reference_type: 'manual',
    reference_id: `REF-${id}`,
    created_by: 'accountant',
    created_at: `${journalDate} 10:00:00`,
    cursor_date: journalDate,
    cursor_created_at: `${journalDate} 10:00:00.000000`,
  };
}

function normalized(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

console.log('\nGeneral Ledger canonical parity gate');

test('parent drill-down returns posting descendants once and never double-counts folders', async () => {
  const db = fakeDb([
    [
      account('ROOT', null, { is_folder: 1, level: 1 }),
      account('MID', 'ROOT', { is_folder: 0, level: 2 }),
      account('A', 'MID', { level: 3 }),
      account('B', 'ROOT', { level: 2 }),
    ],
    [
      { account_id: 'A', d: 100, c: 20 },
      { account_id: 'B', d: 0, c: 80 },
    ],
    [
      entry('1', 'A', 10, 0),
      entry('2', 'B', 0, 10),
    ],
  ]);

  const result = await ledger.getMultiLedger(db, {
    from: '2026-01-01',
    to: '2026-01-31',
    parent: 'ROOT',
    scope: 'active',
  });

  assert.deepEqual(result.sections.map((section) => section.accountId), ['A', 'B']);
  assert.deepEqual(result.sections.map((section) => section.opening), [80, -80]);
  assert.equal(result.grandTotals.accountCount, 2);
  assert.equal(result.grandTotals.opening, 0);
  assert.equal(result.grandTotals.debit, 10);
  assert.equal(result.grandTotals.credit, 10);
  assert.equal(result.grandTotals.closing, 0);

  const treeSql = normalized(db.calls[0].sql);
  assert.match(treeSql, /WITH RECURSIVE requested_tree/i);
  assert.match(treeSql, /UNION DISTINCT/i);
  assert.match(treeSql, /LEFT JOIN coa_0036_account_map seed_map/i);
  assert.deepEqual(db.calls[0].params, ['CO-MAIN', 'ROOT']);

  const openingSql = normalized(db.calls[1].sql);
  const movementSql = normalized(db.calls[2].sql);
  assert.match(openingSql, /LEFT JOIN coa_0036_account_map coa_map/i);
  assert.match(openingSql, /j\.id <> \?/i);
  assert.match(openingSql, /reference_type = 'opening'.*journal_date <= \?.*reference_type IS NULL OR j\.reference_type <> 'opening'.*journal_date < \?/i);
  assert.match(movementSql, /reference_type IS NULL OR j\.reference_type <> 'opening'/i);
  assert.match(movementSql, /ORDER BY COALESCE\(coa_map\.target_account_id, e\.account_id\), j\.journal_date ASC/i);
  assert.equal(db.calls[1].params.includes('COA36-TRANSITION'), true);
  assert.equal(db.calls[2].params.includes('COA36-TRANSITION'), true);
});

test('single-account opening and period boundaries reconcile exactly', async () => {
  const db = fakeDb([
    [account('A', 'ROOT', { code: '111100', level: 3, company_id: 'CO-MAIN' })],
    [{ d: 100, c: 20 }],
    [{ d: 10, c: 3, count: 1 }],
    [entry('1', 'A', 10, 3)],
  ]);

  // A legacy source id must resolve to its canonical destination before any
  // balance query; otherwise an archived account link opens an empty ledger.
  const result = await ledger.getAccountLedger(db, 'OLD-A', {
    startDate: '2026-01-01',
    endDate: '2026-01-31',
  });

  assert.equal(result.opening, 80);
  assert.deepEqual(result.totals, { debit: 10, credit: 3, net: 7, count: 1 });
  assert.equal(result.closing, 87);
  assert.equal(result.ledger[0].balance, 87);

  const identitySql = normalized(db.calls[0].sql);
  assert.match(identitySql, /LEFT JOIN coa_0036_account_map seed_map/i);
  assert.match(identitySql, /canonical\.id = COALESCE\(seed_map\.target_account_id, requested\.id\)/i);
  assert.deepEqual(db.calls[0].params, ['OLD-A', 'CO-MAIN', 'CO-MAIN']);

  const openingSql = normalized(db.calls[1].sql);
  assert.match(openingSql, /COALESCE\(coa_map\.target_account_id, e\.account_id\) = \?/i);
  assert.match(openingSql, /reference_type = 'opening'.*journal_date <= \?.*reference_type IS NULL OR j\.reference_type <> 'opening'.*journal_date < \?/i);
  assert.deepEqual(db.calls[1].params, ['A', 'COA36-TRANSITION', '2026-01-01', '2026-01-01']);

  for (const call of db.calls.slice(2)) {
    const sql = normalized(call.sql);
    assert.match(sql, /LEFT JOIN coa_0036_account_map coa_map/i);
    assert.match(sql, /j\.id <> \?/i);
    assert.match(sql, /reference_type IS NULL OR j\.reference_type <> 'opening'/i);
    assert.match(sql, /j\.journal_date >= \?.*j\.journal_date <= \?/i);
    assert.equal(call.params.includes('COA36-TRANSITION'), true);
  }
});

test('main means folder-or-parent, sub means structural posting leaf', async () => {
  const chart = [
    account('ROOT', null, { is_folder: 1, level: 1 }),
    account('MID', 'ROOT', { is_folder: 0, level: 2 }),
    account('LEAF', 'MID', { level: 3 }),
  ];

  const mainDb = fakeDb([
    chart,
    [{ account_id: 'MID', d: 5, c: 0 }],
    [],
  ]);
  const main = await ledger.getMultiLedger(mainDb, {
    from: '2026-01-01', to: '2026-01-31', scope: 'active', accType: 'main',
  });
  assert.deepEqual(main.sections.map((section) => section.accountId), ['MID']);
  assert.deepEqual(mainDb.calls[1].params.slice(0, 2), ['ROOT', 'MID']);
  assert.match(normalized(mainDb.calls[0].sql), /a\.status = 'active' AND a\.is_active = 1/i);

  const leafDb = fakeDb([
    chart,
    [{ account_id: 'LEAF', d: 5, c: 0 }],
    [],
  ]);
  const sub = await ledger.getMultiLedger(leafDb, {
    from: '2026-01-01', to: '2026-01-31', scope: 'leaf', accType: 'sub',
  });
  assert.deepEqual(sub.sections.map((section) => section.accountId), ['LEAF']);
  assert.equal(leafDb.calls[1].params[0], 'LEAF');
  assert.match(normalized(leafDb.calls[0].sql), /a\.status = 'active' AND a\.is_active = 1/i);
});

test('scope=all keeps its explicit audit boundary instead of silently applying active lifecycle', async () => {
  const db = fakeDb([[],]);
  const result = await ledger.getMultiLedger(db, {
    from: '2026-01-01', to: '2026-01-31', scope: 'all',
  });
  assert.equal(result.sections.length, 0);
  assert.doesNotMatch(normalized(db.calls[0].sql), /a\.status = 'active'/i);
  assert.doesNotMatch(normalized(db.calls[0].sql), /a\.is_active = 1/i);
});

test('Trial Balance projects the same canonical accounts and excludes the transfer journal', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/reports/trialBalance.js'), 'utf8');
  assert.match(source, /LEFT JOIN coa_0036_account_map coa_map ON coa_map\.source_account_id = e\.account_id/);
  assert.match(source, /COALESCE\(coa_map\.target_account_id, e\.account_id\) AS account_id/);
  assert.match(source, /GROUP BY COALESCE\(coa_map\.target_account_id, e\.account_id\)/);
  assert.match(source, /COA36-TRANSITION/);
  assert.match(source, /j\.id <> \?/);
});

chain.then(() => {
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exitCode = failed ? 1 : 0;
});
