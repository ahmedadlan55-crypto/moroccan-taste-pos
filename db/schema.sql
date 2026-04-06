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
  sort_order INT DEFAULT 0
) ENGINE=InnoDB;

INSERT INTO payment_methods (name, name_ar, icon, is_active, sort_order) VALUES
  ('Cash','كاش','fa-money-bill-wave',1,1),
  ('Card','مدى/شبكة','fa-credit-card',1,2),
  ('Kita','كيتا','fa-calculator',1,3),
  ('Transfer','تحويل بنكي','fa-university',0,4),
  ('Split','تجزئة','fa-divide',1,5);

-- ─── Menu (Products) ───
CREATE TABLE menu (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  category VARCHAR(100) DEFAULT 'عام',
  cost DECIMAL(10,2) DEFAULT 0,
  stock INT DEFAULT 999,
  min_stock INT DEFAULT 5,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── Discounts ───
CREATE TABLE discounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type ENUM('PERCENT','FIXED') DEFAULT 'PERCENT',
  value DECIMAL(10,2) DEFAULT 0
) ENGINE=InnoDB;

-- ─── INV Items (Raw Materials) ───
CREATE TABLE inv_items (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(100),
  cost DECIMAL(10,4) DEFAULT 0,
  stock DECIMAL(12,2) DEFAULT 0,
  min_stock DECIMAL(12,2) DEFAULT 0,
  unit VARCHAR(50) DEFAULT 'حبة',
  big_unit VARCHAR(50),
  conv_rate DECIMAL(10,2) DEFAULT 1,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
CREATE TABLE sales (
  id VARCHAR(50) PRIMARY KEY,
  order_date DATETIME NOT NULL,
  items_json TEXT,
  total_final DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(100),
  username VARCHAR(100),
  shift_id VARCHAR(50),
  discount_name VARCHAR(100),
  discount_amount DECIMAL(10,2) DEFAULT 0,
  kita_service_fee DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL
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
CREATE TABLE customers (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  name_en VARCHAR(200),
  vat_number VARCHAR(50),
  phone VARCHAR(50),
  email VARCHAR(100),
  address TEXT,
  city VARCHAR(100),
  customer_type ENUM('B2C','B2B','B2G') DEFAULT 'B2C',
  credit_limit DECIMAL(12,2) DEFAULT 0,
  balance DECIMAL(12,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(100),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by VARCHAR(100)
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
  created_by VARCHAR(100)
) ENGINE=InnoDB;

-- ─── GL Entries ───
CREATE TABLE gl_entries (
  id VARCHAR(50) PRIMARY KEY,
  journal_id VARCHAR(50) NOT NULL,
  account_id VARCHAR(50),
  account_code VARCHAR(20),
  account_name VARCHAR(200),
  debit DECIMAL(14,2) DEFAULT 0,
  credit DECIMAL(14,2) DEFAULT 0,
  description TEXT,
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
