-- 0034_coa_inventory_sales_cutover.sql
-- Safe, reversible-by-status consolidation. Historical entries are never
-- rewritten or deleted. Unused accounts are archived and remain available in
-- the CoA lifecycle filter; runtime uses one Inventory Control account.

-- Cutover guard FIRST: every non-zero event already captured before this
-- release must have its legacy per-invoice Sale journal. db/migrate.js runs
-- statements through a pool, so a TEMPORARY TABLE would be connection-scoped
-- and unsafe here. Migration 0033 is guaranteed to be recorded before 0034;
-- attempting to insert its primary key again gives a deterministic duplicate-key
-- error only when a real gap exists, stopping the release before any chart or
-- queue mutation. With no gaps, the SELECT returns zero rows.
INSERT INTO _migrations (version, filename)
SELECT '0033', '0034_cutover_guard_failed'
FROM (
  SELECT COUNT(*) AS bad_count FROM (
    -- A queue row already marked posted must have a valid SalesBatch and must
    -- NOT also carry the old Sale journal (that would be a historical double).
    SELECT queue_row.id
    FROM sales_posting_queue queue_row
    LEFT JOIN sales_posting_batches batch_row ON batch_row.id = queue_row.batch_id
    LEFT JOIN gl_journals batch_journal
      ON batch_journal.id = batch_row.journal_id
     AND batch_journal.reference_type = 'SalesBatch'
    LEFT JOIN gl_journals legacy_journal
      ON legacy_journal.reference_type = 'Sale'
     AND legacy_journal.reference_id = queue_row.source_id
    WHERE queue_row.status = 'posted'
      AND (batch_journal.id IS NULL OR legacy_journal.id IS NOT NULL)
    UNION ALL
    -- Mid-flight or force-stranded state has no safe automatic cutover.
    SELECT queue_row.id
    FROM sales_posting_queue queue_row
    WHERE queue_row.status IN ('posting','stranded')
  ) unsafe_rows
) cutover_guard
WHERE cutover_guard.bad_count > 0;

-- Historical backfill can contain rows labelled posted_legacy even though no
-- legacy Sale journal exists. They are not safe to ignore and must not receive
-- a per-invoice repair journal: requeue them for the governed batch poster.
UPDATE sales_posting_queue queue_row
LEFT JOIN gl_journals legacy_journal
  ON legacy_journal.reference_type = 'Sale'
 AND legacy_journal.reference_id = queue_row.source_id
SET queue_row.status = 'pending',
    queue_row.batch_id = NULL,
    queue_row.posted_at = NULL,
    queue_row.last_error = 'CUTOVER_REQUEUED_NO_LEGACY_JOURNAL'
WHERE queue_row.status = 'posted_legacy'
  AND (ABS(queue_row.gross_amount) > 0.005 OR ABS(queue_row.cogs_amount) > 0.005)
  AND legacy_journal.id IS NULL;

-- The existing operational account keeps its id/code so historical journals,
-- settings and integrations remain valid. Only its presentation/governance
-- metadata and parent are normalised.
UPDATE gl_accounts inventory_account
LEFT JOIN gl_accounts inventory_parent
  ON inventory_parent.code = '100300'
SET inventory_account.name_ar = 'حساب مراقبة المخزون',
    inventory_account.name_en = 'Inventory Control',
    inventory_account.parent_id = COALESCE(inventory_parent.id, inventory_account.parent_id),
    inventory_account.level = IF(inventory_parent.id IS NULL, inventory_account.level, inventory_parent.level + 1),
    inventory_account.is_active = 1,
    inventory_account.status = 'active',
    inventory_account.is_postable = 1,
    inventory_account.is_control = 1,
    inventory_account.system_managed = 1,
    inventory_account.normal_balance = 'debit',
    inventory_account.report_section = 'inventory',
    inventory_account.cash_flow_activity = 'operating',
    inventory_account.updated_by = 'migration:0034',
    inventory_account.updated_at = NOW()
WHERE inventory_account.code = '1200';

