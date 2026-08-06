/**
 * lib/procurement/accounts.js — Inventory / GRNI / AP / Input-VAT account bootstrap.
 *
 * The GRNI (Goods Received Not Invoiced) accrual account does NOT ship in the
 * base chart of accounts. This module creates it idempotently under current
 * liabilities and resolves the three procurement clearing accounts, whose
 * codes are configurable via env:
 *   PROCUREMENT_GRNI_ACCOUNT_CODE      (default 2150)
 *   PROCUREMENT_AP_ACCOUNT_CODE        (default 2100)
 *   PROCUREMENT_INPUT_VAT_ACCOUNT_CODE (default 1290)
 *
 * Refuses to proceed (throws a PROC_ACCOUNT_* error) if AP / Input-VAT are
 * missing, or if a configured code exists but is inactive / a folder / of the
 * wrong type — never silently reroutes a posting to the wrong account.
 */
'use strict';

const { CORE_ACCOUNTS } = require('../glPosting');

function codes() {
  return {
    inventory: String(process.env.PROCUREMENT_INVENTORY_ACCOUNT_CODE || CORE_ACCOUNTS.INVENTORY.code),
    grni: String(process.env.PROCUREMENT_GRNI_ACCOUNT_CODE || '211200'),
    ap: String(process.env.PROCUREMENT_AP_ACCOUNT_CODE || CORE_ACCOUNTS.AP.code),
    inputVat: String(process.env.PROCUREMENT_INPUT_VAT_ACCOUNT_CODE || CORE_ACCOUNTS.INPUT_VAT.code),
  };
}

class AccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

async function _fetch(db, code) {
  const [rows] = await db.query(
    'SELECT id, code, type, is_active, is_folder, account_class FROM gl_accounts WHERE code = ? LIMIT 1',
    [code]
  );
  return rows[0] || null;
}

function _assertPostable(acc, code, wantType) {
  if (!acc) throw new AccountError('PROC_ACCOUNT_MISSING', `الحساب ${code} غير موجود في دليل الحسابات`);
  if (!Number(acc.is_active)) throw new AccountError('PROC_ACCOUNT_MISSING', `الحساب ${code} غير نشط`);
  if (Number(acc.is_folder)) throw new AccountError('PROC_GRNI_STRUCTURAL', `الحساب ${code} حساب تجميعي (folder) ولا يقبل القيود`);
  if (wantType && acc.type !== wantType) {
    throw new AccountError('PROC_GRNI_STRUCTURAL', `الحساب ${code} من نوع ${acc.type} بينما المتوقع ${wantType}`);
  }
  return acc;
}

/**
 * Ensure the four accounts exist and are postable. Creates GRNI when absent.
 * Returns { inventory, grni, ap, inputVat } each { id, code }. Throws on structural
 * problems. Idempotent.
 */
async function ensureProcurementAccounts(db, opts = {}) {
  const log = opts.log || (() => {});
  const c = codes();

  // Inventory + AP + Input VAT must pre-exist (seeded by ensureCoreAccounts).
  // The inventory control code comes from the single central GL catalog; the
  // procurement module never invents a warehouse/category/item GL account.
  const inventory = _assertPostable(await _fetch(db, c.inventory), c.inventory, 'asset');
  const ap = _assertPostable(await _fetch(db, c.ap), c.ap, 'liability');
  const inputVat = _assertPostable(await _fetch(db, c.inputVat), c.inputVat, 'asset');

  // GRNI — create under current liabilities if missing.
  let grni = await _fetch(db, c.grni);
  if (!grni) {
    // Parent: reuse AP's parent group when available, else NULL.
    const [pr] = await db.query('SELECT parent_id, level FROM gl_accounts WHERE code = ? LIMIT 1', [c.ap]);
    const parentId = (pr[0] && pr[0].parent_id) || null;
    const level = (pr[0] && pr[0].level) || 3;
    const id = 'GL-' + c.grni;
    await db.query(
      `INSERT IGNORE INTO gl_accounts
        (id, code, name_ar, name_en, type, parent_id, level, is_active, is_folder, account_class, tax_nature)
       VALUES (?, ?, ?, ?, 'liability', ?, ?, 1, 0, 'detail', 'none')`,
      [id, c.grni, 'بضاعة مستلمة لم تُفوتر (GRNI)', 'Goods Received Not Invoiced', parentId, level]
    );
    log(`  + GL account ${c.grni} GRNI`);
    grni = await _fetch(db, c.grni);
    // In dry-run the INSERT is a no-op, so the re-fetch is empty — treat the
    // account as if it will be created rather than failing the plan.
    if (!grni && opts.dryRun) {
      return {
        inventory: { id: inventory.id, code: inventory.code },
        grni: { id: 'GL-' + c.grni, code: c.grni },
        ap: { id: ap.id, code: ap.code },
        inputVat: { id: inputVat.id, code: inputVat.code },
      };
    }
  }
  _assertPostable(grni, c.grni, 'liability');

  return {
    inventory: { id: inventory.id, code: inventory.code },
    grni: { id: grni.id, code: grni.code },
    ap: { id: ap.id, code: ap.code },
    inputVat: { id: inputVat.id, code: inputVat.code },
  };
}

module.exports = { ensureProcurementAccounts, codes, AccountError };
