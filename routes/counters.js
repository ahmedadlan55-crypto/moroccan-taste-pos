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
    // g-wf SECURITY: identity from the verified JWT only. /api/counters passes
    // through the global JWT gate in server.js, so req.user is always set for
    // authenticated callers — ?username= let anyone read someone else's badge
    // counts (inbox/outbox/notification volumes).
    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });

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
    // g-wf: was a 200 with an error body — clients treated it as data.
    console.error('[counters] GET /me failed:', e && e.message);
    res.status(500).json({ error: 'خطأ في الخادم أثناء حساب العدّادات' });
  }
});

// POST /counters/recompute — rebuilds the materialized table from scratch
// Used by admin to fix any drift.
// V5-SEC: check user.role === 'admin' instead of username === 'admin'.
// Previously, a user literally named 'admin' (without admin role) could trigger this.
router.post('/recompute', async (req, res) => {
  try {
    // g-wf SECURITY: role from the verified JWT only. The old "paths bypassing
    // JWT" branch accepted body.username and looked its role up in the DB —
    // i.e. sending username=admin (any admin's name) triggered a rebuild with
    // no token at all. /api/counters is behind the global JWT gate; there is
    // no legitimate unauthenticated path here.
    const role = (req.user && req.user.role) || '';
    const isDev = !!(req.user && req.user.isDeveloper);
    const isAdmin = (role === 'admin' || isDev);
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
    // g-wf: was a 200 with success:false — a failed rebuild looked like a quirk.
    console.error('[counters] POST /recompute failed:', e && e.message);
    res.status(500).json({ success: false, error: 'خطأ في الخادم أثناء إعادة بناء العدّادات' });
  }
});

// GET /counters/notifications?username=X&limit=20&unreadOnly=1
// V5-SEC: redact body for top_secret/secret transactions when caller is not the
// creator/assignee/recipient (e.g., escalation managers shouldn't see the subject).
router.get('/notifications', async (req, res) => {
  try {
    // g-wf SECURITY: identity from the verified JWT only — ?username= let anyone
    // read another user's notification feed (titles + bodies).
    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const unreadOnly = req.query.unreadOnly === '1';
    const sql = unreadOnly
      ? `SELECT * FROM notifications WHERE username = ? AND is_read = 0 ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM notifications WHERE username = ? ORDER BY created_at DESC LIMIT ?`;
    const [rows] = await db.query(sql, [username, limit]);

    // V5-SEC: bulk-load secrecy info for any linked transactions and redact bodies.
    const txnIds = [...new Set(rows.filter(r => r.link_type === 'transaction').map(r => r.link_id).filter(Boolean))];
    let secrecyMap = {};
    let secrecyLoadFailed = false;
    if (txnIds.length) {
      try {
        const placeholders = txnIds.map(() => '?').join(',');
        const [tx] = await db.query(
          `SELECT id, content_secrecy, created_by, current_assignee, recipient_username FROM transactions WHERE id IN (${placeholders})`,
          txnIds);
        tx.forEach(t => { secrecyMap[t.id] = t; });
        // Recipients per txn
        const [recRows] = await db.query(
          `SELECT transaction_id, username FROM txn_recipients WHERE transaction_id IN (${placeholders})`,
          txnIds);
        recRows.forEach(rec => {
          if (!secrecyMap[rec.transaction_id]._recipients) secrecyMap[rec.transaction_id]._recipients = [];
          secrecyMap[rec.transaction_id]._recipients.push(rec.username);
        });
      } catch(e) {
        // g-wf: this empty catch was a redaction bypass — if the secrecy load
        // failed, secret/top_secret bodies went out UNREDACTED. Log it and
        // fail CLOSED below (redact every transaction-linked body).
        console.error('[counters] secrecy load failed — redacting all txn-linked bodies:', e && e.message);
        secrecyLoadFailed = true;
      }
    }

    res.json(rows.map(r => {
      let body = r.body;
      if (secrecyLoadFailed && r.link_type === 'transaction') {
        body = '[محتوى سري — انقر للاطلاع إن كانت لك صلاحية]';
      } else if (r.link_type === 'transaction' && secrecyMap[r.link_id]) {
        const t = secrecyMap[r.link_id];
        const sec = (t.content_secrecy || '').toLowerCase();
        const recs = t._recipients || [];
        const hasAccess = (
          t.created_by === username ||
          t.current_assignee === username ||
          t.recipient_username === username ||
          recs.includes(username)
        );
        if ((sec === 'top_secret' || sec === 'secret') && !hasAccess) {
          body = '[محتوى سري — انقر للاطلاع إن كانت لك صلاحية]';
        }
      }
      return {
      id: r.id,
      type: r.type,
      title: r.title,
      body: body,
      linkType: r.link_type,
      linkId: r.link_id,
      severity: r.severity,
      isRead: !!r.is_read,
      readAt: r.read_at,
      createdAt: r.created_at
    };}));
  } catch(e) {
    // g-wf: was `res.json([])` — a DB fault looked like "no notifications".
    console.error('[counters] GET /notifications failed:', e && e.message);
    res.status(500).json({ error: 'خطأ في الخادم أثناء تحميل الإشعارات' });
  }
});

// POST /counters/notifications/:id/read
router.post('/notifications/:id/read', async (req, res) => {
  try {
    // g-wf SECURITY: identity from the verified JWT only (body.username deleted).
    // The UPDATE is scoped to the token user's own row — no capability needed;
    // employees/cashiers must keep acknowledging their own notifications.
    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ success: false, error: 'غير مصرح — يرجى تسجيل الدخول' });
    await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND username = ?',
      [req.params.id, username]);
    res.json({ success: true });
  } catch(e) {
    console.error('[counters] POST /notifications/:id/read failed:', e && e.message);
    res.status(500).json({ success: false, error: 'خطأ في الخادم أثناء تحديث الإشعار' });
  }
});

// POST /counters/notifications/mark-all-read
router.post('/notifications/mark-all-read', async (req, res) => {
  try {
    // g-wf SECURITY: identity from the verified JWT only — body.username let a
    // caller mark ANOTHER user's notifications read (hiding alerts from them).
    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ success: false, error: 'غير مصرح — يرجى تسجيل الدخول' });
    await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE username = ? AND is_read = 0',
      [username]);
    res.json({ success: true });
  } catch(e) {
    console.error('[counters] POST /notifications/mark-all-read failed:', e && e.message);
    res.status(500).json({ success: false, error: 'خطأ في الخادم أثناء تحديث الإشعارات' });
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

// V5-FIX: exported helper for other routes to invalidate cached counters
// (call after txn create/update/delete/transition that touches a user).
async function invalidateCountersFor(...usernames) {
  if (!CACHE.isEnabled()) return;
  const unique = [...new Set(usernames.filter(Boolean))];
  for (const u of unique) {
    try { await CACHE.del('counters:' + u); } catch(_e) { /* swallow */ }
  }
}
router.invalidateCountersFor = invalidateCountersFor;
module.exports = router;
module.exports.invalidateCountersFor = invalidateCountersFor;
