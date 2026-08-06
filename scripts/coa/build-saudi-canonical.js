#!/usr/bin/env node
'use strict';

/**
 * Mechanical generator for the governed fresh-install JSON and migration 0036.
 * The reviewed source is db/coa-saudi-canonical.js; generated files must not
 * be hand-edited because that would let seed and production cutover diverge.
 */

const fs = require('fs');
const path = require('path');
const chart = require('../../db/coa-saudi-canonical');

const ROOT = path.join(__dirname, '..', '..');
const q = (value) => value == null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;

const template = chart.map((row) => ({
  code: row.code,
  nameAr: row.nameAr,
  nameEn: row.nameEn,
  type: row.type,
  parentCode: row.parentCode,
  level: row.level,
  kind: row.kind,
  order: row.order,
  reportSection: row.reportSection,
  cashFlowActivity: row.cashFlowActivity,
  taxNature: row.taxNature,
  isContra: row.isContra,
  isControl: row.isControl,
}));

const legacyPairs = [];
const rolePairs = [];
for (const row of chart) {
  row.legacyCodes.forEach((code, priority) => legacyPairs.push({ code, target: row.code, priority }));
  row.roles.forEach((role) => rolePairs.push({ role, target: row.code }));
}

const duplicateLegacy = legacyPairs.filter((row, i, all) => all.findIndex((x) => x.code === row.code) !== i);
const duplicateRoles = rolePairs.filter((row, i, all) => all.findIndex((x) => x.role === row.role) !== i);
if (duplicateLegacy.length || duplicateRoles.length) {
  throw new Error(`Duplicate mappings: legacy=${JSON.stringify(duplicateLegacy)} roles=${JSON.stringify(duplicateRoles)}`);
}

const accountValues = chart.map((row) => `(${[
  q(row.code), q(row.nameAr), q(row.nameEn), q(row.type), q(row.parentCode || null),
  row.level, q(row.kind), q(row.reportSection), q(row.cashFlowActivity), q(row.taxNature),
  row.isContra ? 1 : 0, row.isControl ? 1 : 0,
].join(',')})`).join(',\n  ');
const legacyValues = legacyPairs.map((row) => `(${q(row.code)},${q(row.target)},${row.priority})`).join(',\n  ');
const roleValues = rolePairs.map((row) => `(${q(row.role)},${q(row.target)})`).join(',\n  ');

