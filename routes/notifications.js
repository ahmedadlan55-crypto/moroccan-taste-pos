/**
 * Notifications — Phase D foundation
 * User-level event feed.
 */
const router = require('express').Router();
const db = require('../db/connection');
// g-wf SECURITY — capability guard for the arbitrary-recipient create endpoint.
const requireCapability = require('../middleware/requireCapability');

// List (current user)
router.get('/notifications', async (req, res) => {
  try {
    // g-wf SECURITY: identity from the verified JWT only — the ?username=
    // fallback let any authenticated user read another user's feed.
    var username = (req.user && req.user.username) || '';
    if (!username) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
    var onlyUnread = req.query.unread === '1';
    var limit = Math.min(Number(req.query.limit) || 50, 200);
    let sql = 'SELECT * FROM notifications WHERE user_username = ?';
    const params = [username];
    if (onlyUnread) sql += ' AND is_read = 0';
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Unread count
router.get('/notifications/unread-count', async (req, res) => {
  try {
    // g-wf SECURITY: identity from the verified JWT only (?username= deleted).
    var username = (req.user && req.user.username) || '';
    if (!username) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
    const [rows] = await db.query(
      'SELECT COUNT(*) AS c FROM notifications WHERE user_username = ? AND is_read = 0',
      [username]);
    res.json({ count: rows[0].c || 0 });
  } catch(e) {
    // g-wf: was a silent `{ count: 0 }` — a DB fault looked like "nothing unread".
    console.error('[notifications] GET /notifications/unread-count failed:', e && e.message);
    res.status(500).json({ error: 'خطأ في الخادم أثناء حساب الإشعارات غير المقروءة' });
  }
});

// Mark one as read
router.post('/notifications/:id/read', async (req, res) => {
  try {
    // g-wf SECURITY: scope the write to the token user's OWN row — previously
    // any authenticated caller could mark ANY user's notification read by id.
    // Self-scoped write: no capability needed (employees/cashiers keep their flow).
    var username = (req.user && req.user.username) || '';
    if (!username) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
    await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND user_username = ?',
      [req.params.id, username]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mark all as read
router.post('/notifications/read-all', async (req, res) => {
  try {
    // g-wf SECURITY: identity from the verified JWT only — body.username let a
    // caller silence ANOTHER user's alerts.
    var username = (req.user && req.user.username) || '';
    if (!username) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
    await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_username = ? AND is_read = 0',
      [username]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create (used by internal code — not exposed to clients typically)
// g-wf SECURITY: this endpoint creates a notification for ANY username — an
// unguarded write that let any authenticated user plant messages in anyone's
// feed. No frontend calls it (verified by grep); gated with workflow.manage
// (admin/hr/manager — the audience that legitimately announces to users).
router.post('/notifications', requireCapability('workflow.manage'), async (req, res) => {
  try {
    const { username, type, title, body, linkType, linkId, icon, iconColor } = req.body;
    if (!username || !title) return res.status(400).json({ error: 'username + title required' });
    const id = 'NT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    await db.query(
      `INSERT INTO notifications
       (id, user_username, type, title, body, link_type, link_id, icon, icon_color, is_read)
       VALUES (?,?,?,?,?,?,?,?,?,0)`,
      [id, username, type || 'info', title, body || '', linkType || null, linkId || null,
       icon || 'fa-bell', iconColor || 'info']);
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
