-- File account 2150 «بضاعة مستلمة لم تُفوتر (GRNI)» under the `grni` section.
--
-- ─── WHY THIS IS NOT IN 0038 ────────────────────────────────────────────────
-- It was. That is the point of this file.
--
-- 0038 had already been applied to production when this statement was added to
-- it. A migration runner records a version as done and never looks at the file
-- again — so the new statement shipped, was never executed anywhere it
-- mattered, and the account stayed misfiled while the migration reported
-- success. Verified against the live database: 0038 applied 2026-08-23 07:40,
-- the statement was written after, and 2150 was still
-- `other_current_liability`.
--
-- An applied migration is immutable. New intent needs a new number.
--
-- ─── WHY IT MATTERS ─────────────────────────────────────────────────────────
-- 2150 is the account role GRNI resolves to — the one EVERY goods receipt now
-- credits. Filed as a generic `other_current_liability`, the balance sheet
-- reported "goods received but not yet invoiced" in a bucket that says nothing
-- about what it is. The catalogue has `grni` for exactly this.
--
-- Guarded on the current value, so it is idempotent and cannot overwrite a
-- classification someone has since chosen deliberately.

UPDATE gl_accounts
   SET report_section = 'grni'
 WHERE code = '2150'
   AND COALESCE(report_section, '') IN ('', 'other_current_liability');
