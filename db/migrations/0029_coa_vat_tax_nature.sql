-- ════════════════════════════════════════════════════════════════════
-- 0029_coa_vat_tax_nature.sql
-- ────────────────────────────────────────────────────────────────────
-- THE VAT ACCOUNTS ARE NOT MARKED AS VAT ACCOUNTS.
--
-- `gl_accounts.tax_nature` has existed for a while and defaults to 'none'.
-- Nothing ever set it, so the two accounts the whole VAT cycle runs through
-- — 1290 «ضريبة المدخلات» (input) and 2210 «ضريبة المخرجات» (output) —
-- still say they have no tax nature at all.
--
-- This surfaced the moment account_roles was seeded: lib/accountRoles.js
-- validates a mapping against the catalog before saving it, and refused
-- INPUT_VAT → 1290 with ACCOUNT_ROLE_TAX_NATURE_MISMATCH. The guard was
-- right. The data was wrong.
--
-- WHY BY CODE AND NOT BY NAME: every other classifier in this codebase that
-- matched Arabic names is being removed for exactly the reason that makes it
-- tempting here — a name is not a classification, and 'ضريبة' appears in
-- accounts that are not the VAT control accounts. These four codes are the
-- ones lib/glPosting.js CORE_ACCOUNTS and routes/erp/vat.js already post to,
-- so this records what the system does rather than deciding something new.
--
-- Scoped tightly: only rows whose tax_nature is still 'none' or NULL are
-- touched, so a value someone set deliberately is never overwritten, and the
-- migration stays re-runnable.
-- ════════════════════════════════════════════════════════════════════

-- Input VAT (a receivable from the tax authority).
UPDATE gl_accounts
   SET tax_nature = 'vat_input'
 WHERE code IN ('1290', '1430')
   AND type = 'asset'
   AND (tax_nature IS NULL OR tax_nature = 'none');

-- Output VAT (a payable to the tax authority). 21301 is the code the VAT
-- settlement route uses on the legacy six-digit chart.
UPDATE gl_accounts
   SET tax_nature = 'vat_output'
 WHERE code IN ('2210', '21301')
   AND type = 'liability'
   AND (tax_nature IS NULL OR tax_nature = 'none');

-- The GOSI pair, for the same reason: the payroll engine posts both sides and
-- neither carries its nature. Employee share is withheld (a liability), the
-- company share is an expense.
UPDATE gl_accounts
   SET tax_nature = 'gosi'
 WHERE code IN ('2202', '5304')
   AND (tax_nature IS NULL OR tax_nature = 'none');
