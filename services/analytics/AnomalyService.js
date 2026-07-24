/**
 * services/analytics/AnomalyService.js — runs the anomaly rule catalog
 * (lib/analytics/anomalyRules.js) over a day×branch grid and upserts findings
 * into the EXISTING anomaly_alerts table — the exact column shape
 * server.js runMigrations §14 creates and routes/anomalies.js lists — so every
 * alert written here shows up in the existing GET /api/anomalies UI unchanged.
 *
 * DEDUPE: dedupe_key = `${ruleId}:${branchId}:${businessDay}:${subject}`
 * (UNIQUE uq_anomaly_dedupe, added by db/migrations/analytics/schema.js §13).
 * The write is INSERT … ON DUPLICATE KEY UPDATE: a re-scan REFRESHES
 * severity/title/description/score/detected_at and NEVER duplicates; the
 * alert's workflow state (status / acknowledged_by / resolution_notes) is
 * deliberately untouched — an acknowledged alert stays acknowledged.
 * Keys longer than the column's 120 chars keep their first 100 chars plus a
 * deterministic djb2 hash of the whole key (same input → same key, ever).
 *
 * created/refreshed counting: a SELECT-by-dedupe_key precedes the upsert.
 * affectedRows CANNOT discriminate here — mysql2 connects with
 * CLIENT_FOUND_ROWS, under which a duplicate-key update that changes nothing
 * (same-second re-scan → identical detected_at) ALSO reports affectedRows=1,
 * exactly like a fresh insert. The extra SELECT is cheap at alert volume and
 * deterministic; a concurrent-scan race could at worst double-count `created`
 * while the UNIQUE key still guarantees a single row.
 *
 * THRESHOLD SETTINGS (till_variance) — read once per scan from the flat
 * settings table (setting_key/setting_value, same tolerant style as
 * lib/pricing.getVatRateFromDb — missing table/row/garbage ⇒ default):
 *   AnalyticsTillVarianceAbs  — absolute SAR threshold  (default 20)
 *   AnalyticsTillVariancePct  — percent-of-expected     (default 2)
 *
 * scan(db, { from, to, branchIds? }) → { created, refreshed, byRule }.
 * branchIds omitted ⇒ derived from the fact tables' rows in the window (the
 * RollupService.rebuildRange derivation). Range capped at 45 days — the
 * worker scans yesterday+today; wider sweeps should go day-batched.
 * A single failing rule is logged and skipped; it never kills the scan.
 */
'use strict';

const { RULES } = require('../../lib/analytics/anomalyRules');

const MAX_SCAN_DAYS = 45;

const SCORE_OF = Object.freeze({
  critical: 95, high: 85, medium: 70, low: 50, info: 30,
});

function err(code, http, message) {
  const e = new Error(message);
  e.code = code;
  e.http = http;
  return e;
}

