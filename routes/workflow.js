/**
 * Workflow Engine v2 — نظام المعاملات الإداري المتكامل
 *
 * Features:
 *  - Structured transaction numbering: BR-DEP-TYP-YYYYMMDD-0001
 *  - Incoming Box (صندوق الوارد): transactions awaiting current user's action
 *  - Outgoing Box (صندوق الصادر): transactions created by current user
 *  - Dashboard with importance-colored cards (critical/high/medium/low)
 *  - Full workflow engine: approve / reject / return / forward / close
 *  - Per-employee permission flags + manager hierarchy
 *  - Auto-routing by step → position or directly to recipient
 *  - Multiple attachments per step
 */
const router = require('express').Router();
const db = require('../db/connection');
// V4 — State machine + permission engine + schema validation + guards + storage
const SM = require('../lib/transactionStateMachine');
const PERMS = require('../lib/transactionPermissions');
const SCHEMA = require('../lib/transactionSchema');
const { guardTxnAccess, guardDeveloper } = require('../lib/transactionGuards');
const S3 = require('../lib/s3Storage');     // optional — falls back to inline if not configured
const CACHE = require('../lib/redisCache'); // optional — no-op if REDIS_URL not set

// Mojibake fixer: repairs UTF-8 Arabic text that was decoded through a
// single-byte codepage (Latin-1 or Windows-1252). Produces forms like
// "Ø·Ù„Ø¨" (cp1252) or "ÙƒÙ„Ù…Ø©" (latin1) instead of "طلب" / "كلمة".
//
// Strategy: try both latin1 and cp1252 round-trips. For each candidate,
// score by number of Arabic code points produced; take the best, provided
// it's strictly more Arabic than the original.
const _CP1252_MAP = {  // extra Windows-1252 mappings vs Latin-1
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84,
  0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
  0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
  0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
  0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F
};
// cp1252 "undefined" slots that most implementations pass through identically
const _CP1252_PASSTHRU = new Set([0x81, 0x8D, 0x8F, 0x90, 0x9D]);
function _toBytesViaCp1252(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) bytes.push(cp);
    else if (_CP1252_MAP[cp] !== undefined) bytes.push(_CP1252_MAP[cp]);
    else if (_CP1252_PASSTHRU.has(cp)) bytes.push(cp);
    else return null;  // unrepresentable — bail
  }
  return Buffer.from(bytes);
}
function _arabicCount(s) {
  const m = s.match(/[\u0600-\u06FF]/g);
  return m ? m.length : 0;
}
function fixMojibake(s) {
  if (!s || typeof s !== 'string') return s;
  // Fast path: no suspicious bytes at all
  if (!/[\u0080-\u00FF\u0152\u0153\u0160\u0161\u017D\u017E\u0178\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]/.test(s)) return s;
  const origArabic = _arabicCount(s);
  let best = { text: s, score: origArabic };
  // Try latin1 round-trip
  try {
    const r = Buffer.from(s, 'latin1').toString('utf8');
    const sc = _arabicCount(r);
    if (sc > best.score) best = { text: r, score: sc };
  } catch(e) {}
  // Try cp1252 round-trip
  try {
    const bytes = _toBytesViaCp1252(s);
    if (bytes) {
      const r = bytes.toString('utf8');
      const sc = _arabicCount(r);
      if (sc > best.score) best = { text: r, score: sc };
    }
  } catch(e) {}
  // Only accept a repair if it produced strictly more Arabic than the original
  return best.score > origArabic ? best.text : s;
}

// Apply fixMojibake to every string field in an object (shallow)
function fixObj(o) {
  if (!o || typeof o !== 'object') return o;
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'string') o[k] = fixMojibake(o[k]);
  }
  return o;
}

// ─── Helpers ─────────────────────────────────────────────────

function todayYmd(d) {
  d = d || new Date();
  return d.getFullYear().toString() +
    String(d.getMonth()+1).padStart(2,'0') +
    String(d.getDate()).padStart(2,'0');
}

function sanitizeCode(s, fallback) {
  if (!s) return fallback || 'GEN';
  const clean = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return clean || (fallback || 'GEN');
}

// Generate strict daily serial for (branch, dept, type, date)
async function nextDailySerial(branchCode, deptCode, typeCode) {
  const ymd = todayYmd();
  const key = [branchCode, deptCode, typeCode, ymd].join('|');
  // Upsert: increment existing counter or insert new — safe under concurrency via ON DUPLICATE KEY
  await db.query(
    `INSERT INTO txn_daily_counter (counter_key, last_serial) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE last_serial = last_serial + 1`, [key]);
  const [rows] = await db.query('SELECT last_serial FROM txn_daily_counter WHERE counter_key = ?', [key]);
  return rows.length ? rows[0].last_serial : 1;
}

// ═══════════════════════════════════════
// ROLE-BASED ASSIGNEE RESOLVER
// (spec §5: find employee by job_title + branch + department,
//  pick least-busy, fall back gracefully when no match)
// ═══════════════════════════════════════

// Look up a step in position_workflow_steps (by initiator + step order).
// Used by create/approve/return. Returns null if no chain is defined for this
// initiator (fall back to legacy workflow_definitions per type).
async function getPositionStep(initiatorPositionId, stepOrder) {
  if (!initiatorPositionId) return null;
  const [rows] = await db.query(
    `SELECT * FROM position_workflow_steps WHERE initiator_position_id = ? AND step_order = ?`,
    [initiatorPositionId, stepOrder]);
  return rows.length ? rows[0] : null;
}

// Find the FIRST step in the initiator's chain
async function getInitiatorFirstStep(initiatorPositionId) {
  if (!initiatorPositionId) return null;
  const [rows] = await db.query(
    `SELECT * FROM position_workflow_steps WHERE initiator_position_id = ? ORDER BY step_order ASC LIMIT 1`,
    [initiatorPositionId]);
  return rows.length ? rows[0] : null;
}

// Normalize a position_workflow_steps row to the same shape used by the
// existing resolver/action logic (which expects workflow_definitions columns).
function _normalizePositionStep(r) {
  if (!r) return null;
  return {
    id: r.id,
    step_order: r.step_order,
    step_name: r.step_name,
    required_position_id: r.required_position_id,
    is_final_step: r.is_final_step,
    can_approve: r.can_approve,
    can_reject: r.can_reject,
    can_return_to_previous: r.can_return_to_previous,
    can_edit: r.can_edit,
    can_edit_amount: r.can_edit_amount,
    require_same_branch: r.require_same_branch,
    require_same_department: r.require_same_department,
    assignment_strategy: r.assignment_strategy,
    _source: 'position'
  };
}

async function resolveAssigneeForStep(step, branchId, deptId) {
  if (!step || !step.required_position_id) return { username: '', employeeId: '', roleName: '' };
  const roleId = step.required_position_id;
  const [roleRow] = await db.query('SELECT name FROM positions WHERE id = ?', [roleId]);
  const roleName = roleRow.length ? roleRow[0].name : '';

  const strat = step.assignment_strategy || 'least_busy';
  const needBranch = step.require_same_branch !== 0 && step.require_same_branch !== false;
  const needDept   = step.require_same_department === 1 || step.require_same_department === true;

  // Try progressively broader matches:
  //   1. exact (role + branch + dept) — only if both flags set
  //   2. role + branch (if branch required)
  //   3. role only (final fallback)
  const attempts = [];
  if (needBranch && needDept && branchId && deptId) {
    attempts.push({ branch: branchId, dept: deptId, label: 'exact' });
  }
  if (needBranch && branchId) attempts.push({ branch: branchId, dept: null, label: 'branch' });
  attempts.push({ branch: null, dept: null, label: 'any' });

  for (const a of attempts) {
    const params = [roleId];
    let where = `e.position_id = ? AND e.status = 'active'`;
    if (a.branch) { where += ' AND e.branch_id = ?'; params.push(a.branch); }
    if (a.dept)   { where += ' AND e.department_id = ?'; params.push(a.dept); }

    let order;
    if (strat === 'first') order = 'e.created_at ASC';
    else {
      // least_busy: count open transactions currently assigned to the user
      order = `(
        SELECT COUNT(*) FROM transactions t
        WHERE t.current_assignee = e.linked_username
          AND t.status IN ('pending','in_progress')
      ) ASC, e.created_at ASC`;
    }

    const [rows] = await db.query(
      `SELECT e.id AS emp_id, e.linked_username, e.first_name, e.last_name
       FROM hr_employees e
       WHERE ${where} AND e.linked_username IS NOT NULL AND e.linked_username <> ''
       ORDER BY ${order}
       LIMIT 1`, params);
    if (rows.length) {
      return { username: rows[0].linked_username, employeeId: rows[0].emp_id, roleName, matchedAt: a.label };
    }
  }

  // Last-ditch: match via users.position_id (for admin / non-HR users)
  const [u] = await db.query(
    `SELECT username FROM users WHERE position_id = ? AND active = 1
     ORDER BY (SELECT COUNT(*) FROM transactions t WHERE t.current_assignee = users.username
              AND t.status IN ('pending','in_progress')) ASC, id ASC LIMIT 1`, [roleId]);
  if (u.length) return { username: u[0].username, employeeId: '', roleName, matchedAt: 'user_fallback' };

  return { username: '', employeeId: '', roleName, matchedAt: 'none' };
}

// Resolve employee profile by linked_username or user_id
async function resolveEmployee(username) {
  if (!username) return null;
  const [rows] = await db.query(
    `SELECT e.*, b.name AS branch_name, b.code AS branch_code_real,
            d.name AS dept_name, d.code AS dept_code_real,
            p.name AS position_name, p.level AS position_level
     FROM hr_employees e
     LEFT JOIN branches b ON e.branch_id = b.id
     LEFT JOIN hr_departments d ON e.department_id = d.id
     LEFT JOIN positions p ON e.position_id = p.id
     WHERE e.linked_username = ? OR e.employee_number = ?
     LIMIT 1`, [username, username]);
  return rows.length ? rows[0] : null;
}

// Check the user's permissions set (falls back to position-level defaults if not an HR employee)
async function getPermissions(username) {
  const emp = await resolveEmployee(username);
  // Resolve role from users table (always — employees may not have it set)
  let userRole = '';
  try {
    const [r] = await db.query('SELECT role FROM users WHERE username = ? LIMIT 1', [username]);
    if (r.length) userRole = (r[0].role || '').toLowerCase();
  } catch(_) {}

  if (emp) {
    return {
      isEmployee: true,
      role: userRole,
      employeeId: emp.id,
      managerId: emp.manager_id || '',
      level: Number(emp.workflow_level) || Number(emp.position_level) || 1,
      branchId: emp.branch_id || '',
      branchName: emp.branch_name || '',
      branchCode: emp.branch_code_real || '',
      deptId: emp.department_id || '',
      deptName: emp.dept_name || '',
      deptCode: emp.dept_code_real || '',
      positionId: emp.position_id || '',
      positionName: emp.position_name || emp.job_title || '',
      canCreate: !!emp.can_create_txn || true,
      canApprove: !!emp.can_approve_txn,
      canReject: !!emp.can_reject_txn,
      canReturn: !!emp.can_return_txn,
      canForward: !!emp.can_forward_txn,
      canClose: !!emp.can_close_txn
    };
  }
  // Fallback: users table (admins / non-HR users)
  const [u] = await db.query(
    `SELECT u.id, u.username, u.role, u.position_id, u.branch_id,
            p.name AS position_name, p.level AS position_level,
            b.name AS branch_name, b.code AS branch_code
     FROM users u LEFT JOIN positions p ON u.position_id = p.id
     LEFT JOIN branches b ON u.branch_id = b.id WHERE u.username = ? LIMIT 1`, [username]);
  if (!u.length) return { isEmployee: false, role: '', level: 0, canCreate: true };
  const isAdmin = u[0].role === 'admin';
  return {
    isEmployee: false,
    role: (u[0].role || '').toLowerCase(),
    userId: u[0].id,
    level: Number(u[0].position_level) || (isAdmin ? 99 : 1),
    branchId: u[0].branch_id || '',
    branchName: u[0].branch_name || '',
    branchCode: u[0].branch_code || '',
    positionId: u[0].position_id || '',
    positionName: u[0].position_name || (isAdmin ? 'مدير النظام' : ''),
    canCreate: true, canApprove: isAdmin, canReject: isAdmin,
    canReturn: isAdmin, canForward: isAdmin, canClose: isAdmin
  };
}

// ═══════════════════════════════════════
// POSITIONS (المناصب الإدارية)
// ═══════════════════════════════════════

router.get('/positions', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM positions ORDER BY level');
    res.json(rows.map(p => ({ id: p.id, name: p.name, level: p.level, isActive: !!p.is_active })));
  } catch(e) { res.json([]); }
});

router.post('/positions', async (req, res) => {
  try {
    const { id, name, level } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query('UPDATE positions SET name=?, level=? WHERE id=?', [name, level||0, id]);
      return res.json({ success: true, id });
    }
    const newId = 'POS-' + Date.now();
    await db.query('INSERT INTO positions (id, name, level) VALUES (?,?,?)', [newId, name, level||0]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/positions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM positions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// TRANSACTION TYPES (أنواع المعاملات)
// ═══════════════════════════════════════

router.get('/transaction-types', async (req, res) => {
  try {
    const { category, requiresPayment } = req.query;
    let sql = 'SELECT * FROM transaction_types WHERE 1=1';
    const params = [];
    if (category) { sql += ' AND category = ?'; params.push(category); }
    if (requiresPayment === '1') sql += ' AND requires_payment = 1';
    if (requiresPayment === '0') sql += ' AND requires_payment = 0';
    sql += ' ORDER BY sort_order ASC, name ASC';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(t => ({
      id: t.id, name: t.name, code: t.code, isActive: !!t.is_active,
      category: t.category || 'administrative',
      requiresPayment: !!t.requires_payment,
      glTemplateCode: t.gl_template_code || null,
      icon: t.icon || 'fa-file-alt',
      iconColor: t.icon_color || 'info',
      description: t.description || '',
      sortOrder: t.sort_order || 100
    })));
  } catch(e) { res.json([]); }
});

// Grouped by category — convenient for the "new transaction" wizard
router.get('/transaction-types/grouped', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM transaction_types ORDER BY category, sort_order ASC, name ASC');
    const groups = { financial: [], administrative: [], procurement: [], operational: [], hr: [] };
    const labels = {
      financial:      { label: 'مالية',         icon: 'fa-sack-dollar',     color: 'warning' },
      administrative: { label: 'إدارية',        icon: 'fa-building',         color: 'info' },
      procurement:    { label: 'مشتريات',       icon: 'fa-cart-shopping',    color: 'success' },
      operational:    { label: 'تشغيلية',       icon: 'fa-industry',         color: 'purple' },
      hr:             { label: 'موارد بشرية',   icon: 'fa-users',            color: 'info' }
    };
    rows.forEach(t => {
      const cat = t.category || 'administrative';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({
        id: t.id, name: t.name, code: t.code, isActive: !!t.is_active,
        category: cat, requiresPayment: !!t.requires_payment,
        glTemplateCode: t.gl_template_code || null,
        icon: t.icon || 'fa-file-alt', iconColor: t.icon_color || 'info',
        description: t.description || ''
      });
    });
    res.json({
      groups: Object.keys(groups).map(cat => ({
        category: cat, label: labels[cat] ? labels[cat].label : cat,
        icon: labels[cat] ? labels[cat].icon : 'fa-folder',
        color: labels[cat] ? labels[cat].color : 'neutral',
        types: groups[cat]
      })),
      total: rows.length
    });
  } catch(e) { res.json({ groups: [], total: 0, error: e.message }); }
});

// GL templates (for UI preview of "what journal will post")
router.get('/gl-templates', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM transaction_gl_templates ORDER BY code');
    res.json(rows);
  } catch(e) { res.json([]); }
});

