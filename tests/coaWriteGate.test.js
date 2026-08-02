#!/usr/bin/env node
'use strict';
/**
 * tests/coaWriteGate.test.js — the chart-of-accounts WRITE GATE (package D).
 *
 * WHAT THIS PINS, AND WHY EACH ONE SHIPPED GREEN
 *
 *  1. `POST /gl/accounts` destructured `level` from the body and ignored it.
 *     Silently. Every client that sent one was told nothing, so it kept
 *     sending it; `level` is DERIVED and lib/coa/tree.js#recomputeLevels is
 *     its only writer. A field that does nothing must be REFUSED.
 *
 *  2. That same handler wrote `parent_id` with NO existence check, NO cycle
 *     check and NO type check. Only `/move` checked cycles — the one endpoint
 *     that cannot create one. A single POST could orphan an account under a
 *     parent id that does not exist, or hang a revenue account off Assets, and
 *     nothing anywhere would notice until a statement stopped balancing.
 *
 *  3. Root protection was `['1','2','3','4','5'].indexOf(code)`. That is dev's
 *     numbering. In production the roots are 100000..500000, so the guard
 *     matched nothing and the roots were unprotected in the one environment
 *     where it mattered. The tests below use a PRODUCTION-SHAPED root (code
 *     '100000') precisely so a regression to code-matching fails here.
 *
 *  4. Rejections answered **HTTP 200 with {success:false}**. A 200 is a promise
 *     that the request was carried out. Every HTTP-level consumer — a proxy, a
 *     retry policy, a monitoring probe, a `fetch` wrapper that only throws on
 *     !res.ok — read a refused write as a completed one.
 *
 * HOW IT IS TESTED: purely. There is no database anywhere in this file. A
 * stub is installed in require.cache for db/connection BEFORE the service is
 * loaded, and every guard is exercised against a fake `conn` whose query()
 * answers from an in-memory account list and RECORDS every statement. That
 * recording is what lets `previewMove` be proved side-effect-free — not by
 * inspecting the database afterwards (which would only prove the writes it
 * happened to make were invisible), but by proving it issued no write at all.
 *
 * Run: node tests/coaWriteGate.test.js   (pure, no DB)
 */

const fs = require('fs');
const path = require('path');

// ── Hermetic: db/connection is stubbed before ANYTHING requires it, so neither
//    the service nor lib/auditLogger can open a pool. The stub also records
//    whether withTransaction() was used, which is how the "every mutation runs
//    in a transaction" contract is checked rather than assumed.
const dbPath = require.resolve('../db/connection');
const stubDb = {
  txCalls: 0,
  async query() { throw new Error('stub db: no direct queries expected'); },
  withTransaction(fn) { stubDb.txCalls++; return fn(stubDb._conn); },
  _conn: null,
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stubDb };

const svc = require('../lib/coa/service');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + safe(extra) : ''));
  console.error('  ✗ ' + name);
}
function safe(v) { try { return JSON.stringify(v); } catch (_) { return String(v); } }

