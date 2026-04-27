/**
 * V4 — workflow_routes (JSON-DSL workflow definitions)
 * Allows admins to define complex workflows with branching/conditional steps
 * stored as JSON, no schema migration needed for new flows.
 *
 *   GET    /api/workflow-routes?typeId=&positionId=
 *   GET    /api/workflow-routes/:id
 *   POST   /api/workflow-routes      (admin only)
 *   PUT    /api/workflow-routes/:id  (admin only)
 *   DELETE /api/workflow-routes/:id  (admin only)
 *   POST   /api/workflow-routes/:id/test  — dry-run with sample txn
 */

'use strict';

const router = require('express').Router();
const db = require('../db/connection');

function _isAdmin(req) {
  const user = req.user || {};
  return user.role === 'admin' || user.username === 'admin';
}

router.get('/', async (req, res) => {
  try {
    const { typeId, positionId, activeOnly } = req.query;
    let sql = 'SELECT * FROM workflow_routes WHERE 1=1';
    const params = [];
    if (typeId)     { sql += ' AND transaction_type_id = ?'; params.push(typeId); }
    if (positionId) { sql += ' AND initiator_position_id = ?'; params.push(positionId); }
    if (activeOnly === '1') sql += ' AND is_active = 1';
    sql += ' ORDER BY is_default DESC, route_name ASC';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id,
      transactionTypeId: r.transaction_type_id,
      initiatorPositionId: r.initiator_position_id,
      routeName: r.route_name,
      isDefault: !!r.is_default,
      isActive: !!r.is_active,
      conditions: _parseJson(r.conditions),
      steps: _parseJson(r.steps),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })));
  } catch(e) { res.json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM workflow_routes WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'route not found' });
    const r = rows[0];
    res.json({
      id: r.id,
      transactionTypeId: r.transaction_type_id,
      initiatorPositionId: r.initiator_position_id,
      routeName: r.route_name,
      isDefault: !!r.is_default,
      isActive: !!r.is_active,
      conditions: _parseJson(r.conditions),
      steps: _parseJson(r.steps),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    });
  } catch(e) { res.json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    if (!_isAdmin(req)) return res.status(403).json({ error: 'admin only' });
    const { transactionTypeId, initiatorPositionId, routeName, isDefault, conditions, steps } = req.body;
    // Validate steps minimum
    if (!Array.isArray(steps) || !steps.length) {
      return res.status(400).json({ error: 'steps must be a non-empty array' });
    }
    for (const [i, s] of steps.entries()) {
      if (!s.id || !s.name) {
        return res.status(400).json({ error: `step[${i}] must have id + name` });
      }
    }
    const id = 'WFR-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
    const username = (req.user && req.user.username) || req.body.username || 'admin';
    await db.query(
      `INSERT INTO workflow_routes (id, transaction_type_id, initiator_position_id, route_name,
        is_default, is_active, conditions, steps, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, transactionTypeId || null, initiatorPositionId || null, routeName || 'Default route',
       isDefault ? 1 : 0, 1, JSON.stringify(conditions || {}), JSON.stringify(steps), username]
    );
    res.json({ success: true, id });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!_isAdmin(req)) return res.status(403).json({ error: 'admin only' });
    const { routeName, isDefault, isActive, conditions, steps } = req.body;
    const sets = [], params = [];
    if (routeName !== undefined) { sets.push('route_name = ?'); params.push(routeName); }
    if (isDefault !== undefined) { sets.push('is_default = ?'); params.push(isDefault ? 1 : 0); }
    if (isActive !== undefined)  { sets.push('is_active = ?');  params.push(isActive ? 1 : 0); }
    if (conditions !== undefined){ sets.push('conditions = ?'); params.push(JSON.stringify(conditions)); }
    if (steps !== undefined) {
      if (!Array.isArray(steps) || !steps.length) {
        return res.status(400).json({ error: 'steps must be a non-empty array' });
      }
      sets.push('steps = ?'); params.push(JSON.stringify(steps));
    }
    if (!sets.length) return res.json({ success: false, error: 'no fields to update' });
    params.push(req.params.id);
    await db.query(`UPDATE workflow_routes SET ${sets.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!_isAdmin(req)) return res.status(403).json({ error: 'admin only' });
    await db.query('DELETE FROM workflow_routes WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Dry-run: given a sample txn, return which path the route would take
router.post('/:id/test', async (req, res) => {
  try {
    if (!_isAdmin(req)) return res.status(403).json({ error: 'admin only' });
    const sampleTxn = req.body.txn || {};
    const [rows] = await db.query('SELECT * FROM workflow_routes WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'route not found' });
    const route = rows[0];
    const steps = _parseJson(route.steps);
    const path = _resolvePath(steps, sampleTxn);
    res.json({ success: true, path });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function _parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch(e) { return null; }
}

function _resolvePath(steps, txn) {
  // Simple linear resolver — picks "default" branch if no matching condition
  const path = [];
  if (!Array.isArray(steps)) return path;
  let curr = steps[0];
  const seen = new Set();
  while (curr && !seen.has(curr.id)) {
    seen.add(curr.id);
    path.push({ id: curr.id, name: curr.name, position: curr.required_position_id });
    if (curr.is_terminal) break;
    let nextId = null;
    if (curr.branches && Array.isArray(curr.branches)) {
      for (const br of curr.branches) {
        if (_evalCondition(br.if, txn)) { nextId = br.next; break; }
      }
    }
    if (!nextId && curr.next && curr.next.default) nextId = curr.next.default;
    curr = steps.find(s => s.id === nextId);
  }
  return path;
}

function _evalCondition(expr, ctx) {
  // Trivial expression evaluator: supports `field <op> value`
  // Examples: "amount <= 50000", "branchId == BR-001"
  if (!expr || typeof expr !== 'string') return false;
  const m = expr.match(/^\s*([a-zA-Z_]\w*)\s*(<=|>=|<|>|==|!=)\s*(.+?)\s*$/);
  if (!m) return false;
  const [, field, op, rhsRaw] = m;
  const lhs = ctx[field];
  let rhs = rhsRaw.trim().replace(/^["']|["']$/g, '');
  if (!isNaN(Number(rhs))) rhs = Number(rhs);
  switch (op) {
    case '<':  return Number(lhs) <  Number(rhs);
    case '<=': return Number(lhs) <= Number(rhs);
    case '>':  return Number(lhs) >  Number(rhs);
    case '>=': return Number(lhs) >= Number(rhs);
    case '==': return String(lhs) === String(rhs);
    case '!=': return String(lhs) !== String(rhs);
  }
  return false;
}

module.exports = router;
