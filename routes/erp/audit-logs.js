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
const requireCapability = require('../../middleware/requireCapability');

const AUDIT_REPORT_MAX_ROWS = 5000;

function validDate(value) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

router.get('/audit-logs', requireCapability('administration.audit'), async (req, res) => {
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
    const reportMode = String(q.report || '') === '1';

    if (!validDate(from) || !validDate(to)) {
      return res.status(400).json({ success: false, code: 'INVALID_DATE', error: 'صيغة التاريخ غير صحيحة' });
    }
    if (from && to && from > to) {
      return res.status(400).json({ success: false, code: 'INVALID_DATE_RANGE', error: 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية' });
    }

    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    if (entity)   { query += ' AND entity_type = ?'; params.push(entity); }
    if (entityId) { query += ' AND entity_id = ?';   params.push(entityId); }
    if (username) { query += ' AND user_username = ?'; params.push(username); }
    if (action)   { query += ' AND action = ?';      params.push(action); }
    if (from)     { query += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)       { query += ' AND DATE(created_at) <= ?'; params.push(to); }
    if (search) {
      query += ' AND (details LIKE ? OR entity_id LIKE ?)';
      params.push('%'+search+'%', '%'+search+'%');
    }
    const requestedLimit = Math.trunc(Number(lim));
    const normalLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 1000)
      : 500;
    query += ' ORDER BY created_at DESC LIMIT ' + (reportMode ? AUDIT_REPORT_MAX_ROWS + 1 : normalLimit);

    const [rows] = await db.query(query, params);
    if (reportMode && rows.length > AUDIT_REPORT_MAX_ROWS) {
      return res.status(413).json({
        success: false,
        code: 'REPORT_TOO_LARGE',
        error: 'التقرير أكبر من حد الطباعة والتصدير، ضيّق الفترة أو المرشّحات',
        maxRows: AUDIT_REPORT_MAX_ROWS,
      });
    }
    res.json(rows.map(r => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entity: r.entity_type,            // alias for new UI
      entityId: r.entity_id,
      documentRef: r.entity_id,         // alias
      reference: r.entity_id,           // alias
      username: r.user_username,
      details: r.details,
      description: r.details,           // alias
      ip: r.ip_address,
      ipAddress: r.ip_address,
      createdAt: r.created_at,
      timestamp: r.created_at
    })));
  } catch(e) {
    console.error('[erp/audit-logs] query failed:', e && e.message);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'تعذّر تحميل سجل التدقيق' });
  }
});

module.exports = router;
