#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  resolveProcurementAccounts,
  ensureProcurementAccounts,
  PROCUREMENT_LEDGER_COMPANY_ID,
} = require('../lib/procurement/accounts');
const glPosting = require('../lib/glPosting');
const procurementPosting = require('../lib/procurement/posting');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✅', name);
  } catch (error) {
    failed++;
    console.log('  ❌', name, '-', error.stack || error.message);
  }
}

const ROLE_ROWS = {
  INVENTORY: role('AR-INV', 'GL-XINV', '991001', 'asset'),
  GRNI: role('AR-GRNI', 'GL-XGRNI', '992001', 'liability'),
  ACCOUNTS_PAYABLE: role('AR-AP', 'GL-XAP', '992002', 'liability'),
  INPUT_VAT: role('AR-IVAT', 'GL-XVAT', '991002', 'asset', { tax_nature: 'vat_input' }),
  PPV: role('AR-PPV', 'GL-XPPV', '995001', 'expense'),
  CASH_ON_HAND: role('AR-CASH', 'GL-XCASH', '991003', 'asset'),
  BANK: role('AR-BANK', 'GL-XBANK', '991004', 'asset'),
};

function role(roleRowId, accountId, code, type, override = {}) {
  return {
    role_row_id: roleRowId,
    account_id: accountId,
    role_active: 1,
    version: 1,
    code,
    name_ar: code,
    type,
    account_active: 1,
    is_folder: 0,
    child_count: 0,
    tax_nature: null,
    ...override,
  };
}

