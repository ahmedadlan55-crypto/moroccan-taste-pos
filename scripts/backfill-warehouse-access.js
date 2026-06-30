#!/usr/bin/env node
/**
 * Backfill user_warehouse_access (Phase 2A.2).
 *
 * Resolves each active user's warehouse scope from existing signals and (with
 * --apply) writes the grant rows. Default is DRY-RUN: it prints who would get
 * global / which warehouses / DENIED and writes NOTHING — run it and review
 * the DENIED list BEFORE flipping WAREHOUSE_SCOPE_ENFORCE on, so nobody is
 * accidentally locked out.
 *
 * Rules (match lib/warehouseScope.isGlobalScope + the agreed backfill policy):
 *   • admin / developer   → GLOBAL scope (implicit in code; NO rows written).
 *   • user with branch_id → every warehouse where warehouses.branch_id =
 *     user.branch_id (the confirmed relationship) ∪ default_warehouse_id.
 *   • user with only default_warehouse_id → that one warehouse.
 *   • no resolvable warehouse → DENIED (no rows) + listed in the report. We
 *     never grant a guessed/blanket scope.
 *
 * Idempotent: INSERT IGNORE on UNIQUE(user_id, warehouse_id). Re-running
 * --apply never duplicates.
 *
 * Usage:
 *   node scripts/backfill-warehouse-access.js           # dry-run (default)
 *   node scripts/backfill-warehouse-access.js --apply   # write grants
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const db = require('../db/connection');
const WS = require('../lib/warehouseScope');

const APPLY = process.argv.includes('--apply');

async function main() {
  // Warehouses + the branch→warehouses index.
  const [whRows] = await db.query('SELECT id, branch_id FROM warehouses');
  const whById = new Set(whRows.map((w) => String(w.id)));
  const byBranch = new Map();
  whRows.forEach((w) => {
    const b = w.branch_id == null ? '' : String(w.branch_id);
    if (!b) return;
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b).push(String(w.id));
  });

  // Active users (resilient to a legacy schema without is_developer / active).
  let users;
  try {
    [users] = await db.query(
      'SELECT id, username, role, COALESCE(is_developer,0) AS is_developer, branch_id, default_warehouse_id ' +
      'FROM users WHERE COALESCE(active,1) = 1 ORDER BY id');
  } catch (_) {
    [users] = await db.query('SELECT id, username, role, branch_id, default_warehouse_id FROM users ORDER BY id');
    users.forEach((u) => { u.is_developer = 0; });
  }

  const report = { global: [], granted: [], denied: [] };
  let totalGrants = 0;

  for (const u of users) {
    const userLike = { role: u.role, isDeveloper: u.is_developer === 1 || u.is_developer === true };
    if (WS.isGlobalScope(userLike)) {
      report.global.push({ username: u.username, role: u.role });
      continue;
    }

    const ids = new Set();
    const branch = u.branch_id == null ? '' : String(u.branch_id);
    if (branch && byBranch.has(branch)) byBranch.get(branch).forEach((id) => ids.add(id));
    const dw = u.default_warehouse_id == null ? '' : String(u.default_warehouse_id);
    if (dw && whById.has(dw)) ids.add(dw);

    if (!ids.size) {
      report.denied.push({
        username: u.username, role: u.role,
        branch_id: u.branch_id || '', default_warehouse_id: u.default_warehouse_id || '',
      });
      continue;
    }

    const list = Array.from(ids);
    report.granted.push({ username: u.username, role: u.role, warehouses: list });
    totalGrants += list.length;

    if (APPLY) {
      for (const wid of list) {
        await db.query(
          'INSERT IGNORE INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)',
          [u.id, wid, 'backfill']);
      }
    }
  }

  const line = '─'.repeat(72);
  console.log('\n' + line);
  console.log('  user_warehouse_access backfill — ' + (APPLY ? 'APPLY (writing rows)' : 'DRY-RUN (no writes)'));
  console.log(line);
  console.log('\n  GLOBAL (admin/developer — implicit, no rows): ' + report.global.length);
  report.global.forEach((u) => console.log('    • ' + u.username + '  (' + u.role + ')'));
  console.log('\n  GRANTED (scoped): ' + report.granted.length + ' user(s), ' + totalGrants + ' grant row(s)');
  report.granted.forEach((u) => console.log('    • ' + u.username + '  (' + u.role + ') → ' + u.warehouses.join(', ')));
  console.log('\n  ⚠ DENIED (no resolvable warehouse — BLOCKED once enforced): ' + report.denied.length);
  report.denied.forEach((u) =>
    console.log('    • ' + u.username + '  (' + u.role + ')  branch_id=' + (u.branch_id || '∅') +
                '  default_warehouse_id=' + (u.default_warehouse_id || '∅')));
  console.log('\n' + line);
  if (!APPLY) {
    console.log('  DRY-RUN complete — NO rows written. Re-run with --apply to grant.');
    console.log('  Grant the DENIED users manually BEFORE setting WAREHOUSE_SCOPE_ENFORCE=1.');
  } else {
    console.log('  APPLIED. Grants are idempotent (INSERT IGNORE on a UNIQUE key).');
  }
  console.log(line + '\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[backfill] FAILED:', e && e.message);
  process.exit(1);
});
