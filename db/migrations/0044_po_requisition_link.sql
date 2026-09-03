-- 0044_po_requisition_link.sql — purchase_orders.requisition_id
--
-- ─── WHY A NUMBERED MIGRATION AND NOT ONLY schema.js ───────────────────────
-- The procurement schema evolution (db/migrations/procurement/schema.js) is
-- applied by `npm run procurement:migrate` — a script somebody runs by hand.
-- It is NOT part of the release chain: scripts/release-start.js runs the
-- numbered migrations here, and server.js's boot block applies the O2C,
-- analytics and party schemas, but never the procurement one. So a column
-- declared only in schema.js reaches production only when someone remembers,
-- and until then every convert-to-PO answers 500 on `Unknown column`.
--
-- schema.js keeps its (idempotent) declaration so the manual script stays
-- consistent; this file is what actually delivers the column at deploy.
--
-- ─── WHAT THE COLUMN IS ─────────────────────────────────────────────────────
-- The PO's back-reference to the branch requisition it was converted from.
-- purchase_requisitions.po_id existed; purchase_orders had no way back, so an
-- order could not be traced to the request that caused it, and the orders
-- list could not show which branch asked. A one-way reference is not
-- traceability.
--
-- Guarded with INFORMATION_SCHEMA so re-running is a no-op — the same pattern
-- as 0013 and 0042.

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'requisition_id');
SET @stmt = IF(@col_exists = 0, 'ALTER TABLE purchase_orders ADD COLUMN requisition_id VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND INDEX_NAME = 'idx_po_requisition');
SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE purchase_orders ADD INDEX idx_po_requisition (requisition_id)', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The orders list now filters by branch; without this it scans the table.
SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND INDEX_NAME = 'idx_po_branch');
SET @stmt = IF(@idx_exists = 0, 'ALTER TABLE purchase_orders ADD INDEX idx_po_branch (branch_id, status)', 'SELECT 1');
PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;
