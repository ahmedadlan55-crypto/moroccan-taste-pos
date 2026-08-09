-- Stable POS order ownership.
-- Login names may be renamed; users.id is the durable account identity.

SET @owner_col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'pos_orders'
    AND COLUMN_NAME = 'owner_user_id'
);
SET @stmt = IF(
  @owner_col_exists = 0,
  'ALTER TABLE pos_orders ADD COLUMN owner_user_id INT NULL AFTER username',
  'SELECT 1'
);
PREPARE s FROM @stmt;
EXECUTE s;
DEALLOCATE PREPARE s;

UPDATE pos_orders po
JOIN users u ON u.username = po.username
SET po.owner_user_id = u.id
WHERE po.owner_user_id IS NULL;

SET @owner_idx_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'pos_orders'
    AND INDEX_NAME = 'idx_pos_orders_owner'
);
SET @stmt = IF(
  @owner_idx_exists = 0,
  'CREATE INDEX idx_pos_orders_owner ON pos_orders(owner_user_id)',
  'SELECT 1'
);
PREPARE s FROM @stmt;
EXECUTE s;
DEALLOCATE PREPARE s;
