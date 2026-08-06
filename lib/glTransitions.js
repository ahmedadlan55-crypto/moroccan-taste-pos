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
const acctDate = require('./accountingDate');
const glPosting = require('./glPosting');
const { hasCapability } = require('../middleware/requireCapability');
const { logAudit, logAuditTx } = require('./auditLogger');

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

/**
 * draft -> approved. Caller must already hold finance.gl.approve
 * (route-level). Tier A.2 Section 3 — the audit write for a SUCCESSFUL
 * transition happens INSIDE this same transaction via logAuditTx(), which
 * (unlike logAudit()) does not swallow a write failure: if the audit_logs
 * insert fails, the whole transaction rolls back, so the journal's status
 * never changes without a corresponding, durable audit record. A DENIAL
 * (nothing changed) still logs best-effort, outside the transaction — see
 * _writeDenialAudit below.
 */
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
    await logAuditTx(conn, 'approve_journal', 'gl_journal', journalId, actor, {}, opts.ip);
    return { ok: true, audit: 'approve_journal' };
  });
  await _writeDenialAudit(out, journalId, actor, opts.ip);
  return out;
}

/**
 * approved -> posted. Caller must already hold finance.gl.post
 * (route-level). See approve() above for why the success audit write is
 * INSIDE the transaction (logAuditTx) while denials are best-effort.
 */
