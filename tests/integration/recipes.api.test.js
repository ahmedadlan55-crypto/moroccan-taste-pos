/**
 * Unified recipe / BOM domain — integration.
 *
 * Boots a REAL server against the isolated test database and asserts the
 * DATABASE EFFECT after every write, not just the HTTP status. Covers the
 * defects the three legacy BOM writers shipped with:
 *   - yield 0 silently coerced to 1
 *   - a cost taken from the browser (erp-core.js:1074 "we trust it")
 *   - duplicate components silently losing quantity
 *   - self-reference and multi-level recipe cycles
 *   - a non-transactional DELETE-then-INSERT that could half-write a recipe
 *   - an active recipe edited in place under running production orders
 *   - reads that swallowed DB errors into res.json([])
 *
 * ISOLATED DB: pinned to moroccan_taste_pos_test BEFORE db/connection loads.
 * Run: npm run test:recipes-api   (MySQL must be up)
 */
'use strict';

// ── ISOLATED TEST DB — must be set before db/connection.js is required ────────
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL;
delete process.env.MYSQL_URL;
try { require('dotenv').config(); } catch (_) {}
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;

const NAME = 'recipes.api';
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.RECIPES_TEST_PORT || 3391);
let _p = 0, _f = 0;
function check(n, c, x) { if (c) { _p++; console.log('  ✅', n); } else { _f++; console.log('  ❌', n, x !== undefined ? '-> ' + JSON.stringify(x).slice(0, 400) : ''); } }
function near(a, b, t) { return Math.abs(Number(a) - Number(b)) <= (t == null ? 0.01 : t); }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: h }, (res) => {
      let buf = ''; res.on('data', (d) => { buf += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) { j = buf; } resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    r.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// The numbered migrations in db/migrations/ are step 2/3 of the release chain
// (scripts/release-start.js) — booting server.js alone does NOT apply them. Run
// them here so this test provisions its own schema on a fresh CI database
// instead of assuming someone migrated it by hand.
async function ensureSchema() {
  const { runPendingMigrations } = require('../../db/migrate');
  const silent = { info: () => {}, warn: () => {}, error: (o, m) => console.error('[migrate]', m || o) };
  await runPendingMigrations({ logger: silent });
}

(async () => {
  await ensureSchema();
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const P = 'SMK-';
  // Idempotency keys survive in `idempotency_keys` across runs. Without this the
  // SECOND run replays the FIRST run's cached response, pointing at rows the
  // first run's cleanup deleted — a harness artifact that would masquerade as a
  // product bug. (Same class of trap as the poisoned-IndexedDB fixture.)
  const RUN = 'smoke-' + Date.now() + '-';
  await conn.query("DELETE FROM idempotency_keys WHERE endpoint LIKE 'recipe:%'");
  async function cleanup() {
    await conn.query('DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM (SELECT id FROM bom WHERE product_id LIKE ?) x)', [P + '%']);
    await conn.query('DELETE FROM bom_outputs WHERE bom_id IN (SELECT id FROM (SELECT id FROM bom WHERE product_id LIKE ?) x)', [P + '%']);
    await conn.query('DELETE FROM bom WHERE product_id LIKE ?', [P + '%']);
    await conn.query('DELETE FROM item_units WHERE item_id LIKE ?', [P + '%']);
    await conn.query('DELETE FROM inv_items WHERE id LIKE ?', [P + '%']);
    await conn.query('DELETE FROM menu WHERE id LIKE ?', [P + '%']);
  }
  await cleanup();
  await conn.query('INSERT INTO inv_items (id,name,name_en,unit,cost,kind,active) VALUES (?,?,?,?,?,?,1)', [P + 'FLOUR', 'دقيق', 'Flour', 'g', 0.01, 'raw']);
  await conn.query('INSERT INTO inv_items (id,name,name_en,unit,cost,kind,active) VALUES (?,?,?,?,?,?,1)', [P + 'SUGAR', 'سكر', 'Sugar', 'g', 0.02, 'raw']);
  await conn.query('INSERT INTO inv_items (id,name,name_en,unit,cost,kind,active) VALUES (?,?,?,?,?,?,1)', [P + 'DOUGH', 'عجينة', 'Dough', 'g', 0, 'semi']);
  await conn.query('INSERT INTO menu (id,name,name_en,price,category,active) VALUES (?,?,?,?,?,1)', [P + 'CAKE', 'كيكة', 'Cake', 40, 'حلويات']);
  await conn.query('INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base,allow_production) VALUES (?,?,?,?,1,1,1)', [P + 'U-G', P + 'FLOUR', 'جرام', 'G']);
  await conn.query('INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base,allow_production) VALUES (?,?,?,?,0,1000,1)', [P + 'U-KG', P + 'FLOUR', 'كيلو', 'KG']);

  const server = spawn(process.execPath, ['server.js'], { env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'development' }), cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = ''; server.stdout.on('data', (d) => { boot += d; }); server.stderr.on('data', (d) => { boot += d; });
  let up=false; for (let i = 0; i < 240; i++) { const v = await req('GET', '/api/version'); if (v.status === 200) { up=true; break; } await sleep(500); }
  if (!up) { console.error('SERVER NEVER CAME UP: ' + boot.slice(-4000)); server.kill(); await conn.end(); process.exit(1); }

  const token = jwt.sign({ username: 'admin', role: 'admin', isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: '1h' });

  console.log('\n=== unified recipe API ===');
  const meta = await req('GET', '/api/recipes/meta', token);
  check('GET /meta returns option sets', meta.status === 200 && meta.body.data && Array.isArray(meta.body.data.productTypes), meta.status);

  const anon = await req('GET', '/api/recipes/meta');
  check('recipes API is NOT anonymous (unlike /api/menu)', anon.status === 401 || anon.status === 403, anon.status);

  const list = await req('GET', '/api/recipes?pageSize=25&q=' + encodeURIComponent('SMK-'), token);
  check('GET / lists products (incl. ones with NO recipe)', list.status === 200 && list.body.data.length > 0, { s: list.status, b: list.body });
  const cake = (list.body.data || []).find((r) => r.productId === P + 'CAKE');
  check('a product with no recipe appears with status "none"', cake && cake.recipeStatus === 'none', cake && cake.recipeStatus);
  check('list carries NO base64 image bytes', JSON.stringify(list.body).indexOf('data:image') === -1);
  check('list exposes imageVersion instead', !!cake && ('imageVersion' in cake));
  check('KPIs present', !!list.body.kpis && typeof list.body.kpis.withoutRecipe === 'number', list.body.kpis);

  const save1 = await req('POST', '/api/recipes/menu/' + P + 'CAKE', token, {
    yieldQuantity: 4, yieldUnit: 'PCS', activate: true,
    lines: [
      { componentItemId: P + 'FLOUR', quantity: 1, enteredUnitCode: 'KG', wastePct: 10 },
      { componentItemId: P + 'SUGAR', quantity: 200, wastePct: 0 },
      { componentItemId: P + 'FLOUR', quantity: 0.5, enteredUnitCode: 'KG', wastePct: 0 },
    ],
  }, { 'Idempotency-Key': RUN + "save-1" });
  check('POST save -> 200', save1.status === 200, save1.body);
  check('duplicate components were merged (warning surfaced)', (save1.body.warnings || []).some((w) => w.code === 'DUPLICATE_COMPONENTS_MERGED'), save1.body.warnings);
  const bomId = save1.body.data && save1.body.data.bomId;

  const [lines] = await conn.query('SELECT * FROM bom_lines WHERE bom_id=? ORDER BY line_no', [bomId]);
  check('DB EFFECT: exactly 2 line rows (3 sent, 2 flour merged)', lines.length === 2, lines.map((l) => l.component_item_id));
  const fl = lines.find((l) => l.component_item_id === P + 'FLOUR') || {};
  check('DB EFFECT: merged flour net = 1.5 KG', near(fl.quantity, 1.5), fl.quantity);
  check('DB EFFECT: conversion factor SNAPSHOTTED as 1000', near(fl.conversion_factor, 1000), fl.conversion_factor);
  check('DB EFFECT: base_quantity = 1500 g', near(fl.base_quantity, 1500), fl.base_quantity);
  check('DB EFFECT: re-derived waste preserves gross (1600 g)', near(Number(fl.base_quantity) * (1 + Number(fl.waste_pct) / 100), 1600, 0.5), { base: fl.base_quantity, waste: fl.waste_pct });
  check('DB EFFECT: registered unit id stored', fl.entered_unit_id === P + 'U-KG', fl.entered_unit_id);

  const [[bomRow]] = await conn.query('SELECT * FROM bom WHERE id=?', [bomId]);
  check('DB EFFECT: server-computed batch cost = 20', near(bomRow.cost_batch, 20), bomRow.cost_batch);
  check('DB EFFECT: unit cost divides by yield = 5', near(bomRow.cost_per_unit, 5), bomRow.cost_per_unit);
  check('DB EFFECT: status active', bomRow.status === 'active', bomRow.status);
  const [[menuRow]] = await conn.query('SELECT cost, computed_cost, cost_source, bom_id FROM menu WHERE id=?', [P + 'CAKE']);
  check('DB EFFECT: menu.cost cascaded = 5', near(menuRow.cost, 5), menuRow.cost);
  check('DB EFFECT: cost_source stamped recipe (arms the manual-edit 409 lock)', menuRow.cost_source === 'recipe', menuRow.cost_source);
  check('DB EFFECT: menu.bom_id linked', menuRow.bom_id === bomId, menuRow.bom_id);
  const [[outCnt]] = await conn.query('SELECT COUNT(*) c FROM bom_outputs WHERE bom_id=?', [bomId]);
  check('DB EFFECT: a primary output row was synthesised', Number(outCnt.c) === 1, outCnt.c);
  const [[aud]] = await conn.query("SELECT COUNT(*) c FROM audit_logs WHERE entity_type='bom' AND entity_id=?", [bomId]);
  check('DB EFFECT: audit row written (fail-closed)', Number(aud.c) >= 1, aud.c);

  const detail0 = await req('GET', '/api/recipes/menu/' + P + 'CAKE', token);
  check('GET detail -> 200 with the active recipe', detail0.status === 200 && detail0.body.data.recipe && detail0.body.data.recipe.bomId === bomId, detail0.status);
  const rowVersion = detail0.body.data.recipe.rowVersion;

  const save2 = await req('POST', '/api/recipes/menu/' + P + 'CAKE', token, {
    yieldQuantity: 4, expectedVersion: rowVersion, recomputedCost: 999999,
    lines: [{ componentItemId: P + 'SUGAR', quantity: 100 }],
  }, { 'Idempotency-Key': RUN + "save-2" });
  check('editing an ACTIVE recipe mints a REVISION, not an in-place edit', save2.status === 200 && save2.body.data.action === 'revise', save2.body);
  check('the revision is a NEW bom id', save2.body.data && save2.body.data.bomId !== bomId, save2.body.data && save2.body.data.bomId);
  check('the revision is version 2', save2.body.data && save2.body.data.version === 2, save2.body.data && save2.body.data.version);
  check('the revision starts as a draft', save2.body.data && save2.body.data.status === 'draft', save2.body.data && save2.body.data.status);
  const [[stillActive]] = await conn.query('SELECT status FROM bom WHERE id=?', [bomId]);
  check('DB EFFECT: v1 is STILL active until v2 is activated', stillActive.status === 'active', stillActive.status);
  check('a browser-sent recomputedCost is IGNORED (100*0.02/4 = 0.5)', near(save2.body.data && save2.body.data.unitCost, 0.5), save2.body.data && save2.body.data.unitCost);

  const stale = await req('POST', '/api/recipes/menu/' + P + 'CAKE', token, {
    yieldQuantity: 4, expectedVersion: 999, lines: [{ componentItemId: P + 'SUGAR', quantity: 1 }],
  }, { 'Idempotency-Key': RUN + "stale" });
  check('a stale expectedVersion -> 409 VERSION_CONFLICT', stale.status === 409 && stale.body.code === 'VERSION_CONFLICT', { s: stale.status, c: stale.body.code });
  check('errors carry a requestId (correlation id)', !!stale.body.requestId, stale.body.requestId);

  const badYield = await req('POST', '/api/recipes/inv/' + P + 'DOUGH', token, { yieldQuantity: 0, lines: [{ componentItemId: P + 'FLOUR', quantity: 1 }] });
  check('yield 0 -> 422 (was silently coerced to 1)', badYield.status === 422 && badYield.body.code === 'VALIDATION_ERROR', { s: badYield.status, c: badYield.body.code });
  const badWaste = await req('POST', '/api/recipes/inv/' + P + 'DOUGH', token, { yieldQuantity: 1, lines: [{ componentItemId: P + 'FLOUR', quantity: 1, wastePct: 150 }] });
  check('wastePct 150 -> 422', badWaste.status === 422, badWaste.status);
  const selfRef = await req('POST', '/api/recipes/inv/' + P + 'DOUGH', token, { yieldQuantity: 1, lines: [{ componentItemId: P + 'DOUGH', quantity: 1 }] });
  check('self-reference -> 422 RECIPE_SELF_REFERENCE', selfRef.status === 422 && selfRef.body.code === 'RECIPE_SELF_REFERENCE', { s: selfRef.status, c: selfRef.body.code });

  const dough = await req('POST', '/api/recipes/inv/' + P + 'DOUGH', token, { yieldQuantity: 1000, activate: true, lines: [{ componentItemId: P + 'FLOUR', quantity: 900 }] }, { 'Idempotency-Key': RUN + "dough" });
  check('semi-finished inv product recipe saves', dough.status === 200, dough.body);
  const cycle = await req('POST', '/api/recipes/inv/' + P + 'FLOUR', token, { yieldQuantity: 1, lines: [{ componentItemId: P + 'DOUGH', quantity: 1 }] }, { 'Idempotency-Key': RUN + "cycle" });
  check('multi-level cycle FLOUR->DOUGH->FLOUR -> 422 RECIPE_CYCLE', cycle.status === 422 && cycle.body.code === 'RECIPE_CYCLE', { s: cycle.status, c: cycle.body.code });

  const [[beforeCnt]] = await conn.query('SELECT COUNT(*) c FROM bom WHERE product_id=?', [P + 'DOUGH']);
  const doughDetail = await req('GET', '/api/recipes/inv/' + P + 'DOUGH', token);
  const doughRv = doughDetail.body.data.recipe.rowVersion;
  const rollback = await req('POST', '/api/recipes/inv/' + P + 'DOUGH', token, {
    yieldQuantity: 5, expectedVersion: doughRv,
    lines: [{ componentItemId: P + 'SUGAR', quantity: 1 }, { componentItemId: 'NOPE-DOES-NOT-EXIST', quantity: 1 }],
  }, { 'Idempotency-Key': RUN + "rollback" });
  check('a bad component -> 422, not a partial write', rollback.status === 422, { s: rollback.status, b: rollback.body });
  const [[afterCnt]] = await conn.query('SELECT COUNT(*) c FROM bom WHERE product_id=?', [P + 'DOUGH']);
  check('DB EFFECT: rollback left NO new bom row', Number(beforeCnt.c) === Number(afterCnt.c), { before: beforeCnt.c, after: afterCnt.c });
  const [dl] = await conn.query('SELECT bl.component_item_id FROM bom_lines bl JOIN bom b ON b.id=bl.bom_id WHERE b.product_id=?', [P + 'DOUGH']);
  check('DB EFFECT: the original DOUGH lines are untouched', dl.length === 1 && dl[0].component_item_id === P + 'FLOUR', dl.map((x) => x.component_item_id));

  const replay = await req('POST', '/api/recipes/menu/' + P + 'CAKE', token, {
    yieldQuantity: 4, yieldUnit: 'PCS', activate: true,
    lines: [
      { componentItemId: P + 'FLOUR', quantity: 1, enteredUnitCode: 'KG', wastePct: 10 },
      { componentItemId: P + 'SUGAR', quantity: 200, wastePct: 0 },
      { componentItemId: P + 'FLOUR', quantity: 0.5, enteredUnitCode: 'KG', wastePct: 0 },
    ],
  }, { 'Idempotency-Key': RUN + "save-1" });
  check('replaying the same Idempotency-Key returns the ORIGINAL result', replay.status === 200 && replay.body.data.bomId === bomId, replay.body.data);
  const [[bomTotal]] = await conn.query('SELECT COUNT(*) c FROM bom WHERE product_id=?', [P + 'CAKE']);
  check('DB EFFECT: the replay created no extra recipe', Number(bomTotal.c) === 2, bomTotal.c);

  const wu = await req('GET', '/api/recipes/where-used/' + P + 'FLOUR', token);
  check('where-used finds the recipes consuming an item', wu.status === 200 && wu.body.data.totalCount >= 2, { status: wu.status, body: wu.body });
  const av = await req('GET', '/api/recipes/bom/' + bomId + '/availability', token);
  check('availability returns per-component required vs available', av.status === 200 && av.body.data.items.length === 2, { s: av.status, b: av.body });
  const cmp = await req('GET', '/api/recipes/compare?a=' + bomId + '&b=' + save2.body.data.bomId, token);
  check('compare returns a real line diff', cmp.status === 200 && cmp.body.data.summary.removed >= 1, cmp.body.data && cmp.body.data.summary);

  const act = await req('POST', '/api/recipes/bom/' + save2.body.data.bomId + '/activate', token, { expectedVersion: 1 });
  check('activate -> 200', act.status === 200, act.body);
  const [statuses] = await conn.query('SELECT id, status FROM bom WHERE product_id=? ORDER BY version', [P + 'CAKE']);
  check('DB EFFECT: exactly ONE active version remains', statuses.filter((s) => s.status === 'active').length === 1, statuses);
  check('DB EFFECT: v1 was archived', (statuses.find((s) => s.id === bomId) || {}).status === 'archived', statuses);

  const editArchived = await req('POST', '/api/recipes/menu/' + P + 'CAKE', token, { bomId, yieldQuantity: 4, expectedVersion: 2, lines: [{ componentItemId: P + 'SUGAR', quantity: 1 }] });
  check('editing an ARCHIVED version -> 409 RECIPE_IMMUTABLE', editArchived.status === 409 && editArchived.body.code === 'RECIPE_IMMUTABLE', { s: editArchived.status, c: editArchived.body.code });


  // ══ THE LEGACY ENDPOINTS DELEGATE — same rules, no divergence ═════════════
  console.log('\n=== legacy compatibility layer delegates ===');
  // 1) The endpoint the React app still calls (menu/api.ts:801).
  const legacyMenu = await req('POST', '/api/menu/' + P + 'CAKE/recipe-bom', token, {
    yieldQuantity: 2, yieldUnit: 'PCS',
    lines: [{ componentItemId: P + 'SUGAR', quantity: 50, wastePct: 0 }],
  });
  check('legacy POST /api/menu/:id/recipe-bom still answers 200', legacyMenu.status === 200, legacyMenu.body);
  check('...and returns the legacy {bomId, computedCost} shape',
    legacyMenu.body && legacyMenu.body.bomId && typeof legacyMenu.body.computedCost === 'number', legacyMenu.body);
  // 50 x 0.02 = 1 over yield 2 -> 0.5
  check('...with the UNIFIED cost formula (divides by yield): 0.5', near(legacyMenu.body.computedCost, 0.5), legacyMenu.body.computedCost);
  const [[legacyMenuRow]] = await conn.query('SELECT cost, cost_source FROM menu WHERE id=?', [P + 'CAKE']);
  check('DB EFFECT: it still cascades menu.cost and the recipe lock', near(legacyMenuRow.cost, 0.5) && legacyMenuRow.cost_source === 'recipe', legacyMenuRow);

  // The legacy path now INHERITS every rule it never had.
  const legacyBadYield = await req('POST', '/api/menu/' + P + 'CAKE/recipe-bom', token, {
    yieldQuantity: 0, lines: [{ componentItemId: P + 'SUGAR', quantity: 1 }],
  });
  check('legacy path now REJECTS yield 0 instead of coercing it to 1',
    legacyBadYield.status === 422, { s: legacyBadYield.status, c: legacyBadYield.body && legacyBadYield.body.code });
  const legacyDup = await req('POST', '/api/menu/' + P + 'CAKE/recipe-bom', token, {
    yieldQuantity: 1,
    lines: [{ componentItemId: P + 'SUGAR', quantity: 2 }, { componentItemId: P + 'SUGAR', quantity: 3 }],
  });
  check('legacy path now folds duplicate components', legacyDup.status === 200, legacyDup.body);
  const [dupLines] = await conn.query('SELECT component_item_id, quantity FROM bom_lines WHERE bom_id=?', [legacyDup.body.bomId]);
  check('DB EFFECT: one line holding the SUMMED 5, not two lines',
    dupLines.length === 1 && near(dupLines[0].quantity, 5), dupLines);

  // 2) /api/erp/bom — the one that TRUSTED a browser-sent cost.
  const legacyErp = await req('POST', '/api/erp/bom', token, {
    productId: P + 'DOUGH', productSource: 'inv', yieldQuantity: 100,
    recomputedCost: 999999,
    lines: [{ componentItemId: P + 'SUGAR', quantity: 100 }],
  });
  check('legacy POST /api/erp/bom still answers 200', legacyErp.status === 200, legacyErp.body);
  // 100 x 0.02 = 2 over yield 100 -> 0.02
  check('...and IGNORES the browser-sent recomputedCost (was "we trust it")',
    near(legacyErp.body.computedCost, 0.02), legacyErp.body.computedCost);
  const legacyCycle = await req('POST', '/api/erp/bom', token, {
    productId: P + 'SUGAR', productSource: 'inv', yieldQuantity: 1,
    lines: [{ componentItemId: P + 'DOUGH', quantity: 1 }],
  });
  check('legacy /erp/bom now refuses a cycle it used to accept',
    legacyCycle.status === 422 && legacyCycle.body.code === 'RECIPE_CYCLE', { s: legacyCycle.status, c: legacyCycle.body && legacyCycle.body.code });

  // 3) The reads no longer fake an empty list on failure.
  const bomList = await req('GET', '/api/erp/bom', token);
  check('GET /api/erp/bom still returns an array on success', bomList.status === 200 && Array.isArray(bomList.body), bomList.status);

  console.log('\n' + (_f === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) console.log(boot.slice(-2500));
  await cleanup();
  server.kill(); await conn.end();
  process.exit(_f === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ERR', e); process.exit(1); });
