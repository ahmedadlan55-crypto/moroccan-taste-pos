/**
 * services/analytics/ScheduleService.js — report_schedules CRUD + the due-run
 * driver (Wave 3).
 *
 * OWNERSHIP + CAPS: every mutation needs the analytics.schedule capability;
 * rows are per-user (owner-or-admin), same model as export_jobs.
 *
 * NEXT-RUN ARITHMETIC: businessDay.nextRunAt(schedule, nowUtc) — pure,
 * DST-correct via ICU, weekday 0=Sunday…6=Saturday, month_day clamped to the
 * month's last day. next_run_at is stored through mysql2's +03:00 session
 * conversion (a JS Date in → Riyadh wall-clock DATETIME in the column), so
 * `next_run_at <= NOW()` in SQL compares like-with-like.
 *
 * runDueSchedules(db):
 *   - finds is_active rows with next_run_at <= NOW() (a NULL next_run_at is
 *     self-healed: computed and stored, NOT fired — a legacy row must not
 *     dump a surprise backlog);
 *   - for each due row: re-resolves the OWNER's current scope and creates an
 *     export job from the stored request_json via ExportService.createJob.
 *     A failure there (cap revoked, request no longer valid) is recorded as
 *     a FAILED export_jobs row — the schedule keeps its cadence either way;
 *   - advances last_run_at/next_run_at exactly once per due row;
 *   - executes the created jobs in-process (ExportService.runPendingExports)
 *     and notifies the owner in-app ('تقرير مجدول جاهز') through the existing
 *     NotificationService (`notifications` table + SSE poller). Notification
 *     failures are swallowed by NotificationService itself — never fatal.
 */
'use strict';

const businessDay = require('../../lib/analytics/businessDay');
const scopeLib = require('../../lib/analytics/scope');
const ExportService = require('./ExportService');
const NotificationService = require('../NotificationService');

const FREQS = new Set(['daily', 'weekly', 'monthly']);
const FORMATS = new Set(['csv', 'xlsx']);
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;

function err(code, http, message) {
  const e = new Error(message);
  e.code = code;
  e.http = http;
  return e;
}

function genId() {
  return 'SCH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function isAdminScope(scope) {
  return !!(scope && scope.all);
}

function requireCap(scope) {
  if (!scope || !scope.caps || !scope.caps.has('analytics.schedule')) {
    throw err('PERMISSION_DENIED', 403, 'صلاحية غير كافية لجدولة التقارير (analytics.schedule)');
  }
}

/** Throws 422 unless tz is a real IANA zone ICU knows. */
function validateTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch (_) {
    throw err('VALIDATION_ERROR', 422, `timezone غير صالح: "${String(tz).slice(0, 60)}"`);
  }
}

/**
 * Validate + normalize the schedule fields (create: all required; update:
 * merged over the existing row first, then validated as a whole).
 */
function validateSpec(s) {
  const out = {};
  out.name = String(s.name || '').trim();
  if (!out.name || out.name.length > 120) {
    throw err('VALIDATION_ERROR', 422, 'name مطلوب (بحد أقصى 120 حرفًا)');
  }
  if (!s.request || typeof s.request !== 'object' || Array.isArray(s.request)) {
    throw err('VALIDATION_ERROR', 422, 'request يجب أن يكون JSON object (عقد الاستعلام)');
  }
  out.request = s.request;
  out.format = String(s.format || 'csv').toLowerCase();
  if (!FORMATS.has(out.format)) throw err('VALIDATION_ERROR', 422, 'format يجب أن يكون csv أو xlsx');
  out.freq = String(s.freq || '');
  if (!FREQS.has(out.freq)) throw err('VALIDATION_ERROR', 422, 'freq يجب أن يكون daily أو weekly أو monthly');
  out.at_time = String(s.at_time || '');
  if (!TIME_RE.test(out.at_time)) throw err('VALIDATION_ERROR', 422, 'at_time يجب أن يكون HH:mm أو HH:mm:ss');
  out.weekday = null;
  out.month_day = null;
  if (out.freq === 'weekly') {
    const w = Number(s.weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) {
      throw err('VALIDATION_ERROR', 422, 'weekday مطلوب للجدولة الأسبوعية (0=الأحد … 6=السبت)');
    }
    out.weekday = w;
  }
  if (out.freq === 'monthly') {
    const d = Number(s.month_day);
    if (!Number.isInteger(d) || d < 1 || d > 31) {
      throw err('VALIDATION_ERROR', 422, 'month_day مطلوب للجدولة الشهرية (1..31)');
    }
    out.month_day = d;
  }
  out.timezone = validateTimezone(String(s.timezone || 'Asia/Riyadh'));
  out.is_active = s.is_active === undefined ? 1 : (s.is_active ? 1 : 0);
  return out;
}

