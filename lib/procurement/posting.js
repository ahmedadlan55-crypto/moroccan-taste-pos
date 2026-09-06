/**
 * lib/procurement/posting.js — GRNI (Goods Received Not Invoiced) GL posting.
 *
 * The single place procurement journals are built. Every function is called
 * with the *transaction connection* so the journal writes are atomic with the
 * document + stock writes. Wraps lib/glPosting.postJournal (which numbers the
 * JV atomically and rejects unbalanced journals) and turns a failed post into a
 * thrown GL_POSTING_FAILED so the whole transaction rolls back.
 *
 * GRNI model:
 *   Receipt post              Dr Inventory        / Cr GRNI (goods) + Cr GRNI (import charges)
 *   Invoice approve (stock)   Dr GRNI + Input VAT / Cr AP     (+PPV on variance)
 *   Charge vendor invoice     Dr GRNI (charges)   / Cr AP     (+PPV on variance) — landed cost
 *   Invoice approve (nonstk)  Dr Expense + In.VAT / Cr AP
 *   Payment execute           Dr AP               / Cr Cash|Bank
 *   Return before invoice     Dr GRNI             / Cr Inventory
 *   Return after invoice      Dr AP               / Cr Inventory + Input VAT
 */
'use strict';

const gl = require('../glPosting');
const {
  resolveProcurementAccounts,
  PROCUREMENT_LEDGER_COMPANY_ID,
} = require('./accounts');
const { err } = require('./errors');
const calc = require('./calculations');
const { money } = calc;

function resolveAccounts(conn, keys) {
  // Explicit single-ledger scope; the resolver has no default/fallback.
  return resolveProcurementAccounts(conn, keys, { companyId: PROCUREMENT_LEDGER_COMPANY_ID });
}

/** Block posting into a closed OR locked period (postJournal only blocks closed). */
async function assertPeriodOpen(conn, dateYMD) {
  if (!dateYMD) return;
  const [rows] = await conn.query(
    `SELECT status FROM accounting_periods WHERE ? BETWEEN start_date AND end_date
       ORDER BY (brand_id IS NULL), (branch_id IS NULL) LIMIT 1`,
    [dateYMD]
  );
  if (rows.length && ['closed', 'locked'].includes(String(rows[0].status))) {
    throw err('PERIOD_CLOSED', 'الفترة المحاسبية مقفلة لهذا التاريخ');
  }
}

function _dims(doc) {
  return {
    brandId: doc.brand_id || doc.brandId || null,
    branchId: doc.branch_id || doc.branchId || null,
    costCenterId: doc.cost_center_id || doc.costCenterId || null,
  };
}

async function _post(conn, spec) {
  const r = await gl.postJournal(conn, spec);
  if (!r || !r.success) {
    throw err('GL_POSTING_FAILED', (r && r.error) || 'فشل ترحيل القيد المحاسبي');
  }
  return r.journalId;
}

/**
 * (a) Goods Receipt post:
 *   Dr Inventory (LANDED value, per warehouse)
 *   Cr GRNI      (goods net)                 'بضاعة مستلمة لم تُفوتر'
 *   Cr GRNI      (import charges, own entry) 'مصاريف استيراد مستحقة'  — only when > 0
 *
 * The charges get their OWN credit line rather than being folded into the
 * goods figure: the goods GRNI is cleared by the goods supplier's invoice and
 * the charges GRNI by the freight/customs vendor's, and a reconciler must be
 * able to see the two accruals separately. `valueByWarehouse` is expected to
 * already be landed (goods + allocated charges), so its sum must equal the
 * landed total, not the goods net.
 */
