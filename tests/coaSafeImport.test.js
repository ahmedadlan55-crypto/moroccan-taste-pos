#!/usr/bin/env node
'use strict';

/**
 * Pure, mutation-minded gate for the additive-only COA importer.
 *
 * There is deliberately no MySQL connection in this test. The fake database
 * implements a real transaction boundary by cloning its state and publishing
 * it only on commit. The fake COA service is intentionally permissive about
 * structural changes: if the importer ever stops guarding code/parent/type/
 * folder itself, these tests observe the corruption instead of being saved by
 * a second guard in the service.
 */

const fs = require('fs');
const path = require('path');
const importer = require('../lib/coa/import');
const coaService = require('../lib/coa/service');

let pass = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    pass += 1;
    return;
  }
  failures.push(name + (extra === undefined ? '' : ' -> ' + safe(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : safe(extra));
}

function safe(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

async function rejected(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

function account(id, code, parentId, extra) {
  return Object.assign({
    id,
    code,
    name_ar: 'حساب ' + code,
    name_en: 'Account ' + code,
    type: 'asset',
    parent_id: parentId || null,
    level: parentId ? 2 : 1,
    is_folder: parentId ? 0 : 1,
    is_active: 1,
    status: 'active',
    company_id: 'CO-MAIN',
    version: 1,
    report_section: 'cash',
    cash_flow_activity: 'operating',
    tax_nature: 'none',
  }, extra || {});
}

function cloneRows(rows) {
  return rows.map((row) => Object.assign({}, row));
}

function makeHarness(seed, options) {
  const config = options || {};
  let committed = cloneRows(seed);
  const calls = { tx: 0, commits: 0, rollbacks: 0, upsert: [], create: [], queries: [] };

  const service = {
    async upsertAccountTx(conn, input) {
      calls.upsert.push(Object.assign({}, input));
      if (config.throwOnName && input.nameAr === config.throwOnName) {
        const error = new Error('injected row failure');
        error.code = 'INJECTED_FAILURE';
        throw error;
      }
      const row = conn.rows.find((candidate) => String(candidate.id) === String(input.id));
      if (!row) throw new Error('fake service: missing account ' + input.id);
      // Intentionally accept every supplied structural value. The importer,
      // not this fake, must make sure these are the current values.
      row.code = input.code;
      row.parent_id = input.parentId || null;
      row.type = input.type;
      row.is_folder = input.isFolder ? 1 : 0;
      row.is_active = input.isActive ? 1 : 0;
      row.status = input.status;
      row.name_ar = input.nameAr;
      row.name_en = input.nameEn;
      if (Object.prototype.hasOwnProperty.call(input, 'reportSection')) row.report_section = input.reportSection;
      if (Object.prototype.hasOwnProperty.call(input, 'cashFlowActivity')) row.cash_flow_activity = input.cashFlowActivity;
      if (Object.prototype.hasOwnProperty.call(input, 'taxNature')) row.tax_nature = input.taxNature;
      row.version += 1;
      return { id: row.id, version: row.version, created: false };
    },
    async createAccountTx(conn, input) {
      calls.create.push(Object.assign({}, input));
      if (conn.rows.some((row) => String(row.id) === String(input.id))) {
        throw new Error('fake service: duplicate id ' + input.id);
      }
      if (conn.rows.some((row) => String(row.code) === String(input.code))) {
        throw new Error('fake service: duplicate code ' + input.code);
      }
      const parent = conn.rows.find((row) => String(row.id) === String(input.parentId));
      if (!parent) throw new Error('fake service: missing parent ' + input.parentId);
      const row = account(input.id, input.code, input.parentId, {
        name_ar: input.nameAr,
        name_en: input.nameEn,
        type: input.type,
        level: Number(parent.level) + 1,
        is_folder: input.isFolder ? 1 : 0,
        company_id: parent.company_id,
        report_section: input.reportSection || null,
        cash_flow_activity: input.cashFlowActivity || null,
        tax_nature: input.taxNature || 'none',
      });
      conn.rows.push(row);
      return { id: row.id, version: 1, created: true };
    },
    async loadAccount(conn, id) {
      return conn.rows.find((row) => String(row.id) === String(id)) || null;
    },
  };

  const db = {
    async withTransaction(fn) {
      calls.tx += 1;
      const working = cloneRows(committed);
      const conn = {
        rows: working,
        async query(sql) {
          calls.queries.push(String(sql).replace(/\s+/g, ' ').trim());
          if (/^SELECT\b/i.test(String(sql)) && /\bFROM gl_accounts\b/i.test(String(sql))) {
            const scoped = /COALESCE\(company_id,\s*['"]CO-MAIN['"]\)/i.test(String(sql));
            return [scoped ? working.filter((row) => !row.company_id || row.company_id === 'CO-MAIN') : working, []];
          }
          throw new Error('unexpected SQL from importer: ' + sql);
        },
      };
      try {
        const result = await fn(conn);
        committed = working;
        calls.commits += 1;
        return result;
      } catch (error) {
        calls.rollbacks += 1;
        throw error;
      }
    },
  };

  return {
    db,
    service,
    calls,
    rows() { return cloneRows(committed); },
    options() { return { db, coaService: service }; },
  };
}

function validRow(overrides) {
  return Object.assign({
    id: 'A-1100',
    code: '1100',
    nameAr: 'النقدية',
    nameEn: 'Cash',
  }, overrides || {});
}

(async function main() {
  const seed = [
    account('ROOT', '1000', null, { name_ar: 'الأصول', name_en: 'Assets', is_folder: 1 }),
    account('A-1100', '1100', 'ROOT'),
    account('A-1200', '1200', 'ROOT'),
    account('A-1300', '1300', 'ROOT'),
  ];

  // Normalisation never carries the two derived/ordering spreadsheet fields
  // into the write model.
  {
    const row = importer.normaliseRow({
      id: 'X', code: '1110', nameAr: 'أ', nameEn: 'A', type: 'asset',
      level: 99, displayOrder: -20,
    }, 0);
    check('normaliser drops uploaded level', !Object.prototype.hasOwnProperty.call(row, 'level'), row);
    check('normaliser drops uploaded display order', !Object.prototype.hasOwnProperty.call(row, 'displayOrder'), row);
  }

  // Replace/unknown modes are rejected before even opening a transaction.
  {
    const h = makeHarness(seed);
    const error = await rejected(() => importer.importAccounts(
      [validRow()], {}, 'replace', h.options(),
    ));
    check('replace is rejected with a stable code', error && error.code === 'COA_REPLACE_RETIRED', error);
    check('replace is HTTP 410 Gone', error && error.httpStatus === 410, error && error.httpStatus);
    const mapped = coaService.toHttpError(error);
    check('route error mapper preserves replace code/status',
      mapped.code === 'COA_REPLACE_RETIRED' && mapped.httpStatus === 410, mapped);
    check('replace never opens a transaction', h.calls.tx === 0, h.calls);
    check('replace leaves every account byte-for-byte unchanged',
      safe(h.rows()) === safe(seed), h.rows());
  }
  {
    const h = makeHarness(seed);
    const error = await rejected(() => importer.importAccounts(
      [validRow()], {}, 'merge', h.options(),
    ));
    check('unknown mode is rejected', error && error.code === 'IMPORT_MODE_INVALID', error);
    check('unknown mode is HTTP 400', error && error.httpStatus === 400, error && error.httpStatus);
    check('unknown mode also performs zero DB work', h.calls.tx === 0, h.calls);
  }

  // Duplicate identities are found in the validation pass, before service
  // writes. Exact error codes keep a generic 422 from becoming a false pass.
  {
    const h = makeHarness(seed);
    const error = await rejected(() => importer.importAccounts([
      validRow({ id: '', code: '1400' }),
      validRow({ id: '', code: '1400', nameAr: 'ثان', nameEn: 'Second' }),
    ], {}, 'update', h.options()));
    const codes = error && error.details && error.details.errors.map((item) => item.code);
    check('duplicate code is rejected by exact reason', codes && codes.includes('DUPLICATE_CODE_IN_FILE'), codes);
    check('duplicate-code file makes zero service writes',
      h.calls.upsert.length === 0 && h.calls.create.length === 0, h.calls);
    check('duplicate-code transaction rolls back', h.calls.rollbacks === 1 && h.calls.commits === 0, h.calls);
  }
  {
    const h = makeHarness(seed);
    const error = await rejected(() => importer.importAccounts([
      validRow({ id: 'SAME-ID', code: '1400' }),
      validRow({ id: 'SAME-ID', code: '1500', nameAr: 'ثان', nameEn: 'Second' }),
    ], {}, 'update', h.options()));
    const codes = error && error.details && error.details.errors.map((item) => item.code);
    check('duplicate id is rejected by exact reason', codes && codes.includes('DUPLICATE_ID_IN_FILE'), codes);
    check('duplicate-id file makes zero service writes',
      h.calls.upsert.length === 0 && h.calls.create.length === 0, h.calls);
  }

  // Parent may occur after its child. The importer resolves the dependency
  // topologically and never trusts the spreadsheet's level.
  {
    const h = makeHarness(seed);
    const result = await importer.importAccounts([
      {
        id: 'NEW-CHILD', code: '1111', nameAr: 'طفل', nameEn: 'Child',
        type: 'asset', parentCode: '1110', level: 99,
        reportSection: 'input_vat', cashFlowActivity: 'non_cash', taxNature: 'vat_input',
      },
      {
        id: 'NEW-PARENT', code: '1110', nameAr: 'أب', nameEn: 'Parent',
        type: 'asset', parentCode: '1000', kind: 'folder', level: -1,
      },
    ], {}, 'update', h.options());
    const rows = h.rows();
    const parent = rows.find((row) => row.id === 'NEW-PARENT');
    const child = rows.find((row) => row.id === 'NEW-CHILD');
    check('parent-after-child import inserts both rows', result.inserted === 2, result);
    check('topological import links the parent to the existing root', parent && parent.parent_id === 'ROOT', parent);
    check('topological import links the child to the newly-created parent', child && child.parent_id === 'NEW-PARENT', child);
    check('derived levels come from topology, not uploaded values',
      parent && child && parent.level === 2 && child.level === 3, { parent, child });
    check('classification metadata is passed for a newly-created account',
      child && child.report_section === 'input_vat' && child.cash_flow_activity === 'non_cash' && child.tax_nature === 'vat_input', child);
    check('successful import commits exactly one transaction',
      h.calls.tx === 1 && h.calls.commits === 1 && h.calls.rollbacks === 0, h.calls);
  }

  // A later validation error must roll back an earlier successful name update.
  // Input order is chosen so the reverse existing-row pass writes A-1200 first.
  {
    const h = makeHarness(seed);
    const error = await rejected(() => importer.importAccounts([
      validRow({ id: 'A-1100', code: '1100', type: 'revenue' }),
      validRow({ id: 'A-1200', code: '1200', nameAr: 'اسم مؤقت', nameEn: 'Temporary' }),
    ], {}, 'update', h.options()));
    const codes = error && error.details && error.details.errors.map((item) => item.code);
    check('retype attempt is rejected by exact reason', codes && codes.includes('RECLASSIFICATION_REQUIRED'), codes);
    check('a preceding row was really written inside the doomed transaction', h.calls.upsert.length === 1, h.calls.upsert);
    check('one bad row rolls back the preceding good row',
      h.rows().find((row) => row.id === 'A-1200').name_ar === seed.find((row) => row.id === 'A-1200').name_ar,
      h.rows().find((row) => row.id === 'A-1200'));
    check('mixed-validity file commits nothing', h.calls.rollbacks === 1 && h.calls.commits === 0, h.calls);
  }

  // The same atomicity contract holds for an unexpected service failure, not
  // merely importer validation errors.
  {
    const h = makeHarness(seed, { throwOnName: 'انفجر' });
    const error = await rejected(() => importer.importAccounts([
      validRow({ id: 'A-1100', code: '1100', nameAr: 'انفجر', nameEn: 'Explode' }),
      validRow({ id: 'A-1200', code: '1200', nameAr: 'تم أولاً', nameEn: 'Done first' }),
    ], {}, 'update', h.options()));
    check('service failure is not swallowed', error && error.code === 'INJECTED_FAILURE', error);
    check('service failure happened after one successful row', h.calls.upsert.length === 2, h.calls.upsert);
    check('service failure rolls back every row', safe(h.rows()) === safe(seed), h.rows());
    check('service failure has one rollback and zero commits',
      h.calls.rollbacks === 1 && h.calls.commits === 0, h.calls);
  }

  // Each structural mutation is rejected even though the fake service would
  // happily execute it. No mutation may hide behind a generic >=400 assertion.
  const structureCases = [
    ['renumber', validRow({ code: '1199' }), 'RENUMBER_REQUIRES_MANIFEST'],
    ['move', validRow({ parentCode: '1200' }), 'MOVE_REQUIRES_GOVERNED_ROUTE'],
    ['retype', validRow({ type: 'revenue' }), 'RECLASSIFICATION_REQUIRED'],
    ['folder flip', validRow({ kind: 'folder' }), 'FOLDER_CHANGE_REQUIRES_GOVERNED_ROUTE'],
  ];
  for (const [name, row, expectedCode] of structureCases) {
    const h = makeHarness(seed);
    const error = await rejected(() => importer.importAccounts([row], {}, 'update', h.options()));
    const codes = error && error.details && error.details.errors.map((item) => item.code);
    check(name + ' is rejected by exact reason', codes && codes.includes(expectedCode), codes);
    check(name + ' reaches no write service',
      h.calls.upsert.length === 0 && h.calls.create.length === 0, h.calls);
    check(name + ' leaves structure unchanged', safe(h.rows()) === safe(seed), h.rows());
  }

  // Supplying id X with code owned by Y is neither an update nor a create.
  {
    const h = makeHarness(seed);
    const error = await rejected(() => importer.importAccounts([
      validRow({ id: 'A-1100', code: '1200' }),
    ], {}, 'update', h.options()));
    const codes = error && error.details && error.details.errors.map((item) => item.code);
    check('id/code collision cannot overwrite either account',
      codes && (codes.includes('RENUMBER_REQUIRES_MANIFEST') || codes.includes('IDENTITY_COLLISION')), codes);
    check('id/code collision writes nothing', h.calls.upsert.length === 0, h.calls);
    check('id/code collision rolls back', h.calls.rollbacks === 1 && h.calls.commits === 0, h.calls);
  }

  // The safe importer is deliberately fixed to CO-MAIN. A same-code account
  // in another company must neither make the row ambiguous nor be mutated.
  {
    const scopedSeed = seed.concat([
      account('OTHER-ROOT', '9000', null, {
        name_ar: 'جذر آخر', name_en: 'Other root', is_folder: 1, company_id: 'CO-2',
      }),
      account('OTHER-1100', '1100', 'OTHER-ROOT', { company_id: 'CO-2' }),
    ]);
    const h = makeHarness(scopedSeed);
    const result = await importer.importAccounts([
      validRow({ id: '', code: '1100' }),
    ], {}, 'update', h.options());
    check('same code in another company does not make CO-MAIN ambiguous',
      result.updated === 1 && h.calls.upsert.length === 1, { result, calls: h.calls });
    check('foreign-company account is never selected or mutated',
      h.rows().find((row) => row.id === 'OTHER-1100').name_ar === scopedSeed.find((row) => row.id === 'OTHER-1100').name_ar,
      h.rows().find((row) => row.id === 'OTHER-1100'));
    check('import query carries the fixed CO-MAIN predicate',
      h.calls.queries.some((sql) => /COALESCE\(company_id, ['"]CO-MAIN['"]\) = ['"]CO-MAIN['"]/.test(sql)), h.calls.queries);
  }

  // A legitimate update changes names only and returns deletion count zero.
  {
    const h = makeHarness(seed);
    const result = await importer.importAccounts([
      validRow({
        nameAr: 'النقدية والبنوك', nameEn: 'Cash and banks',
        reportSection: 'invented_overwrite', cashFlowActivity: 'financing', taxNature: 'zakat',
      }),
    ], { actor: 'accountant' }, 'update', h.options());
    const row = h.rows().find((item) => item.id === 'A-1100');
    const sent = h.calls.upsert[0];
    check('valid update changes the Arabic name', row.name_ar === 'النقدية والبنوك', row);
    check('valid update changes the English name', row.name_en === 'Cash and banks', row);
    check('valid update preserves code/parent/type/folder',
      row.code === '1100' && row.parent_id === 'ROOT' && row.type === 'asset' && row.is_folder === 0,
      row);
    check('service receives locked structural values, never spreadsheet guesses',
      sent.code === '1100' && sent.parentId === 'ROOT' && sent.type === 'asset' && sent.isFolder === false,
      sent);
    check('existing-account metadata is preserved and never sent to the updater',
      row.report_section === 'cash' && row.cash_flow_activity === 'operating' && row.tax_nature === 'none' &&
      !Object.prototype.hasOwnProperty.call(sent, 'reportSection') &&
      !Object.prototype.hasOwnProperty.call(sent, 'cashFlowActivity') &&
      !Object.prototype.hasOwnProperty.call(sent, 'taxNature'), { row, sent });
    check('safe result can never report deletions', result.deleted === 0, result);
    check('importer SQL never disables FK or deletes rows',
      h.calls.queries.every((sql) => !/FOREIGN_KEY_CHECKS|\bDELETE\b/i.test(sql)), h.calls.queries);
  }

  // Route wiring: both success and catch branches return through the safe
  // module before the quarantined legacy block. If a future edit removes one
  // of those returns this assertion fails immediately.
  {
    const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'erp.js'), 'utf8');
    const start = routeSource.indexOf("router.post('/gl/accounts/import'");
    const next = routeSource.indexOf("\nrouter.post('/gl/accounts/dedupe'", start);
    const handler = routeSource.slice(start, next);
    const safeCall = handler.indexOf('await coaImport.importAccounts(rows, _coaCtx(req), requestedMode)');
    const retiredBlock = handler.indexOf('const mode = String');
    const successReturn = handler.indexOf("return res.json({ success: true, mode: 'update', ...result })");
    const failureReturn = handler.indexOf("return _coaFail(res, e, 'import')");
    check('route imports the safe module once',
      routeSource.includes("const coaImport = require('../lib/coa/import')"));
    check('route calls safe importer before retired implementation',
      safeCall >= 0 && retiredBlock > safeCall, { safeCall, retiredBlock });
    check('safe route success returns before retired implementation',
      successReturn > safeCall && successReturn < retiredBlock, { successReturn, retiredBlock });
    check('safe route failure returns before retired implementation',
      failureReturn > safeCall && failureReturn < retiredBlock, { failureReturn, retiredBlock });
    const retiredMentions = handler.match(/retiredUnsafeImporter\s*\(/g) || [];
    check('historical importer is quarantined in a named function',
      handler.includes('async function retiredUnsafeImporter()'), retiredMentions);
    check('historical importer is never invoked', retiredMentions.length === 1, retiredMentions);
  }

  if (failures.length) {
    console.error('\ncoaSafeImport: ' + failures.length + ' failure(s)');
    failures.forEach((failure) => console.error(' - ' + failure));
    process.exit(1);
  }
  console.log('coaSafeImport: ' + pass + '/' + pass + ' checks passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
