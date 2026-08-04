'use strict';
/**
 * lib/coa/service.js — THE write gate for the chart of accounts.
 *
 * WHY THIS EXISTS
 *
 * Before this file, `gl_accounts` had four independent writers in
 * routes/erp.js (the upsert, /move, /:id/folder, DELETE) and each one knew a
 * different, smaller subset of the rules:
 *
 *   * `POST /gl/accounts` wrote `parent_id` with NO existence check, NO cycle
 *     check and NO type check. Only `/move` checked cycles — so the ONE call
 *     that could not create a cycle was guarded, and the upsert (which can, on
 *     its update branch) was not. A single POST could orphan an account under a
 *     parent id that does not exist, or put a revenue account under Assets.
 *
 *   * Root protection was `['1','2','3','4','5'].indexOf(code)`. That is a
 *     numbering scheme, not an identity. It is true in dev and FALSE in
 *     production, where the roots are 100000..500000 — so in production the
 *     "you cannot move a root" guard protected nothing at all. `is_system_root`
 *     (migration 0028) is the durable answer: protection travels with the row.
 *
 *   * Failures answered **HTTP 200 with `{success:false}`**. Every HTTP-level
 *     consumer — a proxy, a retry policy, a monitoring probe, a test asserting
 *     `res.ok` — read a rejected write as a successful one.
 *
 *   * Two people editing the same account last-write-wins in silence, and
 *     nothing at all was written to `audit_logs` for a structural change to the
 *     ledger's own skeleton.
 *
 * THE CONTRACT
 *
 *   1. Every mutation runs inside `db.withTransaction` and takes
 *      `SELECT … FOR UPDATE` on the rows it is about to reason over. Reading a
 *      parent without locking it means the cycle check can be true when it is
 *      read and false when it is written.
 *   2. Every guard throws a typed `CoaError` carrying `{ code, httpStatus }`,
 *      so the route layer maps it MECHANICALLY. String-matching an error
 *      message to pick a status code is how `/move` ended up answering 400 for
 *      "account not found".
 *   3. `level` is DERIVED. `coaTree.recomputeLevels` is its only writer and it
 *      runs inside the same transaction as any topology change.
 *   4. Every successful mutation bumps `version` and stamps
 *      `updated_by`/`updated_at`, and writes an audit row through `logAuditTx`
 *      — which does NOT swallow failures, so a structural change that cannot be
 *      recorded is rolled back rather than performed unrecorded.
 *
 * `../auditLogger` and `../../db/connection` are required LAZILY (inside the
 * functions that need them) so this module — and therefore its unit tests —
 * can be loaded with no database in sight.
 */

// `../coa/tree`, not `./tree`, even though this file already lives in lib/coa:
// the repo-wide structural gate in tests/coaTree.test.js asserts that EVERY
// file mentioning `coaTree.` imports a path ending in `coa/tree`, which is how
// it catches a file that uses the structural authority without importing it.
// A sibling-relative `./tree` is invisible to that check.
const coaTree = require('../coa/tree');
const coaClassify = require('../coa/classify');
const { randomUUID } = require('crypto');

// There is no trustworthy company claim in the JWT yet and the shell company
// selector is presentation-only. Canonical accounting therefore stays pinned
// to the single legal ledger. NULL remains a legacy spelling of CO-MAIN while
// migration 0032 closes that gap.
const LEDGER_COMPANY_ID = 'CO-MAIN';

/** A chart deeper than this is a modelling error, not a chart. */
const MAX_DEPTH = 5;
/** Hard cap on any parent walk so malformed data cannot spin forever. */
const MAX_WALK = 64;
/** Hard cap on a subtree walk, for the same reason. */
const MAX_SUBTREE = 10000;

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const STATUSES = ['active', 'blocked', 'archived'];
const TAX_NATURES = ['none', 'vat_input', 'vat_output', 'zakat', 'withholding', 'gosi', 'eosb'];

function sectionAccountType(section) {
  if (!section) return null;
  if (section.statement === 'income_statement') {
    return section.group === 'revenue' ? 'revenue' : 'expense';
  }
  if (section.statement === 'balance_sheet') {
    if (/Assets$/i.test(section.group)) return 'asset';
    if (/Liabilities$/i.test(section.group)) return 'liability';
    if (section.group === 'equity') return 'equity';
  }
  return null;
}

function assertSectionMatchesType(section, type) {
  const expectedType = sectionAccountType(section);
  if (expectedType && expectedType !== type) {
    fail('REPORT_SECTION_TYPE_MISMATCH', 'تصنيف القائمة المالية لا يطابق فئة الحساب', {
      reportSection: section.id,
      expectedType,
      receivedType: type,
    });
  }
}

/**
 * code → HTTP status. This table IS the mapping; the route layer reads it and
 * never decides a status for itself.
 *
 *   400 the request is malformed / contains something we refuse to accept
 *   404 a row the request names does not exist
 *   409 someone else changed it first, or the write collides with a unique key
 *   422 the request is well-formed but violates a chart-of-accounts rule
 *   500 we did not anticipate this
 */
const ERROR_STATUS = {
  // 400 — malformed request
  LEVEL_NOT_ACCEPTED: 400,
  CODE_REQUIRED: 400,
  NAME_REQUIRED: 400,
  TYPE_INVALID: 400,
  STATUS_INVALID: 400,
  ID_REQUIRED: 400,
  EXPECTED_VERSION_INVALID: 400,
  IS_FOLDER_REQUIRED: 400,
  NAME_EN_REQUIRED: 400,
  CODE_FORMAT_INVALID: 400,
  REPORT_SECTION_INVALID: 400,
  CASH_FLOW_ACTIVITY_INVALID: 400,
  TAX_NATURE_INVALID: 400,
  // 404 — a named row is absent
  ACCOUNT_NOT_FOUND: 404,
  PARENT_NOT_FOUND: 404,
  // 409 — concurrent change / unique-key collision
  VERSION_CONFLICT: 409,
  CODE_CONFLICT: 409,
  MOVE_ENDPOINT_REQUIRED: 409,
  // 422 — well-formed, but the chart says no
  SELF_PARENT: 422,
  ACCOUNT_CYCLE: 422,
  PARENT_HAS_ENTRIES: 422,
  TYPE_MISMATCH: 422,
  MAX_DEPTH_EXCEEDED: 422,
  SYSTEM_ROOT_PROTECTED: 422,
  HAS_CHILDREN: 422,
  HAS_ENTRIES: 422,
  NOT_POSTABLE: 422,
  ROOT_CREATE_FORBIDDEN: 422,
  CODE_CLASS_MISMATCH: 422,
  PARENT_NOT_FOLDER: 422,
  RENUMBER_DISABLED: 422,
  TYPE_CHANGE_REQUIRES_RECLASSIFICATION: 422,
  SYSTEM_MANAGED_PROTECTED: 422,
  COMPANY_SCOPE_REQUIRED: 422,
  IMPORT_INVALID: 422,
  REPORT_SECTION_TYPE_MISMATCH: 422,
  ROOT_MOVE_FORBIDDEN: 422,
  COMPANY_SCOPE_MISMATCH: 422,
  COA_DEDUPE_RETIRED: 410,
  // 500
  INTERNAL: 500,
};

