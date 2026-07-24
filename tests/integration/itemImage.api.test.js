'use strict';
/* Integration — product item images (real server + DB, synthesized fixtures).
 *
 * The contract under test (close/d-images):
 *   · THE RULE: menu.image_data (base64 LONGTEXT, 68MB across the live catalog)
 *     never rides in the /catalog payload. The catalog carries only
 *     items[].imageVersion = SUBSTRING(SHA1(image_data),1,8), null when absent.
 *   · GET /api/pos/v2/item-image/:id serves the DECODED bytes with the right
 *     Content-Type, immutable Cache-Control, and ETag = sha1(b64) honoring
 *     If-None-Match → 304. Absent OR corrupt stored data → 404, never a 500.
 *   · An image edit changes the catalog ETag (cached offline clients revalidate).
 *   · routes/menu.js writes: imageData must be data:image/(jpeg|png|webp);base64
 *     with decoded size ≤ 300KB → else 400 (Arabic). '' still clears. Writes stay
 *     manager-gated; reads work for the cashier role.
 *
 * Every fixture is synthesized (ITEST-* ids / ITEST-IMG category) and cleaned up
 * before + finally.
 *
 * Run: node tests/integration/itemImage.api.test.js   (port 3997)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3997;
const CASHIER = 'itest_img_cashier';
const MANAGER = 'itest_img_manager';
const PW = 'Img#Test!2026';
const ITEM_IMG = 'ITEST-MENU-IMG';
const ITEM_PLAIN = 'ITEST-MENU-NOIMG';
const CAT = 'ITEST-IMG';
// A real 1×1 PNG (89 50 4E 47 magic) — tiny but genuinely decodable.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_B64;
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// The catalog imageVersion is now SUBSTRING(SHA2(image_data,256),1,8) on the SQL
// side (prod MySQL 9.6 removed the SHA1() built-in). It mirrors this SHA-256 of
// the same data-URL. The item-image ETag stays SHA1 (Node-side, pos-v2.js:974),
// so BOTH helpers are needed — do not collapse them.
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, headers: s.headers, raw: b, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
// Binary-safe GET — the image endpoint returns bytes, not JSON.
function callBytes(p, token, headers = {}) {
  return new Promise((res) => {
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: p, headers: h }, (s) => {
      const chunks = []; s.on('data', (c) => chunks.push(c)); s.on('end', () => res({ status: s.statusCode, headers: s.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', () => res({ status: 0, headers: {}, body: Buffer.alloc(0) })); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

const storedImage = async (id) => { const [r] = await db.query('SELECT image_data FROM menu WHERE id=?', [id]); return r.length ? r[0].image_data : undefined; };

async function cleanup() {
  for (const u of [CASHIER, MANAGER]) { try { await db.query('DELETE FROM users WHERE username=?', [u]); } catch (_) {} }
  try { await db.query('DELETE FROM menu WHERE category=? OR id IN (?, ?)', [CAT, ITEM_IMG, ITEM_PLAIN]); } catch (_) {}
}

// PUT /api/menu/:id overwrites every column it names, so the body must carry the
// full base shape (undefined bind params are rejected by mysql2 anyway).
const itemBody = (extra = {}) => ({
  name: 'ITEST صنف بصورة', price: 5, category: CAT, cost: 1, stock: 0, minStock: 0, active: true, ...extra,
});

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [MANAGER, hash, 'manager']);
  await db.query('INSERT INTO menu (id, name, price, category, active, image_data) VALUES (?,?,?,?,1,?)', [ITEM_IMG, 'ITEST صنف بصورة', 5, CAT, PNG_DATA_URL]);
  await db.query('INSERT INTO menu (id, name, price, category, active, image_data) VALUES (?,?,?,?,1,NULL)', [ITEM_PLAIN, 'ITEST صنف بلا صورة', 5, CAT]);

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ item images ═══');

    const cashier = await login(CASHIER);
    const manager = await login(MANAGER);
    check('users authenticate', !!cashier && !!manager);

    // ── the rule: version rides, the blob does not ──
    const cat1 = await call('GET', '/api/pos/v2/catalog', cashier);
    check('cashier can read the catalog', cat1.status === 200 && cat1.body?.success === true, { status: cat1.status });
    check("catalog payload carries NO 'base64' substring (the 66MB rule)", !cat1.raw.includes('base64'));
    const seeded = cat1.body?.data?.items?.find((i) => i.id === ITEM_IMG);
    const plain = cat1.body?.data?.items?.find((i) => i.id === ITEM_PLAIN);
    check('seeded item is in the catalog', !!seeded);
    check('imageVersion = first 8 of SHA2-256(stored data-URL)', seeded && seeded.imageVersion === sha256(PNG_DATA_URL).slice(0, 8), seeded && seeded.imageVersion);
    check('item without an image → imageVersion null', plain && plain.imageVersion === null, plain && plain.imageVersion);

    // ── bytes endpoint ──
    const img = await callBytes('/api/pos/v2/item-image/' + ITEM_IMG, cashier);
    check('GET item-image → 200', img.status === 200, { status: img.status });
    check('Content-Type image/png', img.headers['content-type'] === 'image/png', img.headers['content-type']);
    check('immutable Cache-Control', /public, max-age=31536000, immutable/.test(img.headers['cache-control'] || ''), img.headers['cache-control']);
    check('bytes equal the decoded seeded PNG', Buffer.from(PNG_B64, 'base64').equals(img.body), { len: img.body.length });
    const etag = img.headers.etag;
    check('ETag = sha1 of the b64 payload', etag === '"' + sha1(PNG_B64) + '"', etag);
    const revalidated = await callBytes('/api/pos/v2/item-image/' + ITEM_IMG, cashier, { 'If-None-Match': etag });
    check('If-None-Match → 304 with empty body', revalidated.status === 304 && revalidated.body.length === 0, { status: revalidated.status, len: revalidated.body.length });

    const none = await callBytes('/api/pos/v2/item-image/' + ITEM_PLAIN, cashier);
    check('image absent → 404', none.status === 404, { status: none.status });
    const ghost = await callBytes('/api/pos/v2/item-image/NO-SUCH-ITEM-XYZ', cashier);
    check('unknown id → 404', ghost.status === 404, { status: ghost.status });
    const anon = await callBytes('/api/pos/v2/item-image/' + ITEM_IMG, null);
    check('unauthenticated → 401 (global /api gate)', anon.status === 401, { status: anon.status });

    // ── corrupt stored data must cost a thumbnail, not the request ──
    await db.query('UPDATE menu SET image_data=? WHERE id=?', ['definitely-not-a-data-url', ITEM_IMG]);
    const corrupt1 = await callBytes('/api/pos/v2/item-image/' + ITEM_IMG, cashier);
    check('corrupt stored data (not a data-URL) → 404, not 500', corrupt1.status === 404, { status: corrupt1.status });
    await db.query('UPDATE menu SET image_data=? WHERE id=?', ['data:image/png;base64,%%%%', ITEM_IMG]);
    const corrupt2 = await callBytes('/api/pos/v2/item-image/' + ITEM_IMG, cashier);
    check('corrupt stored data (bad base64 charset) → 404, not 500', corrupt2.status === 404, { status: corrupt2.status });
    await db.query('UPDATE menu SET image_data=? WHERE id=?', [PNG_DATA_URL, ITEM_IMG]); // restore

    // ── write validation (routes/menu.js) ──
    const bigB64 = Buffer.alloc(301 * 1024, 7).toString('base64'); // 301KB decoded > 300KB cap
    const oversized = await call('PUT', '/api/menu/' + ITEM_IMG, manager, itemBody({ imageData: 'data:image/png;base64,' + bigB64 }));
    check('oversized image (301KB decoded) → 400 + Arabic message', oversized.status === 400 && /كبير/.test(oversized.body?.error || ''), { status: oversized.status, body: oversized.body });
    check('…and the stored image is untouched', (await storedImage(ITEM_IMG)) === PNG_DATA_URL);

    const gif = await call('PUT', '/api/menu/' + ITEM_IMG, manager, itemBody({ imageData: 'data:image/gif;base64,' + PNG_B64 }));
    check('unsupported type (gif) → 400', gif.status === 400 && /غير مدعومة/.test(gif.body?.error || ''), { status: gif.status, body: gif.body });
    const svg = await call('PUT', '/api/menu/' + ITEM_IMG, manager, itemBody({ imageData: 'data:image/svg+xml;base64,' + PNG_B64 }));
    check('unsupported type (svg — script-capable) → 400', svg.status === 400, { status: svg.status });
    const junk = await call('PUT', '/api/menu/' + ITEM_IMG, manager, itemBody({ imageData: 'hello world' }));
    check('non-data-URL string → 400', junk.status === 400, { status: junk.status });
    check('…stored image still untouched after every invalid write', (await storedImage(ITEM_IMG)) === PNG_DATA_URL);

    const createBad = await call('POST', '/api/menu', manager, itemBody({ imageData: 'data:image/gif;base64,' + PNG_B64 }));
    check('CREATE with a bad image → 400 (nothing inserted)', createBad.status === 400, { status: createBad.status, body: createBad.body });
    const [strays] = await db.query('SELECT COUNT(*) c FROM menu WHERE category=? AND id NOT IN (?, ?)', [CAT, ITEM_IMG, ITEM_PLAIN]);
    check('…row count confirms nothing was inserted', Number(strays[0].c) === 0);

    const asCashier = await call('PUT', '/api/menu/' + ITEM_IMG, cashier, itemBody({ imageData: PNG_DATA_URL }));
    check('cashier is DENIED image writes (menu writes stay manager-gated)', asCashier.status === 403, { status: asCashier.status });

    // ── a VALID write flows through, and the catalog ETag moves with it ──
    const etagBefore = cat1.headers.etag;
    const validWrite = await call('PUT', '/api/menu/' + ITEM_IMG, manager, itemBody({ imageData: 'data:image/webp;base64,' + PNG_B64 }));
    check('valid webp write is accepted', validWrite.body?.success === true, validWrite.body);
    const cat2 = await call('GET', '/api/pos/v2/catalog', cashier);
    const seeded2 = cat2.body?.data?.items?.find((i) => i.id === ITEM_IMG);
    check('imageVersion changed after the image edit', seeded2 && seeded2.imageVersion === sha256('data:image/webp;base64,' + PNG_B64).slice(0, 8) && seeded2.imageVersion !== seeded.imageVersion, seeded2 && seeded2.imageVersion);
    check('…and the catalog ETag changed (cached clients revalidate)', !!etagBefore && !!cat2.headers.etag && cat2.headers.etag !== etagBefore, { before: etagBefore, after: cat2.headers.etag });
    const webp = await callBytes('/api/pos/v2/item-image/' + ITEM_IMG, cashier);
    check('endpoint now serves image/webp', webp.status === 200 && webp.headers['content-type'] === 'image/webp', webp.headers['content-type']);

    // ── '' clears ──
    const clear = await call('PUT', '/api/menu/' + ITEM_IMG, manager, itemBody({ imageData: '' }));
    check("imageData:'' clears the image", clear.body?.success === true, clear.body);
    check('…DB column is NULL after the clear', (await storedImage(ITEM_IMG)) === null);
    const cat3 = await call('GET', '/api/pos/v2/catalog', cashier);
    const seeded3 = cat3.body?.data?.items?.find((i) => i.id === ITEM_IMG);
    check('…catalog imageVersion is null after the clear', seeded3 && seeded3.imageVersion === null, seeded3 && seeded3.imageVersion);
    const cleared = await callBytes('/api/pos/v2/item-image/' + ITEM_IMG, cashier);
    check('…endpoint → 404 after the clear', cleared.status === 404, { status: cleared.status });

    console.log(`\n${fail === 0 ? '✅' : '❌'} itemImage: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
