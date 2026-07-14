/**
 * posO2cProjection.api.test.js — the eager POS→O2C line-snapshot projection.
 *
 * Before this, a POS checkout wrote NO ar_documents row and NO ar_document_lines,
 * so SalesReturnService._resolveOriginal ("SELECT … WHERE source_type='pos'")
 * found nothing and no POS sale was returnable by any path. InvoiceService
 * .linkPosSale existed but was called only by the backfill script, and wrote the
 * header alone.
 *
 * Checkout now projects header + lines + inventory-component snapshots eagerly,
 * inside its own transaction, from the same numbers that produced the sale and
 * posted the GL — never recomputed later from master data that may have moved.
 *
 * Drives a real server + the .env DB. PORT 3251. Self-cleaning best-effort.
 * Run: node tests/integration/posO2cProjection.api.test.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const ENV = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2];
}
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const db = require(path.join(ROOT, 'db', 'connection'));

const PORT = 3251;
const BASE = `http://127.0.0.1:${PORT}`;
const T = {
  admin: jwt.sign({ id: 1, username: 'admin', role: 'admin', tokenVersion: 1 }, ENV.JWT_SECRET, { expiresIn: '1h' }),
};

let _p = 0, _f = 0; const _fails = [];
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; _fails.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 260) : ''); }
}
async function waitUp(s) {
  for (let i = 0; i < s; i++) {
    try { const r = await fetch(BASE + '/api/version'); if (r.ok) return true; } catch (_) {}
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}
function api(method, p, tok, body) {
  return fetch(BASE + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
async function j(method, p, tok, body) {
  const r = await api(method, p, tok, body);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const minor = (v) => Math.round(Number(v) * 100);

// ── fixtures ────────────────────────────────────────────────────────────────
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-PROJ-${SFX}-${s}`;
const INV_A = P('INVA');       // recipe ingredient, cost 3.00
const INV_B = P('INVB');       // recipe ingredient, cost 1.50
const M_PLAIN = P('MPLAIN');   // standard-rated, no recipe → cost legitimately 0
const M_RECIPE = P('MRECIPE');  // standard-rated, 2 ingredients
const M_ZERO = P('MZERO');     // zero-rated
const SHIFT = P('SH');

async function seed() {
  await cleanup();
  // routes/sales.js:340-366 requires every sale to FK a REAL OPEN shift owned
  // by the acting cashier — the token above is `admin`, so the shift must be.
  await db.query("INSERT INTO shifts (id, username, status, start_time) VALUES (?,?,'OPEN',NOW())", [SHIFT, 'admin']);
  await db.query('INSERT INTO inv_items (id, name, category, cost, stock, unit, active, kind) VALUES (?,?,?,?,?,?,1,?)',
    [INV_A, 'ITEST ing A', 'ITEST', 3.0, 100000, 'kg', 'raw']);
  await db.query('INSERT INTO inv_items (id, name, category, cost, stock, unit, active, kind) VALUES (?,?,?,?,?,?,1,?)',
    [INV_B, 'ITEST ing B', 'ITEST', 1.5, 100000, 'kg', 'raw']);
  // is_tax_inclusive=1 mirrors the POS default (_taxMeta falls back to
  // { cat:'S', inclusive:true }); prices are what the cashier sees.
  await db.query('INSERT INTO menu (id, name, price, category, cost, stock, active, tax_category, is_tax_inclusive, production_method) VALUES (?,?,?,?,?,?,1,?,1,?)',
    [M_PLAIN, 'ITEST plain', 23.0, 'ITEST', 0, 0, 'S', 'made_at_branch']);
  await db.query('INSERT INTO menu (id, name, price, category, cost, stock, active, tax_category, is_tax_inclusive, production_method) VALUES (?,?,?,?,?,?,1,?,1,?)',
    [M_RECIPE, 'ITEST recipe', 46.0, 'ITEST', 0, 0, 'S', 'made_at_branch']);
  await db.query('INSERT INTO menu (id, name, price, category, cost, stock, active, tax_category, is_tax_inclusive, production_method) VALUES (?,?,?,?,?,?,1,?,1,?)',
    [M_ZERO, 'ITEST zero', 10.0, 'ITEST', 0, 0, 'Z', 'made_at_branch']);
  // 2 kg of A + 1 kg of B per unit → 2×3.00 + 1×1.50 = 7.50 per unit.
  // recipe.id is INT AUTO_INCREMENT — let MySQL assign it.
  await db.query('INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used) VALUES (?,?,?,?,?)',
    [M_RECIPE, 'ITEST recipe', INV_A, 'ITEST ing A', 2]);
  await db.query('INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used) VALUES (?,?,?,?,?)',
    [M_RECIPE, 'ITEST recipe', INV_B, 'ITEST ing B', 1]);
}

async function cleanup() {
  const like = `ITEST-PROJ-${SFX}-%`;
  const del = async (sql, params) => { try { await db.query(sql, params); } catch (_) {} };
  // Safety net: the rollback case renames this table to force a fault. If that
  // case died between the rename and its restore, put it back — leaving it
  // renamed would break every checkout on this DB, not just the test.
  try {
    const [bak] = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='arlc_itest_bak'");
    if (bak.length) {
      await del('DROP TABLE IF EXISTS ar_document_line_components');
      await db.query('RENAME TABLE arlc_itest_bak TO ar_document_line_components');
      console.log('  ⚠ restored ar_document_line_components from a stranded rename');
    }
  } catch (_) {}
  // sales.id is SERVER-generated, so it does not carry the fixture prefix —
  // only client_order_id does. Resolve the real ids first; matching sales.id
  // against the prefix would silently delete nothing and leak every row.
  let ids = [];
  try {
    const [rows] = await db.query('SELECT id FROM sales WHERE client_order_id LIKE ?', [like]);
    ids = rows.map((r) => r.id);
  } catch (_) {}
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    await del(`DELETE c FROM ar_document_line_components c JOIN ar_documents d ON d.id = c.document_id WHERE d.source_type='pos' AND d.source_id IN (${ph})`, ids);
    await del(`DELETE l FROM ar_document_lines l JOIN ar_documents d ON d.id = l.document_id WHERE d.source_type='pos' AND d.source_id IN (${ph})`, ids);
    await del(`DELETE e FROM ar_events e JOIN ar_documents d ON d.id = e.document_id WHERE d.source_type='pos' AND d.source_id IN (${ph})`, ids);
    await del(`DELETE srl FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id WHERE sr.original_sale_id IN (${ph})`, ids);
    await del(`DELETE FROM sales_returns WHERE original_sale_id IN (${ph})`, ids);
    await del(`DELETE FROM ar_documents WHERE source_type='pos' AND source_id IN (${ph})`, ids);
    await del(`DELETE FROM gl_entries WHERE journal_id IN (SELECT id FROM gl_journals WHERE reference_type IN ('Sale','ChannelCommission') AND reference_id IN (${ph}))`, ids);
    await del(`DELETE FROM gl_journals WHERE reference_type IN ('Sale','ChannelCommission') AND reference_id IN (${ph})`, ids);
    await del(`DELETE FROM inventory_movements WHERE reference_id IN (${ph})`, ids);
    await del(`DELETE FROM sales_items WHERE order_id IN (${ph})`, ids);
    await del(`DELETE FROM sales WHERE id IN (${ph})`, ids);
  }
  await del(`DELETE FROM inventory_movements WHERE item_id LIKE ?`, [like]);
  await del(`DELETE FROM shifts WHERE id LIKE ?`, [like]);
  await del(`DELETE FROM recipe WHERE menu_id LIKE ?`, [like]);
  await del(`DELETE FROM warehouse_stock WHERE item_id LIKE ?`, [like]);
  await del(`DELETE FROM menu WHERE id LIKE ?`, [like]);
  await del(`DELETE FROM inv_items WHERE id LIKE ?`, [like]);
}

/** POST a checkout. `orderId` is server-assigned; we find it via client_order_id. */
async function sell(items, extra = {}) {
  const clientOrderId = P('CO-' + Math.random().toString(36).slice(2, 8));
  const gross = items.reduce((s, i) => s + i.qty * i.price, 0);
  const body = {
    items, paymentMethod: 'Cash', clientOrderId, shiftId: SHIFT,
    total: gross,
    // The server validates the client total only to ±1 SAR and recomputes it
    // authoritatively, so subtract any discount here to stay inside tolerance.
    totalFinal: gross - (extra.discountAmount || 0),
    ...extra,
  };
  const r = await j('POST', '/sales', T.admin, body);
  return { r, clientOrderId };
}
async function saleRow(clientOrderId) {
  const [s] = await db.query('SELECT * FROM sales WHERE client_order_id = ? LIMIT 1', [clientOrderId]);
  return s[0] || null;
}
async function projected(saleId) {
  const [d] = await db.query("SELECT * FROM ar_documents WHERE source_type='pos' AND source_id = ? LIMIT 1", [saleId]);
  if (!d.length) return { doc: null, lines: [], comps: [] };
  const [l] = await db.query('SELECT * FROM ar_document_lines WHERE document_id = ? ORDER BY source_line_id', [d[0].id]);
  const [c] = await db.query('SELECT * FROM ar_document_line_components WHERE document_id = ? ORDER BY document_line_id, component_seq', [d[0].id]);
  return { doc: d[0], lines: l, comps: c };
}

