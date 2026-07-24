/**
 * services/analytics/ExportService.js — async CSV/XLSX exports of analytics
 * queries (export_jobs table, Wave 3).
 *
 * LIFECYCLE
 *   createJob   — validates format + the analytics.export capability + the
 *                 request itself (a dry planner pass, so a bad request fails
 *                 at CREATE time with the same 422 codes the query route
 *                 uses, not hours later inside a worker), inserts a `queued`
 *                 export_jobs row and audits it. Nothing is executed here.
 *   runPending  — claims queued jobs (status-guarded UPDATE, safe under
 *                 concurrent workers), RE-RESOLVES the owner's scope+caps at
 *                 run time (grants may have changed since create — a revoked
 *                 user's job fails with PERMISSION_REVOKED, it never runs on
 *                 the frozen create-time scope), pages the query, writes the
 *                 file under uploads/exports/, and marks done/failed. NEVER
 *                 throws — a worker loop must survive any single bad job.
 *
 * PAGINATION HONESTY
 *   The planner clamps `limit` to planner.MAX_LIMIT (500) and — more
 *   fundamentally — fetches at most `fetchN` (= MAX_LIMIT) rows PER FACT
 *   before the cross-fact merge, so rows beyond that cap are unreachable no
 *   matter the offset. The export therefore pages in MAX_LIMIT chunks up to
 *   HARD_ROW_CAP and, whenever a page reports rowCountCapped (or the hard cap
 *   trips), records `truncated` in the file's metadata block and keeps
 *   row_count at what was actually written. The spec's "10k chunks" is not
 *   achievable through QueryService today; this is the honest equivalent.
 *
 * FILES
 *   uploads/exports/<jobId>.<csv|xlsx>, dir created on demand. The DB stores
 *   the RELATIVE path (portable across deploy roots); download resolves it
 *   against the repo root. CSV = BOM + '# ' metadata preamble + the
 *   O2C toCsv body (formula-injection guard + quoting live there — one CSV
 *   contract for the whole codebase). XLSX = lazy require('xlsx') (only
 *   loaded when an xlsx job actually runs), 'data' + 'metadata' sheets.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const QueryService = require('./QueryService');
const planner = require('../../lib/analytics/planner');
const scopeLib = require('../../lib/analytics/scope');
const METRICS = require('../../lib/analytics/registry/metrics');
const { toCsv } = require('../../lib/order-to-cash/http');
const AuditService = require('../AuditService');

const EXPORT_DIR_REL = path.join('uploads', 'exports');
const ROOT = path.join(__dirname, '..', '..');
const HARD_ROW_CAP = 100000;
const FORMATS = new Set(['csv', 'xlsx']);

// ── small helpers ────────────────────────────────────────────────────────────

function err(code, http, message) {
  const e = new Error(message);
  e.code = code;
  e.http = http;
  return e;
}

/** Key-order-independent stringify (same contract as QueryService's). */
function stableStringify(v) {
  if (v === undefined || v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** sha256 of the sorted branch+caps identity (scopeLib.scopeHash is already
 *  sorted + stable) — fits the VARCHAR(64) export_jobs.scope_hash column. */
function scopeHashOf(scope) {
  return crypto.createHash('sha256')
    .update(scopeLib.scopeHash(scope))
    .digest('hex');
}

/** Short stable fingerprint of every metric id:version pair (VARCHAR(20)). */
function definitionsVersion() {
  const pairs = METRICS.METRICS.map((m) => `${m.id}:${m.version}`).sort().join(',');
  return 'r' + crypto.createHash('sha256').update(pairs).digest('hex').slice(0, 12);
}

function genId() {
  return 'EXP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function isAdminScope(scope) {
  return !!(scope && scope.all);
}

function exportDirAbs() {
  return path.join(ROOT, EXPORT_DIR_REL);
}

function ensureExportDir() {
  fs.mkdirSync(exportDirAbs(), { recursive: true });
}

/** Global meal-period rows, loaded only when the request references the dim
 *  (mirrors QueryService.run's conditional load). */
async function loadMealPeriods(db, request) {
  const needs =
    (Array.isArray(request && request.dimensions) && request.dimensions.includes('meal_period')) ||
    (Array.isArray(request && request.filters) && request.filters.some((f) => f && f.dimension === 'meal_period'));
  if (!needs) return null;
  const [rows] = await db.query(
    'SELECT period_key, start_time, end_time, sort FROM analytics_meal_periods WHERE branch_id IS NULL ORDER BY sort, period_key');
  return rows.map((r) => ({
    period_key: String(r.period_key),
    start_time: String(r.start_time),
    end_time: String(r.end_time),
    sort: Number(r.sort) || 0,
  }));
}

// ── createJob ────────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} p { user, scope, request, format, ip? }
 * @returns {Promise<{id:string, status:'queued'}>}
 */
async function createJob(db, { user, scope, request, format, ip }) {
  const fmt = String(format || 'csv').toLowerCase();
  if (!FORMATS.has(fmt)) {
    throw err('VALIDATION_ERROR', 422, 'format يجب أن يكون csv أو xlsx');
  }
  if (!scope || !scope.caps || !scope.caps.has('analytics.export')) {
    throw err('PERMISSION_DENIED', 403, 'صلاحية غير كافية لتصدير التقارير (analytics.export)');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw err('VALIDATION_ERROR', 422, 'request يجب أن يكون JSON object (عقد الاستعلام نفسه)');
  }

  // Dry planner pass — same validation surface as POST /query, no execution.
  // Throws the canonical 422/403 errors (unknown metric, too-wide range, …).
  // meal_period plans only WITH the config rows (same conditional load as
  // QueryService.run — passing null would 422 a perfectly valid request).
  planner.plan(request, scope, { mealPeriods: await loadMealPeriods(db, request) });

  const id = genId();
  await db.query(
    `INSERT INTO export_jobs
       (id, username, request_json, format, status, definitions_version, scope_hash, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, NOW())`,
    [id, user.username, stableStringify(request), fmt, definitionsVersion(), scopeHashOf(scope)]
  );

  await AuditService.record({
    action: 'analytics.export.create',
    resourceType: 'export_job',
    resourceId: id,
    actor: user.username,
    details: { format: fmt, metrics: request.metrics, dimensions: request.dimensions, range: request.range },
    ip: ip || '',
  });

  return { id, status: 'queued' };
}

// ── run-time scope re-resolution ─────────────────────────────────────────────

/** Load the job owner's CURRENT user row (id/role drive scope + caps). */
async function loadUserRow(db, username) {
  let rows;
  try {
    [rows] = await db.query(
      'SELECT id, username, role, active, is_developer FROM users WHERE username = ?', [username]);
  } catch (_) {
    // older schemas without is_developer
    [rows] = await db.query(
      'SELECT id, username, role, active FROM users WHERE username = ?', [username]);
  }
  if (!rows.length) return null;
  const u = rows[0];
  if (u.active != null && !Number(u.active)) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    isDeveloper: !!u.is_developer || u.username === 'admin' || String(u.role) === 'developer',
  };
}

// ── query paging + flattening ────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Execute the stored request in planner-sized pages.
 * Returns { columns, dims, metricIds, flatRows, truncated, lastIncludedAt }.
 */
async function collectRows(db, request, scope) {
  const chunk = planner.MAX_LIMIT; // 500 — anything larger is clamped anyway
  let offset = 0;
  let first = null;
  const rows = [];
  let truncated = false;

  for (;;) {
    const pageReq = Object.assign({}, request, { limit: chunk, offset, noCache: true });
    const env = await QueryService.run(db, pageReq, scope);
    if (!first) first = env;
    const page = env.data.rows || [];
    rows.push(...page);
    if (env.data.page && env.data.page.rowCountCapped) truncated = true;
    if (page.length < chunk) break;
    offset += chunk;
    if (rows.length >= HARD_ROW_CAP) { truncated = true; break; }
  }

  const dims = (first.data.columns || []).filter((c) => c.type === 'dimension').map((c) => c.key);
  const metricIds = (first.data.columns || []).filter((c) => c.type === 'metric').map((c) => c.key);

  // Dimensionless request → one totals row is the whole export.
  if (!dims.length && !rows.length) {
    rows.push({ keys: {}, labels: {}, values: (first.data.totals && first.data.totals.values) || {} });
  }

  // label columns only for dims that actually carry labels somewhere
  const labeledDims = new Set();
  for (const r of rows) {
    if (!r.labels) continue;
    for (const d of dims) if (r.labels[d] != null) labeledDims.add(d);
  }

  const columns = [];
  for (const d of dims) {
    columns.push({ key: d, label: d });
    if (labeledDims.has(d)) columns.push({ key: d + '_label', label: d + '_name' });
  }
  for (const m of metricIds) columns.push({ key: m, label: m });

  const flatRows = rows.map((r) => {
    const out = {};
    for (const d of dims) {
      out[d] = r.keys ? r.keys[d] : null;
      if (labeledDims.has(d)) out[d + '_label'] = r.labels && r.labels[d] != null ? r.labels[d] : '';
    }
    for (const m of metricIds) out[m] = r.values ? r.values[m] : null;
    return out;
  });

  // last_included_at = the max calendar/business day present in the RESULT;
  // when no date dimension was requested, fall back to the request range end
  // (the honest upper bound of what the export can contain).
  let maxDay = null;
  for (const r of rows) {
    if (!r.keys) continue;
    for (const d of dims) {
      const v = r.keys[d];
      if (typeof v === 'string' && DAY_RE.test(v) && (!maxDay || v > maxDay)) maxDay = v;
    }
  }
  const rangeTo = request && request.range && request.range.to ? String(request.range.to) : null;
  const lastIncludedAt = maxDay
    ? maxDay + ' 23:59:59'
    : (rangeTo && DAY_RE.test(rangeTo) ? rangeTo + ' 23:59:59' : null);

  return { columns, dims, metricIds, flatRows, truncated, lastIncludedAt };
}

/** The metadata block — shared verbatim by the CSV preamble + xlsx sheet. */
function metadataPairs(job, request, collected) {
  const eqKeys = collected.metricIds.map((id) => {
    const m = METRICS.byId[id];
    return m ? `${id}=${m.equationKey}(v${m.version})` : id;
  });
  const pairs = [
    ['export_id', job.id],
    ['generated_at', new Date().toISOString()],
    ['range', `${request.range ? request.range.from : ''}..${request.range ? request.range.to : ''}`],
    ['date_basis', request.dateBasis || 'business_day (default)'],
    ['filters', stableStringify(request.filters || [])],
    ['timezone', 'Asia/Riyadh (+03:00 DB session; business days per branch tz)'],
    ['definitions_version', definitionsVersion()],
    ['metric_equations', eqKeys.join('; ')],
    ['last_included_at', collected.lastIncludedAt || ''],
    ['row_count', String(collected.flatRows.length)],
  ];
  if (collected.truncated) {
    pairs.push(['truncated', `true — result capped (planner per-fact fetch cap ${planner.MAX_LIMIT} rows, hard cap ${HARD_ROW_CAP})`]);
  }
  return pairs;
}

function writeCsvFile(absPath, pairs, flatRows, columns) {
  const preamble = pairs.map(([k, v]) => `# ${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`).join('\r\n');
  // toCsv already leads with a BOM; the BOM must be the FIRST byte of the
  // file, so strip it off the body and re-emit it ahead of the preamble.
  const body = toCsv(flatRows, columns).replace(/^﻿/, '');
  fs.writeFileSync(absPath, '﻿' + preamble + '\r\n' + body, 'utf8');
}

function writeXlsxFile(absPath, pairs, flatRows, columns) {
  // Lazy: xlsx is only loaded when an xlsx job actually runs.
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const header = columns.map((c) => c.label);
  const aoa = [header, ...flatRows.map((r) => columns.map((c) => {
    const v = r[c.key];
    // same formula-injection stance as the CSV path: neutralize leading = + - @
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return "'" + v;
    return v == null ? '' : v;
  }))];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'data');
  XLSX.utils.book_append_sheet(
    wb, XLSX.utils.aoa_to_sheet([['key', 'value'], ...pairs]), 'metadata');
  XLSX.writeFile(wb, absPath);
}

