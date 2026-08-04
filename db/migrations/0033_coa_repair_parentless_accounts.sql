-- ============================================================================
-- 0033_coa_repair_parentless_accounts.sql
--
-- The six-digit Saudi chart was loaded beside older operational accounts.
-- Runtime writers had created a number of those older rows without parent_id,
-- so the UI saw dozens of top-level accounts beside the five real classes.
-- They are disconnected branches of the same ledger, not accounting roots.
--
-- Repair policy (deterministic and safe for both numbering schemes):
--   1. Keep the five flagged system roots untouched.
--   2. Reconnect a parentless row to the longest strict code-prefix account of
--      the same company/type when that prefix is already a control account.
--   3. Otherwise attach it to the sole system root of its account type.
--   4. Recompute levels from the actual parent chain.
--
-- No id, code, name, balance, journal entry, posting reference or statement
-- metadata is changed.  Every statement is idempotent because the migration
-- runner executes statements through a pool (not one session/transaction).
-- ============================================================================

-- Fail before any data change unless every populated company/type has exactly
-- one correctly classified, parentless system root.
SET @coa_bad_root_types_0033 = (
  SELECT COUNT(*)
    FROM (
      SELECT companies.company_id, expected.account_type
        FROM (SELECT DISTINCT company_id FROM gl_accounts) companies
       CROSS JOIN (
         SELECT 'asset' AS account_type
         UNION ALL SELECT 'liability'
         UNION ALL SELECT 'equity'
         UNION ALL SELECT 'revenue'
         UNION ALL SELECT 'expense'
       ) expected
        LEFT JOIN gl_accounts account_row
          ON account_row.company_id = companies.company_id
         AND account_row.type = expected.account_type
       GROUP BY companies.company_id, expected.account_type
      HAVING COALESCE(SUM(account_row.is_system_root = 1), 0) <> 1
         OR COALESCE(SUM(account_row.is_system_root = 1 AND account_row.parent_id IS NULL), 0) <> 1
         OR COALESCE(SUM(
              account_row.is_system_root = 1
              AND account_row.parent_id IS NULL
              AND account_row.class_code = CASE expected.account_type
                                 WHEN 'asset' THEN '1'
                                 WHEN 'liability' THEN '2'
                                 WHEN 'equity' THEN '3'
                                 WHEN 'revenue' THEN '4'
                                 ELSE '5'
                               END
            ), 0) <> 1
    ) invalid_root_types
);
SET @coa_root_guard_sql_0033 = IF(
  @coa_bad_root_types_0033 = 0,
  'SELECT 1',
  'SELECT * FROM __coa_0033_requires_one_root_per_company_type__'
);
PREPARE coa_root_guard_stmt_0033 FROM @coa_root_guard_sql_0033;
EXECUTE coa_root_guard_stmt_0033;
DEALLOCATE PREPARE coa_root_guard_stmt_0033;

-- Enforce at most one protected root per class.  MySQL permits repeated NULLs
-- in a UNIQUE key, therefore ordinary accounts remain unrestricted.
SET @have_coa_root_key_0033 = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'gl_accounts'
     AND INDEX_NAME = 'uq_gl_accounts_company_class_root'
);
SET @coa_root_key_sql_0033 = IF(
  @have_coa_root_key_0033 = 0,
  'ALTER TABLE gl_accounts ADD UNIQUE KEY uq_gl_accounts_company_class_root (company_id, class_code)',
  'SELECT 1'
);
PREPARE coa_root_key_stmt_0033 FROM @coa_root_key_sql_0033;
EXECUTE coa_root_key_stmt_0033;
DEALLOCATE PREPARE coa_root_key_stmt_0033;

-- Prefer the longest meaningful legacy prefix. ROW_NUMBER materializes the
-- plan and avoids MySQL's target-table restriction. A prefix qualifies only
-- when it is already a folder/non-postable account or already owns children;
-- a historical posting leaf is never silently converted into a group merely
-- because its code happens to prefix another code.
UPDATE gl_accounts disconnected
JOIN (
  SELECT child_id, parent_id
    FROM (
      SELECT child.id AS child_id,
             prefix_parent.id AS parent_id,
             ROW_NUMBER() OVER (
               PARTITION BY child.id
               ORDER BY CHAR_LENGTH(prefix_parent.code) DESC,
                        prefix_parent.code ASC,
                        prefix_parent.id ASC
             ) AS candidate_rank
        FROM gl_accounts child
        JOIN gl_accounts prefix_parent
          ON prefix_parent.company_id = child.company_id
         AND prefix_parent.type = child.type
         AND prefix_parent.id <> child.id
         AND CHAR_LENGTH(prefix_parent.code) < CHAR_LENGTH(child.code)
         AND LEFT(child.code, CHAR_LENGTH(prefix_parent.code)) = prefix_parent.code
       WHERE child.parent_id IS NULL
         AND child.is_system_root = 0
         AND (
           prefix_parent.is_folder = 1
           OR prefix_parent.is_postable = 0
           OR EXISTS (
             SELECT 1
               FROM gl_accounts existing_child
              WHERE existing_child.parent_id = prefix_parent.id
           )
         )
    ) ranked_candidates
   WHERE candidate_rank = 1
) chosen_parent ON chosen_parent.child_id = disconnected.id
SET disconnected.parent_id = chosen_parent.parent_id
WHERE disconnected.parent_id IS NULL
  AND disconnected.is_system_root = 0;

