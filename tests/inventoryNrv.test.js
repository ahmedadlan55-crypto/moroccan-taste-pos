#!/usr/bin/env node
'use strict';
/**
 * tests/inventoryNrv.test.js — lower of cost and NRV, and products sold below
 * cost, driven through the REAL router against the live DB.
 *
 * WHAT THIS FILE PINS
 *   1. An inventory item's selling basis is a menu product whose ACTIVE recipe
 *      consumes it; an inactive (draft) recipe, a combo, and an item nobody's
 *      recipe uses are NOT bases. When several products qualify the LOWEST
 *      net selling price wins (prudence) and is named on the row — the choice
 *      moves when a price moves. (The "exactly one line per item" rule cannot
 *      be exercised live: `uq_bom_lines_component` forbids a second line for
 *      the same item on this schema; the route's HAVING COUNT(*) = 1 is the
 *      guard for a schema without that key.)
 *   2. No basis ⇒ nrvUnit / writeDownUnit / writeDown are null and the row is
 *      'no-basis'; totals.writeDown sums basis rows ONLY; noBasisCount counts
 *      the rest.
 *   3. `warehouseId` switches quantity to that warehouse's and cost to its
 *      WAC, and the basis block says so ('warehouse-wac' vs 'item-wac').
 *   4. VAT comes from settings.VATRate — absent ⇒ 422 VAT_RATE_MISSING, never
 *      a silent 15. NrvSellingCostPct is deducted when present, 0 when not.
 *   5. products-below-cost: recipe cost wins only when it came from the recipe
 *      engine and is > 0, else the active BOM's cost; neither ⇒ noCostCount;
 *      soldQty is the analytics daily fact's net units in the window and the
 *      source is NAMED.
 *
 * Fixtures carry the 'NRV-' prefix; cleanup runs before AND after; the two
 * settings rows are put back exactly as found.
 */

const express = require('express');
const db = require('../db/connection');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve().then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function near(a, b, msg) { if (a == null || Math.abs(a - b) > 1e-6) throw new Error(`${msg || ''} — expected ≈${b}, got ${JSON.stringify(a)}`); }

// ── fixtures ────────────────────────────────────────────────────────────────
const WH_A = 'NRV-WH-A', WH_B = 'NRV-WH-B';
const ITEM_BASIS = 'NRV-ITEM-BASIS', ITEM_NOBASIS = 'NRV-ITEM-NOBASIS';
const MENU_1 = 'NRV-MENU-1';   // one-line recipe, base_quantity 2, yield 1 → 2 units per sale
const MENU_2 = 'NRV-MENU-2';   // one-line recipe, base_quantity 2, yield 2 → 1 unit per sale; BOM cost 35
const MENU_3 = 'NRV-MENU-3';   // its only recipe is a DRAFT → never a basis; no cost anywhere
const MENU_4 = 'NRV-MENU-4';   // a combo → excluded entirely
const BR = 'NRV-BR';
const ADMIN = { id: 990601, username: 'nrv_admin', role: 'admin' };
const saved = { VATRate: null, NrvSellingCostPct: null };

async function getSetting(key) {
  const [r] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [key]);
  return r.length ? r[0].setting_value : null;
}
async function setSetting(key, value) {
  if (value == null) { await db.query('DELETE FROM settings WHERE setting_key = ?', [key]); return; }
  await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, value]);
}