function fakeDb(overrides = {}) {
  const rows = { ...ROLE_ROWS, ...overrides };
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/FROM account_roles ar/.test(sql)) return [[rows[params[0]]].filter(Boolean)];
      if (/FROM accounting_periods/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

async function thrown(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}

(async () => {
  console.log('\n▶ governed procurement account roles\n');

  await test('resolves the exact governed role mappings, not canonical/literal codes', async () => {
    const db = fakeDb();
    const out = await ensureProcurementAccounts(db, { companyId: PROCUREMENT_LEDGER_COMPANY_ID });
    assert.equal(out.inventory.code, '991001');
    assert.equal(out.grni.code, '992001');
    assert.equal(out.ap.code, '992002');
    assert.equal(out.inputVat.code, '991002');
    assert.deepEqual(db.calls.map((c) => c.params), [
      ['INVENTORY', 'CO-MAIN'],
      ['GRNI', 'CO-MAIN'],
      ['ACCOUNTS_PAYABLE', 'CO-MAIN'],
      ['INPUT_VAT', 'CO-MAIN'],
    ]);
    assert.ok(db.calls.every((c) => /^\s*SELECT/i.test(c.sql)), 'resolver performed a financial write/bootstrap');
  });

  await test('company scope is mandatory; there is no global/default lookup', async () => {
    const error = await thrown(() => resolveProcurementAccounts(fakeDb(), ['inventory'], {}));
    assert.equal(error && error.code, 'PROC_ACCOUNT_COMPANY_REQUIRED');
  });

  await test('an unmapped role fails closed and preserves the registry cause code', async () => {
    const error = await thrown(() => resolveProcurementAccounts(
      fakeDb({ GRNI: null }), ['grni'], { companyId: 'CO-MAIN' }
    ));
    assert.equal(error && error.code, 'PROC_ACCOUNT_ROLE_INVALID');
    assert.equal(error && error.details && error.details.causeCode, 'ACCOUNT_ROLE_UNMAPPED');
  });

  await test('revoked mapping fails closed instead of falling back to a literal', async () => {
    const error = await thrown(() => resolveProcurementAccounts(
      fakeDb({ GRNI: role('AR-GRNI', 'GL-XGRNI', '992001', 'liability', { role_active: 0 }) }),
      ['grni'], { companyId: 'CO-MAIN' }
    ));
    assert.equal(error && error.code, 'PROC_ACCOUNT_ROLE_INVALID');
    assert.equal(error && error.details && error.details.causeCode, 'ACCOUNT_ROLE_INACTIVE');
  });

  await test('inactive, folder, and structural-parent targets are rejected by the registry', async () => {
    for (const [override, cause] of [
      [{ account_active: 0 }, 'ACCOUNT_ROLE_TARGET_INACTIVE'],
      [{ is_folder: 1 }, 'ACCOUNT_ROLE_TARGET_IS_FOLDER'],
      [{ child_count: 2 }, 'ACCOUNT_ROLE_TARGET_IS_FOLDER'],
    ]) {
      const error = await thrown(() => resolveProcurementAccounts(
        fakeDb({ INVENTORY: role('AR-INV', 'GL-XINV', '991001', 'asset', override) }),
        ['inventory'], { companyId: 'CO-MAIN' }
      ));
      assert.equal(error && error.code, 'PROC_ACCOUNT_ROLE_INVALID');
      assert.equal(error && error.details && error.details.causeCode, cause);
    }
  });

  await test('type drift is blocked even if a mapping row was edited outside governance', async () => {
    const error = await thrown(() => resolveProcurementAccounts(
      fakeDb({ GRNI: role('AR-GRNI', 'GL-XGRNI', '992001', 'asset') }),
      ['grni'], { companyId: 'CO-MAIN' }
    ));
    assert.equal(error && error.code, 'PROC_ACCOUNT_ROLE_TYPE_DRIFT');
  });

  await test('input-VAT tax-nature drift is blocked even when the account remains an asset', async () => {
    const error = await thrown(() => resolveProcurementAccounts(
      fakeDb({ INPUT_VAT: role('AR-IVAT', 'GL-XVAT', '991002', 'asset', { tax_nature: 'none' }) }),
      ['inputVat'], { companyId: 'CO-MAIN' }
    ));
    assert.equal(error && error.code, 'PROC_ACCOUNT_ROLE_TAX_DRIFT');
  });

  await test('two different procurement controls cannot collapse into one account', async () => {
    const error = await thrown(() => resolveProcurementAccounts(
      fakeDb({
        GRNI: role('AR-GRNI', 'GL-SAME', '992001', 'liability'),
        ACCOUNTS_PAYABLE: role('AR-AP', 'GL-SAME', '992001', 'liability'),
      }),
      ['grni', 'ap'], { companyId: 'CO-MAIN' }
    ));
    assert.equal(error && error.code, 'PROC_ACCOUNT_ROLE_COLLISION');
  });

  await test('posting resolves INVENTORY/GRNI/AP/INPUT_VAT/PPV/CASH/BANK via roles only', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'procurement', 'posting.js'), 'utf8');
    for (const key of ['inventory', 'grni', 'ap', 'inputVat', 'ppv', 'cash', 'bank']) {
      assert.match(source, new RegExp(`['\"]${key}['\"]`), `missing governed role key ${key}`);
    }
    assert.doesNotMatch(source, /CORE_ACCOUNTS\.(INVENTORY|AP|INPUT_VAT|PPV|CASH|BANK)\.code/);
    assert.doesNotMatch(source, /PROCUREMENT_[A-Z_]+_ACCOUNT_CODE/);
  });

  await test('stock-invoice journal uses live GRNI/AP/Input-VAT/PPV mappings end to end', async () => {
    const db = fakeDb();
    const originalPost = glPosting.postJournal;
    let captured;
    glPosting.postJournal = async (_conn, spec) => { captured = spec; return { success: true, journalId: 'JV-T' }; };
    try {
      const journalId = await procurementPosting.postStockInvoice(db, {
        invoice: { id: 'INV-1', subtotal: 110, issue_date: '2026-08-13' },
        grniClear: 100,
        vat: 16.5,
      });
      assert.equal(journalId, 'JV-T');
      assert.deepEqual(captured.entries.map((e) => e.accountCode), ['992001', '991002', '995001', '992002']);
      assert.equal(captured.entries.reduce((sum, e) => sum + e.debit, 0), 126.5);
      assert.equal(captured.entries.reduce((sum, e) => sum + e.credit, 0), 126.5);
    } finally {
      glPosting.postJournal = originalPost;
    }
  });

  await test('supplier payment journal uses governed AP and selected cash/bank role', async () => {
    const db = fakeDb();
    const originalPost = glPosting.postJournal;
    const captured = [];
    glPosting.postJournal = async (_conn, spec) => { captured.push(spec); return { success: true, journalId: `JV-${captured.length}` }; };
    try {
      await procurementPosting.postPayment(db, {
        payment: { id: 'P1', payment_number: 'PAY-1', payment_method: 'cash', paid_at: '2026-08-13' }, amount: 20,
      });
      await procurementPosting.postPayment(db, {
        payment: { id: 'P2', payment_number: 'PAY-2', payment_method: 'bank', paid_at: '2026-08-13' }, amount: 30,
      });
      assert.deepEqual(captured[0].entries.map((e) => e.accountCode), ['992002', '991003']);
      assert.deepEqual(captured[1].entries.map((e) => e.accountCode), ['992002', '991004']);
    } finally {
      glPosting.postJournal = originalPost;
    }
  });

  console.log(`\nProcurement accounts: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
