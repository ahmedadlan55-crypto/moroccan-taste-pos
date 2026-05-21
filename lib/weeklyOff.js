/**
 * lib/weeklyOff.js — Weekly off (rest) day classifier.
 *
 * Two layers of configuration:
 *   1. Org-wide default in settings.weekly_off_default (CSV like '5,6'
 *      — Friday + Saturday for Saudi Arabia is the factory default).
 *   2. Per-employee override in hr_employees.weekly_off_days. NULL =
 *      use the org default. A non-null CSV (even empty string) takes
 *      precedence so HR can give an individual employee a completely
 *      custom rest pattern.
 *
 * Day index convention: JavaScript Date.getDay() — 0=Sunday, 1=Monday,
 * 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
 *
 * The Set returned by getWeeklyOffDaysForEmployee() is what every
 * attendance/payroll caller should use to classify a given calendar
 * date as "weekend" vs "work day".
 *
 * v6.3.0 — added in tandem with the live payroll engine + ERP UI.
 */

// Human-readable day labels (Arabic + English) used by the UI.
const DAY_LABELS = [
  { ar: 'الأحد',     en: 'Sunday',    short: 'حد' },
  { ar: 'الاثنين',   en: 'Monday',    short: 'اث' },
  { ar: 'الثلاثاء',  en: 'Tuesday',   short: 'ثل' },
  { ar: 'الأربعاء',  en: 'Wednesday', short: 'أر' },
  { ar: 'الخميس',    en: 'Thursday',  short: 'خم' },
  { ar: 'الجمعة',    en: 'Friday',    short: 'جم' },
  { ar: 'السبت',     en: 'Saturday',  short: 'سب' }
];

// Saudi-default: Friday + Saturday off
const DEFAULT_OFF_DAYS_CSV = '5,6';

function _parseCsv(csv) {
  if (csv == null) return null;
  const parts = String(csv).split(',').map(s => parseInt(s, 10))
    .filter(n => Number.isFinite(n) && n >= 0 && n <= 6);
  return new Set(parts);
}

/**
 * Fetch the org-wide weekly-off-days set from the settings table.
 * Falls back to Friday+Saturday when no setting is found.
 */
async function getOrgDefaultWeeklyOff(db) {
  try {
    const [rows] = await db.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'weekly_off_default' LIMIT 1"
    );
    if (rows.length && rows[0].setting_value != null && rows[0].setting_value !== '') {
      const set = _parseCsv(rows[0].setting_value);
      if (set) return set;
    }
  } catch (_) { /* settings table may not exist on the very first boot */ }
  return _parseCsv(DEFAULT_OFF_DAYS_CSV);
}

/**
 * Persist the org-wide default. Accepts an array of day indices (0-6).
 */
async function setOrgDefaultWeeklyOff(db, daysArray) {
  const csv = (Array.isArray(daysArray) ? daysArray : [])
    .map(n => parseInt(n, 10))
    .filter(n => Number.isFinite(n) && n >= 0 && n <= 6)
    .sort((a, b) => a - b)
    .join(',');
  await db.query(
    `INSERT INTO settings (setting_key, setting_value)
     VALUES ('weekly_off_default', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [csv]
  );
  return csv;
}

/**
 * Get the effective weekly-off set for one employee. Per-employee
 * override wins; otherwise falls back to the org default.
 */
async function getWeeklyOffDaysForEmployee(db, employeeId) {
  if (!employeeId) return getOrgDefaultWeeklyOff(db);
  try {
    const [rows] = await db.query(
      'SELECT weekly_off_days FROM hr_employees WHERE id = ? LIMIT 1',
      [employeeId]
    );
    if (rows.length && rows[0].weekly_off_days != null && rows[0].weekly_off_days !== '') {
      const set = _parseCsv(rows[0].weekly_off_days);
      if (set) return set;
    }
  } catch (_) { /* column may be missing on legacy schemas */ }
  return getOrgDefaultWeeklyOff(db);
}

/**
 * Set or clear a per-employee override.
 *   daysArray = null|undefined|[]  → clears override (falls back to default)
 *   daysArray = [5,6]              → stores '5,6'
 */
async function setEmployeeWeeklyOff(db, employeeId, daysArray) {
  let csv = null;
  if (Array.isArray(daysArray) && daysArray.length) {
    csv = daysArray
      .map(n => parseInt(n, 10))
      .filter(n => Number.isFinite(n) && n >= 0 && n <= 6)
      .sort((a, b) => a - b)
      .join(',');
    if (!csv) csv = null;
  }
  await db.query(
    'UPDATE hr_employees SET weekly_off_days = ? WHERE id = ?',
    [csv, employeeId]
  );
  return csv;
}

/**
 * Quick predicate. dayOfWeek = 0..6, offDaysSet = Set returned above.
 */
function isWeeklyOff(dayOfWeek, offDaysSet) {
  if (!offDaysSet || typeof offDaysSet.has !== 'function') return false;
  return offDaysSet.has(Number(dayOfWeek));
}

/**
 * Map a Set of day indices to user-friendly labels (used by the UI).
 */
function labelsFor(offDaysSet) {
  if (!offDaysSet) return [];
  const out = [];
  for (let i = 0; i < 7; i++) {
    if (offDaysSet.has(i)) out.push({ index: i, ar: DAY_LABELS[i].ar, en: DAY_LABELS[i].en });
  }
  return out;
}

module.exports = {
  DAY_LABELS,
  getOrgDefaultWeeklyOff,
  setOrgDefaultWeeklyOff,
  getWeeklyOffDaysForEmployee,
  setEmployeeWeeklyOff,
  isWeeklyOff,
  labelsFor
};
