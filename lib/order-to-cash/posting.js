/**
 * lib/order-to-cash/posting.js — the SINGLE place O2C journals are built. Every
 * function takes the *transaction connection* so journal writes are atomic with
 * the document + stock writes. Wraps lib/glPosting.postJournal (atomic JV number,
 * rejects unbalanced) and turns a failed post into GL_POSTING_FAILED so the whole
 * transaction rolls back. Reversals are APPEND-ONLY (clone with debit/credit
 * swapped + link) — never a delete of the original journal (fixes _reverseSaleEffects).
 *
 * GL model (spec §8):
 *   Manual/contract invoice (goods)   Dr AR / Cr Revenue / Cr Output VAT ; Dr COGS / Cr Inventory
 *   Manual/contract invoice (service) Dr AR / Cr Revenue / Cr Output VAT
 *   Collection                        Dr Cash|Bank / Cr AR
 *   Advance (deposit)                 Dr Cash|Bank / Cr Customer Deposits
 *   Advance application               Dr Customer Deposits / Cr AR
 *   Credit note / return              Dr Revenue + Dr Output VAT / Cr AR|Cash|Bank|Deposits ; Dr Inventory / Cr COGS
 *   Reversal                          clone(original) with Dr/Cr swapped, linked
 *
 * POS sales are NOT re-posted here: their revenue/VAT/COGS journal is already
 * created by the sale flow; the ar_document links that journal (no double post).
 */
'use strict';

const gl = require('../glPosting');
const { ensureO2CAccounts } = require('./accounts');
const { err } = require('./errors');
const calc = require('./calculations');
const { money } = calc;

async function assertPeriodOpen(conn, dateYMD) {
  if (!dateYMD) return;
  const [rows] = await conn.query(
    `SELECT status FROM accounting_periods WHERE ? BETWEEN start_date AND end_date
       ORDER BY (brand_id IS NULL), (branch_id IS NULL) LIMIT 1`, [dateYMD]);
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
  if (!r || !r.success) throw err('GL_POSTING_FAILED', (r && r.error) || 'فشل ترحيل القيد المحاسبي');
  return r.journalId;
}

function _destCode(acc, method, destinationType) {
  const m = String(destinationType || method || 'cash').toLowerCase();
  return m === 'bank' ? acc.bank.code : (m === 'cash' ? acc.cash.code : acc.bank.code);
}

/** Manual / contract customer invoice: Dr AR / Cr Revenue / Cr Output VAT (+ COGS/Inventory for goods). */
async function postInvoice(conn, { doc, net, vat, cogs = 0, warehouseId, revenueByAccount }) {
  const acc = await ensureO2CAccounts(conn);
  const n = money(net), v = money(vat), c = money(cogs);
  const arDebit = money(n + v);
  if (arDebit <= 0) throw err('VALIDATION_ERROR', 'قيمة الفاتورة يجب أن تكون موجبة');
  await assertPeriodOpen(conn, calc.ymd(doc.issue_date));
  const dims = _dims(doc);
  const entries = [{ accountCode: acc.ar.code, debit: arDebit, credit: 0, description: 'ذمم عملاء' }];
  // revenue may be split across accounts (per line revenue_account_code); default to 4100
  const revMap = revenueByAccount && Object.keys(revenueByAccount).length ? revenueByAccount : { [acc.revenue.code]: n };
  for (const [code, amt] of Object.entries(revMap)) {
    const a = money(amt);
    if (a !== 0) entries.push({ accountCode: code, debit: 0, credit: a, description: 'إيراد مبيعات' });
  }
  if (v > 0) entries.push({ accountCode: acc.outputVat.code, debit: 0, credit: v, description: 'ضريبة مخرجات' });
  const jId = await _post(conn, {
    journalDate: calc.ymd(doc.issue_date),
    description: `فاتورة عميل ${doc.document_number}`,
    referenceType: 'CustomerInvoice', referenceId: doc.id,
    postedBy: doc.issued_by || doc.created_by || '', status: 'posted', ...dims, entries,
  });
  // COGS leg for goods invoices (service invoices pass cogs=0)
  if (c > 0) {
    await _post(conn, {
      journalDate: calc.ymd(doc.issue_date),
      description: `تكلفة مبيعات ${doc.document_number}`,
      referenceType: 'CustomerInvoiceCOGS', referenceId: doc.id,
      postedBy: doc.issued_by || doc.created_by || '', status: 'posted', ...dims,
      entries: [
        { accountCode: acc.cogs.code, debit: c, credit: 0, description: 'تكلفة المبيعات' },
        { accountCode: acc.inventory.code, debit: 0, credit: c, warehouseId: warehouseId || doc.warehouse_id, description: 'مخزون' },
      ],
    });
  }
  return jId;
}