// Default approval chain for a given transaction type
router.get('/transaction-types/:code/default-chain', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM txn_type_default_chain
       WHERE transaction_type_code = ?
       ORDER BY step_order ASC, amount_from ASC`,
      [req.params.code]);
    res.json(rows);
  } catch(e) { res.json([]); }
});

router.post('/transaction-types', async (req, res) => {
  try {
    const { id, name, code } = req.body;
    if (!name || !code) return res.json({ success: false, error: 'الاسم والرمز مطلوبان' });
    const safeCode = sanitizeCode(code, 'TXN');
    if (id) {
      await db.query('UPDATE transaction_types SET name=?, code=? WHERE id=?', [name, safeCode, id]);
      return res.json({ success: true, id });
    }
    const newId = 'TT-' + Date.now();
    await db.query('INSERT INTO transaction_types (id, name, code) VALUES (?,?,?)', [newId, name, safeCode]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/transaction-types/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM transaction_types WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// WORKFLOW DEFINITIONS (خطوات المعاملة)
// ═══════════════════════════════════════

// All steps where a specific position is responsible (across transaction types)
router.get('/workflow-definitions-by-role/:positionId', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT wd.*, p.name AS position_name, tt.name AS type_name, tt.code AS type_code
       FROM workflow_definitions wd
       LEFT JOIN positions p ON wd.required_position_id = p.id
       LEFT JOIN transaction_types tt ON wd.transaction_type_id = tt.id
       WHERE wd.required_position_id = ?
       ORDER BY tt.name, wd.step_order`, [req.params.positionId]);
    res.json(rows.map(w => ({
      id: w.id, stepOrder: w.step_order, stepName: w.step_name,
      transactionTypeId: w.transaction_type_id, typeName: w.type_name || '', typeCode: w.type_code || '',
      positionId: w.required_position_id, positionName: w.position_name || '',
      canEditAmount: !!w.can_edit_amount,
      canReturn: !!w.can_return_to_previous,
      canApprove: w.can_approve === null || w.can_approve === undefined ? true : !!w.can_approve,
      canReject:  w.can_reject  === null || w.can_reject  === undefined ? true : !!w.can_reject,
      canEdit:    !!w.can_edit,
      isFinal: !!w.is_final_step,
      requireSameBranch: w.require_same_branch === null || w.require_same_branch === undefined ? true : !!w.require_same_branch,
      requireSameDepartment: !!w.require_same_department,
      assignmentStrategy: w.assignment_strategy || 'least_busy'
    })));
  } catch(e) { res.json([]); }
});

router.get('/workflow-definitions/:typeId', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT wd.*, p.name AS position_name FROM workflow_definitions wd
       LEFT JOIN positions p ON wd.required_position_id = p.id
       WHERE wd.transaction_type_id = ? ORDER BY wd.step_order`, [req.params.typeId]);
    res.json(rows.map(w => ({
      id: w.id, stepOrder: w.step_order, stepName: w.step_name,
      positionId: w.required_position_id, positionName: w.position_name || '',
      canEditAmount: !!w.can_edit_amount,
      canReturn: !!w.can_return_to_previous,
      canApprove: w.can_approve === null || w.can_approve === undefined ? true : !!w.can_approve,
      canReject:  w.can_reject  === null || w.can_reject  === undefined ? true : !!w.can_reject,
      canEdit:    !!w.can_edit,
      isFinal: !!w.is_final_step,
      requireSameBranch: w.require_same_branch === null || w.require_same_branch === undefined ? true : !!w.require_same_branch,
      requireSameDepartment: !!w.require_same_department,
      assignmentStrategy: w.assignment_strategy || 'least_busy'
    })));
  } catch(e) { res.json([]); }
});

router.post('/workflow-definitions', async (req, res) => {
  try {
    const {
      id, transactionTypeId, stepOrder, stepName, positionId,
      canEditAmount, canReturn, canApprove, canReject, canEdit, isFinal,
      requireSameBranch, requireSameDepartment, assignmentStrategy
    } = req.body;
    if (!transactionTypeId) return res.json({ success: false, error: 'نوع المعاملة مطلوب' });
    // Auto-generate step name from role name when blank
    let finalStepName = (stepName || '').trim();
    if (!finalStepName) {
      let roleName = 'خطوة';
      if (positionId) {
        const [r] = await db.query('SELECT name FROM positions WHERE id = ?', [positionId]);
        if (r.length) roleName = r[0].name;
      }
      finalStepName = roleName + ' — خطوة ' + (Number(stepOrder) || 1);
    }
    const rb = requireSameBranch !== false ? 1 : 0;
    const rd = requireSameDepartment ? 1 : 0;
    const strat = ['least_busy','first','round_robin'].includes(assignmentStrategy) ? assignmentStrategy : 'least_busy';
    const cApprove = canApprove !== false ? 1 : 0;
    const cReject  = canReject  !== false ? 1 : 0;
    const cEdit    = canEdit ? 1 : 0;
    if (id) {
      await db.query(
        `UPDATE workflow_definitions SET
           step_order=?, step_name=?, required_position_id=?,
           can_edit_amount=?, can_return_to_previous=?, is_final_step=?,
           require_same_branch=?, require_same_department=?, assignment_strategy=?,
           can_approve=?, can_reject=?, can_edit=?
         WHERE id=?`,
        [stepOrder||1, finalStepName, positionId||null,
         canEditAmount?1:0, canReturn!==false?1:0, isFinal?1:0,
         rb, rd, strat, cApprove, cReject, cEdit, id]);
      return res.json({ success: true, id });
    }
    const newId = 'WD-' + Date.now();
    await db.query(
      `INSERT INTO workflow_definitions (
         id, transaction_type_id, step_order, step_name, required_position_id,
         can_edit_amount, can_return_to_previous, is_final_step,
         require_same_branch, require_same_department, assignment_strategy,
         can_approve, can_reject, can_edit
       ) VALUES (?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?)`,
      [newId, transactionTypeId, stepOrder||1, finalStepName, positionId||null,
       canEditAmount?1:0, canReturn!==false?1:0, isFinal?1:0,
       rb, rd, strat, cApprove, cReject, cEdit]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/workflow-definitions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM workflow_definitions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Replace the ENTIRE step sequence — applies to ALL transaction types by
// default (role-based default chain), OR to a specific type if transactionTypeId
// is provided. This matches the spec: a single administrative chain
// (محاسب → مدير مالي → مدير تنفيذي → …) governs every transaction regardless
// of type.
// Body: { transactionTypeId? (omit = all types),
//         steps: [{ stepOrder?, stepName?, positionId, canApprove, canReject,
//           canReturn, canEditAmount, canEdit, isFinal,
//           requireSameBranch, requireSameDepartment, assignmentStrategy }, ...] }
router.post('/workflow-definitions/bulk', async (req, res) => {
  try {
    const { transactionTypeId, steps, applyToAllTypes } = req.body;
    if (!Array.isArray(steps) || !steps.length) return res.json({ success: false, error: 'يجب إضافة خطوة واحدة على الأقل' });

    // Determine target types: one specific, or all
    let targetTypes;
    if (transactionTypeId && !applyToAllTypes) {
      targetTypes = [transactionTypeId];
    } else {
      const [all] = await db.query('SELECT id FROM transaction_types WHERE is_active = 1 OR is_active IS NULL');
      targetTypes = all.map(r => r.id);
      if (!targetTypes.length) return res.json({ success: false, error: 'لا توجد أنواع معاملات معرّفة' });
    }

    // Preload role names for auto-generated step names
    const roleIds = [...new Set(steps.map(s => s.positionId).filter(Boolean))];
    const roleMap = {};
    if (roleIds.length) {
      const placeholders = roleIds.map(() => '?').join(',');
      const [rn] = await db.query(`SELECT id, name FROM positions WHERE id IN (${placeholders})`, roleIds);
      rn.forEach(r => { roleMap[r.id] = r.name; });
    }

    // Auto-mark last step final if none set
    const hasFinal = steps.some(s => s.isFinal === true || s.isFinal === 1);
    if (!hasFinal) steps[steps.length - 1].isFinal = true;

    let totalInserted = 0;
    for (const typeId of targetTypes) {
      // Replace: wipe then insert fresh for this type
      await db.query('DELETE FROM workflow_definitions WHERE transaction_type_id = ?', [typeId]);

      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const stepOrder = Number(s.stepOrder) || (i + 1);
        let stepName = (s.stepName || '').trim();
        if (!stepName) {
          const roleName = s.positionId ? (roleMap[s.positionId] || 'خطوة') : 'خطوة';
          stepName = roleName + ' — خطوة ' + stepOrder;
        }
        const rb = s.requireSameBranch !== false ? 1 : 0;
        const rd = s.requireSameDepartment ? 1 : 0;
        const strat = ['least_busy','first','round_robin'].includes(s.assignmentStrategy) ? s.assignmentStrategy : 'least_busy';
        const cApprove = s.canApprove !== false ? 1 : 0;
        const cReject  = s.canReject  !== false ? 1 : 0;
        const cEdit    = s.canEdit ? 1 : 0;
        const cEditAmt = s.canEditAmount ? 1 : 0;
        const cReturn  = s.canReturn !== false ? 1 : 0;
        const isFinal  = (s.isFinal === true || s.isFinal === 1) ? 1 : 0;

        const id = 'WD-' + Date.now() + '-' + i + '-' + Math.random().toString(36).substr(2, 4);
        await db.query(
          `INSERT INTO workflow_definitions (
             id, transaction_type_id, step_order, step_name, required_position_id,
             can_edit_amount, can_return_to_previous, is_final_step,
             require_same_branch, require_same_department, assignment_strategy,
             can_approve, can_reject, can_edit
           ) VALUES (?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?)`,
          [id, typeId, stepOrder, stepName, s.positionId || null,
           cEditAmt, cReturn, isFinal, rb, rd, strat, cApprove, cReject, cEdit]);
        totalInserted++;
      }
    }

    res.json({ success: true, count: totalInserted, typesAffected: targetTypes.length, steps: steps.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// PER-POSITION WORKFLOW (new primary model)
// Each initiator position has its own isolated chain.
// ═══════════════════════════════════════

// Return the chain for a given initiator position
// GET steps for a given initiator position.
// ?pathKey=default (default) returns one specific path.
// Without pathKey, returns ALL paths grouped by path_key.
router.get('/position-workflow/:initiatorPositionId', async (req, res) => {
  try {
    const pathKey = req.query.pathKey;
    const params = [req.params.initiatorPositionId];
    let where = 'WHERE s.initiator_position_id = ?';
    if (pathKey) { where += " AND COALESCE(s.path_key,'default') = ?"; params.push(pathKey); }
    const [rows] = await db.query(
      `SELECT s.*, p.name AS required_position_name
       FROM position_workflow_steps s
       LEFT JOIN positions p ON s.required_position_id = p.id
       ${where}
       ORDER BY COALESCE(s.path_key,'default'), s.step_order`, params);
    res.json(rows.map(w => ({
      id: w.id,
      initiatorPositionId: w.initiator_position_id,
      pathKey: w.path_key || 'default',
      pathName: w.path_name || 'المسار الأساسي',
      description: w.description || '',
      stepOrder: w.step_order,
      stepName: w.step_name || '',
      positionId: w.required_position_id,
      positionName: w.required_position_name || '',
      isFinal: !!w.is_final_step,
      canApprove: w.can_approve === null || w.can_approve === undefined ? true : !!w.can_approve,
      canReject:  w.can_reject  === null || w.can_reject  === undefined ? true : !!w.can_reject,
      canReturn:  w.can_return_to_previous === null || w.can_return_to_previous === undefined ? true : !!w.can_return_to_previous,
      canEdit:    !!w.can_edit,
      canEditAmount: !!w.can_edit_amount,
      requireSameBranch: w.require_same_branch === null || w.require_same_branch === undefined ? true : !!w.require_same_branch,
      requireSameDepartment: !!w.require_same_department,
      assignmentStrategy: w.assignment_strategy || 'least_busy'
    })));
  } catch(e) { res.json([]); }
});

// List ALL paths for an initiator position (one row per path_key)
router.get('/position-workflow/:initiatorPositionId/paths', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT COALESCE(path_key,'default') AS path_key,
              MAX(COALESCE(path_name,'المسار الأساسي')) AS path_name,
              MAX(COALESCE(description,'')) AS description,
              COUNT(*) AS step_count
       FROM position_workflow_steps
       WHERE initiator_position_id = ?
       GROUP BY COALESCE(path_key,'default')
       ORDER BY path_key`,
      [req.params.initiatorPositionId]);
    res.json(rows.map(r => ({
      pathKey: r.path_key,
      pathName: r.path_name,
      description: r.description,
      stepCount: Number(r.step_count) || 0
    })));
  } catch(e) { res.json([]); }
});

