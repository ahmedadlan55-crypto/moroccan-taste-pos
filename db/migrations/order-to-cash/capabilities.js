/**
 * capabilities.js — seed o2c.* capabilities into permissions_v3 and grant them to
 * roles in role_permissions. Idempotent (INSERT IGNORE). Effective permission at
 * request time = role_permissions ∪ {overrides:grant} \ {overrides:revoke}.
 *
 * Admin top-up: the base seeder only grants admin=ALL when role_permissions is
 * empty, so we explicitly grant every o2c.* to admin here. The cashier role gets
 * ONLY create-level sales/customer capabilities — never approve/post/reverse/
 * deactivate/merge/credit.override (spec §15).
 */
'use strict';

// [id, is_sensitive, sort_order, label_ar, label_en]
const CAPS = [
  ['o2c.view',              0, 10, 'عرض المبيعات والعملاء',      'View sales & customers'],
  ['o2c.dashboard.view',    0, 11, 'لوحة المبيعات',              'Sales dashboard'],
  ['ar_reports.view',       0, 12, 'تقارير الذمم والمبيعات',     'AR & sales reports'],
  ['o2c.export',            0, 13, 'تصدير بيانات المبيعات',      'Export sales data'],
  ['o2c.data_quality',      1, 14, 'جودة بيانات المبيعات',       'Sales data quality'],
  ['customers.view',        0, 20, 'عرض العملاء',                'View customers'],
  ['customers.create',      0, 21, 'إنشاء عميل',                 'Create customer'],
  ['customers.edit',        0, 22, 'تعديل عميل',                 'Edit customer'],
  ['customers.deactivate',  1, 23, 'تعطيل عميل',                 'Deactivate customer'],
  ['customers.merge',       1, 24, 'دمج عملاء مكررين',           'Merge customers'],
  ['sales_orders.view',     0, 30, 'عرض أوامر البيع',            'View sales orders'],
  ['sales_orders.create',   0, 31, 'إنشاء أمر بيع',              'Create sales order'],
  ['sales_orders.confirm',  0, 32, 'تأكيد أمر بيع',              'Confirm sales order'],
  ['sales_orders.fulfill',  1, 33, 'تنفيذ أمر بيع',              'Fulfill sales order'],
  ['invoices.view',         0, 40, 'عرض فواتير العملاء',         'View customer invoices'],
  ['invoices.create',       0, 41, 'إنشاء فاتورة عميل',          'Create customer invoice'],
  ['invoices.issue',        1, 42, 'إصدار فاتورة عميل',          'Issue customer invoice'],
  ['credit.override',       1, 43, 'تجاوز حد الائتمان',          'Credit limit override'],
  ['payments.view',         0, 50, 'عرض التحصيلات',              'View collections'],
  ['payments.create',       0, 51, 'إنشاء سند قبض',              'Create collection'],
  ['payments.approve',      1, 52, 'اعتماد سند قبض',             'Approve collection'],
  ['payments.post',         1, 53, 'ترحيل سند قبض',              'Post collection'],
  ['payments.reverse',      1, 54, 'عكس سند قبض',                'Reverse collection'],
  ['returns.view',          0, 60, 'عرض مرتجعات البيع',          'View sales returns'],
  ['returns.create',        0, 61, 'إنشاء مرتجع بيع',            'Create sales return'],
  ['returns.approve',       1, 62, 'اعتماد مرتجع بيع',           'Approve sales return'],
  ['returns.post',          1, 63, 'ترحيل مرتجع بيع',            'Post sales return'],
  ['returns.reverse',       1, 64, 'عكس مرتجع بيع',              'Reverse sales return'],
  // Cancel was guarded by returns.create, so a cashier could cancel a return a
  // manager had already APPROVED — an approval-level act behind a create-level
  // gate, against this file's own cashier rule.
  ['returns.cancel',        1, 65, 'إلغاء مرتجع بيع',            'Cancel sales return'],
  // Deciding that goods physically go BACK ON THE SHELF is not a clerical act:
  // it moves stock and reverses COGS. A cashier may create a return (they are
  // the one holding the item) but may not rule that a prepared meal is
  // resellable — that is the manager's call, and it needs a reason on record.
  // Absent from cashier/sales below; `manager: CAPS.map(...)` grants it there.
  ['returns.restock',       1, 66, 'إقرار إعادة مرتجع للمخزون',   'Authorise return restock'],
];

// role → capability ids (admin handled by top-up)
const ROLE_GRANTS = {
  manager: CAPS.map((c) => c[0]),
  cashier: [
    'o2c.view', 'o2c.dashboard.view',
    'customers.view', 'customers.create', 'customers.edit',
    'sales_orders.view', 'sales_orders.create',
    'invoices.view', 'invoices.create',
    'payments.view', 'payments.create',
    'returns.view', 'returns.create',
  ],
  sales: [
    'o2c.view', 'o2c.dashboard.view', 'ar_reports.view',
    'customers.view', 'customers.create', 'customers.edit',
    'sales_orders.view', 'sales_orders.create', 'sales_orders.confirm',
    'invoices.view', 'invoices.create',
    'payments.view', 'payments.create',
    'returns.view', 'returns.create',
  ],
  accountant: [
    'o2c.view', 'o2c.dashboard.view', 'ar_reports.view', 'o2c.export', 'o2c.data_quality',
    'customers.view',
    'invoices.view', 'invoices.create', 'invoices.issue',
    'credit.override',
    'payments.view', 'payments.create', 'payments.approve', 'payments.post', 'payments.reverse',
    'returns.view', 'returns.approve', 'returns.post', 'returns.reverse', 'returns.cancel',
    'returns.restock',
  ],
  finance: [
    'o2c.view', 'o2c.dashboard.view', 'ar_reports.view', 'o2c.export', 'o2c.data_quality',
    'customers.view',
    'invoices.view', 'invoices.issue', 'credit.override',
    'payments.view', 'payments.approve', 'payments.post', 'payments.reverse',
    'returns.approve', 'returns.post', 'returns.reverse', 'returns.cancel', 'returns.restock',
  ],
};

async function seedO2CCapabilities(db, log = () => {}) {
  for (const [id, sensitive, order, ar, en] of CAPS) {
    await db.query(
      `INSERT IGNORE INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive, sort_order)
       VALUES (?, 'order_to_cash', ?, ?, ?, ?)`,
      [id, ar, en, sensitive, order]);
  }
  log(`  + ${CAPS.length} order-to-cash capabilities`);
  for (const [id] of CAPS) {
    await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)', ['admin', id]);
  }
  for (const [role, ids] of Object.entries(ROLE_GRANTS)) {
    for (const id of ids) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)', [role, id]);
    }
  }
  log('  + role grants (admin/manager/cashier/sales/accountant/finance)');
  return true;
}

module.exports = { seedO2CCapabilities, CAPS, ROLE_GRANTS };
