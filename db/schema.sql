-- ============================================
-- Moroccan Taste POS/ERP - MySQL Schema
-- ============================================

CREATE DATABASE IF NOT EXISTS moroccan_taste_pos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE moroccan_taste_pos;

-- ─── Users ───
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin','cashier','manager') DEFAULT 'cashier',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── Settings ───
CREATE TABLE settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT
) ENGINE=InnoDB;

INSERT INTO settings VALUES ('CompanyName','Moroccan Taste'),('TaxNumber','314170726400003'),('Currency','SAR'),('VATRate','15');

-- ─── Payment Methods ───
CREATE TABLE payment_methods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  name_ar VARCHAR(100),
  icon VARCHAR(50) DEFAULT 'fa-money-bill',
  is_active BOOLEAN DEFAULT TRUE,
  service_fee_rate DECIMAL(5,2) DEFAULT 0,
  sort_order INT DEFAULT 0,
  UNIQUE KEY uq_pm_name (name)  -- B5: idempotent default seeding under concurrent boot
) ENGINE=InnoDB;

INSERT IGNORE INTO payment_methods (name, name_ar, icon, is_active, sort_order) VALUES
  ('Cash','كاش','fa-money-bill-wave',1,1),
  ('Card','مدى/شبكة','fa-credit-card',1,2),
  ('Kita','كيتا','fa-calculator',1,3),
  ('Transfer','تحويل بنكي','fa-university',0,4),
  ('Split','تجزئة','fa-divide',1,5);

-- ─── Menu (Products) ───
-- v6.5.0 NOTE — `menu` now holds FINISHED products only. Semi-finished
-- intermediates (production outputs, e.g. "cold drink base") moved to
-- `inv_items` with kind='semi'. The legacy is_semi_finished + the four
-- production_*/consumes_semi_* columns are still added by the runtime
-- migration in server.js for back-compat reads, but new writes that
-- flag a menu row as semi are rejected at the API (HTTP 410, see
-- routes/menu.js POST + PUT). The startup migration in server.js auto-
-- copies any leftover semi-finished menu rows into inv_items and soft-
-- deletes them here.
CREATE TABLE menu (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  category VARCHAR(100) DEFAULT 'عام',
  cost DECIMAL(10,2) DEFAULT 0,
  stock INT DEFAULT 999,
  min_stock INT DEFAULT 5,
  active BOOLEAN DEFAULT TRUE,
  -- v6.0.2 Wave B.3 — ZATCA tax category for the line. S=standard 15%,
  -- Z=zero-rated, E=exempt, O=out-of-scope. Defaults to S for back-compat.
  tax_category ENUM('S','Z','E','O') NOT NULL DEFAULT 'S',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── Discounts ───
CREATE TABLE discounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type ENUM('PERCENT','FIXED') DEFAULT 'PERCENT',
  value DECIMAL(10,2) DEFAULT 0
) ENGINE=InnoDB;

-- ─── INV Items (Raw Materials + Semi-Finished) ───
-- v6.5.0 — `kind` makes inv_items the unified inventory home for BOTH
-- raw materials AND semi-finished production outputs. Before v6.5.0
-- semi-finished items lived in `menu` with is_semi_finished=1; the
-- v6.5.0 startup migration in server.js copies them here and soft-
-- deletes the menu copies.
CREATE TABLE inv_items (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  name_en VARCHAR(200),
  category VARCHAR(100),
  cost DECIMAL(10,4) DEFAULT 0,
  stock DECIMAL(12,2) DEFAULT 0,
  min_stock DECIMAL(12,2) DEFAULT 0,
  unit VARCHAR(50) DEFAULT 'حبة',
  big_unit VARCHAR(50),
  conv_rate DECIMAL(10,2) DEFAULT 1,
  active BOOLEAN DEFAULT TRUE,
  -- v6.5.0 Wave — semi-finished items unified into inv_items
  kind ENUM('raw','semi') NOT NULL DEFAULT 'raw',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_inv_items_kind (kind)
) ENGINE=InnoDB;

