'use strict';
/**
 * ─── warehouse-v2 PERFORMANCE suite (dedicated perf DB, report-only) ─────────
 *
 *   node scripts/perf/run-warehouse-v2.js            full run (provision → boot → seed → measure)
 *   PERF_DB_NAME=... PERF_PORT=... to override.
 *
 * What it does:
 *   1. CREATE DATABASE IF NOT EXISTS <perf db> (synthetic-only; NEVER the main DB).
 *   2. Boots server.js against it → also proves idempotent migrations on a fresh DB.
 *   3. Seeds the FULL spec (10 wh / 10k items / ~50k lots / 100k movements / 3k docs).
 *   4. Measures p50/p95 latency + response size for every core read surface,
 *      runs a concurrent-mutations burst, snapshots server memory.
 *   5. EXPLAINs the heavy queries (index-evidence for any tuning).
 *   6. Writes artifacts/warehouse-v2-perf-<stamp>.json + a console table.
 *
 * NEVER touches the primary DB_NAME. Exit 0 even if latencies are high — the
 * numbers are evidence for the perf report; thresholds are judged there.
 */
try { require('dotenv').config(); } catch (_) {}

const PERF_DB = process.env.PERF_DB_NAME || ((process.env.DB_NAME || 'moroccan_taste_pos') + '_perf');
const PORT = Number(process.env.PERF_PORT || 3210);
// Point THIS process's pool (db/connection) at the perf DB BEFORE any require.
process.env.DB_NAME = PERF_DB;

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const BASE = { host: '127.0.0.1', port: PORT };

