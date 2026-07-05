/**
 * capabilities.js — seed procurement.* capabilities into permissions_v3 and
 * grant them to roles in role_permissions. Idempotent (INSERT IGNORE).
 *
 * Effective permission at request time = role_permissions ∪ {overrides:grant}
 *                                        \ {overrides:revoke}  (see routes/auth.js).
 *
 * NOTE the admin top-up: the base seeder only grants admin=ALL when
 * role_permissions is empty, so brand-new capabilities would never reach admin.
 * We therefore explicitly grant every procurement.* to admin here.
 */
'use strict';

// [id, is_sensitive, sort_order, label_ar, label_en]
const CAPS = [
  ['procurement.view',              0, 10, 'عرض وحدة المشتريات',        'View procurement'],
  ['procurement.dashboard',         0, 11, 'لوحة معلومات المشتريات',    'Procurement dashboard'],
  ['procurement.reports',           0, 12, 'تقارير المشتريات',          'Procurement reports'],
  ['procurement.data_quality',      1, 13, 'جودة بيانات المشتريات',     'Procurement data quality'],
  ['suppliers.view',                0, 20, 'عرض الموردين',              'View suppliers'],
  ['suppliers.create',              0, 21, 'إنشاء مورد',                'Create supplier'],
  ['suppliers.edit',                0, 22, 'تعديل مورد',                'Edit supplier'],
  ['suppliers.deactivate',          1, 23, 'تعطيل مورد',                'Deactivate supplier'],
  ['purchase_orders.create',        0, 30, 'إنشاء أمر شراء',            'Create purchase order'],
  ['purchase_orders.edit_draft',    0, 31, 'تعديل مسودة أمر شراء',      'Edit draft PO'],
  ['purchase_orders.submit',        0, 32, 'تقديم أمر شراء',            'Submit PO'],
  ['purchase_orders.approve',       1, 33, 'اعتماد أمر شراء',           'Approve PO'],
  ['purchase_orders.cancel',        1, 34, 'إلغاء أمر شراء',            'Cancel PO'],
  ['purchase_orders.close',         1, 35, 'إغلاق أمر شراء',            'Close PO'],
  ['receipts.create',               0, 40, 'إنشاء استلام',              'Create receipt'],
  ['receipts.approve',              1, 41, 'اعتماد استلام',             'Approve receipt'],
  ['receipts.post',                 1, 42, 'ترحيل استلام',              'Post receipt'],
  ['receipts.reverse',              1, 43, 'عكس استلام',                'Reverse receipt'],
  ['supplier_invoices.create',      0, 50, 'إنشاء فاتورة مورد',         'Create supplier invoice'],
  ['supplier_invoices.approve',     1, 51, 'اعتماد فاتورة مورد',        'Approve supplier invoice'],
  ['supplier_invoices.credit',      1, 52, 'إشعار دائن للمورد',         'Supplier credit note'],
  ['payments.request',              0, 60, 'طلب سداد',                  'Request payment'],
  ['payments.authorize',            1, 61, 'اعتماد سداد',               'Authorize payment'],
  ['payments.execute',              1, 62, 'تنفيذ سداد',                'Execute payment'],
  ['payments.close',                1, 63, 'إغلاق سداد',                'Close payment'],
  ['payments.reverse',              1, 64, 'عكس سداد',                  'Reverse payment'],
  ['purchase_returns.create',       0, 70, 'إنشاء مرتجع شراء',          'Create purchase return'],
  ['purchase_returns.approve',      1, 71, 'اعتماد مرتجع شراء',         'Approve purchase return'],
  ['purchase_returns.post',         1, 72, 'ترحيل مرتجع شراء',          'Post purchase return'],
];

// role → list of capability ids (admin handled by top-up below)
const ROLE_GRANTS = {
  manager: CAPS.map((c) => c[0]), // managers get everything
  purchasing: [
    'procurement.view', 'procurement.dashboard', 'procurement.reports',
    'suppliers.view', 'suppliers.create', 'suppliers.edit',
    'purchase_orders.create', 'purchase_orders.edit_draft', 'purchase_orders.submit',
    'receipts.create',
    'supplier_invoices.create',
    'purchase_returns.create',
  ],
  finance: [
    'procurement.view', 'procurement.dashboard', 'procurement.reports', 'procurement.data_quality',
    'suppliers.view',
    'supplier_invoices.create', 'supplier_invoices.approve', 'supplier_invoices.credit',
    'payments.request', 'payments.authorize', 'payments.execute', 'payments.close', 'payments.reverse',
  ],
  inventory: [
    'procurement.view',
    'suppliers.view',
    'receipts.create', 'receipts.approve', 'receipts.post', 'receipts.reverse',
    'purchase_returns.create', 'purchase_returns.approve', 'purchase_returns.post',
  ],
};

async function seedProcurementCapabilities(db, log = () => {}) {
  // 1. catalog
  for (const [id, sensitive, order, ar, en] of CAPS) {
    await db.query(
      `INSERT IGNORE INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive, sort_order)
       VALUES (?, 'procurement', ?, ?, ?, ?)`,
      [id, ar, en, sensitive, order]
    );
  }
  log(`  + ${CAPS.length} procurement capabilities`);

  // 2. admin top-up — always grant admin every procurement capability
  for (const [id] of CAPS) {
    await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)', ['admin', id]);
  }

  // 3. role grants
  for (const [role, ids] of Object.entries(ROLE_GRANTS)) {
    for (const id of ids) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)', [role, id]);
    }
  }
  log('  + role grants (admin/manager/purchasing/finance/inventory)');
  return true;
}

module.exports = { seedProcurementCapabilities, CAPS, ROLE_GRANTS };