async function main() {
  console.log('\n═══ POS→O2C eager line projection ═══\n');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', ORDER_TO_CASH_ENABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });

  try {
    check('server up', await waitUp(240), log.slice(-400));
    await seed();

    // ── 1. a plain sale projects a header and every line ────────────────────
    console.log('\n── plain sale ──');
    {
      const { r, clientOrderId } = await sell([{ id: M_PLAIN, name: 'ITEST plain', qty: 2, price: 23.0 }]);
      check('checkout accepted', r.status === 200, { status: r.status, data: r.data });
      const s = await saleRow(clientOrderId);
      check('sale row written', !!s);
      const { doc, lines } = await projected(s.id);
      check('ar_documents header projected with source_type=pos', !!doc && doc.source_type === 'pos', doc && doc.source_type);
      check('header links the sale', !!doc && doc.source_id === s.id);
      check('header references the Sale GL journal', !!doc && !!doc.gl_journal_id, doc && doc.gl_journal_id);
      check('one line projected', lines.length === 1, lines.length);
      check('source_line_id populated (was NULL for every row ever written)',
        lines.length === 1 && lines[0].source_line_id === 'L0', lines[0] && lines[0].source_line_id);
      check('menu_id carried, item_id null (POS lines are menu items)',
        lines.length === 1 && lines[0].menu_id === M_PLAIN && lines[0].item_id === null,
        lines[0] && { menu_id: lines[0].menu_id, item_id: lines[0].item_id });
      check('projection_version stamped', lines.length === 1 && Number(lines[0].projection_version) === 1);
      check('line ties to total_final',
        lines.length === 1 && minor(lines[0].gross_amount) === minor(s.total_final),
        { line: lines[0] && lines[0].gross_amount, total: s && s.total_final });
      // 46.00 inclusive @15% → net 40.00, vat 6.00
      check('inclusive VAT split snapshotted (46.00 → net 40.00 + vat 6.00)',
        lines.length === 1 && minor(lines[0].net_amount) === 4000 && minor(lines[0].vat_amount) === 600,
        lines[0] && { net: lines[0].net_amount, vat: lines[0].vat_amount });
      check('no recipe → cost_snapshot legitimately 0, distinguishable via absent components',
        lines.length === 1 && minor(lines[0].cost_snapshot) === 0, lines[0] && lines[0].cost_snapshot);
    }

    // ── 2. a recipe sale snapshots components; cost ties to totalCogs ───────
    console.log('\n── recipe sale + component snapshots ──');
    {
      const { r, clientOrderId } = await sell([{ id: M_RECIPE, name: 'ITEST recipe', qty: 3, price: 46.0 }]);
      check('checkout accepted', r.status === 200, { status: r.status, data: r.data });
      const s = await saleRow(clientOrderId);
      const { doc, lines, comps } = await projected(s.id);
      check('header + line projected', !!doc && lines.length === 1);
      check('two component snapshots (one per ingredient)', comps.length === 2, comps.length);
      check('components carry the deducted BASE qty (3×2=6 kg A, 3×1=3 kg B)',
        comps.length === 2 && Number(comps.find((c) => c.inv_item_id === INV_A).deducted_base_qty) === 6
          && Number(comps.find((c) => c.inv_item_id === INV_B).deducted_base_qty) === 3,
        comps.map((c) => ({ i: c.inv_item_id, q: c.deducted_base_qty })));
      check('components carry the unit cost used by the GL (3.00 / 1.50)',
        comps.length === 2 && Number(comps.find((c) => c.inv_item_id === INV_A).unit_cost_snapshot) === 3
          && Number(comps.find((c) => c.inv_item_id === INV_B).unit_cost_snapshot) === 1.5,
        comps.map((c) => ({ i: c.inv_item_id, u: c.unit_cost_snapshot })));
      // 6 kg × 3.00 + 3 kg × 1.50 = 22.50
      const compSum = comps.reduce((a, c) => a + minor(c.total_cost), 0);
      check('Σ component total_cost === 22.50', compSum === 2250, compSum);
      check('Σ component total_cost === the line cost_snapshot',
        lines.length === 1 && compSum === minor(lines[0].cost_snapshot),
        { compSum, line: lines[0] && lines[0].cost_snapshot });
      // The GL's Dr COGS leg is the independent source of truth for totalCogs.
      const [glc] = await db.query(
        `SELECT COALESCE(SUM(e.debit),0) AS cogs FROM gl_entries e
           JOIN gl_journals jr ON jr.id = e.journal_id
          WHERE jr.reference_type='Sale' AND jr.reference_id = ? AND e.account_code = '5100'`, [s.id]);
      check('Σ line cost_snapshot === totalCogs actually posted to the GL',
        minor(glc[0].cogs) === lines.reduce((a, l) => a + minor(l.cost_snapshot), 0),
        { gl: glc[0].cogs, lines: lines.map((l) => l.cost_snapshot) });
      check('component source tagged recipe', comps.every((c) => c.source === 'recipe'), comps.map((c) => c.source));
    }

    // ── 3. same menu item on two lines stays distinguishable ────────────────
    // This is the case menuId alone could never resolve: recipesApplied carried
    // no line key, so two lines of one item were indistinguishable.
    console.log('\n── duplicate menu item on separate lines ──');
    {
      const { r, clientOrderId } = await sell([
        { id: M_RECIPE, name: 'ITEST recipe', qty: 1, price: 46.0 },
        { id: M_RECIPE, name: 'ITEST recipe', qty: 2, price: 46.0 },
      ]);
      check('checkout accepted', r.status === 200, { status: r.status, data: r.data });
      const s = await saleRow(clientOrderId);
      const { lines, comps } = await projected(s.id);
      check('both lines projected separately', lines.length === 2, lines.length);
      check('distinct source_line_ids L0 / L1',
        lines.length === 2 && lines[0].source_line_id === 'L0' && lines[1].source_line_id === 'L1',
        lines.map((l) => l.source_line_id));
      check('each line got its OWN qty (1 and 2), not a merged 3',
        lines.length === 2 && Number(lines[0].entered_qty) === 1 && Number(lines[1].entered_qty) === 2,
        lines.map((l) => l.entered_qty));
      check('components attach to both lines (2 per line)',
        comps.length === 4 && new Set(comps.map((c) => c.document_line_id)).size === 2,
        { comps: comps.length, parents: new Set(comps.map((c) => c.document_line_id)).size });
      // line0 = 1×7.50, line1 = 2×7.50
      const byLine = {};
      comps.forEach((c) => { byLine[c.document_line_id] = (byLine[c.document_line_id] || 0) + minor(c.total_cost); });
      const costs = lines.map((l) => byLine[l.id]);
      check('per-line cost follows its OWN qty (7.50 and 15.00)',
        costs[0] === 750 && costs[1] === 1500, costs);
    }

    // ── 4. mixed cart with a discount: every invariant closes ───────────────
    console.log('\n── mixed cart + discount ──');
    {
      const { r, clientOrderId } = await sell([
        { id: M_PLAIN, name: 'ITEST plain', qty: 1, price: 23.0 },
        { id: M_ZERO, name: 'ITEST zero', qty: 1, price: 10.0 },
        { id: M_RECIPE, name: 'ITEST recipe', qty: 1, price: 46.0 },
      ], { discountAmount: 7, discountName: 'ITEST disc' });
      check('checkout accepted', r.status === 200, { status: r.status, data: r.data });
      const s = await saleRow(clientOrderId);
      const { doc, lines } = await projected(s.id);
      check('three lines projected', lines.length === 3, lines.length);
      check('Σ line gross === total_final, to the halala',
        lines.reduce((a, l) => a + minor(l.gross_amount), 0) === minor(s.total_final),
        { lines: lines.map((l) => l.gross_amount), total: s.total_final });
      check('Σ line discount === the APPLIED discount stored on the sale',
        lines.reduce((a, l) => a + minor(l.discount_amount), 0) === minor(s.discount_amount),
        { lines: lines.map((l) => l.discount_amount), stored: s.discount_amount });
      check('zero-rated line carries no VAT',
        minor(lines.find((l) => l.menu_id === M_ZERO).vat_amount) === 0,
        lines.find((l) => l.menu_id === M_ZERO).vat_amount);
      check('vat_category snapshotted per line (S / Z)',
        lines.find((l) => l.menu_id === M_ZERO).vat_category === 'Z'
          && lines.find((l) => l.menu_id === M_PLAIN).vat_category === 'S',
        lines.map((l) => ({ m: l.menu_id, c: l.vat_category })));
      // tax_subtotals_json is what the ZATCA UBL sums — buckets are binding.
      const ts = s.tax_subtotals_json ? JSON.parse(s.tax_subtotals_json) : null;
      if (ts) {
        let ok = true; const detail = {};
        Object.keys(ts).forEach((cat) => {
          const mine = lines.filter((l) => l.vat_category === cat);
          const n = mine.reduce((a, l) => a + minor(l.net_amount), 0);
          const v = mine.reduce((a, l) => a + minor(l.vat_amount), 0);
          detail[cat] = { lineNet: n, bucketNet: minor(ts[cat].net), lineVat: v, bucketVat: minor(ts[cat].vat) };
          if (n !== minor(ts[cat].net) || v !== minor(ts[cat].vat)) ok = false;
        });
        check('per-category line sums === tax_subtotals_json exactly', ok, detail);
      } else {
        check('tax_subtotals_json present to reconcile against', false, 'missing');
      }
      check('header AR total === the sale total', minor(doc.total_amount) === minor(s.total_final),
        { doc: doc.total_amount, sale: s.total_final });
      check('header AR discount === the applied discount', minor(doc.discount_amount) === minor(s.discount_amount),
        { doc: doc.discount_amount, sale: s.discount_amount });
    }

    // ── 5. replay is idempotent ─────────────────────────────────────────────
    console.log('\n── idempotent replay ──');
    {
      const clientOrderId = P('CO-REPLAY');
      const body = {
        items: [{ id: M_RECIPE, name: 'ITEST recipe', qty: 1, price: 46.0 }],
        paymentMethod: 'Cash', clientOrderId, shiftId: SHIFT, total: 46, totalFinal: 46,
      };
      const r1 = await j('POST', '/sales', T.admin, body);
      const r2 = await j('POST', '/sales', T.admin, body);
      check('both checkout attempts answered 200', r1.status === 200 && r2.status === 200,
        { a: r1.status, b: r2.status });
      const s = await saleRow(clientOrderId);
      const [salesN] = await db.query('SELECT COUNT(*) n FROM sales WHERE client_order_id = ?', [clientOrderId]);
      check('exactly one sale row', Number(salesN[0].n) === 1, salesN[0].n);
      const [docN] = await db.query("SELECT COUNT(*) n FROM ar_documents WHERE source_type='pos' AND source_id = ?", [s.id]);
      check('exactly one ar_documents header', Number(docN[0].n) === 1, docN[0].n);
      const { lines, comps } = await projected(s.id);
      check('lines not duplicated by the replay', lines.length === 1, lines.length);
      check('components not duplicated by the replay', comps.length === 2, comps.length);
    }

    // ── 6. a projection failure rolls the whole sale back ───────────────────
    // Force a deterministic, in-band fault at the component INSERT — the LAST
    // step of the projection, by which point the sale row, the inventory
    // deduction, the GL journal, the AR header and the AR line have all been
    // written on this connection. If atomicity holds, none of them survive.
    // (Renaming the table is the fault: shrinking a column cannot work here,
    // because MySQL refuses to narrow one that existing rows already exceed.)
    console.log('\n── projection failure rolls back the sale ──');
    {
      const countAll = async () => {
        const [iv] = await db.query('SELECT stock FROM inv_items WHERE id = ?', [INV_A]);
        const [sl] = await db.query('SELECT COUNT(*) n FROM sales WHERE client_order_id LIKE ?', [`ITEST-PROJ-${SFX}-%`]);
        const [ar] = await db.query(
          `SELECT COUNT(*) n FROM ar_documents d JOIN sales s ON s.id = d.source_id
            WHERE d.source_type='pos' AND s.client_order_id LIKE ?`, [`ITEST-PROJ-${SFX}-%`]);
        const [mv] = await db.query('SELECT COUNT(*) n FROM inventory_movements WHERE item_id = ?', [INV_A]);
        return { stock: Number(iv[0].stock), sales: Number(sl[0].n), ar: Number(ar[0].n), movements: Number(mv[0].n) };
      };
      const before = await countAll();
      let renamed = false;
      let r = null, s = null;
      try {
        await db.query('RENAME TABLE ar_document_line_components TO arlc_itest_bak');
        renamed = true;
        const sold = await sell([{ id: M_RECIPE, name: 'ITEST recipe', qty: 1, price: 46.0 }]);
        r = sold.r;
        s = await saleRow(sold.clientOrderId);
      } finally {
        if (renamed) await db.query('RENAME TABLE arlc_itest_bak TO ar_document_line_components');
      }
      const after = await countAll();
      check('checkout REJECTED when the projection cannot be written', r && r.status >= 500, r && r.status);
      check('no sale row survives the rollback', s === null, s && s.id);
      check('sales count unchanged', before.sales === after.sales, { before: before.sales, after: after.sales });
      check('no AR header survives the rollback', before.ar === after.ar, { before: before.ar, after: after.ar });
      check('inventory stock restored by the rollback', before.stock === after.stock,
        { before: before.stock, after: after.stock });
      check('no inventory_movements row survives the rollback',
        before.movements === after.movements, { before: before.movements, after: after.movements });
      // Prove the forced fault was the cause — not a broken fixture that would
      // have failed this checkout anyway.
      const ok = await sell([{ id: M_RECIPE, name: 'ITEST recipe', qty: 1, price: 46.0 }]);
      check('the SAME checkout succeeds once the fault is removed', ok.r.status === 200,
        { status: ok.r.status, data: ok.r.data });
    }

    // ── 7. the projected lines are actually returnable ──────────────────────
    // The whole point: SalesReturnService.create resolves the original by
    // source_type='pos' and reads net/vat/cost/base_qty off the snapshot.
    console.log('\n── returns against projected lines ──');
    {
      const { clientOrderId } = await sell([{ id: M_RECIPE, name: 'ITEST recipe', qty: 4, price: 46.0 }]);
      const s = await saleRow(clientOrderId);
      const { doc, lines } = await projected(s.id);
      check('sale is resolvable as a return original', !!doc && lines.length === 1);

      const SRS = require(path.join(ROOT, 'services', 'order-to-cash', 'SalesReturnService'));
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const partial = await SRS.create(conn, {
          originalSaleId: s.id, returnDate: new Date(),
          lines: [{ originalLineId: lines[0].id, returnQty: 1 }],
          reason: 'ITEST partial',
        }, 'itest');
        check('partial return (1 of 4) accepted', !!partial && !!partial.id);
        // 4 sold @ 184.00 total → 1 returned = a clean quarter.
        check('return amounts derive from the SNAPSHOT, proportionally',
          minor(partial.subtotal) === Math.round(minor(lines[0].net_amount) / 4)
          && minor(partial.vatAmount || partial.vat_amount || 0) === Math.round(minor(lines[0].vat_amount) / 4),
          { sub: partial.subtotal, vat: partial.vatAmount || partial.vat_amount, lineNet: lines[0].net_amount });
        check('return cost derives from the frozen cost_snapshot, not the live recipe',
          minor(partial.costTotal || partial.cost_total || 0) === Math.round(minor(lines[0].cost_snapshot) / 4),
          { cost: partial.costTotal || partial.cost_total, snapshot: lines[0].cost_snapshot });

        let over = null;
        try {
          await SRS.create(conn, {
            originalSaleId: s.id, returnDate: new Date(),
            lines: [{ originalLineId: lines[0].id, returnQty: 4 }],
            reason: 'ITEST over',
          }, 'itest');
        } catch (e) { over = e; }
        check('over-return rejected (1 already returned, 4 more exceeds 4 sold)',
          !!over && over.code === 'OVER_RETURN', over && (over.code || over.message));

        let dup = null;
        try {
          await SRS.create(conn, {
            originalSaleId: s.id, returnDate: new Date(),
            lines: [{ originalLineId: lines[0].id, returnQty: 3.5 }],
            reason: 'ITEST dup',
          }, 'itest');
        } catch (e) { dup = e; }
        check('returning the same line beyond its remaining qty is blocked',
          !!dup && dup.code === 'OVER_RETURN', dup && (dup.code || dup.message));

        const exact = await SRS.create(conn, {
          originalSaleId: s.id, returnDate: new Date(),
          lines: [{ originalLineId: lines[0].id, returnQty: 3 }],
          reason: 'ITEST exact',
        }, 'itest');
        check('the exact remaining qty (3) is still returnable', !!exact && !!exact.id);
        await conn.rollback(); // returns are a read-only probe here
      } finally {
        try { conn.release(); } catch (_) {}
      }
    }

    console.log(`\nPOS→O2C projection: ${_p} passed, ${_f} failed`);
    if (_f) console.log('FAILED:', _fails.join(' | '));
  } catch (e) {
    console.error('\n!!! harness error:', e && e.stack ? e.stack.slice(0, 900) : e);
    console.error('--- server log tail ---\n', log.slice(-1500));
    _f++;
  } finally {
    await cleanup();
    try { child.kill(); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  process.exit(_f ? 1 : 0);
}

main();
