-- Tier A.2 Corrective Gate, Section 3 — audit_logs schema consolidation.
--
-- server.js used to carry THREE independent CREATE TABLE audit_logs
-- definitions (the legacy runMigrations() boot path, not this versioned
-- migration runner): a V4.11 one (id BIGINT AUTO_INCREMENT, user_username,
-- action VARCHAR(80)) and two later, conflicting ones (id VARCHAR(50),
-- `username` instead of `user_username`, action VARCHAR(100)). Because
-- createTableIfMissing() is a no-op once the table exists, and the V4.11
-- definition always ran FIRST in file order, it always won on every real
-- deployment — the other two were 100% dead code, but a landmine: if the
-- V4.11 definition were ever removed or reordered, a fresh boot would
-- silently create the WRONG schema (one lib/auditLogger.js#logAudit/
-- #logAuditTx don't write to: no user_username column, a VARCHAR id that
-- collides with BIGINT AUTO_INCREMENT semantics). Both dead definitions
-- were removed from server.js in this same corrective gate; this migration
-- is what makes the V4.11 schema the canonical, explicit, single source of
-- truth for anyone provisioning a database via `node db/migrate.js` instead
-- of `node server.js`'s legacy boot-time table creation.
--
-- CREATE TABLE IF NOT EXISTS is real, supported MySQL 8 syntax (unlike
-- ADD COLUMN IF NOT EXISTS / DROP INDEX IF EXISTS, which are MariaDB-only —
-- verified earlier in this corrective gate) — safe to run against a
-- database that already has the table from server.js's legacy boot path;
-- this statement then becomes a no-op confirming the schema already
-- matches, not a second competing definition.
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_username VARCHAR(100),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(80),
  details TEXT,
  ip_address VARCHAR(45),
  user_agent VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_user (user_username, created_at DESC),
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_action (action, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