-- Keep operational account codes stable (posted lines snapshot those codes),
-- but place the active controls inside the governed six-digit presentation
-- tree. Re-parenting changes no journal amount and no historical line.
UPDATE gl_accounts operational_account
JOIN (
  SELECT '1110' AS account_code, '100100' AS parent_code UNION ALL
  SELECT '1120', '100100' UNION ALL
  SELECT '1150', '100200' UNION ALL
  SELECT '1200', '100300' UNION ALL
  SELECT '1290', '100450' UNION ALL
  SELECT '2100', '200100' UNION ALL
  SELECT '2210', '200300' UNION ALL
  SELECT '2310', '200200' UNION ALL
  SELECT '2320', '200200' UNION ALL
  SELECT '4100', '400000' UNION ALL
  SELECT '4910', '400900' UNION ALL
  SELECT '5100', '500000' UNION ALL
  SELECT '5200', '501800' UNION ALL
  SELECT '5300', '501800' UNION ALL
  SELECT '5350', '501800' UNION ALL
  SELECT '5400', '500400' UNION ALL
  SELECT '5410', '501800' UNION ALL
  SELECT '5420', '501800' UNION ALL
  SELECT '5500', '501000' UNION ALL
  SELECT '6100', '501700'
) account_map ON account_map.account_code = operational_account.code
JOIN gl_accounts governed_parent ON governed_parent.code = account_map.parent_code
SET operational_account.parent_id = governed_parent.id,
    operational_account.level = governed_parent.level + 1,
    operational_account.updated_by = 'migration:0034',
    operational_account.updated_at = NOW();

-- Any other account with genuine ledger history stays visible and keeps its
-- number/name, but is lifted out of obsolete legacy folders into the correct
-- modern statement root. This is deliberately a presentation-only fallback;
-- explicit control mappings above provide the more precise placement.
UPDATE gl_accounts historical_account
JOIN (SELECT DISTINCT account_id FROM gl_entries WHERE account_id IS NOT NULL) used_account
  ON used_account.account_id = historical_account.id
JOIN gl_accounts statement_root
  ON statement_root.code = CASE historical_account.type
    WHEN 'asset' THEN '100000'
    WHEN 'liability' THEN '200000'
    WHEN 'equity' THEN '300000'
    WHEN 'revenue' THEN '400000'
    WHEN 'expense' THEN '500000'
    ELSE '__NO_MATCH__'
  END
LEFT JOIN (
  SELECT '1110' AS account_code UNION ALL SELECT '1120' UNION ALL SELECT '1150'
  UNION ALL SELECT '1200' UNION ALL SELECT '1290' UNION ALL SELECT '2100'
  UNION ALL SELECT '2210' UNION ALL SELECT '2310' UNION ALL SELECT '2320'
  UNION ALL SELECT '4100' UNION ALL SELECT '4910' UNION ALL SELECT '5100'
  UNION ALL SELECT '5200' UNION ALL SELECT '5300' UNION ALL SELECT '5350'
  UNION ALL SELECT '5400' UNION ALL SELECT '5410' UNION ALL SELECT '5420'
  UNION ALL SELECT '5500' UNION ALL SELECT '6100'
  UNION ALL SELECT '1210' UNION ALL SELECT '1220' UNION ALL SELECT '1230'
) explicit_map ON explicit_map.account_code = historical_account.code
SET historical_account.parent_id = statement_root.id,
    historical_account.level = statement_root.level + 1,
    historical_account.updated_by = 'migration:0034',
    historical_account.updated_at = NOW()
WHERE explicit_map.account_code IS NULL
  AND COALESCE(historical_account.is_system_root, 0) = 0
  AND historical_account.id <> statement_root.id;

-- Legacy stage accounts keep their complete journal history, but become
-- archived/non-postable children of the same Inventory presentation folder.
-- This yields one ACTIVE posting leaf (1200) without rewriting historical
-- gl_entries. Financial statements still roll their balances into inventory;
-- operational detail going forward comes from warehouse/item/BOM subledgers.
UPDATE gl_accounts legacy_inventory
JOIN gl_accounts inventory_parent ON inventory_parent.code = '100300'
SET legacy_inventory.parent_id = inventory_parent.id,
    legacy_inventory.level = inventory_parent.level + 1,
    legacy_inventory.report_section = 'inventory',
    legacy_inventory.status = 'archived',
    legacy_inventory.is_active = 0,
    legacy_inventory.is_postable = 0,
    legacy_inventory.archived_by = 'migration:0034',
    legacy_inventory.archived_at = COALESCE(legacy_inventory.archived_at, NOW()),
    legacy_inventory.updated_by = 'migration:0034',
    legacy_inventory.updated_at = NOW()