// List all initiator positions with step counts (summary)
router.get('/position-workflows-summary', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.id, p.name, p.level,
              (SELECT COUNT(*) FROM position_workflow_steps s WHERE s.initiator_position_id = p.id) AS step_count
       FROM positions p
       WHERE p.is_active = 1 OR p.is_active IS NULL
       ORDER BY p.level ASC, p.name`);
    res.json(rows.map(r => ({
      id: r.id, name: r.name, level: Number(r.level) || 0,
      stepCount: Number(r.step_count) || 0
    })));
  } catch(e) { res.json([]); }
});

// Replace the chain for a given initiator position + pathKey (atomic).
// If pathKey is omitted, defaults to 'default' (backward compat).
// Other paths under the same initiator are NOT touched.
router.post('/position-workflow/bulk', async (req, res) => {
  try {
    const { initiatorPositionId, steps } = req.body;
    const pathKey = (req.body.pathKey || 'default').toString().trim().slice(0, 50) || 'default';
    const pathName = (req.body.pathName || 'المسار الأساسي').toString().slice(0, 200);
    const description = (req.body.description || '').toString().slice(0, 1000);

    if (!initiatorPositionId) return res.json({ success: false, error: 'المنصب البادئ مطلوب' });
    if (!Array.isArray(steps) || !steps.length) return res.json({ success: false, error: 'يجب إضافة خطوة واحدة على الأقل' });

    // Preload role names for auto-generated step names
    const roleIds = [...new Set(steps.map(s => s.positionId).filter(Boolean))];
    const roleMap = {};
    if (roleIds.length) {
      const placeholders = roleIds.map(() => '?').join(',');
      const [rn] = await db.query(`SELECT id, name FROM positions WHERE id IN (${placeholders})`, roleIds);
      rn.forEach(r => { roleMap[r.id] = r.name; });
    }

    // Auto-mark last step final if none set
    const hasFinal = steps.some(s => s.isFinal === true || s.isFinal === 1);
    if (!hasFinal) steps[steps.length - 1].isFinal = true;

    // Replace ONLY this (initiator, path) — leave other paths intact
    await db.query(
      `DELETE FROM position_workflow_steps
       WHERE initiator_position_id = ? AND COALESCE(path_key,'default') = ?`,
      [initiatorPositionId, pathKey]);

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const stepOrder = Number(s.stepOrder) || (i + 1);
      let stepName = (s.stepName || '').trim();
      if (!stepName) {
        const roleName = s.positionId ? (roleMap[s.positionId] || 'خطوة') : 'خطوة';
        stepName = roleName + ' — خطوة ' + stepOrder;
      }
      const rb = s.requireSameBranch !== false ? 1 : 0;
      const rd = s.requireSameDepartment ? 1 : 0;
      const strat = ['least_busy','first','round_robin'].includes(s.assignmentStrategy) ? s.assignmentStrategy : 'least_busy';
      const cApprove = s.canApprove !== false ? 1 : 0;
      const cReject  = s.canReject  !== false ? 1 : 0;
      const cReturn  = s.canReturn !== false ? 1 : 0;
      const cEdit    = s.canEdit ? 1 : 0;
      const cEditAmt = s.canEditAmount ? 1 : 0;
      const isFinal  = (s.isFinal === true || s.isFinal === 1) ? 1 : 0;

      const id = 'PWF-' + Date.now() + '-' + i + '-' + Math.random().toString(36).substr(2, 4);
      await db.query(
        `INSERT INTO position_workflow_steps (
           id, initiator_position_id, step_order, step_name, required_position_id,
           is_final_step, can_approve, can_reject, can_return_to_previous, can_edit, can_edit_amount,
           require_same_branch, require_same_department, assignment_strategy,
           path_key, path_name, description
         ) VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?)`,
        [id, initiatorPositionId, stepOrder, stepName, s.positionId || null,
         isFinal, cApprove, cReject, cReturn, cEdit, cEditAmt,
         rb, rd, strat,
         pathKey, pathName, description]);
    }

    res.json({ success: true, count: steps.length, initiatorPositionId, pathKey, pathName });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Delete one specific path (or all paths if pathKey is omitted)
router.delete('/position-workflow/:initiatorPositionId/path/:pathKey', async (req, res) => {
  try {
    await db.query(
      `DELETE FROM position_workflow_steps
       WHERE initiator_position_id = ? AND COALESCE(path_key,'default') = ?`,
      [req.params.initiatorPositionId, req.params.pathKey]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Delete all steps for an initiator position
router.delete('/position-workflow/:initiatorPositionId', async (req, res) => {
  try {
    await db.query('DELETE FROM position_workflow_steps WHERE initiator_position_id = ?', [req.params.initiatorPositionId]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Return the current default chain — inferred from whichever transaction type
// has workflow_definitions (they should all be identical when using the default
// builder). Falls back to an empty array if nothing defined yet.
router.get('/default-workflow', async (req, res) => {
  try {
    const [anyType] = await db.query(
      `SELECT wd.*, p.name AS position_name
       FROM workflow_definitions wd
       LEFT JOIN positions p ON wd.required_position_id = p.id
       WHERE wd.transaction_type_id IN (SELECT id FROM transaction_types ORDER BY id LIMIT 1)
       ORDER BY wd.step_order`);
    res.json(anyType.map(w => ({
      stepOrder: w.step_order, stepName: w.step_name,
      positionId: w.required_position_id, positionName: w.position_name || '',
      canEditAmount: !!w.can_edit_amount,
      canReturn: !!w.can_return_to_previous,
      canApprove: w.can_approve === null || w.can_approve === undefined ? true : !!w.can_approve,
      canReject:  w.can_reject  === null || w.can_reject  === undefined ? true : !!w.can_reject,
      canEdit:    !!w.can_edit,
      isFinal: !!w.is_final_step,
      requireSameBranch: w.require_same_branch === null || w.require_same_branch === undefined ? true : !!w.require_same_branch,
      requireSameDepartment: !!w.require_same_department,
      assignmentStrategy: w.assignment_strategy || 'least_busy'
    })));
  } catch(e) { res.json([]); }
});

// ═══════════════════════════════════════
// ORGANIZATIONAL HIERARCHY & PERMISSIONS
// ═══════════════════════════════════════

// Current user's profile, permissions, and effective workflow context
router.get('/my-profile', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    const perms = await getPermissions(username);
    res.json({ success: true, username, ...perms });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Full org tree — employees + their managers
router.get('/org-tree', async (req, res) => {
  try {
    const [emps] = await db.query(
      `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.linked_username, e.job_title,
              e.manager_id, e.workflow_level, e.branch_id, e.department_id, e.position_id,
              e.can_create_txn, e.can_approve_txn, e.can_reject_txn, e.can_return_txn, e.can_forward_txn, e.can_close_txn,
              b.name AS branch_name, b.code AS branch_code,
              d.name AS dept_name, d.code AS dept_code,
              p.name AS position_name, p.level AS position_level
       FROM hr_employees e
       LEFT JOIN branches b ON e.branch_id = b.id
       LEFT JOIN hr_departments d ON e.department_id = d.id
       LEFT JOIN positions p ON e.position_id = p.id
       WHERE e.status = 'active'
       ORDER BY p.level DESC, e.first_name`);
    res.json(emps.map(e => ({
      id: e.id, empNumber: e.employee_number,
      fullName: ((e.first_name||'') + ' ' + (e.last_name||'')).trim(),
      username: e.linked_username || '',
      jobTitle: e.job_title || '',
      managerId: e.manager_id || '',
      workflowLevel: Number(e.workflow_level) || Number(e.position_level) || 1,
      branchId: e.branch_id || '', branchName: e.branch_name || '', branchCode: e.branch_code || '',
      deptId: e.department_id || '', deptName: e.dept_name || '', deptCode: e.dept_code || '',
      positionId: e.position_id || '', positionName: e.position_name || '',
      permissions: {
        create: !!e.can_create_txn, approve: !!e.can_approve_txn, reject: !!e.can_reject_txn,
        return: !!e.can_return_txn, forward: !!e.can_forward_txn, close: !!e.can_close_txn
      }
    })));
  } catch(e) { res.json([]); }
});

// Update an employee's workflow settings (permissions / manager / level)
router.put('/org-tree/:employeeId', async (req, res) => {
  try {
    const { managerId, workflowLevel, permissions } = req.body;
    const sets = []; const params = [];
    if (managerId !== undefined) { sets.push('manager_id=?'); params.push(managerId || null); }
    if (workflowLevel !== undefined) { sets.push('workflow_level=?'); params.push(Number(workflowLevel)||1); }
    if (permissions && typeof permissions === 'object') {
      const map = { create: 'can_create_txn', approve: 'can_approve_txn', reject: 'can_reject_txn',
                    return: 'can_return_txn', forward: 'can_forward_txn', close: 'can_close_txn' };
      Object.keys(map).forEach(k => {
        if (permissions[k] !== undefined) { sets.push(map[k]+'=?'); params.push(permissions[k] ? 1 : 0); }
      });
    }
    if (!sets.length) return res.json({ success: false, error: 'لا توجد تغييرات' });
    params.push(req.params.employeeId);
    await db.query(`UPDATE hr_employees SET ${sets.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// EXPENSE CATEGORIES (نوع المصروف)
// ═══════════════════════════════════════

router.get('/expense-categories', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM expense_categories WHERE is_active = 1 OR is_active IS NULL ORDER BY name');
    res.json(rows.map(r => ({
      id: r.id, code: r.code || '', name: r.name,
      glAccountId: r.gl_account_id || '', glAccountCode: r.gl_account_code || '',
      isActive: r.is_active !== false
    })));
  } catch(e) { res.json([]); }
});

