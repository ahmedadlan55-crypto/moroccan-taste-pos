'use strict';
/**
 * Unified GL journal transition service — Tier A.2 corrective gate, Section 2.
 *
 * Before this file, routes/erp.js had FIVE independent implementations of
 * journal state transitions (single POST /:id/approve, single POST /:id/post,
 * single POST /:id/reverse, single DELETE /:id, and POST /bulk), each with
 * its own copy of similar-but-diverging logic. Concretely, before this fix:
 *
 *   - Maker/checker (self-approval) was enforced ONLY on the bulk path.
 *     React's actual UI flow (usePostJournal() in frontend/erp/src/modules/
 *     accounting/api.ts) calls the SINGLE-id /approve route first, which had
 *     NO self-approval check at all — a single user with finance.gl.approve
 *     could create and approve their own journal end to end through the one
 *     path the product UI actually drives. tests/integration/
 *     glSecurity.api.test.js documented this as PASSING (a manager
 *     self-approving their own journal via the sequential single-id routes),
 *     which is exactly the gap this file closes.
 *   - Period-lock enforcement existed in TWO different, non-shared forms: a
 *     local _checkPeriodOpen in routes/erp.js (recognized only 'closed'/
 *     'soft_closed', force honored for ANY finance.gl.post holder with no
 *     distinct capability) vs lib/glPosting.js#isPeriodClosed (recognizes
 *     all 4 closed-ish states via PERIOD_CLOSED_STATUSES, but has no force/
 *     override concept at all) — and bulk POST /gl/journals/bulk's
 *     post/approve_post actions skipped period-lock checking ENTIRELY.
 *   - Bulk approve_post required only finance.gl.post, not also
 *     finance.gl.approve, even though it performs BOTH the approve and the
 *     post state transition.
 *
 * Every transition below — called identically from a single-id route or a
 * bulk loop — returns the same result shape:
 *   { ok: true, audit: '<action_name>' }
 *   { ok: false, code, message, status, denied?: true, journalStatus? }
 * A route handler's job is reduced to: authenticate, load req.user, call the
 * matching export once per journal id, and translate the result into an
 * HTTP response (or, for bulk, into that id's entry in the results array).
 * No route hand-rolls transition SQL anymore.
 */

const db = require('../db/connection');
const glPosting = require('./glPosting');
const { hasCapability } = require('../middleware/requireCapability');
const { logAudit } = require('./auditLogger');

// lib/glPosting.js#PERIOD_CLOSED_STATUSES is the canonical 4-state list
// ('closed','locked','soft_close','soft_closed'). Only the two "soft"
// spellings are ever overridable with force; 'closed'/'locked' never are.
const SOFT_CLOSED_STATUSES = new Set(['soft_close', 'soft_closed']);

function isAdminOrDeveloper(user) {
  const role = String((user && user.role) || '').toLowerCase();
  return role === 'admin' || !!(user && (user.isDeveloper === true || user.isDeveloper === 1));
}

function actorOf(user) {
  return (user && (user.username || user.name)) || '';
}

function journalDeleteDenialCode(status) {
  if (status === 'draft') return null;
  if (status === 'approved') return 'approved_journal_requires_governed_action';
  return 'posted_journal_immutable'; // posted, or any other/unexpected status — fail closed
}

/**
 * Single source of truth for "is this journal's date inside a period that
 * blocks posting, and can `force` get past it?" — reuses glPosting.js's
 * canonical PERIOD_CLOSED_STATUSES (so the closed/open decision can never
 * drift from lib/glPosting.js#isPeriodClosed again) and adds the override
 * decision that neither prior implementation gated correctly: `force` only
 * clears a SOFT-closed period, and only for Admin/Developer or an explicit
 * `finance.periods.override_lock` capability — never for a plain
 * finance.gl.post holder, which is what every caller of post()/approvePost()
 * already is by definition.
 * @param {object} conn - a connection participating in the caller's transaction
 * @param {string} journalDate
 * @param {{force?: boolean, user?: object}} opts
 */
