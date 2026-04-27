/**
 * V4 — SLA enforcement + escalation
 * Background worker (run via setInterval at process startup) checks for
 * overdue transactions and:
 *   1. Marks them as overdue (computed via due_date column)
 *   2. Creates escalation notifications to the assignee + their manager
 *   3. Bumps escalation_count to track repeated overdue
 *
 * Also exposes manual trigger + SLA stats endpoints.
 */
const router = require('express').Router();
const db = require('../db/connection');

// GET /sla/overdue?username=X — list overdue items in user's inbox
router.get('/overdue', async (req, res) => {
  try {
    const username = req.query.username;
    let sql = `
      SELECT t.id, t.transaction_number, t.subject, t.title, t.status, t.amount,
             t.importance, t.created_by, t.current_assignee, t.due_date,
             t.created_at, t.escalation_count,
             TIMESTAMPDIFF(HOUR, t.due_date, NOW()) AS hours_overdue,
             tt.name AS type_name
        FROM transactions t
        LEFT JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.due_date IS NOT NULL
         AND t.due_date < NOW()
         AND t.status IN ('pending','created','in_progress','replied')
    `;
    const params = [];
    if (username) { sql += ' AND t.current_assignee = ?'; params.push(username); }
    sql += ' ORDER BY t.due_date ASC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id,
      txnNumber: r.transaction_number,
      subject: r.subject || r.title,
      status: r.status,
      amount: Number(r.amount) || 0,
      importance: r.importance,
      typeName: r.type_name,
      createdBy: r.created_by,
      currentAssignee: r.current_assignee,
      dueDate: r.due_date,
      hoursOverdue: Number(r.hours_overdue) || 0,
      escalationCount: Number(r.escalation_count) || 0
    })));
  } catch(e) { res.json([]); }
});

// GET /sla/stats — system-wide SLA health
router.get('/stats', async (req, res) => {
  try {
    const [counts] = await db.query(`
      SELECT
        COUNT(*) AS total_open,
        SUM(CASE WHEN due_date IS NOT NULL AND due_date < NOW() THEN 1 ELSE 0 END) AS overdue_count,
        SUM(CASE WHEN due_date IS NOT NULL AND due_date >= NOW()
                 AND due_date < DATE_ADD(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS due_24h,
        AVG(CASE WHEN status = 'closed' THEN TIMESTAMPDIFF(HOUR, created_at, updated_at) END) AS avg_close_hours
      FROM transactions
      WHERE status IN ('pending','created','in_progress','replied')
    `);
    const [byPriority] = await db.query(`
      SELECT importance, COUNT(*) AS c
      FROM transactions
      WHERE status IN ('pending','created','in_progress','replied')
        AND due_date < NOW()
      GROUP BY importance
    `);
    res.json({
      totalOpen:     Number((counts[0]||{}).total_open) || 0,
      overdueCount:  Number((counts[0]||{}).overdue_count) || 0,
      due24h:        Number((counts[0]||{}).due_24h) || 0,
      avgCloseHours: Number((counts[0]||{}).avg_close_hours) || 0,
      overdueByPriority: byPriority.reduce((acc, r) => { acc[r.importance] = Number(r.c); return acc; }, {})
    });
  } catch(e) { res.json({ error: e.message }); }
});

// POST /sla/escalate-now — admin-triggered manual escalation sweep
router.post('/escalate-now', async (req, res) => {
  try {
    const username = req.body.username || (req.user && req.user.username);
    if (username !== 'admin') return res.status(403).json({ error: 'admin only' });
    const result = await runEscalationSweep();
    res.json(result);
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Background sweep (called by server.js on interval) ──────────────────
async function runEscalationSweep() {
  const stats = { checked: 0, escalated: 0, errors: 0 };
  try {
    const [overdue] = await db.query(`
      SELECT id, transaction_number, subject, title, current_assignee, created_by, importance,
             escalation_count, escalated_at, TIMESTAMPDIFF(HOUR, due_date, NOW()) AS hours_overdue
        FROM transactions
       WHERE due_date IS NOT NULL AND due_date < NOW()
         AND status IN ('pending','created','in_progress','replied')
         AND (escalated_at IS NULL OR escalated_at < DATE_SUB(NOW(), INTERVAL 12 HOUR))
       LIMIT 100
    `);
    stats.checked = overdue.length;
    for (const t of overdue) {
      try {
        // Notify the assignee
        if (t.current_assignee) {
          await db.query(
            `INSERT INTO notifications (id, username, type, title, body, link_type, link_id, severity)
             VALUES (?, ?, 'sla_escalation', ?, ?, 'transaction', ?, 'warning')`,
            ['NOT-SLA-' + Date.now() + '-' + Math.random().toString(36).slice(2,4),
             t.current_assignee,
             `معاملة متأخرة: ${t.transaction_number || t.id}`,
             `${t.subject || t.title || ''} — متأخرة بـ ${Math.round(t.hours_overdue)} ساعة`,
             t.id]);
        }
        // After 3 escalations, also notify the creator
        if (Number(t.escalation_count || 0) >= 2 && t.created_by) {
          await db.query(
            `INSERT INTO notifications (id, username, type, title, body, link_type, link_id, severity)
             VALUES (?, ?, 'sla_creator_alert', ?, ?, 'transaction', ?, 'danger')`,
            ['NOT-SLA-CR-' + Date.now() + '-' + Math.random().toString(36).slice(2,4),
             t.created_by,
             `معاملتك متأخرة: ${t.transaction_number || t.id}`,
             `لم يتم التصرف فيها منذ ${Math.round(t.hours_overdue)} ساعة`,
             t.id]);
        }
        // Bump escalation_count
        await db.query(
          'UPDATE transactions SET escalated_at = NOW(), escalation_count = escalation_count + 1 WHERE id = ?',
          [t.id]);
        stats.escalated++;
      } catch(e) {
        stats.errors++;
        console.warn('[sla escalate] err for', t.id, ':', e.message);
      }
    }
  } catch(e) {
    console.error('[sla sweep] error:', e.message);
  }
  return stats;
}

// Start the background sweep on require (every 30 minutes)
let _sweepHandle = null;
function startBackgroundSweep(intervalMs) {
  if (_sweepHandle) clearInterval(_sweepHandle);
  intervalMs = intervalMs || 30 * 60 * 1000;
  _sweepHandle = setInterval(() => {
    runEscalationSweep().catch(e => console.error('[sla bg]', e.message));
  }, intervalMs);
  // Don't keep node alive just for this
  if (_sweepHandle.unref) _sweepHandle.unref();
  console.log('[sla] Background escalation sweep started, interval =', intervalMs / 60000, 'minutes');
}

router._startBackgroundSweep = startBackgroundSweep;
router._runEscalationSweep = runEscalationSweep;

module.exports = router;
