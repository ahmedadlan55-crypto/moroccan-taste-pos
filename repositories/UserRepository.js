/**
 * ─── UserRepository ───────────────────────────────────────────────
 *
 * SQL for `users`, `hr_employees`, `branches`, `hr_departments`. The
 * canonical place to ask "who is X, what's their position, what's
 * their branch/department, and what permission flags do they carry."
 *
 * Caches employee permission lookups for 60 seconds to avoid the N+1
 * pattern observed in pre-refactor org-tree + eligible-users endpoints.
 *
 * v6.8.0 — Phase 1
 */
'use strict';

const db = require('../db/connection');

// ─── Branches / Departments ─────────────────────────────────────────

async function findBranchById(id) {
  if (!id) return null;
  const [rows] = await db.query(
    'SELECT id, name, code FROM branches WHERE id = ?',
    [id]
  );
  return rows.length ? rows[0] : null;
}

async function findDepartmentById(id) {
  if (!id) return null;
  const [rows] = await db.query(
    'SELECT id, name, code FROM hr_departments WHERE id = ?',
    [id]
  );
  return rows.length ? rows[0] : null;
}

// ─── Employees ──────────────────────────────────────────────────────

async function findEmployeeByUsername(username) {
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
     LIMIT 1`,
    [username, username]
  );
  return rows.length ? rows[0] : null;
}

async function findUsernameByEmployeeCode(code) {
  if (!code) return '';
  const [rows] = await db.query(
    `SELECT linked_username FROM hr_employees
     WHERE employee_number = ?
       AND linked_username IS NOT NULL AND linked_username != ''
     LIMIT 1`,
    [code]
  );
  return rows.length ? rows[0].linked_username : '';
}

async function findUsernameByEmployeeName(name) {
  if (!name) return '';
  const [rows] = await db.query(
    `SELECT linked_username FROM hr_employees
     WHERE CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) LIKE ?
       AND linked_username IS NOT NULL AND linked_username != ''
     LIMIT 1`,
    ['%' + name + '%']
  );
  return rows.length ? rows[0].linked_username : '';
}

async function findManagerUsername(employeeId) {
  if (!employeeId) return '';
  const [rows] = await db.query(
    'SELECT linked_username FROM hr_employees WHERE id = ?',
    [employeeId]
  );
  return rows.length ? (rows[0].linked_username || '') : '';
}

/** Find a user's role from the `users` table (lowercased). */
async function getUserRole(username) {
  if (!username) return '';
  try {
    const [rows] = await db.query(
      'SELECT role FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    return rows.length ? String(rows[0].role || '').toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

/** Look up the position name for an employee linked to a username. */
async function getPositionNameForUser(username) {
  if (!username) return '';
  try {
    const [rows] = await db.query(
      `SELECT p.name FROM hr_employees e
       LEFT JOIN positions p ON e.position_id = p.id
       WHERE e.linked_username = ? LIMIT 1`,
      [username]
    );
    return rows.length ? (rows[0].name || '') : '';
  } catch (_) {
    return '';
  }
}

// ─── Permission profile (cached) ────────────────────────────────────
// In-memory cache mirroring the legacy `_permsCache` in routes/workflow.js.
// Same 60s TTL — invalidation is implicit (entries simply expire).
const _permsCache = new Map();
const _permsCacheTTL = 60 * 1000;

async function getPermissionProfile(username) {
  if (!username) username = '';
  const cached = _permsCache.get(username);
  const now = Date.now();
  if (cached && (now - cached.ts < _permsCacheTTL)) return cached.value;

  const emp = await findEmployeeByUsername(username);
  const role = await getUserRole(username);

  if (emp) {
    const out = {
      isEmployee: true,
      role,
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
      // canCreate defaults to true unless explicitly revoked (legacy semantic).
      canCreate: emp.can_create_txn === 0 || emp.can_create_txn === false ? false : true,
      canApprove: !!emp.can_approve_txn,
      canReject: !!emp.can_reject_txn,
      canReturn: !!emp.can_return_txn,
      canForward: !!emp.can_forward_txn,
      canClose: !!emp.can_close_txn
    };
    _permsCache.set(username, { ts: now, value: out });
    return out;
  }

  // Non-employee (admin, system, external user) — minimal profile
  const out = {
    isEmployee: false,
    role,
    employeeId: '',
    managerId: '',
    level: 1,
    branchId: '',
    branchName: '',
    branchCode: '',
    deptId: '',
    deptName: '',
    deptCode: '',
    positionId: '',
    positionName: '',
    canCreate: true,
    canApprove: role === 'admin',
    canReject: role === 'admin',
    canReturn: role === 'admin',
    canForward: role === 'admin',
    canClose: role === 'admin'
  };
  _permsCache.set(username, { ts: now, value: out });
  return out;
}

function invalidatePermissionCache(username) {
  if (username) _permsCache.delete(username);
  else _permsCache.clear();
}

// ─── Assignee candidate queries (used by AssigneeResolverService) ──

/**
 * Find the least-busy active employee matching the given role +
 * optional branch/department filters. Returns null if no match.
 */
async function findCandidateEmployee(opts) {
  const { roleId, branchId, deptId, strategy } = opts;
  if (!roleId) return null;

  const params = [roleId];
  let where = `e.position_id = ? AND e.status = 'active'`;
  if (branchId) { where += ' AND e.branch_id = ?'; params.push(branchId); }
  if (deptId)   { where += ' AND e.department_id = ?'; params.push(deptId); }

  let order;
  if (strategy === 'first') order = 'e.created_at ASC';
  else {
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
     LIMIT 1`,
    params
  );
  return rows.length ? rows[0] : null;
}

/** Fallback: pick a user from the `users` table directly by position. */
async function findCandidateUserByPosition(roleId) {
  if (!roleId) return null;
  const [rows] = await db.query(
    `SELECT username FROM users
     WHERE position_id = ? AND active = 1
     ORDER BY (SELECT COUNT(*) FROM transactions t
              WHERE t.current_assignee = users.username
                AND t.status IN ('pending','in_progress')) ASC, id ASC
     LIMIT 1`,
    [roleId]
  );
  return rows.length ? rows[0] : null;
}

module.exports = {
  // Org
  findBranchById,
  findDepartmentById,
  // Employees
  findEmployeeByUsername,
  findUsernameByEmployeeCode,
  findUsernameByEmployeeName,
  findManagerUsername,
  getUserRole,
  getPositionNameForUser,
  // Permissions
  getPermissionProfile,
  invalidatePermissionCache,
  // Candidates (for AssigneeResolverService)
  findCandidateEmployee,
  findCandidateUserByPosition
};