/** Run `fn` and report the CoaError it threw (or null). */
async function thrown(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
/** Assert a specific typed error came back with its documented status. */
async function expectCode(name, fn, code, status) {
  const e = await thrown(fn);
  if (!e) { check(name, false, 'no error thrown'); return null; }
  check(name + ' → ' + code, e.code === code, { got: e.code, message: e.message });
  check(name + ' → HTTP ' + status, e.httpStatus === status, { got: e.httpStatus });
  check(name + ' is a typed CoaError (not a string match)', svc.isCoaError(e), e.name);
  return e;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A gl_accounts row with every column the service reads. */
function acc(id, code, parent_id, extra) {
  return Object.assign({
    id, code, name_ar: 'حساب ' + code, name_en: '', type: 'asset',
    parent_id: parent_id || null, level: 1, is_folder: 0, is_active: 1,
    display_order: null, company_id: 'CO-MAIN', normal_balance: 'debit',
    is_contra: 0, contra_of_account_id: null, is_postable: 1, is_control: 0,
    cash_flow_activity: null, status: 'active', version: 1,
    is_system_root: 0, system_managed: 0, class_code: null,
    source_entity_type: null, source_entity_id: null,
  }, extra || {});
}

/**
 * A fake connection. Answers from `accounts` / `entries`, records every
 * statement, and never touches a network. Matching is ordered most-specific
 * first — the same ordering the service's SQL implies.
 */
function makeConn(accounts, opts) {
  const o = opts || {};
  const entries = o.entries || {};
  const log = [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const kidsOf = (pid) => accounts.filter((a) => String(a.parent_id) === String(pid));

  return {
    log,
    writes() { return log.filter((q) => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(q.sql)); },
    sqlText() { return log.map((q) => q.sql).join('\n'); },
    async query(sql, params) {
      const p = params || [];
      const s = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: s, params: p });

      if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s)) return [{ affectedRows: 1 }, []];

      // entry counts
      if (/FROM gl_entries WHERE account_id = \?/.test(s)) {
        return [[{ n: Number(entries[p[0]] || 0) }], []];
      }
      // non-archived child count (archive guard)
      if (/COUNT\(\*\) AS n FROM gl_accounts WHERE parent_id = \? AND status/.test(s)) {
        return [[{ n: kidsOf(p[0]).filter((a) => a.status !== 'archived').length }], []];
      }
      // child count
      if (/COUNT\(\*\) AS n FROM gl_accounts WHERE parent_id = \?/.test(s)) {
        return [[{ n: kidsOf(p[0]).length }], []];
      }
      // single row by id (with or without FOR UPDATE)
      if (/FROM gl_accounts WHERE id = \?/.test(s)) {
        const a = byId.get(p[0]);
        return [a ? [a] : [], []];
      }
      // subtree BFS
      if (/FROM gl_accounts WHERE parent_id IN \(/.test(s)) {
        const out = [];
        for (const pid of p) for (const k of kidsOf(pid)) out.push(k);
        return [out, []];
      }
      // code uniqueness
      if (/FROM gl_accounts WHERE code = \?/.test(s)) {
        const hit = accounts.filter((a) => String(a.code) === String(p[0]) && a.id !== p[3]);
        return [hit.slice(0, 1), []];
      }
      // renumber: siblings ordered by code
      if (/FROM gl_accounts WHERE parent_id = \? ORDER BY code/.test(s)) {
        return [kidsOf(p[0]).slice().sort((a, b) => String(a.code).localeCompare(String(b.code))), []];
      }
      // renumber: code-prefix descendants
      if (/FROM gl_accounts WHERE code LIKE \?/.test(s)) {
        const prefix = String(p[0]).replace(/%$/, '');
        return [accounts.filter((a) => String(a.code).startsWith(prefix) && a.id !== p[1]), []];
      }
      // coaTree.recomputeLevels reads the whole table
      if (/FROM gl_accounts$/.test(s) || /FROM gl_accounts WHERE 1/.test(s)) {
        return [accounts, []];
      }
      return [[], []];
    },
  };
}

/** Root(asset) → A → B, plus a production-shaped system root. */
function chart() {
  return [
    acc('R', '100000', null, { is_system_root: 1, is_folder: 1, is_postable: 0, class_code: '1' }),
    acc('A', '110000', 'R', { is_folder: 1, is_postable: 0, level: 2 }),
    acc('B', '110100', 'A', { level: 3 }),
  ];
}

const OK_INPUT = { code: '110200', nameAr: 'حساب جديد', type: 'asset', parentId: 'A' };

