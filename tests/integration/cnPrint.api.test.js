/* Integration — printable credit note + invoice stamp block (real server + DB).
 *
 * The stamp data was persisted (0a8a023) but unprintable: the ERP got the raw
 * TLV base64 and — by design — no client ships a QR encoder, so ReturnDetail
 * showed a SENTENCE about the QR instead of the QR, and InvoiceDetail printed
 * pages with no QR at all. ar_documents also carries no seller columns, so a
 * print had nowhere honest to take the seller from: live settings drift after
 * a rename (the exact defect eb714ab eliminated for sales receipts).
 *
 * Now the server renders the PNG (lib/zatca-qr-image.js, mirroring the legacy
 * receipt's byte-mode rule) and decodes the seller block from the persisted
 * TLV — the identity frozen at stamp time.
 *
 * Run: node tests/integration/cnPrint.api.test.js   (MySQL must be up)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3993;
const PW = 'Itest@12345';
const ADMIN = 'itest_cnp_admin';
const MANAGER = 'itest_cnp_manager';
const CUST = 'ITEST-CNP-CUST';
let pass = 0, fail = 0; const fails = [];
const made = { docs: [], returns: [] };
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function cleanup() {
  for (const id of [...made.docs, ...made.returns]) {
    const [js] = await db.query('SELECT id FROM gl_journals WHERE reference_id = ?', [id]).catch(() => [[]]);
    for (const j of js || []) {
      await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [j.id]).catch(() => {});
      await db.query('DELETE FROM gl_journals WHERE id = ?', [j.id]).catch(() => {});
    }
    await db.query('DELETE FROM ar_events WHERE entity_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM ar_document_lines WHERE document_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM sales_return_line_components WHERE return_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM sales_return_lines WHERE return_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM sales_returns WHERE id = ?', [id]).catch(() => {});
    await db.query("DELETE FROM ar_documents WHERE id = ? OR (document_type='credit_note' AND source_id = ?)", [id, id]).catch(() => {});
  }
  await db.query('DELETE FROM customers WHERE id = ?', [CUST]).catch(() => {});
  for (const u of [ADMIN, MANAGER]) await db.query('DELETE FROM users WHERE username = ?', [u]).catch(() => {});
}

(async () => {
  // ── the decoder itself, offline ─────────────────────────────────────────────
  console.log('▶ TLV decoder');
  const Zqr = require('../../lib/zatca-qr-image');
  const zatca = require('../../lib/zatca');
  const sample = zatca.stampInvoice({
    invoice: { invoiceNumber: 'T-1', issueDate: '2029-07-04', issueTime: '10:00:00', total: 115, vatAmount: 15, lines: [] },
    seller: { name: 'مؤسسة اختبار', vatNumber: '311111111101113' },
    previousHash: '0'.repeat(64),
  });
  const dec = Zqr.decodeZatcaTlv(sample.qrBase64);
  check('round-trip: the decoder reads back the seller the stamper wrote', dec && dec.sellerName === 'مؤسسة اختبار' && dec.vatNumber === '311111111101113', dec);
  check('  …and the money tags', dec && Number(dec.total) === 115 && Number(dec.vat) === 15, dec);
  check('a truncated TLV decodes to null, never garbage', Zqr.decodeZatcaTlv(Buffer.from('ff01', 'hex').toString('base64')) === null);
  check('null/empty input decodes to null', Zqr.decodeZatcaTlv(null) === null && Zqr.decodeZatcaTlv('') === null);
  const png = await Zqr.zatcaQrDataUrl(sample.qrBase64);
  check('the renderer produces a PNG data URL', typeof png === 'string' && png.startsWith('data:image/png'), png && png.slice(0, 30));

  await require('../../db/migrations/order-to-cash/schema').apply(db);
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query("INSERT INTO customers (id, name) VALUES (?, 'ITEST cnp customer')", [CUST]);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    const manager = await login(MANAGER);
    check('admin + manager got JWTs', !!admin && !!manager);

    // issue an invoice, return it, post the CN
    const inv = await call('POST', '/api/order-to-cash/invoices', admin,
      { customerId: CUST, issueDate: '2029-07-04', lines: [{ qty: 2, unitPrice: 50, vatRate: 15, vatCategory: 'S', inclusiveTax: false, description: 'itest print' }] },
      { 'Idempotency-Key': 'itest-cnp-i1' });
    const invId = inv?.body?.data?.id; if (invId) made.docs.push(invId);
    await call('POST', `/api/order-to-cash/invoices/${invId}/issue`, admin, {}, { 'Idempotency-Key': 'itest-cnp-s1' });
    const lineId = (await db.query('SELECT id FROM ar_document_lines WHERE document_id=? LIMIT 1', [invId]))[0][0].id;
    const ret = await call('POST', '/api/order-to-cash/returns', admin,
      { originalArDocumentId: invId, returnDate: '2029-07-05', refundMethod: 'ar_reduction', reason: 'itest print', lines: [{ originalLineId: lineId, returnQty: 1, restock: false }] },
      { 'Idempotency-Key': 'itest-cnp-r1' });
    const retId = ret?.body?.data?.id; if (retId) made.returns.push(retId);
    await call('POST', `/api/order-to-cash/returns/${retId}/approve`, manager, {}, { 'Idempotency-Key': 'itest-cnp-r1a' });
    const po = await call('POST', `/api/order-to-cash/returns/${retId}/post`, admin, {}, { 'Idempotency-Key': 'itest-cnp-r1p' });
    check('flow: issue → return → approve → post', po.status === 200, po.body);
    const cnId = po?.body?.data?.creditNoteId; if (cnId) made.docs.push(cnId);

    // ── the return detail now carries everything a CN print needs ───────────
    console.log('\n▶ credit-note print payload');
    const rd = await call('GET', `/api/order-to-cash/returns/${retId}`, admin);
    const cn = rd?.body?.data?.creditNote;
    check('creditNote block present', !!cn, rd.body);
    check('QR arrives as a server-rendered PNG data URL (clients never encode QRs)',
      typeof cn?.zatca_qr_data_url === 'string' && cn.zatca_qr_data_url.startsWith('data:image/png'), cn?.zatca_qr_data_url?.slice(0, 30));
    check('seller block decoded from the persisted TLV (frozen at stamp time)',
      !!cn?.seller && !!cn.seller.sellerName && !!cn.seller.vatNumber, cn?.seller);
    check('  …TLV money tags match the credit note totals',
      !!cn?.seller && Math.abs(Number(cn.seller.total) - Number(cn.total_amount)) < 0.01 && Math.abs(Number(cn.seller.vat) - Number(cn.vat_amount)) < 0.01,
      cn && { tlv: cn.seller, doc: { total: cn.total_amount, vat: cn.vat_amount } });
    check('original invoice number joined for the print reference',
      !!cn?.original_document_number, cn?.original_document_number);
    check('customer name resolves (COALESCE header → customers join)', cn?.customer_name === 'ITEST cnp customer', cn?.customer_name);
    check('net + VAT present for the totals block', cn?.subtotal != null && cn?.vat_amount != null, cn && { s: cn.subtotal, v: cn.vat_amount });

    // ── the invoice read carries the same stamp block ────────────────────────
    console.log('\n▶ invoice print payload');
    const iv = await call('GET', `/api/order-to-cash/invoices/${invId}`, admin);
    const doc = iv?.body?.data;
    check('issued invoice returns zatca_qr_data_url', typeof doc?.zatca_qr_data_url === 'string' && doc.zatca_qr_data_url.startsWith('data:image/png'), doc?.zatca_qr_data_url?.slice(0, 30));
    check('  …and the decoded seller', !!doc?.seller && !!doc.seller.sellerName, doc?.seller);
    const dr = await call('GET', `/api/order-to-cash/invoices/${cnId}`, admin);
    check('the CN is also readable directly via invoices/:id with its stamp block',
      dr.status === 200 && typeof dr?.body?.data?.zatca_qr_data_url === 'string', dr.status);
    const draft = await call('POST', '/api/order-to-cash/invoices', admin,
      { customerId: CUST, issueDate: '2029-07-04', lines: [{ qty: 1, unitPrice: 10, vatRate: 15, vatCategory: 'S', inclusiveTax: false }] },
      { 'Idempotency-Key': 'itest-cnp-i2' });
    const draftId = draft?.body?.data?.id; if (draftId) made.docs.push(draftId);
    const dv = await call('GET', `/api/order-to-cash/invoices/${draftId}`, admin);
    check('an UNSTAMPED draft carries no QR fields (no fake stamp)', dv.status === 200 && dv?.body?.data?.zatca_qr_data_url == null, dv?.body?.data?.zatca_qr_data_url);
  } finally {
    server.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${fail ? '❌' : '✅'} cnPrint: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