const sql = `-- 0036_coa_saudi_canonical_rebuild.sql
-- Replace the active presentation chart with one governed Saudi/IFRS chart.
-- Historical journals are immutable.  Every non-zero balance on a retired
-- account is moved by one balanced, auditable transition journal; the old
-- row is archived and remains available in historical drill-downs.
--
-- The chart has five roots, six-digit codes, four levels maximum and one
-- Inventory Control account. Item/warehouse/branch/brand/stage detail stays
-- in operational subledgers and journal dimensions.

SET @coa36_company = COALESCE(
  (SELECT id FROM companies ORDER BY (id='CO-MAIN') DESC,id LIMIT 1),
  'CO-MAIN'
);

CREATE TABLE IF NOT EXISTS coa_0036_legacy_map (
  legacy_code VARCHAR(20) NOT NULL PRIMARY KEY,
  canonical_code VARCHAR(20) NOT NULL,
  priority_no INT NOT NULL DEFAULT 0,
  KEY ix_coa36_canonical (canonical_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO coa_0036_legacy_map (legacy_code, canonical_code, priority_no) VALUES
  ${legacyValues}
ON DUPLICATE KEY UPDATE canonical_code=VALUES(canonical_code), priority_no=VALUES(priority_no);

CREATE TABLE IF NOT EXISTS coa_0036_account_map (
  source_account_id VARCHAR(50) NOT NULL PRIMARY KEY,
  company_id VARCHAR(50) NOT NULL,
  source_code VARCHAR(20) NOT NULL,
  target_account_id VARCHAR(50) NOT NULL,
  target_code VARCHAR(20) NOT NULL,
  mapping_reason VARCHAR(120) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_coa36_target (target_account_id),
  KEY ix_coa36_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Canonical rows.  Existing five roots are updated below rather than copied.
INSERT IGNORE INTO gl_accounts
  (id, company_id, code, name_ar, name_en, type, parent_id, level,
   is_active, is_folder, is_postable, balance, normal_balance, is_contra,
   is_control, cash_flow_activity, status, system_managed, report_section,
   tax_nature, created_by)
SELECT CONCAT('C36-', source.code), @coa36_company, source.code, source.name_ar,
       source.name_en, source.account_type, NULL, source.level_no,
       1, IF(source.account_kind='folder',1,0), IF(source.account_kind='leaf',1,0),
       0, IF(source.account_type IN ('asset','expense'),'debit','credit'),
       source.is_contra, source.is_control, source.cash_flow_activity,
       'active', 1, source.report_section, source.tax_nature, 'migration:0036'
FROM (
  SELECT * FROM (VALUES
    ${accountValues}
  ) AS canonical(code,name_ar,name_en,account_type,parent_code,level_no,account_kind,report_section,cash_flow_activity,tax_nature,is_contra,is_control)
) source;

-- MySQL does not support the portable VALUES table constructor on every
-- deployment image. The generator rewrites the block above in its final step.

-- Refresh canonical metadata and connect the hierarchy by id.
UPDATE gl_accounts account_row
JOIN coa_0036_canonical_source source ON source.code = account_row.code
LEFT JOIN gl_accounts parent_row
  ON parent_row.company_id = account_row.company_id
 AND parent_row.code = source.parent_code
SET account_row.name_ar = source.name_ar,
    account_row.name_en = source.name_en,
    account_row.type = source.account_type,
    account_row.parent_id = parent_row.id,
    account_row.level = source.level_no,
    account_row.is_active = 1,
    account_row.status = 'active',
    account_row.is_folder = IF(source.account_kind='folder',1,0),
    account_row.is_postable = IF(source.account_kind='leaf',1,0),
    account_row.normal_balance = IF(source.account_type IN ('asset','expense'),'debit','credit'),
    account_row.is_contra = source.is_contra,
    account_row.is_control = source.is_control,
    account_row.cash_flow_activity = source.cash_flow_activity,
    account_row.report_section = source.report_section,
    account_row.tax_nature = source.tax_nature,
    account_row.system_managed = 1,
    account_row.is_system_root = IF(source.parent_code IS NULL,1,0),
    account_row.class_code = IF(source.parent_code IS NULL,LEFT(source.code,1),NULL),
    account_row.archived_by = NULL,
    account_row.archived_at = NULL,
    account_row.updated_by = 'migration:0036',
    account_row.updated_at = NOW()
WHERE account_row.company_id = @coa36_company;

-- Explicit legacy mapping first.
INSERT INTO coa_0036_account_map
  (source_account_id, company_id, source_code, target_account_id, target_code, mapping_reason)
SELECT old_account.id, old_account.company_id, old_account.code,
       target_account.id, target_account.code, 'explicit canonical mapping'
FROM gl_accounts old_account
JOIN coa_0036_legacy_map map_row ON map_row.legacy_code = old_account.code
JOIN gl_accounts target_account
  ON target_account.company_id = old_account.company_id
 AND target_account.code = map_row.canonical_code
WHERE old_account.company_id = @coa36_company
  AND old_account.id <> target_account.id
ON DUPLICATE KEY UPDATE
  target_account_id=VALUES(target_account_id), target_code=VALUES(target_code),
  mapping_reason=VALUES(mapping_reason);

-- A custom/legacy posting account not in the reviewed map is not dropped.
-- Its balance goes to a visible class-specific "other" account; the source
-- remains archived for drill-down and the map records that fallback openly.
INSERT INTO coa_0036_account_map
  (source_account_id, company_id, source_code, target_account_id, target_code, mapping_reason)
SELECT old_account.id, old_account.company_id, old_account.code,
       target_account.id, target_account.code, 'class fallback for unmapped legacy account'
FROM gl_accounts old_account
JOIN gl_accounts target_account
  ON target_account.company_id = old_account.company_id
 AND target_account.code = CASE
   WHEN old_account.report_section IN ('cash','cash_bank') THEN '111100'
   WHEN old_account.report_section IN ('receivables','trade_receivables') THEN '112100'
   WHEN old_account.report_section = 'inventory' THEN '113100'
   WHEN old_account.report_section IN ('input_vat','vat_input') THEN '115100'
   WHEN old_account.report_section IN ('ppe','fixed_assets') THEN '121100'
   WHEN old_account.report_section IN ('acc_dep','accumulated_depreciation') THEN '121900'
   WHEN old_account.report_section IN ('rou','right_of_use') THEN '122100'
   WHEN old_account.report_section IN ('payables','trade_payables') THEN '211100'
   WHEN old_account.report_section = 'grni' THEN '211200'
   WHEN old_account.report_section IN ('accrued','accruals') THEN '212900'
   WHEN old_account.report_section IN ('output_vat','vat_output') THEN '213100'
   WHEN old_account.report_section = 'net_vat' THEN '213200'
   WHEN old_account.report_section = 'gosi' THEN '213300'
   WHEN old_account.report_section IN ('withholding','wht') THEN '213400'
   WHEN old_account.report_section = 'zakat' AND old_account.type='liability' THEN '213500'
   WHEN old_account.report_section IN ('customer_advances','customer_deposits') THEN '215100'
   WHEN old_account.report_section = 'short_term_debt' THEN '214200'
   WHEN old_account.report_section = 'long_term_debt' THEN '221200'
   WHEN old_account.report_section IN ('lease_obligation','lease_liability') THEN '221100'
   WHEN old_account.report_section = 'eosb' THEN '222100'
   WHEN old_account.report_section = 'capital' THEN '311100'
   WHEN old_account.report_section IN ('retained','retained_earnings') THEN '312100'
   WHEN old_account.report_section = 'drawings' THEN '315100'
   WHEN old_account.report_section = 'reserves' THEN '314200'
   WHEN old_account.report_section IN ('sales_revenue','revenue') THEN '411100'
   WHEN old_account.report_section = 'sales_returns' THEN '412200'
   WHEN old_account.report_section = 'other_income' THEN '419900'
   WHEN old_account.report_section = 'cogs' THEN '511100'
   WHEN old_account.report_section = 'waste' THEN '512100'
   WHEN old_account.report_section = 'stock_variance' THEN '512200'
   WHEN old_account.report_section = 'payroll' THEN '521100'
   WHEN old_account.report_section = 'rent_utilities' THEN '531200'
   WHEN old_account.report_section = 'marketing' THEN '541200'
   WHEN old_account.report_section = 'depreciation' THEN '571100'
   WHEN old_account.report_section = 'bank_gov_fees' THEN '561300'
   WHEN old_account.report_section = 'franchise_fees' THEN '591100'
   WHEN old_account.type='asset' THEN '119900'
   WHEN old_account.type='liability' THEN '219900'
   WHEN old_account.type='equity' THEN '312100'
   WHEN old_account.type='revenue' THEN '419900'
   ELSE '599900' END
LEFT JOIN coa_0036_canonical_source canonical ON canonical.code = old_account.code
LEFT JOIN coa_0036_account_map existing_map ON existing_map.source_account_id = old_account.id
WHERE old_account.company_id = @coa36_company
  AND canonical.code IS NULL
  AND existing_map.source_account_id IS NULL
  AND (COALESCE(old_account.is_postable,0)=1 OR EXISTS (
    SELECT 1 FROM gl_entries existing_entry WHERE existing_entry.account_id=old_account.id
  ))
ON DUPLICATE KEY UPDATE target_account_id=VALUES(target_account_id), target_code=VALUES(target_code);

-- Old codes remain forwarding addresses for imports/integrations.
INSERT INTO account_code_aliases
  (id, company_id, old_code, account_id, reason, created_by)
SELECT CONCAT('A36-', map_row.source_code), map_row.company_id,
       map_row.source_code, map_row.target_account_id,
       'Saudi canonical CoA rebuild 0036', 'migration:0036'
FROM coa_0036_account_map map_row
ON DUPLICATE KEY UPDATE account_id=VALUES(account_id), reason=VALUES(reason);

-- A partially executed draft is safe to rebuild. A posted transition is
-- immutable and makes every following statement an idempotent no-op/update.
DELETE entry_row FROM gl_entries entry_row
JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
WHERE journal_row.id='COA36-TRANSITION' AND journal_row.status='draft';
DELETE FROM gl_journals WHERE id='COA36-TRANSITION' AND status='draft';

INSERT IGNORE INTO gl_journals
  (id,journal_number,journal_date,reference_type,reference_id,description,
   total_debit,total_credit,status,created_by)
SELECT 'COA36-TRANSITION','COA36-TRANSITION',CURRENT_DATE,
       'CoaTransition','0036','إعادة تصنيف أرصدة دليل الحسابات إلى الشجرة السعودية القياسية',
       COALESCE(SUM(ABS(ledger.net_balance)),0),
       COALESCE(SUM(ABS(ledger.net_balance)),0),'draft','migration:0036'
FROM coa_0036_account_map map_row
JOIN (
  SELECT entry_row.account_id, SUM(entry_row.debit-entry_row.credit) AS net_balance
  FROM gl_entries entry_row
  JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
  WHERE journal_row.status='posted' AND journal_row.id<>'COA36-TRANSITION'
  GROUP BY entry_row.account_id
) ledger ON ledger.account_id=map_row.source_account_id
WHERE ABS(ledger.net_balance)>0.005;

-- Reverse each retired account's balance.
INSERT INTO gl_entries
  (id,journal_id,account_id,account_code,account_name,debit,credit,description)
SELECT UUID(),'COA36-TRANSITION',source_account.id,source_account.code,source_account.name_ar,
       IF(ledger.net_balance<0,ABS(ledger.net_balance),0),
       IF(ledger.net_balance>0,ABS(ledger.net_balance),0),
       CONCAT('إقفال الرصيد القديم ونقله إلى ',map_row.target_code)
FROM coa_0036_account_map map_row
JOIN gl_accounts source_account ON source_account.id=map_row.source_account_id
JOIN (
  SELECT entry_row.account_id, SUM(entry_row.debit-entry_row.credit) AS net_balance
  FROM gl_entries entry_row
  JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
  WHERE journal_row.status='posted' AND journal_row.id<>'COA36-TRANSITION'
  GROUP BY entry_row.account_id
) ledger ON ledger.account_id=map_row.source_account_id
JOIN gl_journals transition ON transition.id='COA36-TRANSITION' AND transition.status='draft'
WHERE ABS(ledger.net_balance)>0.005;

-- Open the same balances on canonical accounts, aggregated by target.
INSERT INTO gl_entries
  (id,journal_id,account_id,account_code,account_name,debit,credit,description)
SELECT UUID(),'COA36-TRANSITION',target_account.id,target_account.code,target_account.name_ar,
       SUM(IF(ledger.net_balance>0,ledger.net_balance,0)),
       SUM(IF(ledger.net_balance<0,ABS(ledger.net_balance),0)),
       'أرصدة افتتاحية بعد إعادة بناء دليل الحسابات'
FROM coa_0036_account_map map_row
JOIN gl_accounts target_account ON target_account.id=map_row.target_account_id
JOIN (
  SELECT entry_row.account_id, SUM(entry_row.debit-entry_row.credit) AS net_balance
  FROM gl_entries entry_row
  JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
  WHERE journal_row.status='posted' AND journal_row.id<>'COA36-TRANSITION'
  GROUP BY entry_row.account_id
) ledger ON ledger.account_id=map_row.source_account_id
JOIN gl_journals transition ON transition.id='COA36-TRANSITION' AND transition.status='draft'
WHERE ABS(ledger.net_balance)>0.005
GROUP BY target_account.id,target_account.code,target_account.name_ar;

UPDATE gl_journals journal_row
LEFT JOIN (
  SELECT journal_id,SUM(debit) AS debit_total,SUM(credit) AS credit_total
  FROM gl_entries WHERE journal_id='COA36-TRANSITION' GROUP BY journal_id
) totals ON totals.journal_id=journal_row.id
SET journal_row.total_debit=COALESCE(totals.debit_total,0),
    journal_row.total_credit=COALESCE(totals.credit_total,0),
    journal_row.status='posted'
WHERE journal_row.id='COA36-TRANSITION'
  AND journal_row.status='draft'
  AND ABS(COALESCE(totals.debit_total,0)-COALESCE(totals.credit_total,0))<=0.005;

-- Preserve id-based configuration links before legacy rows are archived.
UPDATE payment_methods item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE discounts_v2 item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE cash_boxes item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE bank_accounts item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE custody_expenses item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE cash_payments item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.expense_account_id SET item.expense_account_id=map_row.target_account_id;
UPDATE expense_categories item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id,item.gl_account_code=map_row.target_code;
UPDATE inv_items item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.waste_gl_account_id SET item.waste_gl_account_id=map_row.target_account_id;
UPDATE customers item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.default_revenue_account_id SET item.default_revenue_account_id=map_row.target_account_id;
UPDATE suppliers item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.default_expense_account_id SET item.default_expense_account_id=map_row.target_account_id;
UPDATE assets item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_asset_account_id SET item.gl_asset_account_id=map_row.target_account_id;
UPDATE assets item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_dep_expense_account_id SET item.gl_dep_expense_account_id=map_row.target_account_id;
UPDATE assets item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_accum_dep_account_id SET item.gl_accum_dep_account_id=map_row.target_account_id;
UPDATE ar_document_lines item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.revenue_account_id SET item.revenue_account_id=map_row.target_account_id,item.revenue_account_code=map_row.target_code;

-- Code-based configuration links move too; historical gl_entries snapshots
-- deliberately retain the code printed when each journal was posted.
UPDATE transactions item JOIN coa_0036_account_map map_row ON map_row.source_code=item.account_code SET item.account_code=map_row.target_code;
UPDATE payment_records item JOIN coa_0036_account_map map_row ON map_row.source_code=item.expense_account_code SET item.expense_account_code=map_row.target_code;
UPDATE payment_records item JOIN coa_0036_account_map map_row ON map_row.source_code=item.counter_account_code SET item.counter_account_code=map_row.target_code;
UPDATE inv_receipts item JOIN coa_0036_account_map map_row ON map_row.source_code=item.counter_account_code SET item.counter_account_code=map_row.target_code;

-- Governance history then current role mapping.
INSERT IGNORE INTO account_role_history
  (id,role_key,company_id,old_account_id,new_account_id,expected_version,reason,changed_by)
SELECT CONCAT('H36-',role_source.role_key),role_source.role_key,@coa36_company,
       current_role.account_id,target_account.id,current_role.version,
       'Saudi canonical CoA rebuild 0036','migration:0036'
FROM (
  ${rolePairs.map((row, i) => `${i ? 'UNION ALL ' : ''}SELECT ${q(row.role)} AS role_key, ${q(row.target)} AS target_code`).join('\n  ')}
) role_source
JOIN gl_accounts target_account ON target_account.company_id=@coa36_company AND target_account.code=role_source.target_code
LEFT JOIN account_roles current_role ON current_role.company_id=@coa36_company AND current_role.role_key=role_source.role_key
WHERE current_role.account_id IS NULL OR current_role.account_id<>target_account.id;

INSERT INTO account_roles
  (id,role_key,company_id,account_id,is_active,version,notes,created_by)
SELECT CONCAT('R36-',role_source.role_key),role_source.role_key,@coa36_company,target_account.id,1,1,
       'Canonical Saudi/IFRS chart 0036','migration:0036'
FROM (
  ${rolePairs.map((row, i) => `${i ? 'UNION ALL ' : ''}SELECT ${q(row.role)} AS role_key, ${q(row.target)} AS target_code`).join('\n  ')}
) role_source
JOIN gl_accounts target_account ON target_account.company_id=@coa36_company AND target_account.code=role_source.target_code
ON DUPLICATE KEY UPDATE
  version=IF(account_roles.account_id<>VALUES(account_id),account_roles.version+1,account_roles.version),
  account_id=VALUES(account_id),is_active=1,notes=VALUES(notes),updated_by='migration:0036';

-- Retire every row outside the reviewed chart. Nothing is deleted.
UPDATE gl_accounts old_account
LEFT JOIN coa_0036_canonical_source canonical ON canonical.code=old_account.code
SET old_account.status='archived',old_account.is_active=0,old_account.is_postable=0,
    old_account.is_system_root=0,old_account.class_code=NULL,
    old_account.archived_by='migration:0036',
    old_account.archived_at=COALESCE(old_account.archived_at,NOW()),
    old_account.updated_by='migration:0036',old_account.updated_at=NOW()
WHERE old_account.company_id=@coa36_company AND canonical.code IS NULL;

-- Rebuild the display cache from posted ledger truth.
UPDATE gl_accounts account_row
LEFT JOIN (
  SELECT entry_row.account_id,SUM(entry_row.debit-entry_row.credit) AS net_balance
  FROM gl_entries entry_row JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
  WHERE journal_row.status='posted' GROUP BY entry_row.account_id
) ledger ON ledger.account_id=account_row.id
SET account_row.balance=COALESCE(ledger.net_balance,0);

-- Fail closed on every invariant the owner asked for.
INSERT INTO _migrations(version,filename)
SELECT '0035','0036_invalid_active_chart'
WHERE (SELECT COUNT(*) FROM gl_accounts WHERE company_id=@coa36_company AND status='active')<>${chart.length}
   OR (SELECT COUNT(*) FROM gl_accounts WHERE company_id=@coa36_company AND status='active' AND parent_id IS NULL)<>5
   OR EXISTS (SELECT 1 FROM gl_accounts WHERE company_id=@coa36_company AND status='active' AND code NOT REGEXP '^[0-9]{6}$')
   OR EXISTS (SELECT 1 FROM gl_accounts WHERE company_id=@coa36_company AND status='active' AND level NOT BETWEEN 1 AND 4)
   OR (SELECT COUNT(*) FROM gl_accounts WHERE company_id=@coa36_company AND status='active' AND report_section='inventory' AND is_postable=1)<>1
   OR EXISTS (
     SELECT 1 FROM gl_accounts parent_row
     JOIN gl_accounts child_row ON child_row.parent_id=parent_row.id AND child_row.status='active'
     WHERE parent_row.company_id=@coa36_company AND parent_row.status='active' AND parent_row.is_postable=1
   )
   OR EXISTS (
     SELECT 1 FROM gl_journals WHERE id='COA36-TRANSITION'
       AND (status<>'posted' OR ABS(total_debit-total_credit)>0.005)
   );
`;

