/* Integration — component `source` enum honesty (DB only, no server needed).
 *
 * 'semi' shipped in source ENUM('recipe','semi','imported','combo') on BOTH
 * component tables and was dead on arrival: no writer ever emitted it (the
 * checkout projects recipe/combo/imported; the legacy semi branch `continue`s
 * before any component write), no reader branches on it, and no row has ever
 * held it. The v7.1 boot migration converts consumes_semi_id pointers into
 * ordinary recipe rows, so the MODERN path for a semi-finished item is already
 * source='recipe'. A dead enum member is a promise the code doesn't keep —
 * this suite pins the honest value set.
 *
 * Run: node tests/integration/componentSource.test.js   (MySQL must be up)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../../db/connection');

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); } }

const TABLES = ['ar_document_line_components', 'sales_return_line_components'];
const ACCEPTED = ['recipe', 'imported', 'combo'];
const PFX = 'ITEST-CSRC-';

async function cleanup() {
  for (const t of TABLES) await db.query(`DELETE FROM ${t} WHERE id LIKE ?`, [PFX + '%']).catch(() => {});
}

(async () => {
  await require('../../db/migrations/order-to-cash/schema').apply(db);
  await cleanup();
  try {
    // ── the schema is honest: the dead member is gone, live ──────────────────
    console.log('▶ schema');
    for (const t of TABLES) {
      const [c] = await db.query(
        "SELECT COLUMN_TYPE ct FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='source'", [t]);
      check(`${t}.source no longer offers 'semi'`, c.length === 1 && !/semi/.test(c[0].ct), c[0] && c[0].ct);
      check(`  …and still offers recipe/imported/combo`, ACCEPTED.every((v) => c[0].ct.includes(`'${v}'`)), c[0] && c[0].ct);
    }

    // ── every accepted value round-trips; unknown values are refused LOUDLY ──
    console.log('\n▶ values');
    const ins = {
      ar_document_line_components:
        `INSERT INTO ar_document_line_components (id, document_id, document_line_id, component_seq, source, inv_item_id, deducted_base_qty, unit_cost_snapshot, total_cost)
         VALUES (?,?,?,?,?,?,1,1,1)`,
      sales_return_line_components:
        `INSERT INTO sales_return_line_components (id, return_id, return_line_id, component_seq, source, inv_item_id, restored_base_qty, unit_cost_snapshot, total_cost)
         VALUES (?,?,?,?,?,?,1,1,1)`,
    };
    for (const t of TABLES) {
      for (let i = 0; i < ACCEPTED.length; i++) {
        const v = ACCEPTED[i];
        let ok = true, got = null;
        try {
          await db.query(ins[t], [PFX + t.slice(0, 4) + '-' + v, PFX + 'DOC', PFX + 'LINE-' + v, i + 1, v, PFX + 'ITEM']);
          const [r] = await db.query(`SELECT source FROM ${t} WHERE id = ?`, [PFX + t.slice(0, 4) + '-' + v]);
          got = r[0] && r[0].source;
        } catch (e) { ok = false; got = e.code; }
        check(`${t}: '${v}' inserts and reads back verbatim`, ok && got === v, got);
      }
      for (const bad of ['semi', 'garbage']) {
        let rejected = false, how = null;
        try { await db.query(ins[t], [PFX + t.slice(0, 4) + '-bad-' + bad, PFX + 'DOC', PFX + 'LINE-bad', 99, bad, PFX + 'ITEM']); }
        catch (e) { rejected = true; how = e.code; }
        check(`${t}: '${bad}' is REJECTED loudly (not truncated to something else)`, rejected, how || 'insert succeeded');
      }
    }

    // ── no writer emits 'semi' — the code matches the schema ────────────────
    console.log('\n▶ writers');
    const roots = ['routes', 'services', 'lib'];
    const hits = [];
    const scan = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { if (f.name !== 'node_modules') scan(p); continue; }
        if (!f.name.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        // a writer would look like  source: 'semi'  /  source = 'semi'  /  ,'semi',
        if (/source\s*[:=]\s*['"]semi['"]/.test(src)) hits.push(p);
      }
    };
    for (const r of roots) scan(path.join(__dirname, '..', '..', r));
    check("no backend writer assigns source 'semi'", hits.length === 0, hits);
  } finally {
    await cleanup();
    await db.end();
  }

  console.log(`\n${fail ? '❌' : '✅'} componentSource: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
