#!/usr/bin/env node
'use strict';
/**
 * ─── warehouse-v2 PREFLIGHT — data reconciliation (report-only) ──────────────
 *
 *   npm run warehouse:v2:preflight            human summary, exit 1 if any BLOCKER
 *   npm run warehouse:v2:preflight -- --json  also write a JSON report to artifacts/
 *   npm run warehouse:v2:preflight -- --csv   also write a CSV report to artifacts/
 *
 * NEVER mutates data. Every finding is classified BLOCKER | WARNING | INFO and
 * the process exits non-zero iff at least one BLOCKER has a positive count, so a
 * release gate / CI can consume it. Missing tables are reported as skipped (a
 * fresh empty DB therefore yields ZERO blockers).
 *
 * Run-as-module:  const { runPreflight } = require('./scripts/warehouse-v2-preflight');
 *                 const report = await runPreflight({ db });   // for tests
 */
const path = require('path');
const fs = require('fs');

const B = 'BLOCKER', W = 'WARNING', I = 'INFO';

// Each check returns { severity, title, rows }. The runner adds id/count/sample.
// A thrown ER_NO_SUCH_TABLE marks the check `skipped` (empty-DB friendly).
const CHECKS = [
  { id: 'lot_stock_drift', run: async (db) => ({
    severity: B, title: 'انحراف رصيد المخزون عن مجموع الدفعات (صنف مُتتبَّع)',
    rows: (await db.query(`SELECT * FROM (
        SELECT ws.warehouse_id, ws.item_id, ws.qty AS stock_qty,
          COALESCE((SELECT SUM(b.qty) FROM warehouse_lot_balances b WHERE b.warehouse_id=ws.warehouse_id AND b.item_id=ws.item_id),0) AS lot_qty
        FROM warehouse_stock ws JOIN inv_items i ON i.id=ws.item_id
        WHERE i.tracking_mode <> 'none'
      ) t WHERE ABS(t.stock_qty - t.lot_qty) > 0.001`))[0] }) },

  { id: 'tracked_no_lots', run: async (db) => ({
    severity: B, title: 'صنف مُتتبَّع له رصيد مخزون بلا دفعات',
    rows: (await db.query(`SELECT ws.warehouse_id, ws.item_id, ws.qty FROM warehouse_stock ws
        JOIN inv_items i ON i.id=ws.item_id
        WHERE i.tracking_mode <> 'none' AND ws.qty > 0.001
        AND NOT EXISTS (SELECT 1 FROM warehouse_lot_balances b WHERE b.warehouse_id=ws.warehouse_id AND b.item_id=ws.item_id AND b.qty<>0)`))[0] }) },

  { id: 'negative_lot_balance', run: async (db) => ({
    severity: B, title: 'رصيد دفعة سالب',
    rows: (await db.query('SELECT warehouse_id, lot_id, item_id, qty FROM warehouse_lot_balances WHERE qty < -0.001'))[0] }) },

  { id: 'negative_stock', run: async (db) => ({
    severity: B, title: 'رصيد مخزون سالب',
    rows: (await db.query('SELECT warehouse_id, item_id, qty FROM warehouse_stock WHERE qty < -0.001'))[0] }) },

  { id: 'gl_imbalance', run: async (db) => ({
    severity: B, title: 'قيد محاسبي غير متوازن (مدين ≠ دائن)',
    rows: (await db.query(`SELECT journal_id, ROUND(SUM(debit),2) AS d, ROUND(SUM(credit),2) AS c
        FROM gl_entries GROUP BY journal_id HAVING ABS(SUM(debit)-SUM(credit)) > 0.01`))[0] }) },

  { id: 'orphan_lot_balance', run: async (db) => ({
    severity: B, title: 'صف رصيد دفعة يتيم (lot_id غير موجود في inventory_lots)',
    rows: (await db.query('SELECT b.id, b.lot_id FROM warehouse_lot_balances b WHERE NOT EXISTS (SELECT 1 FROM inventory_lots l WHERE l.id=b.lot_id)'))[0] }) },

  { id: 'orphan_lot_item', run: async (db) => ({
    severity: B, title: 'دفعة بصنف غير موجود (item_id غير موجود في inv_items)',
    rows: (await db.query('SELECT l.id, l.item_id FROM inventory_lots l WHERE NOT EXISTS (SELECT 1 FROM inv_items i WHERE i.id=l.item_id)'))[0] }) },

  { id: 'orphan_lot_movement', run: async (db) => ({
    severity: B, title: 'حركة دفعة يتيمة (lot_id غير موجود)',
    rows: (await db.query('SELECT m.id, m.lot_id FROM inventory_lot_movements m WHERE NOT EXISTS (SELECT 1 FROM inventory_lots l WHERE l.id=m.lot_id)'))[0] }) },

  { id: 'movement_null_ref', run: async (db) => ({
    severity: B, title: 'حركة مخزون بلا مستودع/صنف (NULL)',
    rows: (await db.query("SELECT id, item_id, warehouse_id FROM inventory_movements WHERE item_id IS NULL OR item_id='' OR warehouse_id IS NULL OR warehouse_id=''"))[0] }) },

  { id: 'transfer_over_receipt', run: async (db) => ({
    severity: B, title: 'استلام تحويل أكبر من المُصدَر (received_qty > qty)',
    rows: (await db.query('SELECT id, transfer_id, source_lot_id, qty, received_qty FROM lot_transfer_allocations WHERE received_qty > qty + 0.001'))[0] }) },

  { id: 'duplicate_sku', run: async (db) => ({
    severity: B, title: 'SKU مكرر بعد التطبيع (sku_norm)',
    rows: (await db.query("SELECT sku_norm, COUNT(*) AS c FROM inv_items WHERE deleted_at IS NULL AND sku_norm IS NOT NULL AND sku_norm<>'' GROUP BY sku_norm HAVING c > 1"))[0] }) },

  // ── WARNINGS ────────────────────────────────────────────────────────────
  { id: 'movement_dangling_ref', run: async (db) => ({
    severity: W, title: 'حركة مخزون تشير إلى صنف/مستودع محذوف',
    rows: (await db.query(`SELECT m.id FROM inventory_movements m
        WHERE (m.item_id IS NOT NULL AND m.item_id<>'' AND NOT EXISTS (SELECT 1 FROM inv_items i WHERE i.id=m.item_id))
           OR (m.warehouse_id IS NOT NULL AND m.warehouse_id<>'' AND NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.id=m.warehouse_id))
        LIMIT 500`))[0] }) },

  { id: 'doc_without_audit', run: async (db) => {
    const rows = [];
    for (const [t, col] of [['inv_receipts', 'receipt'], ['inv_issues', 'issue'], ['inv_adjustments', 'adjustment']]) {
      const [r] = await db.query(`SELECT d.id, '${col}' AS doc_type FROM ${t} d
        WHERE d.status IN ('posted','reversed') AND NOT EXISTS (SELECT 1 FROM inv_tx_events e WHERE e.doc_id=d.id) LIMIT 200`);
      rows.push(...r);
    }
    return { severity: W, title: 'مستند مُرحَّل/معكوس بلا حدث تدقيق (inv_tx_events)', rows };
  } },

  { id: 'journal_without_doc', run: async (db) => ({
    severity: W, title: 'قيد محاسبي مخزني بلا مستند مصدر',
    rows: (await db.query(`SELECT j.id, j.reference_type, j.reference_id FROM gl_journals j
        WHERE j.reference_type IN ('inv_receipt','inv_issue','inv_adjustment')
          AND NOT EXISTS (SELECT 1 FROM inv_receipts r WHERE r.id=j.reference_id)
          AND NOT EXISTS (SELECT 1 FROM inv_issues s WHERE s.id=j.reference_id)
          AND NOT EXISTS (SELECT 1 FROM inv_adjustments a WHERE a.id=j.reference_id) LIMIT 200`))[0] }) },

  { id: 'stocktake_posted_no_adjustment', run: async (db) => ({
    severity: W, title: 'جرد مُرحَّل بفروقات بلا تسوية (adjustment_id فارغ)',
    rows: (await db.query("SELECT id, stocktake_number, total_variance_value FROM inv_stocktakes WHERE status='posted' AND (adjustment_id IS NULL OR adjustment_id='') AND ABS(COALESCE(total_variance_value,0)) > 0.001"))[0] }) },

  { id: 'illegal_doc_state', run: async (db) => {
    const rows = [];
    for (const t of ['inv_receipts', 'inv_issues', 'inv_adjustments']) {
      const [r] = await db.query(`SELECT id, '${t}' AS tbl, status FROM ${t} WHERE status='posted' AND posted_at IS NULL LIMIT 200`);
      rows.push(...r);
    }
    return { severity: W, title: 'حالة مستند غير قانونية (posted بلا posted_at)', rows };
  } },

  { id: 'inactive_in_open_docs', run: async (db) => {
    const rows = [];
    for (const [t, fk] of [['inv_receipt_items', 'receipt_id'], ['inv_issue_items', 'issue_id'], ['inv_adjustment_items', 'adjustment_id']]) {
      const parent = t.replace('_items', 's').replace('inv_adjustment_items'.replace('_items', 's'), 'inv_adjustments');
      const ptbl = t === 'inv_receipt_items' ? 'inv_receipts' : t === 'inv_issue_items' ? 'inv_issues' : 'inv_adjustments';
      const [r] = await db.query(`SELECT DISTINCT li.item_id FROM ${t} li
          JOIN ${ptbl} p ON p.id=li.${fk}
          JOIN inv_items i ON i.id=li.item_id
          WHERE p.status IN ('draft','approved') AND (i.active=0 OR i.deleted_at IS NOT NULL) LIMIT 200`);
      rows.push(...r);
    }
    return { severity: W, title: 'صنف غير نشط مُستخدَم في مستندات مفتوحة (draft/approved)', rows };
  } },

  { id: 'null_sku_active', run: async (db) => ({
    severity: W, title: 'صنف نشط بلا SKU',
    rows: (await db.query("SELECT id, name FROM inv_items WHERE deleted_at IS NULL AND active=1 AND (sku IS NULL OR sku='') LIMIT 500"))[0] }) },

  { id: 'users_denied_before_scope', run: async (db) => ({
    severity: W, title: 'مستخدمون سيُمنعون عند تفعيل Scope (بلا أي إسناد مستودع)',
    rows: (await db.query(`SELECT u.id, u.username, u.role FROM users u
        WHERE LOWER(COALESCE(u.role,'')) NOT IN ('admin') AND COALESCE(u.active,1)=1
          AND NOT EXISTS (SELECT 1 FROM user_warehouse_access a WHERE a.user_id=u.id) LIMIT 500`))[0] }) },

  // ── INFO ────────────────────────────────────────────────────────────────
  { id: 'transfer_in_transit', run: async (db) => ({
    severity: I, title: 'تخصيصات تحويل قيد العبور (لم تُستلَم بالكامل)',
    rows: (await db.query('SELECT transfer_id, source_lot_id, qty, received_qty FROM lot_transfer_allocations WHERE (qty - COALESCE(received_qty,0)) > 0.001 LIMIT 200'))[0] }) },

  { id: 'warehouses_without_users', run: async (db) => ({
    severity: I, title: 'مستودعات نشطة بلا أي مستخدم مُسنَد',
    rows: (await db.query(`SELECT w.id, w.name FROM warehouses w WHERE COALESCE(w.is_active,1)=1
        AND NOT EXISTS (SELECT 1 FROM user_warehouse_access a WHERE a.warehouse_id=w.id) LIMIT 500`))[0] }) },

  { id: 'totals_snapshot', run: async (db) => {
    const one = async (sql) => { try { const [r] = await db.query(sql); return r[0] || {}; } catch (_) { return {}; } };
    const stock = await one('SELECT COUNT(*) AS rows_n, ROUND(COALESCE(SUM(qty),0),3) AS qty_sum, ROUND(COALESCE(SUM(qty*avg_cost),0),2) AS value_sum FROM warehouse_stock');
    const tracked = await one("SELECT COUNT(*) AS items_n FROM inv_items WHERE tracking_mode<>'none' AND deleted_at IS NULL");
    const lots = await one('SELECT COUNT(*) AS lots_n, ROUND(COALESCE(SUM(qty),0),3) AS lot_qty_sum FROM warehouse_lot_balances');
    const trackedStock = await one("SELECT ROUND(COALESCE(SUM(ws.qty),0),3) AS tq FROM warehouse_stock ws JOIN inv_items i ON i.id=ws.item_id WHERE i.tracking_mode<>'none'");
    const parityOk = Math.abs(Number(lots.lot_qty_sum || 0) - Number(trackedStock.tq || 0)) <= 0.001;
    return { severity: I, title: 'لقطة إجماليات (لوحة/شبكة/تقارير)', rows: [{
      stock_rows: Number(stock.rows_n || 0), stock_qty: Number(stock.qty_sum || 0), stock_value: Number(stock.value_sum || 0),
      tracked_items: Number(tracked.items_n || 0), lot_balance_rows: Number(lots.lots_n || 0), lot_qty_sum: Number(lots.lot_qty_sum || 0),
      tracked_stock_qty: Number(trackedStock.tq || 0), tracked_parity_ok: parityOk,
    }] };
  } },
];

