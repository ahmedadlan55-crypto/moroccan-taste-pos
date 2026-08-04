-- 0035_restore_input_vat_control.sql
-- Repair the only runtime control leaf archived by the partially-executed
-- pre-fix 0034 folder cleanup in production. No ledger row or balance changes.
UPDATE gl_accounts
SET status = 'active',
    is_active = 1,
    is_postable = 1,
    is_folder = 0,
    archived_by = NULL,
    archived_at = NULL,
    updated_by = 'migration:0035',
    updated_at = NOW()
WHERE code = '1290';