function req(method, p, token, body, extraHeaders) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({ Accept: 'application/json' }, extraHeaders || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const t0 = process.hrtime.bigint();
    const r = http.request({ ...BASE, method, path: p, headers }, (resp) => {
      let bytes = 0; const chunks = [];
      resp.on('data', (c) => { bytes += c.length; chunks.push(c); });
      resp.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        resolve({ status: resp.statusCode, ms, bytes, body: j });
      });
    });
    r.on('error', (e) => resolve({ status: 0, ms: -1, bytes: 0, error: e.code || e.message }));
    r.setTimeout(60000, () => { r.destroy(); resolve({ status: 0, ms: -1, bytes: 0, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

function pct(sorted, p) { if (!sorted.length) return null; const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1); return Math.round(sorted[Math.max(0, i)] * 10) / 10; }

async function measure(name, method, p, token, opts) {
  opts = opts || {};
  const warm = opts.warm == null ? 2 : opts.warm;
  const n = opts.n == null ? 30 : opts.n;
  for (let i = 0; i < warm; i++) await req(method, p, token);
  const lat = []; let bytes = 0; let bad = 0;
  for (let i = 0; i < n; i++) {
    const r = await req(method, p, token);
    if (r.status !== 200) { bad++; continue; }
    lat.push(r.ms); bytes = r.bytes;
  }
  lat.sort((a, b) => a - b);
  const row = { name, path: p, n: lat.length, failed: bad, p50: pct(lat, 50), p95: pct(lat, 95), max: pct(lat, 100), bytes };
  console.log('  ' + (bad ? '⚠️ ' : '✅') + ' ' + name.padEnd(28) + ' p50=' + String(row.p50).padStart(7) + 'ms  p95=' + String(row.p95).padStart(7) + 'ms  size=' + (bytes / 1024).toFixed(1) + 'KB' + (bad ? '  failed=' + bad : ''));
  return row;
}

async function waitForServer(maxSec) {
  for (let i = 0; i < (maxSec || 240) * 2; i++) {
    const r = await req('GET', '/api/version');
    if (r.status === 200) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing (.env)'); process.exit(2); }
  console.log('\n═══ warehouse-v2 PERFORMANCE suite — DB=' + PERF_DB + ' PORT=' + PORT + ' ═══\n');

  // 1) provision the perf DB (never the primary)
  const admin = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
  await admin.query('CREATE DATABASE IF NOT EXISTS `' + PERF_DB + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await admin.end();
  console.log('  ✅ perf DB ready: ' + PERF_DB);

  // 2) boot the server against the perf DB (fresh-DB migration timing is itself a datapoint)
  const bootT0 = Date.now();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DB_NAME: PERF_DB, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', NODE_ENV: 'production' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const report = { generatedAt: new Date().toISOString(), db: PERF_DB, scale: null, bootSeconds: null, seedSeconds: null, endpoints: [], mutations: null, memory: null, bundles: [], explain: [] };
  try {
    if (!(await waitForServer(300))) { console.error('server did not start'); process.exit(2); }
    report.bootSeconds = Math.round((Date.now() - bootT0) / 100) / 10;
    console.log('  ✅ server up in ' + report.bootSeconds + 's (fresh-DB migrations included on first run)');

    // 3) seed (module shares this process's pool → perf DB)
    const db = require('../../db/connection');
    const { seed, SCALE } = require('./seed-warehouse-v2');
    const s = await seed({ db });
    report.scale = SCALE; report.seedSeconds = s.seconds || 0;
    if (!s.skipped) console.log('  ✅ seeded: ' + JSON.stringify(s.counts));
    else console.log('  ✅ seed present (idempotent skip)');

    // token AFTER seed (admin bypasses scope; scope stays ENFORCE=1 for realism)
    const token = jwt.sign({ id: 0, username: 'perf_admin', role: 'admin', isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: '2h' });
    const [[lot]] = await db.query("SELECT id FROM inventory_lots WHERE id LIKE 'PL-%' LIMIT 1");
    const lotId = lot ? lot.id : null;

    // 4) endpoint measurements
    console.log('\n─── endpoints (warm=2, n=30) ───');
    const E = report.endpoints;
    E.push(await measure('Dashboard summary', 'GET', '/api/inventory/warehouses-summary', token));
    E.push(await measure('Inventory grid (p1)', 'GET', '/api/inventory/grid?pageSize=50', token));
    E.push(await measure('Inventory grid (deep page)', 'GET', '/api/inventory/grid?pageSize=50&page=100', token));
    E.push(await measure('Analytics summary', 'GET', '/api/inventory/analytics/summary', token));
    E.push(await measure('Report: stock-balance', 'GET', '/api/inventory/reports/stock-balance', token));
    E.push(await measure('Transfers list', 'GET', '/api/inventory/transfers?pageSize=50', token));
    E.push(await measure('Replenishment', 'GET', '/api/inventory/v2/replenishment', token));
    E.push(await measure('Items list (p1)', 'GET', '/api/inventory/v2/items?pageSize=50', token));
    E.push(await measure('Lots list (p1)', 'GET', '/api/inventory/v2/lots?pageSize=50', token));
    E.push(await measure('Expiry board', 'GET', '/api/inventory/v2/expiry', token));
    E.push(await measure('Expiry summary', 'GET', '/api/inventory/v2/expiry/summary', token));
    if (lotId) E.push(await measure('Lot trace', 'GET', '/api/inventory/v2/lots/' + lotId + '/trace', token));
    E.push(await measure('Lot integrity (full scan)', 'GET', '/api/inventory/v2/lot-integrity', token, { n: 10 }));
    E.push(await measure('Receipts list', 'GET', '/api/inventory/v2/receipts?pageSize=50', token));

    // 5) concurrent mutations — 20 parallel lot creates (unique numbers + idem keys)
    console.log('\n─── concurrent mutations (20 × POST /v2/lots) ───');
    const [[item]] = await db.query("SELECT id FROM inv_items WHERE id LIKE 'PERF-ITEM-%' AND tracking_mode<>'none' LIMIT 1");
    const stamp = Date.now();
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      req('POST', '/api/inventory/v2/lots', token,
        { itemId: item.id, lotNumber: 'BURST-' + stamp + '-' + i, expiryDate: '2027-01-01' },
        { 'Idempotency-Key': 'perf-burst-' + stamp + '-' + i })));
    const okBurst = burst.filter((r) => r.status === 200 || r.status === 201).length;
    const burstLat = burst.map((r) => r.ms).sort((a, b) => a - b);
    report.mutations = { total: 20, ok: okBurst, p50: pct(burstLat, 50), p95: pct(burstLat, 95) };
    console.log('  ' + (okBurst === 20 ? '✅' : '⚠️ ') + ' ok=' + okBurst + '/20  p50=' + report.mutations.p50 + 'ms  p95=' + report.mutations.p95 + 'ms');

    // 6) memory snapshot
    const mem = await req('GET', '/api/metrics/json', token);
    report.memory = mem.body && mem.body.process ? { rss_mb: mem.body.process.memory_mb, heap_mb: mem.body.process.heap_used_mb } : null;
    console.log('\n  memory: ' + JSON.stringify(report.memory));

    // 7) React bundle sizes (gzip)
    const zlib = require('zlib');
    const assets = path.join(process.cwd(), 'frontend', 'warehouse', 'dist', 'assets');
    if (fs.existsSync(assets)) {
      for (const f of fs.readdirSync(assets)) {
        const buf = fs.readFileSync(path.join(assets, f));
        report.bundles.push({ file: f, rawKB: Math.round(buf.length / 1024), gzipKB: Math.round(zlib.gzipSync(buf).length / 1024) });
      }
      console.log('  bundles(gzip): ' + report.bundles.map((b) => b.file.split('-')[0] + '=' + b.gzipKB + 'KB').join(' · '));
    }

    // 8) EXPLAIN evidence for the heavy queries
    console.log('\n─── EXPLAIN (index evidence) ───');
    const explains = [
      ['lot-integrity aggregate', `SELECT ws.warehouse_id, ws.item_id, ws.qty,
          (SELECT COALESCE(SUM(b.qty),0) FROM warehouse_lot_balances b WHERE b.warehouse_id=ws.warehouse_id AND b.item_id=ws.item_id) AS lot_qty
        FROM warehouse_stock ws JOIN inv_items i ON i.id=ws.item_id WHERE i.tracking_mode <> 'none'`],
      ['expiry list (order by expiry)', `SELECT l.id, l.expiry_date, b.warehouse_id, b.qty FROM inventory_lots l
        JOIN warehouse_lot_balances b ON b.lot_id=l.id WHERE b.qty > 0 ORDER BY l.expiry_date ASC LIMIT 100`],
      ['grid page', 'SELECT ws.*, i.name FROM warehouse_stock ws JOIN inv_items i ON i.id=ws.item_id ORDER BY i.name LIMIT 50 OFFSET 5000'],
      ['movements by item', "SELECT * FROM inventory_movements WHERE item_id='PERF-ITEM-00001' ORDER BY movement_date DESC LIMIT 50"],
      ['lot trace movements', "SELECT * FROM inventory_lot_movements WHERE lot_id='" + (lotId || 'PL-0') + "' ORDER BY occurred_at"],
    ];
    for (const [name, sql] of explains) {
      try {
        const [rows] = await db.query('EXPLAIN ' + sql);
        const summary = rows.map((r) => ({ table: r.table, type: r.type, key: r.key, rows: r.rows, extra: r.Extra }));
        report.explain.push({ name, plan: summary });
        const scans = summary.filter((r) => r.type === 'ALL' && Number(r.rows) > 5000);
        console.log('  ' + (scans.length ? '⚠️ ' : '✅') + ' ' + name + ' → ' + summary.map((r) => r.table + ':' + r.type + (r.key ? '(' + r.key + ')' : '') + '~' + r.rows).join(' | '));
      } catch (e) { report.explain.push({ name, error: String(e.message).slice(0, 200) }); }
    }

    // 9) artifact
    const outDir = path.join(process.cwd(), 'artifacts');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    const out = path.join(outDir, 'warehouse-v2-perf-' + report.generatedAt.replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log('\n  JSON → ' + out + '\n');

    try { if (db.pool && db.pool.end) await db.pool.end(); } catch (_) {}
  } finally {
    try { server.kill(); } catch (_) {}
  }
  process.exit(0);
})().catch((e) => { console.error('PERF FAILED:', e); process.exit(1); });
