-- Move the goods-receipt liability out of A/P and into GR/IR.
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- The legacy purchase-receipt path credited ACCOUNTS PAYABLE. A receipt does
-- create a liability, but not a supplier-INVOICE liability — nothing has been
-- invoiced yet. So the A/P control account held money that no supplier invoice
-- backed, and the A/P ageing (which reads the supplier-invoice subledger) could
-- never tie to the ledger.
--
-- The code is fixed: receipts now credit GR/IR through the same role registry
-- the V2 procurement module uses. This migration deals with what was already
-- posted.
--
-- ─── WHY A JOURNAL AND NOT AN UPDATE ────────────────────────────────────────
-- The obvious "fix" is to UPDATE those eight gl_entries rows to point at GR/IR.
-- That is editing posted history, and this system's rule is explicit — «لا حذف
-- — بل عكس». A posted journal is a record of what was believed at the time; you
-- correct it by posting a correction, which leaves both the original and the
-- correction visible to an auditor.
--
-- So this posts ONE reclassification journal:
--
--     DR  2100  ذمم دائنة        (reduce A/P by the receipt-sourced balance)
--     CR  2150  بضاعة مستلمة لم تُفوتر   (recognise it as GR/IR)
--
-- ─── SAFETY ────────────────────────────────────────────────────────────────
--   · The amount is COMPUTED from the ledger — the net A/P still standing from
--     journals whose reference_type is 'PurchaseReceipt'. It is never a literal,
--     so a database with a different history gets its own correct figure.
--   · IDEMPOTENT: a fixed journal id, and every insert guarded on that id not
--     already existing. Re-running is a no-op.
--   · NO-OP WHEN THERE IS NOTHING TO CORRECT: if the computed amount is zero
--     (a deployment that never used the legacy path), nothing is posted at all.
--     A zero-value journal is noise in the ledger.
--   · The journal BALANCES by construction: one debit, one credit, same amount.

SET @ap_id   = (SELECT id FROM gl_accounts WHERE code = '2100' LIMIT 1);
SET @grni_id = (SELECT id FROM gl_accounts WHERE code = '2150' LIMIT 1);

-- The A/P still standing from receipt journals: credits minus debits, so a
-- receipt later cleared by a real invoice does not get corrected twice.
SET @amount = (
  SELECT COALESCE(ROUND(SUM(e.credit - e.debit), 2), 0)
    FROM gl_entries e
    JOIN gl_journals j ON j.id = e.journal_id
   WHERE j.status = 'posted'
     AND j.reference_type = 'PurchaseReceipt'
     AND e.account_id = @ap_id
);

SET @jid = 'JV-RECLASS-GRNI-0039';
SET @already = (SELECT COUNT(*) FROM gl_journals WHERE id = @jid);

-- Post only when there is a real amount, both accounts exist, and it has not
-- run before.
SET @go = IF(@ap_id IS NOT NULL AND @grni_id IS NOT NULL
             AND @amount > 0.004 AND @already = 0, 1, 0);

INSERT INTO gl_journals (id, journal_number, journal_date, reference_type, reference_id,
                         description, total_debit, total_credit, status, created_by, posted_by, posted_at)
SELECT @jid, @jid, CURDATE(), 'Reclass', 'GRNI-0039',
       'إعادة تصنيف التزام الاستلام من ذمم الموردين إلى بضاعة مستلمة لم تُفوتر',
       @amount, @amount, 'posted', 'migration-0039', 'migration-0039', NOW()
 WHERE @go = 1;

INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description)
SELECT CONCAT(@jid, '-D'), @jid, @ap_id, '2100',
       (SELECT name_ar FROM gl_accounts WHERE id = @ap_id),
       @amount, 0, 'Reclassify goods-receipt liability out of A/P'
 WHERE @go = 1;

INSERT INTO gl_entries (id, journal_id, account_id, account_code, account_name, debit, credit, description)
SELECT CONCAT(@jid, '-C'), @jid, @grni_id, '2150',
       (SELECT name_ar FROM gl_accounts WHERE id = @grni_id),
       0, @amount, 'Goods received not invoiced'
 WHERE @go = 1;
