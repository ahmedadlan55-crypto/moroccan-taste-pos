#!/usr/bin/env node
'use strict';
/**
 * tests/procurementRequisitionVisibility.test.js — a purchase requisition must
 * be visible to the person who filed it, and to nobody else's warehouse.
 * Run: node tests/procurementRequisitionVisibility.test.js
 *
 * WHAT WAS BROKEN
 *   «عند طلب نواقص لا تظهر ضمن الطلبات» — you file a request and it is not in
 *   the requests list. Two independent causes, both reproduced before the fix:
 *
 *   1. NULL vs IN(...). POST / stored `b.warehouseId || null`, and the UI's
 *      warehouse field was a free-text "type the warehouse ID" box, so in
 *      practice every requisition landed with warehouse_id = NULL. GET / then
 *      applied `H.scopeClause(req,'r.warehouse_id')`, which for a scoped user
 *      emits `r.warehouse_id IN (…)` — and NULL matches no IN-list. The row was
 *      invisible to every scoped user INCLUDING the person who had just created
 *      it: HTTP 200, total 0, no error anywhere.
 *
 *   2. Capability asymmetry. The RBAC seed in the same router grants
 *      `purchasing.requisitions.manage` to employee/custody, but the list was
 *      gated on `procurement.view` — which those roles do not have, because it
 *      opens the whole AP module. So the very roles meant to file requisitions
 *      got 201 on create and 403 on the list.
 *
 * WHAT THIS FILE PROVES
 *   It boots the REAL routes/procurement router behind the REAL
 *   middleware/warehouseScope (WAREHOUSE_SCOPE_ENFORCE=1) against the live DB
 *   and speaks HTTP to it. Every row here is created by POSTing to the real
 *   endpoint as a real user, never by an INSERT the test wrote itself, so the
 *   assertions are about what the shipped create+list path actually does.
 *
 * THE RULE THIS PINS
 *   read visibility = warehouse_id IN (granted…)
 *                     OR (warehouse_id IS NULL AND created_by = me)
 *   The NULL branch is bounded by the creator ON PURPOSE. A bare
 *   `OR warehouse_id IS NULL` would hand every scoped user every other
 *   department's unassigned requisitions — section 4 fails if anyone widens it
 *   that way. `created_by` is used rather than `requested_by` because
 *   created_by is stamped from the JWT while requested_by is settable from the
 *   request body, i.e. forgeable; section 5 pins that too.
 *
 * FAIL-CLOSED, AND WHY NOT 403
 *   An out-of-scope id answers 404 with the same body a never-issued id gets.
 *   A 403 would confirm the requisition exists and let an attacker enumerate
 *   another site's document numbering. Section 6 asserts the two are identical.
 */

process.env.PROCUREMENT_P2P_ENABLE = '1';
// MUST precede the require below — middleware/warehouseScope reads the flag once
// at module load. Setting it afterwards silently leaves enforcement OFF, and an
// unenforced run passes every assertion here for the wrong reason (section 0
// refuses to continue in that state).
process.env.WAREHOUSE_SCOPE_ENFORCE = '1';

const express = require('express');
const db = require('../db/connection');
const { loadWarehouseScope, isEnforced } = require('../middleware/warehouseScope');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve()
    .then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── fixture identities ───────────────────────────────────────────────────────
const WH_A = 'WH-REQVIS-A', WH_B = 'WH-REQVIS-B', WH_C = 'WH-REQVIS-C';
const ITEM = 'REQVIS-ITEM';
// manager → has procurement.view AND purchasing.requisitions.manage
const U_ONE = { id: 990201, username: 'reqvis_one', role: 'manager' };     // exactly ONE warehouse
const U_MULTI = { id: 990202, username: 'reqvis_multi', role: 'manager' }; // TWO warehouses → no default
const U_OTHER = { id: 990203, username: 'reqvis_other', role: 'manager' }; // a different warehouse
// employee → has purchasing.requisitions.manage ONLY (no procurement.view)
const U_EMP = { id: 990204, username: 'reqvis_emp', role: 'employee' };
// cashier → neither capability
const U_NONE = { id: 990205, username: 'reqvis_none', role: 'cashier' };
const ADMIN = { id: 990206, username: 'reqvis_admin', role: 'admin' };     // global scope
const ALL_USERS = [U_ONE, U_MULTI, U_OTHER, U_EMP, U_NONE, ADMIN];
const GRANTS = [[U_ONE, [WH_A]], [U_MULTI, [WH_A, WH_B]], [U_OTHER, [WH_C]], [U_EMP, [WH_A]], [U_NONE, [WH_A]]];

