'use strict';
/* Integration — /api/analytics/exports + ExportService worker + schedules
 * (real server + DB, direct-SQL fixtures from tests/fixtures/salesHubSeed).
 *
 * Covers:
 *   · manager (analytics.export via role) creates a CSV job → 201 queued;
 *   · runPendingExports IN-PROCESS → job done, real file under
 *     uploads/exports/: BOM first, '# ' metadata preamble (filters/timezone/
 *     definitions_version/equations/last_included_at), data rows matching a
 *     live /query answer, formula-injection cell neutralized ('=EVIL…);
 *   · scope is enforced INSIDE the export (manager sees only B1);
 *   · xlsx job → readable via require('xlsx'), 'data' + 'metadata' sheets;
 *   · download: owner 200 (BOM + attachment), OTHER non-admin 403, admin 200;
 *   · cap-less user (auditor: analytics.view but NOT analytics.export) → 403;
 *   · revoked-cap job: created with the cap, cap revoked before the worker
 *     runs → job failed with PERMISSION_REVOKED (run-time re-resolution);
 *   · audit_logs rows for analytics.export.create / .download;
 *   · schedule: created via API (403 for auditor), forced due, runDueSchedules
 *     → export job done + in-app notification 'تقرير مجدول جاهز'.
 *
 * Fixtures: ITEST-SHE-* (salesHubSeed, 2032-03). PORT 3987.
 * Run: node tests/integration/analyticsExports.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');
const ExportService = require('../../services/analytics/ExportService');
const ScheduleService = require('../../services/analytics/ScheduleService');

const PORT = 3987;
const PREFIX = 'ITEST-SHE';
const E = seedMod.EXPECTED;
const ADMIN = 'itest_she_admin';
const MGR = 'itest_she_mgr';
const MGR2 = 'itest_she_mgr2';
const AUD = 'itest_she_auditor';
const PW = 'She#Test!2032';
const ROOT = path.join(__dirname, '..', '..');
let I = null;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j, raw: b, headers: s.headers }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() {
  for (let i = 0; i < 180; i++) {
    const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)));
    if (ok) return true;
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}

const createdJobs = [];

async function cleanupAll() {
  for (const u of [ADMIN, MGR, MGR2, AUD]) {
    try {
      const [r] = await db.query('SELECT id FROM users WHERE username = ?', [u]);
      if (r.length) await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [r[0].id]);
      await db.query('DELETE FROM user_permission_overrides WHERE username = ?', [u]);
      await db.query('DELETE FROM users WHERE username = ?', [u]);
    } catch (_) {}
  }
  try { await db.query("DELETE FROM export_jobs WHERE username LIKE 'itest\\_she\\_%'"); } catch (_) {}
  try { await db.query("DELETE FROM report_schedules WHERE username LIKE 'itest\\_she\\_%'"); } catch (_) {}
  try { await db.query("DELETE FROM notifications WHERE username LIKE 'itest\\_she\\_%'"); } catch (_) {}
  try { await db.query("DELETE FROM audit_logs WHERE user_username LIKE 'itest\\_she\\_%'"); } catch (_) {}
  for (const id of createdJobs) {
    for (const ext of ['csv', 'xlsx']) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', 'exports', `${id}.${ext}`)); } catch (_) {}
    }
  }
}

(async () => {
  await seedMod.cleanup(db, PREFIX);
  await cleanupAll();
  I = await seedMod.seed(db, PREFIX);

  const hash = await bcrypt.hash(PW, 12);
  const mkUser = async (u, role) => {
    const [r] = await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [u, hash, role]);
    return r.insertId;
  };
  await mkUser(ADMIN, 'admin');
  const mgrId = await mkUser(MGR, 'manager');
  const mgr2Id = await mkUser(MGR2, 'manager');
  await mkUser(AUD, 'auditor');
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?),(?,?,?)',
    [mgrId, I.W1, 'itest', mgr2Id, I.W1, 'itest']);

  // a branch label that would execute in Excel if not neutralized
  await db.query("UPDATE branches SET name = '=EVIL()' WHERE id = ?", [I.B1]);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    const mgr = await login(MGR);
    const mgr2 = await login(MGR2);
    const aud = await login(AUD);
    check('all four users got JWTs', !!admin && !!mgr && !!mgr2 && !!aud);

    const REQ = {
      metrics: ['net_ex_vat', 'orders'],
      dimensions: ['branch'],
      range: E.RANGE,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
    };

    // ── create (CSV) ──────────────────────────────────────────────────────
    console.log('\n▶ create CSV job');
    const c1 = await call('POST', '/api/analytics/exports', mgr, { format: 'csv', request: REQ });
    check('create answers 201 {id, status:queued}', c1.status === 201 &&
      c1.body?.success === true && !!c1.body?.data?.id && c1.body?.data?.status === 'queued', c1.body);
    const jobId = c1.body?.data?.id || '';
    if (jobId) createdJobs.push(jobId);

    const [audCreate] = await db.query(
      "SELECT id FROM audit_logs WHERE action = 'analytics.export.create' AND entity_id = ? AND user_username = ?",
      [jobId, MGR]);
    check('audit_logs row for analytics.export.create', audCreate.length >= 1, audCreate.length);

    const badReq = await call('POST', '/api/analytics/exports', mgr,
      { format: 'csv', request: { metrics: ['no_such_metric'], range: E.RANGE } });
    check('invalid request fails at CREATE time (422 ANALYTICS_UNKNOWN_METRIC)',
      badReq.status === 422 && badReq.body?.code === 'ANALYTICS_UNKNOWN_METRIC', badReq);
    const badFmt = await call('POST', '/api/analytics/exports', mgr, { format: 'pdf', request: REQ });
    check('unknown format → 422 VALIDATION_ERROR', badFmt.status === 422 && badFmt.body?.code === 'VALIDATION_ERROR', badFmt);

    // ── run the worker in-process ─────────────────────────────────────────
    console.log('\n▶ runPendingExports (in-process)');
    const run1 = await ExportService.runPendingExports(db, { limit: 5 });
    check('worker claimed + finished the job', run1.done.includes(jobId), run1);

    const g1 = await call('GET', '/api/analytics/exports/' + jobId, mgr);
    check('owner GET job → done with file_path + row_count', g1.status === 200 &&
      g1.body?.data?.status === 'done' && !!g1.body?.data?.file_path &&
      g1.body?.data?.row_count === 1, g1.body?.data);

    const [liRow] = await db.query(
      "SELECT DATE_FORMAT(last_included_at, '%Y-%m-%d %H:%i:%s') AS li FROM export_jobs WHERE id = ?", [jobId]);
    check('last_included_at = range end (no date dim in result)',
      liRow.length && liRow[0].li === '2032-03-31 23:59:59', liRow[0]);

    // ── file content ──────────────────────────────────────────────────────
    console.log('\n▶ CSV file content');
    const csvPath = path.join(ROOT, 'uploads', 'exports', `${jobId}.csv`);
    check('file exists under uploads/exports/', fs.existsSync(csvPath), csvPath);
    const csv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : '';
    check('file starts with BOM', csv.charCodeAt(0) === 0xFEFF);
    check('metadata preamble present (# filters / timezone / definitions / equations / last_included_at)',
      csv.includes('# filters:') && csv.includes('# timezone:') &&
      csv.includes('# definitions_version:') && csv.includes('# metric_equations:') &&
      csv.includes('# last_included_at: 2032-03-31 23:59:59'),
      csv.split('\r\n').slice(0, 12));
    check('preamble equations name the metric contracts',
      csv.includes('net_ex_vat=sum(v1)') && csv.includes('orders=count(v1)'));

    // the same query live, same caller — the file must match it
    const live = await call('POST', '/api/analytics/query', mgr, Object.assign({ noCache: true }, REQ));
    const liveRow = (live.body?.data?.rows || [])[0];
    check('live query returns exactly the manager-scoped B1 row (net 830, orders 6)',
      !!liveRow && String(liveRow.keys.branch) === I.B1 &&
      liveRow.values.net_ex_vat === E.B1.net_ex_vat && liveRow.values.orders === E.B1.orders, liveRow);
    check('CSV data row matches the live query (branch id + 830 + 6)',
      csv.includes(I.B1) && /,830,6\r\n/.test(csv), csv.split('\r\n').slice(-4));
    // the preamble's "# filters:" line legitimately echoes the REQUESTED
    // branches (incl. B2) — scope is judged on the DATA section only
    const csvData = csv.split('\r\n').filter((l) => !l.replace(/^﻿/, '').startsWith('# ')).join('\r\n');
    check('scope enforced INSIDE the export — B2 absent from the data section', !csvData.includes(I.B2));
    check("formula-injection label neutralized ('=EVIL())", csv.includes("'=EVIL()") && !/,=EVIL/.test(csv));

    // ── xlsx job ──────────────────────────────────────────────────────────
    console.log('\n▶ xlsx job');
    const c2 = await call('POST', '/api/analytics/exports', mgr, { format: 'xlsx', request: REQ });
    const xJobId = c2.body?.data?.id || '';
    if (xJobId) createdJobs.push(xJobId);
    check('xlsx create answers 201 queued', c2.status === 201 && !!xJobId, c2.body);
    const run2 = await ExportService.runPendingExports(db, { limit: 5 });
    check('xlsx job done', run2.done.includes(xJobId), run2);
    const xlsxPath = path.join(ROOT, 'uploads', 'exports', `${xJobId}.xlsx`);
    check('xlsx file exists', fs.existsSync(xlsxPath), xlsxPath);
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(xlsxPath);
      check('workbook has data + metadata sheets',
        wb.SheetNames.includes('data') && wb.SheetNames.includes('metadata'), wb.SheetNames);
      const dataRows = XLSX.utils.sheet_to_json(wb.Sheets.data);
      check('data sheet row matches live query (B1 / 830 / 6)', dataRows.length === 1 &&
        String(dataRows[0].branch) === I.B1 && Number(dataRows[0].net_ex_vat) === E.B1.net_ex_vat &&
        Number(dataRows[0].orders) === E.B1.orders, dataRows[0]);
      const metaRows = XLSX.utils.sheet_to_json(wb.Sheets.metadata);
      check('metadata sheet carries definitions_version + last_included_at',
        metaRows.some((r) => r.key === 'definitions_version' && String(r.value).startsWith('r')) &&
        metaRows.some((r) => r.key === 'last_included_at'), metaRows.map((r) => r.key));
    } catch (e) {
      check('xlsx readable via require("xlsx")', false, e.message);
    }

    // ── download ──────────────────────────────────────────────────────────
    console.log('\n▶ download');
    const dOwner = await call('GET', `/api/analytics/exports/${jobId}/download`, mgr);
    check('owner download → 200 attachment with BOM', dOwner.status === 200 &&
      String(dOwner.headers['content-disposition'] || '').includes('attachment') &&
      dOwner.raw.charCodeAt(0) === 0xFEFF, { status: dOwner.status, cd: dOwner.headers['content-disposition'] });
    const dOther = await call('GET', `/api/analytics/exports/${jobId}/download`, mgr2);
    check('OTHER non-admin download → 403 PERMISSION_DENIED',
      dOther.status === 403 && dOther.body?.code === 'PERMISSION_DENIED', dOther);
    const dAdmin = await call('GET', `/api/analytics/exports/${jobId}/download`, admin);
    check('admin download → 200 (ownership-or-admin)', dAdmin.status === 200, dAdmin.status);
    const gOther = await call('GET', '/api/analytics/exports/' + jobId, mgr2);
    check('OTHER non-admin GET job → 404 (no existence leak)', gOther.status === 404, gOther.status);
    const [audDl] = await db.query(
      "SELECT id FROM audit_logs WHERE action = 'analytics.export.download' AND entity_id = ? AND user_username = ?",
      [jobId, MGR]);
    check('audit_logs row for analytics.export.download', audDl.length >= 1, audDl.length);

    // ── cap-less create ───────────────────────────────────────────────────
    console.log('\n▶ capability gates');
    const cAud = await call('POST', '/api/analytics/exports', aud, { format: 'csv', request: REQ });
    check('auditor (view, no export cap) create → 403 PERMISSION_DENIED',
      cAud.status === 403 && cAud.body?.code === 'PERMISSION_DENIED', cAud);

    // ── revoked-cap job → PERMISSION_REVOKED at run time ──────────────────
    const c3 = await call('POST', '/api/analytics/exports', mgr2, { format: 'csv', request: REQ });
    const rJobId = c3.body?.data?.id || '';
    if (rJobId) createdJobs.push(rJobId);
    check('mgr2 (cap held) creates a job', c3.status === 201 && !!rJobId, c3.body);
    await db.query(
      "INSERT INTO user_permission_overrides (username, permission_id, grant_type) VALUES (?, 'analytics.export', 'revoke') ON DUPLICATE KEY UPDATE grant_type='revoke'",
      [MGR2]);
    const run3 = await ExportService.runPendingExports(db, { limit: 5 });
    const [rJob] = await db.query('SELECT status, error FROM export_jobs WHERE id = ?', [rJobId]);
    check('revoked-cap job → failed with PERMISSION_REVOKED (run-time re-resolution)',
      rJob.length && rJob[0].status === 'failed' && /PERMISSION_REVOKED/.test(rJob[0].error || ''),
      { run: run3.failed, job: rJob[0] });
    await db.query("DELETE FROM user_permission_overrides WHERE username = ? AND permission_id = 'analytics.export'", [MGR2]);

    // ── list scoping ──────────────────────────────────────────────────────
    const lMgr = await call('GET', '/api/analytics/exports', mgr);
    check('list is per-user (mgr sees only OWN jobs)', lMgr.status === 200 &&
      (lMgr.body?.data || []).length >= 2 &&
      (lMgr.body?.data || []).every((j) => j.username === MGR), (lMgr.body?.data || []).map((j) => j.username));

    // ── schedules ─────────────────────────────────────────────────────────
    console.log('\n▶ schedules');
    const sAud = await call('POST', '/api/analytics/schedules', aud,
      { name: 'x', request: REQ, freq: 'daily', at_time: '07:00' });
    check('auditor (no schedule cap) create → 403', sAud.status === 403 && sAud.body?.code === 'PERMISSION_DENIED', sAud);
    const sBad = await call('POST', '/api/analytics/schedules', mgr,
      { name: 'weekly-missing-weekday', request: REQ, freq: 'weekly', at_time: '07:00' });
    check('weekly without weekday → 422', sBad.status === 422 && sBad.body?.code === 'VALIDATION_ERROR', sBad);
    const s1 = await call('POST', '/api/analytics/schedules', mgr, {
      name: 'تقرير الفروع اليومي', request: REQ, format: 'csv',
      freq: 'daily', at_time: '07:00', timezone: 'Asia/Riyadh',
    });
    const schId = s1.body?.data?.id || '';
    check('schedule created with a FUTURE next_run_at', s1.status === 201 && !!schId &&
      new Date(s1.body?.data?.next_run_at).getTime() > Date.now(), s1.body);

    // force it due, then drive it in-process (creates + runs the export)
    await db.query("UPDATE report_schedules SET next_run_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?", [schId]);
    const due = await ScheduleService.runDueSchedules(db);
    check('runDueSchedules fired exactly one due schedule → one job', due.due === 1 &&
      due.jobsCreated.length === 1 && due.failures.length === 0, due);
    const schJobId = due.jobsCreated[0] || '';
    if (schJobId) createdJobs.push(schJobId);
    const [schJob] = await db.query('SELECT status, row_count FROM export_jobs WHERE id = ?', [schJobId]);
    check('scheduled job executed to done', schJob.length && schJob[0].status === 'done', schJob[0]);
    const [schRow] = await db.query('SELECT last_run_at, next_run_at FROM report_schedules WHERE id = ?', [schId]);
    check('cadence advanced (last_run_at set, next_run_at back in the future)',
      schRow.length && schRow[0].last_run_at != null &&
      new Date(schRow[0].next_run_at).getTime() > Date.now(), schRow[0]);
    const [notif] = await db.query(
      "SELECT title FROM notifications WHERE username = ? AND type = 'analytics.schedule.ready'", [MGR]);
    check("in-app notification 'تقرير مجدول جاهز' inserted",
      notif.length >= 1 && notif[0].title === 'تقرير مجدول جاهز', notif);

    const del = await call('DELETE', '/api/analytics/schedules/' + schId, mgr);
    check('owner DELETE schedule → 200', del.status === 200 && del.body?.data?.deleted === true, del.body);

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsExports: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await seedMod.cleanup(db, PREFIX);
    await cleanupAll();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
