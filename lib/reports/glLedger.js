/**
 * Canonical General Ledger engine.
 *
 * Accounting identity is gl_accounts.id / gl_entries.account_id.  The copied
 * account_code on a journal line is display-only historical metadata: codes
 * can be renamed or reused, so joining history through account_code can merge
 * two different accounts into one ledger.
 *
 * Only POSTED journals belong to the statutory ledger.  Draft and approved
 * journals remain operational workflow records and are deliberately excluded,
 * matching the Trial Balance engine.
 */
'use strict';

const coaTree = require('../coa/tree');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MYSQL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_RANGE_DAYS = 366;
const MAX_SELECTED_ACCOUNTS = 50;
const MAX_MULTI_ACCOUNTS = 1000;
const MAX_MULTI_LINES = 20000;
const MAX_CURSOR_LENGTH = 2048;
const MAX_ID_LENGTH = 50;
const LEDGER_COMPANY_ID = 'CO-MAIN';

function assertFixedCompany(value) {
  if (value != null && value !== '' && String(value) !== LEDGER_COMPANY_ID) {
    fail('دفتر الأستاذ متاح حاليًا لدفتر CO-MAIN فقط', 'GL_COMPANY_SCOPE_FIXED', 400);
  }
  return LEDGER_COMPANY_ID;
}

class GeneralLedgerError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'GeneralLedgerError';
    this.code = code;
    this.status = status || 400;
  }
}

function fail(message, code, status) {
  throw new GeneralLedgerError(message, code, status);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function realDate(value, label, required) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) {
    if (required) fail(`${label} مطلوب`, 'GL_RANGE_REQUIRED', 400);
    return null;
  }
  if (!DATE_RE.test(raw)) {
    fail(`صيغة ${label} غير صالحة؛ الصيغة المطلوبة YYYY-MM-DD`, 'GL_INVALID_DATE_FORMAT', 400);
  }
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    fail(`${label} ليس تاريخًا تقويميًا صالحًا`, 'GL_INVALID_DATE_VALUE', 400);
  }
  return raw;
}

function validateRange(from, to, required) {
  const start = realDate(from, 'تاريخ البداية', required);
  const end = realDate(to, 'تاريخ النهاية', required);
  if (!required && Boolean(start) !== Boolean(end)) {
    fail('يجب إرسال تاريخ البداية والنهاية معًا', 'GL_RANGE_PAIR_REQUIRED', 400);
  }
  if (!start && !end) return { from: null, to: null };
  const startMs = Date.parse(start + 'T00:00:00.000Z');
  const endMs = Date.parse(end + 'T00:00:00.000Z');
  if (startMs > endMs) {
    fail('تاريخ البداية يجب ألا يتجاوز تاريخ النهاية', 'GL_RANGE_ORDER_INVALID', 400);
  }
  const days = Math.floor((endMs - startMs) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) {
    fail(`الفترة المطلوبة تتجاوز الحد الآمن (${MAX_RANGE_DAYS} يومًا)`, 'GL_RANGE_TOO_WIDE', 422);
  }
  return { from: start, to: end };
}

function boundedText(value, label, max, { optional = true } = {}) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) {
    if (!optional) fail(`${label} مطلوب`, 'GL_INVALID_IDENTIFIER', 400);
    return null;
  }
  if (raw.length > max || /[\u0000-\u001f\u007f]/.test(raw)) {
    fail(`${label} غير صالح`, 'GL_INVALID_IDENTIFIER', 400);
  }
  return raw;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) {
    fail('حد الصفحة يجب أن يكون عددًا صحيحًا موجبًا', 'GL_INVALID_LIMIT', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    fail(`حد الصفحة يجب أن يكون بين 1 و${MAX_PAGE_SIZE}`, 'GL_INVALID_LIMIT', 400);
  }
  return parsed;
}

function parseSelectedAccounts(value) {
  const values = Array.from(new Set(
    String(value || '').split(',').map((s) => s.trim()).filter(Boolean),
  ));
  if (values.length > MAX_SELECTED_ACCOUNTS) {
    fail(`يمكن اختيار ${MAX_SELECTED_ACCOUNTS} حسابًا كحد أقصى`, 'GL_TOO_MANY_SELECTED_ACCOUNTS', 422);
  }
  return values.map((id) => boundedText(id, 'معرف الحساب', MAX_ID_LENGTH, { optional: false }));
}

