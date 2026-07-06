#!/usr/bin/env node
/**
 * scripts/procurement/backfill.js — legacy → P2P data backfill (safe, idempotent).
 *
 * Runs on a LOCAL / TEST database only. Never on production. Two phases:
 *
 *   1. Classify every legacy `purchases` row into one of:
 *        po_placeholder | direct_invoice | received | credit_ap | cash | orphan
 *      Rows that can't be resolved go to a REVIEW report — never auto-written.
 *      A PO with no real invoice NEVER fabricates a supplier invoice; a receipt
 *      is only reconstructed where stock evidence (lots / movements) exists.
 *
 *   2. Detect duplicate suppliers by  VAT → phone → normalized name.  Exact-VAT
 *      duplicates are proposed; anything ambiguous is REVIEW-only (no auto-merge).
 *
 *   3. Populate P2P snapshot columns on legacy rows (base_qty, conversion factor,
 *      base_received_qty) so old documents render correctly in the new UI.
 *
 * Default is a DRY-RUN (report only). Pass --apply to write the (safe, additive)
 * snapshot backfills. Classification + dedup are always report-only.
 *
 * Usage:
 *   node scripts/procurement/backfill.js            # dry-run report
 *   node scripts/procurement/backfill.js --apply    # + write snapshot columns
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));

function normName(s) {
  return String(s || '')
    .trim().toLowerCase()
    .replace(/[ـ]/g, '')            // tatweel
    .replace(/[ً-ٟ]/g, '')     // arabic diacritics
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}
function normPhone(s) { return String(s || '').replace(/\D/g, ''); }

function classify(p) {
  const pm = String(p.payment_method || '').toLowerCase();
  const isCredit = /آجل|credit|ذمم/.test(pm);
  const isCash = /نقد|cash|كاش/.test(pm);
  if (p.po_id && p.status === 'draft') return 'po_placeholder';
  if (String(p.status) === 'received' || p.v2_receive_status === 'received' || p.v2_receive_status === 'partial') return 'received';
  if (isCredit) return 'credit_ap';
  if (isCash) return 'cash';
  if (!p.po_id && p.items_json) return 'direct_invoice';
  return 'orphan';
}

async function main({ apply }) {
  console.log(`\n=== Procurement backfill ${apply ? '(APPLY snapshots)' : '(DRY-RUN)'} ===`);

  // ── phase 1: classify legacy purchases ──
  const [purchases] = await db.query('SELECT id, po_id, status, v2_receive_status, payment_method, items_json, supplier_id FROM purchases');
  const classes = {};
  const orphans = [];
  for (const p of purchases) {
    const c = classify(p);
    classes[c] = (classes[c] || 0) + 1;
    if (c === 'orphan') orphans.push(p.id);
  }
  console.log('\n[classification]');
  for (const [k, v] of Object.entries(classes)) console.log(`  ${k}: ${v}`);
  if (orphans.length) console.log(`  ⚠ ${orphans.length} orphan rows → REVIEW (never auto-written): ${orphans.slice(0, 10).join(', ')}${orphans.length > 10 ? '…' : ''}`);
  if (!purchases.length) console.log('  (no legacy purchases rows)');

  // ── phase 2: supplier dedup detection ──
  const [suppliers] = await db.query('SELECT id, name, name_en, vat_number, phone FROM suppliers');
  const byVat = {}, byPhone = {}, byName = {};
  for (const s of suppliers) {
    if (s.vat_number) (byVat[String(s.vat_number).trim()] = byVat[String(s.vat_number).trim()] || []).push(s.id);
    const ph = normPhone(s.phone); if (ph) (byPhone[ph] = byPhone[ph] || []).push(s.id);
    const nm = normName(s.name); if (nm) (byName[nm] = byName[nm] || []).push(s.id);
  }
  const exactVat = Object.entries(byVat).filter(([, ids]) => ids.length > 1);
  const phoneDup = Object.entries(byPhone).filter(([, ids]) => ids.length > 1);
  const nameDup = Object.entries(byName).filter(([, ids]) => ids.length > 1);
  console.log('\n[supplier dedup]');
  console.log(`  exact-VAT duplicate clusters (auto-mergeable, operator-confirmed): ${exactVat.length}`);
  console.log(`  phone-only clusters (REVIEW): ${phoneDup.length}`);
  console.log(`  name-only clusters (REVIEW — never auto-merge): ${nameDup.length}`);
  const review = {
    orphanPurchases: orphans,
    supplierClusters: {
      byVat: exactVat.map(([vat, ids]) => ({ vat, ids })),
      byPhone: phoneDup.map(([ph, ids]) => ({ phone: ph, ids })),
      byName: nameDup.map(([nm, ids]) => ({ name: nm, ids })),
    },
  };

  // ── phase 3: snapshot backfill (safe, additive) ──
  console.log('\n[snapshot backfill]');
  if (apply) {
    const [r1] = await db.query(`UPDATE po_lines SET base_qty = COALESCE(base_qty, qty),
        conversion_factor_snapshot = CASE WHEN conversion_factor_snapshot = 1 AND conv_rate > 0 THEN conv_rate ELSE conversion_factor_snapshot END,
        base_received_qty = CASE WHEN base_received_qty = 0 AND received_qty > 0 THEN received_qty ELSE base_received_qty END,
        entered_qty = COALESCE(entered_qty, qty)
      WHERE base_qty IS NULL OR entered_qty IS NULL`);
    console.log(`  po_lines snapshots filled: ${r1.affectedRows}`);
    const [r2] = await db.query(`UPDATE supplier_invoice_lines SET base_qty = COALESCE(base_qty, quantity) WHERE base_qty IS NULL`);
    console.log(`  supplier_invoice_lines snapshots filled: ${r2.affectedRows}`);
    const [r3] = await db.query(`UPDATE purchase_receipt_lines SET base_qty = COALESCE(base_qty, quantity), base_unit_cost = COALESCE(base_unit_cost, unit_cost) WHERE base_qty IS NULL OR base_unit_cost IS NULL`);
    console.log(`  purchase_receipt_lines snapshots filled: ${r3.affectedRows}`);
  } else {
    const [[c1]] = await db.query('SELECT COUNT(*) c FROM po_lines WHERE base_qty IS NULL OR entered_qty IS NULL');
    const [[c2]] = await db.query('SELECT COUNT(*) c FROM supplier_invoice_lines WHERE base_qty IS NULL');
    console.log(`  would fill po_lines: ${c1.c}, supplier_invoice_lines: ${c2.c} (run with --apply)`);
  }

  console.log('\n[review report JSON]');
  console.log(JSON.stringify(review, null, 0));
  console.log(`\n=== backfill ${apply ? 'APPLIED' : 'DRY-RUN complete'} ===`);
  await db.end();
}

if (require.main === module) {
  main({ apply: process.argv.includes('--apply') }).catch((e) => { console.error('BACKFILL ERROR:', e.message); process.exit(1); });
}
module.exports = { main, classify, normName, normPhone };
