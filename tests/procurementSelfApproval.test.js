/**
 * Segregation of duties on PURCHASE-ORDER approval — the owner-controllable
 * policy. Drives the REAL routes over real HTTP against the real MySQL:
 *
 *   PUT/GET /api/security-policies      (routes/security-policies.js)  — the switch
 *   POST    /api/procurement/orders/... (routes/procurement/orders.js) — the guard
 *
 * The defect this pins: PO self-approval was hard-wired to the
 * PROCUREMENT_MAKER_CHECKER env var. No settings row, no API, no UI — the owner
 * could not turn it on or off («لا يمكنني التحكم في قبول اوامر الشراء من نفس
 * اليوزر»), and an order whose creator was unknown sailed through (fail OPEN).
 *
 * Nothing here asserts a pasted constant: every expectation is derived from the
 * policy that was actually stored and from the row totals the server computed.
 *
 * Run: node tests/procurementSelfApproval.test.js   (MySQL on 127.0.0.1:3306)
 */
'use strict';

process.env.PROCUREMENT_P2P_ENABLE = '1';
require('dotenv').config();
const express = require('express');
const db = require('../db/connection');
const cfg = require('../lib/procurement/config');

let _p = 0, _f = 0;
const fails = [];
function ok(cond, msg, extra) {
  if (cond) { _p++; console.log('  ✅', msg); }
  else { _f++; fails.push(msg); console.log('  ❌', msg, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

const SUP = 'TEST-SOD-SUP', ITEM = 'TEST-SOD-ITEM', WH = 'TEST-SOD-WH';
const MAKER = 'sod_mgr_maker';     // creates + submits
const CHECKER = 'sod_mgr_checker'; // a genuinely different person
const THIRD = 'sod_mgr_third';

// The exact Arabic refusals routes/procurement/orders.js raises.
const MSG_SELF = 'لا يمكن للمُنشئ اعتماد أمر الشراء الخاص به (فصل المهام)';
const MSG_UNKNOWN_MAKER = 'لا يمكن اعتماد أمر شراء مجهول المُنشئ';

// ── a real Express app mounting the real routers ─────────────────────────────
// Auth is stubbed exactly as tests/procurementRBAC.integration.test.js does, so
// that role/username come from headers; requireCapability then consults the REAL
// seeded role grants. Everything below the middleware is production code.
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    req.user = { id: 1, username: String(req.headers['x-test-user'] || 'admin'), role: String(req.headers['x-test-role'] || 'admin') };
    req.guardWh = () => true;
    req.whScopeClause = () => ({ sql: '', params: [] });
    next();
  });
  app.use('/api/procurement', require('../routes/procurement'));
  app.use('/api/security-policies', require('../routes/security-policies'));
  return app;
}

