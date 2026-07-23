/**
 * scripts/rc-gate-seed.mjs — Release-Candidate verification-gate seed.
 *
 * Seeds an ISOLATED test database (moroccan_taste_pos_test) with a deterministic,
 * idempotent, RC-prefixed dataset that exercises the full RC surface:
 *   brands · branches · warehouses · 2000 inv_items (with a 400-item missing
 *   name_en range) · item_units (base+major conversion) · warehouse_stock +
 *   item_warehouse_assignments · ~80 menu items (manual + recipe/BOM cost) ·
 *   channel_menu_items · settings.VATRate · RC users across 5 roles.
 *
 * HARD SAFETY: connects ONLY to moroccan_taste_pos_test @ localhost:3306 root/(empty).
 * It runs `SELECT DATABASE()` and ABORTS if the live DB is anything else. It never
 * requires db/connection.js. Everything it creates is `RC-`-prefixed; on each run it
 * deletes existing RC-% rows (children before parents) then re-inserts. The only
 * non-RC writes are the settings.VATRate upsert and reuse of shared `units`/`sales_channels`.
 *
 * Run:  node scripts/rc-gate-seed.mjs
 */
'use strict';

import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

// ── EXPLICIT, HARD-CODED target (never from env, never from db/connection.js) ──
const DB_CONFIG = {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: '',
  database: 'moroccan_taste_pos_test',
  multipleStatements: false,
};
const EXPECTED_DB = 'moroccan_taste_pos_test';

// Shared throwaway password for every RC user (satisfies ≥6 + letter+digit+special).
const RC_PASSWORD = 'RcGate#2026';

// ── deterministic (no Math.random) so reruns are byte-identical ───────────────
let _seed = 987654321;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

const pad4 = (n) => String(n).padStart(4, '0');
const round4 = (n) => Math.round(n * 10000) / 10000;

// Bulk INSERT in chunks (mysql2 placeholder expansion).
async function batchInsert(conn, head, cols, rows, per = 500) {
  if (!rows.length) return 0;
  const one = '(' + Array(cols).fill('?').join(',') + ')';
  let total = 0;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const flat = [];
    for (const r of chunk) flat.push(...r);
    await conn.query(head + ' VALUES ' + chunk.map(() => one).join(','), flat);
    total += chunk.length;
  }
  return total;
}

async function count(conn, sql, params = []) {
  const [[r]] = await conn.query(sql, params);
  return Number(r.n);
}