const LINES = [{ itemId: ITEM, itemName: 'مادة اختبار', quantity: 4, estimatedPrice: 2.5 }];
const NOTE_TAG = 'reqvis-fixture';

function buildApp() {
  const app = express();
  app.use(express.json());
  // stand-in for verifyToken: identity comes from headers so the REAL
  // requireCapability + REAL warehouse-scope resolution run against real rows.
  app.use((req, _res, next) => {
    req.user = {
      id: Number(req.headers['x-test-uid']),
      username: String(req.headers['x-test-user']),
      role: String(req.headers['x-test-role']),
    };
    next();
  });
  app.use('/api/procurement', loadWarehouseScope);
  app.use('/api/procurement', require('../routes/procurement'));
  return app;
}

async function seed() {
  for (const [id, code, name] of [[WH_A, 'RVA', 'مستودع أ'], [WH_B, 'RVB', 'مستودع ب'], [WH_C, 'RVC', 'مستودع ج']]) {
    await db.query('INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)', [id, code, name]);
  }
  await db.query("INSERT INTO inv_items (id,name,kind,unit,cost,stock,tracking_mode) VALUES (?,?,?,?,0,0,'none') ON DUPLICATE KEY UPDATE stock=stock",
    [ITEM, 'مادة اختبار الرؤية', 'raw', 'حبة']);
  for (const u of ALL_USERS) {
    await db.query('DELETE FROM user_warehouse_access WHERE user_id=?', [u.id]);
    await db.query('INSERT INTO users (id, username, password, role, active) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE role=VALUES(role), active=1',
      [u.id, u.username, 'x', u.role]);
  }
  for (const [u, whs] of GRANTS) {
    for (const wh of whs) {
      await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)', [u.id, wh, 'reqvis']);
    }
  }
}

async function cleanup() {
  await db.query(
    'DELETE l FROM purchase_requisition_lines l JOIN purchase_requisitions r ON r.id=l.requisition_id WHERE r.notes LIKE ?',
    [NOTE_TAG + '%']).catch(() => {});
  await db.query('DELETE FROM purchase_requisitions WHERE notes LIKE ?', [NOTE_TAG + '%']).catch(() => {});
  for (const u of ALL_USERS) {
    await db.query('DELETE FROM user_warehouse_access WHERE user_id=?', [u.id]).catch(() => {});
    await db.query('DELETE FROM users WHERE id=?', [u.id]).catch(() => {});
  }
}

