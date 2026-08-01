'use strict';
/*
 * Integration — نماذج الجرد المحفوظة: saved stocktake templates.
 *   routes/stocktake-templates.js, mounted at /api/inventory/stocktake-templates
 *   (server.js), tables inv_stocktake_templates + inv_stocktake_template_items
 *   (server.js runMigrations → createTableIfMissing), cashier reachability via
 *   middleware/posPortalScope.js.
 *
 * THE OWNER'S ASK this proves is actually persisted:
 *   «امكانيا انشاء وحفظ نموذج جرد بحيث يمكنني اختياره والتعديل عليه بحيث اضع فيه
 *    المواد التي احتاج جردها دوريا» — create a named set of the materials he counts
 *   periodically, pick it, edit it, reuse it.
 *
 * What this proves (real server + real local MySQL, ITEST- fixtures, full cleanup):
 *   (1) CRUD          — create → list → rename → REPLACE the item set → delete,
 *                       with the ORDER of the item list preserved on the round trip.
 *   (2) ENVELOPE      — every response is { success, data }. Pinned deliberately:
 *                       a client that forgot to unwrap `.data` has already caused a
 *                       production outage in this repo.
 *   (3) CASHIER GATE  — a cashier CAN list / create / read / edit-own / delete-own
 *                       (i.e. the posPortalScope ALLOW entries exist for all five
 *                       verbs — without them every one of these is a 403 at the
 *                       boundary, never reaching the route).
 *   (4) OWNERSHIP     — a cashier CANNOT delete (or edit) a template created by
 *                       another user → 403 PERMISSION_DENIED, and the row survives;
 *                       a MANAGER can delete that same template.
 *   (5) VALIDATION    — unknown item id → 400, empty itemIds → 400, blank name →
 *                       400, duplicate name in the same scope → 409, ids deduped.
 *   (6) BLIND COUNT   — no quantity of ANY kind appears anywhere in a template
 *                       payload. A "last counted 40" on a template row would leak
 *                       exactly what blind counting exists to hide.
 *   (7) SCOPE         — a global template (warehouseId omitted/null) is returned
 *                       when listing for a specific warehouse; a warehouse-pinned
 *                       template is not returned for a different warehouse; brand
 *                       and branch are DERIVED from the warehouse row, as
 *                       inv_stocktakes does.
 *
 * The g-inv.json capability seed is applied exactly as a deploy would, tracking
 * only the rows THIS run inserted so a production-seeded DB is left intact.
 *
 * Run: node tests/integration/stocktakeTemplates.api.test.js
 */
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = Number(process.env.STKT_PORT || 3261);
const BASE = { host: '127.0.0.1', port: PORT };
const T = '/api/inventory/stocktake-templates';

const WH_A = 'ITEST-WH-STKT-A';
const WH_B = 'ITEST-WH-STKT-B';
const BRAND = 'ITEST-BR-STKT';
const BRANCH = 'ITEST-BN-STKT';
const I1 = 'ITEST-STKT-I1', I2 = 'ITEST-STKT-I2', I3 = 'ITEST-STKT-I3', I4 = 'ITEST-STKT-I4';
const ITEMS = [I1, I2, I3, I4];
const U_CASHIER = 'itest_stkt_cashier';
const U_CASHIER2 = 'itest_stkt_cashier2';
const U_MANAGER = 'itest_stkt_manager';
const USERS = [U_CASHIER, U_CASHIER2, U_MANAGER];
const PW = 'ItestStkt#2026!';

let _p = 0, _f = 0; const fails = [];
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; fails.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

