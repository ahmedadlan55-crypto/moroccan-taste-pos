'use strict';
/* Integration — the receipt's identity and ZATCA QR (real server + DB).
 *
 * What was wrong, established live before the change:
 *   · The checkout response was the ONLY place the stamped QR ever existed
 *     (routes/sales.js returned zatcaStamp.qrBase64 and nothing stored it), so a
 *     REPRINT had to re-derive the TLV client-side — the legacy template pulls a
 *     QR encoder from a jsdelivr CDN, an online dependency inside the receipt of
 *     an offline-first POS. The React POS printed no QR at all.
 *   · The owner-configured identity (crNumber, nationalAddress, receiptHeader,
 *     receiptThankYou, receiptReturnPolicy) was returned per-sale over the
 *     network only — nothing an OFFLINE receipt could reach. The React receipt
 *     derived its seller name from document.title.
 *
 * Now: sales.zatca_qr_base64 stores the stamp at checkout; /invoice/:orderId
 * serves it back with a server-rendered PNG (old sales get a deterministic
 * rebuild from RECORDED values); /pos/v2/catalog carries the branch-resolved
 * identity because the catalog is the payload the client already caches offline.
 *
 * Run: node tests/integration/receiptQr.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const zatca = require('../../lib/zatca');

const PORT = 3989;
const CASHIER = 'itest_qr_cashier';
const PW = 'Qr#Test!2026';
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-QR-${SFX}-${s}`;
const MENU = P('MENU');
const SHIFT = P('SH');
const OLD_SALE = P('OLDSALE');     // stamped before the column existed → rebuild path
const CORRUPT_SALE = P('BADSALE'); // corrupt subtotal blob → honestly no QR
const MULTI_SALE = P('MULTISALE'); // multi-category tax_subtotals_json → taxSubtotals field
let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
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

/** TLV walker: base64 → [{tag, value(Buffer)}]. Proves the QR is real TLV, not noise. */
function tlv(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = []; let i = 0;
  while (i + 2 <= buf.length) {
    const tag = buf[i]; let len = buf[i + 1]; let off = 2;
    if (len === 0x81) { len = buf[i + 2]; off = 3; }
    else if (len === 0x82) { len = buf.readUInt16BE(i + 2); off = 4; }
    out.push({ tag, value: buf.slice(i + off, i + off + len) });
    i += off + len;
  }
  return out;
}

// Settings the identity resolver reads. The install may not have them; the test
// sets its own and RESTORES the exact prior state (including absence) after.
const TEST_SETTINGS = {
  CompanyName: 'ITEST QR Seller',
  TaxNumber: '310000000000003',
  CrNumber: '1010777777',
  NationalAddress: 'ITEST-RRRD الرياض',
  ReceiptThankYou: 'ITEST شكرًا',
};
const savedSettings = {}; // key → { existed, value }

async function saveAndSetSettings() {
  for (const [k, v] of Object.entries(TEST_SETTINGS)) {
    const [r] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [k]);
    savedSettings[k] = r.length ? { existed: true, value: r[0].setting_value } : { existed: false };
    if (r.length) await db.query('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [v, k]);
    else await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?,?)', [k, v]);
  }
}
async function restoreSettings() {
  for (const [k, s] of Object.entries(savedSettings)) {
    try {
      if (s.existed) await db.query('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [s.value, k]);
      else await db.query('DELETE FROM settings WHERE setting_key = ?', [k]);
    } catch (_) {}
  }
}

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  await del('DELETE FROM users WHERE username = ?', [CASHIER]);
  // checkout side effects for any sale this run created (found via client_order_id prefix)
  const [sales] = await db.query("SELECT id FROM sales WHERE client_order_id LIKE ? OR id IN (?,?,?)", [`ITEST-QR-%`, OLD_SALE, CORRUPT_SALE, MULTI_SALE]).catch(() => [[]]);
  for (const s of sales) {
    for (const t of ['Sale', 'ChannelCommission']) {
      const [js] = await db.query('SELECT id FROM gl_journals WHERE reference_type=? AND reference_id=?', [t, s.id]).catch(() => [[]]);
      for (const j of js) { await del('DELETE FROM gl_entries WHERE journal_id=?', [j.id]); await del('DELETE FROM gl_journals WHERE id=?', [j.id]); }
    }
    await del('DELETE FROM ar_document_line_components WHERE document_id IN (SELECT id FROM ar_documents WHERE source_type=\'pos\' AND source_id=?)', [s.id]);
    await del('DELETE FROM ar_document_lines WHERE document_id IN (SELECT id FROM ar_documents WHERE source_type=\'pos\' AND source_id=?)', [s.id]);
    await del("DELETE FROM ar_documents WHERE source_type='pos' AND source_id=?", [s.id]);
    await del('DELETE FROM inventory_movements WHERE reference_id=?', [s.id]);
    await del('DELETE FROM sales_items WHERE order_id=?', [s.id]);
    await del('DELETE FROM sales WHERE id=?', [s.id]);
  }
  await del('DELETE FROM shifts WHERE id LIKE ?', ['ITEST-QR-%']);
  await del('DELETE FROM menu WHERE id LIKE ?', ['ITEST-QR-%']);
}

