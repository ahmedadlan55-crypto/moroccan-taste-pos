/**
 * ─── AssigneeResolverService ──────────────────────────────────────
 *
 * Decides "who should this transaction go to next?" by walking a
 * layered fallback chain. Replaces the inline 6-level resolver that
 * lived in routes/workflow.js around line 1248. The order is identical
 * — only the location moves — so behaviour for the migrated handlers
 * stays byte-identical with the legacy code path.
 *
 * Resolution order (first match wins):
 *   1. recipientUsername      (top-level explicit pick)
 *   2. recipients[0].username (multi-recipient payload)
 *   3. recipients[0].code     (employee_number lookup)
 *   4. recipients[0].name     (full-name fuzzy lookup)
 *   5. position-chain (firstStep.required_position_id) least-busy match
 *   6. initiator's direct manager
 *
 * Each resolved username may also populate the role name, used by the
 * UI to show "تم تحويلها إلى مدير الفرع".
 *
 * v6.8.0 — Phase 1
 */
'use strict';

const repos = require('../repositories');
const logger = require('../lib/logger').child({ module: 'assignee' });

/**
 * Resolve the next assignee for a transaction during creation.
 *
 * @param {object} input
 *   - recipientUsername   (string|undefined) top-level pick
 *   - recipients          (array|undefined)  multi-recipient payload
 *   - firstStep           (object|null)      first workflow step row
 *   - sender              (object)           sender's permission profile
 *   - branchId, deptId    (string|null)      scope filters for step matching
 *
 * @returns {{ username: string, roleName: string, source: string }}
 */
async function resolveForCreate(input) {
  const recipientUsername = (input.recipientUsername || '').trim();
  const recipients = Array.isArray(input.recipients) ? input.recipients : [];
  const firstStep = input.firstStep || null;
  const sender = input.sender || {};
  const branchId = input.branchId || null;
  const deptId = input.deptId || null;

  let username = '';
  let roleName = '';
  let source = '';

  // 1. Explicit top-level pick wins
  if (recipientUsername) {
    username = recipientUsername;
    source = 'recipient_username';
  }

  // 2. First recipient in multi-recipient list
  if (!username && recipients.length) {
    const first = recipients[0] || {};
    if (first.username && String(first.username).trim()) {
      username = String(first.username).trim();
      source = 'recipients[0].username';
    } else if (first.code) {
      // 3. Lookup by employee_number
      try {
        username = await repos.users.findUsernameByEmployeeCode(first.code);
        if (username) source = 'recipients[0].code';
      } catch (e) {
        logger.warn({ event: 'employee_code_lookup_failed', code: first.code, error: e.message });
      }
    }
    if (!username && first.name) {
      // 4. Lookup by full name (LIKE-fuzzy)
      try {
        username = await repos.users.findUsernameByEmployeeName(first.name);
        if (username) source = 'recipients[0].name';
      } catch (e) {
        logger.warn({ event: 'employee_name_lookup_failed', name: first.name, error: e.message });
      }
    }
  }

  // 5. Position-chain resolution
  if (!username && firstStep && firstStep.required_position_id) {
    const resolved = await resolveForStep(firstStep, branchId, deptId);
    if (resolved.username) {
      username = resolved.username;
      roleName = resolved.roleName;
      source = 'position_chain:' + resolved.matchedAt;
    }
  }

  // 6. Resolve role name even if we got the username from an earlier step
  if (!roleName && firstStep && firstStep.required_position_id) {
    roleName = await repos.workflow.getPositionName(firstStep.required_position_id);
  }
  if (username && !roleName) {
    roleName = await repos.users.getPositionNameForUser(username);
  }

  // 7. Initiator's direct manager — ultimate fallback
  if (!username && sender.managerId) {
    try {
      const mgr = await repos.users.findManagerUsername(sender.managerId);
      if (mgr) {
        username = mgr;
        source = 'manager';
      }
    } catch (e) {
      logger.warn({ event: 'manager_lookup_failed', managerId: sender.managerId, error: e.message });
    }
  }

  return { username, roleName, source };
}

/**
 * Resolve the assignee for a specific workflow step. Tries progressively
 * broader matches: exact (role+branch+dept) → role+branch → role only.
 * Falls back to the users table when no hr_employee matches.
 */
async function resolveForStep(step, branchId, deptId) {
  if (!step || !step.required_position_id) {
    return { username: '', employeeId: '', roleName: '', matchedAt: 'none' };
  }
  const roleId = step.required_position_id;
  const roleName = await repos.workflow.getPositionName(roleId);

  const strategy = step.assignment_strategy || 'least_busy';
  const needBranch = step.require_same_branch !== 0 && step.require_same_branch !== false;
  const needDept   = step.require_same_department === 1 || step.require_same_department === true;

  const attempts = [];
  if (needBranch && needDept && branchId && deptId) {
    attempts.push({ branchId, deptId, label: 'exact' });
  }
  if (needBranch && branchId) attempts.push({ branchId, deptId: null, label: 'branch' });
  attempts.push({ branchId: null, deptId: null, label: 'any' });

  for (const a of attempts) {
    const found = await repos.users.findCandidateEmployee({
      roleId,
      branchId: a.branchId,
      deptId: a.deptId,
      strategy
    });
    if (found) {
      return {
        username: found.linked_username,
        employeeId: found.emp_id,
        roleName,
        matchedAt: a.label
      };
    }
  }

  // Last-ditch: pick from users table by position
  const u = await repos.users.findCandidateUserByPosition(roleId);
  if (u) return { username: u.username, employeeId: '', roleName, matchedAt: 'user_fallback' };

  return { username: '', employeeId: '', roleName, matchedAt: 'none' };
}

module.exports = {
  resolveForCreate,
  resolveForStep
};
