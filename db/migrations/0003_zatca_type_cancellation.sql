-- ════════════════════════════════════════════════════════════════════
-- 0003_zatca_type_cancellation.sql
-- ────────────────────────────────────────────────────────────────────
-- v6.14.0 — Extend sales.zatca_type ENUM to allow 'cancellation'.
--
-- THE BUG THIS FIXES:
--   routes/sales.js POST /sales/:id/void runs:
--     UPDATE sales SET zatca_type='cancellation' WHERE id=?
--   But the schema declared:
--     zatca_type ENUM('standard','simplified','credit_note','debit_note')
--   ...which rejects 'cancellation'. Under MySQL STRICT_TRANS_TABLES
--   the UPDATE raises an error. The handler wraps it in a bare
--   try/catch that swallows the failure, then returns success:true to
--   the cashier client. The sale row was never actually updated, so
--   the UI keeps showing it as active.
--
-- WHY THIS IS SAFE:
--   • Existing rows hold one of the original four values; widening
--     the ENUM never invalidates them.
--   • The DEFAULT stays 'simplified' so freshly-inserted sales behave
--     identically.
--   • No data needs backfill — the bug means no row ever held
--     'cancellation' before this migration.
--   • Idempotent: MODIFY COLUMN is a no-op if the column already
--     matches the new shape.
--
-- COORDINATED CHANGES:
--   • server.js runMigrations addColumnIfMissing definition is updated
--     to the same five-value ENUM so fresh installs match.
--   • routes/sales.js POST /:id/void removes the bare try/catch and
--     asserts affectedRows > 0 so any future enum drift surfaces
--     immediately instead of silently faking success.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE sales
  MODIFY COLUMN zatca_type
  ENUM('standard','simplified','credit_note','debit_note','cancellation')
  DEFAULT 'simplified';