-- ─── Recipe (Product Ingredients) ───
CREATE TABLE recipe (
  id INT AUTO_INCREMENT PRIMARY KEY,
  menu_id VARCHAR(50) NOT NULL,
  menu_name VARCHAR(200),
  inv_item_id VARCHAR(50) NOT NULL,
  inv_item_name VARCHAR(200),
  qty_used DECIMAL(10,4) NOT NULL DEFAULT 0,
  FOREIGN KEY (menu_id) REFERENCES menu(id) ON DELETE CASCADE,
  FOREIGN KEY (inv_item_id) REFERENCES inv_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Shifts ───
CREATE TABLE shifts (
  id VARCHAR(50) PRIMARY KEY,
  username VARCHAR(100),
  start_time DATETIME,
  end_time DATETIME,
  status ENUM('OPEN','closed') DEFAULT 'OPEN',
  total_theoretical DECIMAL(12,2) DEFAULT 0,
  theoretical_cash DECIMAL(12,2) DEFAULT 0,
  theoretical_card DECIMAL(12,2) DEFAULT 0,
  theoretical_kita DECIMAL(12,2) DEFAULT 0,
  actual_cash DECIMAL(12,2) DEFAULT 0,
  actual_card DECIMAL(12,2) DEFAULT 0,
  actual_kita DECIMAL(12,2) DEFAULT 0,
  diff_cash DECIMAL(12,2) DEFAULT 0,
  diff_card DECIMAL(12,2) DEFAULT 0,
  diff_kita DECIMAL(12,2) DEFAULT 0
) ENGINE=InnoDB;

-- ─── Sales ───
-- v6.0.2 — Canonical schema kept in sync with all runtime migrations
-- (server.js runMigrations). Fresh installs from this file boot with
-- the full column set; no migration-window column drift.
CREATE TABLE sales (
  id VARCHAR(50) PRIMARY KEY,
  order_date DATETIME NOT NULL,
  items_json TEXT,
  total_final DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(100),
  payment_notes TEXT NULL,
  customer_id VARCHAR(50) NULL,
  username VARCHAR(100),
  shift_id VARCHAR(50),
  discount_name VARCHAR(100),
  discount_amount DECIMAL(10,2) DEFAULT 0,
  kita_service_fee DECIMAL(10,2) DEFAULT 0,
  -- v5.12.2 sales channel + V3 discount linkage
  channel_id VARCHAR(50) DEFAULT NULL,
  channel_name VARCHAR(200) DEFAULT NULL,
  discount_id VARCHAR(50) DEFAULT NULL,
  discount_gl_id VARCHAR(50) DEFAULT NULL,
  line_discounts_json LONGTEXT,
  -- ZATCA Phase 1 + 2 metadata
  invoice_uuid VARCHAR(36),
  invoice_hash VARCHAR(100),
  previous_invoice_hash VARCHAR(100),
  zatca_type ENUM('standard','simplified','credit_note','debit_note') DEFAULT 'simplified',
  zatca_submitted_at DATETIME NULL,
  zatca_status ENUM('pending','submitted','accepted','rejected') DEFAULT 'pending',
  -- v6.0.2 Wave B.3 — per-category VAT subtotals (JSON keyed by S/Z/E/O)
  tax_subtotals_json LONGTEXT NULL,
  -- v6.0.3 Wave C.4 — structured split-payment breakdown (replaces legacy
  -- "method:amt/method:amt" string format). payment_method stays as 'Split'.
  split_details_json LONGTEXT NULL,
  -- v6.0.4 Wave D — flag set when at least one Credit Note has been
  -- issued against this sale. zatca_type stays 'simplified' on the
  -- original (immutability); the credit note has its own row in
  -- credit_notes with its own ZATCA identity.
  has_credit_note BOOLEAN NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL,
  INDEX idx_sales_customer (customer_id),
  INDEX idx_sales_channel (channel_id),
  INDEX idx_sales_zatca_status (zatca_status, zatca_submitted_at)
) ENGINE=InnoDB;

-- ─── v6.0.4 Wave D — Credit Notes (real ZATCA Type 381 docs) ───
-- Each row is a NEW invoice with its own UUID + hash, linked to the
-- original sale via original_invoice_uuid + original_invoice_hash.
-- See routes/sales.js POST /:orderId/return.
CREATE TABLE credit_notes (
  id VARCHAR(50) PRIMARY KEY,
  original_sale_id VARCHAR(50) NOT NULL,
  original_invoice_uuid VARCHAR(36),
  original_invoice_hash VARCHAR(100),
  invoice_uuid VARCHAR(36),
  invoice_hash VARCHAR(100),
  previous_invoice_hash VARCHAR(100),
  zatca_type ENUM('credit_note','debit_note') NOT NULL DEFAULT 'credit_note',
  zatca_status ENUM('pending','submitted','accepted','rejected') DEFAULT 'pending',
  zatca_submitted_at DATETIME NULL,
  zatca_qr_base64 TEXT NULL,
  issue_date DATE NOT NULL,
  issue_time VARCHAR(10),
  total_final DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
  vat_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax_subtotals_json LONGTEXT NULL,
  reason VARCHAR(200),
  reason_code VARCHAR(40),
  items_json LONGTEXT,
  customer_id VARCHAR(50),
  brand_id VARCHAR(50),
  branch_id VARCHAR(50),
  username VARCHAR(100),
  shift_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cn_original (original_sale_id),
  INDEX idx_cn_status (zatca_status),
  INDEX idx_cn_issue_date (issue_date)
) ENGINE=InnoDB;

-- ─── v6.1.0 Wave E.6 — ZATCA submission queue ───
CREATE TABLE zatca_submission_queue (
  id VARCHAR(50) PRIMARY KEY,
  doc_type ENUM('sale','credit_note') NOT NULL,
  doc_id VARCHAR(50) NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL,
  status ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  last_error TEXT NULL,
  zatca_response_json LONGTEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_zq_status (status, next_attempt_at),
  INDEX idx_zq_doc (doc_type, doc_id)
) ENGINE=InnoDB;

-- ─── v6.2.0 Wave F.3 — Accounting Periods (close-after-lock) ───
CREATE TABLE accounting_periods (
  id VARCHAR(50) PRIMARY KEY,
  period_label VARCHAR(20) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status ENUM('open','soft_close','closed','locked') NOT NULL DEFAULT 'open',
  brand_id VARCHAR(50),
  branch_id VARCHAR(50),
  closed_by VARCHAR(100),
  closed_at DATETIME,
  closing_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_period (period_label, brand_id, branch_id),
  INDEX idx_period_status (status, start_date, end_date)
) ENGINE=InnoDB;

-- ─── v6.0.3 Wave C.3 — Inventory Cost History ───
CREATE TABLE inventory_cost_history (
  id VARCHAR(50) PRIMARY KEY,
  item_id VARCHAR(50) NOT NULL,
  cost_before DECIMAL(14,4),
  cost_after  DECIMAL(14,4),
  reason ENUM('purchase','stocktake','manual','migration','sale','transfer','waste') NOT NULL,
  reference_id VARCHAR(50),
  changed_by VARCHAR(100),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ich_item (item_id, changed_at),
  INDEX idx_ich_reason (reason)
) ENGINE=InnoDB;

-- ─── Sales Items ───
CREATE TABLE sales_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL,
  order_date DATETIME,
  item_name VARCHAR(200),
  qty INT DEFAULT 1,
  price DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) DEFAULT 0,
  payment_method VARCHAR(100),
  username VARCHAR(100),
  shift_id VARCHAR(50),
  FOREIGN KEY (order_id) REFERENCES sales(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Inventory Movements ───
CREATE TABLE inventory_movements (
  id VARCHAR(50) PRIMARY KEY,
  movement_date DATETIME,
  item_id VARCHAR(50),
  item_name VARCHAR(200),
  type ENUM('in','out') NOT NULL,
  qty DECIMAL(12,2) NOT NULL,
  reason VARCHAR(200),
  username VARCHAR(100),
  notes TEXT,
  FOREIGN KEY (item_id) REFERENCES inv_items(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─── Expenses ───
CREATE TABLE expenses (
  id VARCHAR(50) PRIMARY KEY,
  expense_date DATETIME,
  category VARCHAR(100),
  description TEXT,
  amount DECIMAL(12,2) DEFAULT 0,
  payment_method VARCHAR(50),
  username VARCHAR(100),
  notes TEXT
) ENGINE=InnoDB;

-- ─── Purchases ───
CREATE TABLE purchases (
  id VARCHAR(50) PRIMARY KEY,
  purchase_date DATETIME,
  supplier_name VARCHAR(200),
  supplier_id VARCHAR(50),
  item_name VARCHAR(200),
  item_id VARCHAR(50),
  qty DECIMAL(12,2) DEFAULT 0,
  unit_price DECIMAL(10,2) DEFAULT 0,
  total_price DECIMAL(12,2) DEFAULT 0,
  payment_method VARCHAR(50) DEFAULT 'آجل',
  username VARCHAR(100),
  notes TEXT,
  status ENUM('draft','received') DEFAULT 'draft',
  items_json TEXT,
  po_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ═══ ERP Tables ═══

-- ─── Customers ───
-- v6.0.2 — phone is UNIQUE so the v5.11.4 upsert-by-phone flow cannot
-- produce siblings under concurrent checkouts.
CREATE TABLE customers (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  name_en VARCHAR(200),
  vat_number VARCHAR(50),
  phone VARCHAR(50),
  email VARCHAR(100),
  address TEXT,
  city VARCHAR(100),
  gender ENUM('male','female','unknown') NOT NULL DEFAULT 'unknown',
  customer_type ENUM('B2C','B2B','B2G') DEFAULT 'B2C',
  credit_limit DECIMAL(12,2) DEFAULT 0,
  balance DECIMAL(12,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by VARCHAR(100),
  UNIQUE KEY uq_customers_phone (phone),
  INDEX idx_customers_phone (phone)
) ENGINE=InnoDB;

-- ─── Suppliers ───
CREATE TABLE suppliers (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  name_en VARCHAR(200),
  vat_number VARCHAR(50),
  phone VARCHAR(50),
  email VARCHAR(100),
  address TEXT,
  city VARCHAR(100),
  payment_terms ENUM('Cash','Net30','Net60') DEFAULT 'Cash',
  balance DECIMAL(12,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by VARCHAR(100)
) ENGINE=InnoDB;

-- ─── GL Accounts (Chart of Accounts) ───
CREATE TABLE gl_accounts (
  id VARCHAR(50) PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name_ar VARCHAR(200) NOT NULL,
  name_en VARCHAR(200),
  type ENUM('asset','liability','equity','revenue','expense') NOT NULL,
  parent_id VARCHAR(50),
  level INT DEFAULT 1,
  is_active BOOLEAN DEFAULT TRUE,
  balance DECIMAL(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── GL Journals ───
CREATE TABLE gl_journals (
  id VARCHAR(50) PRIMARY KEY,
  journal_number VARCHAR(20),
  journal_date DATE,
  reference_type VARCHAR(50),
  reference_id VARCHAR(100),
  description TEXT,
  total_debit DECIMAL(14,2) DEFAULT 0,
  total_credit DECIMAL(14,2) DEFAULT 0,
  period_id VARCHAR(50),
  status ENUM('posted','draft') DEFAULT 'posted',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100),
  -- v6.4.2 — Reversing-entry linkage. Posted journals are immutable
  -- (SOCPA/IFRS); the only valid correction is a new journal with
  -- debits + credits swapped. These columns link original ↔ reversal.
  reversed_by_journal_id VARCHAR(50) NULL,
  reverses_journal_id    VARCHAR(50) NULL,
  reversed_at            DATETIME NULL,
  reversed_by            VARCHAR(100) NULL,
  UNIQUE KEY uq_journal_number (journal_number),
  INDEX idx_gl_reversed_by (reversed_by_journal_id),
  INDEX idx_gl_reverses    (reverses_journal_id)
) ENGINE=InnoDB;

-- ─── GL Entries ───
-- Dimension columns (brand_id / branch_id / cost_center_id / warehouse_id)
-- enable accounting-dimension filtering on every report. They're added by
-- idempotent migrations in server.js (see runMigrations) so existing DBs
-- pick them up at startup; declared here for fresh deployments.
CREATE TABLE gl_entries (
  id VARCHAR(50) PRIMARY KEY,
  journal_id VARCHAR(50) NOT NULL,
  account_id VARCHAR(50),
  account_code VARCHAR(20),
  account_name VARCHAR(200),
  debit DECIMAL(14,2) DEFAULT 0,
  credit DECIMAL(14,2) DEFAULT 0,
  description TEXT,
  brand_id VARCHAR(50),
  branch_id VARCHAR(50),
  cost_center_id VARCHAR(50),
  warehouse_id VARCHAR(50),
  INDEX idx_gle_brand (brand_id),
  INDEX idx_gle_branch (branch_id),
  INDEX idx_gle_cc (cost_center_id),
  FOREIGN KEY (journal_id) REFERENCES gl_journals(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─── Purchase Orders ───
CREATE TABLE purchase_orders (
  id VARCHAR(50) PRIMARY KEY,
  po_number VARCHAR(20),
  supplier_id VARCHAR(50),
  supplier_name VARCHAR(200),
  po_date DATE,
  expected_date DATE,
  status ENUM('draft','approved','received','cancelled') DEFAULT 'draft',
  total_before_vat DECIMAL(12,2) DEFAULT 0,
  vat_amount DECIMAL(12,2) DEFAULT 0,
  total_after_vat DECIMAL(12,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100),
  approved_by VARCHAR(100),
  approved_at DATETIME
) ENGINE=InnoDB;

-- ─── PO Lines ───
CREATE TABLE po_lines (
  id VARCHAR(50) PRIMARY KEY,
  po_id VARCHAR(50) NOT NULL,
  item_id VARCHAR(50),
  item_name VARCHAR(200),
  qty DECIMAL(12,2) DEFAULT 0,
  unit_price DECIMAL(10,2) DEFAULT 0,
  vat_rate DECIMAL(5,2) DEFAULT 15,
  vat_amount DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(12,2) DEFAULT 0,
  received_qty DECIMAL(12,2) DEFAULT 0,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── VAT Reports ───
CREATE TABLE vat_reports (
  id VARCHAR(50) PRIMARY KEY,
  period_start DATE,
  period_end DATE,
  total_output_vat DECIMAL(12,2) DEFAULT 0,
  total_input_vat DECIMAL(12,2) DEFAULT 0,
  net_vat DECIMAL(12,2) DEFAULT 0,
  status ENUM('draft','submitted','closed') DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100)
) ENGINE=InnoDB;

-- ─── Accounting Periods ───
CREATE TABLE accounting_periods (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100),
  start_date DATE,
  end_date DATE,
  status ENUM('open','closed') DEFAULT 'open',
  closed_by VARCHAR(100),
  closed_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── Payments ───
CREATE TABLE payments (
  id VARCHAR(50) PRIMARY KEY,
  payment_number VARCHAR(20),
  type VARCHAR(50),
  entity_type ENUM('customer','supplier'),
  entity_id VARCHAR(50),
  entity_name VARCHAR(200),
  invoice_id VARCHAR(50),
  amount DECIMAL(12,2) DEFAULT 0,
  payment_method VARCHAR(50),
  payment_date DATE,
  notes TEXT,
  status VARCHAR(20) DEFAULT 'posted',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100)
) ENGINE=InnoDB;

-- ─── Audit Log ───
CREATE TABLE audit_log (
  id VARCHAR(50) PRIMARY KEY,
  user_id VARCHAR(50),
  username VARCHAR(100),
  action VARCHAR(100),
  table_name VARCHAR(100),
  record_id VARCHAR(100),
  old_value TEXT,
  new_value TEXT,
  ip_address VARCHAR(50),
  device_info TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── Branches ───
CREATE TABLE branches (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200),
  code VARCHAR(20),
  location TEXT,
  type ENUM('main','branch') DEFAULT 'main',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100)
) ENGINE=InnoDB;

-- ─── Indexes for Performance ───
CREATE INDEX idx_sales_date ON sales(order_date);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_sales_items_order ON sales_items(order_id);
CREATE INDEX idx_purchases_date ON purchases(purchase_date);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_gl_entries_journal ON gl_entries(journal_id);
CREATE INDEX idx_gl_entries_account ON gl_entries(account_id);
CREATE INDEX idx_recipe_menu ON recipe(menu_id);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_audit_timestamp ON audit_log(created_at);
CREATE INDEX idx_shifts_status ON shifts(status);
CREATE INDEX idx_inv_movements_item ON inventory_movements(item_id);
