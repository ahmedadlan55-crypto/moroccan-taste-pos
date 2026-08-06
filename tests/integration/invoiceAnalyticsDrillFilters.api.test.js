'use strict';
/* Integration — InvoiceService analytics drill filters against real MySQL.
 *
 * Five deliberately similar POS invoices prove that hour, cashier, menu item,
 * at-sale category and payment method select document ids — not merely a SQL
 * string. The one-row page / three-row total case pins pagination, and the
 * combined menu+category case proves both predicates apply to the SAME line.
 *
 * Run: node tests/integration/invoiceAnalyticsDrillFilters.api.test.js
 */
require('dotenv').config();
// MUST precede db/connection: this test writes fixtures and is never allowed to
// point at the developer or production database.
const harness = require('../helpers/testHarness');
harness.activate();
const db = require('../../db/connection');
const InvoiceService = require('../../services/order-to-cash/InvoiceService');

const P = 'ITEST-IADF';
const DAY = '2032-08-06';
const SCOPE = { all: true, branchIds: [] };
const DOCS = {
  A: `${P}-A`, B: `${P}-B`, C: `${P}-C`, D: `${P}-D`, E: `${P}-E`,
};

let pass = 0;
let fail = 0;
const failed = [];
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  ✅', name); }
  else {
    fail++; failed.push(name);
    console.log('  ❌', name, detail == null ? '' : '→ ' + JSON.stringify(detail).slice(0, 500));
  }
}
const same = (actual, expected) =>
  actual.slice().sort().join('|') === expected.slice().sort().join('|');
const ids = (result) => result.data.map((row) => String(row.id)).sort();

async function cleanup() {
  await db.query('DELETE FROM analytics_payment_facts WHERE source_id LIKE ?', [`${P}-%`]);
  await db.query('DELETE FROM ar_document_lines WHERE id LIKE ?', [`${P}-%`]);
  await db.query('DELETE FROM analytics_order_facts WHERE document_id LIKE ?', [`${P}-%`]);
  await db.query('DELETE FROM ar_documents WHERE id LIKE ?', [`${P}-%`]);
}

async function seedDocument(key, { hour, cashier, menuLines, method, subtotal }) {
  const id = DOCS[key];
  const total = Math.round(subtotal * 1.15 * 100) / 100;
  const vat = Math.round((total - subtotal) * 100) / 100;
  await db.query(
    `INSERT INTO ar_documents
       (id, document_number, document_type, source_type, source_id, issue_date,
        subtotal, vat_amount, total_amount, paid_amount, balance_amount, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, id, 'invoice', 'pos', `${id}-SALE`, DAY,
     subtotal, vat, total, total, 0, 'paid', cashier],
  );
  await db.query(
    `INSERT INTO analytics_order_facts
       (document_id, sale_id, order_type, source, origin, status, created_by,
        occurred_at_local, business_day, tz_snapshot, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, `${id}-SALE`, 'dine_in', 'pos', 'online', 'completed', cashier,
     `${DAY} ${String(hour).padStart(2, '0')}:15:00`, DAY, 'Asia/Riyadh', 'live'],
  );
  for (let i = 0; i < menuLines.length; i++) {
    const line = menuLines[i];
    await db.query(
      `INSERT INTO ar_document_lines
         (id, document_id, source_line_id, menu_id, description,
          entered_qty, base_qty, unit_price, vat_category, vat_rate,
          net_amount, vat_amount, gross_amount, category_name_snapshot, snapshot_provenance)
       VALUES (?,?,?,?,?,1,1,?,'S',15,?,?,? ,?,'at_sale')`,
      [`${id}-L${i + 1}`, id, `${i + 1}`, line.menu, line.category,
       subtotal / menuLines.length, subtotal / menuLines.length,
       vat / menuLines.length, total / menuLines.length, line.category],
    );
  }
  await db.query(
    `INSERT INTO analytics_payment_facts
       (source_type, source_id, line_no, document_id, method_raw, method_norm,
        direction, amount, occurred_at, occurred_at_local, business_day, provenance)
     VALUES ('pos_single',?,?,?, ?,?,'in',?,?,?,?,'live')`,
    [`${id}-PAY`, 0, id, method, method, total,
     `${DAY} ${String(hour).padStart(2, '0')}:16:00`,
     `${DAY} ${String(hour).padStart(2, '0')}:16:00`, DAY],
  );
}