// MySQL 8.4 used by this project rejects VALUES as a FROM table constructor.
// Materialise the canonical source as a permanent audit table instead.
const sourceTable = `CREATE TABLE IF NOT EXISTS coa_0036_canonical_source (\n` +
  `  code VARCHAR(20) NOT NULL PRIMARY KEY,name_ar VARCHAR(200) NOT NULL,name_en VARCHAR(200) NOT NULL,\n` +
  `  account_type ENUM('asset','liability','equity','revenue','expense') NOT NULL,parent_code VARCHAR(20) NULL,\n` +
  `  level_no INT NOT NULL,account_kind ENUM('folder','leaf') NOT NULL,report_section VARCHAR(40) NULL,\n` +
  `  cash_flow_activity ENUM('operating','investing','financing','non_cash') NULL,tax_nature VARCHAR(20) NOT NULL,\n` +
  `  is_contra TINYINT(1) NOT NULL DEFAULT 0,is_control TINYINT(1) NOT NULL DEFAULT 0\n` +
  `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\n` +
  `INSERT INTO coa_0036_canonical_source\n` +
  `  (code,name_ar,name_en,account_type,parent_code,level_no,account_kind,report_section,cash_flow_activity,tax_nature,is_contra,is_control) VALUES\n` +
  `  ${accountValues}\n` +
  `ON DUPLICATE KEY UPDATE name_ar=VALUES(name_ar),name_en=VALUES(name_en),account_type=VALUES(account_type),\n` +
  ` parent_code=VALUES(parent_code),level_no=VALUES(level_no),account_kind=VALUES(account_kind),\n` +
  ` report_section=VALUES(report_section),cash_flow_activity=VALUES(cash_flow_activity),tax_nature=VALUES(tax_nature),\n` +
  ` is_contra=VALUES(is_contra),is_control=VALUES(is_control);`;