async function main() {
  await cleanup();
  await seed();

  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, body, u) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-uid': String(u.id), 'x-test-user': u.username, 'x-test-role': u.role,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const createAs = (u, extra) => call('POST', '/api/procurement/requisitions',
    Object.assign({ lines: LINES, notes: NOTE_TAG + ' ' + u.username }, extra || {}), u);
  const listAs = async (u) => {
    const r = await call('GET', '/api/procurement/requisitions?pageSize=200', null, u);
    return { status: r.status, ids: (r.json.data || []).map((x) => x.id), total: r.json.pagination && r.json.pagination.total };
  };
  const warehouseOf = async (id) => {
    const [rows] = await db.query('SELECT warehouse_id, created_by FROM purchase_requisitions WHERE id=?', [id]);
    return rows[0] || null;
  };

  try {
    // ── 0. the run is meaningful ──────────────────────────────────────────────
    console.log('\n0. the enforcement this whole file depends on');

    await test('warehouse-scope enforcement is ON (otherwise every clause below is empty)', () => {
      eq(isEnforced(), true, 'WAREHOUSE_SCOPE_ENFORCE must be on for this file to prove anything');
    });

    // ── 1. the creator can always see what they filed ────────────────────────
    console.log('\n1. the creator can always see what they filed');

    // one-warehouse user, warehouse left empty exactly as the form sends it
    const rOne = await createAs(U_ONE);
    const idOne = rOne.json.data && rOne.json.data.id;

    await test('a one-warehouse user creating with NO warehouse gets it stamped from their own scope', async () => {
      eq(rOne.status, 201, 'create must succeed');
      const row = await warehouseOf(idOne);
      ok(row, 'the row must exist');
      // the PROPERTY: it is the warehouse this caller is granted, not a constant
      const [grants] = await db.query('SELECT warehouse_id FROM user_warehouse_access WHERE user_id=?', [U_ONE.id]);
      eq(grants.length, 1, 'fixture: this user must hold exactly one grant');
      eq(String(row.warehouse_id), String(grants[0].warehouse_id),
        'an unambiguous single-warehouse caller must not be left with a NULL warehouse');
    });

    await test('…and it is in their own list (the defect: it was not)', async () => {
      const l = await listAs(U_ONE);
      eq(l.status, 200, 'list must answer 200');
      ok(l.ids.indexOf(idOne) !== -1, 'the creator cannot see the requisition they just filed');
    });

    // multi-warehouse user: attribution is ambiguous, so the row stays NULL
    const rMulti = await createAs(U_MULTI);
    const idMulti = rMulti.json.data && rMulti.json.data.id;

    await test('a multi-warehouse user creating with NO warehouse keeps warehouse_id NULL', async () => {
      eq(rMulti.status, 201, 'create must succeed');
      const row = await warehouseOf(idMulti);
      eq(row.warehouse_id, null, 'guessing one of several warehouses would misfile the request');
      eq(row.created_by, U_MULTI.username, 'created_by is stamped from the JWT');
    });

    await test('…and that NULL row is STILL in its creator\'s list', async () => {
      const l = await listAs(U_MULTI);
      ok(l.ids.indexOf(idMulti) !== -1, 'a NULL warehouse must not hide a request from the person who filed it');
    });

    // ── 2. cross-warehouse isolation is untouched ────────────────────────────
    console.log('\n2. cross-warehouse isolation is untouched');

    const rOther = await createAs(U_OTHER, { warehouseId: WH_C });
    const idOther = rOther.json.data && rOther.json.data.id;

    await test('fixture: the other user\'s requisition really is on their warehouse', async () => {
      eq(rOther.status, 201, 'create must succeed');
      eq(String((await warehouseOf(idOther)).warehouse_id), WH_C, 'warehouse');
    });

    await test('a scoped user does NOT see another warehouse\'s requisition', async () => {
      const l = await listAs(U_ONE);
      ok(l.ids.indexOf(idOther) === -1, `${WH_C} leaked into a ${WH_A}-only list`);
    });

    await test('the other user does not see the first user\'s warehouse either (both directions)', async () => {
      const l = await listAs(U_OTHER);
      ok(l.ids.indexOf(idOne) === -1, 'a WH-A requisition leaked into a WH-C-only list');
    });

    await test('a global user sees BOTH, and the NULL-warehouse one as well', async () => {
      const l = await listAs(ADMIN);
      eq(l.status, 200, 'admin list');
      ok(l.ids.indexOf(idOne) !== -1, 'admin must see the WH-A requisition');
      ok(l.ids.indexOf(idOther) !== -1, 'admin must see the WH-C requisition');
      ok(l.ids.indexOf(idMulti) !== -1, 'admin must see the unassigned requisition');
    });

    // ── 3. an out-of-scope warehouse cannot be filed against at all ──────────
    console.log('\n3. you cannot file a request where you could not read it back');

    await test('naming a warehouse outside your scope is refused at create', async () => {
      const r = await call('POST', '/api/procurement/requisitions',
        { lines: LINES, warehouseId: WH_C, notes: NOTE_TAG + ' escalation' }, U_ONE);
      eq(r.status, 403, 'a WH-A user filing against WH-C must be denied');
      const [rows] = await db.query('SELECT COUNT(*) AS n FROM purchase_requisitions WHERE notes = ?', [NOTE_TAG + ' escalation']);
      eq(Number(rows[0].n), 0, 'the refused requisition must not have been written');
    });

    // ── 4. the NULL rule is bounded by the creator, not open to everyone ─────
    console.log('\n4. the NULL-warehouse rule — creator only, never a blanket OR IS NULL');

    await test('another scoped user does NOT see somebody else\'s NULL-warehouse requisition', async () => {
      const l = await listAs(U_OTHER);
      ok(l.ids.indexOf(idMulti) === -1,
        'the NULL branch has been widened to every scoped user — that is a blanket OR warehouse_id IS NULL');
    });

    await test('a user with grants but no requisitions of their own sees none of these', async () => {
      const l = await listAs(U_OTHER);
      [idOne, idMulti].forEach((id) => ok(l.ids.indexOf(id) === -1, `row ${id} leaked`));
    });

    // ── 5. the identity used is the non-forgeable one ────────────────────────
    console.log('\n5. the identity in the NULL branch cannot be forged from the body');

    // U_MULTI holds two grants, so this row keeps warehouse_id NULL and really
    // does travel through the creator branch. It is filed by U_MULTI but NAMES
    // U_OTHER in the body's requestedBy — the two identities disagree, which is
    // the only way to tell which column the predicate is keyed on.
    const rForged = await call('POST', '/api/procurement/requisitions',
      { lines: LINES, requestedBy: U_OTHER.username, notes: NOTE_TAG + ' forged' }, U_MULTI);
    const idForged = rForged.json.data && rForged.json.data.id;

    await test('fixture: the row is NULL-warehouse, created_by ≠ requested_by', async () => {
      eq(rForged.status, 201, 'create must succeed');
      const [rows] = await db.query('SELECT warehouse_id, created_by, requested_by FROM purchase_requisitions WHERE id=?', [idForged]);
      eq(rows[0].warehouse_id, null, 'it must exercise the NULL branch, not the IN-list');
      eq(rows[0].created_by, U_MULTI.username, 'created_by must come from the JWT, not the body');
      eq(rows[0].requested_by, U_OTHER.username, 'requested_by is whatever the body said — that is the point');
    });

    await test('the CREATOR still sees it even though the body names someone else', async () => {
      const l = await listAs(U_MULTI);
      ok(l.ids.indexOf(idForged) !== -1,
        'visibility is keyed on the body-settable requested_by, so the filer lost sight of their own request');
    });

    await test('the user NAMED in the body gains nothing', async () => {
      const l = await listAs(U_OTHER);
      ok(l.ids.indexOf(idForged) === -1,
        'writing another name into requestedBy handed that user a requisition they never filed');
      ok(l.ids.indexOf(idMulti) === -1, 'and none of the creator\'s other rows either');
      eq((await call('GET', `/api/procurement/requisitions/${idForged}`, null, U_OTHER)).status, 404, 'detail too');
    });

    // ── 6. detail reads agree with the list, and fail closed ─────────────────
    console.log('\n6. detail reads — same rule, and out-of-scope is indistinguishable from missing');

    await test('the creator can open the requisition they can see in the list', async () => {
      const r = await call('GET', `/api/procurement/requisitions/${idMulti}`, null, U_MULTI);
      eq(r.status, 200, 'the creator must be able to open their own NULL-warehouse requisition');
      eq(r.json.data.id, idMulti, 'and get the right row');
    });

    await test('an out-of-scope id and a never-issued id answer identically', async () => {
      const outOfScope = await call('GET', `/api/procurement/requisitions/${idOther}`, null, U_ONE);
      const missing = await call('GET', '/api/procurement/requisitions/PR-does-not-exist', null, U_ONE);
      eq(outOfScope.status, 404, 'a 403 here would confirm the requisition exists');
      eq(JSON.stringify(outOfScope.json), JSON.stringify(missing.json),
        'the two responses differ — the difference IS the existence leak');
    });

    await test('a global user can still open any of them', async () => {
      for (const id of [idOne, idMulti, idOther]) {
        eq((await call('GET', `/api/procurement/requisitions/${id}`, null, ADMIN)).status, 200, `admin GET ${id}`);
      }
    });

    // ── 7. the role that may FILE a request may READ the list ────────────────
    console.log('\n7. capability — whoever may file a requisition may read the requisition list');

    await test('fixture: employee holds requisitions.manage but NOT procurement.view', async () => {
      const cap = require('../middleware/requireCapability');
      eq(await cap.hasCapability(U_EMP, 'purchasing.requisitions.manage'), true, 'employee must be able to file');
      eq(await cap.hasCapability(U_EMP, 'procurement.view'), false,
        'if the seed ever grants employees procurement.view, this test stops proving anything (and AP opens up)');
    });

    const rEmp = await createAs(U_EMP);

    await test('that role creates (201) and then FINDS its own requisition (the defect: 403)', async () => {
      eq(rEmp.status, 201, 'create must succeed');
      const l = await listAs(U_EMP);
      eq(l.status, 200, 'the list must not 403 the very role that may file requisitions');
      ok(l.ids.indexOf(rEmp.json.data.id) !== -1, 'and it must contain the row they just filed');
    });

    await test('a role holding NEITHER capability is still refused', async () => {
      const l = await listAs(U_NONE);
      eq(l.status, 403, 'the read must stay closed to a role with no requisition capability at all');
      eq((await call('GET', `/api/procurement/requisitions/${rEmp.json.data.id}`, null, U_NONE)).status, 403, 'detail too');
    });

    await test('the read widening did not open the rest of procurement to that role', async () => {
      // CAP_MANAGE now opens the requisition reads. It must NOT have become a
      // skeleton key for supplier invoices / payments, which is exactly why
      // procurement.view was not simply granted to these roles.
      for (const p of ['/api/procurement/invoices', '/api/procurement/payments', '/api/procurement/orders']) {
        eq((await call('GET', p + '?pageSize=5', null, U_EMP)).status, 403, `${p} must stay closed to an employee`);
      }
    });
  } finally {
    server.close();
    await cleanup();
  }

  await db.end();
  console.log(`\nRequisition visibility: ${_passed}/${_total} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
}

main().catch((e) => { console.error('REQUISITION VISIBILITY TEST ERROR:', e.stack || e.message); process.exit(1); });