function req(method, p, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path: p, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
const login = async (u) => (await req('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';

/** Deep scan for any key that smells like a quantity — the blind-count assertion. */
function findQtyKey(node, trail) {
  const QTY = /(qty|quantity|count(ed)?(_|[A-Z])?qty|stock|onhand|on_hand|variance|snapshot|systemqty)/i;
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) { const h = findQtyKey(node[i], (trail || '') + '[' + i + ']'); if (h) return h; }
    return null;
  }
  for (const k of Object.keys(node)) {
    // itemCount is a LENGTH, not a stock quantity — explicitly not a leak.
    if (k !== 'itemCount' && QTY.test(k)) return (trail || '') + '.' + k;
    const h = findQtyKey(node[k], (trail || '') + '.' + k);
    if (h) return h;
  }
  return null;
}

// ── g-inv capability seed (apply as a deploy would; remove only OUR rows) ─────
const SEED_FILE = path.join(__dirname, '..', '..', 'db', 'migrations', 'capability-seeds', 'g-inv.json');
const SEEDS = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const createdPerms = []; const createdGrants = [];
async function applySeeds() {
  for (const cap of SEEDS) {
    const [ex] = await db.query('SELECT id FROM permissions_v3 WHERE id = ?', [cap.id]);
    if (!ex.length) {
      await db.query('INSERT INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive) VALUES (?,?,?,?,?)',
        [cap.id, 'inventory', cap.label_ar, cap.label_en || '', cap.is_sensitive ? 1 : 0]);
      createdPerms.push(cap.id);
    }
    for (const role of cap.roles) {
      const [g] = await db.query('SELECT 1 FROM role_permissions WHERE role = ? AND permission_id = ?', [role, cap.id]);
      if (!g.length) { await db.query('INSERT INTO role_permissions (role, permission_id) VALUES (?,?)', [role, cap.id]); createdGrants.push([role, cap.id]); }
    }
  }
}
async function removeSeeds() {
  for (const [role, pid] of createdGrants) { try { await db.query('DELETE FROM role_permissions WHERE role = ? AND permission_id = ?', [role, pid]); } catch (_) {} }
  for (const pid of createdPerms) { try { await db.query('DELETE FROM permissions_v3 WHERE id = ?', [pid]); } catch (_) {} }
}

async function cleanup() {
  const sqls = [
    ['DELETE ti FROM inv_stocktake_template_items ti JOIN inv_stocktake_templates t ON t.id = ti.template_id WHERE t.created_by IN (?,?,?)', USERS],
    ['DELETE FROM inv_stocktake_templates WHERE created_by IN (?,?,?)', USERS],
    ['DELETE FROM inv_stocktake_template_items WHERE item_id IN (?,?,?,?)', ITEMS],
    ['DELETE FROM inv_items WHERE id IN (?,?,?,?)', ITEMS],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WH_A, WH_B]],
    ['DELETE FROM users WHERE username IN (?,?,?)', USERS],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
  // brand/branch rows are optional fixtures — remove only if the tables exist
  try { await db.query('DELETE FROM branches WHERE id = ?', [BRANCH]); } catch (_) {}
  try { await db.query('DELETE FROM brands WHERE id = ?', [BRAND]); } catch (_) {}
}

async function seed() {
  await cleanup();
  try { await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [BRAND, 'ITEST علامة']); } catch (_) {}
  try { await db.query('INSERT INTO branches (id, name) VALUES (?,?)', [BRANCH, 'ITEST فرع']); } catch (_) {}
  // brand_id / branch_id on the warehouse are what the route DERIVES from.
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main,brand_id,branch_id) VALUES (?,?,?,?,1,1,?,?)',
    [WH_A, 'ITSTKTA', 'مستودع نماذج أ', 'main', BRAND, BRANCH]);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)',
    [WH_B, 'ITSTKTB', 'مستودع نماذج ب', 'branch']);
  const names = { [I1]: 'أرز بسمتي', [I2]: 'زيت زيتون', [I3]: 'دقيق فاخر', [I4]: 'سكر ناعم' };
  for (const it of ITEMS) {
    await db.query('INSERT INTO inv_items (id,name,name_en,category,unit,big_unit,conv_rate,cost,stock,min_stock,active) VALUES (?,?,?,?,?,?,?,?,?,?,1)',
      [it, names[it], 'EN ' + it, 'خام', 'كجم', 'كرتون', 12, 5, 100, 10]);
  }
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [U_CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [U_CASHIER2, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [U_MANAGER, hash, 'manager']);
  await applySeeds();
}