WHERE legacy_inventory.code IN ('1210','1220','1230');

-- gl_accounts.balance is a denormalized cache and was already documented as
-- stale in 0028. Rebuild it from posted ledger lines before lifecycle cleanup,
-- so an unused account cannot remain visible merely because of a zombie cache
-- and no real balance is hidden. No journal row is changed.
UPDATE gl_accounts account_row
LEFT JOIN (
  SELECT entry_row.account_id,
         ROUND(SUM(CASE WHEN ledger_account.type IN ('asset','expense')
                        THEN entry_row.debit - entry_row.credit
                        ELSE entry_row.credit - entry_row.debit END), 2) AS ledger_balance
  FROM gl_entries entry_row
  JOIN gl_journals journal_row ON journal_row.id = entry_row.journal_id AND journal_row.status = 'posted'
  JOIN gl_accounts ledger_account ON ledger_account.id = entry_row.account_id
  GROUP BY entry_row.account_id
) ledger_total ON ledger_total.account_id = account_row.id
SET account_row.balance = COALESCE(ledger_total.ledger_balance, 0);

-- Preserve every account that has history, backs a governed role, is owned by
-- a subledger/integration, is a system root, or is a runtime control account.
-- Everything else can be retired without changing a single balance.
UPDATE gl_accounts account_row
SET account_row.status = 'archived',
    account_row.is_active = 0,
    account_row.archived_by = 'migration:0034',
    account_row.archived_at = COALESCE(account_row.archived_at, NOW()),
    account_row.updated_by = 'migration:0034',
    account_row.updated_at = NOW()
WHERE account_row.is_system_root = 0
  AND account_row.source_entity_type IS NULL
  AND NOT EXISTS (SELECT 1 FROM gl_entries entry_row WHERE entry_row.account_id = account_row.id)
  AND NOT EXISTS (
    SELECT 1 FROM account_roles role_row
    WHERE role_row.account_id = account_row.id AND role_row.is_active = 1
      AND role_row.role_key NOT IN ('INVENTORY','BRANCH_INVENTORY','WORK_IN_PROGRESS','FINISHED_GOODS')
  )
  AND NOT EXISTS (SELECT 1 FROM gl_accounts child_row WHERE child_row.parent_id = account_row.id AND child_row.status = 'active')
  AND account_row.code NOT IN (
    '1110','1120','1130','1150','1200','1290','2100','2201','2202','2210','2310','2320',
    '4100','4201','4910','5100','5200','5300','5301','5302','5303','5304','5350',
    '5400','5410','5420','5500','6100'
  );

-- Retire empty folders bottom-up after their leaves were archived. Repeating
-- the same idempotent statement covers the chart's maximum four levels.
UPDATE gl_accounts folder_row
SET folder_row.status = 'archived', folder_row.is_active = 0,
    folder_row.archived_by = 'migration:0034',
    folder_row.archived_at = COALESCE(folder_row.archived_at, NOW()),
    folder_row.updated_by = 'migration:0034', folder_row.updated_at = NOW()
WHERE folder_row.is_system_root = 0
  AND NOT EXISTS (SELECT 1 FROM gl_entries entry_row WHERE entry_row.account_id = folder_row.id)
  AND NOT EXISTS (SELECT 1 FROM account_roles role_row WHERE role_row.account_id = folder_row.id AND role_row.is_active = 1)
  AND NOT EXISTS (SELECT 1 FROM gl_accounts child_row WHERE child_row.parent_id = folder_row.id AND child_row.status = 'active');

UPDATE gl_accounts folder_row
SET folder_row.status = 'archived', folder_row.is_active = 0,
    folder_row.archived_by = 'migration:0034',
    folder_row.archived_at = COALESCE(folder_row.archived_at, NOW()),
    folder_row.updated_by = 'migration:0034', folder_row.updated_at = NOW()
WHERE folder_row.is_system_root = 0
  AND NOT EXISTS (SELECT 1 FROM gl_entries entry_row WHERE entry_row.account_id = folder_row.id)
  AND NOT EXISTS (SELECT 1 FROM account_roles role_row WHERE role_row.account_id = folder_row.id AND role_row.is_active = 1)
  AND NOT EXISTS (SELECT 1 FROM gl_accounts child_row WHERE child_row.parent_id = folder_row.id AND child_row.status = 'active');

