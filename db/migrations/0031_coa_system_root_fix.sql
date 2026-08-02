-- ════════════════════════════════════════════════════════════════════
-- 0031_coa_system_root_fix.sql
-- ────────────────────────────────────────────────────────────────────
-- 0028 PICKED THE WRONG ROOTS IN PRODUCTION. This corrects it.
--
-- 0028 identified the five system roots as "the parentless account with the
-- shortest code, per type". On dev that happens to be right, because the only
-- parentless rows are '1'..'5' plus a handful of strays. On PRODUCTION it is
-- wrong four times out of five, because ~36 operational accounts were created
-- at runtime with no parent and became roots — and several of them carry
-- SHORTER codes than the real class heads:
--
--   type       0028 would mark            should be
--   asset      11  الأصول المتداولة       100000 الأصول
--   liability  22  التزامات متداولة       200000 الخصوم
--   equity     300000 حقوق الملكية        300000  ← the only one it got right
--   revenue    42  إيرادات أخرى           400000 الإيرادات
--   expense    53  المصروفات التشغيلية    500000 المصروفات
--
-- The consequence is not cosmetic. is_system_root is what the write gate uses
-- to refuse a move/deactivate/delete, so the REAL roots would have been left
-- unprotected while four mid-tree groups became immovable. And the UI treats
-- flagged rows as the top of the tree, so the chart would have rendered from
-- "Current Assets" down and hidden everything else.
--
-- THE CORRECT RULE IS THE CLASS HEAD, not the shortest code: an account whose
-- code is its accounting class followed by nothing but zeros —
--   ^[1-5]$      the legacy chart:      1, 2, 3, 4, 5
--   ^[1-5]0+$    the six-digit chart:   100000, 200000, 300000, 400000, 500000
-- and whose TYPE agrees with that leading digit. Both live charts satisfy it,
-- neither stray nor test root does, and it does not depend on which codes
-- happen to be short in a given database.
--
-- Re-marks from scratch (clear, then set) so it is idempotent and so a wrong
-- flag written by 0028 is actively removed rather than left beside a right one.
-- Only PARENTLESS rows are eligible, so the accidentally-orphaned operational
-- accounts are still not blessed as roots — the manifest reparents those.
-- ════════════════════════════════════════════════════════════════════

-- 1. Clear anything 0028 flagged, so a wrong mark cannot survive.
UPDATE gl_accounts SET is_system_root = 0, class_code = NULL
 WHERE is_system_root = 1 OR class_code IS NOT NULL;

-- 2. Re-mark the genuine class heads.
UPDATE gl_accounts
   SET is_system_root = 1,
       class_code = LEFT(code, 1)
 WHERE parent_id IS NULL
   AND (code REGEXP '^[1-5]$' OR code REGEXP '^[1-5]0+$')
   AND type = CASE LEFT(code, 1)
                WHEN '1' THEN 'asset'
                WHEN '2' THEN 'liability'
                WHEN '3' THEN 'equity'
                WHEN '4' THEN 'revenue'
                ELSE 'expense'
              END;

-- 3. If a class head somehow does not exist, that is worth knowing rather than
--    silently ending up with four roots. Recorded as a settings breadcrumb the
--    health screen can surface; deliberately NOT an error, because a chart
--    mid-migration may legitimately be missing one for a moment.
INSERT INTO settings (setting_key, setting_value)
SELECT 'CoaSystemRootCount_v1', CAST(COUNT(*) AS CHAR)
  FROM gl_accounts WHERE is_system_root = 1
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
