'use strict';
/**
 * scripts/clean-test-residue.js — one-shot cleaner for HISTORICAL integration-test
 * residue in the LOCAL database.
 *
 * Why it exists: before the test suites grew mandatory cleanup, several runs wrote
 * permanently into the real ledger (proven live: 15 gl_journals with
 * posted_by='itest', invoices SI-20260701-0001..0005 with their lines/returns/
 * credit notes/payments). Reports built on gl_entries/ar_documents read that
 * residue as company history.
 *
 * Contract:
 *   · DRY-RUN BY DEFAULT — prints exactly what would be deleted, per table, with
 *     sample ids. `--apply` performs the delete.
 *   · DETERMINISTIC identification only: test-identity patterns on identity
 *     columns (ITEST-% ids, itest% actors) plus child→parent graph traversal from
 *     those anchors. NEVER by date — a date range would sweep real documents.
 *   · ONE transaction on apply: a half-cleaned graph is itself residue.
 *   · doc_counters is never touched (burnt serials are how numbering works; the
 *     key is date-shaped and a real document could share it).
 *   · REFUSES to run against production (NODE_ENV=production or any RAILWAY_* env)
 *     — production residue, if ever proven, is a migration with its own review.
 *   · Before/after row-count report for every touched table.
 *
 * Run:  node scripts/clean-test-residue.js            (dry-run)
 *       node scripts/clean-test-residue.js --apply
 */
require('dotenv').config();
const db = require('../db/connection');

const APPLY = process.argv.includes('--apply');

// Identity conventions used by every integration suite in tests/ — these are the
// anchors. A pattern here must be a TEST convention, never a plausible real value.
const ID_LIKE = 'ITEST-%';          // fixture ids: warehouses, items, menu, sales, ar_documents, brands, shifts, periods…
const ACTOR_LIKE = 'itest%';        // actors: 'itest', 'itest-roy', 'itest_waste_cashier', …

function fmt(rows) { return rows.slice(0, 5).map((r) => r.id || r.username || JSON.stringify(r)).join(', ') + (rows.length > 5 ? ` … (+${rows.length - 5})` : ''); }