async function main() {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Raw HTTP — no client code in the path, so every refusal below is the server's. */
  async function call(method, p, body, role, user) {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-role': role || 'admin', 'x-test-user': user || 'admin' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) { /* empty body */ }
    return { status: res.status, json: json || {} };
  }

  const setPolicy = (policy) => call('PUT', '/api/security-policies', { procurementApproval: policy }, 'admin', 'owner_admin');
  const getPolicies = () => call('GET', '/api/security-policies', null, 'admin', 'owner_admin');
  const poRow = async (id) => {
    const [[r]] = await db.query('SELECT status, version, created_by, submitted_by, approved_by, total_after_vat FROM purchase_orders WHERE id = ?', [id]);
    return r;
  };

  /** Create + submit a PO as `user`, at a chosen unit price. Returns its id. */
  async function makeSubmittedPo(user, unitPrice) {
    const body = { supplierId: SUP, warehouseId: WH, lines: [{ itemId: ITEM, enteredQty: 1, factor: 1, unitPriceEntered: unitPrice, vatRate: 15 }] };
    const c = await call('POST', '/api/procurement/orders', body, 'manager', user);
    if (c.status !== 201) throw new Error('fixture: create PO failed ' + c.status + ' ' + JSON.stringify(c.json));
    const id = c.json.data.id;
    const s = await call('POST', `/api/procurement/orders/${id}/submit`, {}, 'manager', user);
    if (s.status !== 200) throw new Error('fixture: submit PO failed ' + s.status + ' ' + JSON.stringify(s.json));
    return id;
  }

  // ── fixtures / teardown ────────────────────────────────────────────────────
  let priorPolicyRow = null; // restore whatever the DB had, so the run is inert
  async function cleanup() {
    await db.query('DELETE FROM procurement_events WHERE document_type = ? AND document_id IN (SELECT id FROM purchase_orders WHERE supplier_id = ?)', ['po', SUP]).catch(() => {});
    await db.query('DELETE pl FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id WHERE po.supplier_id = ?', [SUP]).catch(() => {});
    await db.query('DELETE FROM purchase_orders WHERE supplier_id = ?', [SUP]).catch(() => {});
    await db.query('DELETE FROM suppliers WHERE id = ?', [SUP]).catch(() => {});
    await db.query('DELETE FROM settings WHERE setting_key = ?', [cfg.SELF_APPROVAL_KEY]).catch(() => {});
    if (priorPolicyRow != null) {
      await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [cfg.SELF_APPROVAL_KEY, priorPolicyRow]).catch(() => {});
    }
  }

  const [prior] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [cfg.SELF_APPROVAL_KEY]);
  priorPolicyRow = prior.length ? prior[0].setting_value : null;
  await cleanup();
  await db.query('INSERT INTO warehouses (id, code, name, is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name = VALUES(name)', [WH, 'SODWH', 'مستودع اختبار فصل المهام']);
  await db.query("INSERT INTO inv_items (id, name, kind, unit, cost, stock, tracking_mode) VALUES (?,?,?,?,0,0,'none') ON DUPLICATE KEY UPDATE stock = stock", [ITEM, 'مادة اختبار', 'raw', 'حبة']);
  await db.query('INSERT INTO suppliers (id, name, is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE is_active = 1', [SUP, 'مورد اختبار']);

  try {
    // ── 1. the control EXISTS and round-trips through the real settings route ──
    console.log('\n── 1. the policy is exposed and round-trips (the missing control) ──');
    const g0 = await getPolicies();
    ok(g0.status === 200 && g0.json && g0.json.procurementApproval != null,
      'GET /api/security-policies exposes a procurementApproval block', { status: g0.status, keys: Object.keys(g0.json || {}) });

    // Unset ⇒ the screen must report what the SERVER actually enforces today,
    // i.e. the PROCUREMENT_MAKER_CHECKER default — not a hardcoded guess.
    const inForce = cfg.defaultSelfApprovalPolicy();
    ok(g0.json.procurementApproval && g0.json.procurementApproval.enabled === inForce.enabled
       && g0.json.procurementApproval.thresholdAmount === inForce.thresholdAmount,
      `unset default equals the behaviour already in force (enabled=${inForce.enabled}, threshold=${inForce.thresholdAmount}) — upgrading changes nothing`,
      g0.json.procurementApproval);

    const putOn = await setPolicy({ enabled: true, thresholdAmount: 0 });
    ok(putOn.status === 200 && putOn.json.success === true, 'admin PUT procurementApproval → 200', putOn.json);
    const g1 = await getPolicies();
    ok(g1.json.procurementApproval.enabled === true && g1.json.procurementApproval.thresholdAmount === 0,
      'GET reflects the stored policy (round-trip)', g1.json.procurementApproval);
    // Deliberately null-safe: a mutant that stops persisting the block must
    // FAIL this assertion, not abort the run before the rest of it can speak.
    const readStored = async () => {
      const [rows] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ?', [cfg.SELF_APPROVAL_KEY]);
      if (!rows.length || !rows[0].setting_value) return null;
      try { return JSON.parse(rows[0].setting_value); } catch (_) { return null; }
    };
    const storedRow = await readStored();
    ok(!!storedRow && storedRow.enabled === true,
      `the policy is persisted in settings.${cfg.SELF_APPROVAL_KEY} (survives a restart)`, storedRow);

    // the switch itself must be protected — a cashier cannot disarm SoD
    const cashPut = await call('PUT', '/api/security-policies', { procurementApproval: { enabled: false, thresholdAmount: 0 } }, 'cashier', 'sod_cashier');
    ok(cashPut.status === 403, 'a cashier PUT of the policy → 403 (the switch is capability-gated)', { status: cashPut.status });
    const afterCash = await readStored();
    ok(!!afterCash && afterCash.enabled === true, 'the refused cashier PUT did not change the stored policy', afterCash);

    // rejected payloads
    const badBool = await call('PUT', '/api/security-policies', { procurementApproval: { thresholdAmount: 10 } }, 'admin', 'owner_admin');
    ok(badBool.status === 400, 'PUT without an explicit enabled flag → 400 (no silent partial write)', badBool.json);
    const badAmount = await setPolicy({ enabled: true, thresholdAmount: -5 });
    ok(badAmount.status === 400, 'PUT with a negative threshold → 400', badAmount.json);

    // ── 2. policy ON: the creator is refused, a different user is not ──────────
    console.log('\n── 2. policy ON — creator refused, different user allowed ──');
    await setPolicy({ enabled: true, thresholdAmount: 0 });
    const po1 = await makeSubmittedPo(MAKER, 100);
    const before1 = await poRow(po1);

    const selfTry = await call('POST', `/api/procurement/orders/${po1}/approve`, {}, 'manager', MAKER);
    ok(selfTry.status === 403 && selfTry.json.code === 'PERMISSION_DENIED',
      'the creator approving their OWN PO → 403 PERMISSION_DENIED', { status: selfTry.status, json: selfTry.json });
    ok(selfTry.json.error === MSG_SELF, 'the refusal carries the specific Arabic maker-checker message, not a generic 403', selfTry.json.error);

    const after1 = await poRow(po1);
    ok(after1.status === before1.status && after1.status === 'submitted', 'the refused approval left the PO in submitted', after1);
    ok(Number(after1.version) === Number(before1.version), 'the refused approval did not bump version (whole transaction rolled back)', { before: before1.version, after: after1.version });
    ok(after1.approved_by == null || after1.approved_by === '', 'the refused approval stamped no approver', after1.approved_by);
    const [ev1] = await db.query("SELECT action FROM procurement_events WHERE document_type='po' AND document_id=? AND action='approve'", [po1]);
    ok(ev1.length === 0, 'the refused approval recorded no approve event', ev1);

    const otherTry = await call('POST', `/api/procurement/orders/${po1}/approve`, {}, 'manager', CHECKER);
    ok(otherTry.status === 200 && otherTry.json.success === true, 'a DIFFERENT user approving the SAME PO → 200 (not a blanket lockout)', otherTry.json);
    const after1b = await poRow(po1);
    ok(after1b.status === 'approved' && after1b.approved_by === CHECKER, 'the PO is approved and stamped with the checker', after1b);

    // spoofing the actor in the body must not help — identity comes from req.user
    const po1s = await makeSubmittedPo(MAKER, 100);
    const spoof = await call('POST', `/api/procurement/orders/${po1s}/approve`, { approvedBy: CHECKER, username: CHECKER, createdBy: CHECKER, actor: CHECKER }, 'manager', MAKER);
    ok(spoof.status === 403 && spoof.json.error === MSG_SELF,
      'a hand-crafted body naming someone else as the approver is still refused (identity is not taken from the payload)', spoof.json);

    // ── 3. the switch actually switches — same PO, opposite outcomes ───────────
    console.log('\n── 3. the owner\'s switch decides the outcome ──');
    const po2 = await makeSubmittedPo(MAKER, 100);
    const onTry = await call('POST', `/api/procurement/orders/${po2}/approve`, {}, 'manager', MAKER);
    ok(onTry.status === 403, 'policy ON → self-approval refused', { status: onTry.status });

    const putOff = await setPolicy({ enabled: false, thresholdAmount: 0 });
    ok(putOff.status === 200, 'owner turns the policy OFF via the settings route', putOff.json);
    const offTry = await call('POST', `/api/procurement/orders/${po2}/approve`, {}, 'manager', MAKER);
    ok(offTry.status === 200 && offTry.json.success === true,
      'policy OFF → the SAME creator approves the SAME PO (today\'s behaviour preserved when the owner opts out)', offTry.json);
    const after2 = await poRow(po2);
    ok(after2.status === 'approved' && after2.approved_by === MAKER, 'the self-approved PO is approved and stamped with its creator', after2);

    // ── 4. threshold — the rule must hold as a PROPERTY, at every amount ───────
    console.log('\n── 4. threshold: refusal ⇔ total_after_vat >= thresholdAmount ──');
    const THRESHOLD = 500;
    await setPolicy({ enabled: true, thresholdAmount: THRESHOLD });
    const gT = await getPolicies();
    ok(gT.json.procurementApproval.thresholdAmount === THRESHOLD, 'threshold stored and read back', gT.json.procurementApproval);

    let propertyHolds = true;
    const observed = [];
    for (const unitPrice of [100, 434.78, 435, 1000]) {
      const id = await makeSubmittedPo(MAKER, unitPrice);
      const row = await poRow(id);
      const total = Number(row.total_after_vat);
      const r = await call('POST', `/api/procurement/orders/${id}/approve`, {}, 'manager', MAKER);
      const refused = r.status === 403;
      const shouldRefuse = total >= THRESHOLD; // the rule, recomputed from the SERVER's own total
      observed.push({ total, refused, shouldRefuse, status: r.status });
      if (refused !== shouldRefuse) propertyHolds = false;
      if (!refused) {
        const done = await poRow(id);
        if (done.status !== 'approved') propertyHolds = false;
      }
    }
    ok(propertyHolds, `self-approval is refused exactly when the PO total reaches the threshold (${THRESHOLD})`, observed);
    ok(observed.some((o) => o.refused) && observed.some((o) => !o.refused),
      'the sample straddles the threshold (both outcomes actually occurred — the assertion is not vacuous)', observed);

    // ── 5. the whole authorship trail counts, not just the last actor ──────────
    console.log('\n── 5. creator ≠ submitter — both are "the same person" ──');
    await setPolicy({ enabled: true, thresholdAmount: 0 });
    const body3 = { supplierId: SUP, warehouseId: WH, lines: [{ itemId: ITEM, enteredQty: 1, factor: 1, unitPriceEntered: 100, vatRate: 15 }] };
    const c3 = await call('POST', '/api/procurement/orders', body3, 'manager', MAKER);
    const po3 = c3.json.data.id;
    await call('POST', `/api/procurement/orders/${po3}/submit`, {}, 'manager', CHECKER); // submitted by someone else
    const row3 = await poRow(po3);
    ok(row3.created_by === MAKER && row3.submitted_by === CHECKER, 'fixture: creator and submitter are different users', row3);

    const creatorTry = await call('POST', `/api/procurement/orders/${po3}/approve`, {}, 'manager', MAKER);
    ok(creatorTry.status === 403 && creatorTry.json.error === MSG_SELF, 'the CREATOR is refused even though someone else submitted', creatorTry.json);
    const submitterTry = await call('POST', `/api/procurement/orders/${po3}/approve`, {}, 'manager', CHECKER);
    ok(submitterTry.status === 403 && submitterTry.json.error === MSG_SELF, 'the SUBMITTER is refused even though someone else created', submitterTry.json);
    const thirdTry = await call('POST', `/api/procurement/orders/${po3}/approve`, {}, 'manager', THIRD);
    ok(thirdTry.status === 200 && thirdTry.json.success === true, 'a third party outside the authorship trail approves → 200', thirdTry.json);

    // ── 6. unknown creator FAILS CLOSED ───────────────────────────────────────
    console.log('\n── 6. unknown creator fails CLOSED (documented behaviour) ──');
    await setPolicy({ enabled: true, thresholdAmount: 0 });
    const po4 = await makeSubmittedPo(MAKER, 100);
    await db.query('UPDATE purchase_orders SET created_by = NULL, submitted_by = NULL WHERE id = ?', [po4]);
    const anon = await call('POST', `/api/procurement/orders/${po4}/approve`, {}, 'manager', THIRD);
    ok(anon.status === 403 && anon.json.code === 'PERMISSION_DENIED',
      'a PO whose creator cannot be determined is REFUSED while the policy is on (not silently allowed)', { status: anon.status, json: anon.json });
    ok(typeof anon.json.error === 'string' && anon.json.error.startsWith(MSG_UNKNOWN_MAKER),
      'the unknown-creator refusal has its own message, distinguishable from the self-approval one', anon.json.error);
    ok(anon.json.error !== MSG_SELF, 'the unknown-creator refusal is not the self-approval message', anon.json.error);
    const after4 = await poRow(po4);
    ok(after4.status === 'submitted', 'the unknown-creator PO stayed submitted', after4);

    // blank strings are as unknown as NULL
    await db.query("UPDATE purchase_orders SET created_by = '', submitted_by = '   ' WHERE id = ?", [po4]);
    const blank = await call('POST', `/api/procurement/orders/${po4}/approve`, {}, 'manager', THIRD);
    ok(blank.status === 403 && blank.json.error.startsWith(MSG_UNKNOWN_MAKER), 'blank/whitespace authorship is treated as unknown too', blank.json);

    // …and the escape hatch the message points at genuinely works
    await setPolicy({ enabled: false, thresholdAmount: 0 });
    const anonOff = await call('POST', `/api/procurement/orders/${po4}/approve`, {}, 'manager', THIRD);
    ok(anonOff.status === 200 && anonOff.json.success === true,
      'with the policy off, the same unknown-creator PO approves — the fail-closed refusal is the policy, not a dead end', anonOff.json);
  } catch (e) {
    ok(false, 'unexpected exception: ' + (e && e.message), e && e.stack ? e.stack.split('\n').slice(0, 3) : null);
  } finally {
    server.close();
    await cleanup();
    await db.end();
  }

  console.log(`\n${_f === 0 ? '✅' : '❌'} procurementSelfApproval: ${_p} passed, ${_f} failed`);
  if (_f) console.log('   failed:', fails.join(' | '));
  process.exit(_f === 0 ? 0 : 1);
}

main().catch((e) => { console.error('SELF-APPROVAL TEST ERROR:', e.stack || e.message); process.exit(1); });
