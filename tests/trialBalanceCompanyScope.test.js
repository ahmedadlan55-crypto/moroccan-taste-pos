#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const T = require('../lib/reports/trialBalance');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra || '');
}

function scopedFakeDb() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: text, params: params || [] });
      if (/^SHOW COLUMNS/.test(text)) return [[{ Field: 'present' }]];
      if (/FROM gl_accounts a WHERE/.test(text)) return [[{
        id: 'MAIN-A', code: '100101', name_ar: 'نقدية', name_en: 'Cash', type: 'asset',
        parent_id: null, is_folder: 0, is_active: 1, display_order: 1, status: 'active',
        normal_balance: 'debit', is_contra: 0, report_section: 'cash', storedLevel: 1,
      }]];
      if (/GROUP BY e\.account_id/.test(text) && /j\.journal_date >= \?/.test(text)) {
        return [[{ account_id: 'MAIN-A', d: 10, c: 0, n: 1 }]];
      }
      if (/GROUP BY e\.account_id/.test(text)) return [[{ account_id: 'MAIN-A', d: 100, c: 0 }]];
      if (/COUNT\(DISTINCT j\.id\)/.test(text)) return [[{ n: 0, d: 0, c: 0 }]];
      if (/LEFT JOIN gl_accounts ga/.test(text)) return [[{ n: 0, d: 0, c: 0 }]];
      if (/e\.account_id IS NULL/.test(text)) return [[{ n: 0, d: 0, c: 0 }]];
      if (/FROM gl_journals j LEFT JOIN gl_entries/.test(text)) return [[]];
      if (/FROM gl_journals j WHERE/.test(text)) return [[]];
      if (/SELECT COALESCE\(SUM\(e\.debit\),0\) d/.test(text) && /j\.journal_date >= \?/.test(text)) {
        return [[{ d: 10, c: 0 }]];
      }
      if (/SELECT COALESCE\(SUM\(e\.debit\),0\) d/.test(text)) return [[{ d: 100, c: 0 }]];
      throw new Error('unexpected TB query: ' + text);
    },
  };
}

(async function main() {
  let scopeError = null;
  try {
    await T.computeTrialBalance(scopedFakeDb(), {
      from: '2026-01-01', to: '2026-01-31', companyId: 'CO-OTHER',
    });
  } catch (error) { scopeError = error; }
  check('arbitrary company selection is rejected by exact code/status',
    scopeError && scopeError.code === 'TB_COMPANY_SCOPE_FIXED' && scopeError.status === 400,
    scopeError && { code: scopeError.code, status: scopeError.status });

  const db = scopedFakeDb();
  const result = await T.computeTrialBalance(db, {
    from: '2026-01-01', to: '2026-01-31', includeZero: true,
  });
  check('response declares the fixed ledger',
    result.ledgerScope === 'CO-MAIN' && result.filters.companyId === 'CO-MAIN', result.filters);
  check('only the scoped account appears',
    result.rows.length === 1 && result.rows[0].accountId === 'MAIN-A', result.rows);
  check('grand totals use only the scoped account movement',
    result.totals.periodDebit === 10 && result.totals.periodCredit === 0, result.totals);

  const accountQuery = db.calls.find((call) => /FROM gl_accounts a WHERE/.test(call.sql));
  check('chart query is fixed to CO-MAIN in SQL and params',
    accountQuery && /COALESCE\(a\.company_id, 'CO-MAIN'\) = \?/.test(accountQuery.sql) &&
      accountQuery.params.length === 1 && accountQuery.params[0] === 'CO-MAIN', accountQuery);

  const movementQueries = db.calls.filter((call) =>
    /FROM gl_entries e JOIN gl_journals j/.test(call.sql) &&
    /e\.account_id IS NOT NULL/.test(call.sql) &&
    !/LEFT JOIN gl_accounts ga/.test(call.sql));
  check('every non-null financial movement query joins the scoped account owner',
    movementQueries.length >= 5 && movementQueries.every((call) =>
      /JOIN gl_accounts scope_a/.test(call.sql) &&
      /COALESCE\(scope_a\.company_id, 'CO-MAIN'\) = \?/.test(call.sql) &&
      call.params[0] === 'CO-MAIN'), movementQueries);

  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'erp-core.js'), 'utf8');
  check('HTTP adapter forwards companyId only so the fixed-scope engine can reject it',
    /const \{ from, to, branch, brand, costCenter, warehouse, includeZero, companyId \} = req\.query/.test(route) &&
      /from, to, branch, brand, costCenter, warehouse, companyId/.test(route));

  if (failures.length) {
    console.error('trialBalanceCompanyScope: ' + failures.length + ' failure(s)');
    failures.forEach((failure) => console.error(' - ' + failure));
    process.exit(1);
  }
  console.log(`trialBalanceCompanyScope: ${pass}/${pass} checks passed`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
