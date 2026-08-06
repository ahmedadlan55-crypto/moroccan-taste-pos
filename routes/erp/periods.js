/**
 * routes/erp/periods.js — Accounting period close mechanics.
 *
 * Statuses:
 *   open        — no restrictions
 *   soft_close  — UI warns when posting; allowed
 *   closed      — POSTs blocked (sales, journals, purchases-receive)
 *   locked      — closed AND cannot be re-opened by anyone but a developer
 *
 * Endpoints:
 *   GET    /api/erp/periods?year=YYYY                  — list periods
 *   GET    /api/erp/periods/check?date=YYYY-MM-DD       — is the date open?
 *   POST   /api/erp/periods                              — create a period row
 *                                                          (idempotent — UPDATE if exists)
 *   POST   /api/erp/periods/:label/close                — open → closed (admin)
 *   POST   /api/erp/periods/:label/soft-close            — open → soft_close
 *   POST   /api/erp/periods/:label/lock                  — closed → locked
 *   POST   /api/erp/periods/:label/reopen                — closed → open (admin)
 *
 * Also exports a helper `assertPeriodOpen(conn, date, brandId, branchId)`
 * for other routes to call inside their transactions.
 *
 * v6.2.0 — Wave F.3
 */

const router = require('express').Router();
const acctDate = require('../../lib/accountingDate');
const glPosting = require('../../lib/glPosting');
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');

function _monthBounds(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  const pad = (n) => n < 10 ? '0' + n : '' + n;
  return {
    start: year + '-' + pad(month) + '-01',
    end: year + '-' + pad(month) + '-' + pad(end.getDate())
  };
}

// Shadowed by routes/erp.js:2450 (same path, mounted first, same capability).
router.get('/periods', requireCapability('finance.gl.view'), async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const [rows] = await db.query(
      `SELECT * FROM accounting_periods
       WHERE period_label LIKE ?
       ORDER BY period_label ASC`,
      [year + '-%']
    );
    // Always project 12 months for the UI grid (open if no row exists)
    const map = {};
    rows.forEach(r => { map[r.period_label] = r; });
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const pad = (n) => n < 10 ? '0' + n : '' + n;
      const label = year + '-' + pad(m);
      const row = map[label];
      const bounds = _monthBounds(year, m);
      months.push({
        label,
        startDate: bounds.start,
        endDate: bounds.end,
        status: row ? row.status : 'open',
        closedBy: row ? row.closed_by : null,
        closedAt: row ? row.closed_at : null,
        notes:    row ? row.closing_notes : null
      });
    }
    res.json({ success: true, year, months });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// No known caller (grep-verified across frontend/, public/, routes/, lib/) —