(async () => {
  await cleanup();
  await saveAndSetSettings();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query("INSERT INTO shifts (id, username, status, start_time) VALUES (?,?,'OPEN',NOW())", [SHIFT, CASHIER]);
  await db.query("INSERT INTO menu (id, name, price, category, cost, stock, active, tax_category, is_tax_inclusive, production_method) VALUES (?,?,?,?,0,0,1,'S',1,'made_at_branch')",
    [MENU, 'ITEST qr item', 23.0, 'ITEST']);

  // An "old" sale: stamped (uuid present) but from before zatca_qr_base64
  // existed. 23.00 gross, 15% inclusive → net 20.00, vat 3.00 recorded per
  // category — the rebuild must read THESE, never derive /1.15 itself.
  await db.query(
    `INSERT INTO sales (id, order_date, total_final, payment_method, username, shift_id, zatca_type,
       invoice_uuid, invoice_hash, tax_subtotals_json)
     VALUES (?, NOW(), 23.00, 'Cash', ?, ?, 'simplified', 'ITEST-UUID-OLD', 'ITEST-HASH-OLD',
       '{"S":{"net":20.00,"vat":3.00,"rate":15}}')`, [OLD_SALE, CASHIER, SHIFT]);
  // A sale whose recorded subtotals are corrupt: the VAT is indeterminable, so
  // there must be NO rebuilt QR rather than one asserting a guessed VAT.
  await db.query(
    `INSERT INTO sales (id, order_date, total_final, payment_method, username, shift_id, zatca_type, tax_subtotals_json)
     VALUES (?, NOW(), 23.00, 'Cash', ?, ?, 'simplified', 'NOT-JSON{{{')`, [CORRUPT_SALE, CASHIER, SHIFT]);
  // A multi-category sale: standard (15%) + zero-rated. 30.00 net + 3.00 vat =
  // 33.00 total. The new taxSubtotals response field must echo BOTH categories
  // and their summed net/vat exactly.
  await db.query(
    `INSERT INTO sales (id, order_date, total_final, payment_method, username, shift_id, zatca_type, tax_subtotals_json)
     VALUES (?, NOW(), 33.00, 'Cash', ?, ?, 'simplified',
       '{"S":{"net":20.00,"vat":3.00,"rate":15},"Z":{"net":10.00,"vat":0.00,"rate":0}}')`, [MULTI_SALE, CASHIER, SHIFT]);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const cashier = await login(CASHIER);
    check('cashier got a JWT', !!cashier);

    // ── the offline identity channel ─────────────────────────────────────────
    console.log('\n▶ catalog identity (the offline channel)');
    const cat = await call('GET', '/api/pos/v2/catalog', cashier);
    check('catalog responds 200', cat.status === 200, cat.status);
    const idn = cat.body?.data?.identity;
    check('catalog carries the resolved identity', !!idn, idn && Object.keys(idn));
    check('  …seller name is the CONFIGURED one, not a tab title', idn?.sellerName === 'ITEST QR Seller', idn?.sellerName);
    check('  …taxNumber present', idn?.taxNumber === '310000000000003', idn?.taxNumber);
    check('  …crNumber present (was write-only since v4)', idn?.crNumber === '1010777777', idn?.crNumber);
    check('  …nationalAddress present', idn?.nationalAddress === 'ITEST-RRRD الرياض', idn?.nationalAddress);
    check('  …thankYou present', idn?.thankYou === 'ITEST شكرًا', idn?.thankYou);
    check('catalog carries the owner print toggles (defaults all-on)', cat.body?.data?.receiptShowFields?.qr === true, cat.body?.data?.receiptShowFields);

    // ── checkout stores the stamp; the response carries a print-ready PNG ────
    console.log('\n▶ checkout: the stamp is persisted, not just returned');
    const clientOrderId = P('CO1');
    const sale = await call('POST', '/api/sales', cashier, {
      items: [{ id: MENU, name: 'ITEST qr item', qty: 1, price: 23.0 }],
      paymentMethod: 'Cash', clientOrderId, shiftId: SHIFT, total: 23.0, totalFinal: 23.0,
    });
    check('checkout accepted', sale.status === 200 && sale.body?.success === true, { status: sale.status, body: sale.body });
    check('response still carries the TLV (backward compatible)', !!sale.body?.zatca?.qrBase64);
    check('response now carries a print-ready PNG data-URL', String(sale.body?.zatca?.qrDataUrl || '').startsWith('data:image/png;base64,'), sale.body?.zatca?.qrDataUrl?.slice(0, 30));

    const [srow] = await db.query('SELECT id, zatca_qr_base64, invoice_uuid FROM sales WHERE client_order_id = ? LIMIT 1', [clientOrderId]);
    check('the TLV is STORED on the sale row (it used to exist only in the response)', !!srow[0]?.zatca_qr_base64);
    check('  …and stored === returned, byte for byte', srow[0]?.zatca_qr_base64 === sale.body?.zatca?.qrBase64);

    // ── reprint: stored stamp preferred ──────────────────────────────────────
    console.log('\n▶ reprint of a NEW sale (stored stamp)');
    const inv1 = await call('GET', `/api/sales/invoice/${encodeURIComponent(srow[0].id)}`, cashier);
    check('invoice endpoint returns the QR block', !!inv1.body?.zatcaQr, inv1.body && Object.keys(inv1.body).slice(0, 8));
    check('  …source is the STORE, not a re-derivation', inv1.body?.zatcaQr?.stored === true);
    check('  …TLV matches what checkout stamped', inv1.body?.zatcaQr?.qrBase64 === srow[0].zatca_qr_base64);
    check('  …with a print-ready PNG', String(inv1.body?.zatcaQr?.qrDataUrl || '').startsWith('data:image/png;base64,'));
    check('  …and the identity fields ride along for the print', inv1.body?.crNumber === '1010777777' && inv1.body?.receiptThankYou === 'ITEST شكرًا',
      { cr: inv1.body?.crNumber, ty: inv1.body?.receiptThankYou });

    // ── reprint of an OLD sale: deterministic rebuild from recorded values ───
    console.log('\n▶ reprint of an OLD sale (no stored stamp → rebuild)');
    const inv2 = await call('GET', `/api/sales/invoice/${OLD_SALE}`, cashier);
    check('old sale still gets a QR', !!inv2.body?.zatcaQr?.qrBase64);
    check('  …marked as rebuilt, not stored', inv2.body?.zatcaQr?.stored === false);
    const fields = tlv(inv2.body.zatcaQr.qrBase64);
    const f = (t) => fields.find((x) => x.tag === t)?.value?.toString('utf8');
    check('  …TLV tag 1 = configured seller', f(1) === 'ITEST QR Seller', f(1));
    check('  …TLV tag 2 = configured VAT number', f(2) === '310000000000003', f(2));
    check('  …TLV tag 4 = the sale\'s recorded total (23.00)', f(4) === '23.00', f(4));
    check('  …TLV tag 5 = the RECORDED VAT (3.00 from tax_subtotals_json), not total/1.15', f(5) === '3.00', f(5));
    const inv2b = await call('GET', `/api/sales/invoice/${OLD_SALE}`, cashier);
    check('  …rebuild is DETERMINISTIC: two reads, identical bytes', inv2b.body?.zatcaQr?.qrBase64 === inv2.body?.zatcaQr?.qrBase64);

    // ── corrupt records: no QR beats a QR asserting a guessed VAT ────────────
    console.log('\n▶ corrupt tax_subtotals_json');
    const inv3 = await call('GET', `/api/sales/invoice/${CORRUPT_SALE}`, cashier);
    check('a sale whose VAT is indeterminable gets NO QR — never a guessed one', inv3.body?.zatcaQr == null, inv3.body?.zatcaQr);
    check('  …and its taxSubtotals is null (indeterminable, never zero)', inv3.body?.taxSubtotals === null, inv3.body?.taxSubtotals);

    // ── taxSubtotals: the RECORDED per-category breakdown reaches the client ──
    console.log('\n▶ taxSubtotals field (recorded per-category VAT)');
    // Single-category (OLD_SALE, S only): net 20 / vat 3.
    check('single-category sale echoes summed net/vat', inv2.body?.taxSubtotals?.net === 20 && inv2.body?.taxSubtotals?.vat === 3,
      inv2.body?.taxSubtotals);
    check('  …with a per-category S bucket', inv2.body?.taxSubtotals?.byCategory?.S?.net === 20 && inv2.body?.taxSubtotals?.byCategory?.S?.vat === 3,
      inv2.body?.taxSubtotals?.byCategory);

    // Multi-category (MULTI_SALE, S 15% + Z 0%): net 30 / vat 3 across two buckets.
    const invM = await call('GET', `/api/sales/invoice/${MULTI_SALE}`, cashier);
    check('multi-category sale sums BOTH categories (net 30, vat 3)', invM.body?.taxSubtotals?.net === 30 && invM.body?.taxSubtotals?.vat === 3,
      invM.body?.taxSubtotals);
    check('  …S bucket {net:20, vat:3}', invM.body?.taxSubtotals?.byCategory?.S?.net === 20 && invM.body?.taxSubtotals?.byCategory?.S?.vat === 3,
      invM.body?.taxSubtotals?.byCategory?.S);
    check('  …Z bucket {net:10, vat:0}', invM.body?.taxSubtotals?.byCategory?.Z?.net === 10 && invM.body?.taxSubtotals?.byCategory?.Z?.vat === 0,
      invM.body?.taxSubtotals?.byCategory?.Z);
    check('  …exactly the two recorded categories, nothing invented', invM.body?.taxSubtotals && Object.keys(invM.body.taxSubtotals.byCategory).sort().join(',') === 'S,Z',
      invM.body?.taxSubtotals?.byCategory && Object.keys(invM.body.taxSubtotals.byCategory));

    console.log(`\n${fail === 0 ? '✅' : '❌'} receiptQr: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await restoreSettings();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
