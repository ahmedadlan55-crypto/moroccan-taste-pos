#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// v5.11.19 — One-shot import from `cashier system (5).xlsx` into the
// current MySQL schema. Idempotent (INSERT IGNORE / REPLACE INTO).
// Master data goes in first (referenced by transactions); big sheets
// (sales / sales_items) stream in batches.
//
// Run from repo root:
//   node scripts/import-cashier-data.js [path/to/file.xlsx]
//
// Skips GL_Accounts / GL_Journals / GL_Entries because their codes
// (1000-9999) are incompatible with the v5.11.8 IFRS chart already
// seeded by /gl/coa/wipe-and-seed.
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const db = require('../db/connection');

const filePath = process.argv[2] || path.join(__dirname, '..', 'cashier system (5).xlsx');
if (!fs.existsSync(filePath)) {
  console.error('File not found:', filePath);
  process.exit(1);
}
console.log('Reading', filePath, '(' + (fs.statSync(filePath).size / 1024 / 1024).toFixed(1) + ' MB)');
const wb = XLSX.readFile(filePath, { cellDates: true });

// ── helpers ────────────────────────────────────────────────────────
function toMysqlDateTime(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  return null;
}
function toMysqlDate(v) {
  const dt = toMysqlDateTime(v);
  return dt ? dt.slice(0, 10) : null;
}
function num(v, def = 0) { const n = Number(v); return isNaN(n) ? def : n; }
function str(v) { return v == null ? null : String(v); }
function bool(v) { if (v == null) return null; return (v === true || v === 'true' || v === 1 || v === '1') ? 1 : 0; }
function normalizeRole(r) {
  // The base schema only allows admin/cashier/manager but migrations
  // extend it. Import as-is; if the user's deployed schema rejects a
  // value, the row is silently skipped via INSERT IGNORE.
  if (!r) return 'cashier';
  return String(r).toLowerCase();
}

// ── single-row importer (small sheets) ─────────────────────────────
async function importSheet(sheetName, tableName, mapper, opts = {}) {
  const sheet = wb.Sheets[sheetName];
  if (!sheet) { console.log(`[${tableName}] sheet "${sheetName}" not found — skip`); return; }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  let inserted = 0, skipped = 0, errors = 0;
  for (const r of rows) {
    let dbRow;
    try { dbRow = mapper(r); } catch (e) { errors++; continue; }
    if (!dbRow) { skipped++; continue; }
    try {
      const cols = Object.keys(dbRow);
      const verb = opts.upsert ? 'REPLACE INTO' : 'INSERT IGNORE INTO';
      await db.query(
        `${verb} ${tableName} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map(c => dbRow[c])
      );
      inserted++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  [${tableName}] err:`, e.message.substring(0, 160));
    }
  }
  console.log(`[${tableName}] inserted=${inserted} skipped=${skipped} errors=${errors} (of ${rows.length})`);
}

