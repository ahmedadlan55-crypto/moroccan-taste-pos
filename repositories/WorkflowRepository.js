/**
 * ─── WorkflowRepository ───────────────────────────────────────────
 *
 * SQL for workflow configuration tables:
 *   - workflow_definitions     (legacy: per transaction-type chain)
 *   - position_workflow_steps  (newer:  per initiator-position chain)
 *   - workflow_routes          (conditional branching — JSON blobs)
 *   - transaction_types        (catalog)
 *
 * The system maintains two parallel chain models intentionally during
 * the migration window (see plan.md). This repository exposes both via
 * separate methods so the service layer can switch models without
 * rewriting SQL.
 *
 * v6.8.0 — Phase 1
 */
'use strict';

const db = require('../db/connection');

// ─── Transaction Types ──────────────────────────────────────────────

async function findTypeById(id) {
  if (!id) return null;
  const [rows] = await db.query(
    'SELECT id, code, name FROM transaction_types WHERE id = ?',
    [id]
  );
  return rows.length ? rows[0] : null;
}

// ─── Workflow Definitions (legacy per-type chain) ───────────────────

/** First step in the workflow_definitions chain for a given transaction type. */
async function getFirstStepForType(transactionTypeId) {
  if (!transactionTypeId) return null;
  const [rows] = await db.query(
    `SELECT id, required_position_id, require_same_branch, require_same_department,
            assignment_strategy, is_final_step, step_order
     FROM workflow_definitions
     WHERE transaction_type_id = ?
     ORDER BY step_order LIMIT 1`,
    [transactionTypeId]
  );
  return rows.length ? rows[0] : null;
}

// ─── Position Workflow Steps (per-initiator chain) ──────────────────

/** First step in the initiator's position-driven chain. */
async function getInitiatorFirstStep(initiatorPositionId) {
  if (!initiatorPositionId) return null;
  const [rows] = await db.query(
    `SELECT * FROM position_workflow_steps
     WHERE initiator_position_id = ?
     ORDER BY step_order ASC LIMIT 1`,
    [initiatorPositionId]
  );
  return rows.length ? rows[0] : null;
}

/** Find a specific step in the chain by its order. */
async function getInitiatorStep(initiatorPositionId, stepOrder) {
  if (!initiatorPositionId) return null;
  const [rows] = await db.query(
    `SELECT * FROM position_workflow_steps
     WHERE initiator_position_id = ? AND step_order = ?`,
    [initiatorPositionId, stepOrder]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Normalize a position_workflow_steps row to the same shape as a
 * workflow_definitions row so downstream code can treat them uniformly.
 * Returns null for null input. Adds `_source: 'position'` for callers
 * that care which model produced the row.
 */
function normalizePositionStep(r) {
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

// ─── Position lookups (used by assignee resolution) ─────────────────

async function getPositionName(positionId) {
  if (!positionId) return '';
  const [rows] = await db.query('SELECT name FROM positions WHERE id = ?', [positionId]);
  return rows.length ? (rows[0].name || '') : '';
}

module.exports = {
  // Types
  findTypeById,
  // Definitions (legacy)
  getFirstStepForType,
  // Position chains
  getInitiatorFirstStep,
  getInitiatorStep,
  normalizePositionStep,
  // Positions
  getPositionName
};
