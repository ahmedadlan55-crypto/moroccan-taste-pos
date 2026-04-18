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
  if (emp) {
    return {
      isEmployee: true,
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
  if (!u.length) return { isEmployee: false, level: 0, canCreate: true };
  const isAdmin = u[0].role === 'admin';
  return {
    isEmployee: false,
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
    const [rows] = await db.query('SELECT * FROM transaction_types ORDER BY name');
    res.json(rows.map(t => ({ id: t.id, name: t.name, code: t.code, isActive: !!t.is_active })));
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
router.get('/position-workflow/:initiatorPositionId', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, p.name AS required_position_name
       FROM position_workflow_steps s
       LEFT JOIN positions p ON s.required_position_id = p.id
       WHERE s.initiator_position_id = ?
       ORDER BY s.step_order`, [req.params.initiatorPositionId]);
    res.json(rows.map(w => ({
      id: w.id,
      initiatorPositionId: w.initiator_position_id,
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

// Replace the entire chain for a given initiator position (atomic)
router.post('/position-workflow/bulk', async (req, res) => {
  try {
    const { initiatorPositionId, steps } = req.body;
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

    // Replace
    await db.query('DELETE FROM position_workflow_steps WHERE initiator_position_id = ?', [initiatorPositionId]);

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
           require_same_branch, require_same_department, assignment_strategy
         ) VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?)`,
        [id, initiatorPositionId, stepOrder, stepName, s.positionId || null,
         isFinal, cApprove, cReject, cReturn, cEdit, cEditAmt,
         rb, rd, strat]);
    }

    res.json({ success: true, count: steps.length, initiatorPositionId });
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

// Eligible recipients — users with positions (higher level than sender by default)
router.get('/eligible-users', async (req, res) => {
  try {
    const senderUsername = req.query.sender || '';
    const branchOnly = req.query.branchOnly === '1';
    let senderLevel = 0, senderBranchId = '';
    if (senderUsername) {
      const p = await getPermissions(senderUsername);
      senderLevel = Number(p.level) || 0;
      senderBranchId = p.branchId || '';
    }
    const [rows] = await db.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.branch_id,
              p.name AS position_name, p.level AS position_level,
              COALESCE(br.name,'') AS branch_name,
              e.id AS emp_id, e.first_name, e.last_name, e.job_title, e.workflow_level
       FROM users u
       LEFT JOIN positions p ON u.position_id = p.id
       LEFT JOIN branches br ON u.branch_id = br.id
       LEFT JOIN hr_employees e ON e.linked_username = u.username
       WHERE u.active = 1 AND (u.position_id IS NOT NULL OR u.role = 'admin' OR e.id IS NOT NULL)
       ORDER BY p.level DESC, u.full_name`);
    let filtered = rows.filter(r => {
      if (r.role === 'admin') return true;
      const level = Number(r.workflow_level) || Number(r.position_level) || 0;
      if (senderLevel > 0 && level <= senderLevel) return false;
      if (branchOnly && senderBranchId && r.branch_id && r.branch_id !== senderBranchId) return false;
      return true;
    });
    res.json(filtered.map(r => ({
      id: r.id, username: r.username,
      fullName: ((r.first_name||'') + ' ' + (r.last_name||'')).trim() || r.full_name || r.username,
      role: r.role,
      positionName: r.position_name || r.job_title || (r.role === 'admin' ? 'مدير النظام' : ''),
      positionLevel: Number(r.workflow_level) || Number(r.position_level) || 0,
      branchName: r.branch_name || '',
      branchId: r.branch_id || ''
    })));
  } catch(e) { res.json([]); }
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
      importance, deptId
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
    const txnNumber = [branchCode, deptCode, typeCode, ymd, String(serial).padStart(4,'0')].join('-');
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

    // Determine initial assignee:
    //   1. explicit recipient override (if sender picked one)
    //   2. role+branch+dept matched employee (spec §5)
    //   3. sender's direct manager (fallback)
    let currentAssignee = recipientUsername || '';
    let currentRoleName = '';
    if (!currentAssignee && firstStep && firstStep.required_position_id) {
      const resolved = await resolveAssigneeForStep(firstStep, finalBranchId, finalDeptId);
      currentAssignee = resolved.username;
      currentRoleName = resolved.roleName;
    }
    if (!currentRoleName && currentRoleId) {
      const [rn] = await db.query('SELECT name FROM positions WHERE id = ?', [currentRoleId]);
      if (rn.length) currentRoleName = rn[0].name;
    }
    if (!currentAssignee && sender.managerId) {
      const [mgr] = await db.query('SELECT linked_username FROM hr_employees WHERE id = ?', [sender.managerId]);
      if (mgr.length && mgr[0].linked_username) currentAssignee = mgr[0].linked_username;
    }

    const validImportance = ['critical','high','medium','low'].includes(importance) ? importance : 'medium';
    const initialStatus = currentAssignee || currentStepId ? 'pending' : 'draft';

    await db.query(
      `INSERT INTO transactions (
         id, transaction_number, transaction_type_id, type_code, daily_serial,
         created_by, branch_id, branch_code, branch_name, brand_id,
         dept_id, dept_code, dept_name,
         title, description, amount, importance, status,
         current_step_id, current_role_id, current_role_name, current_assignee, attachment,
         account_id, account_code, account_name, cost_center_id, cost_center_name,
         recipient_username, sender_name, sender_position, initiator_position_id)
       VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?)`,
      [id, txnNumber, transactionTypeId, typeCode, serial,
       username||'', finalBranchId||null, branchCode, branchName, brandId||null,
       finalDeptId||null, deptCode, deptName,
       title, description||'', amount||0, validImportance, initialStatus,
       currentStepId, currentRoleId, currentRoleName, currentAssignee, attachment||null,
       accountId||null, accountCode||'', accountName||'', costCenterId||null, costCenterName||'',
       recipientUsername||'', senderName||'', senderPosition||'', initiatorPositionId||null]
    );

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
  return {
    id: t.id, txnNumber: t.transaction_number,
    typeId: t.transaction_type_id, typeName: t.type_name, typeCode: t.type_code || t.type_code_real,
    createdBy: t.created_by,
    branchId: t.branch_id, branchCode: t.branch_code || t.branch_code_resolved || '', branchName: t.branch_name || t.branch_name_resolved || '',
    brandId: t.brand_id,
    deptId: t.dept_id, deptCode: t.dept_code || t.dept_code_resolved || '', deptName: t.dept_name || t.dept_name_resolved || '',
    title: t.title, description: t.description, amount: Number(t.amount),
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
    createdAt: t.created_at, updatedAt: t.updated_at
  };
}

// OUTBOX — transactions I created (صندوق الصادر)
router.get('/outbox', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    const status = req.query.status || '';
    let sql = _txnSelectSQL() + ' WHERE t.created_by = ?';
    const params = [username];
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    sql += ' ORDER BY t.created_at DESC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(_mapTxn));
  } catch(e) { res.json([]); }
});

// INCOMING BOX — transactions awaiting my action (صندوق الوارد)
router.get('/incoming', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    if (!username) return res.json([]);
    const perms = await getPermissions(username);
    // Match rules:
    //   (A) directly assigned: current_assignee = username OR recipient_username = username
    //   (B) matches current step's required position AND status pending/in_progress
    //   (C) admins see all pending/in_progress (if they also have canApprove)
    const conditions = ["(t.status IN ('pending','in_progress'))"];
    const params = [];
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

    res.json({
      ..._mapTxn(t),
      description: t.description,
      attachmentDataUrl: t.attachment || '',
      workflowPath: steps.map(s => ({
        id: s.id, stepOrder: s.step_order, stepName: s.step_name,
        positionName: s.position_name || '', isFinal: !!s.is_final_step,
        isCurrent: s.id === t.current_step_id,
        isPast: t.current_step_id ? steps.findIndex(x => x.id === t.current_step_id) > steps.findIndex(x => x.id === s.id) : true
      })),
      logs: logs.map(l => ({
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

// Edit (only by creator, only if still in their control: no outside actions yet)
router.put('/transactions/:id', async (req, res) => {
  try {
    const { title, description, amount, importance, username } = req.body;
    const [txns] = await db.query('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txns.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    const txn = txns[0];
    if (txn.created_by !== username) return res.json({ success: false, error: 'لا يمكن التعديل — لست المنشئ' });
    // Allow only if no actions besides creation yet
    const [logs] = await db.query("SELECT COUNT(*) AS cnt FROM transaction_steps_log WHERE transaction_id = ? AND action_type != 'create'", [req.params.id]);
    if (logs[0].cnt > 0) return res.json({ success: false, error: 'لا يمكن التعديل — تم التصرف في المعاملة' });

    const sets = []; const params = [];
    if (title !== undefined) { sets.push('title=?'); params.push(title); }
    if (description !== undefined) { sets.push('description=?'); params.push(description); }
    if (amount !== undefined) { sets.push('amount=?'); params.push(Number(amount)||0); }
    if (importance !== undefined && ['critical','high','medium','low'].includes(importance)) {
      sets.push('importance=?'); params.push(importance);
    }
    if (!sets.length) return res.json({ success: false, error: 'لا تغييرات' });
    params.push(req.params.id);
    await db.query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, params);

    // Log edit
    await db.query(
      'INSERT INTO transaction_steps_log (id, transaction_id, action_by, action_type, action_note) VALUES (?,?,?,?,?)',
      ['LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2,4), req.params.id, username||'', 'create', 'تم تعديل بيانات المعاملة']);

    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Cancel / delete (only by creator, only before any action)
router.delete('/transactions/:id', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    const [txns] = await db.query('SELECT created_by, status FROM transactions WHERE id = ?', [req.params.id]);
    if (!txns.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    if (txns[0].created_by !== username) return res.json({ success: false, error: 'لا يمكن الإلغاء — لست المنشئ' });
    const [logs] = await db.query("SELECT COUNT(*) AS cnt FROM transaction_steps_log WHERE transaction_id = ? AND action_type != 'create'", [req.params.id]);
    if (logs[0].cnt > 0) return res.json({ success: false, error: 'لا يمكن الإلغاء — بدأ التصرف في المعاملة' });
    await db.query('DELETE FROM transactions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Take action on a transaction (approve / reject / return / forward / close)
router.post('/transactions/:id/action', async (req, res) => {
  try {
    const { action, username, note, attachment, newAmount, forwardTo } = req.body;
    if (!action) return res.json({ success: false, error: 'الإجراء مطلوب' });

    const [txns] = await db.query('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txns.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    const txn = txns[0];

    // Permission check (two layers: employee-wide + step-specific)
    const perms = await getPermissions(username);
    const permMap = { approve: 'canApprove', reject: 'canReject', return: 'canReturn', forward: 'canForward', close: 'canClose' };
    if (permMap[action] && perms.isEmployee && perms[permMap[action]] === false) {
      return res.json({ success: false, error: 'ليس لديك صلاحية ' + action });
    }

    // Get current workflow step — check position chain first, fall back to legacy type chain
    let step = null;
    if (txn.current_step_id) {
      // Check position_workflow_steps first
      const [posRow] = await db.query('SELECT * FROM position_workflow_steps WHERE id = ?', [txn.current_step_id]);
      if (posRow.length) {
        step = _normalizePositionStep(posRow[0]);
      } else {
        const [legacy] = await db.query('SELECT * FROM workflow_definitions WHERE id = ?', [txn.current_step_id]);
        if (legacy.length) step = legacy[0];
      }
    }

    // Step-level permission: the step definition may restrict specific actions
    if (step) {
      if (action === 'approve' && step.can_approve === 0) return res.json({ success: false, error: 'هذه الخطوة لا تسمح بالموافقة' });
      if (action === 'reject'  && step.can_reject  === 0) return res.json({ success: false, error: 'هذه الخطوة لا تسمح بالرفض' });
      if (action === 'return'  && step.can_return_to_previous === 0) return res.json({ success: false, error: 'هذه الخطوة لا تسمح بالإرجاع' });
    }

    if (newAmount !== undefined && (!step || step.can_edit_amount)) {
      await db.query('UPDATE transactions SET amount = ? WHERE id = ?', [Number(newAmount)||0, req.params.id]);
    }

    let newStatus = txn.status;
    let newStepId = txn.current_step_id;
    let newAssignee = txn.current_assignee;
    let newRoleId = txn.current_role_id || null;
    let newRoleName = txn.current_role_name || '';

    const applyStep = async (stepRow) => {
      newStepId = stepRow.id;
      newRoleId = stepRow.required_position_id || null;
      if (stepRow.required_position_id) {
        const resolved = await resolveAssigneeForStep(stepRow, txn.branch_id, txn.dept_id);
        newAssignee = resolved.username;
        newRoleName = resolved.roleName || '';
      } else {
        newAssignee = '';
        newRoleName = '';
      }
    };

    // Helper: look up the next/prev step respecting the chain source
    //   - if current step came from position_workflow_steps → use that table
    //   - else fall back to workflow_definitions (legacy per-type)
    const getSiblingStep = async (order) => {
      if (step && step._source === 'position' && txn.initiator_position_id) {
        const [r] = await db.query(
          'SELECT * FROM position_workflow_steps WHERE initiator_position_id = ? AND step_order = ?',
          [txn.initiator_position_id, order]);
        return r.length ? _normalizePositionStep(r[0]) : null;
      }
      const [r] = await db.query(
        `SELECT id, required_position_id, is_final_step, require_same_branch,
                require_same_department, assignment_strategy, step_order
         FROM workflow_definitions
         WHERE transaction_type_id = ? AND step_order = ?`,
        [txn.transaction_type_id, order]);
      return r.length ? r[0] : null;
    };

    if (action === 'approve') {
      if (step) {
        const nextStep = await getSiblingStep(step.step_order + 1);
        if (nextStep) {
          newStatus = 'in_progress';
          await applyStep(nextStep);
        } else if (step.is_final_step) {
          newStatus = 'closed'; newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
        } else {
          newStatus = 'approved'; newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
        }
      } else {
        newStatus = 'approved'; newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
      }
    } else if (action === 'reject') {
      newStatus = 'rejected';
      newAssignee = txn.created_by;
      newRoleId = null; newRoleName = '';
    } else if (action === 'return') {
      if (step) {
        const prevStep = await getSiblingStep(step.step_order - 1);
        if (prevStep) {
          await applyStep(prevStep);
          if (!newAssignee) newAssignee = txn.created_by;
        } else {
          newAssignee = txn.created_by;
          newRoleId = null; newRoleName = '';
        }
      } else {
        newAssignee = txn.created_by;
      }
      newStatus = 'pending';
    } else if (action === 'close') {
      newStatus = 'closed'; newStepId = null; newAssignee = ''; newRoleId = null; newRoleName = '';
    } else if (action === 'forward') {
      if (!forwardTo) return res.json({ success: false, error: 'حدد المستلم الجديد' });
      newAssignee = forwardTo;
      newStatus = 'in_progress';
      // Role doesn't change on forward — keep current_role_id/name
    }

    await db.query(
      `UPDATE transactions SET status = ?, current_step_id = ?, current_assignee = ?,
              current_role_id = ?, current_role_name = ? WHERE id = ?`,
      [newStatus, newStepId, newAssignee || '', newRoleId, newRoleName, req.params.id]);

    const logId = 'LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query(
      'INSERT INTO transaction_steps_log (id, transaction_id, workflow_definition_id, action_by, action_type, action_note, attachment, position_name) VALUES (?,?,?,?,?,?,?,?)',
      [logId, req.params.id, txn.current_step_id, username||'', action, note||'', attachment||null, perms.positionName || '']);

    res.json({ success: true, newStatus, newAssignee });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

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

module.exports = router;