// ── batched importer (Sales / SalesItems) ──────────────────────────
async function importSheetBatched(sheetName, tableName, mapper, opts = {}) {
  const sheet = wb.Sheets[sheetName];
  if (!sheet) { console.log(`[${tableName}] sheet "${sheetName}" not found — skip`); return; }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const mapped = [];
  for (const r of rows) {
    try { const m = mapper(r); if (m) mapped.push(m); } catch (e) { /* skip bad row */ }
  }
  if (!mapped.length) { console.log(`[${tableName}] nothing to import`); return; }
  const cols = Object.keys(mapped[0]);
  const batch = opts.batchSize || 500;
  let inserted = 0, batches = 0, errors = 0;
  for (let i = 0; i < mapped.length; i += batch) {
    const slice = mapped.slice(i, i + batch);
    const placeholders = slice.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    const params = [];
    for (const r of slice) for (const c of cols) params.push(r[c]);
    try {
      const [res] = await db.query(
        `INSERT IGNORE INTO ${tableName} (${cols.join(',')}) VALUES ${placeholders}`,
        params
      );
      inserted += res.affectedRows || 0;
      batches++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  [${tableName}] batch err:`, e.message.substring(0, 200));
    }
  }
  console.log(`[${tableName}] inserted=${inserted}/${mapped.length} (${batches} batches of ${batch}, errors=${errors})`);
}

// ── mappers ────────────────────────────────────────────────────────
function mapUsers(r) {
  if (!r.username) return null;
  return {
    username: String(r.username).trim(),
    password: r.password == null ? '' : String(r.password),
    role:     normalizeRole(r.role),
    active:   bool(r.active) == null ? 1 : bool(r.active)
  };
}

function mapSettings(r) {
  if (!r.Setting) return null;
  return { setting_key: String(r.Setting), setting_value: r.Value == null ? '' : String(r.Value) };
}

function mapPaymentMethods(r) {
  if (!r.Name) return null;
  // payment_methods.id is AUTO_INCREMENT — do NOT pass it. INSERT IGNORE
  // skips by name uniqueness… actually the table has no UNIQUE on name,
  // so a re-run would create duplicates. Use REPLACE only when matching
  // exactly: instead check first.
  return {
    name:             String(r.Name),
    name_ar:          str(r.NameAR),
    icon:             str(r.Icon) || 'fa-money-bill',
    is_active:        bool(r.IsActive) == null ? 1 : bool(r.IsActive),
    service_fee_rate: num(r.ServiceFeeRate, 0),
    sort_order:       num(r.SortOrder, 0)
  };
}

function mapDiscounts(r) {
  if (!r.Name) return null;
  // Type in Excel is Arabic ("خصم") — schema expects PERCENT/FIXED.
  // Default to PERCENT; the Value field handles the actual amount.
  return {
    name:  String(r.Name),
    type:  'PERCENT',
    value: num(r.Value, 0)
  };
}

function mapSuppliers(r) {
  if (!r.ID || !r.Name) return null;
  return {
    id:             String(r.ID),
    name:           String(r.Name),
    name_en:        str(r.NameEN),
    vat_number:     str(r.VATNumber),
    phone:          str(r.Phone),
    email:          str(r.Email),
    address:        str(r.Address),
    city:           str(r.City),
    payment_terms:  str(r.PaymentTerms) || 'Cash',
    balance:        num(r.Balance, 0),
    is_active:      bool(r.IsActive) == null ? 1 : bool(r.IsActive),
    created_by:     str(r.CreatedBy),
    updated_by:     str(r.UpdatedBy)
  };
}

function mapInvItems(r) {
  if (!r.ID || !r.Name) return null;
  return {
    id:        String(r.ID),
    name:      String(r.Name),
    category:  str(r.Category),
    cost:      num(r.Cost, 0),
    stock:     num(r.Stock, 0),
    min_stock: num(r.MinStock, 0),
    unit:      str(r.Unit) || 'حبة',
    big_unit:  str(r.BigUnit),
    conv_rate: num(r.ConvRate, 1),
    active:    bool(r.Active) == null ? 1 : bool(r.Active)
  };
}

function mapMenu(r) {
  if (!r.Id || !r.Name) return null;
  // Excel id is numeric (228241.0); convert to a clean string id.
  const idStr = 'MNU-' + String(r.Id).replace(/\.0$/, '').replace(/[^A-Za-z0-9-]/g, '');
  return {
    id:        idStr,
    name:      String(r.Name),
    price:     num(r.Price, 0),
    category:  str(r.Category) || 'عام',
    cost:      num(r.Cost, 0),
    stock:     Math.round(num(r.Stock, 999)),
    min_stock: Math.round(num(r.MinStock, 5)),
    active:    bool(r.Active) == null ? 1 : bool(r.Active)
  };
}

function mapRecipe(r) {
  if (!r.MenuID || !r.InvItemID) return null;
  // Excel MenuID is numeric — must match the same mapping mapMenu uses.
  const menuId = 'MNU-' + String(r.MenuID).replace(/\.0$/, '').replace(/[^A-Za-z0-9-]/g, '');
  return {
    menu_id:        menuId,
    menu_name:      str(r.MenuName),
    inv_item_id:    String(r.InvItemID),
    inv_item_name:  str(r.InvItemName),
    qty_used:       num(r.QtyUsed, 0)
  };
}

function mapShifts(r) {
  if (!r.ShiftID) return null;
  // Schema enum is ('OPEN','closed') — normalize.
  let status = String(r.Status || 'closed').toLowerCase();
  if (status !== 'open' && status !== 'closed') status = 'closed';
  return {
    id:                String(r.ShiftID),
    username:          str(r.Username),
    start_time:        toMysqlDateTime(r.StartTime),
    end_time:          toMysqlDateTime(r.EndTime),
    status:            status === 'open' ? 'OPEN' : 'closed',
    total_theoretical: num(r.TotalTheoretical, 0),
    theoretical_cash:  num(r.TheoreticalCash, 0),
    theoretical_card:  num(r.TheoreticalCard, 0),
    theoretical_kita:  num(r.TheoreticalKita, 0),
    actual_cash:       num(r.ActualCash, 0),
    actual_card:       num(r.ActualCard, 0),
    actual_kita:       num(r.ActualKita, 0),
    diff_cash:         num(r.DiffCash, 0),
    diff_card:         num(r.DiffCard, 0),
    diff_kita:         num(r.DiffKita, 0)
  };
}

function mapPO(r) {
  if (!r.ID) return null;
  return {
    id:                String(r.ID),
    po_number:         str(r.PONumber),
    supplier_id:       str(r.SupplierID),
    supplier_name:     str(r.SupplierName),
    po_date:           toMysqlDate(r.Date),
    expected_date:     toMysqlDate(r.ExpectedDate),
    status:            str(r.Status) || 'draft',
    total_before_vat:  num(r.TotalBeforeVAT, 0),
    vat_amount:        num(r.VATAmount, 0),
    total_after_vat:   num(r.TotalAfterVAT, 0),
    notes:             str(r.Notes),
    created_by:        str(r.CreatedBy),
    approved_by:       str(r.ApprovedBy),
    approved_at:       toMysqlDateTime(r.ApprovedAt)
  };
}

function mapPOLines(r) {
  if (!r.ID || !r.POID) return null;
  return {
    id:           String(r.ID),
    po_id:        String(r.POID),
    item_id:      str(r.ItemID),
    item_name:    str(r.ItemName),
    qty:          num(r.Qty, 0),
    unit_price:   num(r.UnitPrice, 0),
    vat_rate:     num(r.VATRate, 15),
    vat_amount:   num(r.VATAmount, 0),
    total:        num(r.Total, 0),
    received_qty: num(r.ReceivedQty, 0)
  };
}

function mapPurchases(r) {
  if (!r.ID) return null;
  return {
    id:             String(r.ID),
    purchase_date:  toMysqlDateTime(r.Date),
    supplier_name:  str(r.SupplierName),
    supplier_id:    str(r.SupplierName), // Excel doesn't carry supplier_id
    item_name:      str(r.ItemName),
    item_id:        str(r.ItemID),
    qty:            num(r.Qty, 0),
    unit_price:     num(r.UnitPrice, 0),
    total_price:    num(r.TotalPrice, 0),
    payment_method: str(r.PaymentMethod) || 'آجل',
    username:       str(r.Username),
    notes:          str(r.Notes),
    items_json:     str(r.ItemsJSON),
    po_id:          str(r.POID),
    status:         str(r.Status) || 'received'
  };
}

function mapInvMovements(r) {
  if (!r.ID) return null;
  let t = String(r.Type || 'in').toLowerCase();
  if (t !== 'in' && t !== 'out') t = 'in';
  return {
    id:            String(r.ID),
    movement_date: toMysqlDateTime(r.Date),
    item_id:       str(r.ItemID),
    item_name:     str(r.ItemName),
    type:          t,
    qty:           num(r.Qty, 0),
    reason:        str(r.Reason),
    username:      str(r.Username),
    notes:         str(r.Notes)
  };
}

function mapSales(r) {
  if (!r.OrderID) return null;
  return {
    id:              String(r.OrderID),
    order_date:      toMysqlDateTime(r.Date) || toMysqlDateTime(new Date()),
    items_json:      str(r.ItemsJSON),
    total_final:     num(r.TotalFinal, 0),
    payment_method:  str(r.PaymentMethod),
    username:        str(r.Username),
    shift_id:        str(r.ShiftID),
    discount_name:   str(r.DiscountName),
    discount_amount: num(r.DiscountAmount, 0)
  };
}

function mapSalesItems(r) {
  if (!r.OrderID || !r.ItemName) return null;
  return {
    order_id:       String(r.OrderID),
    order_date:     toMysqlDateTime(r.Date),
    item_name:      String(r.ItemName),
    qty:            Math.round(num(r.Qty, 1)) || 1,
    price:          num(r.Price, 0),
    total:          num(r.Total, 0),
    payment_method: str(r.Payment),
    username:       str(r.Username),
    shift_id:       str(r.ShiftID)
  };
}

// ── Verification SQL after import ─────────────────────────────────
async function verify() {
  const tables = ['users','settings','payment_methods','discounts','suppliers',
                  'inv_items','menu','recipe','shifts','purchase_orders','po_lines',
                  'purchases','inventory_movements','sales','sales_items'];
  console.log('\n── Verification ──');
  for (const t of tables) {
    try {
      const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM ${t}`);
      console.log(`  ${t}: ${row.n}`);
    } catch (e) { console.log(`  ${t}: ERROR — ${e.message.substring(0, 80)}`); }
  }
  try {
    const [[row]] = await db.query(
      'SELECT COUNT(*) AS cnt, MIN(order_date) AS first_dt, MAX(order_date) AS last_dt, ' +
      'ROUND(SUM(total_final),2) AS gross FROM sales');
    console.log(`\nSales summary: ${row.cnt} orders · ${row.first_dt} → ${row.last_dt} · gross=${row.gross} SAR`);
  } catch (e) { /* table may be empty */ }
}