async function checkPeriodOpen(conn, journalDate, opts) {
  opts = opts || {};
  if (!journalDate) return { ok: true };
  // NOTE — this deliberately selects period_label, NOT period_name. server.js
  // has two independent CREATE TABLE accounting_periods definitions (a
  // pre-existing schema-drift bug, the same class already flagged for
  // Section 6/audit_logs) — whichever one actually executes first on a given
  // deployment "wins", and only period_label is guaranteed present on both:
  // the real dev DB carries period_name only because of years of accumulated
  // history, but a freshly-provisioned database (the isolated test DB this
  // gate insists on, or any brand-new deployment) does NOT have it, and a
  // query naming period_name in its SELECT list fails outright with
  // "Unknown column" — not silently, but hard, since MySQL validates the
  // column list at parse time regardless of whether any row would match.
  // period_label is the one column both definitions agree exists.
  const [p] = await conn.query(
    `SELECT id, period_label, status FROM accounting_periods WHERE ? BETWEEN start_date AND end_date LIMIT 1`,
    [journalDate]
  );
  if (!p.length) return { ok: true }; // no period defined for that date — nothing to lock
  const period = p[0];
  const status = String(period.status || '').toLowerCase();
  if (!glPosting.PERIOD_CLOSED_STATUSES.includes(status)) return { ok: true, period };

  if (SOFT_CLOSED_STATUSES.has(status) && opts.force) {
    const canOverride = isAdminOrDeveloper(opts.user) || (opts.user ? await hasCapability(opts.user, 'finance.periods.override_lock') : false);
    if (canOverride) return { ok: true, period, forced: true };
    return {
      ok: false,
      period,
      code: 'period_force_requires_override_capability',
      message: 'تجاوز إقفال الفترة (force) يتطلب دور Admin/Developer أو صلاحية finance.periods.override_lock — صلاحية الترحيل (finance.gl.post) وحدها لا تكفي.',
    };
  }
  return {
    ok: false,
    period,
    code: SOFT_CLOSED_STATUSES.has(status) ? 'period_locked_soft' : 'period_locked_hard',
    message: SOFT_CLOSED_STATUSES.has(status)
      ? `الفترة «${period.period_label}» مُقفلة (إقفال مبدئي). تواصل مع المحاسب الرئيسي للسماح بالترحيل، أو استخدم force إن كانت لديك الصلاحية.`
      : `لا يمكن الترحيل: الفترة «${period.period_label}» مُقفلة نهائياً.`,
  };
}

/**
 * Maker/checker: the person who CREATED a journal may not be the one who
 * approves/approve_posts it. admin/developer are exempt — the same
 * break-glass bypass the rest of the RBAC layer already uses.
 */
function checkSelfApproval(journal, user) {
  const actor = actorOf(user);
  if (!journal.created_by || journal.created_by !== actor) return { ok: true };
  if (isAdminOrDeveloper(user)) return { ok: true };
  return {
    ok: false,
    code: 'sod-self-approval-denied',
    message: 'لا يمكنك اعتماد قيد أنشأته بنفسك — يلزم مستخدم آخر (فصل المهام).',
  };
}

async function applyBalances(conn, journalId) {
  const [entries] = await conn.query(
    'SELECT account_id, debit, credit FROM gl_entries WHERE journal_id = ? AND account_id IS NOT NULL ORDER BY account_id',
    [journalId]
  );
  for (const e of entries) {
    const net = (Number(e.debit) || 0) - (Number(e.credit) || 0);
    await conn.query('UPDATE gl_accounts SET balance = balance + ? WHERE id = ?', [net, e.account_id]);
  }
}

/** draft -> approved. Caller must already hold finance.gl.approve (route-level). */
async function approve(journalId, user, opts) {
  opts = opts || {};
  const actor = actorOf(user);
  const out = await db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM gl_journals WHERE id = ? FOR UPDATE', [journalId]);
    if (!rows.length) return { ok: false, code: 'not_found', message: 'القيد غير موجود', status: 404 };
    const jrn = rows[0];
    const sod = checkSelfApproval(jrn, user);
    if (!sod.ok) return { ok: false, code: sod.code, message: sod.message, status: 403, denied: true, deniedAudit: 'approve_journal_denied_sod', journalStatus: jrn.status };
    if (jrn.status !== 'draft') return { ok: false, code: 'not_draft', message: 'فقط القيود المسودة يمكن اعتمادها', status: 409 };
    await conn.query('UPDATE gl_journals SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?', [actor, new Date(), journalId]);
    return { ok: true, audit: 'approve_journal' };
  });
  await _writeAudit(out, journalId, actor, opts.ip);
  return out;
}

