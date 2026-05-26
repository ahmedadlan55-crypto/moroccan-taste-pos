-- ════════════════════════════════════════════════════════════════════
-- 0011_tax_inclusive.sql
-- ────────────────────────────────────────────────────────────────────
-- v6.20.0 — Per-product tax-inclusive flag + configurable sales tax.
--
-- THE FEATURE THIS ADDS:
--   The owner wants to enter NEW products with their NET price (price
--   before tax).  The system should add VAT on top and display a WHOLE
--   number to the customer at the cashier and on every receipt.
--
--   Existing products were entered with their TAX-INCLUSIVE price (the
--   system divided by 1.15 to extract the net).  Preserving that
--   contract for legacy rows is critical — otherwise reprinting an old
--   invoice would change its total.
--
-- WHAT THIS MIGRATION DOES:
--   1) Adds menu.is_tax_inclusive BOOLEAN NOT NULL DEFAULT 1.
--      Default 1 means EVERY existing row gets the "inclusive" flag —
--      backwards-compatible with the pre-v6.20.0 semantics.  The owner
--      can then mark individual products (or all new ones via the
--      settings default) as exclusive.
--
--   2) Seeds three settings keys (INSERT IGNORE — safe to re-run):
--        - VATRate (already present at 15 — kept untouched if existing)
--        - SalesTaxName ("ضريبة القيمة المضافة 15%") — the label that
--          appears on receipts and in admin reports
--        - NewProductsTaxInclusive (0) — default for the "is_tax_
--          inclusive" checkbox when creating a new product.  0 = the
--          owner's stated preference (enter prices net of tax).
--
-- WHY THIS IS SAFE:
--   • ALTER TABLE ADD COLUMN with a default never touches existing
--     row data — all rows get is_tax_inclusive=1 atomically.
--   • Settings INSERT IGNORE means no setting is overwritten.
--   • The matching server.js defensive helpers (addColumnIfMissing +
--     INSERT IGNORE) handle deployments that skip this file.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE menu
  ADD COLUMN is_tax_inclusive BOOLEAN NOT NULL DEFAULT 1
  AFTER price;

INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('VATRate', '15'),
  ('SalesTaxName', 'ضريبة القيمة المضافة 15%'),
  ('NewProductsTaxInclusive', '0');
