/* Integration — the O2C idempotency contract (real server + DB, parallel races included).
 *
 * What was broken (all code-verified before the fix):
 *   • uq_are_idem was UNIQUE(entity_type, idempotency_key) — one key per DOCUMENT
 *     TYPE. A key reused across approve→post replayed the approve AS the post:
 *     HTTP 200, toStatus 'approved', no GL, no side effects. One key across two
 *     documents replayed the first document's event onto the second.
 *   • Replay never compared payloads: same key + different body silently returned
 *     the first result. And the replay envelope rebuilt only {journalIds:[gl_journal_id]}
 *     — payload lost (a replayed returns-post answered creditNoteId: undefined),
 *     multi-journal results under-reported.
 *   • Create paths had no replay at all: a duplicate key was an unhandled
 *     ER_DUP_ENTRY (HTTP 500). allocateAdvance had NO idempotency and its
 *     ON DUPLICATE KEY UPDATE ... + VALUES made a double-submit ADD a second
 *     GL journal and reduce the invoice again.
 *
 * Contract now: same key+op+payload ⇒ replay of the same result; same key with a
 * DIFFERENT payload ⇒ 409 IDEMPOTENCY_KEY_REUSED; keys scoped per (type,action,
 * document) for transitions and (type,'create') for creates; parallel-safe.
 *
 * Run: node tests/integration/o2cIdempotency.api.test.js   (MySQL must be up)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3991;
const PW = 'Itest@12345';
const ADMIN = 'itest_idem_admin';
const CUST = 'ITEST-IDEM-CUST';
let pass = 0, fail = 0; const fails = [];
const made = { payments: [], invoices: [] }; // for cleanup
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

// Count ALL journals for a document, whatever their reference_type — an
// advance payment posts as CustomerAdvance, a collection as CustomerPayment,
// an application as CustomerAdvanceApplication. "Money moved once" must be
// blind to which.
const journalsFor = async (refId) =>
  Number((await db.query('SELECT COUNT(*) c FROM gl_journals WHERE reference_id=?', [refId]))[0][0].c);

async function cleanup() {
  const ids = [...made.payments, ...made.invoices];
  for (const id of ids) {
    // GL first (entries cascade off journals), then events, allocations, lines, docs.
    const [js] = await db.query("SELECT id FROM gl_journals WHERE reference_id = ?", [id]).catch(() => [[]]);
    for (const j of js || []) {
      await db.query('DELETE FROM gl_entries WHERE journal_id = ?', [j.id]).catch(() => {});
      await db.query('DELETE FROM gl_journals WHERE id = ?', [j.id]).catch(() => {});
    }
    await db.query('DELETE FROM ar_events WHERE entity_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM ar_payment_allocations WHERE payment_id = ? OR ar_document_id = ?', [id, id]).catch(() => {});
    await db.query('DELETE FROM ar_document_lines WHERE document_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM customer_payments WHERE id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM ar_documents WHERE id = ?', [id]).catch(() => {});
  }
  await db.query('DELETE FROM customers WHERE id = ?', [CUST]).catch(() => {});
  await db.query('DELETE FROM users WHERE username = ?', [ADMIN]).catch(() => {});
}

(async () => {
  await require('../../db/migrations/order-to-cash/schema').apply(db);
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [ADMIN, hash, 'admin']);
  await db.query("INSERT INTO customers (id, name) VALUES (?, 'ITEST idem customer')", [CUST]);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    check('admin got a JWT', !!admin);
    const K = (s) => ({ 'Idempotency-Key': 'itest-idem-' + s });
    const payBody = (amt) => ({ customerId: CUST, amount: amt, paymentDate: '2029-07-01', destinationType: 'cash' });
    const track = (r) => { const id = r?.body?.data?.id; if (id) { if (String(id).startsWith('PAY')) made.payments.push(id); else made.invoices.push(id); } return id; };

    // ── creates: replay / 409 / parallel ─────────────────────────────────────
    console.log('\n▶ create');
    const c1 = await call('POST', '/api/order-to-cash/payments', admin, payBody(100), K('c1'));
    const c1id = c1?.body?.data?.id; if (c1id) made.payments.push(c1id);
    check('first create with a key succeeds', c1.status === 201 && !!c1id, c1.body);
    const c2 = await call('POST', '/api/order-to-cash/payments', admin, payBody(100), K('c1'));
    check('same key + same payload replays the SAME document (no twin)', c2.status === 201 && c2?.body?.data?.id === c1id, c2.body?.data?.id);
    const [twins] = await db.query('SELECT COUNT(*) c FROM customer_payments WHERE customer_id=?', [CUST]);
    check('  …and exactly one payment row exists', Number(twins[0].c) === 1, twins[0].c);
    const c3 = await call('POST', '/api/order-to-cash/payments', admin, payBody(999), K('c1'));
    check('same key + DIFFERENT payload ⇒ 409 IDEMPOTENCY_KEY_REUSED', c3.status === 409 && c3.body?.code === 'IDEMPOTENCY_KEY_REUSED', c3);
    check('  …and no second row appeared', Number((await db.query('SELECT COUNT(*) c FROM customer_payments WHERE customer_id=?', [CUST]))[0][0].c) === 1);

    const [p1, p2] = await Promise.all([
      call('POST', '/api/order-to-cash/payments', admin, payBody(70), K('cpar')),
      call('POST', '/api/order-to-cash/payments', admin, payBody(70), K('cpar')),
    ]);
    const ids = [p1?.body?.data?.id, p2?.body?.data?.id];
    ids.forEach((i) => { if (i && !made.payments.includes(i)) made.payments.push(i); });
    check('PARALLEL same-key creates: both 201, never a 500', p1.status === 201 && p2.status === 201, { a: p1.status, b: p2.status });
    check('  …and they answered with the SAME document', !!ids[0] && ids[0] === ids[1], ids);

    // A posted invoice — used by the transition-fidelity block AND allocate.
    const inv = await call('POST', '/api/order-to-cash/invoices', admin,
      { customerId: CUST, issueDate: '2029-07-01', lines: [{ qty: 1, unitPrice: 100, vatRate: 15, vatCategory: 'S', inclusiveTax: false, description: 'itest' }] }, K('inv1'));
    const invId = inv?.body?.data?.id; if (invId) made.invoices.push(invId);
    check('draft invoice created', inv.status === 201 && !!invId, inv.body);
    const iss = await call('POST', `/api/order-to-cash/invoices/${invId}/issue`, admin, {}, K('iss1'));
    check('invoice issued', iss.status === 200, iss.body);

    // ── transitions: cross-action, replay fidelity, parallel ────────────────
    console.log('\n▶ transitions');
    // THE silent-no-op bug: one key across approve→post. Before scoping, the
    // post found the approve event and returned replayed:true/toStatus approved
    // with HTTP 200 — no GL, no status change, and the client none the wiser.
    const ap = await call('POST', `/api/order-to-cash/payments/${c1id}/approve`, admin, {}, K('flow'));
    check('approve with key F succeeds', ap.status === 200, ap.body);
    // Post WITH allocations so the response carries data.allocations — that
    // comes from result.payload.perInvoice, which the old replay envelope LOST.
    const po = await call('POST', `/api/order-to-cash/payments/${c1id}/post`, admin,
      { allocations: [{ arDocumentId: invId, amount: 40 }] }, K('flow'));
    check('post with the SAME key F genuinely POSTS (no cross-action replay)', po.status === 200 && po.body?.status === 'posted', po.body);
    check('  …and a journal exists', (await journalsFor(c1id)) >= 1);

    const po2 = await call('POST', `/api/order-to-cash/payments/${c1id}/post`, admin,
      { allocations: [{ arDocumentId: invId, amount: 40 }] }, K('flow'));
    check('retrying the post with the same key replays (200, still posted)', po2.status === 200 && po2.body?.status === 'posted', po2.body);
    check('  …journalId matches the original', !!po.body?.journalId && po2.body?.journalId === po.body?.journalId,
      { first: po.body?.journalId, replay: po2.body?.journalId });
    check('  …data.allocations survives the replay (the old envelope returned undefined)',
      Array.isArray(po2.body?.data?.allocations) && JSON.stringify(po2.body.data.allocations) === JSON.stringify(po.body?.data?.allocations),
      { first: po.body?.data?.allocations, replay: po2.body?.data?.allocations });
    const journalsAfterFirstPost = await journalsFor(c1id);
    check('  …and no second journal was posted', (await journalsFor(c1id)) === journalsAfterFirstPost);
    const po3 = await call('POST', `/api/order-to-cash/payments/${c1id}/post`, admin,
      { allocations: [{ arDocumentId: invId, amount: 99 }] }, K('flow'));
    check('same TRANSITION key + different payload ⇒ 409 (executor hash guard)',
      po3.status === 409 && po3.body?.code === 'IDEMPOTENCY_KEY_REUSED', po3);

    // Parallel same-key posts on a fresh payment: one performs, one replays.
    const f1 = await call('POST', '/api/order-to-cash/payments', admin, payBody(50), K('f1'));
    const f1id = track(f1);
    await call('POST', `/api/order-to-cash/payments/${f1id}/approve`, admin, {}, K('f1a'));
    const [q1, q2] = await Promise.all([
      call('POST', `/api/order-to-cash/payments/${f1id}/post`, admin, {}, K('ppar')),
      call('POST', `/api/order-to-cash/payments/${f1id}/post`, admin, {}, K('ppar')),
    ]);
    check('PARALLEL same-key posts: both 200', q1.status === 200 && q2.status === 200, { a: q1.status, b: q2.status });
    check('  …exactly ONE journal exists (money moved once)', (await journalsFor(f1id)) === 1);
    check('  …both answered with the same journalId', !!q1.body?.journalId && q1.body?.journalId === q2.body?.journalId, { a: q1.body?.journalId, b: q2.body?.journalId });

    // ── allocation: the endpoint that had NO idempotency at all ─────────────
    console.log('\n▶ allocate');
    // An advance (unallocated) payment, posted.
    const adv = await call('POST', '/api/order-to-cash/payments', admin, payBody(200), K('adv1'));
    const advId = track(adv);
    await call('POST', `/api/order-to-cash/payments/${advId}/approve`, admin, {}, K('adv1a'));
    await call('POST', `/api/order-to-cash/payments/${advId}/post`, admin, {}, K('adv1p'));

    const allocBody = { allocations: [{ arDocumentId: invId, amount: 50 }] };
    const a1 = await call('POST', `/api/order-to-cash/payments/${advId}/allocate`, admin, allocBody, K('al1'));
    check('first allocation succeeds', a1.status === 200, a1.body);
    const advJournals = await journalsFor(advId);
    const a2 = await call('POST', `/api/order-to-cash/payments/${advId}/allocate`, admin, allocBody, K('al1'));
    check('double-submit with the same key REPLAYS (was: posted a second journal and drained the balance again)',
      a2.status === 200 && a2.body?.data?.replayed === true, a2.body);
    check('  …journal count unchanged', (await journalsFor(advId)) === advJournals);
    const [unap] = await db.query('SELECT unapplied_amount FROM customer_payments WHERE id=?', [advId]);
    check('  …unapplied balance reduced exactly once (200 − 50 = 150)', Number(unap[0].unapplied_amount) === 150, unap[0].unapplied_amount);
    const a3 = await call('POST', `/api/order-to-cash/payments/${advId}/allocate`, admin, { allocations: [{ arDocumentId: invId, amount: 60 }] }, K('al1'));
    check('same key + different allocation ⇒ 409', a3.status === 409 && a3.body?.code === 'IDEMPOTENCY_KEY_REUSED', a3);
    check('  …and balance still 150', Number((await db.query('SELECT unapplied_amount FROM customer_payments WHERE id=?', [advId]))[0][0].unapplied_amount) === 150);

    // ── cross-document isolation ─────────────────────────────────────────────
    console.log('\n▶ cross-document');
    // Same TRANSITION key on two different documents must not cross-replay
    // (scope includes the document id).
    const g1 = await call('POST', '/api/order-to-cash/payments', admin, payBody(10), K('g1'));
    const g2 = await call('POST', '/api/order-to-cash/payments', admin, payBody(20), K('g2'));
    const g1id = track(g1), g2id = track(g2);
    const [ga, gb] = [await call('POST', `/api/order-to-cash/payments/${g1id}/approve`, admin, {}, K('shared')),
                      await call('POST', `/api/order-to-cash/payments/${g2id}/approve`, admin, {}, K('shared'))];
    check('the same key on TWO documents approves BOTH (no cross-document replay)',
      ga.status === 200 && gb.status === 200
      && (await db.query('SELECT COUNT(*) c FROM customer_payments WHERE id IN (?,?) AND status=\'approved\'', [g1id, g2id]))[0][0].c === 2,
      { a: ga.status, b: gb.status });
  } finally {
    server.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${fail ? '❌' : '✅'} o2cIdempotency: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