async function postReceipt(conn, { grn, net, chargesTotal, warehouseId, valueByWarehouse }) {
  const acc = await resolveAccounts(conn, ['inventory', 'grni']);
  const inventoryCode = acc.inventory && acc.inventory.code;
  if (!inventoryCode) throw err('ACCOUNT_ROLE_MISSING', 'حساب مراقبة المخزون غير مضبوط');
  const n = money(net);
  if (n <= 0) throw err('VALIDATION_ERROR', 'قيمة الاستلام يجب أن تكون موجبة');
  const charges = money(chargesTotal || 0);
  if (charges < 0) throw err('VALIDATION_ERROR', 'مصاريف الاستيراد لا يمكن أن تكون سالبة');
  const landed = money(n + charges);
  await assertPeriodOpen(conn, calc.ymd(grn.receipt_date));
  const dims = _dims(grn);
  const warehouseEntries = Object.entries(valueByWarehouse || {})
    .map(([id, value]) => ({ id, value: money(value) }))
    .filter((x) => x.value > 0);
  const warehouseTotal = money(warehouseEntries.reduce((sum, x) => sum + x.value, 0));
  if (warehouseEntries.length && warehouseTotal !== landed) {
    throw err('GL_POSTING_FAILED', `قيمة المستودعات (${warehouseTotal}) لا تساوي القيمة الواصلة للاستلام (${landed})`);
  }
  const inventoryEntries = warehouseEntries.length
    ? warehouseEntries.map((x) => ({
        accountCode: inventoryCode,
        debit: x.value, credit: 0, warehouseId: x.id, description: 'مخزون',
      }))
    : [{ accountCode: inventoryCode, debit: landed, credit: 0,
        warehouseId: warehouseId || grn.warehouse_id, description: 'مخزون' }];
  const grniEntries = [
    { accountCode: acc.grni.code, debit: 0, credit: n, description: 'بضاعة مستلمة لم تُفوتر' },
  ];
  if (charges > 0) {
    grniEntries.push({ accountCode: acc.grni.code, debit: 0, credit: charges, description: 'مصاريف استيراد مستحقة' });
  }
  return _post(conn, {
    journalDate: calc.ymd(grn.receipt_date),
    description: `استلام بضاعة ${grn.receipt_number}`,
    referenceType: 'GoodsReceipt',
    referenceId: grn.id,
    postedBy: grn.posted_by || grn.created_by || '',
    status: 'posted',
    ...dims,
    entries: [
      ...inventoryEntries,
      ...grniEntries,
    ],
  });
}

/**
 * Landed cost: the GRNI debit that clears an import-charge accrual. The
 * amount is what the receipt post CREDITED for the charge rows this invoice
 * settles (Σ purchase_receipt_charges.amount) — the accrual is cleared at ITS
 * value, never at the vendor's, or GRNI keeps a residual nobody will ever
 * clear. The vendor's invoice/accrual difference is a purchase price variance,
 * exactly as it is for goods. Its own entry, mirroring the receipt's own
 * credit, so a reconciler can pair them.
 */
function _chargeClearingEntry(acc, chargesClear) {
  const clear = money(chargesClear || 0);
  if (clear < 0) throw err('VALIDATION_ERROR', 'مصاريف الاستيراد المُصفّاة لا يمكن أن تكون سالبة');
  if (clear === 0) return null;
  return { accountCode: acc.grni.code, debit: clear, credit: 0, description: 'تصفية مصاريف استيراد مستحقة' };
}

/**
 * (b) Stock supplier-invoice approve: Dr GRNI + Input VAT (+PPV) / Cr AP.
 *   grniClear    — the goods accrual this invoice clears (matched receipt
 *                  value, or the goods net for a direct stock invoice)
 *   chargesClear — landed cost: the import-charge accrual it clears (a charge
 *                  vendor's invoice; 0 for a plain goods invoice)
 * PPV is the invoice net less BOTH clearings, so a freight bill that differs
 * from what was accrued lands in price variance, not left behind in GRNI.
 */
async function postStockInvoice(conn, { invoice, grniClear, vat, chargesClear }) {
  const clear = money(grniClear);
  const charges = money(chargesClear || 0);
  const v = money(vat);
  const invoiceNet = money(invoice.subtotal);
  const apCredit = money(invoiceNet + v);
  const ppv = money(invoiceNet - clear - charges); // +ve: invoice cost > receipt cost
  const neededRoles = ['grni', 'ap'];
  if (v > 0) neededRoles.push('inputVat');
  if (ppv !== 0) neededRoles.push('ppv');
  const acc = await resolveAccounts(conn, neededRoles);
  await assertPeriodOpen(conn, calc.ymd(invoice.issue_date));
  const dims = _dims(invoice);
  const entries = [];
  // A pure charge-vendor invoice clears no goods — no zero-amount goods line.
  if (clear > 0) entries.push({ accountCode: acc.grni.code, debit: clear, credit: 0, description: 'تصفية بضاعة مستلمة لم تُفوتر' });
  const chargeEntry = _chargeClearingEntry(acc, charges);
  if (chargeEntry) entries.push(chargeEntry);
  if (v > 0) entries.push({ accountCode: acc.inputVat.code, debit: v, credit: 0, description: 'ضريبة مدخلات' });
  if (ppv > 0) entries.push({ accountCode: acc.ppv.code, debit: ppv, credit: 0, description: 'فرق سعر مشتريات' });
  else if (ppv < 0) entries.push({ accountCode: acc.ppv.code, debit: 0, credit: -ppv, description: 'فرق سعر مشتريات' });
  entries.push({ accountCode: acc.ap.code, debit: 0, credit: apCredit, description: 'ذمم موردين' });
  return _post(conn, {
    journalDate: calc.ymd(invoice.issue_date),
    description: `فاتورة مورد ${invoice.invoice_no || invoice.code}`,
    referenceType: 'SupplierInvoice',
    referenceId: invoice.id,
    postedBy: invoice.approved_by || invoice.created_by || '',
    status: 'posted',
    ...dims,
    entries,
  });
}