function computeNextRun(spec, nowUtc) {
  return businessDay.nextRunAt({
    freq: spec.freq,
    at_time: spec.at_time,
    weekday: spec.weekday,
    month_day: spec.month_day,
    timezone: spec.timezone,
  }, nowUtc || new Date());
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

async function create(db, { user, scope, payload }) {
  requireCap(scope);
  const spec = validateSpec(payload || {});
  const id = genId();
  const nextRun = computeNextRun(spec);
  await db.query(
    `INSERT INTO report_schedules
       (id, username, name, request_json, format, freq, at_time, weekday, month_day,
        timezone, is_active, next_run_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [id, user.username, spec.name, ExportService.stableStringify(spec.request), spec.format,
     spec.freq, spec.at_time, spec.weekday, spec.month_day, spec.timezone,
     spec.is_active, nextRun]);
  return { id, next_run_at: nextRun.toISOString() };
}

async function list(db, { user, scope }) {
  const cols = 'id, username, name, request_json, format, freq, at_time, weekday, month_day, ' +
    'timezone, is_active, last_run_at, next_run_at, created_at';
  let rows;
  if (isAdminScope(scope)) {
    [rows] = await db.query(`SELECT ${cols} FROM report_schedules ORDER BY created_at DESC`);
  } else {
    [rows] = await db.query(
      `SELECT ${cols} FROM report_schedules WHERE username = ? ORDER BY created_at DESC`,
      [user.username]);
  }
  return rows.map((r) => {
    let request = null;
    try { request = JSON.parse(r.request_json); } catch (_) {}
    const out = Object.assign({}, r, { request });
    delete out.request_json;
    return out;
  });
}

async function loadOwned(db, { user, scope, id }) {
  const [rows] = await db.query('SELECT * FROM report_schedules WHERE id = ?', [String(id)]);
  if (!rows.length) throw err('SCHEDULE_NOT_FOUND', 404, 'الجدولة غير موجودة');
  const row = rows[0];
  if (!isAdminScope(scope) && row.username !== user.username) {
    // 404, not 403 — a foreign schedule id must not leak its existence
    throw err('SCHEDULE_NOT_FOUND', 404, 'الجدولة غير موجودة');
  }
  return row;
}

async function update(db, { user, scope, id, payload }) {
  requireCap(scope);
  const row = await loadOwned(db, { user, scope, id });
  let existingRequest = null;
  try { existingRequest = JSON.parse(row.request_json); } catch (_) {}
  const merged = {
    name: payload.name !== undefined ? payload.name : row.name,
    request: payload.request !== undefined ? payload.request : existingRequest,
    format: payload.format !== undefined ? payload.format : row.format,
    freq: payload.freq !== undefined ? payload.freq : row.freq,
    at_time: payload.at_time !== undefined ? payload.at_time : String(row.at_time),
    weekday: payload.weekday !== undefined ? payload.weekday : row.weekday,
    month_day: payload.month_day !== undefined ? payload.month_day : row.month_day,
    timezone: payload.timezone !== undefined ? payload.timezone : row.timezone,
    is_active: payload.is_active !== undefined ? payload.is_active : row.is_active,
  };
  const spec = validateSpec(merged);
  const nextRun = computeNextRun(spec);
  await db.query(
    `UPDATE report_schedules
        SET name = ?, request_json = ?, format = ?, freq = ?, at_time = ?, weekday = ?,
            month_day = ?, timezone = ?, is_active = ?, next_run_at = ?
      WHERE id = ?`,
    [spec.name, ExportService.stableStringify(spec.request), spec.format, spec.freq,
     spec.at_time, spec.weekday, spec.month_day, spec.timezone, spec.is_active,
     nextRun, row.id]);
  return { id: row.id, next_run_at: nextRun.toISOString() };
}

async function remove(db, { user, scope, id }) {
  requireCap(scope);
  const row = await loadOwned(db, { user, scope, id });
  await db.query('DELETE FROM report_schedules WHERE id = ?', [row.id]);
  return { id: row.id, deleted: true };
}

// ── the due-run driver ───────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} opts { now?: Date, runExports?: boolean (default true) }
 * @returns {Promise<{due:number, jobsCreated:string[], failures:Array<{scheduleId,error}>}>}
 * Never throws.
 */
async function runDueSchedules(db, opts = {}) {
  const out = { due: 0, jobsCreated: [], failures: [] };
  const now = opts.now instanceof Date ? opts.now : new Date();
  let rows = [];
  try {
    [rows] = await db.query(
      "SELECT * FROM report_schedules WHERE is_active = 1 AND (next_run_at IS NULL OR next_run_at <= NOW()) ORDER BY next_run_at");
  } catch (e) {
    console.error('[analytics/schedule] due scan failed:', e.message);
    return out;
  }

  const created = []; // { jobId, schedule }
  for (const row of rows) {
    const spec = {
      freq: row.freq, at_time: String(row.at_time), weekday: row.weekday,
      month_day: row.month_day, timezone: row.timezone,
    };
    // self-heal a NULL next_run_at without firing (no surprise backlog)
    if (row.next_run_at == null) {
      try {
        await db.query('UPDATE report_schedules SET next_run_at = ? WHERE id = ?',
          [computeNextRun(spec, now), row.id]);
      } catch (e) {
        console.error('[analytics/schedule] next_run_at heal failed:', row.id, e.message);
      }
      continue;
    }

    out.due++;
    try {
      const owner = await ExportService.loadUserRow(db, row.username);
      if (!owner) throw new Error('PERMISSION_REVOKED: schedule owner missing or inactive');
      const scope = await scopeLib.resolveScope(db, owner);
      const request = JSON.parse(row.request_json || '{}');
      const job = await ExportService.createJob(db, {
        user: owner, scope, request, format: row.format,
      });
      out.jobsCreated.push(job.id);
      created.push({ jobId: job.id, schedule: row });
    } catch (e) {
      // record the failure AS a failed export_jobs row — the schedule keeps
      // its cadence, and the owner can see WHY nothing arrived.
      const msg = (e && e.message ? String(e.message) : 'schedule run failed').slice(0, 2000);
      out.failures.push({ scheduleId: row.id, error: msg });
      try {
        const failId = 'EXP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        await db.query(
          `INSERT INTO export_jobs (id, username, request_json, format, status, error, created_at, finished_at)
           VALUES (?, ?, ?, ?, 'failed', ?, NOW(), NOW())`,
          [failId, row.username, row.request_json, FORMATS.has(row.format) ? row.format : 'csv', msg]);
      } catch (e2) {
        console.error('[analytics/schedule] could not record failed job:', row.id, e2.message);
      }
    }

    // advance the cadence exactly once per due row, success or failure
    try {
      await db.query(
        'UPDATE report_schedules SET last_run_at = NOW(), next_run_at = ? WHERE id = ?',
        [computeNextRun(spec, now), row.id]);
    } catch (e) {
      console.error('[analytics/schedule] cadence advance failed:', row.id, e.message);
    }
  }

  // execute the created jobs in-process, then notify each owner
  if (created.length && opts.runExports !== false) {
    try {
      await ExportService.runPendingExports(db, { limit: Math.min(20, created.length + 2) });
    } catch (e) {
      console.error('[analytics/schedule] runPendingExports failed:', e.message);
    }
    for (const c of created) {
      try {
        const [jr] = await db.query('SELECT status FROM export_jobs WHERE id = ?', [c.jobId]);
        const status = jr.length ? jr[0].status : null;
        if (status === 'done') {
          await NotificationService.notify({
            username: c.schedule.username,
            type: 'analytics.schedule.ready',
            title: 'تقرير مجدول جاهز',
            body: `${c.schedule.name} — جاهز للتنزيل`,
            linkType: 'export_job',
            linkId: c.jobId,
            icon: 'fa-file-arrow-down',
            severity: 'info',
          });
        } else if (status === 'failed') {
          await NotificationService.notify({
            username: c.schedule.username,
            type: 'analytics.schedule.failed',
            title: 'فشل إنشاء تقرير مجدول',
            body: c.schedule.name,
            linkType: 'export_job',
            linkId: c.jobId,
            icon: 'fa-triangle-exclamation',
            severity: 'warning',
          });
        }
      } catch (e) {
        console.error('[analytics/schedule] notify failed:', c.jobId, e.message);
      }
    }
  }
  return out;
}

module.exports = { create, update, list, remove, runDueSchedules, validateSpec, computeNextRun };
