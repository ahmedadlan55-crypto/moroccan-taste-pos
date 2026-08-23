-- Move custody advances out of the TRADE receivables account.
--
-- ─── WHAT HAPPENED ──────────────────────────────────────────────────────────
-- Three `custody_topup` journals funded cashier custodies at 5,000 each and
-- debited `113010 «عهدة ADLAN»` — correctly. Funding an employee's custody is an
-- advance TO THAT EMPLOYEE, not a sale to a customer.
--
-- Then the 0036 canonical rebuild's transition journal moved the whole 15,000
-- from `113010` into `112100 «ذمم العملاء»` — the TRADE receivables control
-- account. Money advanced to a cashier became, on paper, money customers owed.
--
-- ─── HOW IT WAS FOUND ───────────────────────────────────────────────────────
-- The A/R ageing's reconciliation, run against the production ledger:
--
--     subledger 0  vs  control account 15,000
--
-- Decomposed, the control account's ENTIRE balance came from one journal with
-- reference_type 'CoaTransition', and all 18 real customer invoices were fully
-- paid. Not a portion of the balance was trade debt. That is what made this
-- safe to correct rather than merely suspicious.
--
-- ─── WHY A JOURNAL ──────────────────────────────────────────────────────────
-- «لا حذف — بل عكس». The transition journal recorded what was believed at the
-- time; it is not edited. This posts the correction beside it:
--
--     DR  112300  سلف الموظفين والعهد   (the EMPLOYEE_ADVANCES role's account)
--     CR  112100  ذمم العملاء
--
-- 112300 is not a guess: `account_roles` maps EMPLOYEE_ADVANCES to it, and it
-- is filed under `other_current_asset` — so once the balance moves, it leaves
-- the receivables control account and the A/R ageing reconciles.
--
-- ─── SAFETY ────────────────────────────────────────────────────────────────
--   · The amount is COMPUTED — the 112100 balance arising from CoaTransition
--     journals — never a literal. A database with different history gets its
--     own figure, and one with none gets zero.
--   · NO-OP AT ZERO: nothing is posted when there is nothing to correct.
--   · IDEMPOTENT: fixed journal id, every insert guarded on it not existing.
--   · BALANCED by construction: one debit, one credit, one amount.

SET @ar_id    = (SELECT id FROM gl_accounts WHERE code = '112100' LIMIT 1);
SET @adv_id   = (SELECT id FROM gl_accounts WHERE code = '112300' LIMIT 1);

SET @amount = (
  SELECT COALESCE(ROUND(SUM(e.debit - e.credit), 2), 0)
    FROM gl_entries e
    JOIN gl_journals j ON j.id = e.journal_id
   WHERE j.status = 'posted'
     AND j.reference_type = 'CoaTransition'
     AND e.account_id = @ar_id
);

SET @jid = 'JV-RECLASS-CUSTODY-0041';
SET @already = (SELECT COUNT(*) FROM gl_journals WHERE id = @jid);

SET @go = IF(@ar_id IS NOT NULL AND @adv_id IS NOT NULL
             AND @amount > 0.004 AND @already = 0, 1, 0);

INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id,
                         description, total_debit, total_credit, status, created_by, posted_by, posted_at)
SELECT @jid, @jid, CURDATE(), 'Reclass', 'CUSTODY-0041',
       'إعادة تصنيف أرصدة العهد من ذمم العملاء إلى سلف الموظفين والعهد',
       @amount, @amount, 'posted', 'migration-0041', 'migration-0041', NOW()
 WHERE @go = 1;

INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description)
SELECT CONCAT(@jid, '-D'), @jid, @adv_id, '112300',
       (SELECT name_ar FROM gl_accounts WHERE id = @adv_id),
       @amount, 0, 'Custody advances — reclassified out of trade receivables'
 WHERE @go = 1;

INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description)
SELECT CONCAT(@jid, '-C'), @jid, @ar_id, '112100',
       (SELECT name_ar FROM gl_accounts WHERE id = @ar_id),
       0, @amount, 'Remove custody advances from customer receivables'
 WHERE @go = 1;