// ── main ──────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log('\n── Master data ──');
  await importSheet('Users',           'users',           mapUsers);
  await importSheet('Settings',        'settings',        mapSettings,        { upsert: true });
  await importSheet('Payment_Methods', 'payment_methods', mapPaymentMethods);
  await importSheet('Discounts',       'discounts',       mapDiscounts);
  await importSheet('Suppliers',       'suppliers',       mapSuppliers);
  await importSheet('INV_Items',       'inv_items',       mapInvItems);
  await importSheet('Menu',            'menu',            mapMenu);
  await importSheet('Recipe',          'recipe',          mapRecipe);

  console.log('\n── Transactions ──');
  await importSheet('Shifts',          'shifts',          mapShifts);
  await importSheet('Purchase_Orders', 'purchase_orders', mapPO);
  await importSheet('PO_Lines',        'po_lines',        mapPOLines);
  await importSheet('Purchases',       'purchases',       mapPurchases);
  await importSheet('Inventory',       'inventory_movements', mapInvMovements);

  console.log('\n── Big sheets (batched) ──');
  await importSheetBatched('Sales',      'sales',       mapSales,      { batchSize: 200 });
  await importSheetBatched('SalesItems', 'sales_items', mapSalesItems, { batchSize: 500 });

  await verify();
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