async function list(extra, pageSize = 200) {
  return InvoiceService.list({
    scope: SCOPE,
    analyticsPopulation: true,
    q: P,
    from: DAY,
    to: DAY,
    pageSize,
    ...extra,
  });
}

(async () => {
  try {
    await harness.ensureSchema();
    await cleanup();

    await seedDocument('A', {
      hour: 10, cashier: `${P}-CASH-1`, method: 'cash', subtotal: 100,
      menuLines: [{ menu: `${P}-MENU-1`, category: `${P}-CAT-A` }],
    });
    await seedDocument('B', {
      hour: 10, cashier: `${P}-CASH-1`, method: 'card', subtotal: 200,
      menuLines: [{ menu: `${P}-MENU-2`, category: `${P}-CAT-B` }],
    });
    await seedDocument('C', {
      hour: 11, cashier: `${P}-CASH-2`, method: 'cash', subtotal: 300,
      menuLines: [{ menu: `${P}-MENU-1`, category: `${P}-CAT-A` }],
    });
    await seedDocument('D', {
      hour: 12, cashier: `${P}-CASH-3`, method: 'wallet', subtotal: 400,
      menuLines: [{ menu: `${P}-MENU-3`, category: `${P}-CAT-C` }],
    });
    // E carries MENU-1 and CAT-A, but on DIFFERENT lines. A combined filter
    // must not match it.
    await seedDocument('E', {
      hour: 10, cashier: `${P}-CASH-1`, method: 'cash', subtotal: 500,
      menuLines: [
        { menu: `${P}-MENU-1`, category: `${P}-CAT-B` },
        { menu: `${P}-MENU-2`, category: `${P}-CAT-A` },
      ],
    });

    const byHour = await list({ hour: '11' });
    check('hour=11 returns only the branch-local 11:xx invoice',
      same(ids(byHour), [DOCS.C]) && byHour.pagination.total === 1, byHour);

    const byCashier = await list({ cashierId: `${P}-CASH-1` });
    check('cashierId returns exactly that cashier’s three documents',
      same(ids(byCashier), [DOCS.A, DOCS.B, DOCS.E]) && byCashier.pagination.total === 3,
      { ids: ids(byCashier), pagination: byCashier.pagination });
    check('exact-filter totals come from the same cashier population',
      byCashier.totals.orders === 3 && byCashier.totals.net_ex_vat === 800 &&
      byCashier.totals.invoice_total === 920 && byCashier.totals.avg_ticket === 266.67,
      byCashier.totals);

    const byMenu = await list({ menuItemId: `${P}-MENU-1` });
    check('menuItemId matches invoice lines, without multiplying documents',
      same(ids(byMenu), [DOCS.A, DOCS.C, DOCS.E]) && byMenu.pagination.total === 3,
      { ids: ids(byMenu), pagination: byMenu.pagination });

    const byCategory = await list({ categoryId: `${P}-CAT-B` });
    check('categoryId matches the at-sale category-name snapshot',
      same(ids(byCategory), [DOCS.B, DOCS.E]) && byCategory.pagination.total === 2,
      { ids: ids(byCategory), pagination: byCategory.pagination });

    const byPayment = await list({ paymentMethod: 'card' });
    check('paymentMethod matches normalized tender facts',
      same(ids(byPayment), [DOCS.B]) && byPayment.pagination.total === 1, byPayment);

    const combined = await list({
      hour: '10', cashierId: `${P}-CASH-1`, paymentMethod: 'cash',
      menuItemId: `${P}-MENU-1`, categoryId: `${P}-CAT-A`,
    });
    check('combined drill is ANDed and menu/category must belong to the same line',
      same(ids(combined), [DOCS.A]) && combined.pagination.total === 1,
      { ids: ids(combined), pagination: combined.pagination });

    const paged = await list({ cashierId: `${P}-CASH-1` }, 1);
    check('pageSize=1 returns one row while pagination.total remains three',
      paged.data.length === 1 && paged.pagination.total === 3 && paged.pagination.totalPages === 3,
      { n: paged.data.length, pagination: paged.pagination });

    console.log(`\n${fail === 0 ? '✅' : '❌'} invoiceAnalyticsDrillFilters: ${pass} passed, ${fail} failed`);
    if (failed.length) console.log('   failed:', failed.join(' | '));
  } catch (error) {
    fail++;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    try { await cleanup(); } catch (error) { console.error('cleanup:', error && error.message); fail++; }
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