async function seed() {
  saved.VATRate = await getSetting('VATRate');
  saved.NrvSellingCostPct = await getSetting('NrvSellingCostPct');
  await setSetting('VATRate', '15');
  await setSetting('NrvSellingCostPct', null);

  for (const [id, code, name] of [[WH_A, 'NRV-A', 'مستودع NRV أ'], [WH_B, 'NRV-B', 'مستودع NRV ب']]) {
    await db.query('INSERT INTO warehouses (id, code, name, is_active) VALUES (?,?,?,1)', [id, code, name]);
  }
  await db.query("INSERT INTO inv_items (id, name, name_en, kind, unit, cost, stock, active, is_inventoried, tracking_mode) VALUES (?,?,?,?,?,?,?,1,1,'none')",
    [ITEM_BASIS, 'دقيق NRV', 'NRV Flour', 'raw', 'كجم', 10, 8]);
  await db.query("INSERT INTO inv_items (id, name, name_en, kind, unit, cost, stock, active, is_inventoried, tracking_mode) VALUES (?,?,?,?,?,?,?,1,1,'none')",
    [ITEM_NOBASIS, 'ملح NRV', 'NRV Salt', 'raw', 'كجم', 4, 7]);
  // Two warehouses for the basis item with DIFFERENT costs, so the warehouse
  // filter is provably reading the warehouse WAC and not the item cost.
  for (const [id, wh, item, qty, cost] of [
    ['NRV-WS-A-BASIS', WH_A, ITEM_BASIS, 5, 12],
    ['NRV-WS-B-BASIS', WH_B, ITEM_BASIS, 3, 8],
    ['NRV-WS-A-NOBASIS', WH_A, ITEM_NOBASIS, 7, 4],
  ]) {
    await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, avg_cost, last_cost) VALUES (?,?,?,?,?,?)', [id, wh, item, qty, cost, cost]);
  }
  for (const [id, name, nameEn, price, cost, costSource, combo] of [
    [MENU_1, 'خبز NRV', 'NRV Bread', 46, 0, 'manual', 0],
    [MENU_2, 'كعكة NRV', 'NRV Cake', 34.5, 50, 'manual', 0],
    [MENU_3, 'مزدوج NRV', 'NRV Double', 1.15, 0, null, 0],
    [MENU_4, 'كومبو NRV', 'NRV Combo', 1.15, 0, null, 1],
  ]) {
    await db.query("INSERT INTO menu (id, name, name_en, price, cost, active, is_deleted, is_combo, tax_category, is_tax_inclusive, cost_source) VALUES (?,?,?,?,?,1,0,?,'S',1,?)",
      [id, name, nameEn, price, cost, combo, costSource]);
  }
  // BOM-3 is a DRAFT (is_active 0, status 'draft'): a recipe nobody approved
  // is not a selling basis, however cheap its product.
  for (const [id, product, yieldQ, costPerUnit, active, status] of [
    ['NRV-BOM-1', MENU_1, 1, null, 1, 'active'],
    ['NRV-BOM-2', MENU_2, 2, 35, 1, 'active'],
    ['NRV-BOM-3', MENU_3, 1, null, 0, 'draft'],
    ['NRV-BOM-4', MENU_4, 1, null, 1, 'active'],
  ]) {
    await db.query("INSERT INTO bom (id, product_id, product_source, version, yield_quantity, yield_unit, is_active, status, cost_per_unit) VALUES (?,?,'menu',1,?,'PCS',?,?,?)",
      [id, product, yieldQ, active, status, costPerUnit]);
  }
  for (const [id, bom, qty, base, lineNo] of [
    ['NRV-BL-1', 'NRV-BOM-1', 2, 2, 1],
    // quantity 1 but base_quantity 2: the report must read base_quantity
    ['NRV-BL-2', 'NRV-BOM-2', 1, 2, 1],
    ['NRV-BL-3', 'NRV-BOM-3', 1, 1, 1],
    ['NRV-BL-4', 'NRV-BOM-4', 1, 1, 1],
  ]) {
    await db.query("INSERT INTO bom_lines (id, bom_id, component_item_id, quantity, unit, base_quantity, line_no, conversion_factor) VALUES (?,?,?,?,'PCS',?,?,1)",
      [id, bom, ITEM_BASIS, qty, base, lineNo]);
  }
}

