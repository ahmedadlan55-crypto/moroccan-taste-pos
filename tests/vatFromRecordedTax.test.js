#!/usr/bin/env node
'use strict';
/**
 * The VAT return reports the tax the system RECORDED — never a rate applied to
 * a total.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 * The return used to read one rate out of `settings.VATRate` and apply it to
 * every sale and every purchase:
 *
 *     vatAmount = total − total / (1 + rate/100)
 *
 * which is three defects in one line:
 *
 *   1. It TAXED THE UNTAXABLE. One rate for every document reports a zero-rated
 *      export, an exempt sale and a standard-rated one identically. The return's
 *      box structure exists because those differ; reporting them the same is a
 *      wrong filing, not a rounding difference.
 *
 *   2. It IGNORED THE RECORDED TAX. Every AR document stores `vat_amount`,
 *      computed at the time of the transaction from that transaction's own rate.
 *      The old code re-derived it from a global constant instead.
 *
 *   3. It READ THE WRONG LEDGER. `sales` is the POS order table; credit notes
 *      live in `ar_documents`. A refunded sale stayed in the return at full
 *      value, overstating output VAT by the whole credit note.
 *
 * This repository already forbids the same reasoning in analytics
 * (`scripts/audit/analytics-no-vat-constant.js`). The tax return itself was the
 * last place still doing it.
 */

const path = require('path');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra || '');
}

// ── Fixture ────────────────────────────────────────────────────────────────
// Deliberately built so a flat 15% would give a DIFFERENT answer:
//   · a standard-rated invoice          1000 net, 150 VAT
//   · a ZERO-RATED export               2000 net,   0 VAT   ← flat 15% ⇒ 300
//   · a credit note                     −400 net, −60 VAT   ← flat 15% ⇒ +60
// Recorded output VAT = 150 + 0 − 60 = 90.
// A rate-derived answer would be (1000+2000+400) × 15% ≈ 510 — not close.
const AR_DOCS = [
  { id: 'D1', document_number: 'INV-1', document_type: 'invoice', issue_date: '2026-03-05',
    subtotal: 1000, vat_amount: 150, total_amount: 1150, customer_name: 'عميل', status: 'issued', zatca_status: 'sent' },
  { id: 'D2', document_number: 'INV-2', document_type: 'invoice', issue_date: '2026-03-08',
    subtotal: 2000, vat_amount: 0, total_amount: 2000, customer_name: 'تصدير', status: 'issued', zatca_status: 'sent' },
  { id: 'D3', document_number: 'CN-1', document_type: 'credit_note', issue_date: '2026-03-12',
    subtotal: 400, vat_amount: 60, total_amount: 460, customer_name: 'عميل', status: 'issued', zatca_status: 'sent' },
];

const SUPPLIER_INVOICES = [
  { id: 'S1', invoice_no: 'P-1', issue_date: '2026-03-06', subtotal: 800, vat_amount: 120,
    total_amount: 920, supplier_name: 'مورد', vat_number: '3101', status: 'posted' },
];

function fakePool({ suppliersMissing = false } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      seen.push(text);
      if (/FROM settings/i.test(text)) return [[{ setting_value: '15' }]];
      if (/FROM ar_documents/i.test(text)) return [AR_DOCS];
      if (/FROM supplier_invoices/i.test(text)) {
        if (suppliersMissing) { const e = new Error("Table 'supplier_invoices' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
        return [SUPPLIER_INVOICES];
      }
      return [[]];
    },
  };
}

function loadVatRoute(opts) {
  const dbPath = require.resolve(path.join(__dirname, '..', 'db', 'connection.js'));
  const routePath = require.resolve(path.join(__dirname, '..', 'routes', 'erp', 'vat.js'));
  const savedDb = require.cache[dbPath];
  delete require.cache[routePath];
  const pool = fakePool(opts);
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  let router;
  try { router = require(routePath); }
  finally {
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    delete require.cache[routePath];
  }
  return { router, pool };
}

async function callTransactions(opts) {
  const { router, pool } = loadVatRoute(opts);
  const layer = router.stack.find((l) => l.route && /vat\/transactions/.test(l.route.path));
  if (!layer) throw new Error('vat/transactions route not found');
  const handler = layer.route.stack.map((s) => s.handle).pop();
  const req = { query: { startDate: '2026-03-01', endDate: '2026-03-31' }, user: { username: 't', role: 'admin' } };
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler(req, res, () => {});
  return { body: res.body, pool, status: res.statusCode };
}