-- Anything still disconnected has no trustworthy prefix group. Attach it to
-- the one class root already proven by the preflight guard.
UPDATE gl_accounts disconnected
JOIN (
  SELECT company_id, type, MIN(id) AS root_id
    FROM gl_accounts
   WHERE is_system_root = 1
     AND parent_id IS NULL
   GROUP BY company_id, type
  HAVING COUNT(*) = 1
) class_root
  ON class_root.company_id = disconnected.company_id
 AND class_root.type = disconnected.type
SET disconnected.parent_id = class_root.root_id
WHERE disconnected.parent_id IS NULL
  AND disconnected.is_system_root = 0;

-- Every account that owns children is a control account, never a posting leaf.
UPDATE gl_accounts parent_account
JOIN (
  SELECT parent_id
    FROM (
      SELECT DISTINCT parent_id
        FROM gl_accounts
       WHERE parent_id IS NOT NULL
    ) materialized_parents
) parents ON parents.parent_id = parent_account.id
SET parent_account.is_folder = 1,
    parent_account.is_postable = 0;

-- Recompute the denormalized level from the real structure. The path check
-- makes a pre-existing cycle stop rather than recurse forever; postflight then
-- rejects every row that was not reachable from a canonical root.
WITH RECURSIVE coa_tree_0033 AS (
  SELECT id,
         company_id,
         type,
         1 AS depth,
         CAST(CONCAT('|', id, '|') AS CHAR(4000)) AS traversal_path
    FROM gl_accounts
   WHERE is_system_root = 1
     AND parent_id IS NULL
  UNION ALL
  SELECT child.id,
         child.company_id,
         child.type,
         parent.depth + 1,
         CONCAT(parent.traversal_path, child.id, '|')
    FROM gl_accounts child
    JOIN coa_tree_0033 parent
      ON child.parent_id = parent.id
     AND child.company_id = parent.company_id
     AND child.type = parent.type
   WHERE parent.depth < 100
     AND LOCATE(CONCAT('|', child.id, '|'), parent.traversal_path) = 0
)
UPDATE gl_accounts account_row
JOIN coa_tree_0033 tree_row ON tree_row.id = account_row.id
SET account_row.level = tree_row.depth;

WITH RECURSIVE coa_reachable_0033 AS (
  SELECT id,
         company_id,
         type,
         CAST(CONCAT('|', id, '|') AS CHAR(4000)) AS traversal_path
    FROM gl_accounts
   WHERE is_system_root = 1
     AND parent_id IS NULL
  UNION ALL
  SELECT child.id,
         child.company_id,
         child.type,
         CONCAT(parent.traversal_path, child.id, '|')
    FROM gl_accounts child
    JOIN coa_reachable_0033 parent
      ON child.parent_id = parent.id
     AND child.company_id = parent.company_id
     AND child.type = parent.type
   WHERE LOCATE(CONCAT('|', child.id, '|'), parent.traversal_path) = 0
)
SELECT COUNT(DISTINCT id) INTO @coa_reachable_count_0033
  FROM coa_reachable_0033;

SET @coa_total_count_0033 = (SELECT COUNT(*) FROM gl_accounts);
SET @coa_stray_count_0033 = (
  SELECT COUNT(*)
    FROM gl_accounts
   WHERE parent_id IS NULL
     AND is_system_root = 0
);
SET @coa_self_parent_count_0033 = (
  SELECT COUNT(*)
    FROM gl_accounts
   WHERE parent_id = id
);
SET @coa_post_guard_sql_0033 = IF(
  @coa_reachable_count_0033 = @coa_total_count_0033
  AND @coa_stray_count_0033 = 0
  AND @coa_self_parent_count_0033 = 0,
  'SELECT 1',
  'SELECT * FROM __coa_0033_repair_incomplete__'
);
PREPARE coa_post_guard_stmt_0033 FROM @coa_post_guard_sql_0033;
EXECUTE coa_post_guard_stmt_0033;
DEALLOCATE PREPARE coa_post_guard_stmt_0033;
