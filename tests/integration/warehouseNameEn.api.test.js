'use strict';
/* Integration — B3: bilingual warehouse name (name_en).
 * The English name is mandatory for NEW warehouses, returned by the list, and
 * filterable via missingNameEn for the completion workflow.
 * Run: node tests/integration/warehouseNameEn.api.test.js
 */
require('dotenv').config();
const harness = require('../helpers/testHarness');
harness.activate();
const http = require('http');
const db = require('../../db/connection');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }
function call(port, method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
    if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
async function cleanup() {
  try { await db.query("DELETE FROM warehouses WHERE code LIKE 'B3EN%' OR id LIKE 'WH-B3EN%'"); } catch (_) {}
}

(async () => {
  let server = null;
  try {
    await harness.ensureSchema();
    await cleanup();
    console.log('\n═══ B3 warehouse name_en (isolated test DB) ═══');
    // The migration adds warehouses.name_en at boot; confirm the column exists.
    const [cols] = await db.query("SHOW COLUMNS FROM warehouses LIKE 'name_en'");
    check('warehouses.name_en column exists (boot migration)', cols.length === 1);

    server = await harness.spawnServer();
    const port = server.port;
    const token = require('jsonwebtoken').sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // create WITHOUT English name → rejected
    const noEn = await call(port, 'POST', '/api/inventory/v2/warehouses', token, { name: 'مستودع بلا إنجليزي', code: 'B3EN1', type: 'branch' });
    check('create without nameEn is rejected (not 201)', noEn.status !== 201 && !(noEn.body && noEn.body.success), { status: noEn.status, body: noEn.body });

    // create WITH both names → 201
    const withEn = await call(port, 'POST', '/api/inventory/v2/warehouses', token, { name: 'مستودع ثنائي', nameEn: 'Bilingual WH', code: 'B3EN2', type: 'branch' });
    check('create with both names succeeds (201)', withEn.status === 201, { status: withEn.status, body: withEn.body });

    // list returns nameEn
    const list = await call(port, 'GET', '/api/inventory/v2/warehouses', token);
    const created = (list.body && list.body.data || []).find((w) => w.code === 'B3EN2');
    check('list returns the created warehouse with nameEn = "Bilingual WH"', created && created.nameEn === 'Bilingual WH', created);

    // a legacy row missing name_en
    await db.query("INSERT INTO warehouses (id, code, name, name_en, type, is_active) VALUES ('WH-B3EN-LEGACY', 'B3EN3', 'مستودع قديم', NULL, 'branch', 1)");
    const missing = await call(port, 'GET', '/api/inventory/v2/warehouses?missingNameEn=1', token);
    const mset = new Set((missing.body && missing.body.data || []).map((w) => w.code));
    check('missingNameEn=1 includes the legacy no-English row, excludes the bilingual one', mset.has('B3EN3') && !mset.has('B3EN2'), [...mset]);

    // completing it via update removes it from the missing set
    await call(port, 'PATCH', '/api/inventory/v2/warehouses/WH-B3EN-LEGACY', token, { nameEn: 'Legacy WH (completed)' });
    const missing2 = await call(port, 'GET', '/api/inventory/v2/warehouses?missingNameEn=1', token);
    const mset2 = new Set((missing2.body && missing2.body.data || []).map((w) => w.code));
    check('after completing the English name, it drops out of the missing set', !mset2.has('B3EN3'), [...mset2]);

    await cleanup();
    console.log('\nB3 warehouse name_en: ' + pass + ' passed, ' + fail + ' failed' + (fail ? ' → ' + fails.join('; ') : ''));
    if (server && server.close) await server.close().catch(() => {});
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('FATAL', e); try { await cleanup(); } catch (_) {}
    if (server && server.close) try { await server.close(); } catch (_) {}
    process.exit(1);
  }
})();
