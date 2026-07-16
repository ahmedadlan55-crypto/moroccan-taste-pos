/* Integration — the ZATCA hash chain for ar_documents (real server + DB).
 *
 * What was broken (all code-verified before the fix):
 *   • previousHash came from MAX(created_at) over ar_documents — created_at has
 *     1-second resolution (two live docs share a second), FOR UPDATE over an
 *     EMPTY table locks nothing at genesis, and a bare catch(_) re-ran the read
 *     WITHOUT the lock: two concurrent issuers could take the same head and
 *     fork the chain. linkPosSale's copied legacy-sale hashes were eligible
 *     heads (cross-chain contamination).
 *   • The stamper RETURNED previousHash and the QR; issue() dropped both — the
 *     chain link was never stored, only recomputed-and-hoped. No ICV anywhere.
 *
 * Now: zatca_chain_state ('o2c:default') is an always-present, FOR-UPDATE-able
 * head row seeded at migration from the EXISTING stamped head (cutover, not
 * genesis); stamp() locks it and returns {previousHash, icv}; callers persist
 * previous_invoice_hash + zatca_icv + qr on the document AND advance the head
 * in the same transaction. Invoices and credit notes share one chain.
 *
 * Run: node tests/integration/zatcaChain.api.test.js   (MySQL must be up)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3992;
const PW = 'Itest@12345';
const ADMIN = 'itest_chain_admin';
const MANAGER = 'itest_chain_manager'; // SoD: the return's creator may not approve it
const CUST = 'ITEST-CHAIN-CUST';
const FAKE_POS = 'ITEST-CHAIN-POSDOC';
let pass = 0, fail = 0; const fails = [];
const made = { docs: [], returns: [] };
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); } }

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

const head = async () => (await db.query("SELECT last_hash, last_icv FROM zatca_chain_state WHERE chain_id='o2c:default'"))[0][0];
const doc = async (id) => (await db.query('SELECT id, status, zatca_uuid, zatca_hash, previous_invoice_hash, zatca_icv, zatca_qr_base64 FROM ar_documents WHERE id=?', [id]))[0][0];
const mkInvoice = async (admin, amount, key) => {
  const r = await call('POST', '/api/order-to-cash/invoices', admin,
    { customerId: CUST, issueDate: '2029-07-02', lines: [{ qty: 1, unitPrice: amount, vatRate: 15, vatCategory: 'S', inclusiveTax: false, description: 'itest chain' }] },
    { 'Idempotency-Key': 'itest-chain-' + key });
  const id = r?.body?.data?.id; if (id) made.docs.push(id);
  return id;
};

async function cleanup() {
  for (const id of [...made.docs, ...made.returns, FAKE_POS]) {
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
  const schema = require('../../db/migrations/order-to-cash/schema');
  await schema.apply(db);

  // ── the seed is a CUTOVER, not genesis ─────────────────────────────────────
  // Local-dev only: deleting the head row and re-applying must re-derive it
  // from the stamped documents that exist — NOT reset to zeros, which would
  // declare a genesis PIH while chained predecessors stand.
  console.log('▶ seed');
  await db.query("DELETE FROM zatca_chain_state WHERE chain_id='o2c:default'");
  await schema.apply(db);
  const [expHead] = await db.query(
    "SELECT zatca_hash h FROM ar_documents WHERE source_type<>'pos' AND zatca_hash IS NOT NULL AND zatca_hash<>'' ORDER BY created_at DESC, id DESC LIMIT 1");
  const [expCnt] = await db.query(
    "SELECT COUNT(*) c FROM ar_documents WHERE source_type<>'pos' AND zatca_hash IS NOT NULL AND zatca_hash<>''");
  const seeded = await head();
  if (expHead.length) {
    check('re-seeded head = the newest stamped NON-POS document (cutover, not zeros)', seeded.last_hash === expHead[0].h, { seeded: seeded.last_hash, expected: expHead[0].h });
    check('  …and last_icv = the count of stamped documents', Number(seeded.last_icv) === Number(expCnt[0].c), { icv: seeded.last_icv, count: expCnt[0].c });
  } else {
    check('fresh DB seeds the conventional genesis', seeded.last_hash === '0'.repeat(64), seeded.last_hash);
  }

  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query("INSERT INTO customers (id, name) VALUES (?, 'ITEST chain customer')", [CUST]);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    const manager = await login(MANAGER);
    check('admin + manager got JWTs', !!admin && !!manager);

    // ── sequential chain ───────────────────────────────────────────────────
    console.log('\n▶ sequential');
    const h0 = await head();
    const inv1 = await mkInvoice(admin, 100, 'i1');
    const s1 = await call('POST', `/api/order-to-cash/invoices/${inv1}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-s1' });
    check('invoice 1 issued', s1.status === 200, s1.body);
    const d1 = await doc(inv1);
    check('  …its PIH is the head at issue time (stored, not recomputed)', d1.previous_invoice_hash === h0.last_hash, { pih: d1.previous_invoice_hash, head: h0.last_hash });
    check('  …its ICV is head+1', Number(d1.zatca_icv) === Number(h0.last_icv) + 1, d1.zatca_icv);
    check('  …the QR is persisted on the document (issue used to drop it)', !!d1.zatca_qr_base64);
    const h1 = await head();
    check('  …and the head advanced to THIS document', h1.last_hash === d1.zatca_hash && Number(h1.last_icv) === Number(d1.zatca_icv), h1);

    const inv2 = await mkInvoice(admin, 200, 'i2');
    await call('POST', `/api/order-to-cash/invoices/${inv2}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-s2' });
    const d2 = await doc(inv2);
    check('invoice 2 chains off invoice 1 (PIH = inv1.hash)', d2.previous_invoice_hash === d1.zatca_hash, { pih: d2.previous_invoice_hash, prev: d1.zatca_hash });
    check('  …ICV strictly increments', Number(d2.zatca_icv) === Number(d1.zatca_icv) + 1);

    // ── parallel issuers must not share a PIH ──────────────────────────────
    console.log('\n▶ parallel');
    const pa = await mkInvoice(admin, 10, 'p1');
    const pb = await mkInvoice(admin, 20, 'p2');
    const [r1, r2] = await Promise.all([
      call('POST', `/api/order-to-cash/invoices/${pa}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-pp1' }),
      call('POST', `/api/order-to-cash/invoices/${pb}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-pp2' }),
    ]);
    check('both parallel issues succeed', r1.status === 200 && r2.status === 200, { a: r1.status, b: r2.status });
    const da = await doc(pa), db2 = await doc(pb);
    check('  …they took DIFFERENT previous hashes (no fork)', da.previous_invoice_hash !== db2.previous_invoice_hash, { a: da.previous_invoice_hash, b: db2.previous_invoice_hash });
    check('  …their ICVs are consecutive, not equal', Math.abs(Number(da.zatca_icv) - Number(db2.zatca_icv)) === 1, { a: da.zatca_icv, b: db2.zatca_icv });
    const later = Number(da.zatca_icv) > Number(db2.zatca_icv) ? da : db2;
    const earlier = later === da ? db2 : da;
    check('  …the later one chains off the earlier one', later.previous_invoice_hash === earlier.zatca_hash);
    check('  …and the head is the later one', (await head()).last_hash === later.zatca_hash);

    // ── POS-copied hashes cannot poison the chain ──────────────────────────
    console.log('\n▶ POS immunity');
    await db.query(
      `INSERT INTO ar_documents (id, document_number, document_type, source_type, source_id, issue_date, status, zatca_status, zatca_hash, version, created_at)
       VALUES (?, 'ITEST-POS-1', 'invoice', 'pos', 'ITEST-SALE-X', '2029-07-02', 'issued', 'pending', ?, 1, '2039-01-01 00:00:00')`,
      [FAKE_POS, 'f'.repeat(64)]);
    const headBeforePos = await head();
    const inv5 = await mkInvoice(admin, 30, 'i5');
    await call('POST', `/api/order-to-cash/invoices/${inv5}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-s5' });
    const d5 = await doc(inv5);
    check('a max-created_at POS row with a foreign hash does NOT become the PIH',
      d5.previous_invoice_hash === headBeforePos.last_hash && d5.previous_invoice_hash !== 'f'.repeat(64),
      { pih: d5.previous_invoice_hash });

    // ── failure does not advance the head ──────────────────────────────────
    console.log('\n▶ failure');
    const zeroInv = await mkInvoice(admin, 0, 'z1'); // total 0 → GL refuses after the stamp
    const hBefore = await head();
    const zr = await call('POST', `/api/order-to-cash/invoices/${zeroInv}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-z1' });
    check('issuing a zero-total invoice fails (GL refuses an all-zero journal)', zr.status >= 400, zr.status);
    const hAfter = await head();
    check('  …and the chain head did NOT advance (stamp rolled back with the txn)', hBefore.last_hash === hAfter.last_hash && Number(hBefore.last_icv) === Number(hAfter.last_icv), { before: hBefore, after: hAfter });
    const dz = await doc(zeroInv);
    check('  …and the document is still an unstamped draft', dz.status === 'draft' && !dz.zatca_hash, { status: dz.status, hash: dz.zatca_hash });

    // ── retry replays; the head advances exactly once ──────────────────────
    console.log('\n▶ retry');
    const inv6 = await mkInvoice(admin, 40, 'i6');
    const t1 = await call('POST', `/api/order-to-cash/invoices/${inv6}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-t6' });
    const headOnce = await head();
    const t2 = await call('POST', `/api/order-to-cash/invoices/${inv6}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-t6' });
    check('retrying the issue with the same key replays (200)', t1.status === 200 && t2.status === 200, { a: t1.status, b: t2.status });
    const headTwice = await head();
    check('  …and the head advanced exactly ONCE (replay skips perform, cannot advance)', headOnce.last_hash === headTwice.last_hash && Number(headOnce.last_icv) === Number(headTwice.last_icv), { once: headOnce, twice: headTwice });

    // ── the credit note enters the SAME chain ──────────────────────────────
    console.log('\n▶ credit note');
    const ret = await call('POST', '/api/order-to-cash/returns', admin, {
      originalArDocumentId: inv6, returnDate: '2029-07-03', refundMethod: 'ar_reduction', reason: 'itest chain',
      lines: [{ originalLineId: (await db.query('SELECT id FROM ar_document_lines WHERE document_id=? LIMIT 1', [inv6]))[0][0].id, returnQty: 1, restock: false }],
    }, { 'Idempotency-Key': 'itest-chain-r1' });
    const retId = ret?.body?.data?.id; if (retId) made.returns.push(retId);
    check('return created against the issued invoice', ret.status === 201 && !!retId, ret.body);
    const ap = await call('POST', `/api/order-to-cash/returns/${retId}/approve`, manager, {}, { 'Idempotency-Key': 'itest-chain-r1a' });
    check('a different user approves it (SoD)', ap.status === 200, ap.body);
    const headBeforeCn = await head();
    const po = await call('POST', `/api/order-to-cash/returns/${retId}/post`, admin, {}, { 'Idempotency-Key': 'itest-chain-r1p' });
    check('the return posts (credit note issued)', po.status === 200, po.body);
    const cnId = po?.body?.data?.creditNoteId; if (cnId) made.docs.push(cnId);
    const cn = await doc(cnId);
    check('the credit note\'s PIH is the head at post time', cn.previous_invoice_hash === headBeforeCn.last_hash, { pih: cn.previous_invoice_hash, head: headBeforeCn.last_hash });
    check('  …its ICV continues the SAME sequence as invoices', Number(cn.zatca_icv) === Number(headBeforeCn.last_icv) + 1, cn.zatca_icv);
    check('  …uuid + hash + QR are persisted on the credit note', !!cn.zatca_uuid && !!cn.zatca_hash && !!cn.zatca_qr_base64);
    const headAfterCn = await head();
    check('  …and the head is now the credit note', headAfterCn.last_hash === cn.zatca_hash && Number(headAfterCn.last_icv) === Number(cn.zatca_icv), headAfterCn);
    // ── invoice ∥ credit-note race — the case ONLY the chain lock serializes ──
    // Two parallel INVOICES already serialize on the shared doc_counters row
    // before ever reaching the chain, so they cannot prove the chain lock does
    // real work. An invoice and a credit-note post take DIFFERENT counters and
    // meet for the first time at the chain head.
    console.log('\n▶ invoice ∥ credit-note');
    const inv8 = await mkInvoice(admin, 60, 'i8');
    await call('POST', `/api/order-to-cash/invoices/${inv8}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-s8' });
    const ret2 = await call('POST', '/api/order-to-cash/returns', admin, {
      originalArDocumentId: inv8, returnDate: '2029-07-03', refundMethod: 'ar_reduction', reason: 'itest race',
      lines: [{ originalLineId: (await db.query('SELECT id FROM ar_document_lines WHERE document_id=? LIMIT 1', [inv8]))[0][0].id, returnQty: 1, restock: false }],
    }, { 'Idempotency-Key': 'itest-chain-r2' });
    const ret2Id = ret2?.body?.data?.id; if (ret2Id) made.returns.push(ret2Id);
    await call('POST', `/api/order-to-cash/returns/${ret2Id}/approve`, manager, {}, { 'Idempotency-Key': 'itest-chain-r2a' });
    const inv9 = await mkInvoice(admin, 70, 'i9');
    const [x1, x2] = await Promise.all([
      call('POST', `/api/order-to-cash/invoices/${inv9}/issue`, admin, {}, { 'Idempotency-Key': 'itest-chain-s9' }),
      call('POST', `/api/order-to-cash/returns/${ret2Id}/post`, admin, {}, { 'Idempotency-Key': 'itest-chain-r2p' }),
    ]);
    check('parallel invoice-issue and return-post both succeed', x1.status === 200 && x2.status === 200, { inv: x1.status, ret: x2.status });
    const cn2Id = x2?.body?.data?.creditNoteId; if (cn2Id) made.docs.push(cn2Id);
    const d9 = await doc(inv9), cn2 = await doc(cn2Id);
    check('  …the invoice and the credit note took DIFFERENT previous hashes (the chain lock is doing the work)',
      d9.previous_invoice_hash !== cn2.previous_invoice_hash, { inv: d9.previous_invoice_hash, cn: cn2.previous_invoice_hash });
    check('  …their ICVs are consecutive', Math.abs(Number(d9.zatca_icv) - Number(cn2.zatca_icv)) === 1, { inv: d9.zatca_icv, cn: cn2.zatca_icv });
  } finally {
    server.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${fail ? '❌' : '✅'} zatcaChain: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