(async () => {
  console.log('\n═══ نماذج الجرد — saved stocktake templates (CRUD + cashier gate + ownership) ═══\n');
  await seed();
  // WAREHOUSE_SCOPE_ENFORCE=0 isolates the CAPABILITY/OWNERSHIP gates under test
  // from the warehouse ACL (same stance as stocktakePosCashier.api.test.js).
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ══ boot migration actually created the tables ═════════════════════════════
    const [tbls] = await db.query("SHOW TABLES LIKE 'inv_stocktake_template%'");
    check('BOOT MIGRATION: both template tables exist after server boot', tbls.length === 2, tbls);

    const cashier = await login(U_CASHIER);
    const cashier2 = await login(U_CASHIER2);
    const manager = await login(U_MANAGER);
    check('cashier + second cashier + manager authenticate', !!cashier && !!cashier2 && !!manager);

    // ══ (3a) CASHIER CAN LIST — proves the posPortalScope GET entry exists ═════
    const list0 = await req('GET', T, cashier);
    check('CASHIER CAN list templates (posPortalScope GET allow entry present — else 403 PORTAL_FORBIDDEN)',
      list0.status === 200 && list0.body && list0.body.success === true && Array.isArray(list0.body.data),
      { status: list0.status, body: list0.body });
    check('ENVELOPE: list answers { success:true, data:[…] } (NOT a bare array)',
      list0.body && list0.body.success === true && Array.isArray(list0.body.data), list0.body);
    const baseline = (list0.body && list0.body.data || []).length;

    // ══ (1a) CREATE — a cashier saves his periodic count sheet ════════════════
    const created = await req('POST', T, cashier, { name: 'جرد أسبوعي — المخزن', itemIds: [I3, I1, I2] });
    check('CASHIER CAN create a template → 201 (posPortalScope POST allow entry present)',
      created.status === 201 && created.body && created.body.success === true && created.body.data && created.body.data.id,
      { status: created.status, body: created.body });
    const tplId = created.body && created.body.data && created.body.data.id;
    const c = (created.body && created.body.data) || {};
    check('CREATE: name persisted', c.name === 'جرد أسبوعي — المخزن', c.name);
    check('CREATE: itemIds round-trip in the SUBMITTED ORDER (I3, I1, I2 — not re-sorted)',
      JSON.stringify(c.itemIds) === JSON.stringify([I3, I1, I2]), c.itemIds);
    check('CREATE: items hydrated with the LIVE inv_items name + unit + bigUnit/convRate',
      Array.isArray(c.items) && c.items.length === 3 && c.items[0].itemId === I3 &&
      c.items[0].name === 'دقيق فاخر' && c.items[0].unit === 'كجم' &&
      c.items[0].bigUnit === 'كرتون' && Number(c.items[0].convRate) === 12, c.items && c.items[0]);
    check('CREATE: nameEn projected (the English cashier does not see Arabic-only rows)',
      c.items && c.items[0].nameEn === 'EN ' + I3, c.items && c.items[0]);
    check('CREATE: createdBy is taken from the JWT, not the body', c.createdBy === U_CASHIER, c.createdBy);
    check('CREATE: itemCount === items.length', c.itemCount === 3, c.itemCount);
    check('CREATE: canEdit/canDelete true for the owner', c.canEdit === true && c.canDelete === true, { canEdit: c.canEdit, canDelete: c.canDelete });
    check('CREATE: warehouseId null = usable from any till (global template)', c.warehouseId === null, c.warehouseId);

    // ══ (6) BLIND COUNT — no quantity of any kind in the payload ══════════════
    const leak = findQtyKey(created.body, 'create');
    check('BLIND COUNT: the template payload carries NO quantity field of any kind', leak === null, { leakedAt: leak });
    const [tplCols] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('inv_stocktake_templates','inv_stocktake_template_items')");
    const qtyCol = tplCols.map((r) => r.COLUMN_NAME).find((n) => /qty|quantity|stock|variance|snapshot/i.test(n));
    check('BLIND COUNT: neither TABLE even has a quantity column (nothing to leak later)', !qtyCol, { qtyCol });

    // ══ (1b) LIST — the new template shows up, with its items ═════════════════
    const list1 = await req('GET', T, cashier);
    const found = (list1.body && list1.body.data || []).find((x) => x.id === tplId);
    check('LIST: the saved template appears', list1.status === 200 && !!found, { status: list1.status, n: (list1.body && list1.body.data || []).length });
    check('LIST: rows arrive WITH their items hydrated (one call fills the picker)',
      found && Array.isArray(found.items) && found.items.length === 3, found && found.items);
    check('LIST: count grew by exactly one', (list1.body && list1.body.data || []).length === baseline + 1);

    // ══ DETAIL — GET /:id (posPortalScope item-path GET entry) ════════════════
    const detail = await req('GET', `${T}/${tplId}`, cashier);
    check('CASHIER CAN read one template by id → { success, data }',
      detail.status === 200 && detail.body && detail.body.success === true && detail.body.data.id === tplId,
      { status: detail.status, body: detail.body });

    // ══ (1c) RENAME — edit the name only, item set untouched ══════════════════
    const renamed = await req('PUT', `${T}/${tplId}`, cashier, { name: 'جرد الثلاجة — يومي' });
    check('RENAME: PUT with only a name → 200 (posPortalScope PUT allow entry present)',
      renamed.status === 200 && renamed.body && renamed.body.success === true && renamed.body.data.name === 'جرد الثلاجة — يومي',
      { status: renamed.status, body: renamed.body });
    check('RENAME: the item set is UNTOUCHED by a name-only PUT (partial update)',
      JSON.stringify(renamed.body.data.itemIds) === JSON.stringify([I3, I1, I2]), renamed.body.data.itemIds);
    check('RENAME: updatedBy stamped from the JWT', renamed.body.data.updatedBy === U_CASHIER, renamed.body.data.updatedBy);

    // ══ (1d) REPLACE THE ITEM SET — «التعديل عليه» ════════════════════════════
    const replaced = await req('PUT', `${T}/${tplId}`, cashier, { itemIds: [I4, I2] });
    check('REPLACE: PUT with only itemIds → 200 and the set is REPLACED, not merged',
      replaced.status === 200 && JSON.stringify(replaced.body.data.itemIds) === JSON.stringify([I4, I2]),
      { status: replaced.status, itemIds: replaced.body && replaced.body.data && replaced.body.data.itemIds });
    check('REPLACE: the name survives an itemIds-only PUT', replaced.body.data.name === 'جرد الثلاجة — يومي', replaced.body.data.name);
    const [dbItems] = await db.query('SELECT item_id, sort_order FROM inv_stocktake_template_items WHERE template_id = ? ORDER BY sort_order', [tplId]);
    check('REPLACE: the OLD rows are gone from the DB (no orphans left behind)',
      dbItems.length === 2 && dbItems[0].item_id === I4 && dbItems[1].item_id === I2, dbItems);
    check('REPLACE: sort_order persisted 0,1 (order is stored, not incidental)',
      Number(dbItems[0].sort_order) === 0 && Number(dbItems[1].sort_order) === 1, dbItems);

    // ══ (5) VALIDATION ════════════════════════════════════════════════════════
    const badItem = await req('POST', T, cashier, { name: 'نموذج صنف وهمي', itemIds: [I1, 'ITEST-NOPE-999'] });
    check('VALIDATION: an unknown item id → 400 VALIDATION_ERROR (not a silently-dropped line)',
      badItem.status === 400 && badItem.body && badItem.body.code === 'VALIDATION_ERROR', { status: badItem.status, body: badItem.body });
    const emptyItems = await req('POST', T, cashier, { name: 'نموذج فارغ', itemIds: [] });
    check('VALIDATION: empty itemIds → 400', emptyItems.status === 400 && emptyItems.body.code === 'VALIDATION_ERROR', { status: emptyItems.status, body: emptyItems.body });
    const noName = await req('POST', T, cashier, { name: '   ', itemIds: [I1] });
    check('VALIDATION: blank name → 400', noName.status === 400 && noName.body.code === 'VALIDATION_ERROR', { status: noName.status, body: noName.body });
    const dupName = await req('POST', T, cashier, { name: 'جرد الثلاجة — يومي', itemIds: [I1] });
    check('VALIDATION: a duplicate name in the same scope → 409 DUPLICATE_NAME',
      dupName.status === 409 && dupName.body && dupName.body.code === 'DUPLICATE_NAME', { status: dupName.status, body: dupName.body });
    const deduped = await req('POST', T, cashier, { name: 'نموذج مكرر الأصناف', itemIds: [I1, I2, I1, I2, I1] });
    check('VALIDATION: repeated ids are deduped keeping the FIRST position → [I1, I2]',
      deduped.status === 201 && JSON.stringify(deduped.body.data.itemIds) === JSON.stringify([I1, I2]),
      { status: deduped.status, itemIds: deduped.body && deduped.body.data && deduped.body.data.itemIds });
    const dedupId = deduped.body && deduped.body.data && deduped.body.data.id;
    const missing404 = await req('GET', `${T}/STKT-does-not-exist`, cashier);
    check('VALIDATION: an unknown template id → 404 NOT_FOUND', missing404.status === 404 && missing404.body.code === 'NOT_FOUND', { status: missing404.status, body: missing404.body });

    // ══ (7) SCOPE — warehouse pin + brand/branch derivation ═══════════════════
    const pinned = await req('POST', T, cashier, { name: 'جرد مستودع أ', itemIds: [I1, I2], warehouseId: WH_A });
    check('SCOPE: a warehouse-pinned template is created', pinned.status === 201, { status: pinned.status, body: pinned.body });
    const pinnedId = pinned.body && pinned.body.data && pinned.body.data.id;
    check('SCOPE: brand + branch are DERIVED from the warehouse row (matching inv_stocktakes)',
      pinned.body.data.warehouseId === WH_A && pinned.body.data.brandId === BRAND && pinned.body.data.branchId === BRANCH,
      pinned.body.data);
    const listA = await req('GET', `${T}?warehouseId=${WH_A}`, cashier);
    const idsA = (listA.body && listA.body.data || []).map((x) => x.id);
    check('SCOPE: listing for WH-A returns the WH-A template', idsA.indexOf(pinnedId) !== -1, idsA);
    check('SCOPE: …AND the GLOBAL template too (a NULL warehouse is usable from any till)',
      idsA.indexOf(tplId) !== -1, idsA);
    const listB = await req('GET', `${T}?warehouseId=${WH_B}`, cashier);
    const idsB = (listB.body && listB.body.data || []).map((x) => x.id);
    check('SCOPE: listing for WH-B does NOT return the WH-A-pinned template', idsB.indexOf(pinnedId) === -1, idsB);
    check('SCOPE: …but still returns the global one', idsB.indexOf(tplId) !== -1, idsB);

    // ══ (4) OWNERSHIP — another cashier may NOT edit or delete it ═════════════
    const otherEdit = await req('PUT', `${T}/${tplId}`, cashier2, { name: 'اختطاف' });
    check("OWNERSHIP: a cashier CANNOT rename another user's template → 403 PERMISSION_DENIED",
      otherEdit.status === 403 && otherEdit.body && otherEdit.body.code === 'PERMISSION_DENIED', { status: otherEdit.status, body: otherEdit.body });
    const otherDelete = await req('DELETE', `${T}/${tplId}`, cashier2);
    check("OWNERSHIP: a cashier CANNOT delete another user's template → 403 PERMISSION_DENIED",
      otherDelete.status === 403 && otherDelete.body && otherDelete.body.code === 'PERMISSION_DENIED', { status: otherDelete.status, body: otherDelete.body });
    const [survives] = await db.query('SELECT name FROM inv_stocktake_templates WHERE id = ?', [tplId]);
    check('OWNERSHIP: …and the row SURVIVES both attempts, name unchanged',
      survives.length === 1 && survives[0].name === 'جرد الثلاجة — يومي', survives[0]);
    const otherRead = await req('GET', `${T}/${tplId}`, cashier2);
    check("OWNERSHIP: another cashier CAN still READ/USE the template (it is a shared count sheet)",
      otherRead.status === 200 && otherRead.body.data.id === tplId, { status: otherRead.status });
    check('OWNERSHIP: …but canEdit/canDelete come back FALSE for them (UI hides the buttons)',
      otherRead.body.data.canEdit === false && otherRead.body.data.canDelete === false,
      { canEdit: otherRead.body.data.canEdit, canDelete: otherRead.body.data.canDelete });

    // ══ (3b) the cashier CAN delete their OWN template ════════════════════════
    const ownDelete = await req('DELETE', `${T}/${dedupId}`, cashier);
    check('CASHIER CAN delete their OWN template → 200 (posPortalScope DELETE allow entry present)',
      ownDelete.status === 200 && ownDelete.body && ownDelete.body.success === true, { status: ownDelete.status, body: ownDelete.body });
    const [goneRows] = await db.query('SELECT id FROM inv_stocktake_templates WHERE id = ?', [dedupId]);
    const [goneItems] = await db.query('SELECT id FROM inv_stocktake_template_items WHERE template_id = ?', [dedupId]);
    check('DELETE: header AND its item rows are both gone (no orphaned children)',
      goneRows.length === 0 && goneItems.length === 0, { header: goneRows.length, items: goneItems.length });
    const afterDelete = await req('GET', `${T}/${dedupId}`, cashier);
    check('DELETE: a second read of the deleted template → 404', afterDelete.status === 404, { status: afterDelete.status });

    // ══ (4b) a MANAGER can delete someone else's template ═════════════════════
    const mgrEdit = await req('PUT', `${T}/${pinnedId}`, manager, { name: 'جرد مستودع أ (تعديل المدير)' });
    check("MANAGER CAN rename another user's template → 200",
      mgrEdit.status === 200 && mgrEdit.body.data.name === 'جرد مستودع أ (تعديل المدير)', { status: mgrEdit.status, body: mgrEdit.body });
    check('MANAGER: canDelete comes back TRUE for a manager on a template they do not own',
      mgrEdit.body.data.canDelete === true && mgrEdit.body.data.createdBy === U_CASHIER, mgrEdit.body.data);
    const mgrDelete = await req('DELETE', `${T}/${pinnedId}`, manager);
    check("MANAGER CAN delete another user's template → 200 (deleting someone else's is a manager action)",
      mgrDelete.status === 200 && mgrDelete.body.success === true, { status: mgrDelete.status, body: mgrDelete.body });
    const [mgrGone] = await db.query('SELECT id FROM inv_stocktake_templates WHERE id = ?', [pinnedId]);
    check('MANAGER: …and the row really is gone', mgrGone.length === 0, mgrGone);

    // ══ AUTH — no token at all is refused by the global gate ══════════════════
    const anon = await req('GET', T, null);
    check('AUTH: an unauthenticated request is refused (401/403, never 200)',
      anon.status === 401 || anon.status === 403, { status: anon.status, body: anon.body });

    // ══ PORTAL BOUNDARY IS PRECISE, NOT BROAD ════════════════════════════════
    // Everything above proves the ALLOW entries exist. These prove they are
    // ANCHORED and PER-VERB — the boundary is genuinely live on this path family
    // (so the cashier passes above were real, not a hole), and it did not open
    // one verb or one sub-path wider than the routes actually expose.
    const wrongVerb = await req('POST', `${T}/${tplId}`, cashier, { name: 'x' });
    check('BOUNDARY: an UNLISTED verb on the item path (POST) → 403 PORTAL_FORBIDDEN, not 404',
      wrongVerb.status === 403 && wrongVerb.body && wrongVerb.body.reason === 'PORTAL_FORBIDDEN',
      { status: wrongVerb.status, body: wrongVerb.body });
    const deeper = await req('GET', `${T}/${tplId}/items`, cashier);
    check('BOUNDARY: a DEEPER sub-path is not opened by the allowed prefix → 403 PORTAL_FORBIDDEN',
      deeper.status === 403 && deeper.body && deeper.body.reason === 'PORTAL_FORBIDDEN',
      { status: deeper.status, body: deeper.body });
    const mgrDeeper = await req('GET', `${T}/${tplId}/items`, manager);
    check('BOUNDARY: …and that 403 is the CASHIER boundary specifically (a manager gets 404, not 403)',
      mgrDeeper.status === 404, { status: mgrDeeper.status, body: mgrDeeper.body });

  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', (e && e.stack) || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
    try { await removeSeeds(); } catch (_) {}
  }
  console.log(`\n  ${_p} passed, ${_f} failed`);
  if (fails.length) console.log('   failed:', fails.join(' | '));
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
