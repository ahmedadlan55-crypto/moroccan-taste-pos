/**
 * lib/branchWarehouseValidation.js — Owner B (cashier account validation).
 *
 * Shared guard for routes/auth.js POST /users and PUT /users/:username: before
 * either handler resolves a user's branch/warehouse pairing, confirm the branch
 * (when given) actually exists and is active, and that the warehouse it resolves
 * to (explicit override, or the branch's own warehouse_id) exists and is active
 * too. Without this a form could silently create/assign a cashier pinned to a
 * deleted or deactivated branch/warehouse — the account "works" (login succeeds)
 * but every POS action that needs a warehouse (shift open, checkout deduction)
 * has nothing valid to resolve against.
 *
 * Convention: codes are short SCREAMING_SNAKE strings the frontend will map to
 * its own copy later; `error` is the Arabic string this repo already ships to
 * the client directly (see routes/auth.js's existing validation messages).
 */
'use strict';

/**
 * @param {object} db - the mysql2 pool/connection (db.query(sql, params)).
 * @param {string|null|undefined} branchId - branch id being assigned, if any.
 * @param {string|null|undefined} explicitWarehouseId - caller-supplied warehouse
 *        override (e.g. req.body.defaultWarehouseId); falls back to the branch's
 *        own warehouse_id when omitted.
 * @returns {Promise<{ok:true, warehouseId:(string|null), branch?:object} |
 *                    {ok:false, code:string, error:string}>}
 */
async function _validateBranchWarehouse(db, branchId, explicitWarehouseId) {
  if (!branchId) {
    // No branch being assigned — nothing to validate. An explicit warehouse id
    // passed without a branch is returned as-is (unvalidated), matching the
    // pre-existing behavior of the two call sites this replaces.
    return { ok: true, warehouseId: explicitWarehouseId || null };
  }

  const [branchRows] = await db.query(
    'SELECT id, is_active, warehouse_id FROM branches WHERE id = ?',
    [branchId]
  );
  if (!branchRows.length) {
    return { ok: false, code: 'BRANCH_NOT_FOUND', error: 'الفرع غير موجود' };
  }
  const branch = branchRows[0];
  if (!Number(branch.is_active)) {
    return { ok: false, code: 'BRANCH_INACTIVE', error: 'الفرع غير نشط' };
  }

  const warehouseId = explicitWarehouseId || branch.warehouse_id || null;
  if (warehouseId) {
    const [whRows] = await db.query(
      'SELECT id, is_active FROM warehouses WHERE id = ?',
      [warehouseId]
    );
    if (!whRows.length) {
      return { ok: false, code: 'WAREHOUSE_NOT_FOUND', error: 'المستودع غير موجود' };
    }
    if (!Number(whRows[0].is_active)) {
      return { ok: false, code: 'WAREHOUSE_INACTIVE', error: 'المستودع غير نشط' };
    }
  }

  return { ok: true, warehouseId, branch };
}

module.exports = _validateBranchWarehouse;
