/**
 * routes/cashier-readiness.js — Owner B: read-only diagnostics for which
 * role='cashier' accounts are actually usable at a POS terminal.
 *
 * A cashier account can exist and even log in while still being unusable at
 * the register: no branch assigned, a branch/warehouse that's been
 * deactivated since, or missing one of the two capabilities routes/shifts.js
 * and routes/sales.js gate on (pos.use to open a shift / checkout,
 * pos.shift_close to close one). This endpoint surfaces exactly that so an
 * admin/manager can spot a broken cashier BEFORE they're standing at the
 * register during a shift.
 *
 * NOT mounted in server.js by this change — another stage wires the mount.
 * Intended mount path: GET /api/cashier-readiness
 *   Deliberately NOT anything starting with '/menu' — the global auth gate
 *   in server.js has a naive prefix-match bug on that exact string that would
 *   make a route mounted there PUBLIC (no token required).
 *
 * Pure read — no writes anywhere in this file.
 */
'use strict';

const router = require('express').Router();
const db = require('../db/connection');
const verifyToken = require('./authMiddleware');
const { requireRole } = require('./authMiddleware');
const { hasCapability } = require('../middleware/requireCapability');

// The two POS capabilities a working cashier must hold (see routes/shifts.js
// POST /open + POST /close /close-v3, and routes/sales.js POST / checkout).
const REQUIRED_CAPS = ['pos.use', 'pos.shift_close'];

router.get('/', verifyToken, requireRole('admin', 'manager'), async (req, res) => {
  try {
    // full_name was added via migration — tolerate an older schema that
    // doesn't have it yet (same detection pattern as GET /auth/users).
    let hasFullName = true;
    try {
      const [c] = await db.query("SHOW COLUMNS FROM users LIKE 'full_name'");
      hasFullName = !!c.length;
    } catch (e) { hasFullName = false; }
    const nameCol = hasFullName ? 'u.full_name' : "'' AS full_name";

    const [rows] = await db.query(
      `SELECT u.username, ${nameCol} AS full_name, u.active,
              u.branch_id, u.default_warehouse_id,
              br.name AS branch_name, br.is_active AS branch_active,
              wh.name AS warehouse_name, wh.is_active AS warehouse_active
         FROM users u
         LEFT JOIN branches br ON br.id = u.branch_id
         LEFT JOIN warehouses wh ON wh.id = u.default_warehouse_id
        WHERE u.role = 'cashier'
        ORDER BY u.username`
    );

    const out = [];
    for (const u of rows) {
      const reasons = [];

      if (!Number(u.active)) reasons.push('ACCOUNT_INACTIVE');

      if (!u.branch_id) {
        reasons.push('NO_BRANCH');
      } else if (!Number(u.branch_active)) {
        // Also covers an orphaned branch_id (LEFT JOIN found no row —
        // branch_active comes back NULL, which Number() turns into 0).
        reasons.push('BRANCH_INACTIVE');
      }

      if (!u.default_warehouse_id) {
        reasons.push('NO_WAREHOUSE');
      } else if (!Number(u.warehouse_active)) {
        reasons.push('WAREHOUSE_INACTIVE');
      }

      for (const capId of REQUIRED_CAPS) {
        const ok = await hasCapability({ username: u.username, role: 'cashier' }, capId);
        if (!ok) reasons.push('MISSING_CAP:' + capId);
      }

      // repairAction is a single hint (not a list) — priority order below
      // picks the most fundamental fix first: you can't usefully reassign a
      // warehouse before there's a branch, and a capability grant doesn't
      // help someone who can't reach an active branch/warehouse yet.
      let repairAction = null;
      if (reasons.indexOf('NO_BRANCH') !== -1) {
        repairAction = 'ASSIGN_BRANCH';
      } else if (
        reasons.indexOf('BRANCH_INACTIVE') !== -1 ||
        reasons.indexOf('NO_WAREHOUSE') !== -1 ||
        reasons.indexOf('WAREHOUSE_INACTIVE') !== -1
      ) {
        repairAction = 'REASSIGN_BRANCH';
      } else if (reasons.some((r) => r.indexOf('MISSING_CAP:') === 0)) {
        repairAction = 'GRANT_CAPABILITY';
      }
      // ACCOUNT_INACTIVE alone (no branch/warehouse/capability issue) has no
      // dedicated repairAction in this hint set — stays null (toggle the
      // account active from the existing /users/:username/toggle endpoint).

      out.push({
        username: u.username,
        displayName: u.full_name || '',
        active: !!Number(u.active),
        branchId: u.branch_id || null,
        branchName: u.branch_name || '',
        warehouseId: u.default_warehouse_id || null,
        warehouseName: u.warehouse_name || '',
        ready: reasons.length === 0,
        reasons,
        repairAction
      });
    }

    res.json({ success: true, data: out });
  } catch (e) {
    res.status(500).json({ success: false, error: 'تعذر تحميل تقرير جاهزية الكاشير' });
  }
});

module.exports = router;
