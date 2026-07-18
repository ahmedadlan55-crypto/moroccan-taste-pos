#!/usr/bin/env node
/**
 * scripts/seed-test-accounts.js — seed two throwaway test logins for the
 * Administration › Users screen.
 *
 *   1. a CASHIER linked to a real branch + warehouse
 *   2. a CUSTODY-officer-eligible user (custody portal on + a custody_users row)
 *
 * Direct DB insert via the project's pool + bcryptjs (cost 12 — the exact hash
 * convention routes/auth.js uses), NOT the HTTP API, so it runs without an admin
 * JWT. Mirrors the create handler's essentials: strong password, brand/branch/
 * warehouse links, portal flags, must_change_password=1, and custody_users
 * provisioning. Idempotent — ON DUPLICATE KEY UPDATE rotates the password on
 * re-run.
 *
 * SECURITY: passwords are generated with crypto and written ONLY to an
 * out-of-repo file (env SEED_OUT, else <os.tmpdir()>/mt-pos-seed/test-accounts.txt).
 * They are NEVER printed to stdout or committed. Usage:
 *
 *     SEED_OUT="C:\\path\\to\\scratchpad\\test-accounts.txt" node scripts/seed-test-accounts.js
 */
'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');

// A password that always satisfies the server rule (≥6, letter+digit+special):
// base64 body (A-Za-z0-9) + a guaranteed one-of-each tail.
function strongPassword() {
  const body = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '');
  return `${body}Aa9#`;
}

async function pickBranchAndWarehouse() {
  // Prefer a branch that already carries a warehouse; else any branch + any warehouse.
  const [branches] = await db.query(
    'SELECT id, brand_id, warehouse_id FROM branches ORDER BY (warehouse_id IS NULL) ASC, id ASC LIMIT 1',
  );
  const branch = branches[0];
  if (!branch) throw new Error('لا يوجد أي فرع في قاعدة البيانات لربط الحساب به');

  let warehouseId = branch.warehouse_id || null;
  if (!warehouseId) {
    const [whs] = await db.query('SELECT id FROM warehouses ORDER BY id ASC LIMIT 1');
    warehouseId = whs.length ? whs[0].id : null;
  }
  return { branchId: branch.id, brandId: branch.brand_id || null, warehouseId };
}

async function upsertUser({ username, password, role, brandId, branchId, warehouseId }) {
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO users
       (username, password, role, active, email, brand_id, branch_id, default_branch_id,
        default_warehouse_id, can_change_branch, must_change_password)
     VALUES (?, ?, ?, 1, '', ?, ?, ?, ?, 0, 1)
     ON DUPLICATE KEY UPDATE
       password = VALUES(password), role = VALUES(role), active = 1,
       brand_id = VALUES(brand_id), branch_id = VALUES(branch_id),
       default_branch_id = VALUES(default_branch_id),
       default_warehouse_id = VALUES(default_warehouse_id),
       must_change_password = 1`,
    [username, hash, role, brandId, branchId, branchId, warehouseId],
  );
}

async function setPortals(username, { employee, custody }) {
  // Portal columns may be absent on very old schemas — tolerate like the handler.
  try {
    await db.query('UPDATE users SET employee_portal = ?, custody_portal = ? WHERE username = ?', [
      employee ? 1 : 0,
      custody ? 1 : 0,
      username,
    ]);
  } catch (_) {
    /* columns not migrated */
  }
}

async function provisionCustody(username, displayName) {
  // Mirror the create handler: reuse/reactivate an existing custody_users row.
  try {
    const [existing] = await db.query('SELECT id FROM custody_users WHERE linked_username = ? LIMIT 1', [
      username,
    ]);
    if (existing.length) {
      await db.query('UPDATE custody_users SET is_active = 1, name = ? WHERE id = ?', [
        displayName,
        existing[0].id,
      ]);
    } else {
      await db.query(
        'INSERT INTO custody_users (id, name, job_title, linked_username, is_active) VALUES (?,?,?,?,1)',
        ['CU-SEED-' + Date.now(), displayName, 'مسؤول عهدة', username],
      );
    }
  } catch (_) {
    /* custody_users table optional */
  }
}

function writeCredentials(outPath, accounts) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '# Moroccan Taste POS — seeded TEST accounts (do NOT commit)',
    `# generated: ${new Date().toISOString()}`,
    '# All accounts have must_change_password=1 — you will be forced to set a new',
    '# password on first login.',
    '',
  ];
  for (const a of accounts) {
    lines.push(
      `[${a.label}]`,
      `username: ${a.username}`,
      `password: ${a.password}`,
      `role:     ${a.role}`,
      `branch:   ${a.branchId}`,
      `warehouse:${a.warehouseId || '(none)'}`,
      `portals:  ${a.portals}`,
      '',
    );
  }
  fs.writeFileSync(outPath, lines.join('\n'), { encoding: 'utf8' });
}

(async () => {
  const outPath =
    process.env.SEED_OUT || path.join(os.tmpdir(), 'mt-pos-seed', 'test-accounts.txt');

  try {
    const { branchId, brandId, warehouseId } = await pickBranchAndWarehouse();

    const cashier = {
      label: 'CASHIER (branch + warehouse)',
      username: 'test.cashier',
      password: strongPassword(),
      role: 'cashier',
      branchId,
      warehouseId,
      portals: 'employee',
    };
    const custody = {
      label: 'CUSTODY OFFICER (custody portal)',
      username: 'test.custody',
      password: strongPassword(),
      role: 'custody',
      branchId,
      warehouseId,
      portals: 'custody',
    };

    await upsertUser({ ...cashier, brandId });
    await setPortals(cashier.username, { employee: true, custody: false });

    await upsertUser({ ...custody, brandId });
    await setPortals(custody.username, { employee: false, custody: true });
    await provisionCustody(custody.username, 'أمين عهدة تجريبي');

    writeCredentials(outPath, [cashier, custody]);

    // NEVER print the passwords — only what is safe to show.
    console.log('Seeded test accounts:');
    console.log(`  - ${cashier.username} (cashier, branch=${branchId}, warehouse=${warehouseId || 'n/a'})`);
    console.log(`  - ${custody.username} (custody, custodyPortal=on)`);
    console.log(`Credentials (username + password) written to: ${outPath}`);
    process.exit(0);
  } catch (e) {
    console.error('Seed failed:', e.code || e.message);
    process.exit(1);
  }
})();