(async () => {
  // ── The recorded tax, not the rate ────────────────────────────────────────
  {
    const { body, pool } = await callTransactions();
    check('handler answered', !!body, body);

    check('output VAT is the RECORDED tax (150 + 0 − 60 = 90)',
      Math.abs(body.outputVat - 90) < 0.005, body.outputVat);

    // The number a flat 15% would have produced. Asserting it is ABSENT is the
    // point — the two must not coincide, or the test proves nothing.
    const flatRateAnswer = (1000 + 2000 + 400) * 0.15;
    check('output VAT is NOT the flat-rate answer',
      Math.abs(body.outputVat - flatRateAnswer) > 1, { got: body.outputVat, flatRateAnswer });

    check('a ZERO-RATED document contributes zero, not 15%',
      body.transactions.find((t) => t.reference === 'INV-2')?.vatAmount === 0,
      body.transactions.find((t) => t.reference === 'INV-2'));

    check('a CREDIT NOTE reduces the liability instead of adding to it',
      body.transactions.find((t) => t.reference === 'CN-1')?.vatAmount === -60,
      body.transactions.find((t) => t.reference === 'CN-1'));

    check('input VAT is the recorded supplier tax',
      Math.abs(body.inputVat - 120) < 0.005, body.inputVat);
    check('net VAT = output − input',
      Math.abs(body.netVat - (90 - 120)) < 0.005, body.netVat);

    // The declared basis, so a client cannot mistake the source.
    check('the response declares it is not rate-derived',
      body.basis && body.basis.derivedFromRate === false, body.basis);
    check('the configured rate is still reported for display',
      body.vatRate === 15, body.vatRate);

    // THE LEDGER IT READS. `sales` is the POS order table and has no credit
    // notes; reading it is how a refund stayed in the return at full value.
    const readSales = pool.seen.some((s) => /\bFROM sales\b/i.test(s));
    check('it does NOT read the POS `sales` table', !readSales,
      pool.seen.filter((s) => /FROM \w+/i.test(s)).map((s) => (s.match(/FROM \w+/i) || [])[0]));
    check('it reads the AR document ledger',
      pool.seen.some((s) => /FROM ar_documents/i.test(s)));
  }

  // ── An absent subledger is reported, never zeroed ─────────────────────────
  {
    const { body } = await callTransactions({ suppliersMissing: true });
    check('missing supplier ledger yields null input VAT, not 0',
      body.inputVat === null, body.inputVat);
    check('…and null net VAT rather than a figure that overstates what is owed',
      body.netVat === null, body.netVat);
    check('…and says so in the basis', body.basis.input === 'unavailable', body.basis);
    // Zero would read as "no purchases this period" and understate the
    // deductible tax — i.e. overstate what the company owes ZATCA.
    check('output VAT is still reported', Math.abs(body.outputVat - 90) < 0.005, body.outputVat);
  }

  // ── The POSTING path — the one that writes to the ledger ─────────────────
  // GET only displays. POST /vat/post creates a GL journal AND a filed return,
  // so it derived the same fabricated figure and then POSTED it. A wrong
  // number on a screen is a wrong number; a wrong number in the ledger is a
  // wrong number the books now agree with.
  {
    const { router, pool } = loadVatRoute();
    const layer = router.stack.find((l) => l.route && String(l.route.path).includes("vat/post"));
    check("the posting route exists", !!layer, router.stack.map((l) => l.route && l.route.path));

    if (layer) {
      const handler = layer.route.stack.map((s) => s.handle).pop();
      const req = { body: { periodStart: "2026-03-01", periodEnd: "2026-03-31", username: "t" }, user: { username: "t", role: "admin" } };
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await handler(req, res, () => {});

      // The fake pool has no supplier_invoices in this scenario? It does — so
      // the settlement should reach the aggregates rather than the rate.
      const readSales = pool.seen.some((x) => /FROM sales/i.test(x));
      check("posting does NOT settle from the POS sales table", !readSales,
        pool.seen.filter((x) => /FROM w+/i.test(x)).map((x) => (x.match(/FROM w+/i) || [])[0]));
      check("posting reads the AR document ledger",
        pool.seen.some((x) => /FROM ar_documents/i.test(x)));
    }
  }

  // ── A settlement cannot proceed without the deductible side ──────────────
  {
    const { router } = loadVatRoute({ suppliersMissing: true });
    const layer = router.stack.find((l) => l.route && String(l.route.path).includes("vat/post"));
    if (layer) {
      const handler = layer.route.stack.map((s) => s.handle).pop();
      const req = { body: { periodStart: "2026-03-01", periodEnd: "2026-03-31" }, user: { username: "t" } };
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await handler(req, res, () => {});
      // Settling at zero input would post a liability for the FULL output VAT
      // and file a return claiming the company reclaimed nothing.
      check("refuses to settle when input VAT cannot be read",
        res.body && res.body.success === false && res.statusCode === 409, { status: res.statusCode, body: res.body });
      // The code, not just the status: a client distinguishes "cannot settle
      // yet" from any other 409 by this string, and a refusal it cannot
      // classify is a refusal it will retry blindly.
      check("…with a machine-readable reason",
        res.body && res.body.code === "INPUT_VAT_UNAVAILABLE", res.body && res.body.code);
    }
  }

  // ── The source rule, statically ───────────────────────────────────────────
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'erp', 'vat.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    // The exact shape of the defect: total − total/(1 + rate/100).
    check('no rate-derived VAT arithmetic remains in the route',
      !/\/\s*\(\s*1\s*\+/.test(src), 'found `/ (1 +` — the back-computation is back');
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ VAT return: recorded tax, credit notes netted, zero-rated respected — never a rate × total');
  console.log(pass + '/' + pass + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