async function cleanup() {
  await db.query('DELETE FROM analytics_daily_item WHERE branch_id = ?', [BR]).catch(() => {});
  await db.query("DELETE FROM bom_lines WHERE bom_id LIKE 'NRV-%'").catch(() => {});
  await db.query("DELETE FROM bom WHERE id LIKE 'NRV-%'").catch(() => {});
  await db.query("DELETE FROM menu WHERE id LIKE 'NRV-%'").catch(() => {});
  await db.query("DELETE FROM warehouse_stock WHERE id LIKE 'NRV-%' OR item_id LIKE 'NRV-%'").catch(() => {});
  await db.query("DELETE FROM inv_items WHERE id LIKE 'NRV-%'").catch(() => {});
  await db.query("DELETE FROM warehouses WHERE id LIKE 'NRV-%'").catch(() => {});
}
async function restoreSettings() {
  await setSetting('VATRate', saved.VATRate).catch(() => {});
  await setSetting('NrvSellingCostPct', saved.NrvSellingCostPct).catch(() => {});
}

function buildApp(withUser) {
  const app = express();
  app.use((req, _res, next) => {
    if (withUser) req.user = { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role };
    req.requestId = 'test';
    next();
  });
  app.use('/api/erp', require('../routes/erp/reports/inventoryValue'));
  return app;
}

