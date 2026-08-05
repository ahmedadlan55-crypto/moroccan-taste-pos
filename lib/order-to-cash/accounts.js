/**
 * lib/order-to-cash/accounts.js — resolve + bootstrap the O2C clearing accounts.
 *
 * AR / Cash / Bank / Sales Revenue / Output VAT / COGS / Inventory ship in the
 * base chart of accounts (ensureCoreAccounts). Customer Deposits (advance
 * payments — a current liability) does NOT, so it is created idempotently here.
 * Codes are env-configurable. Refuses to proceed (O2C_ACCOUNT_* error) if a
 * required account is missing / inactive / a folder / of the wrong type — never
 * silently reroutes a posting to the wrong account.
 */
'use strict';
const { CORE_ACCOUNTS } = require('../glPosting');

function codes() {
  return {
    ar: String(process.env.O2C_AR_ACCOUNT_CODE || CORE_ACCOUNTS.AR.code),
    cash: String(process.env.O2C_CASH_ACCOUNT_CODE || CORE_ACCOUNTS.CASH.code),
    bank: String(process.env.O2C_BANK_ACCOUNT_CODE || CORE_ACCOUNTS.BANK.code),
    revenue: String(process.env.O2C_REVENUE_ACCOUNT_CODE || CORE_ACCOUNTS.SALES_REVENUE.code),
    outputVat: String(process.env.O2C_OUTPUT_VAT_ACCOUNT_CODE || CORE_ACCOUNTS.OUTPUT_VAT.code),
    cogs: String(process.env.O2C_COGS_ACCOUNT_CODE || CORE_ACCOUNTS.COGS.code),
    inventory: String(process.env.O2C_INVENTORY_ACCOUNT_CODE || CORE_ACCOUNTS.INVENTORY.code),
    deposits: String(process.env.O2C_CUSTOMER_DEPOSITS_CODE || '215100'),
  };
}

class AccountError extends Error {
  constructor(code, message) { super(message); this.name = 'AccountError'; this.code = code; }
}

async function _fetch(db, code) {
  const [rows] = await db.query(
    'SELECT id, code, type, is_active, is_folder FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  return rows[0] || null;
}

function _assertPostable(acc, code, wantType) {
  if (!acc) throw new AccountError('O2C_ACCOUNT_MISSING', `الحساب ${code} غير موجود في دليل الحسابات`);
  if (!Number(acc.is_active)) throw new AccountError('O2C_ACCOUNT_MISSING', `الحساب ${code} غير نشط`);
  if (Number(acc.is_folder)) throw new AccountError('O2C_ACCOUNT_STRUCTURAL', `الحساب ${code} حساب تجميعي ولا يقبل القيود`);
  if (wantType && acc.type !== wantType) {
    throw new AccountError('O2C_ACCOUNT_STRUCTURAL', `الحساب ${code} من نوع ${acc.type} بينما المتوقع ${wantType}`);
  }
  return acc;
}

/** Ensure all O2C accounts exist and are postable; create Customer Deposits when absent. */
async function ensureO2CAccounts(db, opts = {}) {
  const log = opts.log || (() => {});
  const c = codes();

  const ar = _assertPostable(await _fetch(db, c.ar), c.ar, 'asset');
  const cash = _assertPostable(await _fetch(db, c.cash), c.cash, 'asset');
  const bank = _assertPostable(await _fetch(db, c.bank), c.bank, 'asset');
  const revenue = _assertPostable(await _fetch(db, c.revenue), c.revenue, 'revenue');
  const outputVat = _assertPostable(await _fetch(db, c.outputVat), c.outputVat, 'liability');
  const cogs = _assertPostable(await _fetch(db, c.cogs), c.cogs, 'expense');
  const inventory = _assertPostable(await _fetch(db, c.inventory), c.inventory, 'asset');

  // Customer Deposits — create under current liabilities (reuse Output VAT's parent) if missing.
  let deposits = await _fetch(db, c.deposits);
  if (!deposits) {
    const [pr] = await db.query('SELECT parent_id, level FROM gl_accounts WHERE code = ? LIMIT 1', [c.outputVat]);
    const parentId = (pr[0] && pr[0].parent_id) || null;
    const level = (pr[0] && pr[0].level) || 3;
    await db.query(
      `INSERT IGNORE INTO gl_accounts
        (id, code, name_ar, name_en, type, parent_id, level, is_active, is_folder, account_class, tax_nature)
       VALUES (?, ?, ?, ?, 'liability', ?, ?, 1, 0, 'detail', 'none')`,
      ['GL-' + c.deposits, c.deposits, 'دفعات مقدمة من العملاء', 'Customer Deposits', parentId, level]);
    log(`  + GL account ${c.deposits} Customer Deposits`);
    deposits = await _fetch(db, c.deposits);
    if (!deposits && opts.dryRun) deposits = { id: 'GL-' + c.deposits, code: c.deposits };
  }
  _assertPostable(deposits, c.deposits, 'liability');

  return {
    ar: { id: ar.id, code: ar.code },
    cash: { id: cash.id, code: cash.code },
    bank: { id: bank.id, code: bank.code },
    revenue: { id: revenue.id, code: revenue.code },
    outputVat: { id: outputVat.id, code: outputVat.code },
    cogs: { id: cogs.id, code: cogs.code },
    inventory: { id: inventory.id, code: inventory.code },
    deposits: { id: deposits.id, code: deposits.code },
  };
}

module.exports = { ensureO2CAccounts, codes, AccountError };