UPDATE gl_accounts folder_row
SET folder_row.status = 'archived', folder_row.is_active = 0,
    folder_row.archived_by = 'migration:0034',
    folder_row.archived_at = COALESCE(folder_row.archived_at, NOW()),
    folder_row.updated_by = 'migration:0034', folder_row.updated_at = NOW()
WHERE folder_row.is_system_root = 0
  AND NOT EXISTS (SELECT 1 FROM gl_entries entry_row WHERE entry_row.account_id = folder_row.id)
  AND NOT EXISTS (SELECT 1 FROM account_roles role_row WHERE role_row.account_id = folder_row.id AND role_row.is_active = 1)
  AND NOT EXISTS (SELECT 1 FROM gl_accounts child_row WHERE child_row.parent_id = folder_row.id AND child_row.status = 'active');

-- One physical account may satisfy several inventory lifecycle roles. The
-- operational classification is stored in warehouse/item/BOM subledgers, not
-- duplicated in the chart. INSERT IGNORE never overwrites an owner's mapping.
-- Preserve a governance record when an existing inventory role pointed at one
-- of the obsolete zero-balance accounts. The deterministic history id makes
-- this safe if a partially-applied migration is resumed.
INSERT IGNORE INTO account_role_history
  (id, role_key, company_id, old_account_id, new_account_id,
   expected_version, reason, changed_by)
SELECT CONCAT('ARH-', LEFT(MD5(CONCAT(role_row.role_key, ':', role_row.company_id, ':0034')), 32)),
       role_row.role_key, role_row.company_id, role_row.account_id, inventory_account.id,
       role_row.version,
       'Consolidate inventory detail into one control account; preserve detail in subledger/dimensions',
       'migration:0034'
FROM account_roles role_row
JOIN gl_accounts inventory_account
  ON inventory_account.code = '1200'
WHERE role_row.role_key IN ('INVENTORY','BRANCH_INVENTORY','WORK_IN_PROGRESS','FINISHED_GOODS')
  AND role_row.company_id = 'CO-MAIN'
  AND role_row.account_id <> inventory_account.id;

INSERT INTO account_roles
  (id, role_key, company_id, account_id, is_active, notes, created_by)
SELECT CONCAT('AR-', LEFT(MD5(CONCAT(role_keys.role_key, ':CO-MAIN')), 32)),
       role_keys.role_key, 'CO-MAIN', inventory_account.id, 1,
       'One Inventory Control account; detail is carried by dimensions/subledger',
       'migration:0034'
FROM gl_accounts inventory_account
JOIN (
  SELECT 'INVENTORY' AS role_key
  UNION ALL SELECT 'BRANCH_INVENTORY'
  UNION ALL SELECT 'WORK_IN_PROGRESS'
  UNION ALL SELECT 'FINISHED_GOODS'
) role_keys
WHERE inventory_account.code = '1200'
ON DUPLICATE KEY UPDATE
  version = IF(account_id <> VALUES(account_id), version + 1, version),
  account_id = VALUES(account_id),
  is_active = 1,
  notes = VALUES(notes),
  updated_by = 'migration:0034';

-- Existing deployments created the queue before the calendar-date index was
-- introduced. Add it once; fresh deployments also pass through this migration.
SET @idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'sales_posting_queue'
    AND INDEX_NAME = 'ix_spq_status_calendar'
);
SET @stmt = IF(@idx_exists = 0,
  'ALTER TABLE sales_posting_queue ADD KEY ix_spq_status_calendar (status, calendar_date)',
  'SELECT 1');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- All rows present at deployment belong to the old per-invoice regime. Mark
-- them once; new checkouts after startup remain pending for daily/monthly post.
UPDATE sales_posting_queue queue_row
LEFT JOIN gl_journals journal_row
  ON journal_row.reference_type = 'Sale'
 AND journal_row.reference_id = queue_row.source_id
SET queue_row.status = 'posted_legacy',
    queue_row.posted_at = COALESCE(queue_row.posted_at, NOW()),
    queue_row.last_error = NULL
WHERE queue_row.status IN ('pending','failed')
  AND (journal_row.id IS NOT NULL OR (
    ABS(queue_row.gross_amount) <= 0.005 AND ABS(queue_row.cogs_amount) <= 0.005
  ));