const valuesBlock = /INSERT IGNORE INTO gl_accounts[\s\S]*?-- MySQL does not support the portable VALUES table constructor on every\n-- deployment image\. The generator rewrites the block above in its final step\./;
const insertAccounts = `INSERT IGNORE INTO gl_accounts\n` +
  `  (id,company_id,code,name_ar,name_en,type,parent_id,level,is_active,is_folder,is_postable,balance,normal_balance,is_contra,is_control,cash_flow_activity,status,system_managed,report_section,tax_nature,created_by)\n` +
  `SELECT CONCAT('C36-',source.code),@coa36_company,source.code,source.name_ar,source.name_en,source.account_type,NULL,source.level_no,1,\n` +
  ` IF(source.account_kind='folder',1,0),IF(source.account_kind='leaf',1,0),0,\n` +
  ` IF(source.account_type IN ('asset','expense'),'debit','credit'),source.is_contra,source.is_control,source.cash_flow_activity,\n` +
  ` 'active',1,source.report_section,source.tax_nature,'migration:0036' FROM coa_0036_canonical_source source;`;

const finalSql = sql.replace(
  'CREATE TABLE IF NOT EXISTS coa_0036_legacy_map',
  sourceTable + '\n\nCREATE TABLE IF NOT EXISTS coa_0036_legacy_map',
).replace(valuesBlock, insertAccounts);

fs.writeFileSync(path.join(ROOT, 'db', 'coa-template.json'), JSON.stringify(template, null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'db', 'migrations', '0036_coa_saudi_canonical_rebuild.sql'), finalSql);
console.log(`Generated ${template.length} canonical accounts, ${legacyPairs.length} aliases and ${rolePairs.length} roles.`);