class CoaError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'CoaError';
    this.isCoaError = true;
    this.code = code;
    this.httpStatus = ERROR_STATUS[code] || 500;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new CoaError(code, message, details);
}

function isCoaError(e) {
  return !!(e && e.isCoaError === true && e.code && e.httpStatus);
}

/**
 * Map ANY thrown value onto `{ httpStatus, code, error }`.
 *
 * MySQL's own duplicate-key error is translated here rather than left to
 * become a 500: a duplicate `code` is a 409, and the caller can act on it.
 * Everything unrecognised is a 500 — a rejected write must never be able to
 * masquerade as a validation failure the user can "fix".
 */
function toHttpError(e) {
  if (isCoaError(e)) {
    return { httpStatus: e.httpStatus, code: e.code, error: e.message, details: e.details };
  }
  if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
    return { httpStatus: 409, code: 'CODE_CONFLICT', error: 'رمز الحساب مستخدم مسبقًا' };
  }
  if (e && (e.code === 'ER_NO_REFERENCED_ROW_2' || e.errno === 1452)) {
    return { httpStatus: 404, code: 'PARENT_NOT_FOUND', error: 'الحساب الأب غير موجود' };
  }
  if (e && (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451)) {
    return { httpStatus: 422, code: 'HAS_CHILDREN', error: 'لا يمكن حذف حساب لديه حسابات فرعية' };
  }
  return {
    httpStatus: 500,
    code: 'INTERNAL',
    error: (e && e.message) || 'خطأ غير متوقع',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Low-level reads. Every one goes through `conn` so it participates in the
// caller's transaction — a guard that reads outside the transaction is not a
// guard, it is a race.
// ───────────────────────────────────────────────────────────────────────────

const ACCOUNT_COLUMNS =
  'id, code, name_ar, name_en, type, parent_id, level, is_folder, is_active, ' +
  'display_order, company_id, normal_balance, is_contra, contra_of_account_id, ' +
  'is_postable, is_control, report_section, cash_flow_activity, tax_nature, status, version, ' +
  'is_system_root, system_managed, class_code, source_entity_type, source_entity_id';

async function rows(conn, sql, params) {
  const r = await conn.query(sql, params || []);
  // mysql2 returns [rows, fields]; a fake conn in a unit test may return rows
  // directly. Accept both rather than making the test mimic a driver detail.
  return Array.isArray(r) && Array.isArray(r[0]) ? r[0] : (Array.isArray(r) ? r : []);
}

/** Load one account. `lock:true` takes a row lock — required before mutating. */
async function loadAccount(conn, id, opts) {
  const lock = opts && opts.lock;
  const r = await rows(
    conn,
    "SELECT " + ACCOUNT_COLUMNS + " FROM gl_accounts WHERE id = ? AND COALESCE(company_id,'CO-MAIN') = ? LIMIT 1" + (lock ? ' FOR UPDATE' : ''),
    [id, LEDGER_COMPANY_ID]
  );
  return r.length ? r[0] : null;
}

/** Identity probe used only to distinguish a foreign parent from a missing id. */
async function loadAccountAnyCompany(conn, id, opts) {
  const lock = opts && opts.lock;
  const r = await rows(
    conn,
    'SELECT ' + ACCOUNT_COLUMNS + ' FROM gl_accounts WHERE id = ? LIMIT 1' + (lock ? ' FOR UPDATE' : ''),
    [id]
  );
  return r.length ? r[0] : null;
}

function companyScopeOf(account) {
  return account && account.company_id ? String(account.company_id) : LEDGER_COMPANY_ID;
}

/** Load one account or throw the 404. */
async function requireAccount(conn, id, opts) {
  if (!id) fail('ID_REQUIRED', 'معرّف الحساب مطلوب');
  const acc = await loadAccount(conn, id, opts);
  if (!acc) fail('ACCOUNT_NOT_FOUND', 'الحساب غير موجود', { id });
  return acc;
}

async function childCount(conn, id) {
  const r = await rows(conn,
    "SELECT COUNT(*) AS n FROM gl_accounts WHERE parent_id = ? AND COALESCE(company_id,'CO-MAIN') = ?",
    [id, LEDGER_COMPANY_ID]);
  return Number((r[0] && r[0].n) || 0);
}

async function entryCount(conn, id) {
  const r = await rows(conn, 'SELECT COUNT(*) AS n FROM gl_entries WHERE account_id = ?', [id]);
  return Number((r[0] && r[0].n) || 0);
}

/**
 * Is `code` already taken, inside the same company?
 *
 * Company-scoped because migration 0028 replaced the global `UNIQUE(code)`
 * with `UNIQUE(company_id, code)` — checking globally would reject a code that
 * the database is perfectly happy to accept for a second company.
 */
async function findByCode(conn, code, companyId, excludeId) {
  if (companyId != null && String(companyId) !== LEDGER_COMPANY_ID) {
    fail('COMPANY_SCOPE_MISMATCH', 'This endpoint is fixed to the CO-MAIN ledger', {
      expectedCompanyId: LEDGER_COMPANY_ID, receivedCompanyId: String(companyId),
    });
  }
  const r = await rows(
    conn,
    "SELECT id, code FROM gl_accounts WHERE code = ? AND COALESCE(company_id,'CO-MAIN') = ? " +
      'AND (id <> ? OR ? IS NULL) LIMIT 1',
    [code, LEDGER_COMPANY_ID, excludeId || '', excludeId || null]
  );
  return r.length ? r[0] : null;
}

/**
 * Walk from `startId` up to its root, returning `[start, parent, …, root]`.
 *
 * Cycle-safe and capped twice over: a repeated id ends the walk with
 * ACCOUNT_CYCLE, and MAX_WALK hops does too. A guard that can hang is worse
 * than the defect it guards against.
 */
async function ancestorChain(conn, startId, opts) {
  const lock = opts && opts.lock;
  const chain = [];
  const seen = new Set();
  let cursor = startId;
  let hops = 0;
  while (cursor) {
    if (seen.has(cursor)) {
      fail('ACCOUNT_CYCLE', 'دورة في شجرة الحسابات', { at: cursor, chain: chain.map((a) => a.id) });
    }
    if (++hops > MAX_WALK) {
      fail('ACCOUNT_CYCLE', 'سلسلة الحسابات أعمق من الحد المسموح', { chain: chain.map((a) => a.id) });
    }
    seen.add(cursor);
    const acc = await loadAccount(conn, cursor, { lock: !!lock });
    if (!acc) break; // a dangling parent_id ends the walk; the caller decides
    chain.push(acc);
    cursor = acc.parent_id || null;
  }
  return chain;
}

/**
 * Every descendant of `id`, level by level, with the height of the subtree.
 *
 * BFS rather than a `code LIKE 'prefix%'` scan: codes are a naming convention
 * and `parent_id` is the structure. They agree until someone renumbers.
 * `height` counts the node itself, so a leaf has height 1.
 */
async function subtree(conn, id) {
  const descendants = [];
  let frontier = [id];
  let height = 1;
  const seen = new Set([id]);
  while (frontier.length) {
    const placeholders = frontier.map(() => '?').join(',');
    const kids = await rows(
      conn,
      "SELECT id, code, name_ar, parent_id FROM gl_accounts WHERE parent_id IN (" + placeholders + ") AND COALESCE(company_id,'CO-MAIN') = ?",
      frontier.concat([LEDGER_COMPANY_ID])
    );
    const next = [];
    for (const k of kids) {
      if (seen.has(k.id)) continue; // a cycle cannot make this loop forever
      seen.add(k.id);
      descendants.push(k);
      next.push(k.id);
    }
    if (!next.length) break;
    height++;
    if (descendants.length > MAX_SUBTREE || height > MAX_WALK) {
      fail('ACCOUNT_CYCLE', 'شجرة الحساب أكبر من الحد المسموح', { id });
    }
    frontier = next;
  }
  return { descendants, height };
}

// ───────────────────────────────────────────────────────────────────────────
// Guards. Each one is exported so it can be tested on its own and reused;
// each one throws a CoaError and returns nothing useful otherwise.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Optimistic concurrency. `expectedVersion` is OPTIONAL — a caller that does
 * not send one keeps the old last-write-wins behaviour, which is what the
 * existing frontend does today. When it IS sent it is enforced, and a
 * mismatch is a 409 carrying the current version so the client can refetch.
 */
function assertVersion(account, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return;
  const want = Number(expectedVersion);
  if (!Number.isFinite(want) || want < 0) {
    fail('EXPECTED_VERSION_INVALID', 'رقم الإصدار المتوقع غير صالح', { expectedVersion });
  }
  const have = Number(account.version == null ? 1 : account.version);
  if (want !== have) {
    fail('VERSION_CONFLICT', 'تم تعديل الحساب من مستخدم آخر — أعد تحميل البيانات', {
      expectedVersion: want, currentVersion: have, id: account.id,
    });
  }
}

/**
 * The five class roots are structural. They may be renamed; they may not be
 * moved, deactivated, demoted out of folder status, retyped or deleted.
 *
 * `is_system_root` (0028) replaces the old `code in ('1'..'5')` test, which
 * described dev's numbering and protected nothing in production.
 */
function assertNotSystemRoot(account, action) {
  if (Number(account && account.is_system_root) === 1) {
    fail('SYSTEM_ROOT_PROTECTED', 'لا يمكن تعديل حساب رئيسي نظامي (' + (action || 'change') + ')', {
      id: account.id, code: account.code, action: action || 'change',
    });
  }
}

/**
 * "May a journal line hit this account?" — as a reason code, or null.
 *
 * Folder, inactive and blocked are three different reasons and stay three
 * different answers; `status` distinguishes 'blocked' (refuse new postings,
 * keep it visible) from 'archived' (closed) in a way `is_active` alone cannot.
 */
function postabilityProblem(account, opts) {
  if (!account) return { code: 'ACCOUNT_NOT_FOUND', message: 'حساب غير موجود في أحد السطور' };
  if (Number(account.is_folder) === 1) {
    return { code: 'NOT_POSTABLE', message: 'لا يمكن الترحيل إلى حساب رئيسي (اختر حسابًا فرعيًا)' };
  }
  if (opts && opts.hasChildren) {
    return { code: 'NOT_POSTABLE', message: 'لا يمكن الترحيل إلى حساب رئيسي (اختر حسابًا فرعيًا)' };
  }
  const status = account.status == null ? null : String(account.status);
  if (status === 'blocked') {
    return { code: 'NOT_POSTABLE', message: 'لا يمكن الترحيل إلى حساب موقوف' };
  }
  if (status === 'archived') {
    return { code: 'NOT_POSTABLE', message: 'لا يمكن الترحيل إلى حساب مؤرشف' };
  }
  const active = account.is_active;
  if (!(active === 1 || active === true || active === '1')) {
    return { code: 'NOT_POSTABLE', message: 'لا يمكن الترحيل إلى حساب معطَّل' };
  }
  return null;
}

function assertPostable(account, opts) {
  const problem = postabilityProblem(account, opts);
  if (problem) fail(problem.code, problem.message, { id: account && account.id });
}

/**
 * Everything a write needs to know about the proposed parent, in one place:
 * that it exists, that it is not the node itself, that it is not below the
 * node, that the resulting depth fits, that the class root matches, and
 * whether the parent has to be promoted to a folder to accept a child.
 *
 * @param {object} conn
 * @param {object} args
 * @param {string|null} args.parentId    proposed parent (null = a root)
 * @param {string|null} args.movingId    the node being created/updated/moved
 * @param {string|null} args.type        the node's account type
 * @param {number}      args.height      height of the moving node's subtree (leaf = 1)
 * @param {boolean}     args.lock        take row locks while walking
 */
async function resolveParentContext(conn, args) {
  const parentId = (args && args.parentId) || null;
  const movingId = (args && args.movingId) || null;
  const type = (args && args.type) || null;
  const height = Math.max(1, Number((args && args.height) || 1));
  const lock = !!(args && args.lock);
  const companyId = (args && args.companyId) || LEDGER_COMPANY_ID;
  if (String(companyId) !== LEDGER_COMPANY_ID) {
    fail('COMPANY_SCOPE_MISMATCH', 'This endpoint is fixed to the CO-MAIN ledger', {
      expectedCompanyId: LEDGER_COMPANY_ID, receivedCompanyId: String(companyId),
    });
  }

  if (!parentId) {
    // A parentless account is a root. Allowed (the chart legitimately has
    // several) but it still may not be deeper than the cap once its own
    // subtree is counted.
    if (coaTree.DEPTH_BASE + height - 1 > MAX_DEPTH) {
      fail('MAX_DEPTH_EXCEEDED', 'عمق الشجرة يتجاوز الحد المسموح (' + MAX_DEPTH + ')',
        { maxDepth: MAX_DEPTH, resultingDepth: coaTree.DEPTH_BASE + height - 1 });
    }
    return { parent: null, chain: [], root: null, parentDepth: 0, newDepth: coaTree.DEPTH_BASE, needsPromotion: false };
  }

  if (movingId && parentId === movingId) {
    fail('SELF_PARENT', 'لا يمكن جعل الحساب أبًا لنفسه', { id: movingId });
  }

  const parent = await loadAccountAnyCompany(conn, parentId, { lock });
  if (!parent) fail('PARENT_NOT_FOUND', 'الحساب الأب غير موجود', { parentId });
  if (companyScopeOf(parent) !== LEDGER_COMPANY_ID) {
    fail('COMPANY_SCOPE_MISMATCH', 'لا يمكن ربط حساب بدفتر شركة أخرى', {
      parentId, expectedCompanyId: LEDGER_COMPANY_ID, receivedCompanyId: companyScopeOf(parent),
    });
  }

  // Cycle: walk UP from the proposed parent. If the moving node is anywhere on
  // that path, the move would put a node below itself.
  const chain = await ancestorChain(conn, parentId, { lock });
  if (movingId && chain.some((a) => a.id === movingId)) {
    fail('ACCOUNT_CYCLE', 'لا يمكن نقل الحساب تحت أحد أبنائه', {
      id: movingId, parentId, chain: chain.map((a) => a.id),
    });
  }

  const parentDepth = chain.length; // parent is chain[0]; a root parent → 1
  const newDepth = parentDepth + 1;
  if (newDepth + height - 1 > MAX_DEPTH) {
    fail('MAX_DEPTH_EXCEEDED', 'عمق الشجرة يتجاوز الحد المسموح (' + MAX_DEPTH + ')', {
      maxDepth: MAX_DEPTH, resultingDepth: newDepth + height - 1, parentDepth,
    });
  }

  const root = chain.length ? chain[chain.length - 1] : parent;
  if (type && root && root.type && String(root.type) !== String(type)) {
    fail('TYPE_MISMATCH', 'نوع الحساب لا يطابق نوع الجذر (' + root.type + ')', {
      type, rootType: root.type, rootId: root.id, rootCode: root.code,
    });
  }

  // A posting leaf may not become a parent as a hidden side effect of adding
  // a child. The operator must first convert an UNUSED row to a control
  // account through the explicit folder action. That keeps one click from
  // silently changing what journals may post to.
  let needsPromotion = false;
  if (Number(parent.is_folder) !== 1) {
    const kids = await childCount(conn, parent.id);
    if (kids === 0) {
      const posts = await entryCount(conn, parent.id);
      if (posts > 0) {
        fail('PARENT_HAS_ENTRIES', 'لا يمكن جعل حساب عليه قيود حسابًا رئيسيًا', {
          parentId: parent.id, parentCode: parent.code, entryCount: posts,
        });
      }
      fail('PARENT_NOT_FOLDER', 'الحساب الأب يجب أن يكون حسابًا تجميعيًا', {
        parentId: parent.id, parentCode: parent.code,
      });
    }
  }

  return { parent, chain, root, parentDepth, newDepth, needsPromotion };
}

// ───────────────────────────────────────────────────────────────────────────
// Input normalisation
// ───────────────────────────────────────────────────────────────────────────

/**
 * `level` is derived and the request body may not carry it.
 *
 * It used to be destructured and then silently ignored — which reads, to
 * anyone sending it, exactly like it was accepted. Silent acceptance of a
 * field that does nothing is how a client ends up trusting a value the server
 * never honoured. Refusing it is the only honest answer.
 */
function rejectDerivedFields(input) {
  if (!input || typeof input !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(input, 'level') && input.level !== undefined) {
    fail('LEVEL_NOT_ACCEPTED',
      'الحقل level مشتق ولا يُقبل في الطلب — يُحسب من سلسلة الآباء',
      { field: 'level', received: input.level });
  }
}

function normalizeInput(input) {
  const src = input || {};
  rejectDerivedFields(src);

  const code = src.code == null ? '' : String(src.code).trim();
  if (!code) fail('CODE_REQUIRED', 'رمز الحساب مطلوب');
  if (!/^[1-5][0-9]{0,19}$/.test(code)) {
    fail('CODE_FORMAT_INVALID', 'رمز الحساب يجب أن يكون رقميًا ويبدأ من الفئة 1 إلى 5', {
      code, pattern: '^[1-5][0-9]{0,19}$',
    });
  }

  const nameAr = src.nameAr == null ? '' : String(src.nameAr).trim();
  if (!nameAr) fail('NAME_REQUIRED', 'اسم الحساب مطلوب');

  const type = src.type == null ? '' : String(src.type).trim();
  if (ACCOUNT_TYPES.indexOf(type) < 0) {
    fail('TYPE_INVALID', 'نوع الحساب غير صالح', { type, allowed: ACCOUNT_TYPES });
  }

  let status = null;
  if (src.status !== undefined && src.status !== null && src.status !== '') {
    status = String(src.status);
    if (STATUSES.indexOf(status) < 0) {
      fail('STATUS_INVALID', 'حالة الحساب غير صالحة', { status, allowed: STATUSES });
    }
  }

  let reportSection;
  if (Object.prototype.hasOwnProperty.call(src, 'reportSection')) {
    const rawSection = src.reportSection == null ? '' : String(src.reportSection).trim();
    if (!rawSection) reportSection = null;
    else {
      const section = coaClassify.resolveSection(rawSection);
      if (!section) {
        fail('REPORT_SECTION_INVALID', 'تصنيف القوائم المالية غير صالح', {
          reportSection: rawSection,
        });
      }
      reportSection = section.id;
    }
  }

  let cashFlowActivity;
  if (Object.prototype.hasOwnProperty.call(src, 'cashFlowActivity')) {
    const rawActivity = src.cashFlowActivity == null ? '' : String(src.cashFlowActivity).trim();
    cashFlowActivity = rawActivity || null;
    if (cashFlowActivity && !['operating', 'investing', 'financing', 'non_cash'].includes(cashFlowActivity)) {
      fail('CASH_FLOW_ACTIVITY_INVALID', 'تصنيف التدفق النقدي غير صالح', {
        cashFlowActivity,
      });
    }
  }

  let taxNature;
  if (Object.prototype.hasOwnProperty.call(src, 'taxNature')) {
    taxNature = src.taxNature == null || src.taxNature === '' ? 'none' : String(src.taxNature).trim();
    if (!TAX_NATURES.includes(taxNature)) {
      fail('TAX_NATURE_INVALID', 'تصنيف الضريبة غير صالح', { taxNature, allowed: TAX_NATURES });
    }
  }

  return {
    id: src.id ? String(src.id) : null,
    code,
    nameAr,
    // `null` means the caller omitted the bilingual value.  That distinction
    // matters on update: legacy callers must not erase a valid English name
    // merely because they pre-date the bilingual field.
    nameEn: src.nameEn == null ? null : String(src.nameEn).trim(),
    type,
    parentId: src.parentId ? String(src.parentId) : null,
    isFolder: typeof src.isFolder === 'boolean' ? src.isFolder : null,
    isActive: typeof src.isActive === 'boolean' ? src.isActive : null,
    status,
    reportSection,
    cashFlowActivity,
    taxNature,
    expectedVersion: src.expectedVersion,
  };
}

/**
 * `is_active` and `status` say overlapping things and both are read across the
 * codebase, so they are written together, always, from one rule:
 *
 *   status supplied  → it wins; is_active = (status === 'active')
 *   isActive true    → status 'active'
 *   isActive false   → status 'archived' if it was 'active', otherwise left
 *                      alone (so switching a *blocked* account "off" does not
 *                      silently reclassify it as closed)
 */
function resolveLifecycle(current, input) {
  const cur = current || {};
  const curStatus = cur.status == null ? 'active' : String(cur.status);
  if (input.status) {
    return { status: input.status, isActive: input.status === 'active' ? 1 : 0 };
  }
  if (input.isActive === true) return { status: 'active', isActive: 1 };
  if (input.isActive === false) {
    return { status: curStatus === 'active' ? 'archived' : curStatus, isActive: 0 };
  }
  return {
    status: curStatus,
    isActive: cur.is_active == null ? 1 : (Number(cur.is_active) ? 1 : 0),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Shared write helpers
// ───────────────────────────────────────────────────────────────────────────

async function audit(conn, action, id, actor, details, ip) {
  // Lazy require: keeps this module (and its unit tests) loadable with no DB.
  const { logAuditTx } = require('../auditLogger');
  await logAuditTx(conn, action, 'gl_account', id, actor || 'system', details || {}, ip || '');
}

/** Bump version + stamp the actor. Every successful mutation calls this. */
async function stamp(conn, id, actor) {
  await conn.query(
    'UPDATE gl_accounts SET version = COALESCE(version,1) + 1, updated_by = ?, updated_at = NOW() WHERE id = ?',
    [actor || 'system', id]
  );
  const r = await rows(conn, 'SELECT version FROM gl_accounts WHERE id = ?', [id]);
  return Number((r[0] && r[0].version) || 0);
}

/**
 * `is_postable` is authoritative from here on (0028 seeded it from the old
 * computed rule). Keep it in step with the two things that decide it: the
 * folder flag and whether the row has children.
 */
async function syncPostable(conn, id) {
  const acc = await loadAccount(conn, id);
  if (!acc) return;
  const kids = await childCount(conn, id);
  const postable = Number(acc.is_folder) === 1 || kids > 0 ? 0 : 1;
  if (Number(acc.is_postable) !== postable) {
    await conn.query('UPDATE gl_accounts SET is_postable = ? WHERE id = ?', [postable, id]);
  }
}

/** Promote a childless non-folder into a folder so it can accept a child. */
async function promoteToFolder(conn, parentId, actor, ip) {
  await conn.query('UPDATE gl_accounts SET is_folder = 1, is_postable = 0 WHERE id = ?', [parentId]);
  const version = await stamp(conn, parentId, actor);
  await audit(conn, 'coa.promote_folder', parentId, actor, { reason: 'child_added', version }, ip);
}

// ───────────────────────────────────────────────────────────────────────────
// Operations (transaction-scoped: they take a `conn` already inside a txn)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Create one account. Runs the full guard set BEFORE the insert — an orphan or
 * a type-mismatched account is not something you fix afterwards, because the
 * reports have already read it.
 */
async function createAccountTx(conn, input, ctx) {
  const c = ctx || {};
  const actor = c.actor || '';
  const data = normalizeInput(input);

  if (!data.parentId && c.allowRootCreate !== true) {
    fail('ROOT_CREATE_FORBIDDEN', 'لا يمكن إنشاء جذر جديد؛ استخدم أحد الجذور النظامية الخمسة', {
      code: data.code,
    });
  }
  if (!data.nameEn) {
    fail('NAME_EN_REQUIRED', 'الاسم الإنجليزي مطلوب للحسابات الجديدة');
  }

  const parentCtx = await resolveParentContext(conn, {
    parentId: data.parentId, movingId: null, type: data.type, height: 1, lock: true,
    companyId: LEDGER_COMPANY_ID,
  });

  if (c.companyId != null && String(c.companyId) !== LEDGER_COMPANY_ID) {
    fail('COMPANY_SCOPE_MISMATCH', 'This endpoint is fixed to the CO-MAIN ledger', {
      expectedCompanyId: LEDGER_COMPANY_ID, receivedCompanyId: String(c.companyId),
    });
  }
  const companyId = LEDGER_COMPANY_ID;
  const rootClass = parentCtx.root && (parentCtx.root.class_code || String(parentCtx.root.code || '')[0]);
  if (rootClass && data.code[0] !== String(rootClass)) {
    fail('CODE_CLASS_MISMATCH', 'رمز الحساب لا يطابق فئة الجذر', {
      code: data.code, rootCode: parentCtx.root.code, expectedPrefix: String(rootClass),
    });
  }
  const clash = await findByCode(conn, data.code, companyId, null);
  if (clash) fail('CODE_CONFLICT', 'رمز الحساب مستخدم مسبقًا: ' + data.code, { code: data.code, existingId: clash.id });

  const id = data.id || 'GL-' + randomUUID();
  const life = resolveLifecycle(null, data);
  const isFolder = data.isFolder === null ? 0 : (data.isFolder ? 1 : 0);
  const normalBalance = data.type === 'asset' || data.type === 'expense' ? 'debit' : 'credit';
  const reportSection = data.reportSection === undefined
    ? (parentCtx.parent && parentCtx.parent.report_section) || null
    : data.reportSection;
  const section = reportSection ? coaClassify.resolveSection(reportSection) : null;
  assertSectionMatchesType(section, data.type);
  const isContra = section && section.isContra ? 1 : 0;
  const cashFlowActivity = data.cashFlowActivity === undefined
    ? (parentCtx.parent && parentCtx.parent.cash_flow_activity) || null
    : data.cashFlowActivity;
  const taxNature = data.taxNature === undefined
    ? (parentCtx.parent && parentCtx.parent.tax_nature) || 'none'
    : data.taxNature;

  await conn.query(
    'INSERT INTO gl_accounts (id, code, name_ar, name_en, type, parent_id, level, is_folder, ' +
    'is_active, status, company_id, normal_balance, is_contra, report_section, cash_flow_activity, tax_nature, ' +
    'is_postable, version, created_by, updated_by, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,NOW())',
    [id, data.code, data.nameAr, data.nameEn, data.type, data.parentId || null,
     coaTree.DEPTH_BASE, isFolder, life.isActive, life.status, companyId, normalBalance,
     isContra, reportSection, cashFlowActivity, taxNature,
     isFolder ? 0 : 1, actor || null, actor || null]
  );

  if (parentCtx.needsPromotion) await promoteToFolder(conn, parentCtx.parent.id, actor, c.ip);
  if (parentCtx.parent) await syncPostable(conn, parentCtx.parent.id);

  // `level` is derived — this is its only writer, inside this transaction.
  await coaTree.recomputeLevels(conn, { rootId: id, companyId: LEDGER_COMPANY_ID });

  await audit(conn, 'coa.create', id, actor, {
    code: data.code, nameAr: data.nameAr, type: data.type,
    parentId: data.parentId || null, isFolder: !!isFolder, status: life.status,
    reportSection, cashFlowActivity, isContra: !!isContra,
  }, c.ip);

  return { id, version: 1, created: true };
}

/**
 * Update one account in place. Same guard set as create, plus the version
 * check and the system-root protections — a reparent through THIS path is
 * exactly as dangerous as one through /move, which is why it now runs the
 * same checks instead of none.
 */
async function updateAccountTx(conn, id, input, ctx) {
  const c = ctx || {};
  const actor = c.actor || '';
  const data = normalizeInput(input);

  const acc = await requireAccount(conn, id, { lock: true });
  assertVersion(acc, data.expectedVersion !== undefined ? data.expectedVersion : (c.expectedVersion));

  const before = {
    code: acc.code, nameAr: acc.name_ar, nameEn: acc.name_en, type: acc.type,
    parentId: acc.parent_id, isFolder: !!Number(acc.is_folder),
    isActive: !!Number(acc.is_active), status: acc.status,
    reportSection: acc.report_section || null,
    cashFlowActivity: acc.cash_flow_activity || null,
    isContra: !!Number(acc.is_contra),
  };

  const parentChanged = String(acc.parent_id || '') !== String(data.parentId || '');
  const typeChanged = String(acc.type) !== String(data.type);
  const codeChanged = String(acc.code) !== String(data.code);
  const life = resolveLifecycle(acc, data);
  const deactivating = Number(acc.is_active) === 1 && life.isActive === 0;
  const nextNameEn = data.nameEn === null ? String(acc.name_en || '') : data.nameEn;
  const nextReportSection = data.reportSection === undefined
    ? (acc.report_section || null)
    : data.reportSection;
  const nextSection = nextReportSection ? coaClassify.resolveSection(nextReportSection) : null;
  assertSectionMatchesType(nextSection, data.type);
  const nextIsContra = nextSection && nextSection.isContra ? 1 : 0;
  const nextCashFlowActivity = data.cashFlowActivity === undefined
    ? (acc.cash_flow_activity || null)
    : data.cashFlowActivity;
  const nextTaxNature = data.taxNature === undefined
    ? (acc.tax_nature || 'none')
    : data.taxNature;

  if (Number(acc.is_system_root) === 1) {
    if (parentChanged) assertNotSystemRoot(acc, 'move');
    if (typeChanged) assertNotSystemRoot(acc, 'retype');
    if (deactivating) assertNotSystemRoot(acc, 'deactivate');
    if (data.isFolder === false) assertNotSystemRoot(acc, 'demote');
  }

  const folderChanged = data.isFolder !== null && Number(acc.is_folder) !== (data.isFolder ? 1 : 0);
  if (Number(acc.system_managed) === 1 &&
      (parentChanged || typeChanged || codeChanged || folderChanged ||
       nextReportSection !== (acc.report_section || null) ||
       nextCashFlowActivity !== (acc.cash_flow_activity || null) ||
       nextTaxNature !== (acc.tax_nature || 'none'))) {
    fail('SYSTEM_MANAGED_PROTECTED', 'هذا الحساب تديره الوحدة المصدرية ولا يُعدّل هيكله يدويًا', {
      id, sourceEntityType: acc.source_entity_type || null,
    });
  }
  if (parentChanged) {
    fail('MOVE_ENDPOINT_REQUIRED', 'نقل الحساب يتم من صفحة النقل المدققة وليس من نموذج التعديل', {
      id, currentParentId: acc.parent_id || null, requestedParentId: data.parentId || null,
    });
  }
  if (codeChanged) {
    fail('RENUMBER_DISABLED', 'إعادة ترقيم الحساب تتطلب خطة ترحيل معتمدة وتحافظ على الأسماء البديلة', {
      id, currentCode: acc.code, requestedCode: data.code,
    });
  }
  if (typeChanged) {
    fail('TYPE_CHANGE_REQUIRES_RECLASSIFICATION', 'تغيير فئة الحساب يتطلب عملية إعادة تصنيف محاسبية معتمدة', {
      id, currentType: acc.type, requestedType: data.type,
    });
  }

  const { height } = await subtree(conn, id);
  const parentCtx = await resolveParentContext(conn, {
    parentId: data.parentId, movingId: id, type: data.type, height, lock: true,
    companyId: companyScopeOf(acc),
  });

  if (String(acc.code) !== data.code) {
    const clash = await findByCode(conn, data.code, acc.company_id, id);
    if (clash) fail('CODE_CONFLICT', 'رمز الحساب مستخدم مسبقًا: ' + data.code, { code: data.code, existingId: clash.id });
  }

  // A folder demotion is a real rule, not a flag flip — route it through the
  // same guards setFolder uses rather than letting the upsert bypass them.
  let isFolder = Number(acc.is_folder) ? 1 : 0;
  if (data.isFolder !== null) {
    const want = data.isFolder ? 1 : 0;
    if (want !== isFolder) {
      await assertFolderChangeAllowed(conn, acc, !!want);
      isFolder = want;
    }
  }

  const normalBalance = data.type === 'asset' || data.type === 'expense' ? 'debit' : 'credit';
  await conn.query(
    'UPDATE gl_accounts SET code = ?, name_ar = ?, name_en = ?, type = ?, parent_id = ?, ' +
    'is_folder = ?, is_active = ?, status = ?, normal_balance = ?, is_contra = ?, ' +
    'report_section = ?, cash_flow_activity = ?, tax_nature = ? WHERE id = ?',
    [data.code, data.nameAr, nextNameEn, data.type, data.parentId || null,
     isFolder, life.isActive, life.status, normalBalance, nextIsContra,
     nextReportSection, nextCashFlowActivity, nextTaxNature, id]
  );

  if (parentCtx.needsPromotion) await promoteToFolder(conn, parentCtx.parent.id, actor, c.ip);
  if (parentCtx.parent) await syncPostable(conn, parentCtx.parent.id);
  if (parentChanged && acc.parent_id) await syncPostable(conn, acc.parent_id);
  await syncPostable(conn, id);

  // The parent may have changed, which moves this node AND every descendant.
  await coaTree.recomputeLevels(conn, { rootId: id, companyId: LEDGER_COMPANY_ID });

  const version = await stamp(conn, id, actor);
  await audit(conn, 'coa.update', id, actor, {
    before,
    after: {
      code: data.code, nameAr: data.nameAr, nameEn: nextNameEn, type: data.type,
      parentId: data.parentId || null, isFolder: !!isFolder,
      isActive: !!life.isActive, status: life.status,
      reportSection: nextReportSection,
      cashFlowActivity: nextCashFlowActivity,
      taxNature: nextTaxNature,
      isContra: !!nextIsContra,
    },
    version,
  }, c.ip);

  return { id, version, created: false };
}

/** POST /gl/accounts is an upsert; this is the branch selector, guarded. */
async function upsertAccountTx(conn, input, ctx) {
  const src = input || {};
  rejectDerivedFields(src);
  if (src.id) {
    const existing = await loadAccount(conn, String(src.id));
    if (existing) return updateAccountTx(conn, String(src.id), src, ctx);
  }
  return createAccountTx(conn, src, ctx);
}

/**
 * The renumber plan for a move — computed, never applied, so `previewMove` and
 * `moveAccount` cannot disagree about what a move would do.
 *
 * Descendant selection stays CODE-PREFIX based, exactly as the shipped /move
 * did: changing it to a parent_id walk would renumber a different set of rows
 * than the endpoint has been renumbering, and the codes are what the ledger's
 * denormalised `gl_entries.account_code` points at.
 */
async function computeRenumberPlan(conn, acc, newParent) {
  if (!newParent) return { newCode: acc.code, changes: [] };

  const siblings = await rows(
    conn, 'SELECT code FROM gl_accounts WHERE parent_id = ? ORDER BY code', [newParent.id]
  );
  let newCode;
  if (!siblings.length) {
    newCode = Number(newParent.level) >= 3 ? newParent.code + '01' : newParent.code + '1';
  } else {
    const last = siblings[siblings.length - 1].code;
    const suffix = String(last).substring(String(newParent.code).length);
    const nextNum = parseInt(suffix, 10) + 1;
    newCode = newParent.code + String(nextNum).padStart(suffix.length || 1, '0');
  }

  const oldPrefix = String(acc.code);
  const descRows = await rows(
    conn, 'SELECT id, code FROM gl_accounts WHERE code LIKE ? AND id <> ?', [oldPrefix + '%', acc.id]
  );
  const changes = [];
  for (const d of descRows) {
    if (!String(d.code).startsWith(oldPrefix)) continue;
    changes.push({ id: d.id, oldCode: d.code, newCode: newCode + String(d.code).substring(oldPrefix.length) });
  }
  return { newCode, changes };
}

/**
 * Move an account under a new parent, optionally renumbering the subtree.
 *
 * The shipped /move already checked cycles; what it did NOT check was type
 * compatibility, depth, whether the target could hold children, or the
 * version — and its root protection was the code-prefix test that is false in
 * production.
 */
async function moveAccountTx(conn, id, args, ctx) {
  const c = ctx || {};
  const actor = c.actor || '';
  const parentId = (args && args.parentId) || null;
  if (!parentId) {
    fail('ROOT_MOVE_FORBIDDEN', 'لا يمكن تحويل حساب عادي إلى جذر جديد', { id });
  }
  const willRenumber = !!(args && args.autoRenumber);
  if (willRenumber) {
    fail('RENUMBER_DISABLED', 'إعادة الترقيم المباشر معطلة؛ استخدم manifest ترحيل معتمد');
  }

  const acc = await requireAccount(conn, id, { lock: true });
  assertVersion(acc, args && args.expectedVersion);
  assertNotSystemRoot(acc, 'move');

  const { height } = await subtree(conn, id);
  const parentCtx = await resolveParentContext(conn, {
    parentId, movingId: id, type: acc.type, height, lock: true,
    companyId: companyScopeOf(acc),
  });
  const newParent = parentCtx.parent;

  const plan = willRenumber ? await computeRenumberPlan(conn, acc, newParent) : { newCode: acc.code, changes: [] };

  const renumbered = [];
  for (const ch of plan.changes) {
    const clash = await findByCode(conn, ch.newCode, acc.company_id, ch.id);
    if (clash) fail('CODE_CONFLICT', 'تعارض كود: ' + ch.newCode + ' موجود مسبقًا', { code: ch.newCode });
    await conn.query('UPDATE gl_accounts SET code = ? WHERE id = ?', [ch.newCode, ch.id]);
    await conn.query('UPDATE gl_entries SET account_code = ? WHERE account_id = ?', [ch.newCode, ch.id]);
    renumbered.push(ch);
  }

  if (String(plan.newCode) !== String(acc.code)) {
    const mainClash = await findByCode(conn, plan.newCode, acc.company_id, id);
    if (mainClash) fail('CODE_CONFLICT', 'تعارض كود: ' + plan.newCode + ' موجود مسبقًا', { code: plan.newCode });
  }
  await conn.query('UPDATE gl_accounts SET code = ?, parent_id = ? WHERE id = ?',
    [plan.newCode, parentId || null, id]);
  await conn.query('UPDATE gl_entries SET account_code = ? WHERE account_id = ?', [plan.newCode, id]);
  renumbered.push({ id, oldCode: acc.code, newCode: plan.newCode });

  if (parentCtx.needsPromotion) await promoteToFolder(conn, newParent.id, actor, c.ip);
  if (newParent) await syncPostable(conn, newParent.id);
  if (acc.parent_id) await syncPostable(conn, acc.parent_id);
  await syncPostable(conn, id);

  // Levels are DERIVED and a move changes the depth of the WHOLE subtree.
  const levels = await coaTree.recomputeLevels(conn, { rootId: id, companyId: LEDGER_COMPANY_ID });

  const version = await stamp(conn, id, actor);
  await audit(conn, 'coa.move', id, actor, {
    oldParentId: acc.parent_id || null, newParentId: parentId || null,
    oldCode: acc.code, newCode: plan.newCode,
    renumbered: renumbered.length, levelsUpdated: levels.updated, version,
  }, c.ip);

  return {
    renumbered, oldCode: acc.code, newCode: plan.newCode,
    newParentId: parentId || null, levelsUpdated: levels.updated, version,
  };
}

/**
 * What WOULD a move do? Read-only, by construction: it issues SELECTs only,
 * never takes a lock, and reports rule violations as `blockers` rather than
 * throwing, so a UI can show every problem at once instead of one per attempt.
 *
 * The single exception is a missing subject account — there is nothing to
 * preview, so that stays a 404.
 */
async function previewMoveTx(conn, id, newParentId, args) {
  const willRenumber = !!(args && args.autoRenumber);
  const acc = await requireAccount(conn, id, { lock: false });

  const blockers = [];
  const push = (e) => {
    const m = toHttpError(e);
    blockers.push({ code: m.code, message: m.error, details: m.details || null });
  };

  let oldChain = [];
  try { oldChain = await ancestorChain(conn, id, { lock: false }); } catch (e) { push(e); }

  let height = 1, descendants = [];
  try {
    const st = await subtree(conn, id);
    height = st.height; descendants = st.descendants;
  } catch (e) { push(e); }

  try { assertNotSystemRoot(acc, 'move'); } catch (e) { push(e); }

  let parentCtx = null;
  try {
    if (!newParentId) throw new CoaError('ROOT_MOVE_FORBIDDEN', 'لا يمكن تحويل حساب عادي إلى جذر جديد', { id });
    parentCtx = await resolveParentContext(conn, {
      parentId: newParentId, movingId: id, type: acc.type, height, lock: false,
      companyId: companyScopeOf(acc),
    });
  } catch (e) { push(e); }

  let plan = { newCode: acc.code, changes: [] };
  if (willRenumber && parentCtx && parentCtx.parent) {
    try { plan = await computeRenumberPlan(conn, acc, parentCtx.parent); } catch (e) { push(e); }
  }

  const label = (a) => ({ id: a.id, code: a.code, nameAr: a.name_ar == null ? null : a.name_ar });
  const oldPath = oldChain.slice().reverse().map(label);
  const newPath = parentCtx
    ? parentCtx.chain.slice().reverse().map(label).concat([{ id: acc.id, code: plan.newCode, nameAr: acc.name_ar }])
    : [];

  const entries = await entryCount(conn, id);

  return {
    id,
    oldPath,
    newPath,
    affectedChildren: descendants.map((d) => ({ id: d.id, code: d.code, nameAr: d.name_ar == null ? null : d.name_ar })),
    oldCodes: [{ id: acc.id, code: acc.code }].concat(plan.changes.map((ch) => ({ id: ch.id, code: ch.oldCode }))),
    proposedCodes: [{ id: acc.id, code: plan.newCode }].concat(plan.changes.map((ch) => ({ id: ch.id, code: ch.newCode }))),
    entryCount: entries,
    subtreeHeight: height,
    resultingDepth: parentCtx ? parentCtx.newDepth : null,
    blockers,
    ok: blockers.length === 0,
  };
}

/** Shared by setFolder and the upsert's folder flip, so they cannot diverge. */
async function assertFolderChangeAllowed(conn, acc, want) {
  if (!want) {
    assertNotSystemRoot(acc, 'demote');
    const kids = await childCount(conn, acc.id);
    if (kids > 0) fail('HAS_CHILDREN', 'لا يمكن إلغاء الفولدر — احذف الأبناء أولاً', { childCount: kids });
    return;
  }
  // Promoting a posting account into a folder hides its postings behind a
  // header account: every report that sums leaves would stop counting them.
  const posts = await entryCount(conn, acc.id);
  if (posts > 0) {
    fail('HAS_ENTRIES', 'لا يمكن تحويل حساب عليه قيود إلى حساب رئيسي', { entryCount: posts });
  }
}

async function setFolderTx(conn, id, isFolder, ctx) {
  const c = ctx || {};
  const actor = c.actor || '';
  if (typeof isFolder !== 'boolean') fail('IS_FOLDER_REQUIRED', 'قيمة isFolder مطلوبة (true/false)');

  const acc = await requireAccount(conn, id, { lock: true });
  assertVersion(acc, c.expectedVersion);

  const want = isFolder ? 1 : 0;
  if (Number(acc.is_folder) === want) {
    return { id, isFolder: !!want, version: Number(acc.version || 1), changed: false };
  }
  await assertFolderChangeAllowed(conn, acc, !!want);

  await conn.query('UPDATE gl_accounts SET is_folder = ? WHERE id = ?', [want, id]);
  await syncPostable(conn, id);
  const version = await stamp(conn, id, actor);
  await audit(conn, 'coa.set_folder', id, actor, {
    code: acc.code, from: !!Number(acc.is_folder), to: !!want, version,
  }, c.ip);

  return { id, isFolder: !!want, version, changed: true };
}

/**
 * Close an account without destroying its history. This is the correct answer
 * for an account that HAS postings: the ledger keeps them, the pickers stop
 * offering it, and historical reports still balance.
 */
async function archiveAccountTx(conn, id, ctx) {
  const c = ctx || {};
  const actor = c.actor || '';
  const acc = await requireAccount(conn, id, { lock: true });
  assertVersion(acc, c.expectedVersion);
  assertNotSystemRoot(acc, 'archive');

  const openKids = await rows(
    conn, "SELECT COUNT(*) AS n FROM gl_accounts WHERE parent_id = ? AND status <> 'archived'", [id]
  );
  const n = Number((openKids[0] && openKids[0].n) || 0);
  if (n > 0) fail('HAS_CHILDREN', 'أرشف الحسابات الفرعية أولاً', { openChildren: n });

  await conn.query(
    "UPDATE gl_accounts SET status = 'archived', is_active = 0, is_postable = 0, " +
    'archived_by = ?, archived_at = NOW() WHERE id = ?',
    [actor || null, id]
  );
  const version = await stamp(conn, id, actor);
  await audit(conn, 'coa.archive', id, actor, { code: acc.code, from: acc.status, version }, c.ip);
  return { id, status: 'archived', version };
}

/**
 * Hard delete. Kept because the CoA screen's delete button and several
 * integration tests depend on it, but fenced: no children, no entries, not a
 * system root, version-checked, audited. Anything with history must be
 * ARCHIVED instead — the difference is now a status code, not a coin flip.
 */
async function deleteAccountTx(conn, id, ctx) {
  const c = ctx || {};
  const actor = c.actor || '';
  const acc = await requireAccount(conn, id, { lock: true });
  assertVersion(acc, c.expectedVersion);
  assertNotSystemRoot(acc, 'delete');

  const kids = await childCount(conn, id);
  if (kids > 0) fail('HAS_CHILDREN', 'لا يمكن حذف حساب لديه حسابات فرعية', { childCount: kids });
  const posts = await entryCount(conn, id);
  if (posts > 0) fail('HAS_ENTRIES', 'لا يمكن حذف حساب مستخدم في قيود محاسبية', { entryCount: posts });

  // Audit BEFORE the delete: logAuditTx does not swallow failures, so if the
  // audit row cannot be written the delete rolls back with it.
  await audit(conn, 'coa.delete', id, actor, {
    code: acc.code, nameAr: acc.name_ar, type: acc.type, parentId: acc.parent_id || null,
    version: Number(acc.version || 1),
  }, c.ip);
  await conn.query('DELETE FROM gl_accounts WHERE id = ?', [id]);
  if (acc.parent_id) await syncPostable(conn, acc.parent_id);
  return { id, deleted: true };
}

// ───────────────────────────────────────────────────────────────────────────
// Public API — each opens its own transaction. The *Tx variants above compose
// inside a caller's transaction (the import path, seeds, repairs).
// ───────────────────────────────────────────────────────────────────────────

function _db() {
  return require('../../db/connection');
}

const createAccount = (input, ctx) => _db().withTransaction((conn) => createAccountTx(conn, input, ctx));
const updateAccount = (id, input, ctx) => _db().withTransaction((conn) => updateAccountTx(conn, id, input, ctx));
const upsertAccount = (input, ctx) => _db().withTransaction((conn) => upsertAccountTx(conn, input, ctx));
const moveAccount = (id, args, ctx) => _db().withTransaction((conn) => moveAccountTx(conn, id, args, ctx));
const setFolder = (id, isFolder, ctx) => _db().withTransaction((conn) => setFolderTx(conn, id, isFolder, ctx));
const archiveAccount = (id, ctx) => _db().withTransaction((conn) => archiveAccountTx(conn, id, ctx));
const deleteAccount = (id, ctx) => _db().withTransaction((conn) => deleteAccountTx(conn, id, ctx));
/** previewMove reads only — no transaction, no locks, no writes. */
const previewMove = (id, newParentId, args) => previewMoveTx(_db(), id, newParentId, args);

module.exports = {
  // constants + error contract
  MAX_DEPTH, MAX_WALK, ACCOUNT_TYPES, STATUSES, TAX_NATURES, ERROR_STATUS, LEDGER_COMPANY_ID,
  CoaError, isCoaError, toHttpError,
  // reads
  loadAccount, requireAccount, childCount, entryCount, findByCode,
  ancestorChain, subtree, computeRenumberPlan,
  // guards
  assertVersion, assertNotSystemRoot, assertFolderChangeAllowed,
  resolveParentContext, rejectDerivedFields, normalizeInput, resolveLifecycle,
  postabilityProblem, assertPostable,
  // transaction-scoped operations
  createAccountTx, updateAccountTx, upsertAccountTx, moveAccountTx,
  previewMoveTx, setFolderTx, archiveAccountTx, deleteAccountTx,
  // self-transacting operations
  createAccount, updateAccount, upsertAccount, moveAccount,
  previewMove, setFolder, archiveAccount, deleteAccount,
};