// routes/sales.js:55 requires assertPeriodOpen as a MODULE, never over HTTP.
router.get('/periods/check', requireCapability('finance.gl.view'), async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) return res.json({ success: false, error: 'date is required' });
    const status = await _statusAt(db, date, req.query.brandId, req.query.branchId);
    res.json({ success: true, date, status, isOpen: status === 'open' || status === 'soft_close' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

async function _statusAt(conn, date, brandId, branchId, opts = {}) {
  // v6.4.1 — defensive: an early deployment created accounting_periods
  // without brand_id/branch_id, then the v6.2.0 createTableIfMissing was
  // a no-op. The addColumnIfMissing in server.js backfills the columns,
  // but if for any reason the schema is still partial we fall back to
  // "open" — a missing/broken period table must NEVER block a sale.
  try {
    const [rows] = await conn.query(
      `SELECT status FROM accounting_periods
       WHERE start_date <= ? AND end_date >= ?
         AND (brand_id IS NULL OR brand_id = ? OR ? = '')
         AND (branch_id IS NULL OR branch_id = ? OR ? = '')
       ORDER BY status DESC LIMIT 1${opts.lock ? ' FOR SHARE' : ''}`,
      [date, date, brandId || '', brandId || '', branchId || '', branchId || '']
    );
    return rows.length ? rows[0].status : 'open';
  } catch (e) {
    if (opts.strict) throw e;
    // Schema mismatch or table missing — treat as no enforcement
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[periods._statusAt] degraded to open:', e.message);
    }
    return 'open';
  }
}

// Shadowed by routes/erp.js:2482 (same path, mounted first, same capability) —
// guarded here too so mount order is not the only thing standing between an
// arbitrary token and a new period row.
router.post('/periods', requireCapability('finance.periods.manage'), async (req, res) => {
  try {
    const { periodLabel, startDate, endDate, brandId, branchId } = req.body || {};
    if (!periodLabel || !startDate || !endDate) {
      return res.json({ success: false, error: 'periodLabel/startDate/endDate required' });
    }
    const id = 'PER-' + periodLabel + '-' + (brandId || 'ALL') + '-' + (branchId || 'ALL');
    await db.query(
      `INSERT INTO accounting_periods (id, period_label, start_date, end_date, brand_id, branch_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'open')
       ON DUPLICATE KEY UPDATE start_date = VALUES(start_date), end_date = VALUES(end_date)`,
      [id, periodLabel, startDate, endDate, brandId || null, branchId || null]
    );
    res.json({ success: true, id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

async function _transitionStatus(req, res, target, fromStates) {
  try {
    const label = req.params.label;
    const brandId  = req.body && req.body.brandId  || null;
    const branchId = req.body && req.body.branchId || null;
    const notes    = req.body && req.body.notes    || '';
    const username = (req.user && req.user.username) || (req.body && req.body.username) || 'system';

    // Ensure the period row exists (auto-create from label)
    const m = /^(\d{4})-(\d{2})$/.exec(label);
    if (!m) return res.json({ success: false, error: 'invalid period label, expected YYYY-MM' });
    const bounds = _monthBounds(Number(m[1]), Number(m[2]));
    const id = 'PER-' + label + '-' + (brandId || 'ALL') + '-' + (branchId || 'ALL');
    await db.query(
      `INSERT IGNORE INTO accounting_periods (id, period_label, start_date, end_date, brand_id, branch_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'open')`,
      [id, label, bounds.start, bounds.end, brandId, branchId]
    );

    const wantsForce = req.body && req.body.force === true;
    const reason = String((req.body && req.body.reason) || '').trim();
    const mayOverride = wantsForce
      ? await requireCapability.hasCapability(req.user, 'finance.periods.override_lock').catch(() => false)
      : false;
    const salesPosting = require('./sales-posting');

    await db.withTransaction(async (conn) => {
    // Transition check + period lock make queue stranding and state change one unit.
    const [cur] = await conn.query('SELECT status FROM accounting_periods WHERE id = ? FOR UPDATE', [id]);
    if (!cur.length) { const e = new Error('period not found'); e.status = 404; throw e; }
    if (fromStates && fromStates.length && fromStates.indexOf(cur[0].status) < 0) {
      const e = new Error('illegal transition from ' + cur[0].status); e.status = 409; throw e;
    }

    // ── «ترحيل المبيعات» guard ──────────────────────────────────────────
    // Sealing a period whose sales have not reached the ledger produces a
    // trial balance that looks finished and is wrong, and leaves the queue
    // rows with nowhere legal to go. Only on a real close — soft_close is a
    // review state, and reopen must never be blocked.
    if (target === 'closed' || target === 'locked') {
      try {
        await salesPosting.assertNoUnpostedSales(conn, {
          from: bounds.start, to: bounds.end, brandId, branchId });
      } catch (guardErr) {
        if (guardErr && guardErr.code === 'UNPOSTED_SALES_IN_PERIOD') {
          // Override needs force AND the capability AND a reason. What is left
          // behind becomes `stranded` rather than being deleted, so a forced
          // close never makes unposted revenue disappear quietly.
          if (!wantsForce || !mayOverride || reason.length < 10) {
            throw guardErr;
          }
          const stranded = await salesPosting.strandUnposted(conn,
            { from: bounds.start, to: bounds.end, brandId, branchId });
          console.warn('[periods] FORCED close of ' + id + ' by ' + username +
            ' — ' + stranded + ' sale(s) marked stranded · reason: ' + reason);
        } else { throw guardErr; }
      }
    }
    if (target === 'open') {
      await salesPosting.recoverStranded(conn,
        { from: bounds.start, to: bounds.end, brandId, branchId });
    }
    await conn.query(
      `UPDATE accounting_periods SET status = ?, closed_by = ?, closed_at = NOW(), closing_notes = ? WHERE id = ?`,
      [target, username, notes, id]
    );
    });
    res.json({ success: true, id, status: target });
  } catch (e) {
    if (e && e.code === 'UNPOSTED_SALES_IN_PERIOD') {
      return res.status(409).json({
        success: false, error: e.code, message: e.message,
        unpostedCount: e.unpostedCount, firstDay: e.firstDay, lastDay: e.lastDay,
        link: '/accounting/sales-posting?from=' + (e.firstDay || '') + '&to=' + (e.lastDay || ''),
        overrideRequires: 'force=true + finance.periods.override_lock + reason (10+ chars)',
      });
    }
    res.status(e && e.status || 500).json({ success: false, error: e.message });
  }
}

// ── Authorization ───────────────────────────────────────────────────────────
// These routes shipped with NO guard at all. Closing a period blocks every
// subsequent sale in it (lib/glPosting.js isPeriodClosed fails CLOSED), and
// re-opening one lets journals be posted into a period the books were already
// signed off on. `finance.periods.manage` is the capability routes/erp.js:2523
// already uses for the parallel lock endpoint, so this closes the bypass rather
// than inventing a second, divergent gate.
//
// MOUNT ORDER MATTERS — server.js mounts routes/erp.js (:772) BEFORE this file
// (:778), so `/periods` (GET+POST) and `/periods/:id/lock` are already served,
// and already guarded, by routes/erp.js:2450/2482/2523. Only `close`,
// `soft-close` and `reopen` are unique to this file — those were the live hole.
// The rest are guarded here anyway: a shadowed route is one mount-order edit
// away from being reachable, and an unguarded shadowed route is a trap.
//
// `posPortalScope` (middleware/posPortalScope.js) already blocked the CASHIER
// role specifically. It is a deny-list for POS_ONLY_ROLES, so every other
// non-admin role — waiter, inventory, purchasing, employee — still reached
// these. That is what this closes.

router.post('/periods/:label/close',       requireCapability('finance.periods.manage'), (req, res) => _transitionStatus(req, res, 'closed', ['open', 'soft_close']));
router.post('/periods/:label/soft-close',  requireCapability('finance.periods.manage'), (req, res) => _transitionStatus(req, res, 'soft_close', ['open']));
router.post('/periods/:label/lock',        requireCapability('finance.periods.manage'), (req, res) => _transitionStatus(req, res, 'locked', ['closed']));
router.post('/periods/:label/reopen',      requireCapability('finance.periods.manage'), (req, res) => _transitionStatus(req, res, 'open',   ['closed', 'soft_close']));

/**
 * Helper for other routes to enforce period locks inside their
 * transactions. Throws an err with status=403 and code='period_locked'
 * if the target date falls inside a closed/locked period.
 *
 * Usage from routes/sales.js etc:
 *   const periods = require('./erp/periods');
 *   await periods.assertPeriodOpen(conn, new Date(), brandId, branchId);
 */
async function assertPeriodOpen(conn, date, brandId, branchId) {
  const c = conn || db;
  // Riyadh calendar date, not UTC. `toISOString()` here checked a 00:00–02:59
  // sale against the PREVIOUS day's period — so a sale on the 1st was refused
  // whenever the prior month was closed, and slipped into a month that was
  // supposed to be finished whenever it was not. See lib/accountingDate.js.
  const d = acctDate.toAccountingDate(date);
  // Lock the matching period row for the duration of the caller's transaction.
  // A concurrent close takes FOR UPDATE on the same row, so either the sale
  // captures before the close or it sees the closed state — never between.
  const status = await _statusAt(c, d, brandId, branchId, { lock: true, strict: true });
  // Same list glPosting blocks on — imported, not restated.
  //
  // These two guards used to disagree: this one blocked only {closed, locked}
  // while lib/glPosting.js#isPeriodClosed also blocks {soft_close,
  // soft_closed}. So a sale into a soft-closed period passed THIS check, ran
  // the whole checkout, and then died inside postJournal with a generic
  // «GL_POSTING_FAILED» that rolled everything back — the cashier saw an
  // unexplained failure instead of «the period is closed».
  //
  // Aligning them cannot newly reject a sale that succeeds today: any sale
  // that posts a journal already fails in that period. It only moves the
  // refusal to the front, where it can say why.
  //
  // The FAIL DIRECTIONS stay deliberately opposite: _statusAt degrades to
  // 'open' so a broken period table can never stop the register, while
  // isPeriodClosed returns true so it can never let money into a closed book.
  // Availability for the till, integrity for the ledger.
  if (glPosting.PERIOD_CLOSED_STATUSES.includes(String(status || '').toLowerCase())) {
    const err = new Error('Accounting period for ' + d + ' is ' + status + ' — re-open or post to a later date');
    err.code = 'period_locked';
    err.status = 403;
    err.periodDate = d;
    err.periodStatus = status;
    throw err;
  }
}

router.assertPeriodOpen = assertPeriodOpen;
module.exports = router;
module.exports.assertPeriodOpen = assertPeriodOpen;