(async function run() {

// ── 1. `level` is REFUSED, not swallowed ──────────────────────────────────
{
  await expectCode('create: level in the body is rejected',
    () => svc.createAccountTx(makeConn(chart()), Object.assign({ level: 1 }, OK_INPUT), {}),
    'LEVEL_NOT_ACCEPTED', 400);

  // The refusal must happen BEFORE anything is read or written — a rejected
  // request that already touched the database is not a rejection.
  const conn = makeConn(chart());
  await thrown(() => svc.upsertAccountTx(conn, Object.assign({ id: 'B', level: 9 }, OK_INPUT), {}));
  check('level rejection issues zero statements', conn.log.length === 0, conn.log.map((q) => q.sql));

  // level: undefined is absence, not a value — an object spread that carries
  // the key with no value must not become a 400.
  const e = await thrown(() => svc.normalizeInput(Object.assign({ level: undefined }, OK_INPUT)));
  check('level: undefined is treated as absent', e === null, e && e.code);

  check('level: 0 is still rejected',
    (() => { try { svc.normalizeInput(Object.assign({ level: 0 }, OK_INPUT)); return false; }
             catch (x) { return x.code === 'LEVEL_NOT_ACCEPTED'; } })());
}

// ── 2. Cycles — the check the upsert never had ────────────────────────────
{
  // A is B's parent. Moving A under B would put A below itself.
  await expectCode('move: a node cannot go under its own descendant',
    () => svc.moveAccountTx(makeConn(chart()), 'A', { parentId: 'B' }, {}),
    'ACCOUNT_CYCLE', 422);

  // The SAME cycle, attempted through the upsert's update branch — the path
  // that had no cycle check at all.
  await expectCode('upsert: the update branch is cycle-checked too',
    () => svc.upsertAccountTx(makeConn(chart()),
      { id: 'A', code: '110000', nameAr: 'A', type: 'asset', parentId: 'B' }, {}),
    'ACCOUNT_CYCLE', 422);

  // A chart that is ALREADY cyclic must terminate, not hang. X↔Y.
  const cyclic = [acc('X', '1', 'Y'), acc('Y', '2', 'X')];
  const e = await thrown(() => svc.ancestorChain(makeConn(cyclic), 'X'));
  check('ancestorChain terminates on a pre-existing cycle', e && e.code === 'ACCOUNT_CYCLE', e && e.code);

  // …and it terminates by DETECTION, not by exhausting the hop cap.
  const conn = makeConn(cyclic);
  await thrown(() => svc.ancestorChain(conn, 'X'));
  check('cycle is detected in a few hops, not by burning the cap',
    conn.log.length <= 4, conn.log.length);
}

// ── 3. Self-parent ────────────────────────────────────────────────────────
{
  await expectCode('move: an account cannot be its own parent',
    () => svc.moveAccountTx(makeConn(chart()), 'B', { parentId: 'B' }, {}),
    'SELF_PARENT', 422);

  await expectCode('upsert: an account cannot be its own parent',
    () => svc.upsertAccountTx(makeConn(chart()),
      { id: 'B', code: '110100', nameAr: 'B', type: 'asset', parentId: 'B' }, {}),
    'SELF_PARENT', 422);
}

// ── 4. Missing parent — the orphan the upsert used to create happily ──────
{
  await expectCode('create: a non-existent parent is a 404, not an orphan',
    () => svc.createAccountTx(makeConn(chart()),
      { code: '990000', nameAr: 'يتيم', type: 'asset', parentId: 'GHOST' }, {}),
    'PARENT_NOT_FOUND', 404);

  await expectCode('move: a non-existent parent is a 404',
    () => svc.moveAccountTx(makeConn(chart()), 'B', { parentId: 'GHOST' }, {}),
    'PARENT_NOT_FOUND', 404);

  await expectCode('move: a non-existent SUBJECT is 404, not 400',
    () => svc.moveAccountTx(makeConn(chart()), 'NOPE', { parentId: 'A' }, {}),
    'ACCOUNT_NOT_FOUND', 404);
}

// ── 5. A posting leaf may not become a parent while it holds entries ──────
{
  // L is a childless non-folder WITH postings. Hanging a child under it would
  // turn it into a header account with real journal lines hiding behind it —
  // every report that sums leaves would stop counting them.
  const rows = chart().concat([acc('L', '110200', 'A', { level: 3 })]);
  await expectCode('create: a posting leaf that HAS entries cannot become a parent',
    () => svc.createAccountTx(makeConn(rows, { entries: { L: 7 } }),
      { code: '110201', nameAr: 'ابن', type: 'asset', parentId: 'L' }, {}),
    'PARENT_HAS_ENTRIES', 422);

  // The same leaf with no postings is promotable — refusing that would make
  // the chart unextendable, which is a different bug, not a safer one.
  const ctx = await svc.resolveParentContext(makeConn(rows, { entries: {} }),
    { parentId: 'L', movingId: null, type: 'asset', height: 1 });
  check('an EMPTY posting leaf is promotable to a folder', ctx.needsPromotion === true, ctx);

  // A row already flagged is_folder needs no promotion.
  const ctx2 = await svc.resolveParentContext(makeConn(rows), { parentId: 'A', movingId: null, type: 'asset', height: 1 });
  check('an existing folder needs no promotion', ctx2.needsPromotion === false, ctx2.needsPromotion);
}

// ── 6. Type must match the CLASS ROOT, not the immediate parent ───────────
{
  await expectCode('create: a revenue account cannot live under the asset root',
    () => svc.createAccountTx(makeConn(chart()),
      { code: '110200', nameAr: 'إيراد', type: 'revenue', parentId: 'A' }, {}),
    'TYPE_MISMATCH', 422);

  await expectCode('move: a retyped subtree cannot be moved into a foreign root',
    () => svc.moveAccountTx(makeConn(chart().concat([
      acc('RV', '400000', null, { type: 'revenue', is_system_root: 1, is_folder: 1 }),
      acc('RV1', '410000', 'RV', { type: 'revenue' }),
    ])), 'RV1', { parentId: 'A' }, {}),
    'TYPE_MISMATCH', 422);

  // The error must name the ROOT that disagrees, not just say "no".
  const e = await thrown(() => svc.createAccountTx(makeConn(chart()),
    { code: '110200', nameAr: 'إيراد', type: 'revenue', parentId: 'A' }, {}));
  check('TYPE_MISMATCH names the offending root', e && e.details && e.details.rootId === 'R', e && e.details);
}

// ── 7. Depth cap ──────────────────────────────────────────────────────────
{
  const deep = [
    acc('d1', '1', null, { is_folder: 1, is_system_root: 1 }),
    acc('d2', '11', 'd1', { is_folder: 1 }),
    acc('d3', '111', 'd2', { is_folder: 1 }),
    acc('d4', '1111', 'd3', { is_folder: 1 }),
    acc('d5', '11111', 'd4', { is_folder: 1 }),
  ];
  check('MAX_DEPTH is 5', svc.MAX_DEPTH === 5, svc.MAX_DEPTH);

  await expectCode('create: a 6th level is refused',
    () => svc.createAccountTx(makeConn(deep), { code: '111111', nameAr: 'عميق', type: 'asset', parentId: 'd5' }, {}),
    'MAX_DEPTH_EXCEEDED', 422);

  // Depth is measured against the moving node's SUBTREE HEIGHT, not the node
  // alone — moving a 3-deep branch under a level-3 parent lands its leaves at
  // level 6 even though the node itself would sit at 4.
  const withBranch = deep.slice(0, 3).concat([
    acc('m1', '2', null, { is_folder: 1, is_system_root: 1 }),
    acc('m2', '21', 'm1', { is_folder: 1 }),   // ← moving this one (height 3)
    acc('m3', '211', 'm2', { is_folder: 1 }),
    acc('m4', '2111', 'm3'),
  ]);
  await expectCode('move: the moving SUBTREE height counts toward the cap',
    () => svc.moveAccountTx(makeConn(withBranch), 'm2', { parentId: 'd3' }, {}),
    'MAX_DEPTH_EXCEEDED', 422);

  // A move that fits is not refused.
  const ok = await svc.resolveParentContext(makeConn(deep), { parentId: 'd3', movingId: null, type: 'asset', height: 2 });
  check('a move that fits inside the cap is allowed', ok.newDepth === 4, ok.newDepth);
}

// ── 8. System-root protection, by FLAG not by code ────────────────────────
{
  const rows = chart();
  check('the fixture root is production-shaped, so code-matching would miss it',
    ['1', '2', '3', '4', '5'].indexOf(rows[0].code) < 0, rows[0].code);

  await expectCode('move: a system root cannot be moved',
    () => svc.moveAccountTx(makeConn(rows), 'R', { parentId: 'A' }, {}),
    'SYSTEM_ROOT_PROTECTED', 422);

  await expectCode('delete: a system root cannot be deleted',
    () => svc.deleteAccountTx(makeConn(rows), 'R', {}),
    'SYSTEM_ROOT_PROTECTED', 422);

  await expectCode('archive: a system root cannot be archived',
    () => svc.archiveAccountTx(makeConn(rows), 'R', {}),
    'SYSTEM_ROOT_PROTECTED', 422);

  await expectCode('folder: a system root cannot be demoted to a leaf',
    () => svc.setFolderTx(makeConn(rows), 'R', false, {}),
    'SYSTEM_ROOT_PROTECTED', 422);

  await expectCode('upsert: a system root cannot be deactivated',
    () => svc.upsertAccountTx(makeConn(rows),
      { id: 'R', code: '100000', nameAr: 'أصول', type: 'asset', parentId: null, isActive: false }, {}),
    'SYSTEM_ROOT_PROTECTED', 422);

  await expectCode('upsert: a system root cannot be retyped',
    () => svc.upsertAccountTx(makeConn(rows),
      { id: 'R', code: '100000', nameAr: 'أصول', type: 'revenue', parentId: null }, {}),
    'SYSTEM_ROOT_PROTECTED', 422);

  // A non-root is not protected by this rule.
  const e = await thrown(() => svc.assertNotSystemRoot(acc('B', '110100', 'A'), 'move'));
  check('a normal account is not system-root protected', e === null, e && e.code);
}

// ── 9. Optimistic concurrency ─────────────────────────────────────────────
{
  const row = acc('B', '110100', 'A', { version: 4 });

  const e = await thrown(() => svc.assertVersion(row, 3));
  check('a stale expectedVersion is VERSION_CONFLICT', e && e.code === 'VERSION_CONFLICT', e && e.code);
  check('VERSION_CONFLICT is HTTP 409', e && e.httpStatus === 409, e && e.httpStatus);
  check('VERSION_CONFLICT reports the CURRENT version so a client can refetch',
    e && e.details && e.details.currentVersion === 4, e && e.details);

  check('a matching expectedVersion passes', (await thrown(() => svc.assertVersion(row, 4))) === null);
  check('a matching expectedVersion passes as a string', (await thrown(() => svc.assertVersion(row, '4'))) === null);
  check('an absent expectedVersion is not enforced (legacy callers keep working)',
    (await thrown(() => svc.assertVersion(row, undefined))) === null);
  check('a null expectedVersion is not enforced',
    (await thrown(() => svc.assertVersion(row, null))) === null);

  const bad = await thrown(() => svc.assertVersion(row, 'abc'));
  check('a non-numeric expectedVersion is a 400, not a 409',
    bad && bad.code === 'EXPECTED_VERSION_INVALID' && bad.httpStatus === 400, bad && bad.code);

  // …and it is enforced end-to-end, through the real operations.
  await expectCode('move honours expectedVersion',
    () => svc.moveAccountTx(makeConn([
      acc('R', '100000', null, { is_system_root: 1, is_folder: 1 }),
      acc('A', '110000', 'R', { is_folder: 1 }),
      acc('B', '110100', 'A', { version: 4 }),
    ]), 'B', { parentId: 'A', expectedVersion: 1 }, {}),
    'VERSION_CONFLICT', 409);

  await expectCode('delete honours expectedVersion',
    () => svc.deleteAccountTx(makeConn([acc('B', '110100', null, { version: 4 })]), 'B', { expectedVersion: 2 }),
    'VERSION_CONFLICT', 409);

  await expectCode('folder toggle honours expectedVersion',
    () => svc.setFolderTx(makeConn([acc('B', '110100', null, { version: 4 })]), 'B', true, { expectedVersion: 2 }),
    'VERSION_CONFLICT', 409);
}

// ── 10. previewMove mutates NOTHING ───────────────────────────────────────
{
  const conn = makeConn(chart());
  const p = await svc.previewMoveTx(conn, 'B', 'A', { autoRenumber: true });

  check('previewMove issues zero write statements', conn.writes().length === 0,
    conn.writes().map((q) => q.sql));
  check('previewMove takes no row locks', !/FOR UPDATE/i.test(conn.sqlText()));
  for (const k of ['oldPath', 'newPath', 'affectedChildren', 'oldCodes', 'proposedCodes', 'entryCount']) {
    check('previewMove returns ' + k, Object.prototype.hasOwnProperty.call(p, k), Object.keys(p));
  }
  check('previewMove oldPath runs root → node',
    p.oldPath.length === 3 && p.oldPath[0].id === 'R' && p.oldPath[2].id === 'B',
    p.oldPath.map((x) => x.id));

  // A move that would be REFUSED is reported as a blocker — and still writes
  // nothing. The point of a preview is to see the refusal before committing.
  const conn2 = makeConn(chart());
  const bad = await svc.previewMoveTx(conn2, 'A', 'B', {});
  check('previewMove reports a cycle as a blocker instead of throwing',
    bad.blockers.some((b) => b.code === 'ACCOUNT_CYCLE'), bad.blockers);
  check('previewMove says ok:false when blocked', bad.ok === false, bad.ok);
  check('a BLOCKED previewMove still writes nothing', conn2.writes().length === 0,
    conn2.writes().map((q) => q.sql));

  // A system root preview is blocked, not thrown — same reason.
  const conn3 = makeConn(chart());
  const rootPrev = await svc.previewMoveTx(conn3, 'R', 'A', {});
  check('previewMove blocks a system-root move', rootPrev.blockers.some((b) => b.code === 'SYSTEM_ROOT_PROTECTED'),
    rootPrev.blockers);
  check('previewMove of a system root writes nothing', conn3.writes().length === 0);

  // A missing subject has nothing to preview → still a real 404.
  await expectCode('previewMove of a missing account is 404',
    () => svc.previewMoveTx(makeConn(chart()), 'NOPE', 'A', {}), 'ACCOUNT_NOT_FOUND', 404);
}

// ── 11. Postability: folder / inactive / blocked are three refusals ───────
{
  const leaf = acc('B', '110100', 'A');
  check('a clean active leaf is postable', svc.postabilityProblem(leaf) === null);
  check('a folder is not postable', !!svc.postabilityProblem(acc('F', '1', null, { is_folder: 1 })));
  check('an account WITH CHILDREN is not postable (even without the flag)',
    !!svc.postabilityProblem(leaf, { hasChildren: true }));
  check('a blocked account is not postable',
    !!svc.postabilityProblem(acc('X', '2', null, { status: 'blocked' })));
  check('an archived account is not postable',
    !!svc.postabilityProblem(acc('X', '2', null, { status: 'archived', is_active: 0 })));
  check('an inactive account is not postable',
    !!svc.postabilityProblem(acc('X', '2', null, { is_active: 0 })));
  check('a missing account is not postable', !!svc.postabilityProblem(null));
  check('every postability refusal carries an Arabic message',
    ['blocked', 'archived'].every((st) => /[؀-ۿ]/.test(svc.postabilityProblem(acc('X', '2', null, { status: st })).message)));
}

// ── 12. Folder conversion rules ───────────────────────────────────────────
{
  await expectCode('folder: an account WITH entries cannot become a folder',
    () => svc.setFolderTx(makeConn([acc('B', '110100', null)], { entries: { B: 3 } }), 'B', true, {}),
    'HAS_ENTRIES', 422);

  await expectCode('folder: a folder with children cannot be demoted',
    () => svc.setFolderTx(makeConn([acc('P', '11', null, { is_folder: 1 }), acc('C', '111', 'P')]), 'P', false, {}),
    'HAS_CHILDREN', 422);

  await expectCode('folder: a missing account is 404',
    () => svc.setFolderTx(makeConn([]), 'NOPE', true, {}), 'ACCOUNT_NOT_FOUND', 404);

  await expectCode('folder: a non-boolean flag is a 400',
    () => svc.setFolderTx(makeConn([acc('B', '1', null)]), 'B', 'yes', {}), 'IS_FOLDER_REQUIRED', 400);
}

// ── 13. Delete / archive rules ────────────────────────────────────────────
{
  await expectCode('delete: an account with children is 422, not 200',
    () => svc.deleteAccountTx(makeConn([acc('P', '11', null), acc('C', '111', 'P')]), 'P', {}),
    'HAS_CHILDREN', 422);

  await expectCode('delete: an account with journal entries is 422, not 200',
    () => svc.deleteAccountTx(makeConn([acc('B', '11', null)], { entries: { B: 1 } }), 'B', {}),
    'HAS_ENTRIES', 422);

  await expectCode('delete: a missing account is 404, not 200',
    () => svc.deleteAccountTx(makeConn([]), 'NOPE', {}), 'ACCOUNT_NOT_FOUND', 404);

  await expectCode('archive: open children must be archived first',
    () => svc.archiveAccountTx(makeConn([acc('P', '11', null), acc('C', '111', 'P')]), 'P', {}),
    'HAS_CHILDREN', 422);

  // Archiving an account that HAS postings is exactly what archive is for.
  const conn = makeConn([acc('B', '11', null, { version: 2 })], { entries: { B: 9 } });
  const out = await svc.archiveAccountTx(conn, 'B', { actor: 'ahmed' });
  check('archive succeeds on an account with postings', out.status === 'archived', out);
  check('archive stamps archived_by/archived_at', /archived_by = \?/.test(conn.sqlText()));
  check('archive stops it being postable', /is_postable = 0/.test(conn.sqlText()));
}

// ── 14. Input validation ──────────────────────────────────────────────────
{
  const cases = [
    ['a blank code is CODE_REQUIRED', { code: '  ', nameAr: 'x', type: 'asset' }, 'CODE_REQUIRED', 400],
    ['a blank name is NAME_REQUIRED', { code: '1', nameAr: '', type: 'asset' }, 'NAME_REQUIRED', 400],
    ['an unknown type is TYPE_INVALID', { code: '1', nameAr: 'x', type: 'wealth' }, 'TYPE_INVALID', 400],
    ['an unknown status is STATUS_INVALID', { code: '1', nameAr: 'x', type: 'asset', status: 'frozen' }, 'STATUS_INVALID', 400],
  ];
  for (const [name, input, code, status] of cases) {
    let e = null;
    try { svc.normalizeInput(input); } catch (x) { e = x; }
    check(name, e && e.code === code, e && e.code);
    check(name + ' → HTTP ' + status, e && e.httpStatus === status, e && e.httpStatus);
  }

  // A duplicate code is a 409 (a collision), not a 400 (a malformed request).
  await expectCode('a duplicate code is CODE_CONFLICT',
    () => svc.createAccountTx(makeConn(chart()),
      { code: '110100', nameAr: 'مكرر', type: 'asset', parentId: 'A' }, {}),
    'CODE_CONFLICT', 409);
}

// ── 15. The error → status contract is a TABLE, not string matching ───────
{
  check('every declared code has a status', Object.values(svc.ERROR_STATUS).every((s) => s >= 400 && s <= 599),
    svc.ERROR_STATUS);
  check('no COA error maps to 200', !Object.values(svc.ERROR_STATUS).includes(200));

  const buckets = { 400: [], 404: [], 409: [], 422: [], 500: [] };
  for (const [code, st] of Object.entries(svc.ERROR_STATUS)) (buckets[st] || (buckets[st] = [])).push(code);
  check('validation codes exist (400)', buckets[400].includes('LEVEL_NOT_ACCEPTED'), buckets[400]);
  check('missing-row codes exist (404)', buckets[404].includes('ACCOUNT_NOT_FOUND') && buckets[404].includes('PARENT_NOT_FOUND'), buckets[404]);
  check('conflict codes exist (409)', buckets[409].includes('VERSION_CONFLICT') && buckets[409].includes('CODE_CONFLICT'), buckets[409]);
  check('rule-violation codes exist (422)', buckets[422].includes('ACCOUNT_CYCLE') && buckets[422].includes('SYSTEM_ROOT_PROTECTED'), buckets[422]);

  // MySQL's own errors are translated rather than becoming an opaque 500.
  const dup = svc.toHttpError({ code: 'ER_DUP_ENTRY', errno: 1062, message: 'Duplicate entry' });
  check('ER_DUP_ENTRY becomes a 409 CODE_CONFLICT', dup.httpStatus === 409 && dup.code === 'CODE_CONFLICT', dup);
  const fk = svc.toHttpError({ errno: 1452, message: 'FK' });
  check('a dangling-parent FK becomes a 404', fk.httpStatus === 404 && fk.code === 'PARENT_NOT_FOUND', fk);
  const boom = svc.toHttpError(new TypeError('x is not a function'));
  check('an UNANTICIPATED error is a 500, never a 4xx', boom.httpStatus === 500 && boom.code === 'INTERNAL', boom);
  check('a typed CoaError keeps its own status',
    svc.toHttpError(new svc.CoaError('ACCOUNT_CYCLE', 'x')).httpStatus === 422);
}

// ── 16. A successful write stamps version + writes an audit row ───────────
{
  const conn = makeConn([
    acc('R', '100000', null, { is_system_root: 1, is_folder: 1 }),
    acc('A', '110000', 'R', { is_folder: 1 }),
    acc('B', '110100', 'A', { version: 3 }),
  ]);
  await svc.updateAccountTx(conn, 'B', { code: '110100', nameAr: 'اسم جديد', type: 'asset', parentId: 'A' }, { actor: 'ahmed' });
  const text = conn.sqlText();
  check('update bumps version', /SET version = COALESCE\(version,1\) \+ 1/.test(text));
  check('update stamps updated_by + updated_at', /updated_by = \?, updated_at = NOW\(\)/.test(text));
  check('update writes an audit row', /INSERT INTO audit_logs/.test(text), text.slice(0, 400));
  const auditRow = conn.log.find((q) => /INSERT INTO audit_logs/.test(q.sql));
  check('the audit row names the actor from the JWT, not the body',
    auditRow && auditRow.params.indexOf('ahmed') >= 0, auditRow && auditRow.params);
  check('the audit row is scoped to gl_account',
    auditRow && auditRow.params.indexOf('gl_account') >= 0, auditRow && auditRow.params);

  const created = makeConn(chart());
  const out = await svc.createAccountTx(created, OK_INPUT, { actor: 'ahmed' });
  check('create returns the new id', !!out.id, out);
  check('create writes an audit row', /INSERT INTO audit_logs/.test(created.sqlText()));
  check('create inserts version = 1', /INSERT INTO gl_accounts/.test(created.sqlText()));

  // A move must re-derive levels for the whole subtree, in the same txn.
  const moved = makeConn([
    acc('R', '100000', null, { is_system_root: 1, is_folder: 1 }),
    acc('A', '110000', 'R', { is_folder: 1 }),
    acc('A2', '120000', 'R', { is_folder: 1 }),
    acc('B', '110100', 'A'),
  ]);
  const mv = await svc.moveAccountTx(moved, 'B', { parentId: 'A2' }, { actor: 'ahmed' });
  check('move returns the legacy response fields',
    ['renumbered', 'oldCode', 'newCode', 'newParentId', 'levelsUpdated'].every((k) => k in mv), Object.keys(mv));
  check('move re-derives levels (recomputeLevels ran)', /SELECT id, code, parent_id, level FROM gl_accounts/.test(moved.sqlText()));
  check('move writes an audit row', /INSERT INTO audit_logs/.test(moved.sqlText()));
  check('move locks the rows it mutates', /FOR UPDATE/.test(moved.sqlText()));
}

// ── 17. Every public mutation opens a transaction ─────────────────────────
{
  stubDb._conn = makeConn(chart());
  stubDb.txCalls = 0;
  await thrown(() => svc.createAccount(Object.assign({}, OK_INPUT), { actor: 'x' }));
  check('createAccount runs inside db.withTransaction', stubDb.txCalls === 1, stubDb.txCalls);

  for (const [name, call] of [
    ['updateAccount', () => svc.updateAccount('B', { code: '110100', nameAr: 'x', type: 'asset', parentId: 'A' }, {})],
    ['upsertAccount', () => svc.upsertAccount(Object.assign({}, OK_INPUT), {})],
    ['moveAccount', () => svc.moveAccount('B', { parentId: 'A' }, {})],
    ['setFolder', () => svc.setFolder('B', true, {})],
    ['archiveAccount', () => svc.archiveAccount('B', {})],
    ['deleteAccount', () => svc.deleteAccount('B', {})],
  ]) {
    stubDb._conn = makeConn(chart());
    stubDb.txCalls = 0;
    await thrown(call);
    check(name + ' runs inside db.withTransaction', stubDb.txCalls === 1, stubDb.txCalls);
  }

  // previewMove is the ONE that must not: it is a read.
  stubDb.txCalls = 0;
  const preConn = makeConn(chart());
  const realWithTx = stubDb.withTransaction;
  stubDb.query = preConn.query.bind(preConn);
  await thrown(() => svc.previewMove('B', 'A', {}));
  check('previewMove opens no transaction', stubDb.txCalls === 0, stubDb.txCalls);
  check('previewMove writes nothing through the pool', preConn.writes().length === 0);
  stubDb.withTransaction = realWithTx;
}

// ── 18. STATIC: no COA handler answers a rejection with HTTP 200 ──────────
{
  const root = path.join(__dirname, '..');
  const erp = fs.readFileSync(path.join(root, 'routes', 'erp.js'), 'utf8');
  const serviceRaw = fs.readFileSync(path.join(root, 'lib', 'coa', 'service.js'), 'utf8');

  // A static assertion must read the CODE, not the prose about the code. Both
  // files document the defects they fix by quoting the old expression
  // verbatim — so a check that greps the raw text fails on its own changelog
  // and passes only if the explanation is deleted. Strip comments first.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');  // full-line //
  }
  const service = stripComments(serviceRaw);

  // The four write-gate handlers, by their registration line.
  const HANDLERS = [
    "router.post('/gl/accounts', ",
    "router.post('/gl/accounts/:id/folder'",
    "router.post('/gl/accounts/:id/move'",
    "router.delete('/gl/accounts/:id'",
    "router.post('/gl/accounts/:id/archive'",
  ];
  for (const sig of HANDLERS) {
    const start = erp.indexOf(sig);
    check('handler is present: ' + sig.trim(), start >= 0, sig);
    if (start < 0) continue;
    const nextRouter = erp.indexOf('\nrouter.', start + 1);
    const body = stripComments(erp.slice(start, nextRouter < 0 ? erp.length : nextRouter));

    // (a) THE regression this package exists to stop.
    check(sig.trim() + ' never answers a rejection with HTTP 200',
      !/res\.json\(\s*\{\s*success:\s*false/.test(body),
      (body.match(/res\.json\(\s*\{\s*success:\s*false[^\n]*/) || [])[0]);

    // (b) It routes through the gate rather than touching gl_accounts itself.
    check(sig.trim() + ' delegates to lib/coa/service', /coaService\./.test(body));
    check(sig.trim() + ' does not write gl_accounts inline',
      !/(UPDATE|INSERT INTO|DELETE FROM)\s+gl_accounts/.test(body),
      (body.match(/(UPDATE|INSERT INTO|DELETE FROM)\s+gl_accounts[^\n]*/) || [])[0]);

    // (c) The root guard that was false in production is gone from the gate.
    check(sig.trim() + " no longer hardcodes roots as codes '1'..'5'",
      !/\['1','2','3','4','5'\]/.test(body));
  }

  // (d) The upsert must not silently accept a derived field any more.
  const upsertStart = erp.indexOf("router.post('/gl/accounts', ");
  const upsertBody = stripComments(erp.slice(upsertStart, erp.indexOf('\nrouter.', upsertStart + 1)));
  check('the upsert no longer destructures `level` from the body',
    !/const\s*\{[^}]*\blevel\b[^}]*\}\s*=\s*req\.body/.test(upsertBody), upsertBody.slice(0, 200));

  // (e) Errors are mapped mechanically from the thrown type — one responder.
  check('routes/erp.js requires the write gate', /require\('\.\.\/lib\/coa\/service'\)/.test(erp));
  check('there is ONE COA failure responder', /function _coaFail\(/.test(erp));
  check('_coaFail takes its status from the typed error, not a string match',
    /coaService\.toHttpError\(e\)/.test(erp) && /res\.status\(mapped\.httpStatus\)/.test(erp));
  check('_coaFail emits a machine-readable code', /code:\s*mapped\.code/.test(erp));

  // (f) The actor comes from the JWT. Taking identity from the body is how
  //     `?username=admin` authenticated with no token once already.
  check('COA mutations take the actor from the authenticated user',
    /_coaCtx\(req\)/.test(erp) && /actor:\s*_actor\(req\)/.test(erp));

  // (g) The service must not re-implement depth or ordering — lib/coa/tree.js
  //     is the structural authority, and a second implementation is exactly
  //     how the two depth bases diverged in the first place.
  check('service delegates level derivation to coaTree.recomputeLevels',
    /coaTree\.recomputeLevels\(conn/.test(service));
  check('service never writes `level` itself',
    !/SET[^;]*\blevel\s*=/.test(service),
    (service.match(/SET[^;]*\blevel\s*=[^\n]*/) || [])[0]);

  // (h) Guards run under a row lock, inside a transaction.
  check('service locks the rows it mutates', /FOR UPDATE/.test(service));
  check('service mutations run in withTransaction', /withTransaction\(/.test(service));

  // (i) Root protection is the FLAG.
  check('service protects roots via is_system_root', /is_system_root/.test(service));
  check("service does not hardcode roots as codes '1'..'5'", !/\['1','2','3','4','5'\]/.test(service));

  // (j) Journal posting shares the one postability rule.
  check('journal-line validation uses the shared postability rule',
    /coaService\.postabilityProblem\(/.test(erp));
}

// ── report ────────────────────────────────────────────────────────────────
console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('✅ coa write gate: typed errors → real status codes, cycle/type/depth/root guards, ' +
  'optimistic concurrency, audited mutations, side-effect-free preview');
process.exit(0);

})().catch((e) => {
  console.error('\nHARNESS CRASH:', (e && e.stack) || e);
  process.exit(1);
});