router.post('/expense-categories', async (req, res) => {
  try {
    const { id, code, name, glAccountId, glAccountCode, isActive } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query(
        'UPDATE expense_categories SET code=?, name=?, gl_account_id=?, gl_account_code=?, is_active=? WHERE id=?',
        [code||'', name, glAccountId||'', glAccountCode||'', isActive!==false?1:0, id]);
      return res.json({ success: true, id });
    }
    const newId = 'EXP-' + Date.now();
    await db.query(
      'INSERT INTO expense_categories (id, code, name, gl_account_id, gl_account_code, is_active) VALUES (?,?,?,?,?,?)',
      [newId, code||'', name, glAccountId||'', glAccountCode||'', isActive!==false?1:0]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/expense-categories/:id', async (req, res) => {
  try {
    await db.query('UPDATE expense_categories SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Recipient directory — full list for the "Recipients" table in the new-txn modal.
// Returns users + their position + dept; each row carries a code (employee_number
// or a synthesized one) and a displayable name.
router.get('/recipients-directory', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id AS user_id, u.username, u.full_name, u.role,
              p.id AS position_id, p.name AS position_name, p.level AS position_level,
              b.name AS branch_name,
              e.id AS emp_id, e.employee_number, e.first_name, e.last_name,
              e.job_title, d.name AS dept_name
       FROM users u
       LEFT JOIN positions p ON u.position_id = p.id
       LEFT JOIN branches b ON u.branch_id = b.id
       LEFT JOIN hr_employees e ON e.linked_username = u.username
       LEFT JOIN hr_departments d ON e.department_id = d.id
       WHERE u.active = 1 AND (u.position_id IS NOT NULL OR u.role = 'admin' OR e.id IS NOT NULL)
       ORDER BY p.level DESC, u.username`);
    res.json(rows.map(r => {
      const fullName = (((r.first_name||'') + ' ' + (r.last_name||'')).trim()) || r.full_name || r.username;
      const position = r.position_name || r.job_title || (r.role === 'admin' ? 'مدير النظام' : '');
      const code = r.employee_number || (r.user_id ? ('U-' + r.user_id) : '');
      return {
        userId: r.user_id, username: r.username, fullName,
        code, position, positionId: r.position_id || '',
        branchName: r.branch_name || '', deptName: r.dept_name || '',
        displayName: fullName + (position ? (' — ' + position) : '') + (r.branch_name ? (' | ' + r.branch_name) : '')
      };
    }));
  } catch(e) { res.json([]); }
});

// Eligible recipients — users with positions (higher level than sender by default)
// ═══════════════════════════════════════════════════════════════════
// /eligible-users — who CAN this sender create a transaction for?
//
// New rules (replaces the old level-based filter):
//   1. ADMIN role + EXECUTIVE positions (CEO / Owner / level >= 9) →
//      can send to EVERY active user with a position OR HR profile
//      (no restrictions). Reason: top management coordinates everyone.
//   2. Sender HAS a defined workflow chain in position_workflow_steps:
//      → eligible = users holding any position that appears in:
//        a) the sender's OWN chain (forward — manager / approver chain)
//        b) any OTHER position's chain that includes the sender's
//           position (backward — so a manager can also send to a
//           subordinate whose workflow lands on the manager).
//        + the sender themselves can NOT be a recipient.
//   3. Sender has NO chain defined → fall back to anyone above their
//      level in the same branch (legacy behavior, kept for compat).
//
// Optional ?branchOnly=1 filters to same-branch users only.
// ═══════════════════════════════════════════════════════════════════
router.get('/eligible-users', async (req, res) => {
  try {
    const senderUsername = req.query.sender || '';
    const branchOnly = req.query.branchOnly === '1';

    // Resolve sender's identity + workflow context
    let senderRole = '';
    let senderLevel = 0;
    let senderBranchId = '';
    let senderPositionId = null;
    if (senderUsername) {
      const p = await getPermissions(senderUsername);
      senderRole       = (p.role || '').toLowerCase();
      senderLevel      = Number(p.level) || 0;
      senderBranchId   = p.branchId || '';
      senderPositionId = p.positionId || null;
    }

    // Pull the candidate pool (all active employees that have a position
    // OR an HR profile OR the admin role)
    const [rows] = await db.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.branch_id, u.position_id,
              p.name AS position_name, p.level AS position_level,
              COALESCE(br.name,'') AS branch_name,
              e.id AS emp_id, e.first_name, e.last_name, e.job_title, e.workflow_level
       FROM users u
       LEFT JOIN positions p ON u.position_id = p.id
       LEFT JOIN branches br ON u.branch_id = br.id
       LEFT JOIN hr_employees e ON e.linked_username = u.username
       WHERE u.active = 1
         AND (u.position_id IS NOT NULL OR u.role = 'admin' OR e.id IS NOT NULL)
       ORDER BY p.level DESC, u.full_name`);

    // EXECUTIVE OVERRIDE: admin role or position level ≥ 9 (CEO/owner)
    // can send to everyone (except themselves)
    const isExecutive = senderRole === 'admin' || senderLevel >= 9;

    let allowedPositionIds = null;  // null = no restriction (executive)
    if (!isExecutive && senderPositionId) {
      // 1. Forward direction: positions appearing in the sender's chain
      const [forward] = await db.query(
        `SELECT DISTINCT required_position_id AS pid
         FROM position_workflow_steps
         WHERE initiator_position_id = ? AND required_position_id IS NOT NULL`,
        [senderPositionId]);

      // 2. Backward direction: positions whose chain includes the sender
      // (so the sender can reply / send back to subordinates that route to them)
      const [backward] = await db.query(
        `SELECT DISTINCT initiator_position_id AS pid
         FROM position_workflow_steps
         WHERE required_position_id = ?`,
        [senderPositionId]);

      const set = new Set();
      forward.forEach(r => r.pid && set.add(r.pid));
      backward.forEach(r => r.pid && set.add(r.pid));
      // Always include same-position colleagues (peer transactions)
      set.add(senderPositionId);

      allowedPositionIds = set.size ? set : null;
    }

    let filtered = rows.filter(r => {
      // Always allow admin role to be a recipient (top of chain)
      if (r.role === 'admin') return true;
      // Skip the sender themselves
      if (senderUsername && r.username === senderUsername) return false;

      if (isExecutive) {
        // Executive sender → no further restrictions
      } else if (allowedPositionIds) {
        // Sender HAS a chain → only positions in the allowed set
        if (!allowedPositionIds.has(r.position_id)) return false;
      } else {
        // Sender has NO chain → fall back to legacy level-based filter
        const level = Number(r.workflow_level) || Number(r.position_level) || 0;
        if (senderLevel > 0 && level <= senderLevel) return false;
      }

      // Branch filter (opt-in via ?branchOnly=1)
      if (branchOnly && senderBranchId && r.branch_id && r.branch_id !== senderBranchId) return false;
      return true;
    });

    res.json(filtered.map(r => ({
      id: r.id,
      username: r.username,
      fullName: ((r.first_name||'') + ' ' + (r.last_name||'')).trim() || r.full_name || r.username,
      role: r.role,
      positionId:   r.position_id || '',
      positionName: r.position_name || r.job_title || (r.role === 'admin' ? 'مدير النظام' : ''),
      positionLevel: Number(r.workflow_level) || Number(r.position_level) || 0,
      branchName: r.branch_name || '',
      branchId: r.branch_id || ''
    })));
  } catch(e) {
    console.error('eligible-users error:', e);
    res.json([]);
  }
});

// ═══════════════════════════════════════
// TRANSACTIONS — CORE CRUD
// ═══════════════════════════════════════

// Create new transaction
router.post('/transactions', async (req, res) => {
  try {
    const {
      transactionTypeId, title, description, amount, branchId, brandId, username, attachment,
      accountId, accountCode, accountName, costCenterId, costCenterName,
      recipientUsername, senderName, senderPosition,
      importance, deptId,
      // Enterprise fields
      subject, contentHtml, contentSecrecy, attachmentsSecrecy,
      issuingEntityId, issuingEntityName, hijriDate,
      recipients,              // [{ username?, positionId?, code?, name, needsResponse }]
      saveAsDraft,             // if true, status = 'draft' regardless of routing
      expenseCategoryId, expenseCategoryName,
      dueDate, scope
    } = req.body;

    if (!transactionTypeId || !title) return res.json({ success: false, error: 'نوع المعاملة والعنوان مطلوبان' });

    // Creation is OPEN to all departments/branches by design.
    // Any employee can initiate any transaction type — routing happens
    // downstream via workflow_definitions (role + branch/dept scoping).
    // The only gate is an explicit per-employee `can_create_txn = false`
    // flag (admin toggle on the Org Tree page).
    const sender = await getPermissions(username);
    if (sender && sender.canCreate === false) return res.json({ success: false, error: 'ليس لديك صلاحية إنشاء معاملة' });

    // Resolve codes
    const finalBranchId = branchId || sender.branchId || '';
    const finalDeptId = deptId || sender.deptId || '';

    let branchCode = '', branchName = '';
    if (finalBranchId) {
      const [br] = await db.query('SELECT name, code FROM branches WHERE id = ?', [finalBranchId]);
      if (br.length) { branchCode = sanitizeCode(br[0].code || br[0].name, 'BR'); branchName = br[0].name || ''; }
    }
    if (!branchCode) branchCode = sanitizeCode(sender.branchCode || sender.branchName, 'BR');
    if (!branchName) branchName = sender.branchName || '';

    let deptCode = '', deptName = '';
    if (finalDeptId) {
      const [dp] = await db.query('SELECT name, code FROM hr_departments WHERE id = ?', [finalDeptId]);
      if (dp.length) { deptCode = sanitizeCode(dp[0].code || dp[0].name, 'DEP'); deptName = dp[0].name || ''; }
    }
    if (!deptCode) deptCode = sanitizeCode(sender.deptCode || sender.deptName, 'DEP');
    if (!deptName) deptName = sender.deptName || '';

    // Type code
    const [tt] = await db.query('SELECT code, name FROM transaction_types WHERE id = ?', [transactionTypeId]);
    if (!tt.length) return res.json({ success: false, error: 'نوع المعاملة غير موجود' });
    const typeCode = sanitizeCode(tt[0].code, 'TXN');

    // Daily serial
    const ymd = todayYmd();
    const serial = await nextDailySerial(branchCode, deptCode, typeCode);
    // Clamp each part so the full number always fits in a VARCHAR(80) column.
    // Structured format: BR-DEP-TYP-YYYYMMDD-0001 (6 chars per code × 3 + 4 separators + 8 + 4 = 34 max)
    const _clamp = (s, n) => String(s || '').slice(0, n);
    const txnNumber = [
      _clamp(branchCode, 6), _clamp(deptCode, 6), _clamp(typeCode, 6),
      ymd, String(serial).padStart(4, '0')
    ].join('-');
    const id = 'TXN-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);

    // Resolve the workflow chain:
    //   1. PRIMARY — initiator's position has its own chain (position_workflow_steps)
    //   2. FALLBACK — legacy per-type chain (workflow_definitions)
    let firstStep = null;
    let stepSource = 'type';
    const initiatorPositionId = sender.positionId || '';
    if (initiatorPositionId) {
      const posFirst = await getInitiatorFirstStep(initiatorPositionId);
      if (posFirst) { firstStep = _normalizePositionStep(posFirst); stepSource = 'position'; }
    }
    if (!firstStep) {
      const [firstStepRows] = await db.query(
        `SELECT id, required_position_id, require_same_branch, require_same_department,
                assignment_strategy, is_final_step, step_order
         FROM workflow_definitions
         WHERE transaction_type_id = ?
         ORDER BY step_order LIMIT 1`,
        [transactionTypeId]);
      firstStep = firstStepRows.length ? firstStepRows[0] : null;
    }
    const currentStepId = firstStep ? firstStep.id : null;
    const currentRoleId = firstStep ? (firstStep.required_position_id || null) : null;

    // Determine initial assignee with a layered fallback so an explicit
    // recipient selection ALWAYS wins over the position-chain default.
    //   1. recipientUsername (top-level, explicit single pick from the modal)
    //   2. recipients[0].username (multi-recipient payload; use the first)
    //   3. recipients[0] lookup by code (employee_number) — handles UIs that
    //      sent the employee number without a resolved username
    //   4. recipients[0] lookup by full name — last-ditch
    //   5. position-chain resolution (initiator's workflow default)
    //   6. initiator's direct manager (ultimate fallback)
    let currentAssignee = (recipientUsername || '').trim();
    let currentRoleName = '';
    if (!currentAssignee && Array.isArray(recipients) && recipients.length) {
      const first = recipients[0] || {};
      if (first.username && String(first.username).trim()) {
        currentAssignee = String(first.username).trim();
      } else if (first.code) {
        // Employee number lookup
        try {
          const [u] = await db.query(
            `SELECT linked_username FROM hr_employees
             WHERE employee_number = ? AND linked_username IS NOT NULL AND linked_username != '' LIMIT 1`,
            [first.code]);
          if (u.length) currentAssignee = u[0].linked_username;
        } catch(e) {}
      }
      if (!currentAssignee && first.name) {
        // Full-name lookup against hr_employees
        try {
          const [u] = await db.query(
            `SELECT linked_username FROM hr_employees
             WHERE CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) LIKE ?
               AND linked_username IS NOT NULL AND linked_username != '' LIMIT 1`,
            ['%' + first.name + '%']);
          if (u.length) currentAssignee = u[0].linked_username;
        } catch(e) {}
      }
    }
    if (!currentAssignee && firstStep && firstStep.required_position_id) {
      const resolved = await resolveAssigneeForStep(firstStep, finalBranchId, finalDeptId);
      currentAssignee = resolved.username;
      currentRoleName = resolved.roleName;
    }
    if (!currentRoleName && currentRoleId) {
      const [rn] = await db.query('SELECT name FROM positions WHERE id = ?', [currentRoleId]);
      if (rn.length) currentRoleName = rn[0].name;
    }
    // If explicit recipient was used, stamp their current role for display
    if (currentAssignee && !currentRoleName) {
      try {
        const [pr] = await db.query(
          `SELECT p.name FROM hr_employees e
           LEFT JOIN positions p ON e.position_id = p.id
           WHERE e.linked_username = ? LIMIT 1`, [currentAssignee]);
        if (pr.length && pr[0].name) currentRoleName = pr[0].name;
      } catch(e) {}
    }
    if (!currentAssignee && sender.managerId) {
      const [mgr] = await db.query('SELECT linked_username FROM hr_employees WHERE id = ?', [sender.managerId]);
      if (mgr.length && mgr[0].linked_username) currentAssignee = mgr[0].linked_username;
    }

    const validImportance = ['critical','high','medium','low'].includes(importance) ? importance : 'medium';
    const secrecyValues = ['normal','confidential','secret','top_secret'];
    const finalContentSecrecy = secrecyValues.includes(contentSecrecy) ? contentSecrecy : 'normal';
    const finalAttSecrecy     = secrecyValues.includes(attachmentsSecrecy) ? attachmentsSecrecy : 'normal';
    const finalSubject = (subject || title || '').slice(0, 500);
    const finalIssuingEntityId   = issuingEntityId || sender.deptId || sender.branchId || '';
    const finalIssuingEntityName = issuingEntityName || sender.deptName || sender.branchName || '';
    // Draft mode overrides routing — transaction parked in creator's outbox only
    const initialStatus = saveAsDraft ? 'draft'
                        : ((currentAssignee || currentStepId) ? 'pending' : 'draft');

    await db.query(
      `INSERT INTO transactions (
         id, transaction_number, transaction_type_id, type_code, daily_serial,
         created_by, branch_id, branch_code, branch_name, brand_id,
         dept_id, dept_code, dept_name,
         title, subject, description, content_html, amount, importance,
         content_secrecy, attachments_secrecy, issuing_entity_id, issuing_entity_name, hijri_date,
         status, current_step_id, current_role_id, current_role_name, current_assignee, attachment,
         account_id, account_code, account_name, cost_center_id, cost_center_name,
         recipient_username, sender_name, sender_position, initiator_position_id)
       VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?)`,
      [id, txnNumber, transactionTypeId, typeCode, serial,
       username||'', finalBranchId||null, branchCode, branchName, brandId||null,
       finalDeptId||null, deptCode, deptName,
       title, finalSubject, description||'', contentHtml||null, amount||0, validImportance,
       finalContentSecrecy, finalAttSecrecy, finalIssuingEntityId||null, finalIssuingEntityName, hijriDate||'',
       initialStatus, currentStepId, currentRoleId, currentRoleName, currentAssignee, attachment||null,
       accountId||null, accountCode||'', accountName||'', costCenterId||null, costCenterName||'',
       recipientUsername||'', senderName||'', senderPosition||'', initiatorPositionId||null]
    );

    // Expense category + due date + scope (optional — update after main insert to
    // avoid ballooning the VALUES list and to keep this addition surgical)
    if (expenseCategoryId || dueDate || scope) {
      const sets = []; const vals = [];
      if (expenseCategoryId !== undefined) {
        sets.push('expense_category_id=?'); vals.push(expenseCategoryId || null);
        sets.push('expense_category_name=?'); vals.push(expenseCategoryName || '');
      }
      if (dueDate) { sets.push('due_date=?'); vals.push(dueDate); }
      if (scope)   { sets.push('transaction_scope=?'); vals.push(scope === 'external' ? 'external' : 'internal'); }
      if (sets.length) {
        vals.push(id);
        try { await db.query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, vals); } catch(e) {}
      }
    }

    // Multi-recipients (optional)
    if (Array.isArray(recipients) && recipients.length) {
      for (const r of recipients) {
        if (!r || (!r.username && !r.name && !r.positionId)) continue;
        const recId = 'RCP-' + Date.now() + '-' + Math.random().toString(36).substr(2,5);
        await db.query(
          `INSERT INTO txn_recipients
             (id, transaction_id, recipient_type, recipient_id, recipient_username,
              recipient_code, recipient_name, needs_response)
           VALUES (?,?,?,?,?,?,?,?)`,
          [recId, id, r.type || (r.positionId ? 'position' : 'user'),
           r.id || r.positionId || null, r.username || '',
           r.code || '', r.name || '', r.needsResponse ? 1 : 0]);
      }
    }

    // Log creation
    const logId = 'LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query(
      'INSERT INTO transaction_steps_log (id, transaction_id, workflow_definition_id, action_by, action_type, action_note, position_name) VALUES (?,?,?,?,?,?,?)',
      [logId, id, currentStepId, username||'', 'create', 'تم إنشاء المعاملة', senderPosition || sender.positionName || '']);

    res.json({ success: true, id, txnNumber, currentAssignee });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Helper — fetch transaction with joined metadata
function _txnSelectSQL() {
  return `SELECT t.*, tt.name AS type_name, tt.code AS type_code_real,
                 wd.step_name AS current_step_name,
                 p.name AS current_position_name, p.level AS current_position_level,
                 br.name AS branch_name_resolved, br.code AS branch_code_resolved,
                 d.name AS dept_name_resolved, d.code AS dept_code_resolved
          FROM transactions t
          JOIN transaction_types tt ON t.transaction_type_id = tt.id
          LEFT JOIN workflow_definitions wd ON t.current_step_id = wd.id
          LEFT JOIN positions p ON wd.required_position_id = p.id
          LEFT JOIN branches br ON t.branch_id = br.id
          LEFT JOIN hr_departments d ON t.dept_id = d.id`;
}

function _mapTxn(t) {
  return fixObj({
    id: t.id, txnNumber: t.transaction_number,
    typeId: t.transaction_type_id, typeName: t.type_name, typeCode: t.type_code || t.type_code_real,
    createdBy: t.created_by,
    branchId: t.branch_id, branchCode: t.branch_code || t.branch_code_resolved || '', branchName: t.branch_name || t.branch_name_resolved || '',
    brandId: t.brand_id,
    deptId: t.dept_id, deptCode: t.dept_code || t.dept_code_resolved || '', deptName: t.dept_name || t.dept_name_resolved || '',
    title: t.title, subject: t.subject || t.title || '', description: t.description, amount: Number(t.amount),
    importance: t.importance || 'medium',
    status: t.status,
    currentStepId: t.current_step_id, currentStepName: t.current_step_name || '',
    currentPositionName: t.current_position_name || t.current_role_name || '',
    currentRoleId: t.current_role_id || '',
    currentRoleName: t.current_role_name || t.current_position_name || '',
    currentAssignee: t.current_assignee || '',
    attachment: t.attachment ? true : false,
    accountCode: t.account_code || '', accountName: t.account_name || '',
    costCenterName: t.cost_center_name || '',
    recipientUsername: t.recipient_username || '',
    senderName: t.sender_name || '', senderPosition: t.sender_position || '',
    // V3.1: returned-for-edit metadata
    returnedAt: t.returned_at || null,
    returnedBy: t.returned_by || null,
    returnReason: t.returned_reason || null,
    returnCount: Number(t.return_count) || 0,
    isReturnedForEdit: t.status === 'returned',
    createdAt: t.created_at, updatedAt: t.updated_at
  });
}

// OUTBOX — transactions I created (صندوق الصادر) with rich filters
router.get('/outbox', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    const {
      status, typeId, importance,
      startDate, endDate,       // from/to transaction date
      txnNumber,                // رقم المعاملة
      subject,                  // الموضوع (LIKE)
      recipientUsername,        // تصدير إلى جهة
      pendingAt,                // معلقة عند (current_assignee)
      readStatus,               // 'read' | 'unread'
      overdue,                  // '1' if due_date < NOW and still open
      expenseCategoryId,
      scope                     // 'internal' | 'external'
    } = req.query;

    // V4: exclude soft-deleted rows from outbox
    let sql = _txnSelectSQL() + ' WHERE t.created_by = ? AND t.deleted_at IS NULL';
    const params = [username];
    if (status)              { sql += ' AND t.status = ?'; params.push(status); }
    if (typeId)              { sql += ' AND t.transaction_type_id = ?'; params.push(typeId); }
    if (importance)          { sql += ' AND t.importance = ?'; params.push(importance); }
    if (startDate)           { sql += ' AND DATE(t.created_at) >= ?'; params.push(startDate); }
    if (endDate)             { sql += ' AND DATE(t.created_at) <= ?'; params.push(endDate); }
    if (txnNumber)           { sql += ' AND t.transaction_number LIKE ?'; params.push('%' + txnNumber + '%'); }
    if (subject)             { sql += ' AND (t.subject LIKE ? OR t.title LIKE ?)'; params.push('%' + subject + '%', '%' + subject + '%'); }
    if (recipientUsername)   { sql += ' AND (t.recipient_username = ? OR t.id IN (SELECT transaction_id FROM txn_recipients WHERE recipient_username = ?))'; params.push(recipientUsername, recipientUsername); }
    if (pendingAt)           { sql += ' AND t.current_assignee = ?'; params.push(pendingAt); }
    if (readStatus === 'read')     { sql += ' AND t.is_read = 1'; }
    if (readStatus === 'unread')   { sql += ' AND (t.is_read = 0 OR t.is_read IS NULL)'; }
    if (overdue === '1')     { sql += " AND t.due_date IS NOT NULL AND t.due_date < CURDATE() AND t.status IN ('pending','in_progress')"; }
    if (expenseCategoryId)   { sql += ' AND t.expense_category_id = ?'; params.push(expenseCategoryId); }
    if (scope)               { sql += ' AND t.transaction_scope = ?'; params.push(scope); }
    sql += ' ORDER BY t.created_at DESC LIMIT 500';

    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => Object.assign(_mapTxn(r), {
      subject: r.subject || r.title,
      expenseCategoryId: r.expense_category_id || '',
      expenseCategoryName: r.expense_category_name || '',
      isRead: !!r.is_read,
      readAt: r.read_at,
      dueDate: r.due_date,
      scope: r.transaction_scope || 'internal',
      isOverdue: r.due_date && new Date(r.due_date) < new Date() && (r.status === 'pending' || r.status === 'in_progress')
    })));
  } catch(e) { res.json([]); }
});

// Summary stats for the outbox bottom panel
router.get('/outbox-summary', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    const [rows] = await db.query(
      `SELECT
         SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS open_out,
         SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_out,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_out,
         SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END) AS returned_out,
         COUNT(*) AS total_out
       FROM transactions WHERE created_by = ?`, [username]);
    // V3.1: incoming summary excludes own items so the count matches the visible inbox
    const [inRows] = await db.query(
      `SELECT
         SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS open_in,
         SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_in,
         COUNT(*) AS total_in
       FROM transactions WHERE (current_assignee = ? OR recipient_username = ?) AND created_by != ?`,
      [username, username, username]);
    const r = rows[0] || {}, ri = inRows[0] || {};
    res.json({
      outgoing: {
        open: Number(r.open_out)||0,
        closed: Number(r.closed_out)||0,
        rejected: Number(r.rejected_out)||0,
        returned: Number(r.returned_out)||0,
        total: Number(r.total_out)||0
      },
      incoming: { open: Number(ri.open_in)||0, closed: Number(ri.closed_in)||0, total: Number(ri.total_in)||0 }
    });
  } catch(e) { res.json({ outgoing: {}, incoming: {} }); }
});