function parseMultiQuery(query) {
  const q = query || {};
  const range = validateRange(q.from, q.to, true);
  const scope = String(q.scope || 'all');
  const accType = String(q.accType || 'both');
  if (!['all', 'active', 'leaf'].includes(scope)) {
    fail('نطاق الحسابات غير صالح', 'GL_INVALID_SCOPE', 400);
  }
  if (!['both', 'main', 'sub'].includes(accType)) {
    fail('نوع الحسابات غير صالح', 'GL_INVALID_ACCOUNT_TYPE', 400);
  }
  return {
    from: range.from,
    to: range.to,
    scope,
    accType,
    accounts: parseSelectedAccounts(q.accounts),
    parent: boundedText(q.parent, 'معرف الحساب الأب', MAX_ID_LENGTH),
    addedBy: boundedText(q.addedBy, 'اسم منشئ القيد', 100),
    companyId: assertFixedCompany(q.companyId),
  };
}

function cursorFingerprint(opts) {
  return {
    a: opts.accountId,
    f: opts.startDate || null,
    t: opts.endDate || null,
    s: 'posted',
    co: LEDGER_COMPANY_ID,
  };
}

function encodeCursor(key, opts) {
  const payload = Object.assign({ v: 1 }, cursorFingerprint(opts), {
    d: key.date,
    c: key.createdAt,
    i: key.id,
  });
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value, opts) {
  if (!value) return null;
  const raw = String(value);
  if (raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    fail('مؤشر الصفحة غير صالح', 'GL_INVALID_CURSOR', 400);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (_) {
    fail('مؤشر الصفحة غير صالح', 'GL_INVALID_CURSOR', 400);
  }
  const expected = cursorFingerprint(opts);
  const valid = parsed && parsed.v === 1 &&
    parsed.a === expected.a && parsed.f === expected.f && parsed.t === expected.t && parsed.s === expected.s && parsed.co === expected.co &&
    DATE_RE.test(String(parsed.d || '')) && MYSQL_DATETIME_RE.test(String(parsed.c || '')) &&
    typeof parsed.i === 'string' && parsed.i.length > 0 && parsed.i.length <= MAX_ID_LENGTH;
  if (!valid) fail('مؤشر الصفحة لا يطابق هذا التقرير', 'GL_CURSOR_MISMATCH', 400);
  return { date: parsed.d, createdAt: parsed.c, id: parsed.i };
}

function parseAccountQuery(accountId, query) {
  const id = boundedText(accountId, 'معرف الحساب', MAX_ID_LENGTH, { optional: false });
  const q = query || {};
  const range = validateRange(q.startDate, q.endDate, false);
  // Legacy callers may explicitly send status=posted or includeDraft=0.  Any
  // request for a non-posted workflow state is rejected rather than silently
  // changing the legal ledger's meaning.
  if (q.status && String(q.status) !== 'posted') {
    fail('دفتر الأستاذ المالي يعرض القيود المرحلة فقط', 'GL_STATUS_NOT_SUPPORTED', 400);
  }
  if (String(q.includeDraft || '0') === '1' || String(q.includeDraft || '').toLowerCase() === 'true') {
    fail('لا يمكن إدراج القيود غير المرحلة في دفتر الأستاذ المالي', 'GL_STATUS_NOT_SUPPORTED', 400);
  }
  const limit = parsePositiveInt(q.limit !== undefined ? q.limit : q.pageSize, DEFAULT_PAGE_SIZE);
  const base = { accountId: id, startDate: range.from, endDate: range.to, companyId: assertFixedCompany(q.companyId) };
  return Object.assign(base, {
    limit,
    cursor: decodeCursor(q.cursor, base),
  });
}

function dateFilters(alias, from, to) {
  const clauses = [];
  const params = [];
  if (from) { clauses.push(`${alias}.journal_date >= ?`); params.push(from); }
  if (to) { clauses.push(`${alias}.journal_date <= ?`); params.push(to); }
  return { clauses, params };
}

function inClause(ids) {
  return ids.map(() => '?').join(',');
}

async function getMultiLedger(db, query) {
  const opts = parseMultiQuery(query);
  const selectedSet = new Set(opts.accounts);

  let accountSql =
    `SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.parent_id,
            a.is_folder, a.display_order, a.level, a.report_section,
            a.normal_balance, a.is_contra, a.cash_flow_activity, a.status,
            a.is_active
       FROM gl_accounts a`;
  const accountParams = [LEDGER_COMPANY_ID];
  const accountWhere = ["COALESCE(a.company_id, 'CO-MAIN') = ?"];
  // Explicit selection is the escape hatch for very large charts: fetch the
  // requested ids directly rather than first loading (and rejecting) the
  // entire chart.  Selection already has its own 50-account upper bound.
  if (opts.accounts.length) {
    accountWhere.push(`a.id IN (${inClause(opts.accounts)})`);
    accountParams.push(...opts.accounts);
  }
  accountSql += ` WHERE ${accountWhere.join(' AND ')}`;
  accountSql += ` ORDER BY ${coaTree.ORDER_BY('a')} LIMIT ${MAX_MULTI_ACCOUNTS + 1}`;
  const [allAccounts] = await db.query(accountSql, accountParams);
  if (!opts.accounts.length && allAccounts.length > MAX_MULTI_ACCOUNTS) {
    fail(
      `عدد الحسابات يتجاوز حد التقرير (${MAX_MULTI_ACCOUNTS})؛ استخدم اختيار حسابات محددة`,
      'GL_ACCOUNT_RESULT_TOO_LARGE',
      422,
    );
  }

  const childParents = new Set(allAccounts.map((a) => a.parent_id).filter(Boolean).map(String));
  const isMain = (a) => !a.parent_id;
  const isLeaf = (a) => !Number(a.is_folder) && !childParents.has(String(a.id));
  const candidates = allAccounts.filter((a) => {
    const id = String(a.id);
    if (selectedSet.size) return selectedSet.has(id);
    if (opts.scope === 'leaf' && !isLeaf(a)) return false;
    if (opts.accType === 'main' && !isMain(a)) return false;
    if (opts.accType === 'sub' && isMain(a)) return false;
    if (opts.parent && String(a.parent_id || '') !== opts.parent && id !== opts.parent) return false;
    return true;
  });
  const candidateIds = candidates.map((a) => String(a.id));

  if (!candidateIds.length) {
    return {
      success: true,
      ledgerScope: LEDGER_COMPANY_ID,
      filters: Object.assign({}, opts, { accounts: opts.accounts.length ? opts.accounts : null, status: 'posted', companyId: LEDGER_COMPANY_ID }),
      sections: [],
      grandTotals: { debit: 0, credit: 0, opening: 0, closing: 0, accountCount: 0, lineCount: 0 },
      pagination: { bounded: true, maxAccounts: MAX_MULTI_ACCOUNTS, maxLines: MAX_MULTI_LINES },
      generatedAt: new Date().toISOString(),
    };
  }

  const openingMap = Object.create(null);
  const [openingRows] = await db.query(
    `SELECT e.account_id,
            COALESCE(SUM(e.debit),0) AS d,
            COALESCE(SUM(e.credit),0) AS c
       FROM gl_entries e
       JOIN gl_journals j ON e.journal_id = j.id
      WHERE e.account_id IN (${inClause(candidateIds)})
        AND j.status = 'posted'
        AND j.journal_date < ?
      GROUP BY e.account_id`,
    [...candidateIds, opts.from],
  );
  openingRows.forEach((r) => { openingMap[String(r.account_id)] = Number(r.d) - Number(r.c); });

  let entrySql =
    `SELECT e.id, e.journal_id, e.account_id, e.debit, e.credit,
            e.description AS entry_desc,
            j.journal_number, j.journal_date, j.description AS journal_desc,
            j.reference_type, j.reference_id, j.created_by, j.created_at
       FROM gl_entries e
       JOIN gl_journals j ON e.journal_id = j.id
      WHERE e.account_id IN (${inClause(candidateIds)})
        AND j.status = 'posted'
        AND j.journal_date >= ?
        AND j.journal_date <= ?`;
  const entryParams = [...candidateIds, opts.from, opts.to];
  if (opts.addedBy) { entrySql += ' AND j.created_by = ?'; entryParams.push(opts.addedBy); }
  entrySql += ` ORDER BY e.account_id, j.journal_date ASC, j.created_at ASC, e.id ASC
                LIMIT ${MAX_MULTI_LINES + 1}`;
  const [entryRows] = await db.query(entrySql, entryParams);
  if (entryRows.length > MAX_MULTI_LINES) {
    fail(
      `نتيجة الأستاذ تتجاوز ${MAX_MULTI_LINES} سطرًا؛ قلّص الفترة أو اختر حسابات محددة`,
      'GL_RESULT_TOO_LARGE',
      422,
    );
  }

  const linesByAccount = Object.create(null);
  entryRows.forEach((r) => {
    const id = String(r.account_id);
    if (!linesByAccount[id]) linesByAccount[id] = [];
    linesByAccount[id].push({
      id: r.id,
      journalId: r.journal_id,
      journalNumber: r.journal_number || '',
      date: r.journal_date,
      createdAt: r.created_at,
      addedBy: r.created_by || '',
      description: r.entry_desc || r.journal_desc || '',
      referenceType: r.reference_type || '',
      referenceId: r.reference_id || '',
      source: { type: r.reference_type || null, id: r.reference_id || null },
      drilldown: { type: 'journal', id: r.journal_id, number: r.journal_number || '' },
      debit: Number(r.debit) || 0,
      credit: Number(r.credit) || 0,
    });
  });

  const sections = [];
  candidates.forEach((a) => {
    const id = String(a.id);
    const lines = linesByAccount[id] || [];
    const opening = Number(openingMap[id] || 0);
    const explicitlySelected = selectedSet.has(id);
    if (!explicitlySelected && (opts.scope === 'active' || opts.scope === 'all')) {
      if (!lines.length && Math.abs(opening) < 0.005) return;
    }
    let balance = opening;
    let totalDebit = 0;
    let totalCredit = 0;
    const decorated = lines.map((line) => {
      balance += line.debit - line.credit;
      totalDebit += line.debit;
      totalCredit += line.credit;
      return Object.assign({}, line, { runningBalance: round2(balance) });
    });
    sections.push({
      accountId: a.id,
      code: a.code,
      nameAr: a.name_ar,
      nameEn: a.name_en || '',
      type: a.type,
      level: Number(a.level) || 0,
      parentId: a.parent_id || null,
      reportSection: a.report_section || null,
      normalBalance: a.normal_balance || null,
      isContra: !!Number(a.is_contra),
      cashFlowActivity: a.cash_flow_activity || null,
      accountStatus: a.status || null,
      isActive: a.is_active === null || a.is_active === undefined ? true : !!Number(a.is_active),
      opening: round2(opening),
      openingDebit: opening > 0 ? round2(opening) : 0,
      openingCredit: opening < 0 ? round2(-opening) : 0,
      totalDebit: round2(totalDebit),
      totalCredit: round2(totalCredit),
      closingBalance: round2(opening + totalDebit - totalCredit),
      lineCount: decorated.length,
      lines: decorated,
    });
  });

  const grandTotals = sections.reduce((totals, section) => ({
    debit: round2(totals.debit + section.totalDebit),
    credit: round2(totals.credit + section.totalCredit),
    opening: round2(totals.opening + section.opening),
    closing: round2(totals.closing + section.closingBalance),
    accountCount: totals.accountCount + 1,
    lineCount: totals.lineCount + section.lineCount,
  }), { debit: 0, credit: 0, opening: 0, closing: 0, accountCount: 0, lineCount: 0 });

  return {
    success: true,
    ledgerScope: LEDGER_COMPANY_ID,
    filters: {
      from: opts.from,
      to: opts.to,
      parent: opts.parent,
      accounts: opts.accounts.length ? opts.accounts : null,
      addedBy: opts.addedBy,
      scope: opts.scope,
      accType: opts.accType,
      status: 'posted',
      companyId: LEDGER_COMPANY_ID,
    },
    sections,
    grandTotals,
    pagination: { bounded: true, maxAccounts: MAX_MULTI_ACCOUNTS, maxLines: MAX_MULTI_LINES },
    generatedAt: new Date().toISOString(),
  };
}

function baseEntryWhere(opts) {
  const date = dateFilters('j', opts.startDate, opts.endDate);
  return {
    sql: [`e.account_id = ?`, `j.status = 'posted'`, ...date.clauses].join(' AND '),
    params: [opts.accountId, ...date.params],
  };
}

function beforeCursor(cursor) {
  return {
    sql: `(j.journal_date < ? OR
           (j.journal_date = ? AND
            (j.created_at < ? OR (j.created_at = ? AND e.id < ?))))`,
    params: [cursor.date, cursor.date, cursor.createdAt, cursor.createdAt, cursor.id],
  };
}

async function getAccountLedger(db, accountId, query) {
  const opts = parseAccountQuery(accountId, query);
  const [accountRows] = await db.query(
    `SELECT id, code, name_ar, name_en, type, level, parent_id, is_folder,
            report_section, normal_balance, is_contra, cash_flow_activity,
            status, company_id
       FROM gl_accounts
      WHERE id = ? AND COALESCE(company_id, 'CO-MAIN') = ?
      LIMIT 1`,
    [opts.accountId, LEDGER_COMPANY_ID],
  );
  if (!accountRows.length) {
    fail('الحساب غير موجود', 'GL_ACCOUNT_NOT_FOUND', 404);
  }
  const account = accountRows[0];

  let opening = 0;
  if (opts.startDate) {
    const [openingRows] = await db.query(
      `SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
         FROM gl_entries e
         JOIN gl_journals j ON e.journal_id = j.id
        WHERE e.account_id = ?
          AND j.status = 'posted'
          AND j.journal_date < ?`,
      [opts.accountId, opts.startDate],
    );
    opening = Number(openingRows[0] && openingRows[0].d) - Number(openingRows[0] && openingRows[0].c);
  }

  const where = baseEntryWhere(opts);
  const [totalRows] = await db.query(
    `SELECT COALESCE(SUM(e.debit),0) AS d,
            COALESCE(SUM(e.credit),0) AS c,
            COUNT(*) AS count
       FROM gl_entries e
       JOIN gl_journals j ON e.journal_id = j.id
      WHERE ${where.sql}`,
    where.params,
  );
  const periodDebit = Number(totalRows[0] && totalRows[0].d) || 0;
  const periodCredit = Number(totalRows[0] && totalRows[0].c) || 0;
  const totalCount = Number(totalRows[0] && totalRows[0].count) || 0;

  const closing = opening + periodDebit - periodCredit;
  // Pages run newest → oldest so the no-filter account detail truly shows
  // recent activity.  `pageUpperBalance` is the balance immediately after the
  // newest row in this page.  On page 1 it is the period closing balance; on a
  // continuation page it is recomputed from posted history strictly BEFORE
  // the cursor (the cursor row was already delivered on the previous page).
  let pageUpperBalance = closing;
  if (opts.cursor) {
    const prior = beforeCursor(opts.cursor);
    const [priorRows] = await db.query(
      `SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
         FROM gl_entries e
         JOIN gl_journals j ON e.journal_id = j.id
        WHERE ${where.sql} AND ${prior.sql}`,
      [...where.params, ...prior.params],
    );
    pageUpperBalance = opening +
      (Number(priorRows[0] && priorRows[0].d) || 0) -
      (Number(priorRows[0] && priorRows[0].c) || 0);
  }

  let pageSql =
    `SELECT e.id, e.journal_id, e.account_id, e.debit, e.credit, e.description,
            j.journal_number, j.journal_date, j.description AS journal_desc,
            j.status, j.reference_type, j.reference_id, j.created_by, j.created_at,
            DATE_FORMAT(j.journal_date, '%Y-%m-%d') AS cursor_date,
            DATE_FORMAT(j.created_at, '%Y-%m-%d %H:%i:%s.%f') AS cursor_created_at
       FROM gl_entries e
       JOIN gl_journals j ON e.journal_id = j.id
      WHERE ${where.sql}`;
  const pageParams = [...where.params];
  if (opts.cursor) {
    const next = beforeCursor(opts.cursor);
    pageSql += ` AND ${next.sql}`;
    pageParams.push(...next.params);
  }
  pageSql += ` ORDER BY j.journal_date DESC, j.created_at DESC, e.id DESC LIMIT ${opts.limit + 1}`;
  const [pageRows] = await db.query(pageSql, pageParams);
  const hasMore = pageRows.length > opts.limit;
  const rows = hasMore ? pageRows.slice(0, opts.limit) : pageRows;
  for (const row of rows) {
    if (!DATE_RE.test(String(row.cursor_date || '')) ||
        !MYSQL_DATETIME_RE.test(String(row.cursor_created_at || '')) ||
        !row.id) {
      fail(
        'يوجد قيد مرحل بلا مفتاح ترتيب صالح (التاريخ/وقت الإنشاء/معرف السطر)',
        'GL_POSTED_ORDER_KEY_INVALID',
        409,
      );
    }
  }

  let running = pageUpperBalance;
  const ledger = rows.map((row) => {
    const debit = Number(row.debit) || 0;
    const credit = Number(row.credit) || 0;
    const line = {
      id: row.id,
      journalId: row.journal_id,
      journalNumber: row.journal_number || '',
      journalDate: row.journal_date,
      createdAt: row.created_at,
      journalDesc: row.journal_desc || '',
      entryDesc: row.description || '',
      referenceType: row.reference_type || '',
      referenceId: row.reference_id || '',
      source: { type: row.reference_type || null, id: row.reference_id || null },
      drilldown: { type: 'journal', id: row.journal_id, number: row.journal_number || '' },
      status: 'posted',
      createdBy: row.created_by || '',
      debit,
      credit,
      // Balance immediately AFTER this journal line, even though rows are
      // displayed in reverse chronological order.
      balance: round2(running),
    };
    running -= debit - credit;
    return line;
  });
  const last = rows.length ? rows[rows.length - 1] : null;
  const nextCursor = hasMore && last ? encodeCursor({
    date: String(last.cursor_date),
    createdAt: String(last.cursor_created_at),
    id: String(last.id),
  }, opts) : null;

  return {
    success: true,
    ledgerScope: LEDGER_COMPANY_ID,
    account: {
      id: account.id,
      code: account.code || '',
      nameAr: account.name_ar || '',
      nameEn: account.name_en || '',
      type: account.type || '',
      level: Number(account.level) || 0,
      parentId: account.parent_id || '',
      isFolder: !!Number(account.is_folder),
      reportSection: account.report_section || null,
      normalBalance: account.normal_balance || null,
      isContra: !!Number(account.is_contra),
      cashFlowActivity: account.cash_flow_activity || null,
      status: account.status || null,
      companyId: LEDGER_COMPANY_ID,
    },
    accountName: account.name_ar || '',
    accountCode: account.code || '',
    period: { startDate: opts.startDate, endDate: opts.endDate, status: 'posted' },
    opening: round2(opening),
    totals: {
      debit: round2(periodDebit),
      credit: round2(periodCredit),
      net: round2(periodDebit - periodCredit),
      count: totalCount,
    },
    closing: round2(closing),
    page: { opening: round2(running), closing: round2(pageUpperBalance) },
    pagination: {
      strategy: 'cursor',
      sort: 'desc',
      limit: opts.limit,
      hasMore,
      nextCursor,
      total: totalCount,
    },
    ledger,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  GeneralLedgerError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_RANGE_DAYS,
  MAX_SELECTED_ACCOUNTS,
  MAX_MULTI_ACCOUNTS,
  MAX_MULTI_LINES,
  LEDGER_COMPANY_ID,
  round2,
  validateRange,
  parseMultiQuery,
  parseAccountQuery,
  encodeCursor,
  decodeCursor,
  getMultiLedger,
  getAccountLedger,
};