/** approved -> posted. Caller must already hold finance.gl.post (route-level). */
async function post(journalId, user, opts) {
  opts = opts || {};
  const actor = actorOf(user);
  const out = await db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM gl_journals WHERE id = ? FOR UPDATE', [journalId]);
    if (!rows.length) return { ok: false, code: 'not_found', message: 'القيد غير موجود', status: 404 };
    const jrn = rows[0];
    if (jrn.status === 'posted') return { ok: false, code: 'already-posted', message: 'القيد مُرحَّل بالفعل', status: 409 };
    if (jrn.status !== 'approved') return { ok: false, code: 'not-approved', message: 'يجب اعتماد القيد أولاً قبل الترحيل', status: 409 };
    const period = await checkPeriodOpen(conn, jrn.journal_date, { force: !!opts.force, user });
    if (!period.ok) return { ok: false, code: period.code, message: period.message, status: 409, denied: true, deniedAudit: 'post_journal_denied_period_lock', journalStatus: jrn.status };
    await applyBalances(conn, journalId);
    await conn.query('UPDATE gl_journals SET status = "posted", posted_by = ?, posted_at = ? WHERE id = ?', [actor, new Date(), journalId]);
    return { ok: true, audit: 'post_journal' };
  });
  await _writeAudit(out, journalId, actor, opts.ip);
  return out;
}

/**
 * draft -> approved -> posted in one step (what bulk's approve_post offers).
 * Requires BOTH finance.gl.approve AND finance.gl.post (Tier A.2 fix — bulk
 * previously required only finance.gl.post for this combined action, even
 * though it performs the approve transition too). Blocks self-approval and
 * enforces the period lock exactly like post() does — bulk previously
 * skipped period-lock checking entirely for this action.
 */
async function approvePost(journalId, user, opts) {
  opts = opts || {};
  const actor = actorOf(user);
  const [canApprove, canPost] = await Promise.all([
    hasCapability(user, 'finance.gl.approve'),
    hasCapability(user, 'finance.gl.post'),
  ]);
  if (!canApprove || !canPost) {
    return { ok: false, code: 'PERMISSION_DENIED', message: 'صلاحية غير كافية — يلزم finance.gl.approve وfinance.gl.post معًا', status: 403 };
  }
  const out = await db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM gl_journals WHERE id = ? FOR UPDATE', [journalId]);
    if (!rows.length) return { ok: false, code: 'not_found', message: 'القيد غير موجود', status: 404 };
    const jrn = rows[0];
    const sod = checkSelfApproval(jrn, user);
    if (!sod.ok) return { ok: false, code: sod.code, message: sod.message, status: 403, denied: true, deniedAudit: 'approve_journal_denied_sod', journalStatus: jrn.status };
    if (jrn.status !== 'draft') return { ok: false, code: 'not_draft', message: 'فقط القيود المسودة يمكن اعتمادها وترحيلها', status: 409 };
    const period = await checkPeriodOpen(conn, jrn.journal_date, { force: !!opts.force, user });
    if (!period.ok) return { ok: false, code: period.code, message: period.message, status: 409, denied: true, deniedAudit: 'post_journal_denied_period_lock', journalStatus: jrn.status };
    await conn.query('UPDATE gl_journals SET status = "approved", approved_by = ?, approved_at = ? WHERE id = ?', [actor, new Date(), journalId]);
    await applyBalances(conn, journalId);
    await conn.query('UPDATE gl_journals SET status = "posted", posted_by = ?, posted_at = ? WHERE id = ?', [actor, new Date(), journalId]);
    return { ok: true, audit: 'approve_post_journal' };
  });
  await _writeAudit(out, journalId, actor, opts.ip);
  return out;
}

/**
 * Draft-only hard delete. Authorization (developer/admin only) is a
 * route-level concern (guardDeveloper on the single-id route; the
 * equivalent inline check on bulk) — this function does not re-check it,
 * matching the pre-existing design where DELETE's gate lives at the route.
 */
async function deleteJournal(journalId, user, opts) {
  opts = opts || {};
  const actor = actorOf(user);
  const DENIAL_MESSAGES = {
    posted_journal_immutable: 'القيد مُرحَّل — لا يمكن حذفه. أنشئ قيد عكس (Reversal) بدلاً من ذلك.',
    approved_journal_requires_governed_action: 'القيد معتمَد — لا يُحذف مباشرة. استخدم إجراء إلغاء الاعتماد (Return-to-draft) الموثَّق بدلاً من الحذف.',
  };
  const out = await db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT id, status FROM gl_journals WHERE id = ? FOR UPDATE', [journalId]);
    if (!rows.length) return { ok: false, code: 'not_found', message: 'القيد غير موجود', status: 404 };
    const denyCode = journalDeleteDenialCode(rows[0].status);
    if (denyCode) {
      return { ok: false, code: denyCode, message: DENIAL_MESSAGES[denyCode], status: 409, denied: true, deniedAudit: 'delete_journal_denied', journalStatus: rows[0].status };
    }
    // Only a draft reaches here — a draft never affected gl_accounts.balance,
    // so there is nothing to reverse; reversing here would have been wrong.
    await conn.query('DELETE FROM gl_entries WHERE journal_id = ?', [journalId]);
    await conn.query('DELETE FROM gl_journals WHERE id = ?', [journalId]);
    return { ok: true, audit: 'delete_journal' };
  });
  await _writeAudit(out, journalId, actor, opts.ip);
  return out;
}

