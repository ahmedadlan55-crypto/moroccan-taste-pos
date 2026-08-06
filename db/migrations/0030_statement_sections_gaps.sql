-- ════════════════════════════════════════════════════════════════════
-- 0030_statement_sections_gaps.sql
-- ────────────────────────────────────────────────────────────────────
-- FINISH THE SECTION VOCABULARY THAT 0028 STARTED.
--
-- 0028 seeded statement_sections from the sections the balance sheet's own
-- reportSectionMap recognised — 29 rows. That was the wrong source: it was a
-- list of what ONE report happened to handle, not what the CHART actually
-- uses. Querying the live data afterwards found 9 more section ids in use on
-- 25 accounts with no row to join to:
--
--   revenue (14 accounts)  intangibles (2)  retained (2)  vat_output (2)
--   customer_deposits (1)  long_term_debt (1)  opex (1)
--   other_current_liability (1)  prepaid (1)
--
-- Five of those are the SAME concept under a different spelling than 0028
-- chose (vat_output/output_vat, prepaid/prepayments, retained/
-- retained_earnings, customer_deposits/customer_advances) — so the catalog had
-- two names for one thing, and only one of them existed.
--
-- Left as-is, every one of those 25 accounts would fall through to the legacy
-- code-prefix path on the very first run of the new classifier: a third of the
-- chart quietly "unmapped" on day one, which is exactly the outcome the
-- classifier was built to eliminate.
--
-- WHY BOTH SPELLINGS ARE KEPT rather than rewriting the accounts: renaming
-- report_section on 25 live accounts is a data migration that changes what the
-- statements read, and it belongs in the reviewable manifest with the rest of
-- the structural work — not in a catalog top-up. Adding the row is additive and
-- reversible; rewriting the account is neither. The duplicate ids are marked in
-- `parent_group` so the manifest can converge them later.
--
-- INSERT IGNORE keeps this re-runnable and never overwrites an edited row.
-- ════════════════════════════════════════════════════════════════════

INSERT IGNORE INTO statement_sections
  (id, statement, parent_group, name_ar, name_en, normal_balance, is_contra, display_order) VALUES
  -- Balance sheet — genuinely missing concepts
  ('intangibles',             'balance_sheet','nonCurrentAssets',  'أصول غير ملموسة',        'Intangible assets',           'debit', 0, 85),
  ('rou',                     'balance_sheet','nonCurrentAssets',  'أصول حق الاستخدام',      'Right-of-use assets',         'debit', 0, 86),
  ('other_current_asset',     'balance_sheet','currentAssets',     'أصول متداولة أخرى',      'Other current assets',        'debit', 0, 90),
  ('short_term_debt',         'balance_sheet','currentLiabilities','قروض قصيرة الأجل',       'Short-term debt',             'credit',0, 160),
  ('other_current_liability', 'balance_sheet','currentLiabilities','التزامات متداولة أخرى',  'Other current liabilities',   'credit',0, 165),
  ('long_term_debt',          'balance_sheet','nonCurrentLiabilities','قروض طويلة الأجل',    'Long-term debt',              'credit',0, 170),
  ('lease_obligation',        'balance_sheet','nonCurrentLiabilities','التزامات عقود الإيجار','Lease obligations',          'credit',0, 175),
  ('eosb',                    'balance_sheet','nonCurrentLiabilities','مكافأة نهاية الخدمة', 'End-of-service benefits',     'credit',0, 180),
  ('gosi',                    'balance_sheet','currentLiabilities','التأمينات الاجتماعية',   'GOSI payable',                'credit',0, 185),
  ('withholding',             'balance_sheet','currentLiabilities','ضريبة الاستقطاع',        'Withholding tax',             'credit',0, 190),
  ('zakat',                   'balance_sheet','currentLiabilities','الزكاة',                 'Zakat',                       'credit',0, 195),
  ('net_vat',                 'balance_sheet','currentLiabilities','صافي ضريبة القيمة المضافة','Net VAT',                   'credit',0, 200),

  -- The five alternate spellings already live in the data. Same concept as the
  -- 0028 row named in parent_group; kept so nothing falls through today.
  ('vat_input',               'balance_sheet','alias:input_vat',        'ضريبة المدخلات',      'Input VAT',            'debit', 0, 61),
  ('vat_output',              'balance_sheet','alias:output_vat',       'ضريبة المخرجات',      'Output VAT',           'credit',0, 141),
  ('prepaid',                 'balance_sheet','alias:prepayments',      'مصروفات مدفوعة مقدمًا','Prepayments',         'debit', 0, 51),
  ('retained',                'balance_sheet','alias:retained_earnings','أرباح مبقاة',         'Retained earnings',    'credit',0, 221),
  ('customer_deposits',       'balance_sheet','alias:customer_advances','دفعات مقدمة من عملاء','Customer advances',    'credit',0, 151),

  -- Income statement — the two broad buckets the chart uses directly.
  ('revenue',                 'income_statement','revenue','الإيرادات',            'Revenue',            'credit',0, 300),
  ('opex',                    'income_statement','opex',   'مصروفات تشغيلية',      'Operating expenses', 'debit', 0, 500);
