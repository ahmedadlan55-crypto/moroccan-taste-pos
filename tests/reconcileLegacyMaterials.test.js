/**
 * Unit test for scripts/reconcile-legacy-materials.js — pure runner, uses a
 * mock connection so it runs in `npm test` without any DB.
 */
'use strict';
const { runReconcile } = require('../scripts/reconcile-legacy-materials');

let _p = 0, _f = 0;
function test(name, fn) { const ok = (async () => await fn())().then(() => { _p++; console.log('  ✅', name); }, (e) => { _f++; console.log('  ❌', name, '\n     ', e.message || e); }); return ok; }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
function truthy(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// Minimal mock: dispatches queries to canned responses by SQL-shape match.
function makeMockConn(state) {
  const s = state;
  return {
    async query(sql, params) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (/SELECT ws.item_id, MAX/i.test(q)) return [s.orphans.filter((r) => /INV-/.test(r.item_id))];
      if (/inventory_movements WHERE item_id IN/i.test(q)) return [s.movements];
      if (/SELECT COUNT\(\*\) rows_, ROUND\(SUM\(qty\)/i.test(q)) return [[{ rows_: s.stock.rows, sum_qty: s.stock.qty, sum_value: s.stock.value }]];
      if (/START TRANSACTION/i.test(q)) { s.inTx = true; s.startSnapshot = { ...s.stock }; return [{}]; }
      if (/COMMIT/i.test(q)) { s.inTx = false; return [{}]; }
      if (/ROLLBACK/i.test(q)) { s.inTx = false; s.stock = { ...s.startSnapshot }; return [{}]; }
      if (/^INSERT INTO inv_items/i.test(q)) {
        const [id, name, cost] = params;
        s.inv_items.push({ id, name, cost, category: 'legacy-raw-materials' });
        return [{ affectedRows: 1 }];
      }
      if (/SELECT COUNT\(\*\) c FROM warehouse_stock ws LEFT JOIN inv_items/i.test(q)) {
        const orphansLeft = s.orphans.filter((r) => !s.inv_items.some((i) => i.id === r.item_id));
        return [[{ c: orphansLeft.length }]];
      }
      if (/DELETE FROM inv_items WHERE id IN/i.test(q)) {
        const [ids] = params;
        const before = s.inv_items.length;
        s.inv_items = s.inv_items.filter((i) => !ids.includes(i.id));
        return [{ affectedRows: before - s.inv_items.length }];
      }
      if (/SELECT id FROM inv_items WHERE category='legacy-raw-materials' AND id IN/i.test(q)) {
        const [ids] = params;
        return [s.inv_items.filter((i) => ids.includes(i.id) && i.category === 'legacy-raw-materials').map((i) => ({ id: i.id }))];
      }
      throw new Error('unmocked query: ' + q.slice(0, 100));
    },
  };
}

(async () => {
  console.log('\n═══ reconcile legacy materials (W1) — unit ═══\n');

  await test('dry-run: reports orphans without writing', async () => {
    const state = { orphans: [{ item_id: 'INV-1', cost: 5, total_qty: 10, warehouses: 1 }, { item_id: 'INV-2', cost: 0, total_qty: 3, warehouses: 2 }], movements: [{ item_id: 'INV-1', item_name: 'طماطم' }], inv_items: [], stock: { rows: 100, qty: 1000, value: 500 } };
    const rep = await runReconcile({ conn: makeMockConn(state) });
    eq(rep.dryRun, true);
    eq(rep.before.orphanCount, 2);
    eq(rep.plannedInserts.length, 2);
    eq(rep.plannedInserts[0].name, 'طماطم');
    eq(rep.plannedInserts[1].name, 'مادة قديمة INV-2');
    eq(state.inv_items.length, 0, 'should not write in dry-run');
  });

  await test('apply: inserts once + invariant (0 orphans + totals unchanged) holds → COMMIT', async () => {
    const state = { orphans: [{ item_id: 'INV-A', cost: 7, total_qty: 5, warehouses: 1 }], movements: [], inv_items: [], stock: { rows: 10, qty: 100, value: 700 } };
    const rep = await runReconcile({ conn: makeMockConn(state), apply: true, artifactDir: require('os').tmpdir() });
    eq(rep.inserted.length, 1);
    eq(state.inv_items.length, 1);
    eq(rep.after.orphanGap, 0);
    eq(rep.after.stockRows, 10); // stock unchanged
  });

  await test('apply: if invariant fails (post gap != 0) → ROLLBACK', async () => {
    const state = { orphans: [{ item_id: 'INV-B', cost: 0, total_qty: 1, warehouses: 1 }], movements: [], inv_items: [], stock: { rows: 5, qty: 20, value: 0 } };
    // Break: force post-insert gap check to see one still missing
    const badConn = makeMockConn(state);
    const origQuery = badConn.query.bind(badConn);
    badConn.query = async (sql, params) => {
      if (/SELECT COUNT\(\*\) c FROM warehouse_stock ws LEFT JOIN inv_items/i.test(sql)) return [[{ c: 1 }]];
      return origQuery(sql, params);
    };
    let threw = false;
    try { await runReconcile({ conn: badConn, apply: true, artifactDir: require('os').tmpdir() }); } catch (e) { threw = /POST-INSERT GAP/.test(e.message); }
    truthy(threw, 'expected POST-INSERT GAP throw');
    eq(state.stock.rows, 5, 'rolled back stock snapshot');
  });

  await test('revert: deletes only the previously-inserted IDs, ignores others', async () => {
    const state = { orphans: [], movements: [], inv_items: [{ id: 'INV-X', category: 'legacy-raw-materials' }, { id: 'INV-Y', category: 'legacy-raw-materials' }, { id: 'MTG-1', category: 'other' }], stock: { rows: 0, qty: 0, value: 0 } };
    const tmp = require('os').tmpdir() + '/reconcile-revert-test.json';
    require('fs').writeFileSync(tmp, JSON.stringify({ inserted: [{ id: 'INV-X' }, { id: 'INV-Y' }, { id: 'MTG-1' }] }));
    const rep = await runReconcile({ conn: makeMockConn(state), revertFile: tmp });
    eq(rep.deleted, 2);
    eq(state.inv_items.length, 1, 'MTG-1 not deleted');
    eq(state.inv_items[0].id, 'MTG-1');
    eq(rep.unmatched, ['MTG-1']);
  });

  setTimeout(() => { console.log('\n' + (_f === 0 ? '✅' : '❌') + ' reconcileLegacyMaterials: ' + _p + ' passed, ' + _f + ' failed\n'); if (_f) process.exit(1); }, 300);
})();