function _isIsoDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function _newId() {
  return 'ALR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

/** Deterministic djb2 hash → 8 hex chars. */
function _hash8(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** `${ruleId}:${branchId}:${businessDay}:${subject}`, capped at 120 chars. */
function dedupeKey(ruleId, branchId, businessDay, subject) {
  const key = `${ruleId}:${branchId}:${businessDay}:${subject}`;
  if (key.length <= 120) return key;
  return key.slice(0, 100) + '#' + _hash8(key);
}

/** Tolerant numeric settings read (lib/pricing.getVatRateFromDb style). */
async function _readNumberSetting(db, key, fallback) {
  try {
    const [rows] = await db.query(
      'SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [key]);
    if (rows && rows.length) {
      const v = Number(rows[0].setting_value);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  } catch (_) { /* settings table missing on legacy deploys — fall through */ }
  return fallback;
}

/** { tillAbs, tillPct } for the till_variance rule. */
async function readThresholds(db) {
  return {
    tillAbs: await _readNumberSetting(db, 'AnalyticsTillVarianceAbs', 20),
    tillPct: await _readNumberSetting(db, 'AnalyticsTillVariancePct', 2),
  };
}

/** Branch set inside the window, derived from the fact tables (rebuildRange's
 *  derivation — order/payment/till facts + sales_returns). */
async function _deriveBranches(db, from, to) {
  const [rows] = await db.query(
    `SELECT DISTINCT branch_id FROM analytics_order_facts   WHERE business_day BETWEEN ? AND ?
     UNION SELECT DISTINCT branch_id FROM analytics_payment_facts WHERE business_day BETWEEN ? AND ?
     UNION SELECT DISTINCT branch_id FROM analytics_till_facts    WHERE business_day BETWEEN ? AND ?
     UNION SELECT DISTINCT branch_id FROM sales_returns           WHERE return_date  BETWEEN ? AND ?`,
    [from, to, from, to, from, to, from, to]);
  return [...new Set(rows.map((r) => r.branch_id).filter((b) => b != null).map(String))];
}

/**
 * @param {object} db  mysql2 pool
 * @param {object} p   { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', branchIds?: string[] }
 * @returns {Promise<{created:number, refreshed:number, byRule:Object<string,number>}>}
 */
async function scan(db, { from, to, branchIds } = {}) {
  if (!_isIsoDay(from) || !_isIsoDay(to)) {
    throw err('VALIDATION_ERROR', 422, 'from/to مطلوبان بصيغة YYYY-MM-DD');
  }
  const fromMs = Date.parse(from + 'T00:00:00Z');
  const toMs = Date.parse(to + 'T00:00:00Z');
  if (!(fromMs <= toMs)) throw err('VALIDATION_ERROR', 422, 'to يسبق from');
  const days = Math.floor((toMs - fromMs) / 86400000) + 1;
  if (days > MAX_SCAN_DAYS) {
    throw err('ANALYTICS_RANGE_TOO_WIDE', 422, `المدى ${days} يومًا يتجاوز حد ${MAX_SCAN_DAYS} يومًا للفحص`);
  }

  let branches = Array.isArray(branchIds)
    ? [...new Set(branchIds.map(String).filter(Boolean))] : [];
  if (!branches.length) branches = await _deriveBranches(db, from, to);

  const out = { created: 0, refreshed: 0, byRule: {} };
  for (const rule of RULES) out.byRule[rule.id] = 0;
  if (!branches.length) return out;

  const thresholds = await readThresholds(db);

  const dayList = [];
  for (let ms = fromMs; ms <= toMs; ms += 86400000) {
    dayList.push(new Date(ms).toISOString().slice(0, 10));
  }

  for (const businessDay of dayList) {
    for (const branchId of branches) {
      for (const rule of RULES) {
        let findings;
        try {
          findings = await rule.run(db, { branchId, businessDay, thresholds });
        } catch (e) {
          console.warn('[analytics-anomaly] rule ' + rule.id + ' failed for ' +
            branchId + ' ' + businessDay + ':', e && e.message);
          continue; // one broken rule never kills the scan
        }
        for (const f of findings || []) {
          const r = await _upsertAlert(db, rule, branchId, businessDay, f);
          out.byRule[rule.id]++;
          if (r === 'created') out.created++; else out.refreshed++;
        }
      }
    }
  }
  return out;
}

/** One finding → one anomaly_alerts row (dedupe-keyed upsert). */
async function _upsertAlert(db, rule, branchId, businessDay, finding) {
  const key = dedupeKey(rule.id, branchId, businessDay, finding.subject);
  // related_doc points the existing UI at the most useful drill target:
  // per-document rules link the document; everything else links the branch.
  const docLinked = rule.id === 'late_offline_sync';
  const relatedType = docLinked ? 'ar_document' : 'branch';
  const relatedId = String(docLinked ? finding.subject : branchId).slice(0, 60);
  const title = `${rule.title} — ${businessDay}`;
  const description =
    `[${rule.id}] ${businessDay} فرع ${branchId} — ${finding.subject}: ` +
    `القيمة ${finding.value} مقابل الأساس ${finding.baseline}. ${finding.detail || ''}`.trim();
  const [existing] = await db.query(
    'SELECT 1 FROM anomaly_alerts WHERE dedupe_key = ? LIMIT 1', [key]);
  await db.query(
    `INSERT INTO anomaly_alerts
       (id, severity, category, title, description, related_doc_type, related_doc_id,
        score, status, dedupe_key)
     VALUES (?,?,?,?,?,?,?,?, 'open', ?)
     ON DUPLICATE KEY UPDATE
       severity = VALUES(severity),
       title = VALUES(title),
       description = VALUES(description),
       score = VALUES(score),
       detected_at = CURRENT_TIMESTAMP`,
    [_newId(), rule.severity, rule.category, title.slice(0, 300), description,
     relatedType, relatedId, SCORE_OF[rule.severity] || 60, key]);
  return existing.length ? 'refreshed' : 'created';
}

module.exports = { scan, readThresholds, dedupeKey, MAX_SCAN_DAYS };