// ── static reference data ─────────────────────────────────────────────────────
const BRANDS = [
  { id: 'RC-BRAND-1', name: 'الطعم المغربي — علامة أ', name_en: 'Moroccan Taste — Brand A' },
  { id: 'RC-BRAND-2', name: 'الطعم المغربي — علامة ب', name_en: 'Moroccan Taste — Brand B' },
];
const BRANCHES = [
  { id: 'RC-BR-1', name: 'فرع الرياض', name_en: 'Riyadh Branch', brand_id: 'RC-BRAND-1', warehouse_id: 'RC-WH-1' },
  { id: 'RC-BR-2', name: 'فرع جدة', name_en: 'Jeddah Branch', brand_id: 'RC-BRAND-2', warehouse_id: 'RC-WH-2' },
];
const WAREHOUSES = [
  { id: 'RC-WH-1', code: 'RCWH1', name: 'مستودع الرياض الرئيسي', name_en: 'Riyadh Main WH', type: 'main', branch_id: 'RC-BR-1', is_main: 1 },
  { id: 'RC-WH-2', code: 'RCWH2', name: 'مستودع جدة الرئيسي', name_en: 'Jeddah Main WH', type: 'main', branch_id: 'RC-BR-2', is_main: 1 },
  { id: 'RC-WH-3', code: 'RCWH3', name: 'مستودع الرياض الفرعي', name_en: 'Riyadh Secondary WH', type: 'branch', branch_id: 'RC-BR-1', is_main: 0 },
];
// 8 bilingual inv-item categories.
const ITEM_CATS = [
  { id: 'RC-CAT-1', ar: 'لحوم', en: 'Meat' },
  { id: 'RC-CAT-2', ar: 'خضروات', en: 'Vegetables' },
  { id: 'RC-CAT-3', ar: 'بهارات', en: 'Spices' },
  { id: 'RC-CAT-4', ar: 'ألبان', en: 'Dairy' },
  { id: 'RC-CAT-5', ar: 'حبوب', en: 'Grains' },
  { id: 'RC-CAT-6', ar: 'مشروبات', en: 'Beverages' },
  { id: 'RC-CAT-7', ar: 'زيوت', en: 'Oils' },
  { id: 'RC-CAT-8', ar: 'تغليف', en: 'Packaging' },
];
// 6 bilingual menu categories.
const MENU_CATS = [
  { ar: 'أطباق رئيسية', en: 'Main Dishes' },
  { ar: 'مقبلات', en: 'Appetizers' },
  { ar: 'مشروبات', en: 'Beverages' },
  { ar: 'حلويات', en: 'Desserts' },
  { ar: 'سندويشات', en: 'Sandwiches' },
  { ar: 'سلطات', en: 'Salads' },
];
const RC_USERS = [
  { username: 'RC-admin', role: 'admin', brand_id: 'RC-BRAND-1', branch_id: 'RC-BR-1', warehouse_id: 'RC-WH-1' },
  { username: 'RC-manager', role: 'manager', brand_id: 'RC-BRAND-1', branch_id: 'RC-BR-1', warehouse_id: 'RC-WH-1' },
  { username: 'RC-accountant', role: 'accountant', brand_id: 'RC-BRAND-1', branch_id: 'RC-BR-1', warehouse_id: 'RC-WH-1' },
  { username: 'RC-sales', role: 'sales', brand_id: 'RC-BRAND-2', branch_id: 'RC-BR-2', warehouse_id: 'RC-WH-2' },
  { username: 'RC-cashier', role: 'cashier', brand_id: 'RC-BRAND-2', branch_id: 'RC-BR-2', warehouse_id: 'RC-WH-2' },
];

// Volume knobs.
const N_ITEMS = 2000;
const NAME_EN_NULL_FROM = 1601;          // RC-ITEM-1601..2000 have NULL name_en (=400)
const N_ITEM_UNITS_ITEMS = 200;          // items that get base+major item_units rows
const N_STOCK_ITEMS = 800;               // items assigned to warehouses / stock
const N_MENU = 80;
const CHANNEL_ID = 'CH-MAIN';            // reuse an existing sales_channels row
const CHANNEL_ID_2 = 'CH-APP';           // second existing channel (for channelCount variety)

async function cleanup(conn) {
  // children before parents (respect FKs: warehouse_stock/uwa -> warehouses; uwa -> users)
  const stmts = [
    ["DELETE FROM bom_lines WHERE bom_id LIKE 'RC-BOM-%' OR id LIKE 'RC-BL-%'"],
    ["DELETE FROM bom WHERE id LIKE 'RC-BOM-%' OR product_id LIKE 'RC-MENU-%'"],
    ["DELETE FROM recipe WHERE menu_id LIKE 'RC-%'"],
    ["DELETE FROM channel_menu_items WHERE id LIKE 'RC-CMI-%' OR menu_item_id LIKE 'RC-MENU-%'"],
    ["DELETE FROM menu WHERE id LIKE 'RC-MENU-%'"],
    ["DELETE FROM item_units WHERE id LIKE 'RC-IU-%' OR item_id LIKE 'RC-ITEM-%'"],
    ["DELETE FROM item_warehouse_assignments WHERE id LIKE 'RC-IWA-%' OR item_id LIKE 'RC-ITEM-%'"],
    ["DELETE FROM warehouse_stock WHERE id LIKE 'RC-WS-%' OR item_id LIKE 'RC-ITEM-%'"],
    ["DELETE FROM inv_items WHERE id LIKE 'RC-ITEM-%'"],
    ["DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id = uwa.user_id WHERE u.username LIKE 'RC-%'"],
    ["DELETE FROM users WHERE username LIKE 'RC-%'"],
    ["DELETE FROM warehouse_stock WHERE warehouse_id LIKE 'RC-WH-%'"],
    ["DELETE FROM user_warehouse_access WHERE warehouse_id LIKE 'RC-WH-%'"],
    ["DELETE FROM warehouses WHERE id LIKE 'RC-WH-%'"],
    ["DELETE FROM branches WHERE id LIKE 'RC-BR-%'"],
    ["DELETE FROM brands WHERE id LIKE 'RC-BRAND-%'"],
  ];
  for (const [s] of stmts) { try { await conn.query(s); } catch (e) { console.warn('  cleanup skip:', s.slice(0, 48), '→', e.code || e.message); } }
}