function _isMissingTable(e) {
  return e && (e.code === 'ER_NO_SUCH_TABLE' || /doesn'?t exist|Unknown column|Unknown table/i.test(String(e.message || '')));
}

async function runPreflight(opts) {
  const db = (opts && opts.db) || require('../db/connection');
  const results = [];
  for (const c of CHECKS) {
    try {
      const out = await c.run(db);
      const rows = out.rows || [];
      results.push({ id: c.id, severity: out.severity, title: out.title, count: rows.length, skipped: false, sample: rows.slice(0, 8) });
    } catch (e) {
      if (_isMissingTable(e)) {
        results.push({ id: c.id, severity: I, title: (c.id), count: 0, skipped: true, sample: [], note: 'جدول غير موجود — تم التخطّي' });
      } else {
        results.push({ id: c.id, severity: B, title: c.id + ' (فشل الفحص)', count: 1, skipped: false, sample: [{ error: String(e.message || e).slice(0, 300) }] });
      }
    }
  }
  const summary = { BLOCKER: 0, WARNING: 0, INFO: 0, skipped: 0 };
  for (const r of results) { if (r.skipped) summary.skipped++; else if (r.count > 0) summary[r.severity]++; }
  const blockers = results.filter((r) => !r.skipped && r.severity === B && r.count > 0);
  return { generatedAt: new Date().toISOString(), summary, blockers: blockers.length, checks: results };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function _fmt(report) {
  const order = { BLOCKER: 0, WARNING: 1, INFO: 2 };
  const icon = { BLOCKER: '⛔', WARNING: '⚠️ ', INFO: 'ℹ️ ' };
  const lines = ['', '═══ warehouse-v2 PREFLIGHT — ' + report.generatedAt + ' ═══', ''];
  const sorted = report.checks.slice().sort((a, b) => (order[a.severity] - order[b.severity]) || (b.count - a.count));
  for (const r of sorted) {
    if (r.skipped) { lines.push('  ⏭️  [SKIP] ' + r.id + ' — ' + (r.note || 'تم التخطّي')); continue; }
    const tag = r.count > 0 ? icon[r.severity] : '✅';
    lines.push('  ' + tag + ' [' + r.severity + '] ' + r.title + ' — ' + r.count);
    if (r.count > 0 && r.severity !== 'INFO') {
      for (const s of r.sample) lines.push('         · ' + JSON.stringify(s));
    } else if (r.severity === 'INFO' && r.sample.length) {
      lines.push('         · ' + JSON.stringify(r.sample[0]));
    }
  }
  lines.push('');
  lines.push('  الخلاصة: ⛔ ' + report.summary.BLOCKER + ' BLOCKER · ⚠️ ' + report.summary.WARNING + ' WARNING · ℹ️ ' + report.summary.INFO + ' INFO · ⏭️ ' + report.summary.skipped + ' skipped');
  lines.push('  القرار: ' + (report.blockers === 0 ? '✅ لا توجد عوائق (BLOCKER=0)' : '❌ يوجد ' + report.blockers + ' عائق — غير صالح للترقية'));
  lines.push('');
  return lines.join('\n');
}

function _toCsv(report) {
  const esc = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=+@\t\r-]/.test(s)) s = "'" + s;            // formula-injection guard
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const rows = [['id', 'severity', 'count', 'skipped', 'title']];
  for (const r of report.checks) rows.push([r.id, r.severity, r.count, r.skipped ? 'yes' : 'no', r.title]);
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

if (require.main === module) {
  (async () => {
    try { require('dotenv').config(); } catch (_) {}
    const args = process.argv.slice(2);
    const wantJson = args.includes('--json');
    const wantCsv = args.includes('--csv');
    const db = require('../db/connection');
    const report = await runPreflight({ db });
    process.stdout.write(_fmt(report) + '\n');
    if (wantJson || wantCsv) {
      const outDir = path.join(process.cwd(), 'artifacts');
      try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
      const stamp = report.generatedAt.replace(/[:.]/g, '-');
      if (wantJson) { const p = path.join(outDir, 'warehouse-v2-preflight-' + stamp + '.json'); fs.writeFileSync(p, JSON.stringify(report, null, 2)); console.log('JSON → ' + p); }
      if (wantCsv) { const p = path.join(outDir, 'warehouse-v2-preflight-' + stamp + '.csv'); fs.writeFileSync(p, _toCsv(report)); console.log('CSV → ' + p); }
    }
    try { const db2 = require('../db/connection'); if (db2.pool && db2.pool.end) await db2.pool.end(); } catch (_) {}
    process.exit(report.blockers === 0 ? 0 : 1);
  })().catch((e) => { console.error('PREFLIGHT FAILED:', e); process.exit(2); });
}

module.exports = { runPreflight, _fmt, _toCsv, CHECKS };