/**
 * (c) Non-stock invoice: Dr Expense/Asset + Input VAT / Cr AP.
 * `charges` (landed cost, optional) = { clear, invoiceNet }: a non-stock
 * invoice may also carry lines that settle an import-charge accrual; those
 * clear GRNI at the accrued value and their invoice/accrual difference goes to
 * PPV, while the remaining lines keep their expense treatment. The caller has
 * already taken the charge lines' net OUT of expenseByAccount.
 */
async function postNonStockInvoice(conn, { invoice, expenseByAccount, vat, charges }) {
  const v = money(vat);
  const chargesClear = money((charges && charges.clear) || 0);
  const chargesNet = money(charges && charges.invoiceNet != null ? charges.invoiceNet : chargesClear);
  const ppv = chargesClear > 0 ? money(chargesNet - chargesClear) : 0;
  const neededRoles = ['ap'];
  if (v > 0) neededRoles.push('inputVat');
  if (chargesClear > 0) neededRoles.push('grni');
  if (ppv !== 0) neededRoles.push('ppv');
  const acc = await resolveAccounts(conn, neededRoles);
  await assertPeriodOpen(conn, calc.ymd(invoice.issue_date));
  const dims = _dims(invoice);
  const entries = [];
  let apCredit = v;
  for (const [code, amount] of Object.entries(expenseByAccount)) {
    const a = money(amount);
    if (a <= 0) continue;
    entries.push({ accountCode: code, debit: a, credit: 0, description: 'مصروف/أصل' });
    apCredit += a;
  }
  const chargeEntry = _chargeClearingEntry(acc, chargesClear);
  if (chargeEntry) {
    entries.push(chargeEntry);
    if (ppv > 0) entries.push({ accountCode: acc.ppv.code, debit: ppv, credit: 0, description: 'فرق سعر مشتريات' });
    else if (ppv < 0) entries.push({ accountCode: acc.ppv.code, debit: 0, credit: -ppv, description: 'فرق سعر مشتريات' });
    // AP owes the vendor what was BILLED for the charges, not what was accrued.
    apCredit += chargesNet;
  }
  if (v > 0) entries.push({ accountCode: acc.inputVat.code, debit: v, credit: 0, description: 'ضريبة مدخلات' });
  entries.push({ accountCode: acc.ap.code, debit: 0, credit: money(apCredit), description: 'ذمم موردين' });
  return _post(conn, {
    journalDate: calc.ymd(invoice.issue_date),
    description: `فاتورة مورد (غير مخزون) ${invoice.invoice_no || invoice.code}`,
    referenceType: 'SupplierInvoice',
    referenceId: invoice.id,
    postedBy: invoice.approved_by || invoice.created_by || '',
    status: 'posted',
    ...dims,
    entries,
  });
}

/** (d) Payment execute: Dr AP / Cr Cash|Bank. */
async function postPayment(conn, { payment, amount }) {
  const a = money(amount);
  if (a <= 0) throw err('VALIDATION_ERROR', 'مبلغ السداد يجب أن يكون موجبًا');
  const method = String(payment.payment_method || 'bank').toLowerCase();
  const settlementKey = method === 'cash' ? 'cash' : 'bank';
  const acc = await resolveAccounts(conn, ['ap', settlementKey]);
  const creditCode = acc[settlementKey].code;
  await assertPeriodOpen(conn, calc.ymd(payment.receipt_date || payment.paid_at));
  const dims = _dims(payment);
  const date = calc.ymd(payment.receipt_date || payment.paid_at);
  return _post(conn, {
    journalDate: date,
    description: `سداد مورد ${payment.payment_number}`,
    referenceType: 'SupplierPayment',
    referenceId: payment.id,
    postedBy: payment.paid_by || payment.requested_by || '',
    status: 'posted',
    ...dims,
    entries: [
      { accountCode: acc.ap.code, debit: a, credit: 0, description: 'تسوية ذمم موردين' },
      { accountCode: creditCode, debit: 0, credit: a, description: method === 'cash' ? 'نقدية' : 'بنك' },
    ],
  });
}

