/**
 * HR Payroll → GL Posting
 * Creates accounting journal entries when payroll is approved:
 *   1. Accrual entry (expenses → payable)
 *   2. Deductions entry (payable → advances/penalties/insurance)
 *   3. Payment entry (payable → bank/cash)
 */
const db = require('../db/connection');

// ──────────────────────────────────────────────────
// Account code map — auto-created if missing
// Codes follow the standard 5-root chart: 1=Asset, 2=Liability, 3=Equity, 4=Revenue, 5=Expense
// ──────────────────────────────────────────────────
const SALARY_ACCOUNTS = [
  // Expense accounts (5xxx)
  { code: '5301', nameAr: 'مصروف الرواتب والأجور', type: 'expense', parent: '53' },
  { code: '5302', nameAr: 'مصروف البدلات',          type: 'expense', parent: '53' },
  { code: '5303', nameAr: 'مصروف الإضافي',          type: 'expense', parent: '53' },
  { code: '5304', nameAr: 'مصروف التأمينات - حصة الشركة', type: 'expense', parent: '53' },
  // Liability accounts (2xxx)
  { code: '2201', nameAr: 'رواتب وأجور مستحقة', type: 'liability', parent: '22' },
  { code: '2202', nameAr: 'التأمينات الاجتماعية - حصة الموظف', type: 'liability', parent: '22' },
  // Asset accounts (1xxx)
  { code: '1130', nameAr: 'سلف الموظفين',         type: 'asset', parent: '11' },
  // Revenue accounts (4xxx)
  { code: '4201', nameAr: 'إيرادات جزاءات ومخالفات', type: 'revenue', parent: '42' },
];

async function ensureParentAccount(code, nameAr, type) {
  const [existing] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [code]);
  if (existing.length) return existing[0].id;
  const id = 'GL-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
  const rootCode = code[0];
  const [root] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [rootCode]);
  const parentId = root.length ? root[0].id : null;
  await db.query(
    'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
    [id, code, nameAr, type, parentId, 2]
  );
  return id;
}

async function ensurePayrollAccounts() {
  // Ensure parent accounts first (53 = operating expenses, 22 = current liabilities, 11 = current assets, 42 = other revenue)
  await ensureParentAccount('53', 'المصروفات التشغيلية', 'expense');
  await ensureParentAccount('22', 'التزامات متداولة', 'liability');
  await ensureParentAccount('11', 'الأصول المتداولة', 'asset');
  await ensureParentAccount('42', 'إيرادات أخرى', 'revenue');

  const map = {};
  for (const acc of SALARY_ACCOUNTS) {
    const [existing] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [acc.code]);
    if (existing.length) { map[acc.code] = existing[0].id; continue; }
    const [parent] = await db.query('SELECT id FROM gl_accounts WHERE code = ? LIMIT 1', [acc.parent]);
    const parentId = parent.length ? parent[0].id : null;
    const id = 'GL-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query(
      'INSERT INTO gl_accounts (id, code, name_ar, type, parent_id, level, is_active) VALUES (?,?,?,?,?,?,1)',
      [id, acc.code, acc.nameAr, acc.type, parentId, 3]
    );
    map[acc.code] = id;
  }
  return map;
}

// ──────────────────────────────────────────────────
// Create a journal entry with multiple lines and post it
// ──────────────────────────────────────────────────
async function createAndPostJournal(opts) {
  const { date, description, lines, username } = opts;
  if (!lines || !lines.length) return null;
  let totalDebit = 0, totalCredit = 0;
  for (const l of lines) {
    totalDebit += Number(l.debit) || 0;
    totalCredit += Number(l.credit) || 0;
  }
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error('قيد غير متوازن: مدين=' + totalDebit.toFixed(2) + ' دائن=' + totalCredit.toFixed(2));
  }
  const journalId = 'GLJ-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
  // Get next journal number
  const [last] = await db.query('SELECT journal_number FROM gl_journals ORDER BY created_at DESC LIMIT 1');
  let num = 1;
  if (last.length && last[0].journal_number) {
    const m = last[0].journal_number.match(/(\d+)/);
    if (m) num = parseInt(m[1]) + 1;
  }
  const journalNumber = 'JE-' + String(num).padStart(5, '0');

  await db.query(
    `INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, description, total_debit, total_credit, status, created_by, posted_by, posted_at)
     VALUES (?,?,?,?,?,?,?,'posted',?,?,NOW())`,
    [journalId, journalNumber, date, 'payroll', description, totalDebit, totalCredit, username||'', username||'']
  );

  for (const l of lines) {
    const entryId = 'GLE-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query(
      `INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description)
       VALUES (?,?,?,?,?,?,?,?)`,
      [entryId, journalId, l.accountId || null, l.accountCode || '', l.accountName || '', Number(l.debit)||0, Number(l.credit)||0, l.description || description]
    );
    // Update account balance (asset/expense: debit+; liability/revenue/equity: credit+)
    if (l.accountId) {
      const netAmount = (Number(l.debit)||0) - (Number(l.credit)||0);
      await db.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [netAmount, l.accountId]);
    }
  }
  return { id: journalId, journalNumber };
}

