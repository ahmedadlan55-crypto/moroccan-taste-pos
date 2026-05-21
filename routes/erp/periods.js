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
const db = require('../../db/connection');

function _monthBounds(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  const pad = (n) => n < 10 ? '0' + n : '' + n;
  return {
    start: year + '-' + pad(month) + '-01',
    end: year + '-' + pad(month) + '-' + pad(end.getDate())
  };
}

router.get('/periods', async (req, res) => {
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

router.get('/periods/check', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) return res.json({ success: false, error: 'date is required' });
    const status = await _statusAt(db, date, req.query.brandId, req.query.branchId);
    res.json({ success: true, date, status, isOpen: status === 'open' || status === 'soft_close' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

async function _statusAt(conn, date, brandId, branchId) {
  const [rows] = await conn.query(
    `SELECT status FROM accounting_periods
     WHERE start_date <= ? AND end_date >= ?
       AND (brand_id IS NULL OR brand_id = ? OR ? = '')
       AND (branch_id IS NULL OR branch_id = ? OR ? = '')
     ORDER BY status DESC LIMIT 1`,
    [date, date, brandId || '', brandId || '', branchId || '', branchId || '']
  );
  return rows.length ? rows[0].status : 'open';
}

router.post('/periods', async (req, res) => {
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

    // Transition check
    const [cur] = await db.query('SELECT status FROM accounting_periods WHERE id = ?', [id]);
    if (!cur.length) return res.json({ success: false, error: 'period not found' });
    if (fromStates && fromStates.length && fromStates.indexOf(cur[0].status) < 0) {
      return res.json({ success: false, error: 'illegal transition from ' + cur[0].status });
    }
    await db.query(
      `UPDATE accounting_periods SET status = ?, closed_by = ?, closed_at = NOW(), closing_notes = ? WHERE id = ?`,
      [target, username, notes, id]
    );
    res.json({ success: true, id, status: target });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
}

router.post('/periods/:label/close',       (req, res) => _transitionStatus(req, res, 'closed', ['open', 'soft_close']));
router.post('/periods/:label/soft-close',  (req, res) => _transitionStatus(req, res, 'soft_close', ['open']));
router.post('/periods/:label/lock',        (req, res) => _transitionStatus(req, res, 'locked', ['closed']));
router.post('/periods/:label/reopen',      (req, res) => _transitionStatus(req, res, 'open',   ['closed', 'soft_close']));

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
  const d = (date instanceof Date)
    ? (date.toISOString().slice(0, 10))
    : String(date).slice(0, 10);
  const status = await _statusAt(c, d, brandId, branchId);
  if (status === 'closed' || status === 'locked') {
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