/**
 * Reverses a posted journal by creating a new, mirrored (debit↔credit
 * swapped) journal via lib/glPosting.js#postJournal — the one transition
 * that already routed through the shared posting helper before this file
 * existed, so its period-lock behavior (isPeriodClosed, no override) was
 * already correct; centralized here for a single call surface, not because
 * its internals needed to change.
 */
async function reverse(journalId, user, opts) {
  opts = opts || {};
  const actor = actorOf(user) || 'system';
  const reason = String(opts.reason || 'correction').slice(0, 200);
  try {
    const result = await db.withTransaction(async (conn) => {
      const [orig] = await conn.query('SELECT * FROM gl_journals WHERE id = ? FOR UPDATE', [journalId]);
      if (!orig.length) { const err = new Error('original-not-found'); err.code = 'not_found'; err.status = 404; throw err; }
      const j = orig[0];
      if (j.status !== 'posted') { const err = new Error('only-posted-journals-can-be-reversed'); err.code = 'only_posted_can_be_reversed'; err.status = 400; throw err; }
      if (j.reversed_by_journal_id) { const err = new Error('already-reversed'); err.code = 'already_reversed'; err.status = 400; throw err; }
      const [entries] = await conn.query('SELECT * FROM gl_entries WHERE journal_id = ? ORDER BY id', [j.id]);
      if (!entries.length) { const err = new Error('original-has-no-entries'); err.code = 'no_entries'; err.status = 400; throw err; }
      const reversedEntries = entries.map((e) => ({
        accountCode: e.account_code,
        debit: Number(e.credit) || 0,
        credit: Number(e.debit) || 0,
        description: 'REVERSAL of ' + (j.journal_number || j.id) + (reason ? ' — ' + reason : ''),
        brandId: e.brand_id || null,
        branchId: e.branch_id || null,
        projectId: e.project_id || null,
        costCenterId: e.cost_center_id || null,
        warehouseId: e.warehouse_id || null,
      }));
      const posted = await glPosting.postJournal(conn, {
        journalDate: new Date().toISOString().slice(0, 10),
        description: 'REVERSAL of ' + (j.journal_number || j.id) + ' — ' + reason,
        referenceType: 'reversal',
        referenceId: j.id,
        entries: reversedEntries,
        postedBy: actor,
      });
      if (!posted || !posted.success) {
        const err = new Error('reversal-post-failed: ' + ((posted && posted.error) || 'unknown'));
        err.code = 'reversal_post_failed'; err.status = 500; throw err;
      }
      try {
        await conn.query('UPDATE gl_journals SET reversed_by_journal_id = ?, reversed_at = NOW(), reversed_by = ? WHERE id = ?', [posted.journalId, actor, j.id]);
        await conn.query('UPDATE gl_journals SET reverses_journal_id = ? WHERE id = ?', [j.id, posted.journalId]);
      } catch (_) { /* schema may not have the columns on a very old deploy — non-fatal */ }
      return {
        originalJournalId: j.id,
        originalJournalNumber: j.journal_number,
        newJournalId: posted.journalId,
        newJournalNumber: posted.journalNumber,
        reason,
      };
    });
    await logAudit('reverse_journal', 'gl_journal', journalId, actor, {}, opts.ip || '');
    return { ok: true, audit: 'reverse_journal', ...result };
  } catch (e) {
    return { ok: false, code: e.code || 'reverse_failed', message: e.message, status: e.status || 500 };
  }
}

async function _writeAudit(out, journalId, actor, ip) {
  if (out.ok) {
    await logAudit(out.audit, 'gl_journal', journalId, actor, {}, ip || '');
  } else if (out.denied && out.deniedAudit) {
    await logAudit(out.deniedAudit, 'gl_journal', journalId, actor, { status: out.journalStatus, code: out.code }, ip || '');
  }
}

module.exports = {
  approve,
  post,
  approvePost,
  deleteJournal,
  reverse,
  checkPeriodOpen,
  checkSelfApproval,
  journalDeleteDenialCode,
  isAdminOrDeveloper,
};