/** Collection: Dr Cash|Bank / Cr AR. */
async function postCollection(conn, { payment, amount }) {
  const acc = await ensureO2CAccounts(conn);
  const a = money(amount);
  if (a <= 0) throw err('VALIDATION_ERROR', 'مبلغ التحصيل يجب أن يكون موجبًا');
  await assertPeriodOpen(conn, calc.ymd(payment.payment_date));
  const dims = _dims(payment);
  return _post(conn, {
    journalDate: calc.ymd(payment.payment_date),
    description: `سند قبض ${payment.payment_number}`,
    referenceType: 'CustomerPayment', referenceId: payment.id,
    postedBy: payment.posted_by || payment.created_by || '', status: 'posted', ...dims,
    entries: [
      { accountCode: _destCode(acc, payment.payment_method, payment.destination_type), debit: a, credit: 0, description: payment.destination_type === 'bank' ? 'بنك' : 'نقدية' },
      { accountCode: acc.ar.code, debit: 0, credit: a, description: 'تحصيل ذمم عملاء' },
    ],
  });
}

/** Advance (unapplied deposit): Dr Cash|Bank / Cr Customer Deposits. */
async function postAdvance(conn, { payment, amount }) {
  const acc = await ensureO2CAccounts(conn);
  const a = money(amount);
  if (a <= 0) throw err('VALIDATION_ERROR', 'مبلغ الدفعة يجب أن يكون موجبًا');
  await assertPeriodOpen(conn, calc.ymd(payment.payment_date));
  const dims = _dims(payment);
  return _post(conn, {
    journalDate: calc.ymd(payment.payment_date),
    description: `دفعة مقدمة ${payment.payment_number}`,
    referenceType: 'CustomerAdvance', referenceId: payment.id,
    postedBy: payment.posted_by || payment.created_by || '', status: 'posted', ...dims,
    entries: [
      { accountCode: _destCode(acc, payment.payment_method, payment.destination_type), debit: a, credit: 0, description: payment.destination_type === 'bank' ? 'بنك' : 'نقدية' },
      { accountCode: acc.deposits.code, debit: 0, credit: a, description: 'دفعات مقدمة من العملاء' },
    ],
  });
}

/** Apply a previously-recorded advance to invoices: Dr Customer Deposits / Cr AR. */
async function postAdvanceApplication(conn, { payment, amount }) {
  const acc = await ensureO2CAccounts(conn);
  const a = money(amount);
  if (a <= 0) throw err('VALIDATION_ERROR', 'مبلغ التخصيص يجب أن يكون موجبًا');
  await assertPeriodOpen(conn, calc.ymd(payment.payment_date));
  const dims = _dims(payment);
  return _post(conn, {
    journalDate: calc.ymd(payment.payment_date),
    description: `تخصيص دفعة مقدمة ${payment.payment_number}`,
    referenceType: 'CustomerAdvanceApplication', referenceId: payment.id,
    postedBy: payment.posted_by || payment.created_by || '', status: 'posted', ...dims,
    entries: [
      { accountCode: acc.deposits.code, debit: a, credit: 0, description: 'استخدام دفعة مقدمة' },
      { accountCode: acc.ar.code, debit: 0, credit: a, description: 'تسوية ذمم عملاء' },
    ],
  });
}

/**
 * Credit note / sales return: reverse revenue + output VAT, refund via
 * AR reduction | cash/bank | customer deposit; reverse cost back to inventory.
 */
