'use strict';

/**
 * Safe bulk import for the Chart of Accounts.
 *
 * This path is intentionally additive: it creates accounts and updates only
 * bilingual names on existing accounts. It never deletes rows, disables
 * foreign keys, guesses identity from a translated name, changes a code,
 * reparents/retypes an existing account, changes folder/postability state, or
 * trusts uploaded level/order values. Structural changes belong to the
 * audited move/reclassification flows; renumbering belongs to an approved
 * migration manifest.
 */

const { randomUUID } = require('crypto');
const coaService = require('./service');

const MAX_ROWS = 1000;

function value(row, ...keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function text(row, ...keys) {
  const v = value(row, ...keys);
  return v == null ? '' : String(v).trim();
}

function normaliseRow(row, index) {
  const kind = text(row, 'kind', 'النوع الهيكلي').toLowerCase();
  const type = text(row, 'type', 'طبيعة الحساب', 'النوع').toLowerCase();
  return {
    rowNumber: index + 2,
    id: text(row, 'id', 'المعرف (لا تحذف)'),
    code: text(row, 'code', 'الكود'),
    nameAr: text(row, 'nameAr', 'الاسم العربي'),
    nameEn: text(row, 'nameEn', 'الاسم الإنجليزي', 'الاسم الانجليزي', 'الاسم الإنج'),
    type: type || null,
    parentCode: text(row, 'parentCode', 'كود الأب'),
    reportSection: text(row, 'reportSection', 'تصنيف التقرير') || null,
    cashFlowActivity: text(row, 'cashFlowActivity', 'تصنيف التدفق النقدي') || null,
    taxNature: text(row, 'taxNature', 'التصنيف الضريبي') || null,
    isFolder: kind
      ? ['folder', 'group', 'control', 'رئيسي', 'مجموعة', 'تجميعي'].includes(kind)
      : null,
  };
}

function typedImportError(code, httpStatus, message, details) {
  const error = new Error(message || code);
  error.name = 'CoaImportError';
  error.isCoaError = true;
  error.code = code;
  error.httpStatus = httpStatus;
  if (details) error.details = details;
  return error;
}

function importError(message, errors) {
  return typedImportError('IMPORT_INVALID', 422, message, { errors: errors || [] });
}

/**
 * `replace` used to delete every unmatched account after disabling FK checks.
 * It is retired, not hidden behind a confirmation word. This guard runs before
 * opening a transaction so no mutation/query can occur for a rejected mode.
 */
function assertUpdateMode(mode) {
  const requested = String(mode || 'update').trim().toLowerCase();
  if (requested === 'replace') {
    throw typedImportError(
      'COA_REPLACE_RETIRED',
      410,
      'تم إيقاف استبدال دليل الحسابات لأنه قد يحذف حسابات مستخدمة؛ استخدم الاستيراد التحديثي فقط',
      { requestedMode: requested, allowedModes: ['update'] },
    );
  }
  if (requested !== 'update') {
    throw typedImportError(
      'IMPORT_MODE_INVALID',
      400,
      'وضع الاستيراد غير صالح؛ الوضع المسموح هو update فقط',
      { requestedMode: requested, allowedModes: ['update'] },
    );
  }
  return requested;
}

async function queryRows(conn, sql, params) {
  const out = await conn.query(sql, params || []);
  return Array.isArray(out) && Array.isArray(out[0]) ? out[0] : out;
}

function pushStructureError(errors, row, code, details) {
  errors.push(Object.assign({ row: row.rowNumber, code }, details || {}));
}

async function importAccountsTx(conn, sourceRows, ctx, options) {
  const service = (options && options.coaService) || coaService;
  if (!Array.isArray(sourceRows) || sourceRows.length === 0) {
    throw importError('لا توجد صفوف صالحة للاستيراد');
  }
  if (sourceRows.length > MAX_ROWS) {
    throw importError('عدد الصفوف يتجاوز الحد الآمن للاستيراد', [
      { code: 'TOO_MANY_ROWS', max: MAX_ROWS, received: sourceRows.length },
    ]);
  }

  const rows = sourceRows.map(normaliseRow);
  const errors = [];
  const codeSeen = new Map();
  const idSeen = new Map();

  // Validate the whole file before its first write. A duplicate identity must
  // not become "last row wins" merely because it was later in the spreadsheet.
  for (const row of rows) {
    if (!row.code) errors.push({ row: row.rowNumber, code: 'CODE_REQUIRED' });
    if (!row.nameAr) errors.push({ row: row.rowNumber, code: 'NAME_REQUIRED' });
    if (!row.nameEn) errors.push({ row: row.rowNumber, code: 'NAME_EN_REQUIRED' });
    if (row.code) {
      if (codeSeen.has(row.code)) {
        errors.push({
          row: row.rowNumber,
          code: 'DUPLICATE_CODE_IN_FILE',
          value: row.code,
          firstRow: codeSeen.get(row.code),
        });
      } else codeSeen.set(row.code, row.rowNumber);
    }
    if (row.id) {
      if (idSeen.has(row.id)) {
        errors.push({
          row: row.rowNumber,
          code: 'DUPLICATE_ID_IN_FILE',
          value: row.id,
          firstRow: idSeen.get(row.id),
        });
      } else idSeen.set(row.id, row.rowNumber);
    }
  }
  if (errors.length) throw importError('ملف دليل الحسابات غير صالح', errors);

  const existing = await queryRows(
    conn,
    `SELECT id, code, name_ar, name_en, type, parent_id, level, is_folder,
            is_active, status, company_id, version, report_section,
            cash_flow_activity, tax_nature
       FROM gl_accounts
      WHERE COALESCE(company_id, 'CO-MAIN') = 'CO-MAIN'
      FOR UPDATE`,
  );
  const byId = new Map(existing.map((account) => [String(account.id), account]));
  const byCode = new Map();
  for (const account of existing) {
    const code = String(account.code);
    // A code may be scoped per company. A code-only spreadsheet row cannot
    // safely choose between two companies, so mark it ambiguous rather than
    // silently picking the last row returned by MySQL.
    if (!byCode.has(code)) byCode.set(code, account);
    else byCode.set(code, null);
  }

  let inserted = 0;
  let updated = 0;
  const applied = [];
  const pending = rows.slice();

  // Existing rows first. Only names are imported; every structural field is
  // compared to the locked database row and an attempted change rejects the
  // entire file.
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const row = pending[i];
    const idAccount = row.id ? byId.get(row.id) : null;
    const codeAccount = byCode.get(row.code);

    if (row.id && !idAccount && byCode.has(row.code)) {
      pushStructureError(errors, row, 'IDENTITY_COLLISION', {
        requestedId: row.id,
        requestedCode: row.code,
        codeOwnerId: codeAccount ? String(codeAccount.id) : null,
      });
      pending.splice(i, 1);
      continue;
    }
    if (!row.id && byCode.has(row.code) && codeAccount === null) {
      pushStructureError(errors, row, 'AMBIGUOUS_CODE_REQUIRES_ID', { requestedCode: row.code });
      pending.splice(i, 1);
      continue;
    }

    const account = idAccount || codeAccount;
    if (!account) continue;

    if (row.id && String(account.code) !== row.code) {
      pushStructureError(errors, row, 'RENUMBER_REQUIRES_MANIFEST', {
        currentCode: String(account.code),
        requestedCode: row.code,
      });
      pending.splice(i, 1);
      continue;
    }
    if (row.id && codeAccount && String(codeAccount.id) !== String(account.id)) {
      pushStructureError(errors, row, 'IDENTITY_COLLISION', {
        requestedId: row.id,
        requestedCode: row.code,
        codeOwnerId: String(codeAccount.id),
      });
      pending.splice(i, 1);
      continue;
    }

    const currentParent = account.parent_id ? byId.get(String(account.parent_id)) : null;
    if (row.parentCode && (!currentParent || String(currentParent.code) !== row.parentCode)) {
      pushStructureError(errors, row, 'MOVE_REQUIRES_GOVERNED_ROUTE', {
        currentParentCode: currentParent ? String(currentParent.code) : null,
        requestedParentCode: row.parentCode,
      });
      pending.splice(i, 1);
      continue;
    }
    if (row.type && row.type !== String(account.type)) {
      pushStructureError(errors, row, 'RECLASSIFICATION_REQUIRED', {
        currentType: String(account.type),
        requestedType: row.type,
      });
      pending.splice(i, 1);
      continue;
    }
    if (row.isFolder !== null && row.isFolder !== !!Number(account.is_folder)) {
      pushStructureError(errors, row, 'FOLDER_CHANGE_REQUIRES_GOVERNED_ROUTE', {
        currentIsFolder: !!Number(account.is_folder),
        requestedIsFolder: row.isFolder,
      });
      pending.splice(i, 1);
      continue;
    }

    const out = await service.upsertAccountTx(
      conn,
      {
        id: String(account.id),
        code: String(account.code),
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        type: String(account.type),
        parentId: account.parent_id ? String(account.parent_id) : null,
        isFolder: !!Number(account.is_folder),
        isActive: Number(account.is_active) !== 0,
        status: account.status || (Number(account.is_active) === 0 ? 'archived' : 'active'),
        expectedVersion: Number(account.version || 1),
      },
      ctx,
    );
    updated += 1;
    applied.push({ row: row.rowNumber, id: out.id, code: row.code, action: 'updated' });
    pending.splice(i, 1);
  }

  // New rows are resolved topologically: their parent may appear before or
  // after the child in the file. Roots cannot be created by import.
  while (pending.length) {
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const row = pending[i];
      if (row.parentCode && byCode.has(row.parentCode) && byCode.get(row.parentCode) === null) {
        pushStructureError(errors, row, 'AMBIGUOUS_PARENT_CODE_REQUIRES_SCOPE', {
          parentCode: row.parentCode,
        });
        pending.splice(i, 1);
        progressed = true;
        continue;
      }
      const parent = row.parentCode ? byCode.get(row.parentCode) : null;
      if (!parent) continue;

      const type = row.type || String(parent.type);
      const out = await service.createAccountTx(
        conn,
        Object.assign({
          id: row.id || 'GL-' + randomUUID(),
          code: row.code,
          nameAr: row.nameAr,
          nameEn: row.nameEn,
          type,
          parentId: String(parent.id),
          isFolder: row.isFolder == null ? false : row.isFolder,
        }, row.reportSection ? { reportSection: row.reportSection } : {},
        row.cashFlowActivity ? { cashFlowActivity: row.cashFlowActivity } : {},
        row.taxNature ? { taxNature: row.taxNature } : {}),
        ctx,
      );
      const created = await service.loadAccount(conn, out.id);
      if (!created) {
        throw typedImportError('INTERNAL', 500, 'تعذر التحقق من الحساب الذي تم إنشاؤه', { id: out.id });
      }
      byId.set(String(created.id), created);
      if (!byCode.has(String(created.code))) byCode.set(String(created.code), created);
      else byCode.set(String(created.code), null);
      inserted += 1;
      applied.push({ row: row.rowNumber, id: out.id, code: row.code, action: 'inserted' });
      pending.splice(i, 1);
      progressed = true;
    }
    if (!progressed) {
      for (const row of pending) {
        pushStructureError(errors, row, row.parentCode ? 'PARENT_NOT_FOUND' : 'ROOT_CREATE_FORBIDDEN', {
          parentCode: row.parentCode || null,
        });
      }
      break;
    }
  }

  if (errors.length) {
    throw importError('لم يُطبّق الاستيراد لأن بعض الصفوف تحتاج معالجة', errors);
  }
  return { inserted, updated, skipped: 0, deleted: 0, applied };
}

function db() {
  return require('../../db/connection');
}

function importAccounts(rows, ctx, mode, options) {
  assertUpdateMode(mode);
  const database = (options && options.db) || db();
  return database.withTransaction((conn) => importAccountsTx(conn, rows, ctx, options));
}

module.exports = {
  MAX_ROWS,
  normaliseRow,
  assertUpdateMode,
  importAccountsTx,
  importAccounts,
};
