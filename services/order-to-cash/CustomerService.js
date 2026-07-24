/**
 * services/order-to-cash/CustomerService.js — Customer master (spec §Customer
 * Master + 360). Server-side pagination / search (ar + en + normalized phone +
 * VAT), duplicate detection (never auto-merges), B2C/B2B/B2G, credit
 * limit/terms/days, activate/deactivate. A customer that has ANY sales / AR /
 * payment history can NEVER be hard-deleted — only deactivated. The AR balance is
 * ALWAYS derived (v_customer_ar_balance), never `customers.balance`.
 *
 * Actor is supplied by the route from the JWT — never the request body.
 */
'use strict';

const db = require('../../db/connection');
const { err } = require('../../lib/order-to-cash/errors');

function genId() { return 'CUST-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

/** Normalize a phone to a bare national number for dedupe (drop +966/0 prefixes, spaces, dashes). */
function normalizePhone(input) {
  let s = String(input || '').replace(/[^\d]/g, '');
  if (!s) return '';
  if (s.startsWith('00966')) s = s.slice(5);
  else if (s.startsWith('966')) s = s.slice(3);
  if (s.startsWith('0')) s = s.replace(/^0+/, '');
  return s;
}

const VALID_TYPES = ['B2C', 'B2B', 'B2G'];

function _shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    nameEn: row.name_en || null,
    phone: row.phone || null,
    vatNumber: row.vat_number || null,
    email: row.email || null,
    address: row.address || null,
    city: row.city || null,
    country: row.country || null,
    vatRegistered: row.vat_registered == null ? true : !!Number(row.vat_registered),
    street: row.street || null,
    buildingNumber: row.building_number || null,
    district: row.district || null,
    additionalNo: row.additional_no || null,
    postalCode: row.postal_code || null,
    defaultRevenueAccountId: row.default_revenue_account_id || null,
    defaultRevenueCostCenterId: row.default_revenue_cost_center_id || null,
    customerType: row.customer_type || 'B2C',
    creditLimit: Number(row.credit_limit || 0),
    balance: Number(row.balance || 0),           // legacy manual field (informational only)
    paymentTerms: row.payment_terms || 'Cash',
    creditDays: Number(row.credit_days || 0),
    brandId: row.brand_id || null,
    isActive: !!Number(row.is_active),
    mergedIntoId: row.merged_into_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Derived AR balance (issued − allocated) from the ledger view. */
async function derivedBalance(conn, customerId) {
  const [rows] = await conn.query(
    'SELECT invoiced_total, paid_total, ar_balance FROM v_customer_ar_balance WHERE customer_id = ? LIMIT 1',
    [customerId]);
  const r = rows[0] || {};
  return {
    invoiced: Number(r.invoiced_total || 0),
    paid: Number(r.paid_total || 0),
    arBalance: Number(r.ar_balance || 0),
  };
}

const SORTABLE = { name: 'name', createdAt: 'created_at', creditLimit: 'credit_limit' };

async function list(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const sortCol = SORTABLE[params.sort] || 'name';
  const dir = String(params.dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const where = ['deleted_at IS NULL'];
  const args = [];
  if (params.active === 'true' || params.active === true) where.push('is_active = 1');
  else if (params.active === 'false' || params.active === false) where.push('is_active = 0');
  if (params.type && VALID_TYPES.includes(params.type)) { where.push('customer_type = ?'); args.push(params.type); }
  if (params.brandId) { where.push('brand_id = ?'); args.push(String(params.brandId)); }
  if (params.q) {
    const q = String(params.q).trim();
    const digits = normalizePhone(q);
    const like = '%' + q + '%';
    const clause = ['name LIKE ?', 'name_en LIKE ?', 'vat_number LIKE ?'];
    args.push(like, like, like);
    if (digits) { clause.push("REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+','') LIKE ?"); args.push('%' + digits + '%'); }
    where.push('(' + clause.join(' OR ') + ')');
  }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const [rows] = await db.query(
    `SELECT * FROM customers ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
    args.concat([pageSize, offset]));
  const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM customers ${whereSql}`, args);
  const total = Number(cnt[0].total);
  return {
    data: rows.map(_shape),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

async function get(id, conn = db) {
  const [rows] = await conn.query('SELECT * FROM customers WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw err('NOT_FOUND', 'العميل غير موجود');
  const c = _shape(rows[0]);
  c.derived = await derivedBalance(conn, id);
  return c;
}

/** Find likely duplicates by normalized phone / VAT / exact name (report only, never auto-merge). */
async function detectDuplicates({ phone, vatNumber, name, excludeId } = {}, conn = db) {
  const digits = normalizePhone(phone);
  const clauses = [];
  const args = [];
  if (digits) { clauses.push("REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+','') LIKE ?"); args.push('%' + digits + '%'); }
  if (vatNumber) { clauses.push('vat_number = ?'); args.push(String(vatNumber).trim()); }
  if (name) { clauses.push('name = ?'); args.push(String(name).trim()); }
  if (!clauses.length) return [];
  let sql = `SELECT id, name, phone, vat_number, is_active FROM customers WHERE deleted_at IS NULL AND (${clauses.join(' OR ')})`;
  if (excludeId) { sql += ' AND id <> ?'; args.push(excludeId); }
  const [rows] = await conn.query(sql + ' LIMIT 20', args);
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, vatNumber: r.vat_number, isActive: !!Number(r.is_active) }));
}

function _validate(data, { partial = false } = {}) {
  if (!partial || data.name != null) {
    if (!data.name || !String(data.name).trim()) throw err('VALIDATION_ERROR', 'اسم العميل مطلوب');
  }
  if (data.customerType != null && !VALID_TYPES.includes(data.customerType)) {
    throw err('VALIDATION_ERROR', 'نوع عميل غير صالح (B2C/B2B/B2G)');
  }
  if (data.creditLimit != null && Number(data.creditLimit) < 0) throw err('VALIDATION_ERROR', 'حد الائتمان لا يمكن أن يكون سالبًا');
  if (data.creditDays != null && Number(data.creditDays) < 0) throw err('VALIDATION_ERROR', 'أيام الائتمان لا يمكن أن تكون سالبة');
  // B2B/B2G on credit terms must carry a VAT number for ZATCA B2B invoices —
  // only enforced while the customer is actually marked VAT-registered.
  if (data.vatRegistered !== false && data.customerType && data.customerType !== 'B2C' &&
      data.vatNumber != null && String(data.vatNumber).trim() && !/^\d{15}$/.test(String(data.vatNumber).trim())) {
    throw err('VALIDATION_ERROR', 'رقم ضريبي غير صالح (يجب 15 رقمًا)');
  }
}

async function create(conn, data, actor) {
  _validate(data);
  const dupes = await detectDuplicates({ phone: data.phone, vatNumber: data.vatNumber }, conn);
  if (dupes.length && !data.allowDuplicate) {
    throw err('CUSTOMER_DUPLICATE', 'يوجد عميل مطابق للهاتف/الرقم الضريبي', { duplicates: dupes });
  }
  const id = data.id || genId();
  await conn.query(
    `INSERT INTO customers
       (id, name, name_en, phone, vat_number, email, address, city, country, gender, customer_type,
        credit_limit, balance, payment_terms, credit_days, brand_id, is_active, created_by, updated_by,
        vat_registered, street, building_number, district, additional_no, postal_code,
        default_revenue_account_id, default_revenue_cost_center_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`,
    [id, String(data.name).trim(), data.nameEn || null, data.phone || null, data.vatNumber || null,
     data.email || null, data.address || null, data.city || null, data.country || null, data.gender || 'unknown',
     data.customerType || 'B2C', Number(data.creditLimit || 0),
     data.paymentTerms || 'Cash', Number(data.creditDays || 0), data.brandId || null, actor || '', actor || '',
     data.vatRegistered === false ? 0 : 1, data.street || null, data.buildingNumber || null,
     data.district || null, data.additionalNo || null, data.postalCode || null,
     data.defaultRevenueAccountId || null, data.defaultRevenueCostCenterId || null]);
  return get(id, conn);
}

async function update(conn, id, data, actor) {
  const [cur] = await conn.query('SELECT * FROM customers WHERE id = ? FOR UPDATE', [id]);
  if (!cur.length) throw err('NOT_FOUND', 'العميل غير موجود');
  _validate(data, { partial: true });
  const map = {
    name: 'name', nameEn: 'name_en', phone: 'phone', vatNumber: 'vat_number', email: 'email',
    address: 'address', city: 'city', country: 'country', gender: 'gender', customerType: 'customer_type',
    creditLimit: 'credit_limit', paymentTerms: 'payment_terms', creditDays: 'credit_days', brandId: 'brand_id',
    vatRegistered: 'vat_registered', street: 'street', buildingNumber: 'building_number',
    district: 'district', additionalNo: 'additional_no', postalCode: 'postal_code',
    defaultRevenueAccountId: 'default_revenue_account_id', defaultRevenueCostCenterId: 'default_revenue_cost_center_id',
  };
  const sets = [], args = [];
  for (const [k, col] of Object.entries(map)) {
    if (data[k] !== undefined) { sets.push(`${col} = ?`); args.push(data[k] === '' ? null : data[k]); }
  }
  if (!sets.length) return get(id, conn);
  sets.push('updated_by = ?'); args.push(actor || '');
  args.push(id);
  await conn.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, args);
  return get(id, conn);
}

/** Has the customer any financial footprint (sale, AR doc, or payment)? */
async function hasActivity(conn, id) {
  const [[s]] = [await conn.query('SELECT COUNT(*) AS n FROM sales WHERE customer_id = ? LIMIT 1', [id])];
  if (Number(s[0].n) > 0) return true;
  const [a] = await conn.query('SELECT COUNT(*) AS n FROM ar_documents WHERE customer_id = ? LIMIT 1', [id]);
  if (Number(a[0].n) > 0) return true;
  const [p] = await conn.query('SELECT COUNT(*) AS n FROM customer_payments WHERE customer_id = ? LIMIT 1', [id]);
  return Number(p[0].n) > 0;
}

async function deactivate(conn, id, actor) {
  const [cur] = await conn.query('SELECT id, is_active FROM customers WHERE id = ? FOR UPDATE', [id]);
  if (!cur.length) throw err('NOT_FOUND', 'العميل غير موجود');
  const bal = await derivedBalance(conn, id);
  if (bal.arBalance > 0.01) throw err('VALIDATION_ERROR', 'لا يمكن تعطيل عميل عليه رصيد ذمم مستحق');
  await conn.query('UPDATE customers SET is_active = 0, updated_by = ? WHERE id = ?', [actor || '', id]);
  return get(id, conn);
}

async function activate(conn, id, actor) {
  const [cur] = await conn.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [id]);
  if (!cur.length) throw err('NOT_FOUND', 'العميل غير موجود');
  await conn.query('UPDATE customers SET is_active = 1, updated_by = ? WHERE id = ?', [actor || '', id]);
  return get(id, conn);
}

module.exports = {
  normalizePhone, derivedBalance, list, get, detectDuplicates,
  create, update, deactivate, activate, hasActivity, _shape, VALID_TYPES,
};