// Mark a transaction as read (for حالة القراءة)
router.post('/transactions/:id/mark-read', async (req, res) => {
  try {
    const { username } = req.body;
    await db.query(
      `UPDATE transactions SET is_read = 1, read_by = ?, read_at = NOW() WHERE id = ? AND (is_read = 0 OR is_read IS NULL)`,
      [username || '', req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// INCOMING BOX — transactions awaiting my action (صندوق الوارد)
// V3.1: Strictly "received from others". Items I created are NEVER shown here —
// even if returned to me — they belong only in the outbox with a "مرجعة للتعديل" badge.
// V4: Also excludes soft-deleted rows + includes new lifecycle states (created, replied)
router.get('/incoming', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    if (!username) return res.json([]);
    const perms = await getPermissions(username);
    // V4: include all 8 lifecycle states that need attention (not just pending/in_progress)
    const conditions = ["(t.status IN ('pending','created','in_progress','replied'))", "t.created_by != ?", "t.deleted_at IS NULL"];
    const params = [username]; // first param for created_by exclusion
    const orParts = [];
    orParts.push('t.current_assignee = ?'); params.push(username);
    orParts.push('t.recipient_username = ?'); params.push(username);
    if (perms.positionId) {
      orParts.push('(t.current_assignee = \'\' AND EXISTS(SELECT 1 FROM workflow_definitions w WHERE w.id = t.current_step_id AND w.required_position_id = ?))');
      params.push(perms.positionId);
    }
    if (!perms.isEmployee && perms.positionName === 'مدير النظام') {
      // admin superuser — also include anything unassigned
      orParts.push("(t.current_assignee = '' AND (t.recipient_username = '' OR t.recipient_username IS NULL))");
    }
    conditions.push('(' + orParts.join(' OR ') + ')');
    const sql = _txnSelectSQL() + ' WHERE ' + conditions.join(' AND ') + ' ORDER BY FIELD(t.importance,\'critical\',\'high\',\'medium\',\'low\'), t.created_at DESC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapTxn));
  } catch(e) { res.json([]); }
});

// Kept for backward compatibility
router.get('/my-transactions', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    const sql = _txnSelectSQL() + ' WHERE t.created_by = ? ORDER BY t.created_at DESC LIMIT 100';
    const [rows] = await db.query(sql, [username]);
    res.json(rows.map(_mapTxn));
  } catch(e) { res.json([]); }
});

// DASHBOARD — importance-based card listing for management
router.get('/dashboard-cards', async (req, res) => {
  try {
    const { branchId, deptId, importance, typeId, status } = req.query;
    let sql = _txnSelectSQL() + " WHERE 1=1";
    const params = [];
    if (branchId) { sql += ' AND t.branch_id = ?'; params.push(branchId); }
    if (deptId) { sql += ' AND t.dept_id = ?'; params.push(deptId); }
    if (importance) { sql += ' AND t.importance = ?'; params.push(importance); }
    if (typeId) { sql += ' AND t.transaction_type_id = ?'; params.push(typeId); }
    if (status) {
      sql += ' AND t.status = ?'; params.push(status);
    } else {
      sql += " AND t.status IN ('pending','in_progress')";
    }
    sql += " ORDER BY FIELD(t.importance,'critical','high','medium','low'), t.created_at DESC LIMIT 300";
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapTxn));
  } catch(e) { res.json([]); }
});

// Dashboard filter metadata (branches, depts, types)
router.get('/dashboard-filters', async (req, res) => {
  try {
    const [branches] = await db.query('SELECT id, name, code FROM branches ORDER BY name');
    const [depts] = await db.query('SELECT id, name, code, branch_id FROM hr_departments WHERE is_active = 1 ORDER BY name');
    const [types] = await db.query('SELECT id, name, code FROM transaction_types ORDER BY name');
    const [summary] = await db.query(
      `SELECT importance, COUNT(*) AS cnt FROM transactions
       WHERE status IN ('pending','in_progress') GROUP BY importance`);
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    summary.forEach(r => { counts[r.importance] = r.cnt; });
    res.json({
      branches: branches.map(b => ({ id: b.id, name: b.name, code: b.code || '' })),
      departments: depts.map(d => ({ id: d.id, name: d.name, code: d.code || '', branchId: d.branch_id || '' })),
      types: types.map(t => ({ id: t.id, name: t.name, code: t.code || '' })),
      counts
    });
  } catch(e) { res.json({ branches: [], departments: [], types: [], counts: {} }); }
});

// Kept: generic list (admin-level)
router.get('/transactions', async (req, res) => {
  try {
    const { status, positionId, importance } = req.query;
    let sql = _txnSelectSQL() + ' WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    if (positionId) { sql += ' AND wd.required_position_id = ?'; params.push(positionId); }
    if (importance) { sql += ' AND t.importance = ?'; params.push(importance); }
    sql += " ORDER BY FIELD(t.importance,'critical','high','medium','low'), t.created_at DESC LIMIT 200";
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapTxn));
  } catch(e) { res.json([]); }
});

// Single transaction with full workflow path + timeline
router.get('/transactions/:id', async (req, res) => {
  try {
    const [txns] = await db.query(_txnSelectSQL() + ' WHERE t.id = ?', [req.params.id]);
    if (!txns.length) return res.json({ error: 'المعاملة غير موجودة' });
    const t = txns[0];

    // Workflow path for this transaction type
    const [steps] = await db.query(
      `SELECT wd.id, wd.step_order, wd.step_name, wd.is_final_step, p.name AS position_name
       FROM workflow_definitions wd LEFT JOIN positions p ON wd.required_position_id = p.id
       WHERE wd.transaction_type_id = ? ORDER BY wd.step_order`, [t.transaction_type_id]);

    // Timeline / log
    const [logs] = await db.query(
      `SELECT l.*, wd.step_name, p.name AS position_name_from_def FROM transaction_steps_log l
       LEFT JOIN workflow_definitions wd ON l.workflow_definition_id = wd.id
       LEFT JOIN positions p ON wd.required_position_id = p.id
       WHERE l.transaction_id = ? ORDER BY l.created_at`, [req.params.id]);

    // Multi attachments
    const [atts] = await db.query('SELECT id, file_name, mime_type, uploaded_by, uploaded_at, log_id FROM txn_attachments WHERE transaction_id = ? ORDER BY uploaded_at', [req.params.id]);

    // Recipients (multi)
    const [recipientRows] = await db.query('SELECT * FROM txn_recipients WHERE transaction_id = ? ORDER BY created_at', [req.params.id]);

    res.json({
      ..._mapTxn(t),
      description: fixMojibake(t.description),
      attachmentDataUrl: t.attachment || '',
      subject: fixMojibake(t.subject || t.title || ''),
      contentHtml: fixMojibake(t.content_html || ''),
      contentSecrecy: t.content_secrecy || 'normal',
      attachmentsSecrecy: t.attachments_secrecy || 'normal',
      issuingEntityId: t.issuing_entity_id || '',
      issuingEntityName: fixMojibake(t.issuing_entity_name || ''),
      hijriDate: t.hijri_date || '',
      // V3: CEO approval indicator
      passedCeoAt: t.passed_ceo_at || null,
      passedCeoBy: t.passed_ceo_by || null,
      recipients: recipientRows.map(r => fixObj({
        id: r.id, type: r.recipient_type, username: r.recipient_username,
        code: r.recipient_code, name: r.recipient_name,
        needsResponse: !!r.needs_response, responseReceived: !!r.response_received
      })),
      workflowPath: steps.map(s => fixObj({
        id: s.id, stepOrder: s.step_order, stepName: s.step_name,
        positionName: s.position_name || '', isFinal: !!s.is_final_step,
        isCurrent: s.id === t.current_step_id,
        isPast: t.current_step_id ? steps.findIndex(x => x.id === t.current_step_id) > steps.findIndex(x => x.id === s.id) : true
      })),
      logs: logs.map(l => fixObj({
        id: l.id, stepName: l.step_name || '',
        positionName: l.position_name || l.position_name_from_def || '',
        actionBy: l.action_by, actionType: l.action_type,
        note: l.action_note,
        attachment: l.attachment,
        createdAt: l.created_at
      })),
      attachments: atts.map(a => ({ id: a.id, fileName: a.file_name, mime: a.mime_type, uploadedBy: a.uploaded_by, uploadedAt: a.uploaded_at, logId: a.log_id }))
    });
  } catch(e) { res.json({ error: e.message }); }
});