/** (e) Return before invoice: Dr GRNI / Cr Inventory. */
async function postReturnBeforeInvoice(conn, { ret, net, warehouseId }) {
  const acc = await resolveAccounts(conn, ['grni', 'inventory']);
  const n = money(net);
  await assertPeriodOpen(conn, calc.ymd(ret.return_date));
  const dims = _dims(ret);
  return _post(conn, {
    journalDate: calc.ymd(ret.return_date),
    description: `مرتجع شراء (قبل الفاتورة) ${ret.return_number}`,
    referenceType: 'PurchaseReturn',
    referenceId: ret.id,
    postedBy: ret.posted_by || ret.created_by || '',
    status: 'posted',
    ...dims,
    entries: [
      { accountCode: acc.grni.code, debit: n, credit: 0, description: 'عكس بضاعة مستلمة لم تُفوتر' },
      { accountCode: acc.inventory.code, debit: 0, credit: n, warehouseId: warehouseId || ret.warehouse_id, description: 'مخزون' },
    ],
  });
}

/** (f) Return after invoice: Dr AP / Cr Inventory + Input VAT. */
async function postReturnAfterInvoice(conn, { ret, net, vat, warehouseId }) {
  const n = money(net);
  const v = money(vat);
  const acc = await resolveAccounts(conn, v > 0 ? ['ap', 'inventory', 'inputVat'] : ['ap', 'inventory']);
  await assertPeriodOpen(conn, calc.ymd(ret.return_date));
  const dims = _dims(ret);
  const entries = [
    { accountCode: acc.ap.code, debit: money(n + v), credit: 0, description: 'تخفيض ذمم موردين (إشعار دائن)' },
    { accountCode: acc.inventory.code, debit: 0, credit: n, warehouseId: warehouseId || ret.warehouse_id, description: 'مخزون' },
  ];
  if (v > 0) entries.push({ accountCode: acc.inputVat.code, debit: 0, credit: v, description: 'عكس ضريبة مدخلات' });
  return _post(conn, {
    journalDate: calc.ymd(ret.return_date),
    description: `مرتجع شراء (بعد الفاتورة) ${ret.return_number}`,
    referenceType: 'PurchaseReturn',
    referenceId: ret.id,
    postedBy: ret.posted_by || ret.created_by || '',
    status: 'posted',
    ...dims,
    entries,
  });
}

/**
 * (g) Reversal — clone a journal with debit/credit swapped, then link the two
 * via gl_journals.reverses_journal_id / reversed_by_journal_id.
 */
async function postReversal(conn, { originalJournalId, referenceType, referenceId, actor, dateYMD, description }) {
  const [orig] = await conn.query('SELECT * FROM gl_journals WHERE id = ? LIMIT 1', [originalJournalId]);
  if (!orig.length) throw err('VALIDATION_ERROR', 'القيد الأصلي غير موجود');
  const [lines] = await conn.query('SELECT * FROM gl_entries WHERE journal_id = ?', [originalJournalId]);
  await assertPeriodOpen(conn, calc.ymd(dateYMD || orig[0].journal_date));
  const entries = lines.map((l) => ({
    accountCode: l.account_code,
    debit: money(l.credit),
    credit: money(l.debit),
    branchId: l.branch_id || null,
    brandId: l.brand_id || null,
    costCenterId: l.cost_center_id || null,
    warehouseId: l.warehouse_id || null,
    description: 'عكس: ' + (l.description || ''),
  }));
  const jId = await _post(conn, {
    journalDate: calc.ymd(dateYMD || orig[0].journal_date),
    description: description || ('عكس قيد ' + (orig[0].journal_number || '')),
    referenceType: (referenceType || orig[0].reference_type || 'Manual') + 'Reversal',
    referenceId: referenceId || orig[0].reference_id,
    postedBy: actor || '',
    status: 'posted',
    entries,
  });
  // best-effort linkage (columns exist in this schema)
  try {
    await conn.query('UPDATE gl_journals SET reverses_journal_id = ? WHERE id = ?', [originalJournalId, jId]);
    await conn.query('UPDATE gl_journals SET reversed_by_journal_id = ?, reversed_at = NOW(), reversed_by = ? WHERE id = ?',
      [jId, actor || '', originalJournalId]);
  } catch (_) { /* linkage is best-effort */ }
  return jId;
}

module.exports = {
  assertPeriodOpen,
  postReceipt, postStockInvoice, postNonStockInvoice, postPayment,
  postReturnBeforeInvoice, postReturnAfterInvoice, postReversal,
};
