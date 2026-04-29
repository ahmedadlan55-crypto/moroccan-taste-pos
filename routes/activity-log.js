/**
 * Activity Log Viewer — V5
 * Unified read API over the existing audit_logs table.
 *   GET /api/activity-log
 *     ?user=ahmed       (filter by username)
 *     &action=approve   (filter by action_type / action)
 *     &entity=transaction (filter by entity_type)
 *     &from=2026-01-01  (date range)
 *     &to=2026-12-31
 *     &limit=100        (max 500)
 *   GET /api/activity-log/dashboard  → counts by user + action
 *   GET /api/activity-log/user-stats?user=X → recent activity for one user
 */
const router = require('express').Router();
const db = require('../db/connection');

// Admin-only guard: must hit before any handler
router.use(function(req, res, next){
  const role = (req.user && req.user.role) || '';
  const isDev = !!(req.user && req.user.isDeveloper);
  if (role !== 'admin' && !isDev) {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
});

// V5-FIX: detect which user column the deployed audit_logs schema has
// (server.js defines 3 variants: user_username, username — first one wins via
// CREATE TABLE IF NOT EXISTS, but Railway may have the second one).
let _userColCache = null;
async function _userCol() {
  if (_userColCache) return _userColCache;
  try {
    const [cols] = await db.query(`SHOW COLUMNS FROM audit_logs`);
    const names = cols.map(c => c.Field || c.field);
    if (names.includes('user_username')) _userColCache = 'user_username';
    else if (names.includes('username'))  _userColCache = 'username';
    else _userColCache = 'username';   // safe default
  } catch(_) { _userColCache = 'username'; }
  return _userColCache;
}

router.get('/', async (req, res) => {
  try {
    const userCol = await _userCol();
    const { user, action, entity, from, to } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const conds = []; const params = [];
    if (user)   { conds.push(userCol + ' = ?'); params.push(user); }
    if (action) { conds.push('action = ?'); params.push(action); }
    if (entity) { conds.push('entity_type = ?'); params.push(entity); }
    if (from)   { conds.push('created_at >= ?'); params.push(from); }
    if (to)     { conds.push('created_at <= ?'); params.push(to + ' 23:59:59'); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const [rows] = await db.query(
      `SELECT id, ${userCol} AS user_col, action, entity_type, entity_id, details, ip_address, created_at
       FROM audit_logs ${where}
       ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
    res.json(rows.map(r => ({
      id: r.id,
      user: r.user_col,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: (function(){ try { return JSON.parse(r.details||'{}'); } catch(_) { return {}; } })(),
      ip: r.ip_address || '',
      at: r.created_at
    })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const userCol = await _userCol();
    const since = req.query.since || new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0,10);
    const [byUser] = await db.query(
      `SELECT ${userCol} AS user_col, COUNT(*) AS cnt FROM audit_logs
       WHERE created_at >= ? GROUP BY ${userCol} ORDER BY cnt DESC LIMIT 20`, [since]);
    const [byAction] = await db.query(
      `SELECT action, COUNT(*) AS cnt FROM audit_logs
       WHERE created_at >= ? GROUP BY action ORDER BY cnt DESC LIMIT 20`, [since]);
    const [byEntity] = await db.query(
      `SELECT entity_type, COUNT(*) AS cnt FROM audit_logs
       WHERE created_at >= ? GROUP BY entity_type ORDER BY cnt DESC LIMIT 20`, [since]);
    const [total] = await db.query(`SELECT COUNT(*) AS c FROM audit_logs WHERE created_at >= ?`, [since]);
    res.json({
      since, total: total[0].c,
      byUser: byUser.map(r => ({ user: r.user_col, cnt: r.cnt })),
      byAction, byEntity
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/user-stats', async (req, res) => {
  try {
    const userCol = await _userCol();
    const user = req.query.user;
    if (!user) return res.status(400).json({ error: 'user required' });
    const [counts] = await db.query(`
      SELECT
        COUNT(*) AS total,
        SUM(action LIKE 'workflow_%') AS workflow_actions,
        SUM(action = 'login')    AS logins,
        SUM(action = 'logout')   AS logouts,
        SUM(action = 'soft_delete') AS deletes,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen
      FROM audit_logs WHERE ${userCol} = ?`, [user]);
    const [recent] = await db.query(`
      SELECT action, entity_type, entity_id, created_at
      FROM audit_logs WHERE ${userCol} = ?
      ORDER BY created_at DESC LIMIT 50`, [user]);
    res.json({ user, ...counts[0], recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
