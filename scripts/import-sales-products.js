#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// v5.11.20 — استيراد مُبَسَّط: المنتجات + المبيعات فقط.
// لا shifts / suppliers / inventory / users / settings.
//
// تَشغيل:  node scripts/import-sales-products.js
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const db = require('../db/connection');

const filePath = process.argv[2] || path.join(__dirname, '..', 'cashier system (5).xlsx');
if (!fs.existsSync(filePath)) {
  console.error('الملف غير موجود:', filePath);
  process.exit(1);
}

console.log('قراءة:', filePath);
const wb = XLSX.readFile(filePath, { cellDates: true });

const toDt = v => v instanceof Date && !isNaN(v) ? v.toISOString().slice(0,19).replace('T',' ') : null;
const num  = (v, d=0) => { const n = Number(v); return isNaN(n) ? d : n; };
const str  = v => v == null ? null : String(v);

// ── 1. المنتجات (Menu) ─────────────────────────────────────────────
const menuRows = XLSX.utils.sheet_to_json(wb.Sheets.Menu || {}, { defval: null });
let menuOk = 0, menuSkip = 0;
(async () => {
  for (const r of menuRows) {
    if (!r.Id || !r.Name) { menuSkip++; continue; }
    const id = 'MNU-' + String(r.Id).replace(/\.0$/, '').replace(/[^A-Za-z0-9-]/g, '');
    try {
      await db.query(
        'INSERT IGNORE INTO menu (id, name, price, category, cost, stock, min_stock, active) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        [id, r.Name, num(r.Price), str(r.Category) || 'عام', num(r.Cost),
         Math.round(num(r.Stock, 999)), Math.round(num(r.MinStock, 5))]
      );
      menuOk++;
    } catch (e) { /* ignore */ }
  }
  console.log(`[menu] أُدخل ${menuOk} منتج (تُخُطِّي ${menuSkip})`);

  // ── 2. المبيعات (Sales) ─────────────────────────────────────────
  const salesRows = XLSX.utils.sheet_to_json(wb.Sheets.Sales || {}, { defval: null })
    .filter(r => r.OrderID);
  let salesOk = 0;
  for (let i = 0; i < salesRows.length; i += 200) {
    const slice = salesRows.slice(i, i + 200);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    const params = [];
    for (const r of slice) {
      params.push(
        String(r.OrderID),
        toDt(r.Date) || toDt(new Date()),
        str(r.ItemsJSON),
        num(r.TotalFinal),
        str(r.PaymentMethod),
        str(r.Username),
        str(r.ShiftID),
        str(r.DiscountName),
        num(r.DiscountAmount)
      );
    }
    try {
      const [res] = await db.query(
        'INSERT IGNORE INTO sales (id, order_date, items_json, total_final, payment_method, username, shift_id, discount_name, discount_amount) ' +
        'VALUES ' + placeholders, params);
      salesOk += res.affectedRows;
    } catch (e) { console.error('  خطأ دفعة مبيعات:', e.message.substring(0, 200)); }
  }
  console.log(`[sales] أُدخل ${salesOk} فاتورة من ${salesRows.length}`);

  // ── 3. بنود المبيعات (SalesItems) ───────────────────────────────
  const itemsRows = XLSX.utils.sheet_to_json(wb.Sheets.SalesItems || {}, { defval: null })
    .filter(r => r.OrderID && r.ItemName);
  let itemsOk = 0;
  for (let i = 0; i < itemsRows.length; i += 500) {
    const slice = itemsRows.slice(i, i + 500);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    const params = [];
    for (const r of slice) {
      params.push(
        String(r.OrderID),
        toDt(r.Date),
        String(r.ItemName),
        Math.round(num(r.Qty, 1)) || 1,
        num(r.Price),
        num(r.Total),
        str(r.Payment),
        str(r.Username),
        str(r.ShiftID)
      );
    }
    try {
      const [res] = await db.query(
        'INSERT IGNORE INTO sales_items (order_id, order_date, item_name, qty, price, total, payment_method, username, shift_id) ' +
        'VALUES ' + placeholders, params);
      itemsOk += res.affectedRows;
    } catch (e) { console.error('  خطأ دفعة بنود:', e.message.substring(0, 200)); }
  }
  console.log(`[sales_items] أُدخل ${itemsOk} بند من ${itemsRows.length}`);

  // ── ملخَّص ───────────────────────────────────────────────────────
  const [[m]] = await db.query('SELECT COUNT(*) AS n FROM menu');
  const [[s]] = await db.query(
    'SELECT COUNT(*) AS cnt, MIN(order_date) AS min_d, MAX(order_date) AS max_d, ' +
    'ROUND(SUM(total_final),2) AS gross FROM sales');
  const [[i]] = await db.query('SELECT COUNT(*) AS n FROM sales_items');

  console.log('\n═══ النتيجة ═══');
  console.log('  المنتجات:    ', m.n);
  console.log('  المبيعات:    ', s.cnt, '(' + s.min_d + ' → ' + s.max_d + ')');
  console.log('  بنود المبيعات:', i.n);
  console.log('  إجمالي:      ', s.gross, 'ريال');

  process.exit(0);
})().catch(e => { console.error('فشل:', e.message); process.exit(1); });