// Edit (creator only).
// V4.4: when status='returned', creator can edit EVERY field (type, recipient,
// branch, dept, account, cost center, brand) — the whole point of returning is
// to let creator FIX the issue, including wrong type/recipient mistakes.
// For draft + pending(no others acted): only basic fields editable.
router.put('/transactions/:id', async (req, res) => {
  try {
    const {
      title, description, contentHtml, amount, importance, username, attachment,
      // V4.4: full-edit fields (only applied when status='returned' or 'draft')
      transactionTypeId, recipientUsername, branchId, deptId, brandId,
      accountId, accountCode, accountName, costCenterId, costCenterName,
      contentSecrecy, attachmentsSecrecy, hijriDate, slaHours, dueDate,
      recipients   // optional: full replacement of multi-recipients list
    } = req.body;

    const [txns] = await db.query('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txns.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    const txn = txns[0];
    if (txn.created_by !== username) return res.json({ success: false, error: 'لا يمكن التعديل — لست المنشئ' });
    // V4.4: editing allowed in: draft (always), returned (whole point), pending (only if no others acted)
    const editableStatuses = ['draft', 'pending', 'returned'];
    if (!editableStatuses.includes(txn.status)) {
      return res.json({ success: false, error: 'لا يمكن التعديل — المعاملة قيد التنفيذ أو منتهية' });
    }
    if (txn.status === 'pending') {
      const [logs] = await db.query("SELECT COUNT(*) AS cnt FROM transaction_steps_log WHERE transaction_id = ? AND action_type != 'create' AND action_by != ?", [req.params.id, username]);
      if (logs[0].cnt > 0) return res.json({ success: false, error: 'لا يمكن التعديل — تم التصرف في المعاملة من جهة أخرى' });
    }

    // V4.4: "full edit" mode is allowed for draft + returned (NOT pending — too risky)
    const fullEditAllowed = (txn.status === 'draft' || txn.status === 'returned');

    const sets = []; const params = [];
    // ─── Always-editable fields (basic) ───
    if (title !== undefined) { sets.push('title=?'); params.push(title); sets.push('subject=?'); params.push(title); }
    if (description !== undefined) { sets.push('description=?'); params.push(description); }
    if (contentHtml !== undefined) { sets.push('content_html=?'); params.push(contentHtml); }
    if (amount !== undefined) { sets.push('amount=?'); params.push(Number(amount)||0); }
    if (importance !== undefined && ['critical','high','medium','low'].includes(importance)) {
      sets.push('importance=?'); params.push(importance);
    }
    if (attachment !== undefined && typeof attachment === 'string' && attachment.startsWith('data:')) {
      sets.push('attachment=?'); params.push(attachment);
    }

    // ─── V4.4: Full-edit fields (only when draft/returned) ───
    if (fullEditAllowed) {
      if (transactionTypeId !== undefined) { sets.push('transaction_type_id=?'); params.push(transactionTypeId); }
      if (recipientUsername !== undefined) { sets.push('recipient_username=?'); params.push(recipientUsername || ''); }
      if (branchId !== undefined) { sets.push('branch_id=?'); params.push(branchId || null); }
      if (deptId !== undefined) { sets.push('dept_id=?'); params.push(deptId || null); }
      if (brandId !== undefined) { sets.push('brand_id=?'); params.push(brandId || null); }
      if (accountId !== undefined) { sets.push('account_id=?'); params.push(accountId || null); }
      if (accountCode !== undefined) { sets.push('account_code=?'); params.push(accountCode || ''); }
      if (accountName !== undefined) { sets.push('account_name=?'); params.push(accountName || ''); }
      if (costCenterId !== undefined) { sets.push('cost_center_id=?'); params.push(costCenterId || null); }
      if (costCenterName !== undefined) { sets.push('cost_center_name=?'); params.push(costCenterName || ''); }
      if (contentSecrecy !== undefined && ['normal','confidential','secret','top_secret'].includes(contentSecrecy)) {
        sets.push('content_secrecy=?'); params.push(contentSecrecy);
      }
      if (attachmentsSecrecy !== undefined && ['normal','confidential','secret','top_secret'].includes(attachmentsSecrecy)) {
        sets.push('attachments_secrecy=?'); params.push(attachmentsSecrecy);
      }
      if (hijriDate !== undefined) { sets.push('hijri_date=?'); params.push(hijriDate || ''); }
      if (slaHours !== undefined) { sets.push('sla_hours=?'); params.push(Number(slaHours) || 72); }
      if (dueDate !== undefined) { sets.push('due_date=?'); params.push(dueDate || null); }
    }

    if (!sets.length && !Array.isArray(recipients)) {
      return res.json({ success: false, error: 'لا تغييرات' });
    }

    // V4.4: bump version even on edit (for optimistic concurrency)
    if (sets.length) {
      sets.push('version=version+1');
      sets.push('updated_at=NOW()');
      params.push(req.params.id);
      await db.query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    // V4.4: Replace recipients list (full-edit only)
    if (fullEditAllowed && Array.isArray(recipients)) {
      try {
        await db.query('DELETE FROM txn_recipients WHERE transaction_id = ?', [req.params.id]);
        for (const r of recipients) {
          if (!r || (!r.username && !r.recipientUsername)) continue;
          await db.query(
            `INSERT INTO txn_recipients
              (id, transaction_id, recipient_type, recipient_username, recipient_code, recipient_name, needs_response)
             VALUES (?,?,?,?,?,?,?)`,
            ['REC-' + Date.now() + '-' + Math.random().toString(36).slice(2,4),
             req.params.id, r.type || 'user',
             r.username || r.recipientUsername || '',
             r.code || '', r.name || '',
             r.needsResponse ? 1 : 0]);
        }
      } catch(e) { console.warn('[edit] recipients replace failed:', e.message); }
    }

    // Log edit
    const editNote = txn.status === 'returned'
      ? 'تم تعديل المعاملة استجابة للإرجاع' + (fullEditAllowed ? ' (تعديل كامل)' : '')
      : 'تم تعديل بيانات المعاملة';
    await db.query(
      'INSERT INTO transaction_steps_log (id, transaction_id, action_by, action_type, action_note) VALUES (?,?,?,?,?)',
      ['LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2,4), req.params.id, username||'', 'create', editNote]);

    res.json({ success: true, status: txn.status, fullEditAllowed });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// V3.1: Resubmit a returned transaction back into the workflow.
// Status moves from 'returned' → 'pending' (or 'in_progress' if the workflow has more steps).
// The transaction goes back to the step it was returned FROM (the assignee who returned it),
// or to the first non-creator step if we can't reconstruct it.
router.post('/transactions/:id/resubmit', SCHEMA.validateBody(SCHEMA.schemas.resubmit), async (req, res) => {
  try {
    const { username, note } = req.body;
    const [txns] = await db.query('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txns.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    const txn = txns[0];
    if (txn.created_by !== username) return res.json({ success: false, error: 'لا يمكن إعادة الإرسال — لست المنشئ' });
    if (txn.status !== 'returned') return res.json({ success: false, error: 'يمكن إعادة الإرسال للمعاملات المرجعة فقط' });

    // Strategy: advance to the NEXT step from the current_step_id (the step where it was when returned)
    // For position-based workflows, look up next step matching amount
    let newStepId = txn.current_step_id;
    let newAssignee = txn.current_assignee;
    let newStatus = 'in_progress';
    let newRoleName = txn.current_role_name || '';
    let newRoleId = txn.current_role_id || null;

    // If current_step_id exists, get the actual step row so we can resolve assignee
    if (txn.current_step_id) {
      const [posRow] = await db.query('SELECT * FROM position_workflow_steps WHERE id = ?', [txn.current_step_id]);
      if (posRow.length) {
        const step = _normalizePositionStep(posRow[0]);
        if (step.required_position_id) {
          const resolved = await resolveAssigneeForStep(step, txn.branch_id, txn.dept_id);
          newAssignee = resolved.username || newAssignee;
          newRoleId = step.required_position_id;
          newRoleName = resolved.roleName || newRoleName;
        }
      } else {
        const [legacy] = await db.query('SELECT * FROM workflow_definitions WHERE id = ?', [txn.current_step_id]);
        if (legacy.length && legacy[0].required_position_id) {
          const resolved = await resolveAssigneeForStep(legacy[0], txn.branch_id, txn.dept_id);
          newAssignee = resolved.username || newAssignee;
          newRoleId = legacy[0].required_position_id;
          newRoleName = resolved.roleName || newRoleName;
        }
      }
    }

    // Transition. If no assignee resolved, status stays pending so any matching role can pick it up.
    if (!newAssignee) newStatus = 'pending';

    await db.query(
      `UPDATE transactions SET status = ?, current_step_id = ?, current_assignee = ?,
              current_role_id = ?, current_role_name = ? WHERE id = ?`,
      [newStatus, newStepId, newAssignee || '', newRoleId, newRoleName, req.params.id]);

    // Log the resubmission as a special action so the timeline shows it
    await db.query(
      'INSERT INTO transaction_steps_log (id, transaction_id, workflow_definition_id, action_by, action_type, action_note) VALUES (?,?,?,?,?,?)',
      ['LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2,4), req.params.id, txn.current_step_id, username||'', 'forward', '[إعادة إرسال بعد التعديل] ' + (note || '')]);

    res.json({ success: true, newStatus, newAssignee });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Cancel / delete — V4: now soft-delete (deleted_at) instead of hard-delete
// Only the creator can soft-delete, only before any non-create action.
// Use /transactions/:id/force for true permanent delete (developer only).
router.delete('/transactions/:id', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || (req.body && req.body.username) || '';
    const reason = (req.body && req.body.reason) || (req.query.reason) || 'cancelled by creator';
    const [txns] = await db.query('SELECT created_by, status, deleted_at FROM transactions WHERE id = ?', [req.params.id]);
    if (!txns.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    if (txns[0].deleted_at) return res.json({ success: false, error: 'المعاملة محذوفة مسبقاً' });
    if (txns[0].created_by !== username) return res.json({ success: false, error: 'لا يمكن الإلغاء — لست المنشئ' });
    const [logs] = await db.query("SELECT COUNT(*) AS cnt FROM transaction_steps_log WHERE transaction_id = ? AND action_type != 'create'", [req.params.id]);
    if (logs[0].cnt > 0) return res.json({ success: false, error: 'لا يمكن الإلغاء — بدأ التصرف في المعاملة' });
    // Soft-delete: keep the row + audit trail, just hide from queries
    await db.query(
      `UPDATE transactions SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?,
                                version = version + 1 WHERE id = ?`,
      [username, String(reason).substring(0, 500), req.params.id]);
    // Audit log
    try {
      await db.query(
        `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details)
         VALUES (?, 'soft_delete', 'transaction', ?, ?)`,
        [username, req.params.id, JSON.stringify({ reason: reason })]);
    } catch(e) {}
    res.json({ success: true, softDeleted: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// V4 — Restore a soft-deleted transaction (admin only)
router.post('/transactions/:id/restore', async (req, res) => {
  try {
    const username = (req.body && req.body.username) || (req.user && req.user.username);
    if (username !== 'admin') return res.status(403).json({ error: 'admin only' });
    await db.query(
      'UPDATE transactions SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, version = version + 1 WHERE id = ?',
      [req.params.id]);
    try {
      await db.query(
        `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details)
         VALUES (?, 'restore', 'transaction', ?, '{}')`,
        [username, req.params.id]);
    } catch(e) {}
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// V3.1.4 — DEVELOPER FORCE-DELETE
// Bypasses ALL guards (creator check, action history, status). Cascades to:
//   - transaction_steps_log
//   - transaction_replies
//   - txn_attachments (if table exists)
//   - txn_recipients (if table exists)
//   - memo_read_receipts (if table exists)
//   - payment_records (only the link via transaction_id; we don't delete payment rows blindly)
// Restricted to:
//   1. The literal `admin` username, OR
//   2. Any user whose user_meta.isDeveloper === true
// Body MUST include { confirm: 'DELETE-FOREVER', reason: '<text>' } so a stray
// click cannot trigger this. The deletion is logged to audit_logs if available.
router.delete('/transactions/:id/force', guardDeveloper, SCHEMA.validateBody(SCHEMA.schemas.forceDelete), async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || (req.body && req.body.username) || '';
    const { confirm, reason } = req.body || {};

    const txnId = req.params.id;
    const [txns] = await db.query(
      'SELECT id, transaction_number, title, subject, created_by, amount FROM transactions WHERE id = ?',
      [txnId]
    );
    if (!txns.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    const snap = txns[0];

    // Cascade delete inside a transaction so we either delete everything or nothing
    await db.withTransaction(async (conn) => {
      // 1. Delete child rows from tables we know exist
      const childTables = [
        'transaction_steps_log',
        'transaction_replies',
        'txn_attachments',
        'txn_recipients',
        'memo_read_receipts'
      ];
      for (const tbl of childTables) {
        try {
          await conn.query(`DELETE FROM ${tbl} WHERE transaction_id = ?`, [txnId]);
        } catch(e) {
          // Tolerate: table may not exist on this deploy
        }
      }
      // 2. Detach payment_records (don't delete payments; just unlink to preserve GL)
      try {
        await conn.query(
          'UPDATE payment_records SET transaction_id = NULL WHERE transaction_id = ?',
          [txnId]
        );
      } catch(e) { /* table may not exist */ }
      // 3. Delete the transaction itself
      await conn.query('DELETE FROM transactions WHERE id = ?', [txnId]);
      // 4. Log to audit_logs if present
      try {
        await conn.query(
          `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details, created_at)
           VALUES (?, 'force_delete', 'transaction', ?, ?, NOW())`,
          [username, txnId, JSON.stringify({
            txnNumber: snap.transaction_number,
            title: snap.subject || snap.title,
            createdBy: snap.created_by,
            amount: Number(snap.amount) || 0,
            reason: String(reason).trim()
          })]
        );
      } catch(e) { /* audit_logs may not exist or have a different schema */ }
    });

    res.json({
      success: true,
      deletedId: txnId,
      txnNumber: snap.transaction_number || '',
      message: 'تم الحذف النهائي للمعاملة + كل ما يرتبط بها'
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Take action on a transaction (approve / reject / return / forward / close)
// ═══════════════════════════════════════════════════════════════════
// V4 — Workflow action handler (state machine + locking + permissions)
// ═══════════════════════════════════════════════════════════════════
// All previous if/else state mutation has been replaced with:
//   1. SELECT ... FOR UPDATE (row-level lock to prevent race conditions)
//   2. Optimistic version check (rejects with 409 if version changed)
//   3. State machine transition (validates legality)
//   4. One-reply-per-stage enforcement (rejects with 409 if already acted)
//   5. Permission engine check (centralized in lib/transactionPermissions.js)
//   6. Invariant assertion (refuses to persist inconsistent state)
//   7. Atomic UPDATE inside DB transaction
// ═══════════════════════════════════════════════════════════════════
router.post('/transactions/:id/action', SCHEMA.validateBody(SCHEMA.schemas.action), async (req, res) => {
  const txnId = req.params.id;
  const { action, username, note, attachment, newAmount, forwardTo, expectedVersion } = req.body;
  if (!action) return res.status(400).json({ success: false, error: 'الإجراء مطلوب' });
  if (!username) return res.status(401).json({ success: false, error: 'مستخدم غير معروف' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Lock the row — blocks any concurrent UPDATE on this transaction
    const [txns] = await conn.query('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [txnId]);
    if (!txns.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }
    const txn = txns[0];

    // 2. Optimistic version check (if client supplied expectedVersion)
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(txn.version || 0)) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        error: 'تم تعديل المعاملة من قِبَل شخص آخر — أعد تحميل الصفحة',
        code: 'VERSION_CONFLICT',
        currentVersion: txn.version || 0
      });
    }

    // 3. Build user object for permission engine
    const senderPerms = await getPermissions(username);
    const isPrimaryAdmin = (username === 'admin');
    const user = {
      username: username,
      role: senderPerms.role || 'employee',
      isDeveloper: !!senderPerms.isDeveloper || isPrimaryAdmin,
      isAdmin: senderPerms.role === 'admin' || isPrimaryAdmin
    };

    // 4. Resolve current step (for amount-based routing + step-level limits)
    let step = null;
    if (txn.current_step_id) {
      const [posRow] = await conn.query('SELECT * FROM position_workflow_steps WHERE id = ?', [txn.current_step_id]);
      if (posRow.length) step = _normalizePositionStep(posRow[0]);
      else {
        const [legacy] = await conn.query('SELECT * FROM workflow_definitions WHERE id = ?', [txn.current_step_id]);
        if (legacy.length) step = legacy[0];
      }
    }

    // 5. Fetch action log + replies for permission engine context (one-reply-per-stage)
    const [actionLog] = await conn.query(
      'SELECT id, action_type, action_by, workflow_definition_id, created_at FROM transaction_steps_log WHERE transaction_id = ?',
      [txnId]);
    const [replies] = await conn.query(
      'SELECT id, author_username, stage_step_id, created_at FROM transaction_replies WHERE transaction_id = ?',
      [txnId]);
    const [recipients] = await conn.query(
      'SELECT recipient_username FROM txn_recipients WHERE transaction_id = ?',
      [txnId]);
    const recipientUsernames = recipients.map(r => r.recipient_username);

    // 6. Map HTTP action → permission key + state machine action
    const actionToPermMap = {
      approve: 'txn.action.approve',
      reject:  'txn.action.reject',
      return:  'txn.action.return',
      forward: 'txn.action.forward',
      close:   'txn.action.close',
      open:    'txn.action.open'
    };
    const permKey = actionToPermMap[action];
    if (!permKey) {
      await conn.rollback();
      return res.status(400).json({ success: false, error: 'إجراء غير معروف: ' + action });
    }
    const permCtx = { txn, currentStep: step, actionLog, replies, recipientUsernames };
    if (!PERMS.can(user, permKey, permCtx)) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: _explainPermissionDenied(action, user, txn, step, actionLog),
        code: 'PERMISSION_DENIED'
      });
    }

    // 7. Apply newAmount if step allows it (must happen before transition computation)
    if (newAmount !== undefined && (!step || step.can_edit_amount)) {
      await conn.query('UPDATE transactions SET amount = ? WHERE id = ?', [Number(newAmount)||0, txnId]);
      txn.amount = Number(newAmount) || 0;
    }

    // 8. Compute next-step routing
    const txnAmount = Number(txn.amount) || 0;
    const getSiblingStep = async (order) => {
      if (step && step._source === 'position' && txn.initiator_position_id) {
        let [r] = await conn.query(
          `SELECT * FROM position_workflow_steps
           WHERE initiator_position_id = ? AND step_order = ?
             AND COALESCE(amount_from, 0) <= ?
             AND (amount_to IS NULL OR amount_to >= ?)
           ORDER BY COALESCE(amount_from, 0) DESC
           LIMIT 1`,
          [txn.initiator_position_id, order, txnAmount, txnAmount]);
        if (!r.length) {
          [r] = await conn.query(
            'SELECT * FROM position_workflow_steps WHERE initiator_position_id = ? AND step_order = ?',
            [txn.initiator_position_id, order]);
        }
        return r.length ? _normalizePositionStep(r[0]) : null;
      }
      const [r] = await conn.query(
        `SELECT id, required_position_id, is_final_step, require_same_branch,
                require_same_department, assignment_strategy, step_order
         FROM workflow_definitions WHERE transaction_type_id = ? AND step_order = ?`,
        [txn.transaction_type_id, order]);
      return r.length ? r[0] : null;
    };

    let newStepId = txn.current_step_id;
    let newAssignee = txn.current_assignee;
    let newRoleId = txn.current_role_id || null;
    let newRoleName = txn.current_role_name || '';
    let nextStepHasNext = false;
    let extraUpdates = {};   // additional columns to set in the final UPDATE

    if (action === 'approve') {
      if (step) {
        const nextStep = await getSiblingStep(step.step_order + 1);
        if (nextStep) {
          newStepId = nextStep.id;
          newRoleId = nextStep.required_position_id || null;
          if (nextStep.required_position_id) {
            const resolved = await resolveAssigneeForStep(nextStep, txn.branch_id, txn.dept_id);
            newAssignee = resolved.username || '';
            newRoleName = resolved.roleName || '';
          } else { newAssignee = ''; newRoleName = ''; }
          nextStepHasNext = true;
        } else if (step.is_final_step) {
          newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
        } else {
          // Approved but no next step + not marked final → "approved" terminal state
          newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
        }
      } else {
        newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
      }
    } else if (action === 'reject') {
      newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
    } else if (action === 'return') {
      // V4: returned-state lock — current_step_id stays so resubmit knows where to go
      newAssignee = txn.created_by;
      // Save returned-to step info
      extraUpdates.returned_at = new Date();
      extraUpdates.returned_by = username;
      extraUpdates.returned_reason = String(note || '').substring(0, 500);
      extraUpdates.returned_to_step_id = txn.current_step_id;
    } else if (action === 'close') {
      newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
    } else if (action === 'forward') {
      if (!forwardTo) {
        await conn.rollback();
        return res.status(400).json({ success: false, error: 'حدد المستلم الجديد' });
      }
      newAssignee = forwardTo;
    } else if (action === 'open') {
      // Just transitions created → in_progress; no other changes
      extraUpdates.first_viewed_at = new Date();
      extraUpdates.first_viewed_by = username;
    }

    // 9. Compute next state via state machine
    const ctxForSM = { txn: { ...txn, hasNextStep: nextStepHasNext } };
    let newStatus;
    try {
      newStatus = SM.transition(txn.status, action, ctxForSM);
    } catch (e) {
      // Handle legacy 'pending' status by treating it as 'in_progress'
      if (e.code === 'INVALID_TRANSITION' && txn.status === 'pending') {
        try {
          newStatus = SM.transition(SM.STATES.IN_PROGRESS, action, ctxForSM);
        } catch (e2) {
          await conn.rollback();
          return res.status(409).json({ success: false, error: e2.message, code: e2.code });
        }
      } else {
        await conn.rollback();
        return res.status(409).json({ success: false, error: e.message, code: e.code });
      }
    }

    // 10. Build the UPDATE — including bumping version for optimistic concurrency
    const finalUpdates = Object.assign({
      status: newStatus,
      current_step_id: newStepId,
      current_assignee: newAssignee || '',
      current_role_id: newRoleId,
      current_role_name: newRoleName
    }, extraUpdates);
    // Increment return_count if returning
    if (action === 'return') {
      finalUpdates.return_count = Number(txn.return_count || 0) + 1;
    }

    // Validate invariants on the new state
    const newTxnState = Object.assign({}, txn, finalUpdates);
    try { SM.assertInvariants(newTxnState); }
    catch (e) {
      await conn.rollback();
      return res.status(500).json({ success: false, error: 'INVARIANT_VIOLATION: ' + e.message });
    }

    // 11. Apply UPDATE atomically with version bump
    const setKeys = Object.keys(finalUpdates);
    const setClause = setKeys.map(k => `${k} = ?`).join(', ');
    const setValues = setKeys.map(k => finalUpdates[k]);
    await conn.query(
      `UPDATE transactions SET ${setClause}, version = version + 1, updated_at = NOW() WHERE id = ? AND version = ?`,
      [...setValues, txnId, txn.version || 0]
    );

    // 12. Insert action log entry
    const logId = 'LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await conn.query(
      `INSERT INTO transaction_steps_log
        (id, transaction_id, workflow_definition_id, action_by, action_type, action_note, attachment, position_name, from_step_id, to_step_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [logId, txnId, txn.current_step_id, username, action, note || '', attachment || null,
       senderPerms.positionName || '', txn.current_step_id, newStepId]
    );

    // 13. Per-recipient sub-status sync (best-effort)
    try {
      const subStatus = action === 'approve' ? 'approved' :
                        action === 'reject'  ? 'rejected' :
                        action === 'return'  ? 'pending' : null;
      if (subStatus) {
        await conn.query(
          `UPDATE txn_recipients SET sub_status = ?, acted_at = NOW(), acted_action = ?
            WHERE transaction_id = ? AND recipient_username = ?`,
          [subStatus, action, txnId, username]
        );
      }
    } catch(e) { /* tolerate if column missing */ }

    // 14. CEO approval stamp (legacy — preserved)
    try {
      const senderLevel = Number(senderPerms.positionLevel || 0);
      if (action === 'approve' && (senderLevel >= 9 || senderPerms.role === 'admin')) {
        await conn.query(
          'UPDATE transactions SET passed_ceo_at = NOW(), passed_ceo_by = ? WHERE id = ? AND passed_ceo_at IS NULL',
          [username, txnId]);
      }
    } catch(e) {}

    // 15. Insert notification for the new assignee (or creator on return/reject/approve)
    try {
      let notifyUser = null;
      let notifTitle = '', notifBody = '', severity = 'info';
      if (action === 'return') {
        notifyUser = txn.created_by;
        notifTitle = 'معاملة مرجعة للتعديل';
        notifBody  = (txn.subject || txn.title || '') + ' — السبب: ' + String(note || '').substring(0, 100);
        severity = 'warning';
      } else if (action === 'reject') {
        notifyUser = txn.created_by;
        notifTitle = 'تم رفض معاملتك';
        notifBody  = (txn.subject || txn.title || '');
        severity = 'danger';
      } else if (action === 'approve' && newStatus === SM.STATES.APPROVED) {
        notifyUser = txn.created_by;
        notifTitle = 'تمت الموافقة على معاملتك';
        notifBody  = (txn.subject || txn.title || '');
        severity = 'success';
      } else if ((action === 'approve' || action === 'forward') && newAssignee) {
        notifyUser = newAssignee;
        notifTitle = 'معاملة جديدة بانتظار الإجراء';
        notifBody  = (txn.subject || txn.title || '');
        severity = 'info';
      } else if (action === 'close') {
        notifyUser = txn.created_by;
        notifTitle = 'تم إغلاق معاملتك';
        notifBody  = (txn.subject || txn.title || '');
        severity = 'success';
      }
      if (notifyUser) {
        await conn.query(
          `INSERT INTO notifications (id, username, type, title, body, link_type, link_id, severity)
           VALUES (?,?,?,?,?,?,?,?)`,
          ['NOT-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
           notifyUser, 'workflow_' + action, notifTitle, notifBody, 'transaction', txnId, severity]
        );
      }
    } catch(e) { /* notifications table may not exist on old deploy */ }

    // 16. Audit log entry
    try {
      await conn.query(
        `INSERT INTO audit_logs (user_username, action, entity_type, entity_id, details)
         VALUES (?, ?, 'transaction', ?, ?)`,
        [username, 'workflow_' + action, txnId, JSON.stringify({
          oldStatus: txn.status, newStatus, fromStep: txn.current_step_id, toStep: newStepId,
          note: note || ''
        })]);
    } catch(e) {}

    await conn.commit();
    return res.json({
      success: true,
      newStatus,
      newAssignee,
      newVersion: Number(txn.version || 0) + 1
    });
  } catch (e) {
    try { await conn.rollback(); } catch(_) {}
    console.error('[workflow action] error:', e);
    return res.status(500).json({ success: false, error: e.message, code: e.code });
  } finally {
    conn.release();
  }
});

// V4 helper: human-readable explanation for permission denials
function _explainPermissionDenied(action, user, txn, step, actionLog) {
  const isAssignee = txn.current_assignee === user.username;
  if (!isAssignee && !user.isAdmin && !user.isDeveloper) {
    return 'هذه المعاملة ليست بانتظار إجرائك';
  }
  // Check if already acted on this stage
  const alreadyActed = (actionLog || []).some(l =>
    l.action_by === user.username &&
    (l.workflow_definition_id === txn.current_step_id) &&
    ['approve','reject','return','forward'].includes(l.action_type));
  if (alreadyActed) {
    return 'لقد قمت بالرد على هذه المرحلة من قبل — رد واحد لكل مرحلة';
  }
  // Step-level
  if (step) {
    if (action === 'approve' && step.can_approve === 0) return 'هذه الخطوة لا تسمح بالموافقة';
    if (action === 'reject'  && step.can_reject  === 0) return 'هذه الخطوة لا تسمح بالرفض';
    if (action === 'return'  && step.can_return_to_previous === 0) return 'هذه الخطوة لا تسمح بالإرجاع';
  }
  // Status mismatch
  if (SM.isTerminal(txn.status)) {
    return 'المعاملة في حالة نهائية — لا يمكن تعديلها';
  }
  return 'ليس لديك صلاحية ' + action;
}

// Upload additional attachment for a transaction
router.post('/transactions/:id/attachments', async (req, res) => {
  try {
    const { username, fileName, mime, dataUrl, logId } = req.body;
    if (!dataUrl) return res.json({ success: false, error: 'المرفق مطلوب' });
    const id = 'ATT-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query(
      'INSERT INTO txn_attachments (id, transaction_id, log_id, file_name, mime_type, data_url, uploaded_by) VALUES (?,?,?,?,?,?,?)',
      [id, req.params.id, logId || null, fileName || 'file', mime || '', dataUrl, username || '']);
    res.json({ success: true, id });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/attachments/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM txn_attachments WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.json({ error: 'غير موجود' });
    res.json({ id: rows[0].id, fileName: rows[0].file_name, mime: rows[0].mime_type, dataUrl: rows[0].data_url });
  } catch(e) { res.json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════════
 * V3 — Transaction Replies (threaded comments, separate from action log)
 * Anyone who is sender, recipient, or current assignee can reply.
 * ═══════════════════════════════════════════════════════════════════ */

// GET /workflow/transactions/:id/replies
// V3.1 FIX: apply fixMojibake to every string field — replies stored before
// the utf8mb4 migration showed up as ❓❓❓ to clients. fixMojibake re-decodes
// the wrongly-stored Latin-1 bytes back into proper Arabic.
router.get('/transactions/:id/replies', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM transaction_replies WHERE transaction_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows.map(r => fixObj({
      id: r.id,
      transactionId: r.transaction_id,
      replyText: r.reply_text,
      attachment: r.attachment || null,
      attachmentName: r.attachment_name || '',
      attachmentMime: r.attachment_mime || '',
      authorUsername: r.author_username,
      authorName: r.author_name || r.author_username,
      authorRole: r.author_role || '',
      authorPosition: r.author_position || '',
      isInternal: !!r.is_internal,
      createdAt: r.created_at
    })));
  } catch(e) {
    res.json({ error: e.message, replies: [] });
  }
});

// POST /workflow/transactions/:id/replies
// V4 — Enforces "one reply per stage per actor" rule.
// V4.2 — If `andAdvance:true` AND user is current assignee → AUTO-ADVANCES workflow
//        (implements user spec: "بعد الرد يجب انتقال المعاملة للجهة التالية")
router.post('/transactions/:id/replies', SCHEMA.validateBody(SCHEMA.schemas.reply), async (req, res) => {
  try {
    const { replyText, attachment, attachmentName, attachmentMime, isInternal, username, andAdvance, forwardTo } = req.body;
    if (!replyText || !replyText.trim()) {
      return res.json({ success: false, error: 'نص الرد مطلوب' });
    }
    const author = username || (req.user && req.user.username) || 'admin';

    // V4: load txn + check one-reply-per-stage rule via the permission engine
    const [txnRows] = await db.query('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txnRows.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    const txn = txnRows[0];
    const [existingReplies] = await db.query(
      'SELECT id, author_username, stage_step_id FROM transaction_replies WHERE transaction_id = ?',
      [req.params.id]);
    const [recipientsRows] = await db.query(
      'SELECT recipient_username FROM txn_recipients WHERE transaction_id = ?', [req.params.id]);
    const recipientUsernames = recipientsRows.map(r => r.recipient_username);
    const userPerms = await getPermissions(author);
    const user = {
      username: author,
      role: userPerms.role || 'employee',
      isDeveloper: !!userPerms.isDeveloper || author === 'admin',
      isAdmin: userPerms.role === 'admin' || author === 'admin'
    };
    const canReply = PERMS.can(user, 'txn.reply', {
      txn, replies: existingReplies, recipientUsernames
    });
    if (!canReply) {
      return res.status(403).json({
        success: false,
        error: 'لا يمكنك الرد — إما ليس لديك صلاحية، أو رددت مسبقاً على هذه المرحلة',
        code: 'REPLY_DENIED'
      });
    }

    // Resolve author meta (name + role + position) for display
    let authorName = author, authorRole = '', authorPosition = '';
    try {
      const [u] = await db.query(
        `SELECT u.role, u.position_id, COALESCE(u.full_name, u.username) AS full_name, p.name AS pos_name
         FROM users u LEFT JOIN positions p ON p.id = u.position_id
         WHERE u.username = ? LIMIT 1`,
        [author]
      );
      if (u.length) {
        authorName = u[0].full_name || author;
        authorRole = u[0].role || '';
        authorPosition = u[0].pos_name || '';
      }
    } catch(e) {}

    // V4.5.3: ALWAYS store inline. S3 upload (if enabled) runs ASYNC in
    // background AFTER response sent. User never waits for S3.
    // This was the root cause of "reply hangs forever" complaints.
    const finalAttachment = attachment || null;
    let s3Warning = null;
    const id = 'REP-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
    try {
      await db.query(
        `INSERT INTO transaction_replies (id, transaction_id, reply_text, attachment, attachment_name, attachment_mime, author_username, author_name, author_role, author_position, is_internal, stage_step_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, req.params.id, replyText.trim(), finalAttachment, attachmentName || null, attachmentMime || null, author, authorName, authorRole, authorPosition, isInternal ? 1 : 0, txn.current_step_id || null]
      );
    } catch(insertErr) {
      // Fallback for older deploys where new columns don't exist yet
      await db.query(
        `INSERT INTO transaction_replies (id, transaction_id, reply_text, attachment, author_username, author_name, author_role, author_position, is_internal)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, req.params.id, replyText.trim(), attachment || null, author, authorName, authorRole, authorPosition, isInternal ? 1 : 0]
      );
    }

    // V4: also stamp transaction's updated_at + bump version + create notification for creator
    // V4.1: invalidate cached counters for both creator and current assignee
    try {
      await db.query('UPDATE transactions SET version = version + 1, updated_at = NOW() WHERE id = ?', [req.params.id]);
      try {
        await CACHE.del('counters:' + txn.created_by, 'counters:' + (txn.current_assignee || ''));
      } catch(_) {}
      // Notify creator (unless they're the one replying)
      if (txn.created_by && txn.created_by !== author) {
        await db.query(
          `INSERT INTO notifications (id, username, type, title, body, link_type, link_id, severity)
           VALUES (?,?,?,?,?,?,?,?)`,
          ['NOT-' + Date.now() + '-' + Math.random().toString(36).slice(2,4),
           txn.created_by, 'workflow_reply',
           'رد جديد على معاملتك من ' + (authorName || author),
           replyText.trim().substring(0, 200),
           'transaction', req.params.id, 'info']
        );
      }
    } catch(e) {}

    // V4.2/4.5: If user IS the current assignee AND andAdvance is true → auto-advance the workflow
    let advanceResult = null;
    let advanceError = null;   // V4.5: surface the failure to the frontend
    const isAssignee = (txn.current_assignee === author);
    const wantsAdvance = (andAdvance === true || andAdvance === 'true' || andAdvance === 1);
    if (wantsAdvance && isAssignee && ['pending','created','in_progress','replied'].includes(txn.status)) {
      try {
        const conn = await db.getConnection();
        try {
          await conn.beginTransaction();
          // Resolve next step
          let step = null;
          if (txn.current_step_id) {
            const [posRow] = await conn.query('SELECT * FROM position_workflow_steps WHERE id = ?', [txn.current_step_id]);
            if (posRow.length) step = _normalizePositionStep(posRow[0]);
            else {
              const [legacy] = await conn.query('SELECT * FROM workflow_definitions WHERE id = ?', [txn.current_step_id]);
              if (legacy.length) step = legacy[0];
            }
          }
          let newStatus = 'approved', newStepId = null, newAssignee = '', newRoleId = null, newRoleName = '';
          // V4.5: if forwardTo is explicitly provided, route to that specific user
          // (bypasses the chain-defined next step — useful for "send to specific person")
          if (forwardTo) {
            // Verify the target user exists
            const [u] = await conn.query('SELECT username, COALESCE(full_name,username) AS name, position_id FROM users WHERE username = ? LIMIT 1', [forwardTo]);
            if (!u.length) {
              await conn.rollback();
              return res.status(400).json({ success: false, error: 'المستلم المحدد غير موجود: ' + forwardTo });
            }
            newStatus = 'in_progress';
            newAssignee = u[0].username;
            newStepId = txn.current_step_id;  // keep step but with new assignee
            newRoleId = u[0].position_id || txn.current_role_id || null;
            // Look up role name if we have a position_id
            if (u[0].position_id) {
              try {
                const [p] = await conn.query('SELECT name FROM positions WHERE id = ? LIMIT 1', [u[0].position_id]);
                if (p.length) newRoleName = p[0].name;
              } catch(_) {}
            }
          } else if (step) {
            const txnAmount = Number(txn.amount) || 0;
            let nextStep = null;
            if (step._source === 'position' && txn.initiator_position_id) {
              let [r] = await conn.query(
                `SELECT * FROM position_workflow_steps WHERE initiator_position_id = ? AND step_order = ?
                 AND COALESCE(amount_from,0) <= ? AND (amount_to IS NULL OR amount_to >= ?)
                 ORDER BY COALESCE(amount_from,0) DESC LIMIT 1`,
                [txn.initiator_position_id, step.step_order + 1, txnAmount, txnAmount]);
              if (!r.length) [r] = await conn.query(
                'SELECT * FROM position_workflow_steps WHERE initiator_position_id = ? AND step_order = ? LIMIT 1',
                [txn.initiator_position_id, step.step_order + 1]);
              if (r.length) nextStep = _normalizePositionStep(r[0]);
            } else {
              const [r] = await conn.query(
                'SELECT * FROM workflow_definitions WHERE transaction_type_id = ? AND step_order = ?',
                [txn.transaction_type_id, step.step_order + 1]);
              if (r.length) nextStep = r[0];
            }
            if (nextStep) {
              newStatus = 'in_progress';
              newStepId = nextStep.id;
              newRoleId = nextStep.required_position_id || null;
              if (nextStep.required_position_id) {
                const resolved = await resolveAssigneeForStep(nextStep, txn.branch_id, txn.dept_id);
                newAssignee = resolved.username || '';
                newRoleName = resolved.roleName || '';
              }
            } else if (step.is_final_step) {
              newStatus = 'closed';
            }
          }
          await conn.query(
            `UPDATE transactions SET status=?, current_step_id=?, current_assignee=?,
                    current_role_id=?, current_role_name=?, version=version+1, updated_at=NOW()
              WHERE id=?`,
            [newStatus, newStepId, newAssignee, newRoleId, newRoleName, req.params.id]);
          // Log the action — distinguishes between auto-route and explicit forward
          const advLogType = forwardTo ? 'forward' : 'approve';
          const advLogNote = forwardTo
            ? '[رد + تحويل صريح إلى ' + forwardTo + '] ' + replyText.trim().substring(0, 180)
            : '[رد + موافقة] ' + replyText.trim().substring(0, 200);
          await conn.query(
            `INSERT INTO transaction_steps_log
              (id, transaction_id, workflow_definition_id, action_by, action_type, action_note, reply_id, from_step_id, to_step_id, position_name)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            ['LOG-' + Date.now() + '-' + Math.random().toString(36).slice(2,4),
             req.params.id, txn.current_step_id, author, advLogType,
             advLogNote, id, txn.current_step_id, newStepId, authorPosition || '']);
          // Notify next assignee or creator
          try {
            if (newAssignee && newAssignee !== author) {
              await conn.query(
                `INSERT INTO notifications (id, username, type, title, body, link_type, link_id, severity)
                 VALUES (?,?,?,?,?,?,?,?)`,
                ['NOT-' + Date.now() + '-' + Math.random().toString(36).slice(2,4),
                 newAssignee, 'workflow_advance',
                 'معاملة جديدة بانتظار إجرائك',
                 (txn.subject || txn.title || ''), 'transaction', req.params.id, 'info']);
            } else if (newStatus === 'closed' || newStatus === 'approved') {
              if (txn.created_by && txn.created_by !== author) {
                await conn.query(
                  `INSERT INTO notifications (id, username, type, title, body, link_type, link_id, severity)
                   VALUES (?,?,?,?,?,?,?,?)`,
                  ['NOT-' + Date.now() + '-' + Math.random().toString(36).slice(2,4),
                   txn.created_by, 'workflow_approved',
                   'تمت الموافقة على معاملتك',
                   (txn.subject || txn.title || ''), 'transaction', req.params.id, 'success']);
              }
            }
          } catch(_) {}
          await conn.commit();
          advanceResult = { newStatus, newAssignee, newStepId };
        } catch(advErr) {
          try { await conn.rollback(); } catch(_) {}
          advanceError = advErr.message;
          console.warn('[reply+advance] failed:', advErr.message);
        } finally {
          conn.release();
        }
      } catch(connErr) {
        advanceError = connErr.message;
        console.warn('[reply+advance conn] failed:', connErr.message);
      }
    } else if (wantsAdvance && !isAssignee) {
      advanceError = 'لا يمكن تحريك المعاملة — لست المسؤول الحالي';
    } else if (wantsAdvance) {
      advanceError = 'لا يمكن تحريك المعاملة في الحالة الحالية: ' + txn.status;
    }

    res.json({ success: true, id, authorName, authorRole, authorPosition, advanceResult, advanceError, s3Warning });

    // V4.5.3: BACKGROUND S3 upload (fire-and-forget, after response sent)
    // Reply is already in DB with inline data URL. This optimizes storage later.
    if (finalAttachment && S3.ENABLED && typeof finalAttachment === 'string' && finalAttachment.startsWith('data:')) {
      setImmediate(async () => {
        try {
          const uploaded = await S3.maybeUpload(finalAttachment, attachmentName || ('reply-' + id), attachmentMime);
          if (uploaded && uploaded !== finalAttachment && uploaded.startsWith('http')) {
            // Replace inline base64 with the S3 URL
            await db.query('UPDATE transaction_replies SET attachment = ? WHERE id = ?', [uploaded, id]);
            console.log('[s3 bg] reply ' + id + ' attachment uploaded + DB updated');
          }
        } catch (e) {
          console.warn('[s3 bg] reply ' + id + ' upload failed (inline kept):', e.message);
        }
      });
    }
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// V4 — GET /transactions/:id/permissions — what can the current user do?
// Returns a precomputed permission object the UI uses to decide which buttons to render.
// This replaces scattered if/else logic in the frontend with a single source of truth.
router.get('/transactions/:id/permissions', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    if (!username) return res.json({ permissions: {}, error: 'لا يوجد مستخدم' });
    const [rows] = await db.query('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.json({ permissions: {}, error: 'المعاملة غير موجودة' });
    const txn = rows[0];

    // Load context
    const [actionLog] = await db.query(
      'SELECT id, action_type, action_by, workflow_definition_id FROM transaction_steps_log WHERE transaction_id = ?',
      [req.params.id]);
    const [replies] = await db.query(
      'SELECT id, author_username, stage_step_id FROM transaction_replies WHERE transaction_id = ?',
      [req.params.id]);
    const [recipients] = await db.query(
      'SELECT recipient_username FROM txn_recipients WHERE transaction_id = ?', [req.params.id]);

    const senderPerms = await getPermissions(username);
    const user = {
      username,
      role: senderPerms.role || 'employee',
      isDeveloper: !!senderPerms.isDeveloper || username === 'admin',
      isAdmin: senderPerms.role === 'admin' || username === 'admin'
    };

    let currentStep = null;
    if (txn.current_step_id) {
      const [posRow] = await db.query('SELECT * FROM position_workflow_steps WHERE id = ?', [txn.current_step_id]);
      if (posRow.length) currentStep = _normalizePositionStep(posRow[0]);
      else {
        const [legacy] = await db.query('SELECT * FROM workflow_definitions WHERE id = ?', [txn.current_step_id]);
        if (legacy.length) currentStep = legacy[0];
      }
    }

    const perms = PERMS.computePermissions(user, txn, {
      currentStep,
      actionLog,
      replies,
      recipientUsernames: recipients.map(r => r.recipient_username)
    });

    res.json({
      permissions: perms,
      currentVersion: txn.version || 0,
      txnStatus: txn.status,
      isMyTurn: txn.current_assignee === username,
      isCreator: txn.created_by === username,
      iAlreadyActed: actionLog.some(l =>
        l.action_by === username &&
        l.workflow_definition_id === txn.current_step_id &&
        ['approve','reject','return','forward'].includes(l.action_type)),
      iAlreadyReplied: replies.some(r =>
        r.author_username === username && r.stage_step_id === txn.current_step_id)
    });
  } catch(e) {
    res.json({ permissions: {}, error: e.message });
  }
});

// V4.5.2 — GET /routable-users?username=X
// Returns ALL users the caller can route/reply to, properly grouped.
// Reads from BOTH `users` (system users) AND `hr_employees` (HR data),
// merges by username, so admin/finance/manager users without HR rows still appear.
router.get('/routable-users', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username);
    if (!username) return res.json({ groups: [] });

    // 1. Get ALL active users (admin + employees) — single source of truth
    // V4.6.1: column is `active` not `is_active` — use COALESCE to be tolerant
    const [allUsers] = await db.query(
      `SELECT u.username, u.role, u.full_name AS user_full_name
         FROM users u
        WHERE u.username IS NOT NULL AND u.username != ?
          AND COALESCE(u.active, 1) = 1`,
      [username]);

    if (!allUsers.length) return res.json({ groups: [], totalUsers: 0 });

    // 2. Get HR data for any of them (left join — HR is optional)
    const usernames = allUsers.map(u => u.username);
    const placeholders = usernames.map(() => '?').join(',');
    let hrMap = {};
    try {
      const [hrRows] = await db.query(
        `SELECT e.linked_username, e.id, e.manager_id, e.workflow_level, e.department_id, e.position_id,
                COALESCE(CONCAT_WS(' ', e.first_name, e.last_name), e.linked_username) AS full_name,
                e.job_title, p.name AS position_name, b.name AS branch_name, p.level AS position_level
           FROM hr_employees e
           LEFT JOIN positions p ON e.position_id = p.id
           LEFT JOIN branches b ON e.branch_id = b.id
          WHERE e.status = 'active' AND e.linked_username IN (${placeholders})`,
        usernames);
      hrRows.forEach(r => { hrMap[r.linked_username] = r; });
    } catch(_) {}

    // 3. Find caller's HR data (for relationship calculations)
    let myHr = null;
    try {
      const [me] = await db.query(
        `SELECT e.id, e.manager_id, e.workflow_level, e.department_id, e.position_id,
                p.level AS position_level
           FROM hr_employees e
           LEFT JOIN positions p ON e.position_id = p.id
          WHERE e.linked_username = ? AND e.status = 'active' LIMIT 1`,
        [username]);
      if (me.length) myHr = me[0];
    } catch(_) {}

    const myEmpId    = myHr ? myHr.id : null;
    const myMgrId    = myHr ? myHr.manager_id : null;
    const myLevel    = myHr ? (Number(myHr.workflow_level) || Number(myHr.position_level) || 1) : 1;
    const myDeptId   = myHr ? myHr.department_id : null;

    // 4. Categorize each user
    const manager = [];
    const subordinates = [];
    const peers = [];
    const higherUps = [];
    const systemAdmins = [];   // admin/manager/finance roles WITHOUT specific HR relationship
    const others = [];

    for (const u of allUsers) {
      const hr = hrMap[u.username];
      const userObj = {
        username: u.username,
        fullName: hr ? hr.full_name : (u.user_full_name || u.username),
        position: hr ? (hr.position_name || hr.job_title) : _roleLabel(u.role),
        branch:   hr ? (hr.branch_name || '') : '',
        role:     u.role || ''
      };

      // Always include system admin in its own bucket
      if (u.username === 'admin' || u.role === 'admin') {
        systemAdmins.push(Object.assign({}, userObj, { position: userObj.position || 'مدير النظام' }));
        continue;
      }

      // If user has HR data, categorize by relationship
      if (hr) {
        if (myEmpId && hr.id === myMgrId) { manager.push(userObj); continue; }
        if (myEmpId && hr.manager_id === myEmpId) { subordinates.push(userObj); continue; }
        if (myDeptId && hr.department_id === myDeptId && Number(hr.workflow_level || hr.position_level || 1) === myLevel) {
          peers.push(userObj); continue;
        }
        const theirLevel = Number(hr.workflow_level || hr.position_level || 1);
        if (theirLevel > myLevel) { higherUps.push(Object.assign({}, userObj, { level: theirLevel })); continue; }
      }

      // Special roles WITHOUT HR row → group as "system staff" (manager/finance roles)
      if (u.role && ['manager', 'finance', 'hr', 'purchasing', 'inventory'].includes(u.role)) {
        higherUps.push(Object.assign({}, userObj, { level: 99 }));
        continue;
      }

      // Otherwise: bucket as "other users"
      others.push(userObj);
    }

    // Sort higher-ups by level desc
    higherUps.sort((a, b) => (b.level || 0) - (a.level || 0));

    const groups = [];
    if (manager.length)      groups.push({ key: 'manager',     label: '👔 مديري المباشر',     icon: 'fa-user-tie',  users: manager });
    if (subordinates.length) groups.push({ key: 'subordinates',label: '👥 موظفو قسمي',        icon: 'fa-users-line', users: subordinates });
    if (peers.length)        groups.push({ key: 'peers',       label: '👬 زملاء بنفس المستوى',icon: 'fa-user-group', users: peers });
    if (higherUps.length)    groups.push({ key: 'higher',      label: '👑 الإدارة العليا',     icon: 'fa-crown',     users: higherUps });
    if (systemAdmins.length) groups.push({ key: 'admin',       label: '🛡️ الإدارة العامة',    icon: 'fa-shield',    users: systemAdmins });
    if (others.length)       groups.push({ key: 'others',      label: '🌐 مستخدمون آخرون',    icon: 'fa-users',     users: others });

    const total = groups.reduce((s, g) => s + g.users.length, 0);
    res.json({ groups, totalUsers: total });
  } catch(e) {
    console.warn('[routable-users]', e.message);
    res.json({ groups: [], error: e.message });
  }
});

function _roleLabel(role) {
  const map = {
    admin:'مدير النظام', manager:'مدير', cashier:'كاشير', custody:'عهدة',
    finance:'المالية', hr:'الموارد البشرية', purchasing:'مشتريات',
    inventory:'مخزون', employee:'موظف'
  };
  return map[role] || (role || 'مستخدم');
}

// V4 — POST /transactions/:id/open — explicit "first view" trigger
// Transitions created → in_progress when assignee opens the txn for the first time.
router.post('/transactions/:id/open', async (req, res) => {
  const txnId = req.params.id;
  const username = req.body.username || (req.user && req.user.username);
  if (!username) return res.status(401).json({ success: false, error: 'لا يوجد مستخدم' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [txnId]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }
    const txn = rows[0];
    if (txn.current_assignee !== username) {
      await conn.rollback();
      return res.json({ success: false, error: 'ليست معاملتك' });
    }
    if (txn.status !== 'created' && txn.status !== 'pending') {
      await conn.commit();   // not an error, just nothing to do
      return res.json({ success: true, alreadyOpened: true, status: txn.status });
    }
    await conn.query(
      `UPDATE transactions SET status = ?, first_viewed_at = NOW(), first_viewed_by = ?,
                                version = version + 1, updated_at = NOW()
        WHERE id = ?`,
      [SM.STATES.IN_PROGRESS, username, txnId]
    );
    await conn.commit();
    res.json({ success: true, status: SM.STATES.IN_PROGRESS });
  } catch(e) {
    try { await conn.rollback(); } catch(_) {}
    res.status(500).json({ success: false, error: e.message });
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════════════════════
 * V3 — Memo Read Receipts
 * For "تعاميم إدارية" — track who has read each memo
 * ═══════════════════════════════════════════════════════════════════ */

// POST /workflow/transactions/:id/memo-read — mark as read
router.post('/transactions/:id/memo-read', async (req, res) => {
  try {
    const username = req.body.username || (req.user && req.user.username);
    if (!username) return res.json({ success: false, error: 'username required' });
    const id = 'MRR-' + req.params.id + '-' + username;
    await db.query(
      'INSERT INTO memo_read_receipts (id, transaction_id, username) VALUES (?,?,?) ON DUPLICATE KEY UPDATE read_at = CURRENT_TIMESTAMP',
      [id, req.params.id, username]
    );
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// GET /workflow/transactions/:id/memo-readers — admin: who read it
router.get('/transactions/:id/memo-readers', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT r.username, r.read_at, COALESCE(u.full_name, u.username) AS full_name, u.role
       FROM memo_read_receipts r LEFT JOIN users u ON u.username = r.username
       WHERE r.transaction_id = ? ORDER BY r.read_at DESC`,
      [req.params.id]
    );
    res.json(rows.map(r => ({
      username: r.username, fullName: r.full_name || r.username,
      role: r.role || '', readAt: r.read_at
    })));
  } catch(e) { res.json([]); }
});

// GET /workflow/memos-inbox — list all memos (for the dedicated inbox tab)
// Memos can be any transaction_type with code in ('MEMO','MEMO_CIRCULAR')
// or category = 'administrative' (for compatibility with existing seed data).
router.get('/memos-inbox', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username);
    // Get all memo type ids — tolerate either old or new code
    const [tt] = await db.query(`
      SELECT id FROM transaction_types
       WHERE code IN ('MEMO', 'MEMO_CIRCULAR')
          OR (category = 'administrative' AND code LIKE '%MEMO%')
    `);
    if (!tt.length) return res.json([]);
    const memoTypeIds = tt.map(r => r.id);
    const placeholders = memoTypeIds.map(() => '?').join(',');
    // Get all memos + read flag for this user
    const [rows] = await db.query(`
      SELECT t.*, COALESCE(u.full_name, t.created_by) AS sender_full_name,
             (SELECT MAX(read_at) FROM memo_read_receipts r WHERE r.transaction_id = t.id AND r.username = ?) AS my_read_at
      FROM transactions t
      LEFT JOIN users u ON u.username = t.created_by
      WHERE t.transaction_type_id IN (${placeholders})
      ORDER BY t.created_at DESC
      LIMIT 200
    `, [username || ''].concat(memoTypeIds));
    res.json(rows.map(t => ({
      id: t.id, txnNumber: t.txn_number, subject: t.subject,
      contentText: t.content_text, contentHtml: t.content_html,
      importance: t.importance, status: t.status,
      createdAt: t.created_at, createdBy: t.created_by,
      senderName: t.sender_full_name || t.sender_name || t.created_by,
      senderPosition: t.sender_position || '',
      isRead: !!t.my_read_at, readAt: t.my_read_at
    })));
  } catch(e) {
    res.json({ error: e.message, memos: [] });
  }
});

// V3.1.3 — DIAGNOSTIC removed after root cause confirmed:
// • Backend handles UTF-8 correctly end-to-end (proven via Node-based POST
//   round-trip showing byte-perfect Arabic)
// • Earlier "corrupted" rows came from my own curl tests on Windows Git Bash
//   which mangles UTF-8 command-line args through CP1252
// • The user's screenshot showing ❓❓❓ was a reply written BEFORE my
//   ALTER TABLE CONVERT TO migration; the convert replaced unmappable
//   bytes with U+FFFD permanently
// All NEW replies sent from the actual web/PWA UI work correctly.

module.exports = router;
