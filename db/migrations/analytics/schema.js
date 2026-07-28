/**
 * db/migrations/analytics/schema.js — additive, idempotent Unified Sales
 * Analytics schema. New tables only (never drops, never rewrites existing
 * rows); the transactional tables (`ar_documents`, `sales`, `pos_orders`, …)
 * are untouched apart from additive columns. Every new table is InnoDB /
 * utf8mb4 / utf8mb4_unicode_ci (matches base tables → no "Illegal mix of
 * collations" on joins), DECIMAL money. Safe on empty / partial DBs + rerun.
 *
 * TYPE-MATCHING NOTES (deviations from the sprint DDL spec, all for join
 * correctness against the REAL referenced tables):
 *   - document_id is VARCHAR(64), not VARCHAR(50): ar_documents.id is
 *     VARCHAR(64) (db/migrations/order-to-cash/schema.js) and a narrower
 *     column would truncate-or-mismatch on join.
 *   - brand/branch/warehouse/shift/channel/customer/menu ids stay VARCHAR(50)
 *     to match the legacy masters (branches.id, shifts.id, menu.id are all
 *     VARCHAR(50)); values flowing through ar_documents (VARCHAR(64)) always
 *     originate in those masters, so 50 is the true domain.
 *   - actor columns are VARCHAR(100) to match users.username /
 *     pos_orders.username VARCHAR(100) (spec said 100 too — kept).
 *   - meal-period seed times carry :59 seconds ('11:59:59') so an inclusive
 *     TIME comparison has no dead 59-second gap between periods.
 *   - the meal-period global seed is guarded by a SELECT instead of relying on
 *     INSERT IGNORE: the UNIQUE(branch_id, period_key) key never collides while
 *     branch_id IS NULL (MySQL treats NULLs as distinct), so INSERT IGNORE
 *     alone would duplicate the three global rows on every boot.
 */
'use strict';

const H = require('../order-to-cash/ddlHelpers');

const TBL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const ID = 'VARCHAR(50)';            // legacy master ids (branches/shifts/menu/…)
const DOCID = 'VARCHAR(64)';         // ar_documents.id — see header note
const ACTOR = 'VARCHAR(100)';        // users.username width
const MONEY = 'DECIMAL(14,2)';
const ROLLUP_MONEY = 'DECIMAL(16,2)';

