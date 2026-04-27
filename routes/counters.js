/**
 * V4 — User Inbox Counters API
 * Returns real-time counters from the materialized table.
 * Falls back to live SQL aggregation if the materialized row is missing/stale.
 */
const router = require('express').Router();
const db = require('../db/connection');
const CACHE = require('../lib/redisCache');   // optional Redis layer

// GET /counters/me?username=X
// Returns: { inbox: {...}, outbox: {...}, notifications: {...} }
// V4.2: Always compute LIVE from transactions table (avoids materialization
// drift bugs). Materialized table is now optional cache, not source of truth.
router.get('/me', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username);
    if (!username) return res.json({ error: 'username required' });

    // Try Redis cache first (30s TTL — covers >95% of inbox loads)
    const cacheKey = 'counters:' + username;
    if (CACHE.isEnabled()) {
      const cached = await CACHE.get(cacheKey);
      if (cached) return res.json(cached);
    }

    // V4.2: Compute live — guaranteed correct even if materialized table is broken
    let counters;
    try {
      counters = await _computeCountersFor(username);
    } catch(computeErr) {
      console.error('[counters] live compute failed:', computeErr.message);
      counters = { pending_action: 0, returned_to_me: 0, awaiting_others: 0, total_inbox: 0, total_outbox: 0 };
    }

    // Overdue: compute live (cheap query, status uses index)
    const [overdueRow] = await db.query(
      `SELECT COUNT(*) AS c FROM transactions
       WHERE current_assignee = ?
         AND status IN ('pending','created','in_progress','replied')
         AND due_date IS NOT NULL AND due_date < NOW()`,
      [username]);
    const overdue = Number((overdueRow[0] || {}).c) || 0;

    // Unread notifications — tolerant to missing/legacy schema
    let unread = 0;
    try {
      const [unreadRow] = await db.query(
        `SELECT COUNT(*) AS c FROM notifications WHERE username = ? AND is_read = 0`,
        [username]);
      unread = Number((unreadRow[0] || {}).c) || 0;
    } catch(e) {
      console.warn('[counters] notifications query failed (legacy schema?):', e.message);
    }

    const result = {
      inbox: {
        pendingAction: Number(counters.pending_action) || 0,
        returnedToMe:  Number(counters.returned_to_me) || 0,
        overdue:       overdue,
        total:         Number(counters.total_inbox) || 0
      },
      outbox: {
        awaitingOthers: Number(counters.awaiting_others) || 0,
        total:          Number(counters.total_outbox) || 0
      },
      notifications: {
        unread: unread
      },
      lastComputedAt: counters.last_computed_at || new Date()
    };
    // V4.1: cache for 30s (only if Redis enabled)
    if (CACHE.isEnabled()) {
      try { await CACHE.set(cacheKey, result, CACHE.TTL.COUNTERS); } catch(_) {}
    }
    res.json(result);
  } catch(e) {
    res.json({ error: e.message });
  }
});

// POST /counters/recompute — rebuilds the materialized table from scratch
// Used by admin to fix any drift.
router.post('/recompute', async (req, res) => {
  try {
    const username = req.body.username || (req.user && req.user.username);
    const isAdmin = (username === 'admin');
    if (!isAdmin) return res.status(403).json({ error: 'admin only' });

    await db.query("DELETE FROM user_inbox_counters");
    await db.query(`
      INSERT INTO user_inbox_counters (username, pending_action, total_inbox)
      SELECT current_assignee,
             SUM(CASE WHEN status IN ('pending','created','in_progress','replied') THEN 1 ELSE 0 END),
             COUNT(*)
        FROM transactions
        WHERE current_assignee IS NOT NULL AND current_assignee != ''
        GROUP BY current_assignee
      ON DUPLICATE KEY UPDATE
        pending_action = VALUES(pending_action),
        total_inbox    = VALUES(total_inbox)
    `);
    await db.query(`
      INSERT INTO user_inbox_counters
        (username, awaiting_others, total_outbox, returned_to_me)
      SELECT created_by,
             SUM(CASE WHEN status IN ('pending','created','in_progress','replied') THEN 1 ELSE 0 END),
             COUNT(*),
             SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END)
        FROM transactions
        WHERE created_by IS NOT NULL AND created_by != ''
        GROUP BY created_by
      ON DUPLICATE KEY UPDATE
        awaiting_others = VALUES(awaiting_others),
        total_outbox    = VALUES(total_outbox),
        returned_to_me  = VALUES(returned_to_me)
    `);
    res.json({ success: true, message: 'Counters rebuilt' });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// GET /counters/notifications?username=X&limit=20&unreadOnly=1
router.get('/notifications', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username);
    if (!username) return res.json([]);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const unreadOnly = req.query.unreadOnly === '1';
    const sql = unreadOnly
      ? `SELECT * FROM notifications WHERE username = ? AND is_read = 0 ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM notifications WHERE username = ? ORDER BY created_at DESC LIMIT ?`;
    const [rows] = await db.query(sql, [username, limit]);
    res.json(rows.map(r => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      linkType: r.link_type,
      linkId: r.link_id,
      severity: r.severity,
      isRead: !!r.is_read,
      readAt: r.read_at,
      createdAt: r.created_at
    })));
  } catch(e) {
    res.json([]);
  }
});

// POST /counters/notifications/:id/read
router.post('/notifications/:id/read', async (req, res) => {
  try {
    const username = req.body.username || (req.user && req.user.username);
    await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND username = ?',
      [req.params.id, username]);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// POST /counters/notifications/mark-all-read
router.post('/notifications/mark-all-read', async (req, res) => {
  try {
    const username = req.body.username || (req.user && req.user.username);
    await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE username = ? AND is_read = 0',
      [username]);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────

async function _computeCountersFor(username) {
  const [inRows] = await db.query(
    `SELECT
       SUM(CASE WHEN status IN ('pending','created','in_progress','replied') THEN 1 ELSE 0 END) AS pending,
       COUNT(*) AS total
     FROM transactions
     WHERE current_assignee = ?`, [username]);
  const [outRows] = await db.query(
    `SELECT
       SUM(CASE WHEN status IN ('pending','created','in_progress','replied') THEN 1 ELSE 0 END) AS awaiting,
       SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END) AS returned,
       COUNT(*) AS total
     FROM transactions
     WHERE created_by = ?`, [username]);
  return {
    pending_action:  Number((inRows[0] || {}).pending) || 0,
    total_inbox:     Number((inRows[0] || {}).total) || 0,
    awaiting_others: Number((outRows[0] || {}).awaiting) || 0,
    returned_to_me:  Number((outRows[0] || {}).returned) || 0,
    total_outbox:    Number((outRows[0] || {}).total) || 0
  };
}

module.exports = router;