async function post(journalId, user, opts) {
  opts = opts || {};
  const actor = actorOf(user);
  const out = await db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM gl_journals WHERE id = ? FOR UPDATE', [journalId]);
    if (!rows.length) return { ok: false, code: 'not_found', message: 'القيد غير موجود', status: 404 };
    const jrn = rows[0];
    // Tier A.3 Release Gate — post() never checked this at all: the
    // creator could not self-APPROVE (checkSelfApproval() in approve()
    // above), but once a DIFFERENT user approved their journal, the
    // creator was free to POST it themselves — maker/checker only held for
    // half the workflow. The rule is the creator may neither approve NOR
    // post their own journal, via Single or Bulk, full stop.
    const sod = checkSelfApproval(jrn, user);
    if (!sod.ok) return { ok: false, code: 'sod-self-post-denied', message: 'لا يمكنك ترحيل قيد أنشأته بنفسك — يلزم مستخدم آخر (فصل المهام).', status: 403, denied: true, deniedAudit: 'post_journal_denied_sod', journalStatus: jrn.status };
    if (jrn.status === 'posted') return { ok: false, code: 'already-posted', message: 'القيد مُرحَّل بالفعل', status: 409 };
    if (jrn.status !== 'approved') return { ok: false, code: 'not-approved', message: 'يجب اعتماد القيد أولاً قبل الترحيل', status: 409 };
    const period = await checkPeriodOpen(conn, jrn.journal_date, { force: !!opts.force, user });
    if (!period.ok) return { ok: false, code: period.code, message: period.message, status: 409, denied: true, deniedAudit: 'post_journal_denied_period_lock', journalStatus: jrn.status };
    await applyBalances(conn, journalId);
    await conn.query('UPDATE gl_journals SET status = "posted", posted_by = ?, posted_at = ? WHERE id = ?', [actor, new Date(), journalId]);
    await logAuditTx(conn, 'post_journal', 'gl_journal', journalId, actor, {}, opts.ip);
    return { ok: true, audit: 'post_journal' };
  });
  await _writeDenialAudit(out, journalId, actor, opts.ip);
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
    await logAuditTx(conn, 'approve_post_journal', 'gl_journal', journalId, actor, {}, opts.ip);
    return { ok: true, audit: 'approve_post_journal' };
  });
  await _writeDenialAudit(out, journalId, actor, opts.ip);
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
    await logAuditTx(conn, 'delete_journal', 'gl_journal', journalId, actor, {}, opts.ip);
    return { ok: true, audit: 'delete_journal' };
  });
  await _writeDenialAudit(out, journalId, actor, opts.ip);
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
    const runOnConnection = async (conn) => {
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
        // The PARTY must survive the reversal. Without these two lines a
        // reversal credits the payable control account with no counterparty,
        // so the supplier's statement shows the invoice and never the credit —
        // the balance stays owed forever while the ledger says it is settled.
        // Every other dimension is copied here for the same reason; the party
        // is simply the one whose absence is invisible until a supplier calls.
        partyType: e.party_type || null,
        partyId: e.party_id || null,
      }));
      // Tier A.3 Release Gate item 9 — new Date().toISOString() is UTC. On a
      // server whose OS clock is UTC (the common case for cloud deploys —
      // this repo's own dev sandbox happens to run with a Riyadh system
      // clock, which is exactly why this bug stayed invisible locally), a
      // reversal posted between 00:00-02:59 Asia/Riyadh (21:00-23:59 UTC the
      // PREVIOUS day) would date itself one calendar day too early. MySQL's
      // session is already pinned to Asia/Riyadh (db/connection.js, SET
      // time_zone='+03:00' on every connection) — asking IT for today's date
      // via DATE_FORMAT (a plain string, not a Date object mysql2 would
      // hand back and risk re-serializing through JS/UTC again) sidesteps
      // the JS timezone question entirely instead of reimplementing +03:00
      // arithmetic by hand.
      const [[{ riyadhToday }]] = await conn.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS riyadhToday");
      // opts.journalDate lets a caller date the reversal inside the ORIGINAL's
      // period rather than today. Reversing a month-end batch on the 3rd of the
      // following month would otherwise move the correction into a period the
      // original never touched — and be refused outright once that month is
      // closed, leaving a wrong journal standing with no way to undo it.
      // Default is unchanged: today, in Riyadh, asked of MySQL.
      const revDate = opts.journalDate
        ? acctDate.toAccountingDate(opts.journalDate)
        : riyadhToday;
      const posted = await glPosting.postJournal(conn, {
        journalDate: revDate,
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
      // Tier A.3 Release Gate item 9 — this try/catch used to swallow ANY
      // failure here, not just "old deploy missing the columns" as the
      // comment claimed. The new reversal journal is ALREADY posted by this
      // point (postJournal() above) — if this link-back UPDATE then fails
      // for a genuine reason (deadlock, transient DB error, ...), the
      // ORIGINAL journal's reversed_by_journal_id stays NULL, so the
      // double-reversal guard at the top of this function (`if
      // (j.reversed_by_journal_id)`) would never trip: the same journal
      // could be reversed a second time, silently duplicating the GL entry.
      // No catch — a real failure here must roll back the WHOLE transaction
      // (including the reversal journal just posted), not leave a posted
      // reversal with no record of what it reversed.
      await conn.query('UPDATE gl_journals SET reversed_by_journal_id = ?, reversed_at = NOW(), reversed_by = ? WHERE id = ?', [posted.journalId, actor, j.id]);
      await conn.query('UPDATE gl_journals SET reverses_journal_id = ? WHERE id = ?', [j.id, posted.journalId]);
      // Tier A.2 Section 3 — inside the same transaction (logAuditTx, not
      // logAudit): a failure here rolls back the whole reversal, including
      // the new mirrored journal postJournal() just created above.
      await logAuditTx(conn, 'reverse_journal', 'gl_journal', journalId, actor, { newJournalId: posted.journalId }, opts.ip);
      return {
        originalJournalId: j.id,
        originalJournalNumber: j.journal_number,
        newJournalId: posted.journalId,
        newJournalNumber: posted.journalNumber,
        reason,
      };
    };
    // Most callers keep the historical self-contained transaction. Composite
    // workflows (sales-batch reversal) may supply their already-open
    // connection so the journal reversal and their own state changes commit
    // or roll back as one unit, without a nested transaction.
    const result = opts.conn
      ? await runOnConnection(opts.conn)
      : await db.withTransaction(runOnConnection);
    return { ok: true, audit: 'reverse_journal', ...result };
  } catch (e) {
    return { ok: false, code: e.code || 'reverse_failed', message: e.message, status: e.status || 500 };
  }
}

/**
 * Best-effort denial logging — a denial never changed the journal's state,
 * so losing this specific audit row on a transient failure is a bounded
 * gap, not a correctness bug (unlike the success path, which uses
 * logAuditTx INSIDE the transaction — see approve()/post()/etc. above).
 */
async function _writeDenialAudit(out, journalId, actor, ip) {
  if (!out.ok && out.denied && out.deniedAudit) {
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