async function apply(db, log = () => {}) {
  // ── 1. branch analytics attributes (additive on the legacy master) ────────
  if (await H.tableExists(db, 'branches')) {
    await H.addColumn(db, 'branches', 'timezone', "VARCHAR(64) NOT NULL DEFAULT 'Asia/Riyadh'", log);
    await H.addColumn(db, 'branches', 'day_close_time', "TIME NOT NULL DEFAULT '04:00:00'", log);
    await H.addColumn(db, 'branches', 'region', 'VARCHAR(100) NULL', log);
    await H.addColumn(db, 'branches', 'city', 'VARCHAR(100) NULL', log);
  }

  // ── 2. pos_orders capture columns ─────────────────────────────────────────
  if (await H.tableExists(db, 'pos_orders')) {
    await H.addColumn(db, 'pos_orders', 'guests', 'SMALLINT NULL', log);
    await H.addColumn(db, 'pos_orders', 'app_version', 'VARCHAR(40) NULL', log);
    await H.addColumn(db, 'pos_orders', 'source', 'VARCHAR(30) NULL', log);
  }

  // ── 3. ar_document_lines category snapshot ────────────────────────────────
  if (await H.tableExists(db, 'ar_document_lines')) {
    await H.addColumn(db, 'ar_document_lines', 'category_id_snapshot', 'VARCHAR(50) NULL', log);
    await H.addColumn(db, 'ar_document_lines', 'category_name_snapshot', 'VARCHAR(200) NULL', log);
    await H.addColumn(db, 'ar_document_lines', 'snapshot_provenance', "ENUM('at_sale','backfilled') NULL", log);
  }

  // ── 4. meal periods (global rows have branch_id NULL; branch rows override)
  await H.createTable(db, 'analytics_meal_periods', `
    CREATE TABLE analytics_meal_periods (
      id INT AUTO_INCREMENT PRIMARY KEY,
      branch_id ${ID} NULL,
      period_key VARCHAR(20) NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      UNIQUE KEY uq_amp_branch_period (branch_id, period_key)
    ) ${TBL}`, log);
  {
    // Guarded seed — see header note on why INSERT IGNORE is not enough here.
    const [g] = await db.query(
      'SELECT 1 FROM analytics_meal_periods WHERE branch_id IS NULL LIMIT 1');
    if (!g.length) {
      await db.query(`
        INSERT IGNORE INTO analytics_meal_periods (branch_id, period_key, start_time, end_time, sort) VALUES
          (NULL, 'breakfast', '05:00:00', '11:59:59', 1),
          (NULL, 'lunch',     '12:00:00', '16:59:59', 2),
          (NULL, 'dinner',    '17:00:00', '04:59:59', 3)`);
      log('  + analytics_meal_periods global defaults (breakfast/lunch/dinner)');
    }
  }

  // ── 5. order facts — one row per AR document, denormalized for reads ──────
  await H.createTable(db, 'analytics_order_facts', `
    CREATE TABLE analytics_order_facts (
      document_id ${DOCID} PRIMARY KEY,
      sale_id ${ID} NULL,
      pos_order_id ${ID} NULL,
      brand_id ${ID} NULL,
      branch_id ${ID} NULL,
      warehouse_id ${ID} NULL,
      shift_id ${ID} NULL,
      till_id ${ID} NULL,
      device_id VARCHAR(60) NULL,
      app_version VARCHAR(40) NULL,
      channel_id ${ID} NULL,
      order_type VARCHAR(20) NULL,
      source VARCHAR(30) NULL,
      origin VARCHAR(10) NULL,
      table_no VARCHAR(20) NULL,
      guests SMALLINT NULL,
      customer_id ${ID} NULL,
      status VARCHAR(20) NULL,
      created_by ${ACTOR} NULL,
      salesperson ${ACTOR} NULL,
      closed_by ${ACTOR} NULL,
      payment_collector ${ACTOR} NULL,
      discount_by ${ACTOR} NULL,
      void_by ${ACTOR} NULL,
      approved_by ${ACTOR} NULL,
      opened_at DATETIME NULL,
      closed_at DATETIME NULL,
      paid_at DATETIME NULL,
      occurred_at_local DATETIME NOT NULL,
      business_day DATE NOT NULL,
      tz_snapshot VARCHAR(64) NULL,
      discount_total ${MONEY} NOT NULL DEFAULT 0,
      rounding_amount ${MONEY} NOT NULL DEFAULT 0,
      tips_amount ${MONEY} NOT NULL DEFAULT 0,
      fees_amount ${MONEY} NOT NULL DEFAULT 0,
      provenance ENUM('live','backfilled') NOT NULL DEFAULT 'live',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_aof_day_branch (business_day, branch_id),
      KEY ix_aof_branch_day (branch_id, business_day),
      KEY ix_aof_shift (shift_id),
      KEY ix_aof_salesperson_day (salesperson, business_day)
    ) ${TBL}`, log);

  // ── 6. payment facts — one row per tender leg ─────────────────────────────
  await H.createTable(db, 'analytics_payment_facts', `
    CREATE TABLE analytics_payment_facts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      source_type ENUM('pos_split','pos_single','ar_receipt','refund','cn_refund') NOT NULL,
      source_id ${ID} NOT NULL,
      line_no INT NOT NULL DEFAULT 0,
      document_id ${DOCID} NULL,
      branch_id ${ID} NULL,
      brand_id ${ID} NULL,
      shift_id ${ID} NULL,
      method_raw VARCHAR(60) NULL,
      method_norm VARCHAR(40) NULL,
      provider VARCHAR(60) NULL,
      terminal VARCHAR(60) NULL,
      direction ENUM('in','out') NOT NULL,
      amount ${MONEY} NOT NULL DEFAULT 0,
      status ENUM('captured','settled','unknown') NOT NULL DEFAULT 'captured',
      settled_at DATETIME NULL,
      occurred_at DATETIME NULL,
      occurred_at_local DATETIME NULL,
      business_day DATE NULL,
      performed_by ${ACTOR} NULL,
      provenance ENUM('live','backfilled') NOT NULL DEFAULT 'live',
      UNIQUE KEY uq_apf_source (source_type, source_id, line_no),
      KEY ix_apf_day_branch_method (business_day, branch_id, method_norm),
      KEY ix_apf_document (document_id)
    ) ${TBL}`, log);

  // ── 7. modifier / combo-component facts ───────────────────────────────────
  // NOTE: component_menu_id is part of the UNIQUE but nullable — a NULL
  // (free-text modifier) row escapes dedupe by MySQL NULL semantics; the
  // projector must write '' rather than NULL when it needs replay protection.
  await H.createTable(db, 'analytics_modifier_facts', `
    CREATE TABLE analytics_modifier_facts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      document_id ${DOCID} NOT NULL,
      source_line_id VARCHAR(80) NOT NULL,
      parent_menu_id ${ID} NULL,
      component_menu_id ${ID} NULL,
      component_name_snapshot VARCHAR(200) NULL,
      qty DECIMAL(12,3) NOT NULL DEFAULT 0,
      price_delta DECIMAL(12,2) NULL,
      cost_snapshot DECIMAL(12,4) NULL,
      kind ENUM('combo_choice','modifier') NOT NULL,
      provenance ENUM('live','backfilled') NOT NULL DEFAULT 'live',
      UNIQUE KEY uq_amf_component (document_id, source_line_id, component_menu_id, kind),
      KEY ix_amf_document (document_id)
    ) ${TBL}`, log);

  // ── 8. till facts — every cash-drawer movement, one row each ──────────────
  await H.createTable(db, 'analytics_till_facts', `
    CREATE TABLE analytics_till_facts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      shift_id ${ID} NULL,
      branch_id ${ID} NULL,
      movement_type ENUM('open_float','cash_sale','cash_refund','pay_in','pay_out','close_count','deposit') NOT NULL,
      amount ${MONEY} NOT NULL DEFAULT 0,
      occurred_at DATETIME NULL,
      occurred_at_local DATETIME NULL,
      business_day DATE NULL,
      performed_by ${ACTOR} NULL,
      approved_by ${ACTOR} NULL,
      source_type VARCHAR(30) NOT NULL,
      source_id ${ID} NOT NULL,
      provenance ENUM('live','backfilled') NOT NULL DEFAULT 'live',
      UNIQUE KEY uq_atf_source (source_type, source_id, movement_type),
      KEY ix_atf_shift (shift_id),
      KEY ix_atf_day_branch (business_day, branch_id)
    ) ${TBL}`, log);

  // ── 9. sales budgets (monthly, per-branch, per-metric) ────────────────────
  await H.createTable(db, 'analytics_sales_budget', `
    CREATE TABLE analytics_sales_budget (
      id INT AUTO_INCREMENT PRIMARY KEY,
      brand_id ${ID} NULL,
      branch_id ${ID} NOT NULL,
      period_month DATE NOT NULL,
      metric ENUM('net_sales_ex_vat','orders','guests') NOT NULL,
      amount ${MONEY} NOT NULL DEFAULT 0,
      distribution ENUM('even','weekday_weighted') NOT NULL DEFAULT 'weekday_weighted',
      version INT NOT NULL DEFAULT 1,
      created_by ${ACTOR} NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_asb_branch_month_metric (branch_id, period_month, metric)
    ) ${TBL}`, log);

  // ── 10. rollups (rebuilt by the rollup worker; PKs are the grain) ─────────
  await H.createTable(db, 'analytics_daily_branch', `
    CREATE TABLE analytics_daily_branch (
      business_day DATE NOT NULL,
      brand_id ${ID} NULL,
      branch_id ${ID} NOT NULL,
      orders INT NOT NULL DEFAULT 0,
      guests INT NOT NULL DEFAULT 0,
      gross_product ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      discounts ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      returns_net ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      net_ex_vat ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      vat ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      invoice_total ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      rounding ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      tips ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      fees ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      cogs ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      gross_profit ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      voids_count INT NOT NULL DEFAULT 0,
      refunds_amount ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      PRIMARY KEY (business_day, branch_id)
    ) ${TBL}`, log);

  await H.createTable(db, 'analytics_daily_item', `
    CREATE TABLE analytics_daily_item (
      business_day DATE NOT NULL,
      branch_id ${ID} NOT NULL,
      menu_id ${ID} NOT NULL,
      category_id_snapshot VARCHAR(50) NULL,
      qty_sold DECIMAL(14,3) NOT NULL DEFAULT 0,
      qty_returned DECIMAL(14,3) NOT NULL DEFAULT 0,
      gross ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      discount_alloc ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      net_ex_vat ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      vat ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      cogs ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      PRIMARY KEY (business_day, branch_id, menu_id)
    ) ${TBL}`, log);

  await H.createTable(db, 'analytics_daily_payment', `
    CREATE TABLE analytics_daily_payment (
      business_day DATE NOT NULL,
      branch_id ${ID} NOT NULL,
      method_norm VARCHAR(40) NOT NULL,
      direction ENUM('in','out') NOT NULL,
      amount ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      tx_count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (business_day, branch_id, method_norm, direction)
    ) ${TBL}`, log);

  await H.createTable(db, 'analytics_hourly_branch', `
    CREATE TABLE analytics_hourly_branch (
      business_day DATE NOT NULL,
      branch_id ${ID} NOT NULL,
      slot30 TINYINT NOT NULL,
      orders INT NOT NULL DEFAULT 0,
      net_ex_vat ${ROLLUP_MONEY} NOT NULL DEFAULT 0,
      guests INT NOT NULL DEFAULT 0,
      PRIMARY KEY (business_day, branch_id, slot30)
    ) ${TBL}`, log);

  // ── 11. rollup bookkeeping ────────────────────────────────────────────────
  await H.createTable(db, 'analytics_rollup_dirty', `
    CREATE TABLE analytics_rollup_dirty (
      branch_id ${ID} NOT NULL,
      business_day DATE NOT NULL,
      queued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (branch_id, business_day)
    ) ${TBL}`, log);

  await H.createTable(db, 'analytics_rollup_state', `
    CREATE TABLE analytics_rollup_state (
      k VARCHAR(40) PRIMARY KEY,
      v VARCHAR(200) NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ${TBL}`, log);

  await H.createTable(db, 'analytics_projection_repair', `
    CREATE TABLE analytics_projection_repair (
      source_type VARCHAR(30) NOT NULL,
      source_id ${ID} NOT NULL,
      queued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      PRIMARY KEY (source_type, source_id)
    ) ${TBL}`, log);

  // ── 12. export jobs + report schedules ────────────────────────────────────
  await H.createTable(db, 'export_jobs', `
    CREATE TABLE export_jobs (
      id ${ID} PRIMARY KEY,
      username ${ACTOR} NULL,
      request_json LONGTEXT NULL,
      columns_json LONGTEXT NULL,
      format ENUM('csv','xlsx') NOT NULL DEFAULT 'csv',
      status ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
      file_path VARCHAR(300) NULL,
      row_count INT NULL,
      last_included_at DATETIME NULL,
      definitions_version VARCHAR(20) NULL,
      scope_hash VARCHAR(64) NULL,
      error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      KEY ix_ej_status_created (status, created_at)
    ) ${TBL}`, log);
  // Header labels are a CLIENT fact: the metric/dimension registry carries ids
  // only, and the human names live in the UI dictionaries — which know the
  // reader's language. The requester's resolved labels ride along with the job
  // so the file header reads "صافي المبيعات", not "net_ex_vat".
  await H.addColumn(db, 'export_jobs', 'columns_json', 'LONGTEXT NULL', log);

  await H.createTable(db, 'report_schedules', `
    CREATE TABLE report_schedules (
      id ${ID} PRIMARY KEY,
      username ${ACTOR} NULL,
      name VARCHAR(120) NOT NULL,
      request_json LONGTEXT NULL,
      format ENUM('csv','xlsx') NOT NULL DEFAULT 'csv',
      freq ENUM('daily','weekly','monthly') NOT NULL,
      at_time TIME NOT NULL,
      weekday TINYINT NULL,
      month_day TINYINT NULL,
      timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Riyadh',
      is_active TINYINT NOT NULL DEFAULT 1,
      last_run_at DATETIME NULL,
      next_run_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_rs_active_next (is_active, next_run_at)
    ) ${TBL}`, log);

  // ── 13. anomaly_alerts dedupe key ─────────────────────────────────────────
  // anomaly_alerts is created by server.js runMigrations (§14 "Anomaly
  // Alerts", createTableIfMissing) and read/written by routes/anomalies.js.
  // A standalone `node scripts/analytics/migrate.js` run on a fresh DB may
  // execute before server.js ever booted, so create it compatibly here —
  // same shape as the server.js DDL — before altering it.
  if (!(await H.tableExists(db, 'anomaly_alerts'))) {
    await H.createTable(db, 'anomaly_alerts', `
      CREATE TABLE anomaly_alerts (
        id VARCHAR(40) PRIMARY KEY,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        severity ENUM('info','low','medium','high','critical') DEFAULT 'medium',
        category ENUM('financial','operational','behavioral','compliance','duplicate') DEFAULT 'financial',
        title VARCHAR(300),
        description TEXT,
        related_doc_type VARCHAR(40),
        related_doc_id VARCHAR(60),
        score DECIMAL(5,2),
        status ENUM('open','acknowledged','dismissed','resolved') DEFAULT 'open',
        acknowledged_by VARCHAR(80),
        acknowledged_at DATETIME,
        resolution_notes TEXT,
        INDEX idx_severity (severity, status),
        INDEX idx_doc (related_doc_type, related_doc_id),
        INDEX idx_status (status)
      ) ${TBL}`, log);
  }
  await H.addColumn(db, 'anomaly_alerts', 'dedupe_key', 'VARCHAR(120) NULL', log);
  await H.addIndex(db, 'anomaly_alerts', 'uq_anomaly_dedupe', 'dedupe_key', { unique: true }, log);

  // ── 14. read-path indexes on existing tables (idempotent, guarded) ────────
  if (await H.tableExists(db, 'ar_documents')) {
    await H.addIndex(db, 'ar_documents', 'ix_ard_type_status_date_branch',
      'document_type, status, issue_date, branch_id', {}, log);
  }
  if (await H.tableExists(db, 'ar_document_lines')) {
    await H.addIndex(db, 'ar_document_lines', 'ix_arl_menu', 'menu_id', {}, log);
  }
  if ((await H.tableExists(db, 'sales')) && (await H.columnExists(db, 'sales', 'branch_id'))) {
    await H.addIndex(db, 'sales', 'ix_sales_branch_day', 'branch_id, order_date', {}, log);
  }

  return true;
}

module.exports = { apply };
