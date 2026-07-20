/**
 * capabilities.js — seed finance.* / hr.payroll.* / zatca.* capabilities into
 * permissions_v3 and grant them to roles in role_permissions. Idempotent
 * (INSERT IGNORE). Mirrors db/migrations/procurement/capabilities.js.
 *
 * FC-P1 (Final Closure Sprint): these caps are ENFORCED by requireCapability
 * on the GL / cash / payroll / ZATCA routes — they are no longer a dormant
 * catalog. Effective permission = role_permissions ∪ {override:grant}
 * \ {override:revoke}; admin + developer bypass inside the middleware.
 */
'use strict';

// [id, is_sensitive, sort_order, label_ar, label_en]
const CAPS = [
  // ── General Ledger ──
  ['finance.gl.view',          0, 110, 'عرض القيود ودليل الحسابات',   'View GL journals & accounts'],
  ['finance.gl.create',        0, 111, 'إنشاء/تعديل قيد يومية',       'Create/edit GL journal'],
  ['finance.gl.approve',       1, 112, 'اعتماد قيد يومية',            'Approve GL journal'],
  ['finance.gl.post',          1, 113, 'ترحيل قيد يومية',             'Post GL journal'],
  ['finance.gl.reverse',       1, 114, 'عكس قيد مُرحَّل',             'Reverse posted GL journal'],
  ['finance.accounts.manage',  1, 115, 'إدارة دليل الحسابات',         'Manage chart of accounts'],
  // ── Cash / vouchers ──
  ['finance.cash.approve',     1, 120, 'اعتماد سندات القبض/الصرف',    'Approve cash vouchers'],
  ['finance.cash.close',       1, 121, 'إقفال الصندوق',               'Close cashbox'],
  // ── Bank reconciliation ──
  ['finance.bankrec.view',     0, 130, 'عرض التسويات البنكية',        'View bank reconciliation'],
  ['finance.bankrec.manage',   0, 131, 'إدارة التسويات البنكية',      'Manage bank reconciliation'],
  ['finance.bankrec.close',    1, 132, 'إقفال تسوية بنكية',           'Close bank reconciliation'],
  // ── Payroll (approve/pay on top of the existing hr.payroll.view/run) ──
  ['hr.payroll.approve',       1, 140, 'اعتماد مسير الرواتب',         'Approve payroll run'],
  ['hr.payroll.pay',           1, 141, 'صرف مسير الرواتب',            'Pay payroll run'],
  // ── ZATCA phase-2 credentials ──
  ['zatca.manage',             1, 150, 'إدارة ربط هيئة الزكاة (فوترة)', 'Manage ZATCA onboarding'],
  // ── Workflow builder (definitions / positions / routes DSL) ──
  ['workflow.manage',          1, 160, 'إدارة مسارات الاعتماد',       'Manage approval workflows'],
  // ── Financial reports (Trial Balance, P&L, Balance Sheet, ...) ──
  // Tier A COA/Trial Balance overhaul — this id already existed and was
  // enforced (see routes/erp/reports/equity-changes.js), and was already
  // seeded/granted to finance/manager via the base seeder in server.js.
  // Re-declaring it here (idempotent INSERT IGNORE) is what actually closes
  // the gap: it was NEVER granted to accountant/auditor in this, the more
  // actively maintained finance capability seed — the base seeder in
  // server.js only fills role_permissions when the table is EMPTY, so a
  // fresh accountant/auditor account never received it.
  ['finance.reports.view',     0, 170, 'عرض التقارير المالية (ميزان المراجعة، الأرباح والخسائر، الميزانية)', 'View financial reports (Trial Balance, P&L, Balance Sheet)'],
];

// role → capability ids (admin top-up handled below; developer bypasses in-middleware)
const FIN_ALL = CAPS.map((c) => c[0]);
const ROLE_GRANTS = {
  manager: FIN_ALL, // managers get everything (mirrors the base seeder's stance)
  accountant: [
    'finance.gl.view', 'finance.gl.create', 'finance.gl.approve', 'finance.gl.post',
    'finance.accounts.manage',
    'finance.cash.approve',
    'finance.bankrec.view', 'finance.bankrec.manage',
    'finance.reports.view',
  ],
  finance: [
    'finance.gl.view', 'finance.gl.create', 'finance.gl.approve', 'finance.gl.post', 'finance.gl.reverse',
    'finance.accounts.manage',
    'finance.cash.approve', 'finance.cash.close',
    'finance.bankrec.view', 'finance.bankrec.manage', 'finance.bankrec.close',
    'hr.payroll.approve', 'hr.payroll.pay',
    'finance.reports.view',
  ],
  auditor: [
    'finance.gl.view',
    'finance.bankrec.view',
    'finance.reports.view',
  ],
};

async function seedFinanceCapabilities(db, log = () => {}) {
  // 1. catalog
  for (const [id, sensitive, order, ar, en] of CAPS) {
    await db.query(
      `INSERT IGNORE INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive, sort_order)
       VALUES (?, 'finance', ?, ?, ?, ?)`,
      [id, ar, en, sensitive, order]
    );
  }
  log(`  + ${CAPS.length} finance capabilities`);

  // 2. admin top-up — always grant admin every finance capability (the base
  //    seeder only fills role_permissions when the table is EMPTY, so new
  //    capabilities would never reach admin without this).
  for (const [id] of CAPS) {
    await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)', ['admin', id]);
  }

  // 3. role grants
  for (const [role, ids] of Object.entries(ROLE_GRANTS)) {
    for (const id of ids) {
      await db.query('INSERT IGNORE INTO role_permissions (role, permission_id) VALUES (?, ?)', [role, id]);
    }
  }
  log('  + role grants (admin/manager/accountant/finance/auditor)');
  return true;
}

module.exports = { seedFinanceCapabilities, CAPS, ROLE_GRANTS };
