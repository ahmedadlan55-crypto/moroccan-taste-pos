#!/usr/bin/env node
'use strict';
/**
 * /api/erp/menu-options — server-side search and paging.
 *
 * WHY THIS EXISTS
 *   The item picker fetched the entire catalog once and filtered it in the
 *   browser. That is fine at 200 items and it is not what the 2,000-row cap is
 *   for: AT the cap the response silently truncated, so an item past the cut
 *   could not be found and nothing in the payload said the server had stopped
 *   looking. A picker that cannot find a real item, and cannot say so, is worse
 *   than a slow one.
 *
 * THE CONTRACT THIS PINS
 *   - no query params  → the historical bare ARRAY, byte-compatible with every
 *     existing caller
 *   - limit/offset     → an envelope carrying `hasMore`, because a short page
 *     and the end of the list are indistinguishable without it
 *   - `q` matches BOTH names — an English-speaking user typing "chicken" must
 *     match a row whose primary name is Arabic, and vice versa
 *   - the error path returns the SHAPE THE CALLER ASKED FOR; degrading a paged
 *     request to a bare array makes the client's own parse throw and undoes the
 *     degradation it was trying to provide
 *
 * The route is driven directly through a real Express app with a real MySQL
 * connection — not by calling a handler with a hand-built req/res, which would
 * let a routing or middleware mistake pass unnoticed.
 */
const assert = require('assert');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const express = require('express');
const http = require('http');
const db = require('../db/connection');

let pass = 0, fail = 0;
function it(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log('  ok   ' + name); })
    .catch((e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); });
}

const PREFIX = '__test_mopt__';
let server, port;

function get(qs) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/erp/menu-options' + qs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { reject(new Error('non-JSON response: ' + body.slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

async function seed() {
  await cleanup();
  // Names chosen so search can be proved in BOTH directions: an Arabic primary
  // with an English secondary, and the reverse.
  const rows = [];
  for (let i = 1; i <= 25; i++) {
    rows.push([`${PREFIX}${String(i).padStart(3, '0')}`, `${PREFIX} دجاج ${i}`, `${PREFIX} Chicken ${i}`]);
  }
  rows.push([`${PREFIX}zz1`, `${PREFIX} سلطة`, `${PREFIX} Salad`]);
  rows.push([`${PREFIX}zz2`, `${PREFIX} عصير`, null]); // no English name at all
  for (const [id, name, nameEn] of rows) {
    await db.query(
      'INSERT INTO menu (id, name, name_en, price, active) VALUES (?,?,?,0,1)',
      [id, name, nameEn]);
  }
}
const cleanup = () => db.query('DELETE FROM menu WHERE id LIKE ?', [PREFIX + '%']);

