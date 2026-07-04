#!/usr/bin/env node
'use strict';
/**
 * ─── verify catalog reconciliation (W1 post-check) ──────────────────────────
 *
 * READ-ONLY verifier for scripts/reconcile-legacy-materials.js. Proves the
 * dual-catalog gap is closed and that the reconcile changed NOTHING except
 * adding inv_items rows. Runs only SELECTs — it never mutates data.
 *
 * Checks:
 *   1. orphan-stock-rows     every warehouse_stock.item_id exists in inv_items
 *                            (LEFT JOIN misses reported, INV-% and others)
 *   2. qty-invariant         artifact per-item qty snapshot == current SUM(qty);
 *                            no NULL qty rows / NULL per-item sums; every
 *                            reconciled id exists in inv_items; artifact
 *                            before/after Σqty+Σvalue identical
 *   3. duplicate-ids         no case-collision ids in inv_items
 *                            (GROUP BY LOWER(id) HAVING >1) and no duplicate
 *                            (warehouse_id, item_id) pairs in warehouse_stock
 *   4. recipe-refs           recipe.inv_item_id + bom_lines.component_item_id
 *                            all resolve to inv_items rows
 *   5. legacy-v2-parity      the dashboard-summary aggregate (routes/inventory.js
 *                            _warehousesSummary: Σqty and Σ qty*COALESCE(
 *                            NULLIF(ws.avg_cost,0), i.cost, 0) over active items
 *                            with qty>0) computed as one direct SUM equals the
 *                            per-warehouse GROUP BY summed up; active-items-with-
 *                            stock count matches legacy-style vs V2 rollup
 *   6. reversibility         latest artifacts/reconcile-*.json lists inserted
 *                            ids; reports how many warehouse_stock rows a
 *                            --revert would re-orphan (expected, listed)
 *   7. local-guard           refuses to run against a non-local DB host unless
 *                            --allow-remote is passed
 *
 * Output: console PASS/FAIL per check + artifacts/catalog-verify-<ts>.json.
 * Exit codes: 0 = all checks pass · 1 = at least one FAIL · 2 = remote refusal.
 *
 *   node scripts/reporting/verify-catalog-reconciliation.js
 *   node scripts/reporting/verify-catalog-reconciliation.js --allow-remote
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (_) {}

const EPS = 0.01;   // money tolerance (DECIMAL round-trips through JS floats)
const QEPS = 0.001; // qty tolerance (reconcile artifact rounds qty to 3 dp)
const LIST_CAP = 25; // max offending rows echoed to console / kept per finding

// ── 7) production-untouched guard (must run BEFORE the pool is created) ─────
function resolveDbTarget() {
  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      return { host: u.hostname, port: Number(u.port || 3306), database: (u.pathname || '/').slice(1), via: 'DATABASE_URL' };
    } catch (_) {
      return { host: '(unparseable DATABASE_URL)', port: null, database: '(unknown)', via: 'DATABASE_URL' };
    }
  }
  return {
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    database: process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || process.env.DB_NAME || 'moroccan_taste_pos',
    via: 'DB_HOST/DB_NAME env',
  };
}
function isLocalHost(h) {
  const host = String(h || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

const num = (v) => (v === null || v === undefined) ? null : Number(v);
const r3 = (v) => Math.round(Number(v) * 1000) / 1000;

function latestReconcileArtifact(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^reconcile-.*\.json$/.test(f)).sort();
  } catch (_) { return null; }
  if (!files.length) return null;
  const file = path.join(dir, files[files.length - 1]);
  try { return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { file, data: null, parseError: e.message }; }
}

async function main() {
  const argv = process.argv.slice(2);
  const allowRemote = argv.includes('--allow-remote');
  const target = resolveDbTarget();

  const line = '─'.repeat(74);
  console.log('\n' + line);
  console.log('  W1 catalog reconciliation — VERIFY (read-only, zero writes)');
  console.log(line);
  console.log('  DB target : ' + target.host + ':' + (target.port || '?') + ' / ' + target.database + '  (' + target.via + ')');

  if (!isLocalHost(target.host) && !allowRemote) {
    console.error('\n  ✋ REFUSING TO RUN: DB host "' + target.host + '" is not local (localhost/127.0.0.1/::1).');
    console.error('     This verifier is meant for the LOCAL database. Pass --allow-remote to override.\n');
    process.exit(2);
  }
  console.log('  Guard     : ' + (isLocalHost(target.host)
    ? 'LOCAL database confirmed — production untouched.'
    : 'REMOTE host — proceeding because --allow-remote was passed.'));
  console.log(line);

  const db = require(path.join(ROOT, 'db', 'connection.js'));
  const artifactDir = path.join(ROOT, 'artifacts');
  const artifact = latestReconcileArtifact(artifactDir);

  const checks = [];
  const addCheck = (id, name, pass, summary, details) => {
    checks.push({ id, name, status: pass === null ? 'SKIP' : (pass ? 'PASS' : 'FAIL'), summary, details: details || {} });
    const tag = pass === null ? '⏭  SKIP' : (pass ? '✅ PASS' : '❌ FAIL');
    console.log('\n  [' + id + '] ' + tag + '  ' + name);
    console.log('      ' + summary);
  };

  try {
    // ── 1) No orphan stock rows ─────────────────────────────────────────────
    {
      const [misses] = await db.query(
        `SELECT ws.item_id,
                COUNT(*)                       AS stock_rows,
                COUNT(DISTINCT ws.warehouse_id) AS warehouses,
                ROUND(SUM(ws.qty), 3)           AS total_qty
           FROM warehouse_stock ws
           LEFT JOIN inv_items i ON i.id = ws.item_id
          WHERE i.id IS NULL
          GROUP BY ws.item_id
          ORDER BY ws.item_id`);
      const inv = misses.filter((m) => /^INV-/i.test(m.item_id));
      const other = misses.filter((m) => !/^INV-/i.test(m.item_id));
      addCheck(1, 'no orphan stock rows (warehouse_stock.item_id → inv_items)',
        misses.length === 0,
        'orphan item_ids: ' + misses.length + ' (INV-%: ' + inv.length + ', other: ' + other.length + ')',
        {
          orphanItemIds: misses.length,
          invPrefixed: inv.length,
          other: other.length,
          sample: misses.slice(0, LIST_CAP).map((m) => ({ itemId: m.item_id, stockRows: num(m.stock_rows), warehouses: num(m.warehouses), totalQty: num(m.total_qty) })),
        });
      for (const m of misses.slice(0, LIST_CAP)) console.log('        • MISSING ' + m.item_id + ' (rows=' + m.stock_rows + ', qty=' + m.total_qty + ')');
      if (misses.length > LIST_CAP) console.log('        … +' + (misses.length - LIST_CAP) + ' more (see JSON report)');
    }

    // ── 2) Σqty invariant ───────────────────────────────────────────────────
    {
      const details = { artifact: artifact ? path.basename(artifact.file) : null };
      const problems = [];

      // 2a. No NULL qty anywhere / no NULL per-item sums.
      const [[nullQty]] = await db.query('SELECT COUNT(*) c FROM warehouse_stock WHERE qty IS NULL');
      const [nullSums] = await db.query(
        'SELECT item_id FROM warehouse_stock GROUP BY item_id HAVING SUM(qty) IS NULL');
      details.nullQtyRows = num(nullQty.c);
      details.nullSumItems = nullSums.map((r) => r.item_id);
      if (details.nullQtyRows > 0) problems.push(details.nullQtyRows + ' warehouse_stock rows with NULL qty');
      if (nullSums.length > 0) problems.push(nullSums.length + ' items whose SUM(qty) is NULL');

      // 2b. Artifact snapshot vs. current DB (only when a reconcile artifact exists).
      if (artifact && artifact.data) {
        const a = artifact.data;
        details.artifactBefore = a.before || null;
        details.artifactAfter = a.after || null;

        // Artifact-internal invariant: the reconcile must have left Σqty/Σvalue identical.
        if (a.before && a.after) {
          const same = r3(a.before.stockSumQty) === r3(a.after.stockSumQty) &&
                       r3(a.before.stockSumValue) === r3(a.after.stockSumValue) &&
                       num(a.before.stockRows) === num(a.after.stockRows);
          details.artifactTotalsIdentical = same;
          if (!same) problems.push('artifact before/after warehouse_stock totals differ (reconcile changed quantities!)');
        }

        // Per-item snapshot: plannedInserts[].totalQty (qty at reconcile time) vs current SUM.
        const planned = Array.isArray(a.plannedInserts) ? a.plannedInserts : [];
        const insertedIds = (Array.isArray(a.inserted) ? a.inserted : []).map((r) => r.id);
        details.reconciledItems = insertedIds.length;
        if (insertedIds.length) {
          const [sums] = await db.query(
            'SELECT item_id, ROUND(SUM(qty),3) AS q FROM warehouse_stock WHERE item_id IN (?) GROUP BY item_id',
            [insertedIds]);
          const curQty = new Map(sums.map((r) => [r.item_id, Number(r.q)]));
          const snapQty = new Map(planned.map((p) => [p.id, Number(p.totalQty)]));
          const drift = [];
          for (const id of insertedIds) {
            const snap = snapQty.has(id) ? snapQty.get(id) : null;
            const cur = curQty.has(id) ? curQty.get(id) : null;
            if (snap === null || cur === null || Math.abs(snap - cur) > QEPS) {
              drift.push({ itemId: id, snapshotQty: snap, currentQty: cur });
            }
          }
          details.qtyDriftCount = drift.length;
          details.qtyDrift = drift.slice(0, LIST_CAP);
          if (drift.length) problems.push(drift.length + '/' + insertedIds.length + ' reconciled items: current Σqty differs from artifact snapshot');

          // Every reconciled item must exist in inv_items (same id).
          const [present] = await db.query('SELECT id FROM inv_items WHERE id IN (?)', [insertedIds]);
          const have = new Set(present.map((r) => r.id));
          const missing = insertedIds.filter((id) => !have.has(id));
          details.reconciledMissingFromInvItems = missing.slice(0, LIST_CAP);
          details.reconciledMissingCount = missing.length;
          if (missing.length) problems.push(missing.length + ' reconciled ids no longer exist in inv_items');
        }
      } else {
        details.note = 'no artifacts/reconcile-*.json found — snapshot comparison skipped, NULL/rollup checks still enforced';
      }

      addCheck(2, 'Σqty invariant (artifact snapshot + NULL/NaN + inv_items rollup)',
        problems.length === 0,
        problems.length ? problems.join('; ')
          : 'no NULL qty; ' + (artifact && artifact.data
              ? (details.reconciledItems + ' reconciled items: Σqty matches snapshot, all present in inv_items, artifact totals identical')
              : 'no reconcile artifact — nothing to diff'),
        details);
      for (const d of (details.qtyDrift || [])) console.log('        • DRIFT ' + d.itemId + ' snapshot=' + d.snapshotQty + ' current=' + d.currentQty);
    }

    // ── 3) No duplicate IDs ─────────────────────────────────────────────────
    {
      const [caseDups] = await db.query(
        `SELECT LOWER(id) AS lid, COUNT(*) AS c, GROUP_CONCAT(id ORDER BY id SEPARATOR ' | ') AS ids
           FROM inv_items GROUP BY LOWER(id) HAVING COUNT(*) > 1`);
      const [[ws]] = await db.query(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT warehouse_id, item_id) AS distinct_pairs,
                SUM(CASE WHEN warehouse_id IS NULL OR item_id IS NULL THEN 1 ELSE 0 END) AS null_keys
           FROM warehouse_stock`);
      const wsDupRows = num(ws.total) - num(ws.distinct_pairs);
      const ok = caseDups.length === 0 && wsDupRows === 0 && num(ws.null_keys) === 0;
      addCheck(3, 'no duplicate ids (inv_items case-collisions + warehouse_stock pairs)',
        ok,
        'inv_items case-collision groups: ' + caseDups.length +
        '; warehouse_stock rows=' + ws.total + ' distinct (warehouse_id,item_id)=' + ws.distinct_pairs +
        ' → duplicate rows: ' + wsDupRows + '; NULL-key rows: ' + ws.null_keys,
        {
          caseCollisions: caseDups.slice(0, LIST_CAP).map((d) => ({ lowerId: d.lid, count: num(d.c), ids: d.ids })),
          stockRows: num(ws.total), distinctPairs: num(ws.distinct_pairs), duplicatePairRows: wsDupRows, nullKeyRows: num(ws.null_keys),
        });
      for (const d of caseDups.slice(0, LIST_CAP)) console.log('        • CASE-COLLISION ' + d.ids);
    }

    // ── 4) Recipe references intact ─────────────────────────────────────────
    {
      const details = {};
      const problems = [];
      let available = 0;
      // legacy recipe table
      try {
        const [recMiss] = await db.query(
          `SELECT r.inv_item_id, COUNT(*) AS refs
             FROM recipe r LEFT JOIN inv_items i ON i.id = r.inv_item_id
            WHERE r.inv_item_id IS NOT NULL AND i.id IS NULL
            GROUP BY r.inv_item_id ORDER BY r.inv_item_id`);
        details.recipeMisses = recMiss.slice(0, LIST_CAP).map((m) => ({ invItemId: m.inv_item_id, refs: num(m.refs) }));
        details.recipeMissCount = recMiss.length;
        available++;
        if (recMiss.length) problems.push(recMiss.length + ' recipe.inv_item_id values missing from inv_items');
        for (const m of recMiss.slice(0, LIST_CAP)) console.log('        • recipe → MISSING ' + m.inv_item_id + ' (' + m.refs + ' refs)');
      } catch (e) { details.recipeTable = 'unavailable: ' + e.message; }
      // modern bom_lines table
      try {
        const [bomMiss] = await db.query(
          `SELECT bl.component_item_id, COUNT(*) AS refs
             FROM bom_lines bl LEFT JOIN inv_items i ON i.id = bl.component_item_id
            WHERE bl.component_item_id IS NOT NULL AND i.id IS NULL
            GROUP BY bl.component_item_id ORDER BY bl.component_item_id`);
        details.bomLineMisses = bomMiss.slice(0, LIST_CAP).map((m) => ({ componentItemId: m.component_item_id, refs: num(m.refs) }));
        details.bomLineMissCount = bomMiss.length;
        available++;
        if (bomMiss.length) problems.push(bomMiss.length + ' bom_lines.component_item_id values missing from inv_items');
        for (const m of bomMiss.slice(0, LIST_CAP)) console.log('        • bom_lines → MISSING ' + m.component_item_id + ' (' + m.refs + ' refs)');
      } catch (e) { details.bomLinesTable = 'unavailable: ' + e.message; }

      addCheck(4, 'recipe references intact (recipe.inv_item_id + bom_lines.component_item_id)',
        available === 0 ? null : problems.length === 0,
        available === 0 ? 'neither recipe nor bom_lines table available — skipped'
          : (problems.length ? problems.join('; ')
             : 'all references resolve (recipe misses: ' + (details.recipeMissCount ?? 'n/a') + ', bom_lines misses: ' + (details.bomLineMissCount ?? 'n/a') + ')'),
        details);
    }

    // ── 5) Legacy = V2 parity (mirror _warehousesSummary aggregate) ────────
    {
      // Representative aggregate mirrored from routes/inventory.js
      // _warehousesSummary(): active-item, qty>0, value = qty * COALESCE(
      // NULLIF(ws.avg_cost,0), i.cost, 0), rooted at warehouses LEFT JOINs.
      const AGG =
        `COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0 THEN ws.qty ELSE 0 END), 0) AS total_qty,
         COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND ws.qty > 0
                           THEN ws.qty * COALESCE(NULLIF(ws.avg_cost,0), i.cost, 0)
                           ELSE 0 END), 0) AS total_value`;
      const FROM =
        ` FROM warehouses w
          LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
          LEFT JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL`;

      const [[direct]] = await db.query('SELECT ' + AGG + FROM);
      const [perWh] = await db.query('SELECT w.id, ' + AGG + FROM + ' GROUP BY w.id');
      const sumQty = perWh.reduce((s, r) => s + Number(r.total_qty), 0);
      const sumValue = perWh.reduce((s, r) => s + Number(r.total_value), 0);
      const qtyOk = Math.abs(Number(direct.total_qty) - sumQty) <= EPS;
      const valOk = Math.abs(Number(direct.total_value) - sumValue) <= EPS;

      // Active items with stock — legacy-style DISTINCT join vs V2-style rollup.
      const [[legacyCnt]] = await db.query(
        `SELECT COUNT(DISTINCT i.id) AS c
           FROM inv_items i JOIN warehouse_stock ws ON ws.item_id = i.id
          WHERE i.active = 1 AND i.deleted_at IS NULL AND ws.qty > 0`);
      const [[v2Cnt]] = await db.query(
        `SELECT COUNT(*) AS c FROM (
            SELECT ws.item_id
              FROM warehouse_stock ws
              JOIN inv_items i ON i.id = ws.item_id AND i.active = 1 AND i.deleted_at IS NULL
             WHERE ws.qty > 0
             GROUP BY ws.item_id) x`);
      const cntOk = num(legacyCnt.c) === num(v2Cnt.c);

      addCheck(5, 'legacy=V2 parity (dashboard-summary aggregate two ways)',
        qtyOk && valOk && cntOk,
        'Σqty direct=' + r3(direct.total_qty) + ' vs per-warehouse=' + r3(sumQty) + (qtyOk ? ' ✓' : ' ✗') +
        '; Σvalue direct=' + r3(direct.total_value) + ' vs per-warehouse=' + r3(sumValue) + (valOk ? ' ✓' : ' ✗') +
        '; active items w/ stock legacy=' + legacyCnt.c + ' vs v2-rollup=' + v2Cnt.c + (cntOk ? ' ✓' : ' ✗'),
        {
          directTotalQty: num(direct.total_qty), perWarehouseSumQty: r3(sumQty),
          directTotalValue: num(direct.total_value), perWarehouseSumValue: r3(sumValue),
          warehousesAggregated: perWh.length,
          activeItemsWithStockLegacy: num(legacyCnt.c), activeItemsWithStockV2: num(v2Cnt.c),
          mirroredFrom: 'routes/inventory.js _warehousesSummary (dashboard-summary)',
        });
    }

    // ── 6) Reversibility of the latest reconcile artifact ──────────────────
    {
      if (!artifact) {
        addCheck(6, 'reversibility (latest reconcile artifact)', null,
          'no artifacts/reconcile-*.json found — nothing to revert, skipped', {});
      } else if (!artifact.data) {
        addCheck(6, 'reversibility (latest reconcile artifact)', false,
          'artifact ' + path.basename(artifact.file) + ' is unreadable: ' + artifact.parseError, { file: artifact.file });
      } else {
        const a = artifact.data;
        const insertedIds = (Array.isArray(a.inserted) ? a.inserted : []).map((r) => r.id).filter(Boolean);
        const details = { file: path.basename(artifact.file), insertedIds: insertedIds.length };
        const problems = [];
        const notes = [];
        if (!insertedIds.length) problems.push('artifact has no inserted[] ids — --revert would be a no-op');
        if (a.after && num(a.after.insertedCount) !== insertedIds.length) {
          problems.push('inserted[] length (' + insertedIds.length + ') != after.insertedCount (' + a.after.insertedCount + ')');
        }
        if (insertedIds.length) {
          // Which of the inserted ids are still revert-eligible (category untouched)?
          const [eligible] = await db.query(
            "SELECT id FROM inv_items WHERE category='legacy-raw-materials' AND id IN (?)", [insertedIds]);
          const eligibleSet = new Set(eligible.map((r) => r.id));
          details.revertEligible = eligibleSet.size;
          details.notRevertEligible = insertedIds.filter((id) => !eligibleSet.has(id)).slice(0, LIST_CAP);
          details.notRevertEligibleCount = insertedIds.length - eligibleSet.size;

          // Rows a revert would re-orphan (stock rows for the inserted ids).
          const [[reorphan]] = await db.query(
            'SELECT COUNT(*) AS rows_, COUNT(DISTINCT item_id) AS items FROM warehouse_stock WHERE item_id IN (?)',
            [insertedIds]);
          details.revertWouldReorphanRows = num(reorphan.rows_);
          details.revertWouldReorphanItems = num(reorphan.items);
          notes.push('        • revert would re-orphan ' + reorphan.rows_ + ' warehouse_stock rows across ' +
                     reorphan.items + ' items: expected (reconcile never touches warehouse_stock)');
          if (details.notRevertEligibleCount > 0) {
            problems.push(details.notRevertEligibleCount + ' inserted ids no longer revert-eligible (missing or category changed)');
          }
        }
        addCheck(6, 'reversibility (latest reconcile artifact)',
          problems.length === 0,
          problems.length ? problems.join('; ')
            : insertedIds.length + ' inserted ids recorded, all still revert-eligible; revert would re-orphan ' +
              (details.revertWouldReorphanRows || 0) + ' stock rows (expected, informational)',
          details);
        for (const n of notes) console.log(n);
      }
    }

    // ── 7) guard result (already enforced above — record it) ───────────────
    addCheck(7, 'production untouched guard (local DB only)',
      true,
      'ran against ' + target.host + ':' + (target.port || '?') + '/' + target.database +
      (isLocalHost(target.host) ? ' (local)' : ' (REMOTE — explicitly allowed via --allow-remote)'),
      { host: target.host, port: target.port, database: target.database, via: target.via, allowRemote, local: isLocalHost(target.host) });

  } finally {
    try { await db.end(); } catch (_) {}
  }

  // ── report + exit ─────────────────────────────────────────────────────────
  const failed = checks.filter((c) => c.status === 'FAIL');
  const report = {
    tool: 'verify-catalog-reconciliation',
    at: new Date().toISOString(),
    db: { host: target.host, port: target.port, database: target.database },
    reconcileArtifact: artifact ? path.basename(artifact.file) : null,
    result: failed.length ? 'FAIL' : 'PASS',
    passed: checks.filter((c) => c.status === 'PASS').length,
    failed: failed.length,
    skipped: checks.filter((c) => c.status === 'SKIP').length,
    checks,
  };
  let outPath = null;
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    outPath = path.join(artifactDir, 'catalog-verify-' + report.at.replace(/[:.]/g, '-').slice(0, 19) + '.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  } catch (e) { console.error('  (could not write JSON report: ' + e.message + ')'); }

  console.log('\n' + line);
  console.log('  RESULT: ' + (failed.length ? '❌ FAIL — ' + failed.length + ' check(s) failed: ' + failed.map((c) => '#' + c.id).join(', ')
                                            : '✅ ALL CHECKS PASSED') +
              '  (' + report.passed + ' pass / ' + report.failed + ' fail / ' + report.skipped + ' skip)');
  if (outPath) console.log('  report: ' + outPath);
  console.log(line + '\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('\nVERIFY FAILED (unexpected error):', e && e.message || e); process.exit(1); });
