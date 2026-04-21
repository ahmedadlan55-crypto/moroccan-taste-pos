/**
 * Notifications — Phase D foundation
 * User-level event feed.
 */
const router = require('express').Router();
const db = require('../db/connection');

// List (current user)
router.get('/notifications', async (req, res) => {
  try {
    var username = (req.user && req.user.username) || req.query.username || '';
    if (!username) return res.json([]);
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
    var username = (req.user && req.user.username) || req.query.username || '';
    if (!username) return res.json({ count: 0 });
    const [rows] = await db.query(
      'SELECT COUNT(*) AS c FROM notifications WHERE user_username = ? AND is_read = 0',
      [username]);
    res.json({ count: rows[0].c || 0 });
  } catch(e) { res.json({ count: 0 }); }
});

// Mark one as read
router.post('/notifications/:id/read', async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ?',
      [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mark all as read
router.post('/notifications/read-all', async (req, res) => {
  try {
    var username = (req.user && req.user.username) || req.body.username || '';
    if (!username) return res.status(400).json({ error: 'username required' });
    await db.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_username = ? AND is_read = 0',
      [username]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create (used by internal code — not exposed to clients typically)
router.post('/notifications', async (req, res) => {
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
