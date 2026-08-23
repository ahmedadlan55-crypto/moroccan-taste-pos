-- Correct `gl_accounts.report_section` where it contradicts the account.
--
-- ─── HOW THESE WERE FOUND ───────────────────────────────────────────────────
-- The A/R ageing gained a reconciliation against the receivables control
-- account. Its first live run reported:
--
--     ageing 0 · ledger 2,360 · difference −2,360 · NOT reconciled
--     control side is made of:  1120 «البنوك» = 2,360
--
-- The ageing was right. The BANK account was classified as a receivable. Once
-- the breakdown named it, the rest of the chart was worth reading, and the same
-- column was wrong in twelve more places.
--
-- ─── WHY EACH ONE MOVES MONEY ───────────────────────────────────────────────
--   · An account marked `receivables` is reported as money customers owe. Cash,
--     inventory and input VAT are not that. The receivables line was overstated
--     by every one of them, and the A/R ageing could never tie.
--
--   · `acc_dep` is a CONTRA asset — the balance sheet SUBTRACTS it. Two real
--     assets carried it (`122` POS hardware, `1220` work in progress), so each
--     was deducted from total assets instead of added: the balance sheet
--     understated assets by TWICE their value.
--
--   · A NULL section falls through to the legacy code-prefix guesser
--     (lib/coa/classify.js quarantines those in `legacy*` and reports them in
--     the response's `unmapped` array). Naming them stops the guessing.
--
-- ─── WHY THIS IS SAFE ───────────────────────────────────────────────────────
-- Every row is addressed by its EXACT code — never by a name pattern, and never
-- by a prefix. An account not listed here is not touched. Section ids are the
-- catalogue's own (lib/coa/classify.js SECTIONS); `vat_output` and `vat_input`
-- are deliberately left alone because SECTION_ALIASES already maps them to
-- `output_vat` / `input_vat` — they are spellings, not errors.
--
-- This changes PRESENTATION only. No journal, no balance and no account code is
-- altered; the trial balance is identical before and after. What changes is
-- which line of the balance sheet each account is reported on.

-- ── Marked `receivables`, but not receivable ────────────────────────────────
UPDATE gl_accounts SET report_section = 'cash'
 WHERE code = '1120' AND report_section = 'receivables';

-- DELIBERATELY NOT TOUCHED: 11101 «عهدة الكاشير / صناديق نقاط البيع».
--
-- A till float is arguably cash on hand, and this migration first moved it. But
-- server.js has a `custody-fix` boot pass that re-parents every «عهدة» account
-- under 115 العهد والسلف and marks it `receivables` on purpose — treating a
-- float as value entrusted to a named cashier rather than as free cash. That is
-- a defensible accounting position, it is deliberate, and it announces itself in
-- the boot log.
--
-- Correcting it here would not settle the question; it would just make the two
-- rules fight on every restart. The account carries no balance that breaks the
-- A/R reconciliation, so there is nothing here to fix — only a decision that
-- already has an owner.

UPDATE gl_accounts SET report_section = 'inventory'
 WHERE code IN ('11201', '11202', '11203', '11204', '11205')
   AND report_section = 'receivables';

-- Employee advances ARE receivable, but they are not TRADE receivables and must
-- not sit in the customer control account the ageing reconciles against.
UPDATE gl_accounts SET report_section = 'other_current_asset'
 WHERE code IN ('115', '112300', '11302') AND report_section = 'receivables';

UPDATE gl_accounts SET report_section = 'input_vat'
 WHERE code = '115100' AND report_section = 'receivables';

-- ── Marked as accumulated depreciation, but real assets ─────────────────────
-- `acc_dep` is contra: these were being SUBTRACTED from total assets.
UPDATE gl_accounts SET report_section = 'ppe'
 WHERE code = '122' AND report_section = 'acc_dep';

UPDATE gl_accounts SET report_section = 'inventory'
 WHERE code = '1220' AND report_section = 'acc_dep';

-- ── Never classified at all ─────────────────────────────────────────────────
UPDATE gl_accounts SET report_section = 'cash'
 WHERE code IN ('1101-TILL') AND report_section IS NULL;

-- Per-branch till accounts share the 1101- prefix with a branch suffix. Matched
-- on the prefix ONLY for this one family, and only where the section is NULL —
-- an account someone has already classified is never overwritten.
UPDATE gl_accounts SET report_section = 'cash'
 WHERE code LIKE '1101-%' AND report_section IS NULL AND type = 'asset';

UPDATE gl_accounts SET report_section = 'inventory'
 WHERE code = '1200' AND report_section IS NULL;

UPDATE gl_accounts SET report_section = 'input_vat'
 WHERE code = '1290' AND report_section IS NULL;

UPDATE gl_accounts SET report_section = 'payables'
 WHERE code = '2100' AND report_section IS NULL;

UPDATE gl_accounts SET report_section = 'accrued'
 WHERE code IN ('2310', '2320') AND report_section IS NULL;

-- ── GR/IR filed as a generic liability ──────────────────────────────────────
-- `2150 «بضاعة مستلمة لم تُفوتر (GRNI)»` is the account role GRNI resolves to —
-- the one every goods receipt credits. It carried `other_current_liability`, so
-- the obligation for goods received-but-not-invoiced was reported in a bucket
-- that says nothing about what it is. The catalogue has `grni` for exactly this.
UPDATE gl_accounts SET report_section = 'grni'
 WHERE code = '2150' AND report_section = 'other_current_liability';
