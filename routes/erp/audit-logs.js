// ═══════════════════════════════════════════════════════════════════
// /api/erp/audit-logs — Audit-log query
//
// Read-only window over the audit_logs table. Accepts both legacy
// (entityType/entityId/startDate/endDate/username) and new
// (entity/from/to/user/action/search) parameter names so older
// admin pages keep working. Defaults to 500 rows, newest first.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

router.get('/audit-logs', async (req, res) => {
  try {
    const q = req.query;
    const entity   = q.entity     || q.entityType || '';
    const entityId = q.entityId   || '';
    const username = q.user       || q.username   || '';
    const action   = q.action     || '';
    const from     = q.from       || q.startDate  || '';
    const to       = q.to         || q.endDate    || '';
    const search   = q.search     || '';
    const lim      = q.limit;

    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    if (entity)   { query += ' AND entity_type = ?'; params.push(entity); }
    if (entityId) { query += ' AND entity_id = ?';   params.push(entityId); }
    if (username) { query += ' AND username = ?';    params.push(username); }
    if (action)   { query += ' AND action = ?';      params.push(action); }
    if (from)     { query += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)       { query += ' AND DATE(created_at) <= ?'; params.push(to); }
    if (search) {
      query += ' AND (details LIKE ? OR entity_id LIKE ?)';
      params.push('%'+search+'%', '%'+search+'%');
    }
    query += ' ORDER BY created_at DESC LIMIT ' + (Number(lim) || 500);

    const [rows] = await db.query(query, params);
    res.json(rows.map(r => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entity: r.entity_type,            // alias for new UI
      entityId: r.entity_id,
      documentRef: r.entity_id,         // alias
      reference: r.entity_id,           // alias
      username: r.username,
      details: r.details,
      description: r.details,           // alias
      ip: r.ip_address,
      ipAddress: r.ip_address,
      createdAt: r.created_at,
      timestamp: r.created_at
    })));
  } catch(e) { res.json([]); }
});

module.exports = router;