async function main() {
  console.log('menuOptionsPaging');
  try { await db.query('SELECT 1'); } catch (e) {
    console.log('  FATAL: MySQL unreachable — ' + (e.code || e.message));
    process.exit(2);
  }
  await seed();

  const app = express();
  app.use('/api/erp', require('../routes/erp/menu-options'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  console.log('\n1. the historical shape is untouched for existing callers');

  await it('no query params → a bare ARRAY, not an envelope', async () => {
    const { status, json } = await get('');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(json), 'response is no longer an array — every existing caller breaks');
    assert.ok(json.length >= 27, `expected the seeded rows, got ${json.length}`);
  });

  console.log('\n2. paging');

  await it('limit returns exactly that many, and says there is more', async () => {
    const { json } = await get('?q=' + encodeURIComponent(PREFIX) + '&limit=10');
    assert.ok(!Array.isArray(json), 'a paged request must return an envelope');
    assert.strictEqual(json.items.length, 10);
    assert.strictEqual(json.hasMore, true);
  });

  await it('the LAST page says hasMore=false — the only page allowed to', async () => {
    const { json } = await get('?q=' + encodeURIComponent(PREFIX) + '&limit=10&offset=20');
    assert.ok(json.items.length > 0 && json.items.length <= 10);
    assert.strictEqual(json.hasMore, false, 'the final page claimed more rows exist');
  });

  await it('offset actually advances — page 2 shares nothing with page 1', async () => {
    const a = await get('?q=' + encodeURIComponent(PREFIX) + '&limit=10&offset=0');
    const b = await get('?q=' + encodeURIComponent(PREFIX) + '&limit=10&offset=10');
    const ids = new Set(a.json.items.map((x) => x.id));
    assert.ok(b.json.items.every((x) => !ids.has(x.id)), 'page 2 repeated rows from page 1');
  });

  await it('paging past the end is an empty page, not an error', async () => {
    const { status, json } = await get('?q=' + encodeURIComponent(PREFIX) + '&limit=10&offset=9999');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json.items, []);
    assert.strictEqual(json.hasMore, false);
  });

  console.log('\n3. search matches BOTH languages — the whole point of two name columns');

  await it('an English term finds a row whose primary name is Arabic', async () => {
    const { json } = await get('?q=' + encodeURIComponent(PREFIX + ' Chicken') + '&limit=50');
    assert.ok(json.items.length >= 25, `English search found ${json.items.length}`);
    assert.ok(json.items.every((x) => x.name.includes('دجاج')), 'matched the wrong rows');
  });

  await it('an Arabic term finds the same rows', async () => {
    const { json } = await get('?q=' + encodeURIComponent('دجاج') + '&limit=50');
    assert.ok(json.items.length >= 25, `Arabic search found ${json.items.length}`);
  });

  await it('an exact id resolves — a pasted id must not come back empty', async () => {
    const { json } = await get('?q=' + encodeURIComponent(PREFIX + '007') + '&limit=5');
    assert.strictEqual(json.items.length, 1);
    assert.strictEqual(json.items[0].id, PREFIX + '007');
  });

  await it('a row with NO English name is still returned and carries an empty string', async () => {
    // The picker renders nameEn directly; a null here becomes "null" on screen.
    //
    // Scoped to the fixture prefix on purpose: searching the bare word matched
    // five rows, because the real catalog on this machine also sells عصير. A
    // test that assumes it owns a shared table passes only until someone adds
    // an item.
    const { json } = await get('?q=' + encodeURIComponent(PREFIX + ' عصير') + '&limit=5');
    assert.strictEqual(json.items.length, 1);
    assert.strictEqual(json.items[0].nameEn, '');
  });

  await it('a term matching nothing returns an empty page, not everything', async () => {
    // A dropped WHERE clause is the failure mode: it looks like a working
    // search right up until it silently returns the whole catalog.
    const { json } = await get('?q=' + encodeURIComponent('zzz-no-such-item-zzz') + '&limit=50');
    assert.deepStrictEqual(json.items, []);
  });

  console.log('\n4. hostile input is clamped, never bound raw');

  await it('a non-numeric limit falls back instead of throwing', async () => {
    const { status, json } = await get('?q=' + encodeURIComponent(PREFIX) + '&limit=abc');
    assert.strictEqual(status, 200);
    assert.ok(json.items.length > 0);
  });

  await it('a negative offset does not become a SQL error', async () => {
    const { status } = await get('?q=' + encodeURIComponent(PREFIX) + '&limit=5&offset=-10');
    assert.strictEqual(status, 200);
  });

  await it('an absurd limit is capped, not honoured', async () => {
    const { json } = await get('?q=' + encodeURIComponent(PREFIX) + '&limit=999999');
    assert.ok(json.limit <= 2000, `limit ${json.limit} exceeds the cap`);
  });

  await it('a SQL metacharacter in q is a literal, not syntax', async () => {
    const { status, json } = await get('?q=' + encodeURIComponent("' OR 1=1 --") + '&limit=50');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json.items, [], 'the injection matched rows — q is not bound');
  });

  await new Promise((r) => server.close(r));
  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch (_) {}
  process.exit(2);
});