// ── runPendingExports ────────────────────────────────────────────────────────

/**
 * Claim + execute up to `limit` queued jobs. Never throws.
 * @returns {Promise<{claimed:number, done:string[], failed:Array<{id,error}>}>}
 */
async function runPendingExports(db, { limit = 2 } = {}) {
  const summary = { claimed: 0, done: [], failed: [] };
  let candidates = [];
  try {
    [candidates] = await db.query(
      "SELECT id FROM export_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT " +
      Math.max(1, Math.min(20, Number(limit) || 2)));
  } catch (e) {
    console.error('[analytics/export] queue scan failed:', e.message);
    return summary;
  }

  for (const c of candidates) {
    let job = null;
    try {
      // claim — guarded by affectedRows so two workers never run the same job
      const [claim] = await db.query(
        "UPDATE export_jobs SET status = 'running', started_at = NOW() WHERE id = ? AND status = 'queued'",
        [c.id]);
      if (!claim.affectedRows) continue;
      summary.claimed++;

      const [rows] = await db.query('SELECT * FROM export_jobs WHERE id = ?', [c.id]);
      if (!rows.length) continue;
      job = rows[0];

      // ── run-time re-authorization (the create-time scope is NOT trusted) ──
      const user = await loadUserRow(db, job.username);
      if (!user) throw err('PERMISSION_REVOKED', 403, 'PERMISSION_REVOKED: user missing or inactive');
      const scope = await scopeLib.resolveScope(db, user);
      if (!scope.caps.has('analytics.view') || !scope.caps.has('analytics.export')) {
        throw err('PERMISSION_REVOKED', 403, 'PERMISSION_REVOKED: analytics.export no longer granted');
      }

      const request = JSON.parse(job.request_json || '{}');
      const collected = await collectRows(db, request, scope);
      const pairs = metadataPairs(job, request, collected);

      ensureExportDir();
      const ext = job.format === 'xlsx' ? 'xlsx' : 'csv';
      const relPath = path.join(EXPORT_DIR_REL, `${job.id}.${ext}`);
      const absPath = path.join(ROOT, relPath);
      if (ext === 'xlsx') writeXlsxFile(absPath, pairs, collected.flatRows, collected.columns);
      else writeCsvFile(absPath, pairs, collected.flatRows, collected.columns);

      await db.query(
        `UPDATE export_jobs
            SET status = 'done', file_path = ?, row_count = ?, last_included_at = ?,
                error = NULL, finished_at = NOW()
          WHERE id = ?`,
        [relPath.replace(/\\/g, '/'), collected.flatRows.length, collected.lastIncludedAt, job.id]);
      summary.done.push(job.id);
    } catch (e) {
      const msg = (e && e.message ? String(e.message) : 'export failed').slice(0, 2000);
      summary.failed.push({ id: c.id, error: msg });
      try {
        await db.query(
          "UPDATE export_jobs SET status = 'failed', error = ?, finished_at = NOW() WHERE id = ?",
          [msg, c.id]);
      } catch (e2) {
        console.error('[analytics/export] could not mark job failed:', c.id, e2.message);
      }
    }
  }
  return summary;
}

