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
 *   Receipt post              Dr Inventory        / Cr GRNI
 *   Invoice approve (stock)   Dr GRNI + Input VAT / Cr AP     (+PPV on variance)
 *   Invoice approve (nonstk)  Dr Expense + In.VAT / Cr AP
 *   Payment execute           Dr AP               / Cr Cash|Bank
 *   Return before invoice     Dr GRNI             / Cr Inventory
 *   Return after invoice      Dr AP               / Cr Inventory + Input VAT
 */
'use strict';

const gl = require('../glPosting');
const { ensureProcurementAccounts } = require('./accounts');
const { err } = require('./errors');
const calc = require('./calculations');
const { money } = calc;

const PPV_CODE = '5350'; // Purchase Price Variance (exists in base COA)

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

/** (a) Goods Receipt post: Dr Inventory / Cr GRNI (net, no VAT). */
async function postReceipt(conn, { grn, net, warehouseId }) {
  const acc = await ensureProcurementAccounts(conn);
  const n = money(net);
  if (n <= 0) throw err('VALIDATION_ERROR', 'قيمة الاستلام يجب أن تكون موجبة');
  await assertPeriodOpen(conn, calc.ymd(grn.receipt_date));
  const dims = _dims(grn);
  return _post(conn, {
    journalDate: calc.ymd(grn.receipt_date),
    description: `استلام بضاعة ${grn.receipt_number}`,
    referenceType: 'GoodsReceipt',
    referenceId: grn.id,
    postedBy: grn.posted_by || grn.created_by || '',
    status: 'posted',
    ...dims,
    entries: [
      { accountCode: acc.inventory ? acc.inventory.code : '1200', debit: n, credit: 0, warehouseId: warehouseId || grn.warehouse_id, description: 'مخزون' },
      { accountCode: acc.grni.code, debit: 0, credit: n, description: 'بضاعة مستلمة لم تُفوتر' },
    ],
  });
}

/** (b) Stock supplier-invoice approve: Dr GRNI + Input VAT (+PPV) / Cr AP. */
async function postStockInvoice(conn, { invoice, grniClear, vat }) {
  const acc = await ensureProcurementAccounts(conn);
  const clear = money(grniClear);
  const v = money(vat);
  const invoiceNet = money(invoice.subtotal);
  const apCredit = money(invoiceNet + v);
  const ppv = money(invoiceNet - clear); // +ve: invoice cost > receipt cost
  await assertPeriodOpen(conn, calc.ymd(invoice.issue_date));
  const dims = _dims(invoice);
  const entries = [
    { accountCode: acc.grni.code, debit: clear, credit: 0, description: 'تصفية بضاعة مستلمة لم تُفوتر' },
  ];
  if (v > 0) entries.push({ accountCode: acc.inputVat.code, debit: v, credit: 0, description: 'ضريبة مدخلات' });
  if (ppv > 0) entries.push({ accountCode: PPV_CODE, debit: ppv, credit: 0, description: 'فرق سعر مشتريات' });
  else if (ppv < 0) entries.push({ accountCode: PPV_CODE, debit: 0, credit: -ppv, description: 'فرق سعر مشتريات' });
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

/** (c) Non-stock invoice: Dr Expense/Asset + Input VAT / Cr AP. */
async function postNonStockInvoice(conn, { invoice, expenseByAccount, vat }) {
  const acc = await ensureProcurementAccounts(conn);
  const v = money(vat);
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
  const acc = await ensureProcurementAccounts(conn);
  const a = money(amount);
  if (a <= 0) throw err('VALIDATION_ERROR', 'مبلغ السداد يجب أن يكون موجبًا');
  const method = String(payment.payment_method || 'bank').toLowerCase();
  const creditCode = method === 'cash' ? '1110' : '1120';
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
  const acc = await ensureProcurementAccounts(conn);
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
      { accountCode: '1200', debit: 0, credit: n, warehouseId: warehouseId || ret.warehouse_id, description: 'مخزون' },
    ],
  });
}

/** (f) Return after invoice: Dr AP / Cr Inventory + Input VAT. */
async function postReturnAfterInvoice(conn, { ret, net, vat, warehouseId }) {
  const acc = await ensureProcurementAccounts(conn);
  const n = money(net);
  const v = money(vat);
  await assertPeriodOpen(conn, calc.ymd(ret.return_date));
  const dims = _dims(ret);
  const entries = [
    { accountCode: acc.ap.code, debit: money(n + v), credit: 0, description: 'تخفيض ذمم موردين (إشعار دائن)' },
    { accountCode: '1200', debit: 0, credit: n, warehouseId: warehouseId || ret.warehouse_id, description: 'مخزون' },
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
  PPV_CODE,
};