async function postCreditNote(conn, { ret, net, vat, cost = 0, warehouseId, revenueByAccount, cogsByWarehouse }) {
  const acc = await ensureO2CAccounts(conn);
  const n = money(net), v = money(vat), c = money(cost);
  await assertPeriodOpen(conn, calc.ymd(ret.return_date));
  const dims = _dims(ret);
  const total = money(n + v);
  // credit leg per refund method
  let creditLeg;
  const rm = String(ret.refund_method || 'ar_reduction').toLowerCase();
  if (rm === 'cash') creditLeg = { accountCode: acc.cash.code, description: 'رد نقدي' };
  else if (rm === 'bank') creditLeg = { accountCode: acc.bank.code, description: 'رد بنكي' };
  else if (rm === 'customer_deposit') creditLeg = { accountCode: acc.deposits.code, description: 'رصيد دائن للعميل' };
  else creditLeg = { accountCode: acc.ar.code, description: 'تخفيض ذمم عملاء' };
  // Revenue is debited back to the SAME accounts the invoice credited (postInvoice
  // splits by line revenue_account_code). Collapsing the split onto one default
  // account leaves both accounts permanently misstated on a full return. An empty
  // key means the line carried no account → the default, exactly as postInvoice does.
  const revMap = {};
  if (revenueByAccount && Object.keys(revenueByAccount).length) {
    for (const [code, amt] of Object.entries(revenueByAccount)) {
      const k = code || acc.revenue.code;
      revMap[k] = money((revMap[k] || 0) + Number(amt));
    }
  } else {
    revMap[acc.revenue.code] = n;
  }
  const revSum = money(Object.values(revMap).reduce((s, a) => s + Number(a), 0));
  if (Math.abs(revSum - n) > 0.01) {
    throw err('VALIDATION_ERROR', `توزيع الإيراد على الحسابات (${revSum}) لا يساوي صافي المرتجع (${n})`);
  }
  const entries = [];
  for (const [code, amt] of Object.entries(revMap)) {
    const a = money(amt);
    if (a !== 0) entries.push({ accountCode: code, debit: a, credit: 0, description: 'عكس إيراد (مرتجع)' });
  }
  if (v > 0) entries.push({ accountCode: acc.outputVat.code, debit: v, credit: 0, description: 'عكس ضريبة مخرجات' });
  entries.push({ accountCode: creditLeg.accountCode, debit: 0, credit: total, description: creditLeg.description });
  const jId = await _post(conn, {
    journalDate: calc.ymd(ret.return_date),
    description: `إشعار دائن / مرتجع ${ret.return_number}`,
    referenceType: 'SalesReturn', referenceId: ret.id,
    postedBy: ret.posted_by || ret.created_by || '', status: 'posted', ...dims, entries,
  });
  if (c > 0) {
    // One inventory leg per warehouse: a single menu line's components can come
    // from more than one warehouse, and the sale's COGS leg carried warehouseId,
    // so the reversal has to land on the same dimension or the per-warehouse
    // valuation drifts. Falls back to the header when no split is supplied.
    const whMap = {};
    if (cogsByWarehouse && Object.keys(cogsByWarehouse).length) {
      for (const [wh, amt] of Object.entries(cogsByWarehouse)) {
        whMap[wh] = money((whMap[wh] || 0) + Number(amt));
      }
    } else {
      whMap[warehouseId || ret.warehouse_id || ''] = c;
    }
    const whSum = money(Object.values(whMap).reduce((s, a) => s + Number(a), 0));
    if (Math.abs(whSum - c) > 0.01) {
      throw err('VALIDATION_ERROR', `توزيع التكلفة على المستودعات (${whSum}) لا يساوي التكلفة المُعادة (${c})`);
    }
    const cogsEntries = [];
    for (const [wh, amt] of Object.entries(whMap)) {
      const a = money(amt);
      if (a !== 0) cogsEntries.push({ accountCode: acc.inventory.code, debit: a, credit: 0, warehouseId: wh || null, description: 'مخزون' });
    }
    cogsEntries.push({ accountCode: acc.cogs.code, debit: 0, credit: c, description: 'عكس تكلفة المبيعات' });
    await _post(conn, {
      journalDate: calc.ymd(ret.return_date),
      description: `عكس تكلفة مرتجع ${ret.return_number}`,
      referenceType: 'SalesReturnCOGS', referenceId: ret.id,
      postedBy: ret.posted_by || ret.created_by || '', status: 'posted', ...dims,
      entries: cogsEntries,
    });
  }
  return jId;
}

/** Append-only reversal — clone a journal with debit/credit swapped and link the two. */
async function postReversal(conn, { originalJournalId, referenceType, referenceId, actor, dateYMD, description }) {
  const [orig] = await conn.query('SELECT * FROM gl_journals WHERE id = ? LIMIT 1', [originalJournalId]);
  if (!orig.length) throw err('VALIDATION_ERROR', 'القيد الأصلي غير موجود');
  const [lines] = await conn.query('SELECT * FROM gl_entries WHERE journal_id = ?', [originalJournalId]);
  await assertPeriodOpen(conn, calc.ymd(dateYMD || orig[0].journal_date));
  const entries = lines.map((l) => ({
    accountCode: l.account_code, debit: money(l.credit), credit: money(l.debit),
    branchId: l.branch_id || null, brandId: l.brand_id || null,
    costCenterId: l.cost_center_id || null, warehouseId: l.warehouse_id || null,
    description: 'عكس: ' + (l.description || ''),
  }));
  const jId = await _post(conn, {
    journalDate: calc.ymd(dateYMD || orig[0].journal_date),
    description: description || ('عكس قيد ' + (orig[0].journal_number || '')),
    referenceType: (referenceType || orig[0].reference_type || 'Manual') + 'Reversal',
    referenceId: referenceId || orig[0].reference_id, postedBy: actor || '', status: 'posted', entries,
  });
  try {
    await conn.query('UPDATE gl_journals SET reverses_journal_id = ? WHERE id = ?', [originalJournalId, jId]);
    await conn.query('UPDATE gl_journals SET reversed_by_journal_id = ?, reversed_at = NOW(), reversed_by = ? WHERE id = ?',
      [jId, actor || '', originalJournalId]);
  } catch (_) { /* linkage is best-effort */ }
  return jId;
}

module.exports = {
  assertPeriodOpen, postInvoice, postCollection, postAdvance, postAdvanceApplication,
  postCreditNote, postReversal,
};