// ── reads + download ─────────────────────────────────────────────────────────

const JOB_COLS =
  'id, username, format, status, file_path, row_count, last_included_at, ' +
  'definitions_version, scope_hash, error, created_at, started_at, finished_at';

/** Per-user unless admin. Not-found and not-owned both → null (no leak). */
async function getJob(db, { user, scope, id }) {
  const [rows] = await db.query(
    `SELECT ${JOB_COLS}, request_json FROM export_jobs WHERE id = ?`, [String(id)]);
  if (!rows.length) return null;
  const job = rows[0];
  if (!isAdminScope(scope) && job.username !== user.username) return null;
  try { job.request = JSON.parse(job.request_json); } catch (_) { job.request = null; }
  delete job.request_json;
  return job;
}

async function listJobs(db, { user, scope, limit = 50 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  if (isAdminScope(scope)) {
    const [rows] = await db.query(
      `SELECT ${JOB_COLS} FROM export_jobs ORDER BY created_at DESC, id DESC LIMIT ${n}`);
    return rows;
  }
  const [rows] = await db.query(
    `SELECT ${JOB_COLS} FROM export_jobs WHERE username = ? ORDER BY created_at DESC, id DESC LIMIT ${n}`,
    [user.username]);
  return rows;
}

/**
 * Ownership-or-admin + caps re-check + audit, then res.download stream.
 * Throws coded errors BEFORE any byte is written — the route maps them.
 */
async function streamDownload(db, res, { user, scope, id, ip }) {
  const [rows] = await db.query('SELECT * FROM export_jobs WHERE id = ?', [String(id)]);
  if (!rows.length) throw err('EXPORT_NOT_FOUND', 404, 'التصدير غير موجود');
  const job = rows[0];
  if (!isAdminScope(scope) && job.username !== user.username) {
    throw err('PERMISSION_DENIED', 403, 'هذا التصدير يخص مستخدمًا آخر');
  }
  if (!scope.caps.has('analytics.export')) {
    throw err('PERMISSION_DENIED', 403, 'صلاحية غير كافية لتنزيل التقارير (analytics.export)');
  }
  if (job.status !== 'done' || !job.file_path) {
    throw err('EXPORT_NOT_READY', 404, `التصدير ليس جاهزًا (status=${job.status})`);
  }
  const abs = path.join(ROOT, job.file_path);
  if (!fs.existsSync(abs)) throw err('EXPORT_NOT_FOUND', 404, 'ملف التصدير غير موجود على الخادم');

  await AuditService.record({
    action: 'analytics.export.download',
    resourceType: 'export_job',
    resourceId: job.id,
    actor: user.username,
    details: { format: job.format, row_count: job.row_count },
    ip: ip || '',
  });

  return new Promise((resolve, reject) => {
    res.download(abs, path.basename(abs), (e) => (e ? reject(e) : resolve()));
  });
}

module.exports = {
  createJob,
  runPendingExports,
  getJob,
  listJobs,
  streamDownload,
  // exported for schedules + tests
  definitionsVersion,
  stableStringify,
  loadUserRow,
  HARD_ROW_CAP,
  EXPORT_DIR_REL,
};