async function main() {
  // ── production guard ────────────────────────────────────────────────────────
  const prodMarkers = Object.keys(process.env).filter((k) => k.startsWith('RAILWAY_'));
  if (process.env.NODE_ENV === 'production' || prodMarkers.length) {
    console.error('REFUSED: production environment detected (' +
      (process.env.NODE_ENV === 'production' ? 'NODE_ENV=production' : prodMarkers.join(',')) +
      '). This tool is for the LOCAL database only.');
    process.exit(2);
  }

  const q = async (sql, a) => { try { const [r] = await db.query(sql, a || []); return r; } catch (e) { if (e && e.code === 'ER_NO_SUCH_TABLE') return []; throw e; } };
  const count = async (t) => { const r = await q('SELECT COUNT(*) c FROM `' + t + '`'); return r.length ? Number(r[0].c) : null; };

  // ── 1. anchors: identify by test-identity patterns ─────────────────────────
  // Historical o2cServices runs (pre-deterministic-fixtures) minted RANDOM ids
  // for their customers — the surviving anchor on those rows is created_by='itest'.
  const custIds = (await q('SELECT id FROM customers WHERE id LIKE ? OR created_by LIKE ?', [ID_LIKE, ACTOR_LIKE])).map((r) => r.id);
  const userNames = (await q('SELECT username FROM users WHERE username LIKE ?', [ACTOR_LIKE])).map((r) => r.username);

  // ar_documents: by own id, by test creator, or hanging off a test customer.
  const docSet = new Set();
  for (const r of await q('SELECT id FROM ar_documents WHERE id LIKE ? OR created_by LIKE ? OR document_number LIKE ?', [ID_LIKE, ACTOR_LIKE, ID_LIKE])) docSet.add(r.id);
  if (custIds.length) {
    const ph = custIds.map(() => '?').join(',');
    for (const r of await q(`SELECT id FROM ar_documents WHERE customer_id IN (${ph})`, custIds)) docSet.add(r.id);
  }

  // returns hanging off those documents (and their credit notes, wherever created).
  const retSet = new Set();
  for (const r of await q('SELECT id, credit_note_id FROM sales_returns WHERE id LIKE ? OR created_by LIKE ?', [ID_LIKE, ACTOR_LIKE])) { retSet.add(r.id); if (r.credit_note_id) docSet.add(r.credit_note_id); }
  if (docSet.size) {
    const ids = [...docSet]; const ph = ids.map(() => '?').join(',');
    for (const r of await q(`SELECT id, credit_note_id FROM sales_returns WHERE original_ar_document_id IN (${ph})`, ids)) { retSet.add(r.id); if (r.credit_note_id) docSet.add(r.credit_note_id); }
  }

  const payIds = new Set();
  for (const r of await q('SELECT id FROM customer_payments WHERE id LIKE ? OR created_by LIKE ?', [ID_LIKE, ACTOR_LIKE])) payIds.add(r.id);
  if (custIds.length) {
    const ph = custIds.map(() => '?').join(',');
    for (const r of await q(`SELECT id FROM customer_payments WHERE customer_id IN (${ph})`, custIds)) payIds.add(r.id);
  }

  // legacy sales fixtures + their projections
  const saleIds = (await q('SELECT id FROM sales WHERE id LIKE ? OR client_order_id LIKE ?', [ID_LIKE, ID_LIKE])).map((r) => r.id);
  if (saleIds.length) {
    const ph = saleIds.map(() => '?').join(',');
    for (const r of await q(`SELECT id FROM ar_documents WHERE source_type='pos' AND source_id IN (${ph})`, saleIds)) docSet.add(r.id);
  }

  // journals: by test poster, or referencing anything in the graph above.
  const jSet = new Set();
  for (const r of await q('SELECT id FROM gl_journals WHERE posted_by LIKE ? OR created_by LIKE ? OR reference_id LIKE ?', [ACTOR_LIKE, ACTOR_LIKE, ID_LIKE])) jSet.add(r.id);
  const refIds = [...docSet, ...retSet, ...payIds, ...saleIds];
  for (let i = 0; i < refIds.length; i += 200) {
    const chunk = refIds.slice(i, i + 200);
    const ph = chunk.map(() => '?').join(',');
    for (const r of await q(`SELECT id FROM gl_journals WHERE reference_id IN (${ph})`, chunk)) jSet.add(r.id);
  }

  // simple ITEST-% fixture tables (id-anchored, no children beyond what's above)
  const simpleTables = ['warehouses', 'inv_items', 'menu', 'shifts', 'brands', 'accounting_periods', 'waste_entries', 'royalty_runs'];
  const simple = {};
  for (const t of simpleTables) simple[t] = (await q('SELECT id FROM `' + t + '` WHERE id LIKE ?', [ID_LIKE])).map((r) => r.id);

  // ── 2. report ───────────────────────────────────────────────────────────────
  const plan = [
    ['gl_journals (+entries)', [...jSet]],
    ['ar_documents (+lines/components)', [...docSet]],
    ['sales_returns (+lines/components)', [...retSet]],
    ['customer_payments (+allocations)', [...payIds]],
    ['sales (+items/movements)', saleIds],
    ['customers', custIds],
    ['users', userNames],
    ...simpleTables.map((t) => [t, simple[t]]),
  ];
  console.log(APPLY ? '═══ APPLY ═══' : '═══ DRY-RUN (nothing deleted; use --apply) ═══');
  let total = 0;
  for (const [label, ids] of plan) {
    total += ids.length;
    console.log(`  ${label.padEnd(38)} ${String(ids.length).padStart(4)}  ${ids.length ? fmt(ids.map((id) => ({ id }))) : ''}`);
  }
  if (!total) { console.log('\n  ✓ clean — no test residue found.'); return 0; }
  if (!APPLY) { console.log(`\n  ${total} anchor rows matched. Re-run with --apply to delete (children included).`); return 0; }

  // ── 3. apply: one transaction, children → parents ───────────────────────────
  const before = {};
  const touched = ['gl_entries', 'gl_journals', 'ar_events', 'ar_document_line_components', 'ar_document_lines', 'ar_documents',
    'sales_return_line_components', 'sales_return_lines', 'sales_returns', 'ar_payment_allocations', 'customer_payments',
    'sales_items', 'inventory_movements', 'sales', 'customers', 'users', 'warehouse_stock', 'waste_entry_items', ...simpleTables];
  for (const t of touched) before[t] = await count(t);

  await db.withTransaction(async (conn) => {
    const del = async (sql, a) => { try { await conn.query(sql, a || []); } catch (e) { if (e && e.code === 'ER_NO_SUCH_TABLE') return; throw e; } };
    const each = async (ids, fn) => { for (const id of ids) await fn(id); };

    await each([...jSet], async (j) => { await del('DELETE FROM gl_entries WHERE journal_id = ?', [j]); await del('DELETE FROM gl_journals WHERE id = ?', [j]); });
    await each([...docSet, ...retSet, ...payIds], async (id) => del('DELETE FROM ar_events WHERE entity_id = ?', [id]));
    await each([...retSet], async (r) => { await del('DELETE FROM sales_return_line_components WHERE return_id = ?', [r]); await del('DELETE FROM sales_return_lines WHERE return_id = ?', [r]); await del('DELETE FROM sales_returns WHERE id = ?', [r]); });
    await each([...payIds], async (p) => { await del('DELETE FROM ar_payment_allocations WHERE payment_id = ?', [p]); await del('DELETE FROM customer_payments WHERE id = ?', [p]); });
    await each([...docSet], async (d) => { await del('DELETE FROM ar_document_line_components WHERE document_id = ?', [d]); await del('DELETE FROM ar_document_lines WHERE document_id = ?', [d]); await del('DELETE FROM ar_documents WHERE id = ?', [d]); });
    await each(saleIds, async (s) => { await del('DELETE FROM sales_items WHERE order_id = ?', [s]); await del('DELETE FROM inventory_movements WHERE reference_id = ? OR notes LIKE ?', [s, s + '%']); await del('DELETE FROM sales WHERE id = ?', [s]); });
    await each(custIds, async (c) => del('DELETE FROM customers WHERE id = ?', [c]));
    await each(userNames, async (u) => del('DELETE FROM users WHERE username = ?', [u]));
    await each(simple.waste_entries || [], async (w) => del('DELETE FROM waste_entry_items WHERE waste_id = ?', [w]));
    await each(simple.warehouses || [], async (w) => { await del('DELETE FROM warehouse_stock WHERE warehouse_id = ?', [w]); await del('DELETE FROM inventory_movements WHERE warehouse_id = ?', [w]); });
    for (const t of simpleTables) await each(simple[t] || [], async (id) => del('DELETE FROM `' + t + '` WHERE id = ?', [id]));
  });

  console.log('\n═══ before → after ═══');
  for (const t of touched) {
    const after = await count(t);
    if (before[t] !== after) console.log(`  ${t.padEnd(30)} ${String(before[t]).padStart(6)} → ${after}`);
  }
  console.log('\n  ✓ applied in one transaction. doc_counters untouched by design.');
  return 0;
}

main()
  .then(async (code) => { await db.end(); process.exit(code); })
  .catch(async (e) => { console.error('FAILED (transaction rolled back):', (e && e.message) || e); try { await db.end(); } catch (_) {} process.exit(1); });