// ──────────────────────────────────────────────────
// Main entry: post all 3 payroll journals
// ──────────────────────────────────────────────────
async function postPayrollJournals(runId, username) {
  const [runs] = await db.query('SELECT * FROM hr_payroll_runs WHERE id = ?', [runId]);
  if (!runs.length) throw new Error('دورة الرواتب غير موجودة');
  const run = runs[0];
  const [items] = await db.query('SELECT * FROM hr_payroll_items WHERE run_id = ?', [runId]);
  if (!items.length) throw new Error('لا توجد بنود رواتب لترحيلها');

  const accounts = await ensurePayrollAccounts();
  const date = run.year + '-' + String(run.month).padStart(2,'0') + '-' + String(new Date(run.year, run.month, 0).getDate()).padStart(2,'0');
  const periodStr = new Date(run.year, run.month-1, 1).toLocaleDateString('ar-SA', { month:'long', year:'numeric' });

  // Aggregate totals
  let totalBasic = 0, totalAllowances = 0, totalOvertime = 0;
  let totalAbsence = 0, totalLate = 0, totalAdvance = 0, totalInsurance = 0, totalFixedDed = 0;
  let totalNet = 0;
  items.forEach(i => {
    totalBasic += Number(i.basic_salary)||0;
    totalAllowances += (Number(i.housing_allowance)||0) + (Number(i.transport_allowance)||0) + (Number(i.other_allowance)||0)
                    + (Number(i.food_allowance)||0) + (Number(i.communication_allowance)||0)
                    + (Number(i.education_allowance)||0) + (Number(i.nature_allowance)||0);
    totalOvertime += Number(i.overtime_amount)||0;
    totalAbsence += Number(i.absence_deduction)||0;
    totalLate += Number(i.late_deduction)||0;
    totalAdvance += Number(i.advance_deduction)||0;
    totalInsurance += Number(i.social_insurance)||0;
    totalFixedDed += Number(i.fixed_deduction)||0;
    totalNet += Number(i.net_salary)||0;
  });

  const totalGross = totalBasic + totalAllowances + totalOvertime;
  const totalPenalties = totalLate + totalAbsence; // treated as revenue (company income from penalties)

  const results = {};

  // ═══ قيد 1: الاستحقاق ═══
  const accrualLines = [];
  if (totalBasic > 0) accrualLines.push({ accountId: accounts['5301'], accountCode:'5301', accountName:'مصروف الرواتب والأجور', debit: totalBasic, credit: 0 });
  if (totalAllowances > 0) accrualLines.push({ accountId: accounts['5302'], accountCode:'5302', accountName:'مصروف البدلات', debit: totalAllowances, credit: 0 });
  if (totalOvertime > 0) accrualLines.push({ accountId: accounts['5303'], accountCode:'5303', accountName:'مصروف الإضافي', debit: totalOvertime, credit: 0 });
  accrualLines.push({ accountId: accounts['2201'], accountCode:'2201', accountName:'رواتب وأجور مستحقة', debit: 0, credit: totalGross });

  if (totalGross > 0) {
    const j1 = await createAndPostJournal({
      date, description: 'قيد استحقاق رواتب ' + periodStr + ' — دورة ' + (run.run_number || run.id),
      lines: accrualLines, username
    });
    results.accrual = j1;
  }

  // ═══ قيد 2: الخصومات ═══
  const dedLines = [];
  const totalDeductionsForJournal = totalAdvance + totalInsurance + totalPenalties + totalFixedDed;
  if (totalDeductionsForJournal > 0) {
    dedLines.push({ accountId: accounts['2201'], accountCode:'2201', accountName:'رواتب وأجور مستحقة', debit: totalDeductionsForJournal, credit: 0 });
    if (totalAdvance > 0) dedLines.push({ accountId: accounts['1130'], accountCode:'1130', accountName:'سلف الموظفين', debit: 0, credit: totalAdvance });
    if (totalInsurance > 0) dedLines.push({ accountId: accounts['2202'], accountCode:'2202', accountName:'التأمينات الاجتماعية - حصة الموظف', debit: 0, credit: totalInsurance });
    if (totalPenalties > 0) dedLines.push({ accountId: accounts['4201'], accountCode:'4201', accountName:'إيرادات جزاءات ومخالفات', debit: 0, credit: totalPenalties });
    if (totalFixedDed > 0) dedLines.push({ accountId: accounts['4201'], accountCode:'4201', accountName:'إيرادات جزاءات ومخالفات', debit: 0, credit: totalFixedDed });

    const j2 = await createAndPostJournal({
      date, description: 'قيد خصومات رواتب ' + periodStr + ' — دورة ' + (run.run_number || run.id),
      lines: dedLines, username
    });
    results.deductions = j2;
  }

  // ═══ قيد 3: الصرف (مؤقت — يُخصم من مستحقة بدون صرف فعلي، يتم تحديثه عند الصرف الفعلي) ═══
  // نتركه مسودة حتى يتم الصرف الفعلي من البنك/الصندوق
  // بدلاً من ذلك، نسجل الصافي كـ rewards pending
  // ملاحظة: قيد الصرف يحتاج حساب البنك/الصندوق المحدد — يُنشأ يدوياً عند الصرف الفعلي

  // Update run with journal IDs
  await db.query(
    'UPDATE hr_payroll_runs SET journal_id_accrual = ?, journal_id_deductions = ? WHERE id = ?',
    [results.accrual ? results.accrual.id : null, results.deductions ? results.deductions.id : null, runId]
  );

  return { success: true, accrual: results.accrual, deductions: results.deductions, totalNet };
}

