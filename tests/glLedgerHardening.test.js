#!/usr/bin/env node
'use strict';

/**
 * General Ledger hardening gate (pure/fake-DB + real HTTP adapter).
 *
 * No development database is touched.  The assertions pin the semantic bugs
 * that used to make the GL disagree with the Trial Balance:
 *   - approved/draft rows are never legal-ledger rows;
 *   - account_code never owns history;
 *   - a single-account ledger is keyset-paginated with a stable balance;
 *   - oversized/invalid requests fail explicitly;
 *   - HTTP errors are non-200 and internal SQL text is not leaked.
 */

const http = require('http');
const express = require('express');
const L = require('../lib/reports/glLedger');

let passed = 0;
let failed = 0;
let queue = Promise.resolve();

function test(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      passed++;
      console.log('  ✓ ' + name);
    } catch (error) {
      failed++;
      console.error('  ✗ ' + name);
      console.error('    ' + (error && error.stack ? error.stack : error));
    }
  });
}

function ok(value, message) {
  if (!value) throw new Error(message || 'expected truthy');
}

function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || 'values differ'}: expected ${e}, got ${a}`);
}

function expectLedgerError(fn, code, status) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  ok(error instanceof L.GeneralLedgerError, 'expected GeneralLedgerError');
  equal(error.code, code, 'error code');
  equal(error.status, status, 'HTTP status');
}

function fakeDb(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params: params || [] });
      if (index >= responses.length) throw new Error('unexpected query #' + (index + 1));
      const value = responses[index++];
      if (value instanceof Error) throw value;
      return [value];
    },
  };
}

function row(overrides) {
  return Object.assign({
    id: 'E1', journal_id: 'J1', account_id: 'A1', debit: 5, credit: 0,
    description: 'قيد سطر', journal_number: 'JV-000001', journal_date: '2026-01-02',
    journal_desc: 'قيد يومية', reference_type: 'sale', reference_id: 'S1',
    created_by: 'accountant', created_at: '2026-01-02 09:00:00',
    cursor_date: '2026-01-02', cursor_created_at: '2026-01-02 09:00:00.000000',
  }, overrides || {});
}

console.log('\nGeneral Ledger hardening gate');

test('multi-ledger requires a real, bounded period', () => {
  expectLedgerError(() => L.parseMultiQuery({}), 'GL_RANGE_REQUIRED', 400);
  expectLedgerError(
    () => L.parseMultiQuery({ from: '2026-02-30', to: '2026-03-01' }),
    'GL_INVALID_DATE_VALUE',
    400,
  );
  expectLedgerError(
    () => L.parseMultiQuery({ from: '2025-01-01', to: '2026-01-02' }),
    'GL_RANGE_TOO_WIDE',
    422,
  );
});

test('multi-ledger rejects invalid filters and an unbounded account selection', () => {
  expectLedgerError(
    () => L.parseMultiQuery({ from: '2026-01-01', to: '2026-01-31', scope: 'DROP TABLE' }),
    'GL_INVALID_SCOPE',
    400,
  );
  const accounts = Array.from({ length: L.MAX_SELECTED_ACCOUNTS + 1 }, (_, i) => 'A' + i).join(',');
  expectLedgerError(
    () => L.parseMultiQuery({ from: '2026-01-01', to: '2026-01-31', accounts }),
    'GL_TOO_MANY_SELECTED_ACCOUNTS',
    422,
  );
  expectLedgerError(
    () => L.parseMultiQuery({ from: '2026-01-01', to: '2026-01-31', companyId: 'CO-OTHER' }),
    'GL_COMPANY_SCOPE_FIXED',
    400,
  );
});

test('single-account defaults to posted-only and a bounded cursor page', () => {
  const parsed = L.parseAccountQuery('A1', {});
  equal(parsed.limit, 50);
  equal([parsed.startDate, parsed.endDate, parsed.cursor], [null, null, null]);
  expectLedgerError(() => L.parseAccountQuery('A1', { status: 'approved' }), 'GL_STATUS_NOT_SUPPORTED', 400);
  expectLedgerError(() => L.parseAccountQuery('A1', { status: 'all' }), 'GL_STATUS_NOT_SUPPORTED', 400);
  expectLedgerError(() => L.parseAccountQuery('A1', { includeDraft: '1' }), 'GL_STATUS_NOT_SUPPORTED', 400);
  expectLedgerError(() => L.parseAccountQuery('A1', { limit: '201' }), 'GL_INVALID_LIMIT', 400);
  expectLedgerError(() => L.parseAccountQuery('A1', { startDate: '2026-01-01' }), 'GL_RANGE_PAIR_REQUIRED', 400);
});

test('cursor is scoped to account and report period', () => {
  const opts = { accountId: 'A1', startDate: '2026-01-01', endDate: '2026-01-31' };
  const cursor = L.encodeCursor({
    date: '2026-01-02', createdAt: '2026-01-02 09:00:00.000000', id: 'E1',
  }, opts);
  equal(L.decodeCursor(cursor, opts), {
    date: '2026-01-02', createdAt: '2026-01-02 09:00:00.000000', id: 'E1',
  });
  expectLedgerError(
    () => L.decodeCursor(cursor, { accountId: 'A2', startDate: '2026-01-01', endDate: '2026-01-31' }),
    'GL_CURSOR_MISMATCH',
    400,
  );
});

test('multi-ledger uses account_id + posted only and returns bilingual classification/source metadata', async () => {
  const db = fakeDb([
    [{
      id: 'A1', code: '110100', name_ar: 'النقدية', name_en: 'Cash', type: 'asset',
      parent_id: 'A0', is_folder: 0, display_order: 1, level: 3,
      report_section: 'cash', normal_balance: 'debit', is_contra: 0,
      cash_flow_activity: 'operating', status: 'archived', is_active: 0,
    }],
    [{ account_id: 'A1', d: 100, c: 20 }],
    [
      row({ debit: 10, credit: 2 }),
      row({ id: 'FOREIGN-E', account_id: 'FOREIGN', debit: 9999, credit: 0 }),
    ],
  ]);
  const result = await L.getMultiLedger(db, {
    from: '2026-01-01', to: '2026-01-31', scope: 'active', accounts: 'A1',
  });
  equal(result.filters.status, 'posted');
  equal(result.ledgerScope, 'CO-MAIN');
  equal(result.filters.companyId, 'CO-MAIN');
  equal(result.sections[0].nameEn, 'Cash');
  equal(result.sections[0].reportSection, 'cash');
  equal(result.sections[0].isActive, false);
  equal(result.sections[0].opening, 80);
  equal(result.sections[0].closingBalance, 88);
  equal(result.sections[0].lines[0].source, { type: 'sale', id: 'S1' });
  equal(result.sections[0].lines[0].drilldown, { type: 'journal', id: 'J1', number: 'JV-000001' });
  const financialSql = db.calls.slice(1).map((c) => c.sql).join('\n');
  ok(/j\.status = 'posted'/.test(financialSql), 'posted predicate missing');
  ok(!/approved/.test(financialSql), 'approved must not enter statutory ledger');
  ok(!/account_code/.test(financialSql), 'account_code must not own history');
  ok(new RegExp(`LIMIT ${L.MAX_MULTI_LINES + 1}`).test(financialSql), 'multi result must be hard-bounded');
  ok(!/WHERE\s+a\.is_active/i.test(db.calls[0].sql), 'archived accounts with history must remain auditable');
  ok(/COALESCE\(a\.company_id,\s*'CO-MAIN'\)\s*=\s*\?/.test(db.calls[0].sql), 'account query must be fixed to CO-MAIN');
  ok(/a\.id IN \(\?\)/.test(db.calls[0].sql), 'explicit selection must not load the whole chart first');
  equal(db.calls[0].params, ['CO-MAIN', 'A1']);
  equal(result.grandTotals.debit, 10, 'a foreign account row cannot enter grand totals even if a broken adapter returns it');
});

test('multi-ledger refuses oversized account/line results instead of truncating a financial report', async () => {
  const tooManyAccounts = fakeDb([
    Array.from({ length: L.MAX_MULTI_ACCOUNTS + 1 }, (_, i) => ({ id: 'A' + i })),
  ]);
  let accountError;
  try {
    await L.getMultiLedger(tooManyAccounts, { from: '2026-01-01', to: '2026-01-31' });
  } catch (caught) { accountError = caught; }
  equal([accountError.code, accountError.status], ['GL_ACCOUNT_RESULT_TOO_LARGE', 422]);

  const tooManyLines = fakeDb([
    [{ id: 'A1', code: '110100', name_ar: 'النقدية', name_en: 'Cash', parent_id: null, is_folder: 0 }],
    [],
    Array(L.MAX_MULTI_LINES + 1).fill(row()),
  ]);
  let lineError;
  try {
    await L.getMultiLedger(tooManyLines, { from: '2026-01-01', to: '2026-01-31' });
  } catch (caught) { lineError = caught; }
  equal([lineError.code, lineError.status], ['GL_RESULT_TOO_LARGE', 422]);
});

test('single-account first page has full totals, page balances and a next cursor', async () => {
  const db = fakeDb([
    [{
      id: 'A1', code: '110100', name_ar: 'النقدية', name_en: 'Cash', type: 'asset', level: 3,
      parent_id: 'A0', is_folder: 0, report_section: 'cash', normal_balance: 'debit',
      is_contra: 0, cash_flow_activity: 'operating', status: 'active', company_id: 'CO-MAIN',
    }],
    [{ d: 100, c: 20 }],
    [{ d: 10, c: 3, count: 3 }],
    [
      // DB order is newest first. E3 +4, E2 -2, E1 +5 = period net +7.
      row({ id: 'E3', debit: 5, credit: 1, journal_date: '2026-01-03', created_at: '2026-01-03 10:00:00', cursor_date: '2026-01-03', cursor_created_at: '2026-01-03 10:00:00.000000' }),
      row({ id: 'E2', debit: 0, credit: 2, created_at: '2026-01-02 10:00:00', cursor_created_at: '2026-01-02 10:00:00.000000' }),
      row({ id: 'E1', debit: 5, credit: 0 }),
    ],
  ]);
  const result = await L.getAccountLedger(db, 'A1', {
    startDate: '2026-01-01', endDate: '2026-01-31', limit: '2',
  });
  equal(result.account.nameEn, 'Cash');
  equal(result.account.companyId, 'CO-MAIN');
  equal(result.ledgerScope, 'CO-MAIN');
  equal(result.period.status, 'posted');
  equal(result.opening, 80);
  equal(result.totals, { debit: 10, credit: 3, net: 7, count: 3 });
  equal(result.closing, 87);
  equal(result.ledger.map((line) => line.balance), [87, 83]);
  equal(result.page, { opening: 85, closing: 87 });
  equal(result.pagination.hasMore, true);
  ok(result.pagination.nextCursor, 'expected next cursor');
  const sql = db.calls.map((c) => c.sql).join('\n');
  ok(/COALESCE\(company_id,\s*'CO-MAIN'\)\s*=\s*\?/.test(db.calls[0].sql), 'single account lookup must be fixed to CO-MAIN');
  equal(db.calls[0].params, ['A1', 'CO-MAIN']);
  ok(!/account_code/.test(sql), 'renamed/reused code must not merge history');
  equal((sql.match(/j\.status = 'posted'/g) || []).length, 3, 'every financial query is posted-only');

  const second = fakeDb([
    [db.calls.length && {
      id: 'A1', code: '110100', name_ar: 'النقدية', name_en: 'Cash', type: 'asset', level: 3,
      parent_id: 'A0', is_folder: 0, report_section: 'cash', normal_balance: 'debit',
      is_contra: 0, cash_flow_activity: 'operating', status: 'active', company_id: 'CO-MAIN',
    }],
    [{ d: 100, c: 20 }],
    [{ d: 10, c: 3, count: 3 }],
    [{ d: 5, c: 0 }],
    [row({ id: 'E1', debit: 5, credit: 0 })],
  ]);
  const page2 = await L.getAccountLedger(second, 'A1', {
    startDate: '2026-01-01', endDate: '2026-01-31', limit: '2', cursor: result.pagination.nextCursor,
  });
  equal(page2.page, { opening: 80, closing: 85 });
  equal(page2.ledger[0].balance, 85);
  equal(page2.pagination.hasMore, false);
  ok(/j\.journal_date < \?/.test(second.calls[4].sql), 'keyset continuation predicate missing');
  ok(!/OFFSET/i.test(second.calls[4].sql), 'offset pagination is unsafe under concurrent inserts');
});

test('missing account is an explicit 404 domain error', async () => {
  const db = fakeDb([[]]);
  let error;
  try { await L.getAccountLedger(db, 'MISSING', {}); } catch (caught) { error = caught; }
  ok(error instanceof L.GeneralLedgerError);
  equal([error.code, error.status], ['GL_ACCOUNT_NOT_FOUND', 404]);
});

test('a posted row without a stable order key fails visibly instead of corrupting pagination', async () => {
  const db = fakeDb([
    [{ id: 'A1', code: '110100', name_ar: 'النقدية', name_en: 'Cash' }],
    [{ d: 1, c: 0, count: 1 }],
    [row({ cursor_date: null })],
  ]);
  let error;
  try { await L.getAccountLedger(db, 'A1', {}); } catch (caught) { error = caught; }
  equal([error.code, error.status], ['GL_POSTED_ORDER_KEY_INVALID', 409]);
});

function requestJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
}

test('HTTP adapter returns 4xx/5xx (never false-success 200) and does not leak SQL errors', async () => {
  const dbPath = require.resolve('../db/connection');
  const guardPath = require.resolve('../middleware/requireCapability');
  const routePath = require.resolve('../routes/erp/reports/gl-ledger');
  const oldDb = require.cache[dbPath];
  const oldGuard = require.cache[guardPath];
  const oldRoute = require.cache[routePath];
  let mode = 'throw';
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      async query() {
        if (mode === 'missing') return [[]];
        throw new Error('SECRET_SQL_PASSWORD_AND_SCHEMA');
      },
    },
  };
  delete require.cache[guardPath];
  delete require.cache[routePath];

  const router = require('../routes/erp/reports/gl-ledger');
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'root', role: 'admin' }; next(); });
  app.use(router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const port = server.address().port;
    const invalid = await requestJson(port, '/reports/gl-ledger-multi');
    equal([invalid.status, invalid.body.code], [400, 'GL_RANGE_REQUIRED']);

    const originalConsoleError = console.error;
    let serverLog = '';
    console.error = (...parts) => { serverLog += parts.map(String).join(' '); };
    let internal;
    try {
      internal = await requestJson(port, '/reports/gl-ledger-multi?from=2026-01-01&to=2026-01-31');
    } finally {
      console.error = originalConsoleError;
    }
    equal([internal.status, internal.body.code], [500, 'GL_INTERNAL_ERROR']);
    ok(!JSON.stringify(internal.body).includes('SECRET_SQL'), 'internal SQL error leaked to browser');
    ok(serverLog.includes('SECRET_SQL'), 'full failure should remain in the server-side log');

    mode = 'missing';
    const missing = await requestJson(port, '/gl/account-ledger/UNKNOWN');
    equal([missing.status, missing.body.code], [404, 'GL_ACCOUNT_NOT_FOUND']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (oldDb) require.cache[dbPath] = oldDb; else delete require.cache[dbPath];
    if (oldGuard) require.cache[guardPath] = oldGuard; else delete require.cache[guardPath];
    if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
  }
});

queue.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