async function main() {
  const conn = await mysql.createConnection(DB_CONFIG);

  // ── HARD SAFETY GATE ────────────────────────────────────────────────────────
  const [[{ db: liveDb }]] = await conn.query('SELECT DATABASE() AS db');
  if (liveDb !== EXPECTED_DB) {
    await conn.end();
    throw new Error(`REFUSING TO RUN — connected DB is "${liveDb}", expected "${EXPECTED_DB}". Aborting to protect dev/prod data.`);
  }
  console.log(`\n═══ RC gate seed (DB: ${liveDb}) ═══\n`);

  // Detect optional columns (name_en present on brands/branches/warehouses?).
  const hasCol = async (table, col) =>
    (await count(conn, "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?", [table, col])) > 0;
  const brandsHasNameEn = await hasCol('brands', 'name_en');
  const branchesHasNameEn = await hasCol('branches', 'name_en');
  const whHasNameEn = await hasCol('warehouses', 'name_en');   // (schema has none — handled gracefully)
  const notes = [];
  if (!brandsHasNameEn) notes.push('brands.name_en absent — skipped');
  if (!branchesHasNameEn) notes.push('branches.name_en absent — skipped');
  if (!whHasNameEn) notes.push('warehouses has no name_en column — English WH name skipped (schema has no such column)');

  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  await cleanup(conn);

  // ── 1) settings.VATRate (deterministic tax math) ────────────────────────────
  await conn.query(
    "INSERT INTO settings (setting_key, setting_value) VALUES ('VATRate','15') ON DUPLICATE KEY UPDATE setting_value='15'"
  );

  // ── 2) brands ───────────────────────────────────────────────────────────────
  for (const b of BRANDS) {
    if (brandsHasNameEn) {
      await conn.query('INSERT INTO brands (id, name, name_en, is_active) VALUES (?,?,?,1)', [b.id, b.name, b.name_en]);
    } else {
      await conn.query('INSERT INTO brands (id, name, is_active) VALUES (?,?,1)', [b.id, b.name]);
    }
  }

  // ── 3) branches (brand_id + primary warehouse_id) ───────────────────────────
  for (const br of BRANCHES) {
    if (branchesHasNameEn) {
      await conn.query(
        'INSERT INTO branches (id, name, name_en, type, brand_id, warehouse_id, is_active) VALUES (?,?,?,?,?,?,1)',
        [br.id, br.name, br.name_en, 'branch', br.brand_id, br.warehouse_id]
      );
    } else {
      await conn.query(
        'INSERT INTO branches (id, name, type, brand_id, warehouse_id, is_active) VALUES (?,?,?,?,?,1)',
        [br.id, br.name, 'branch', br.brand_id, br.warehouse_id]
      );
    }
  }

  // ── 4) warehouses (spread across the 2 branches, brand-linked) ──────────────
  for (const w of WAREHOUSES) {
    const brandId = w.branch_id === 'RC-BR-1' ? 'RC-BRAND-1' : 'RC-BRAND-2';
    await conn.query(
      'INSERT INTO warehouses (id, code, name, type, branch_id, brand_id, is_main, is_active) VALUES (?,?,?,?,?,?,?,1)',
      [w.id, w.code, w.name, w.type, w.branch_id, brandId, w.is_main]
    );
  }

  // ── 5) inv_items — EXACTLY 2000 (RC-ITEM-0001..2000) ────────────────────────
  const itemCost = new Map();   // id -> cost (for BOM rollup)
  const itemHasBig = [];        // items with a base 'قطعة' + big 'كرتون' unit (for item_units)
  const itemRows = [];
  for (let i = 1; i <= N_ITEMS; i++) {
    const id = 'RC-ITEM-' + pad4(i);
    const cat = ITEM_CATS[(i - 1) % ITEM_CATS.length];
    const brandId = i % 2 === 0 ? 'RC-BRAND-2' : 'RC-BRAND-1';
    const nameAr = `${cat.ar} صنف ${pad4(i)}`;
    const nameEn = i >= NAME_EN_NULL_FROM ? null : `${cat.en} Item ${pad4(i)}`;   // NULL for RC-ITEM-1601..2000 (=400)
    const cost = round4(2 + ((i % 30) * 0.5));                                    // 2.00 .. 16.50
    itemCost.set(id, cost);
    const hasBig = (i % 5) < 2;                                                   // ~40%
    const unit = hasBig ? 'قطعة' : (i % 2 ? 'كجم' : 'قطعة');
    const bigUnit = hasBig ? 'كرتون' : null;
    const convRate = hasBig ? 12 : 1;
    if (hasBig) itemHasBig.push(id);
    const sku = 'RC-SKU-' + pad4(i);
    const hasBarcode = i % 2 === 0;                                              // ~50%
    const barcode = hasBarcode ? '6290' + String(i).padStart(8, '0') : null;
    const isSellable = i % 3 === 0 ? 0 : 1;
    itemRows.push([
      id, nameAr, nameEn, cat.ar, cat.id, cost, 0, 5, unit, bigUnit, convRate,
      1, 'raw', brandId, sku, sku, barcode, barcode, isSellable, 1, 1,
    ]);
  }
  const itemsInserted = await batchInsert(
    conn,
    'INSERT INTO inv_items (id, name, name_en, category, category_id, cost, stock, min_stock, unit, big_unit, conv_rate, active, kind, brand_id, sku, sku_norm, barcode, barcode_norm, is_sellable, is_inventoried, version)',
    21, itemRows, 500
  );

  // ── 6) item_units — base + major (1 كرتون = 12 قطعة) for a 200-item subset ──
  const iuItems = itemHasBig.slice(0, N_ITEM_UNITS_ITEMS);
  const iuRows = [];
  for (const id of iuItems) {
    // base: قطعة (PCS) conversion 1 ; major: كرتون (BOX) conversion 12
    iuRows.push([`RC-IU-${id}-B`, id, 'PCS', 'قطعة', 'PCS', 1, 1]);
    iuRows.push([`RC-IU-${id}-M`, id, 'BOX', 'كرتون', 'BOX', 0, 12]);
  }
  const iuInserted = await batchInsert(
    conn,
    'INSERT INTO item_units (id, item_id, unit_id, unit_name, unit_code, is_base, conversion_to_base)',
    7, iuRows, 500
  );

  // ── 7) warehouse_stock + item_warehouse_assignments (subset ~800) ───────────
  const wsRows = [];
  const iwaRows = [];
  let twoWhCount = 0;
  for (let i = 1; i <= N_STOCK_ITEMS; i++) {
    const id = 'RC-ITEM-' + pad4(i);
    const cost = itemCost.get(id);
    const primaryWh = i % 2 === 0 ? 'RC-WH-2' : 'RC-WH-1';
    const qty = 10 + (i % 90);
    wsRows.push([`RC-WS-${pad4(i)}-P`, primaryWh, id, qty, cost]);
    iwaRows.push([`RC-IWA-${pad4(i)}-P`, id, primaryWh, 1]);   // is_main = 1
    // every 3rd item also stocked in the secondary warehouse (2-warehouse item)
    if (i % 3 === 0) {
      wsRows.push([`RC-WS-${pad4(i)}-S`, 'RC-WH-3', id, 5 + (i % 25), cost]);
      iwaRows.push([`RC-IWA-${pad4(i)}-S`, id, 'RC-WH-3', 0]);
      twoWhCount++;
    }
  }
  const wsInserted = await batchInsert(
    conn, 'INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost)', 5, wsRows, 500
  );
  const iwaInserted = await batchInsert(
    conn, 'INSERT INTO item_warehouse_assignments (id, item_id, warehouse_id, is_main)', 4, iwaRows, 500
  );

  // ── 8) menu (~80) + BOM recipes for the 'recipe' half ───────────────────────
  const menuRows = [];
  const bomRows = [];
  const bomLineRows = [];
  const cmiRows = [];
  let recipeCount = 0, manualCount = 0, menuNoEn = 0;
  const NAME_EN_NULL_MENU_FROM = N_MENU - 9;   // last 10 menu rows (0071..0080) → NULL name_en

  for (let i = 1; i <= N_MENU; i++) {
    const id = 'RC-MENU-' + pad4(i);
    const cat = MENU_CATS[(i - 1) % MENU_CATS.length];
    const brandId = i % 2 === 0 ? 'RC-BRAND-2' : 'RC-BRAND-1';
    const nameAr = `${cat.ar} صنف ${pad4(i)}`;
    const nameEn = i > NAME_EN_NULL_MENU_FROM ? null : `${cat.en} ${pad4(i)}`;
    if (nameEn === null) menuNoEn++;
    const price = round4(15 + (i % 20) * 2.5);
    const taxCategory = i % 10 === 0 ? 'Z' : 'S';   // mostly standard, a few zero-rated
    const isRecipe = i % 2 === 0;                   // even → recipe, odd → manual

    let cost, computedCost, costSource, bomId = null;
    if (isRecipe) {
      // Build a real BOM: 2 ingredients, waste 0, yield 1 → cost = Σ(qty*ingredientCost)
      bomId = 'RC-BOM-' + pad4(i);
      const ingA = 'RC-ITEM-' + pad4(((i * 3) % 100) + 1);
      const ingB = 'RC-ITEM-' + pad4(((i * 7) % 100) + 51);
      const qtyA = 2, qtyB = 1;
      const rollup = round4(qtyA * itemCost.get(ingA) + qtyB * itemCost.get(ingB));
      bomRows.push([bomId, id, 'menu', 1, 1, 'PCS', `وصفة لـ ${nameAr}`, 1]);
      bomLineRows.push([`RC-BL-${pad4(i)}-A`, bomId, ingA, qtyA, 'PCS', 0]);
      bomLineRows.push([`RC-BL-${pad4(i)}-B`, bomId, ingB, qtyB, 'PCS', 0]);
      cost = rollup; computedCost = rollup; costSource = 'recipe';
      recipeCount++;
    } else {
      cost = round4(6 + (i % 10)); computedCost = cost; costSource = 'manual';
      manualCount++;
    }
    // menu column order per task pattern:
    // (id,name,name_en,category,brand_id,price,cost,cost_source,computed_cost,
    //  tax_category,is_tax_inclusive,active,bom_id,image_data,is_semi_finished,is_deleted)
    menuRows.push([
      id, nameAr, nameEn, cat.ar, brandId, price, cost, costSource, computedCost,
      taxCategory, 1, 1, bomId, null,
    ]);
    // Channel availability — deliberately varied so branchCount/channelCount
    // (COUNT DISTINCT ... WHERE is_available=1) differ across rows for E2E:
    //   • CH-MAIN @ RC-BR-1 : always available.
    //   • CH-MAIN @ RC-BR-2 : available except every 7th item (branchCount → 1 there).
    //   • CH-APP  @ RC-BR-1 : added for even items (channelCount → 2 there).
    cmiRows.push([`RC-CMI-${pad4(i)}-1`, CHANNEL_ID, 'RC-BR-1', id, 1]);
    cmiRows.push([`RC-CMI-${pad4(i)}-2`, CHANNEL_ID, 'RC-BR-2', id, i % 7 === 0 ? 0 : 1]);
    if (i % 2 === 0) cmiRows.push([`RC-CMI-${pad4(i)}-3`, CHANNEL_ID_2, 'RC-BR-1', id, 1]);
  }

  const bomInserted = await batchInsert(
    conn, 'INSERT INTO bom (id, product_id, product_source, version, yield_quantity, yield_unit, notes, is_active)', 8, bomRows, 500
  );
  const bomLinesInserted = await batchInsert(
    conn, 'INSERT INTO bom_lines (id, bom_id, component_item_id, quantity, unit, waste_pct)', 6, bomLineRows, 500
  );
  // menu inserted explicitly because the last 2 columns are literal 0,0 (is_semi_finished,is_deleted)
  let menuCount = 0;
  {
    const per = 500;
    const one = '(' + Array(14).fill('?').join(',') + ',0,0)';
    for (let i = 0; i < menuRows.length; i += per) {
      const chunk = menuRows.slice(i, i + per);
      const flat = [];
      for (const r of chunk) flat.push(...r);
      await conn.query(
        'INSERT INTO menu (id, name, name_en, category, brand_id, price, cost, cost_source, computed_cost, tax_category, is_tax_inclusive, active, bom_id, image_data, is_semi_finished, is_deleted) VALUES ' +
        chunk.map(() => one).join(','),
        flat
      );
      menuCount += chunk.length;
    }
  }

  const cmiInserted = await batchInsert(
    conn, 'INSERT INTO channel_menu_items (id, channel_id, branch_id, menu_item_id, is_available)', 5, cmiRows, 500
  );

  // ── 9) users (5 roles) + user_warehouse_access for manager/sales ────────────
  const hash = await bcrypt.hash(RC_PASSWORD, 12);
  const userIds = {};
  for (const u of RC_USERS) {
    await conn.query(
      `INSERT INTO users
         (username, password, role, active, email, brand_id, branch_id, default_branch_id, default_warehouse_id, can_change_branch, must_change_password)
       VALUES (?,?,?,1,?,?,?,?,?,0,0)`,
      [u.username, hash, u.role, `${u.username}@rc.test`, u.brand_id, u.branch_id, u.branch_id, u.warehouse_id]
    );
    const [[row]] = await conn.query('SELECT id FROM users WHERE username=?', [u.username]);
    userIds[u.username] = row.id;
  }
  // manager → WH-1 & WH-3 ; sales → WH-2
  const uwaRows = [
    [userIds['RC-manager'], 'RC-WH-1', 'RC-seed'],
    [userIds['RC-manager'], 'RC-WH-3', 'RC-seed'],
    [userIds['RC-sales'], 'RC-WH-2', 'RC-seed'],
  ];
  const uwaInserted = await batchInsert(
    conn, 'INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by)', 3, uwaRows, 100
  );

  // ── VERIFY / ACCEPTANCE (throw on any failure) ──────────────────────────────
  const summary = {};
  summary['inv_items (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM inv_items WHERE id LIKE 'RC-ITEM-%'");
  summary['inv_items name_en NULL (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM inv_items WHERE id LIKE 'RC-ITEM-%' AND name_en IS NULL");
  summary['brands (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM brands WHERE id LIKE 'RC-BRAND-%'");
  summary['branches (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM branches WHERE id LIKE 'RC-BR-%'");
  summary['warehouses (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM warehouses WHERE id LIKE 'RC-WH-%'");
  summary['item_units (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM item_units WHERE id LIKE 'RC-IU-%'");
  summary['warehouse_stock (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM warehouse_stock WHERE id LIKE 'RC-WS-%'");
  summary['item_warehouse_assignments (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM item_warehouse_assignments WHERE id LIKE 'RC-IWA-%'");
  summary['warehouse_stock 2-WH items'] = twoWhCount;
  summary['menu (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM menu WHERE id LIKE 'RC-MENU-%'");
  summary['menu recipe (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM menu WHERE id LIKE 'RC-MENU-%' AND cost_source='recipe' AND bom_id IS NOT NULL");
  summary['menu manual (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM menu WHERE id LIKE 'RC-MENU-%' AND cost_source='manual'");
  summary['menu name_en NULL (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM menu WHERE id LIKE 'RC-MENU-%' AND name_en IS NULL");
  summary['bom (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM bom WHERE id LIKE 'RC-BOM-%'");
  summary['bom_lines (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM bom_lines WHERE id LIKE 'RC-BL-%'");
  summary['channel_menu_items (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM channel_menu_items WHERE id LIKE 'RC-CMI-%'");
  summary['users (RC-)'] = await count(conn, "SELECT COUNT(*) AS n FROM users WHERE username LIKE 'RC-%'");
  summary['user_warehouse_access (RC users)'] = await count(conn, "SELECT COUNT(*) AS n FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username LIKE 'RC-%'");
  const rolesPresent = await conn.query("SELECT role FROM users WHERE username LIKE 'RC-%'").then(([r]) => new Set(r.map((x) => x.role)));

  const fails = [];
  const need = (name, cond) => { if (!cond) fails.push(name); };
  need('inv_items RC- == 2000', summary['inv_items (RC-)'] === 2000);
  need('inv_items name_en NULL in [350,450]', summary['inv_items name_en NULL (RC-)'] >= 350 && summary['inv_items name_en NULL (RC-)'] <= 450);
  need('brands RC- >= 2', summary['brands (RC-)'] >= 2);
  need('branches RC- >= 2', summary['branches (RC-)'] >= 2);
  need('warehouses RC- >= 3', summary['warehouses (RC-)'] >= 3);
  need('item_units RC- > 0', summary['item_units (RC-)'] > 0);
  need('warehouse_stock RC- > 0', summary['warehouse_stock (RC-)'] > 0);
  need('item_warehouse_assignments RC- > 0', summary['item_warehouse_assignments (RC-)'] > 0);
  need('menu RC- >= 60', summary['menu (RC-)'] >= 60);
  need('menu recipe (cost_source=recipe AND bom_id) > 0', summary['menu recipe (RC-)'] > 0);
  need('menu manual > 0', summary['menu manual (RC-)'] > 0);
  need('bom header + lines exist', summary['bom (RC-)'] > 0 && summary['bom_lines (RC-)'] > 0);
  need('channel_menu_items RC- > 0', summary['channel_menu_items (RC-)'] > 0);
  need('users RC- has all 5 roles', ['admin', 'manager', 'accountant', 'sales', 'cashier'].every((r) => rolesPresent.has(r)));

  console.log('── Row-count summary ──');
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(38)} ${v}`);
  console.log(`  RC user roles present:                 ${[...rolesPresent].sort().join(', ')}`);
  if (notes.length) { console.log('\n── Schema notes ──'); notes.forEach((n) => console.log('  • ' + n)); }

  await conn.end();

  if (fails.length) {
    console.error('\n❌ ACCEPTANCE FAILED:\n  - ' + fails.join('\n  - '));
    throw new Error('RC gate seed acceptance failed (' + fails.length + ' check(s)).');
  }
  console.log('\n✅ All acceptance checks passed. RC gate DB is seeded.\n');
}

main().catch((e) => { console.error('\nSEED FAILED:', e && e.stack || e); process.exit(1); });