async function main() {
  await cleanup();
  await seed();
  const server = buildApp(true).listen(0);
  const anon = buildApp(false).listen(0);
  await Promise.all([server, anon].map((s) => new Promise((r) => s.once('listening', r))));
  const base = `http://127.0.0.1:${server.address().port}`;
  const anonBase = `http://127.0.0.1:${anon.address().port}`;
  const get = async (p, root) => {
    const res = await fetch((root || base) + p);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const NRV = '/api/erp/reports/inventory-value/nrv';
  const BELOW = '/api/erp/reports/inventory-value/products-below-cost';

  try {
    console.log('\n1. the selling basis and the prudence rule');
    await test('the lowest NET price is the basis, and it is named', async () => {
      // MENU_1: 46 incl → 40 net; MENU_2: 34.5 incl → 30 net → the basis.
      // MENU_3 (draft recipe, net 1) and MENU_4 (combo, net 1) would be
      // cheaper still: they must NOT be picked.
      const r = await get(NRV);
      eq(r.status, 200, 'nrv answers');
      const row = r.json.data.find((x) => x.itemId === ITEM_BASIS);
      ok(row, 'the stocked item is a row');
      eq(row.basisSource, 'menu:' + MENU_2, 'basis');
      eq(row.basisProductName, 'كعكة NRV', 'named');
      near(row.netSellingPrice, 30, 'VAT stripped at settings rate');
      near(row.unitsPerSale, 1, 'base_quantity 2 ÷ yield 2');
      near(row.nrvUnit, 30, 'nrv per unit');
      near(row.quantity, 8, 'quantity summed over warehouses');
      near(row.unitCost, 10, 'item WAC without a warehouse');
      eq(row.writeDownUnit, 0, 'NRV above cost ⇒ clamped to 0, not a write-up');
      eq(row.status, 'ok');
      eq(r.json.basis.costSource, 'item-wac');
      eq(r.json.basis.vatRatePct, 15);
      eq(r.json.basis.sellingCostPct, 0, 'absent pct reported as 0');
    });
    await test('an item no recipe uses is no-basis with NULLS, never 0', async () => {
      const r = await get(NRV);
      const row = r.json.data.find((x) => x.itemId === ITEM_NOBASIS);
      ok(row, 'present');
      eq(row.status, 'no-basis');
      eq(row.basisSource, null);
      eq(row.nrvUnit, null);
      eq(row.writeDownUnit, null);
      eq(row.writeDown, null);
      near(row.inventoryValue, 28, 'carrying value still stated');
      ok(r.json.totals.noBasisCount >= 1, 'counted');
      // The whole set, whatever else the DB holds: the total write-down is
      // the sum over basis rows only, and rows without one are counted.
      const basisRows = r.json.data.filter((x) => x.basisSource != null);
      near(r.json.totals.writeDown, Number(basisRows.reduce((a, x) => a + x.writeDown, 0).toFixed(2)), 'writeDown sums basis rows only');
      eq(r.json.totals.noBasisCount, r.json.data.length - basisRows.length, 'noBasisCount = rows without a basis');
      eq(r.json.totals.items, r.json.data.length);
    });
    await test('the basis MOVES when a cheaper product qualifies', async () => {
      // MENU_1 drops to 11.5 incl → 10 net, below MENU_2's 30 → now the basis.
      await db.query('UPDATE menu SET price = 11.5 WHERE id = ?', [MENU_1]);
      const r = await get(NRV);
      const row = r.json.data.find((x) => x.itemId === ITEM_BASIS);
      eq(row.basisSource, 'menu:' + MENU_1, 'basis moved');
      eq(row.basisProductName, 'خبز NRV');
      near(row.unitsPerSale, 2, 'base_quantity 2 ÷ yield 1');
      near(row.nrvUnit, 5, '10 ÷ 2');
      near(row.writeDownUnit, 5, '10 − 5');
      near(row.writeDown, 40, '5 × 8');
      eq(row.status, 'impaired');
      ok(r.json.totals.impairedItems >= 1);
    });

    console.log('\n2. the warehouse filter switches to warehouse WAC');
    await test('warehouseId=A: that warehouse\'s quantity and WAC, totals exact', async () => {
      const r = await get(NRV + '?warehouseId=' + WH_A);
      eq(r.status, 200);
      eq(r.json.basis.costSource, 'warehouse-wac');
      eq(r.json.data.length, 2, 'only the two NRV items live there');
      const b = r.json.data.find((x) => x.itemId === ITEM_BASIS);
      const n = r.json.data.find((x) => x.itemId === ITEM_NOBASIS);
      near(b.quantity, 5); near(b.unitCost, 12, 'warehouse WAC, not item cost');
      near(b.writeDownUnit, 7, '12 − 5'); near(b.writeDown, 35, '7 × 5');
      near(n.quantity, 7); near(n.unitCost, 4); eq(n.writeDown, null);
      eq(r.json.totals.items, 2); eq(r.json.totals.itemsWithBasis, 1);
      eq(r.json.totals.noBasisCount, 1); eq(r.json.totals.impairedItems, 1);
      near(r.json.totals.inventoryValue, 60 + 28); near(r.json.totals.writeDown, 35, 'basis rows only');
    });
    await test('warehouseId=B: the no-basis item has no stock there and is absent', async () => {
      const r = await get(NRV + '?warehouseId=' + WH_B);
      eq(r.json.data.length, 1);
      const b = r.json.data[0];
      near(b.quantity, 3); near(b.unitCost, 8); near(b.writeDownUnit, 3); near(b.writeDown, 9);
      eq(r.json.totals.noBasisCount, 0); near(r.json.totals.writeDown, 9);
    });
    await test('an unknown warehouse is refused, not answered empty', async () => {
      const r = await get(NRV + '?warehouseId=NRV-NOPE');
      eq(r.status, 422); eq(r.json.code, 'WAREHOUSE_NOT_FOUND');
    });

    console.log('\n3. settings govern; nothing is hardcoded');
    await test('NrvSellingCostPct is deducted and reported', async () => {
      await setSetting('NrvSellingCostPct', '10');
      const r = await get(NRV + '?warehouseId=' + WH_B);
      eq(r.json.basis.sellingCostPct, 10);
      near(r.json.data[0].nrvUnit, 4.5, '10 × 0.9 ÷ 2');
      near(r.json.data[0].writeDownUnit, 3.5, '8 − 4.5');
      near(r.json.totals.writeDown, 10.5, '3.5 × 3');
      await setSetting('NrvSellingCostPct', null);
    });
    await test('a different VAT rate changes the answer (no literal 15)', async () => {
      await setSetting('VATRate', '10');
      const r = await get(NRV + '?warehouseId=' + WH_B);
      eq(r.json.basis.vatRatePct, 10);
      // The row carries money at 4 dp, so compare against the rounded figure.
      near(r.json.data[0].netSellingPrice, Number((11.5 / 1.1).toFixed(4)), 'stripped at 10%');
      await setSetting('VATRate', '15');
    });
    await test('a missing VATRate is 422 VAT_RATE_MISSING on both reports', async () => {
      await setSetting('VATRate', null);
      try {
        const a = await get(NRV);
        eq(a.status, 422, 'nrv'); eq(a.json.code, 'VAT_RATE_MISSING');
        const b = await get(BELOW);
        eq(b.status, 422, 'below-cost'); eq(b.json.code, 'VAT_RATE_MISSING');
      } finally {
        await setSetting('VATRate', '15');
      }
    });

    console.log('\n4. products sold below cost');
    await test('cost precedence: recipe > BOM; no cost ⇒ counted, not listed; combo excluded', async () => {
      // MENU_1: net 10, recipe cost 12 (its BOM has no cost) → 'recipe'
      await db.query("UPDATE menu SET cost = 12, cost_source = 'recipe' WHERE id = ?", [MENU_1]);
      const r = await get(BELOW);
      eq(r.status, 200);
      const one = r.json.data.find((x) => x.menuId === MENU_1);
      const two = r.json.data.find((x) => x.menuId === MENU_2);
      ok(one, 'MENU_1 listed'); ok(two, 'MENU_2 listed');
      eq(one.costSource, 'recipe'); near(one.unitCost, 12); near(one.shortfallUnit, 2); near(one.marginPct, -20);
      // MENU_2: cost_source manual ⇒ menu.cost 50 is NOT a recipe cost ⇒ BOM 35 vs net 30
      eq(two.costSource, 'bom'); near(two.unitCost, 35); near(two.shortfallUnit, 5);
      eq(one.status, 'below-cost');
      ok(!r.json.data.some((x) => x.menuId === MENU_3), 'no cost anywhere ⇒ not a row');
      ok(r.json.totals.noCostCount >= 1, 'but counted');
      ok(!r.json.data.some((x) => x.menuId === MENU_4), 'a combo is never a product row');
      eq(r.json.totals.products, r.json.data.length);
      eq(r.json.basis.days, 30);
    });
    await test('soldQty is the analytics fact\'s net units in the window; the source is named', async () => {
      await db.query('INSERT INTO analytics_daily_item (business_day, branch_id, menu_id, qty_sold, qty_returned) VALUES (CURDATE(), ?, ?, 4, 1)', [BR, MENU_1]);
      await db.query('INSERT INTO analytics_daily_item (business_day, branch_id, menu_id, qty_sold, qty_returned) VALUES (DATE_SUB(CURDATE(), INTERVAL 40 DAY), ?, ?, 100, 0)', [BR, MENU_1]);
      const r = await get(BELOW + '?days=30');
      eq(r.json.basis.salesSource, 'analytics_daily_item');
      const one = r.json.data.find((x) => x.menuId === MENU_1);
      near(one.soldQty, 3, '4 sold − 1 returned; the 40-day-old row is outside the window');
      near(one.exposure, 6, '2 × 3');
      const two = r.json.data.find((x) => x.menuId === MENU_2);
      eq(two.soldQty, 0, 'the source exists and records no sales');
      eq(two.exposure, 0);
      ok(r.json.totals.exposure >= 6, 'exposure summed');
      const wide = await get(BELOW + '?days=60');
      near(wide.json.data.find((x) => x.menuId === MENU_1).soldQty, 103, 'a wider window includes the old row');
    });
    await test('days is validated', async () => {
      const r = await get(BELOW + '?days=0');
      eq(r.status, 422); eq(r.json.code, 'VALIDATION_ERROR');
      const s = await get(BELOW + '?days=abc');
      eq(s.status, 422);
    });

    console.log('\n5. the guard');
    await test('no user ⇒ 401 on both reports', async () => {
      const a = await get(NRV, anonBase); eq(a.status, 401); eq(a.json.code, 'PERMISSION_DENIED');
      const b = await get(BELOW, anonBase); eq(b.status, 401);
    });
  } finally {
    server.close();
    anon.close();
    await cleanup();
    await restoreSettings();
    await db.end?.().catch?.(() => {});
  }

  console.log(`\n${_passed}/${_total} passed${_failed ? `, ${_failed} failed` : ''}`);
  if (_failed) process.exit(1);
  console.log('  ✅ NRV: prudent basis named; no-basis is null; warehouse WAC honoured; VAT from settings; below-cost precedence + named sales source');
  process.exit(0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