// ──────────────────────────────────────────────────
// Create payment journal when actual payment happens
// ──────────────────────────────────────────────────
async function postPayrollPaymentJournal(runId, bankAccountId, username) {
  const [runs] = await db.query('SELECT * FROM hr_payroll_runs WHERE id = ?', [runId]);
  if (!runs.length) throw new Error('دورة الرواتب غير موجودة');
  const run = runs[0];
  const accounts = await ensurePayrollAccounts();
  const date = new Date().toISOString().slice(0,10);
  const periodStr = new Date(run.year, run.month-1, 1).toLocaleDateString('ar-SA', { month:'long', year:'numeric' });

  const totalNet = Number(run.total_net) || 0;
  if (totalNet <= 0) throw new Error('الصافي صفر أو سالب');

  // Get bank account info
  const [bank] = await db.query('SELECT id, code, name_ar FROM gl_accounts WHERE id = ? LIMIT 1', [bankAccountId]);
  if (!bank.length) throw new Error('حساب البنك غير موجود');

  const lines = [
    { accountId: accounts['2201'], accountCode:'2201', accountName:'رواتب وأجور مستحقة', debit: totalNet, credit: 0 },
    { accountId: bank[0].id, accountCode: bank[0].code, accountName: bank[0].name_ar, debit: 0, credit: totalNet }
  ];

  const j = await createAndPostJournal({
    date, description: 'قيد صرف رواتب ' + periodStr + ' — دورة ' + (run.run_number || run.id),
    lines, username
  });

  await db.query('UPDATE hr_payroll_runs SET journal_id_payment = ?, status = \'paid\' WHERE id = ?', [j.id, runId]);
  return { success: true, payment: j };
}

module.exports = { postPayrollJournals, postPayrollPaymentJournal, ensurePayrollAccounts };
