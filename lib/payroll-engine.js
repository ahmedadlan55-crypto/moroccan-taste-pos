/**
 * lib/payroll-engine.js — Real-time monthly salary projection.
 *
 * The Employee Portal's "ملفي" tab now shows a LIVE breakdown that
 * reacts to every clock-in/out instead of a static basic_salary
 * snapshot. The same engine powers the admin-side preview before the
 * monthly payroll is run + frozen into hr_payroll_items.
 *
 * Composition:
 *
 *   gross = basicEarned + allowancesEarned + overtimePay + holidayBonus
 *
 *   netProjection = gross − ( lateDeduction + absenceDeduction +
 *                              gosi + advancesRecovered + fixedDeduction )
 *
 * Where:
 *   basicEarned       = dailyRate × presentDays
 *   allowancesEarned  = monthlyAllowancesTotal × (presentDays / workDaysExpected)
 *                      — pro-rated so absences cut the allowance proportionally.
 *                      Set ALLOWANCES_PRO_RATA=false in env to pay allowances in
 *                      full regardless of attendance (common Saudi practice).
 *   overtimePay       = (totalOvertimeMinutes / 60) × hourlyRate × OT_MULTIPLIER
 *   holidayBonus      = (hours worked on hr_holidays days) × hourlyRate × HOL_MULTIPLIER
 *   lateDeduction     = (totalLateMinutes / 60) × hourlyRate
 *   absenceDeduction  = absentDays × dailyRate
 *   gosi              = (basic + housing) × GOSI_EMPLOYEE_RATE
 *   advancesRecovered = sum of hr_advances rows due for this month
 *
 * All multipliers + rates are pulled from `settings` (with sensible
 * defaults) so the operator can tune them without code changes.
 *
 * Dependencies it relies on (already in the repo):
 *   - lib/hr-holidays.js findHolidayForDate, holidaysInMonth
 *   - lib/weeklyOff.js  getWeeklyOffDaysForEmployee
 *
 * v6.3.0 — Wave A (HR live payroll)
 */

const holidays  = require('./hr-holidays');
const weeklyOff = require('./weeklyOff');

// ── tunables (each can be overridden via settings.<key>) ───────────
const SETTING_KEYS = {
  otMultiplier:      'overtime_multiplier_default',  // default 1.5
  holMultiplier:     'holiday_multiplier_default',   // default 2.5
  gosiRate:          'gosi_employee_rate',           // default 10 (%)
  allowancesProRata: 'allowances_pro_rata'           // 'true' / 'false', default 'true'
};

async function _readSetting(db, key, fallback) {
  try {
    const [rows] = await db.query(
      'SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [key]
    );
    if (rows.length && rows[0].setting_value != null && rows[0].setting_value !== '') {
      return rows[0].setting_value;
    }
  } catch (_) {}
  return fallback;
}

function _r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Compute the projected net salary for an employee for a given month.
 *
 * @param {Object} db        — mysql pool or connection
 * @param {string} employeeId
 * @param {number} year      — e.g. 2026
 * @param {number} month     — 1..12
 * @param {Object} opts
 *   opts.asOfDate           — Date — defaults to NOW. When the requested
 *                              month is in the future, only days up to
 *                              this date contribute to "present" — the
 *                              rest are treated as 'pending' (not absent).
 * @returns {Promise<Object>}
 */
async function computeMonthlyProjection(db, employeeId, year, month, opts) {
  opts = opts || {};
  // ── 1. Load employee record ─────────────────────────────────────
  const [rows] = await db.query(
    `SELECT id, employee_number, first_name, last_name, full_name,
            branch_id, brand_id, basic_salary, hourly_rate, salary_type,
            housing_allowance, transport_allowance, other_allowance,
            food_allowance, communication_allowance, education_allowance,
            nature_allowance, social_insurance_rate, fixed_deduction,
            work_start, work_end, shift_id
       FROM hr_employees WHERE id = ? LIMIT 1`,
    [employeeId]
  );
  if (!rows.length) {
    const err = new Error('Employee not found: ' + employeeId);
    err.code = 'employee_not_found';
    throw err;
  }
  const emp = rows[0];
  const monthlySalary = Number(emp.basic_salary) || 0;
  const allowances = {
    housing:       Number(emp.housing_allowance       || 0),
    transport:     Number(emp.transport_allowance     || 0),
    communication: Number(emp.communication_allowance || 0),
    education:     Number(emp.education_allowance     || 0),
    nature:        Number(emp.nature_allowance        || 0),
    food:          Number(emp.food_allowance          || 0),
    other:         Number(emp.other_allowance         || 0)
  };
  allowances.total = _r2(
    allowances.housing + allowances.transport + allowances.communication +
    allowances.education + allowances.nature + allowances.food + allowances.other
  );

  // ── 2. Read tunable settings (with defaults) ────────────────────
  const otMul     = Number(await _readSetting(db, SETTING_KEYS.otMultiplier,    '1.5'))  || 1.5;
  const holMul    = Number(await _readSetting(db, SETTING_KEYS.holMultiplier,   '2.5'))  || 2.5;
  // Employee-row rate overrides the global setting when present (so HR can
  // give a contract employee a custom rate without touching settings).
  const empGosi   = Number(emp.social_insurance_rate);
  const gosiRate  = (Number.isFinite(empGosi) && empGosi > 0)
    ? empGosi
    : Number(await _readSetting(db, SETTING_KEYS.gosiRate, '10')) || 10;
  const proRataRaw = (await _readSetting(db, SETTING_KEYS.allowancesProRata, 'true') || 'true');
  const allowancesProRata = !(/^(false|0|no)$/i).test(String(proRataRaw));

  // ── 3. Period bounds ────────────────────────────────────────────
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const start = year + '-' + pad(month) + '-01';
  const endDay = new Date(year, month, 0).getDate();   // last day of month
  const end = year + '-' + pad(month) + '-' + pad(endDay);
  const daysInMonth = endDay;

  // ── 4. Day-of-week classifier (weekly off + holidays) ───────────
  const offDaysSet = await weeklyOff.getWeeklyOffDaysForEmployee(db, employeeId);
  const holMap = await holidays.holidaysInMonth(year, month, emp.brand_id, emp.branch_id);

  // ── 5. Pull attendance rows for the month ───────────────────────
  const [attRows] = await db.query(
    `SELECT attendance_date, clock_in, clock_out, total_hours,
            late_minutes, overtime_minutes, status
       FROM hr_attendance
      WHERE employee_id = ? AND attendance_date BETWEEN ? AND ?`,
    [employeeId, start, end]
  );
  const attByDate = {};
  attRows.forEach(r => {
    const d = r.attendance_date instanceof Date
      ? r.attendance_date.toISOString().slice(0, 10)
      : String(r.attendance_date).slice(0, 10);
    attByDate[d] = r;
  });

  // ── 6. Walk the month + classify each day ───────────────────────
  const asOf = opts.asOfDate ? new Date(opts.asOfDate) : new Date();
  const asOfStr = asOf.toISOString().slice(0, 10);

  let presentDays = 0, partialDays = 0, absentDays = 0;
  let leaveDays = 0, holidayDays = 0, weekendDays = 0, pendingDays = 0;
  let workDaysExpected = 0;
  let totalLateMinutes = 0, totalOvertimeMinutes = 0;
  let totalWorkHours = 0;
  let holidayWorkedHours = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = year + '-' + pad(month) + '-' + pad(d);
    const date = new Date(dateStr + 'T00:00:00');
    const dow = date.getDay();
    const isFuture = dateStr > asOfStr;
    const att = attByDate[dateStr];
    const holiday = holMap && holMap[dateStr];

    if (offDaysSet.has(dow)) {
      weekendDays++;
      // Worked on a weekly off day? Count as overtime-style bonus.
      if (att && att.clock_in) {
        const hrs = Number(att.total_hours) || 0;
        holidayWorkedHours += hrs;
      }
      continue;
    }
    if (holiday) {
      holidayDays++;
      if (att && att.clock_in) {
        const hrs = Number(att.total_hours) || 0;
        // Use the holiday's own multiplier if set, otherwise the default.
        const thisMul = Number(holiday.overtimeMultiplier || holMul) || holMul;
        holidayWorkedHours += hrs * (thisMul / holMul);  // normalize to base for later × holMul
      }
      continue;
    }

    workDaysExpected++;

    if (!att) {
      if (isFuture) pendingDays++;
      else absentDays++;
      continue;
    }
    const status = String(att.status || '').toLowerCase();
    if (status === 'leave') { leaveDays++; continue; }
    if (status === 'absent') { absentDays++; continue; }
    if (att.clock_in && att.clock_out) {
      presentDays++;
      totalWorkHours += Number(att.total_hours) || 0;
    } else if (att.clock_in && !att.clock_out) {
      // Has clock-in but no clock-out — still counts as present for
      // attendance-day purposes; admin can decide deductions later.
      partialDays++;
      totalWorkHours += Number(att.total_hours) || 0;
    } else if (status === 'present') {
      presentDays++;
    } else {
      if (isFuture) pendingDays++;
      else absentDays++;
    }
    totalLateMinutes += Number(att.late_minutes) || 0;
    totalOvertimeMinutes += Number(att.overtime_minutes) || 0;
  }

  // ── 7. Rates ────────────────────────────────────────────────────
  // Saudi convention: monthly basis / 30 for daily, daily / shiftHours for hourly.
  const shiftHours = _shiftHoursFrom(emp.work_start, emp.work_end) || 9;
  const dailyRate  = monthlySalary / 30;
  const hourlyRate = (Number(emp.hourly_rate) > 0)
    ? Number(emp.hourly_rate)
    : (dailyRate / shiftHours);

  // ── 8. Earnings ─────────────────────────────────────────────────
  const effectivePresent = presentDays + partialDays;
  const basicEarned = _r2(dailyRate * effectivePresent);
  const allowancesEarned = allowancesProRata
    ? _r2(allowances.total * (workDaysExpected > 0 ? (effectivePresent / workDaysExpected) : 1))
    : allowances.total;
  const overtimePay = _r2((totalOvertimeMinutes / 60) * hourlyRate * otMul);
  const holidayBonus = _r2(holidayWorkedHours * hourlyRate * holMul);
  const gross = _r2(basicEarned + allowancesEarned + overtimePay + holidayBonus);

  // ── 9. Deductions ───────────────────────────────────────────────
  const lateDeduction    = _r2((totalLateMinutes / 60) * hourlyRate);
  const absenceDeduction = _r2(absentDays * dailyRate);
  const gosi             = _r2((monthlySalary + allowances.housing) * (gosiRate / 100));
  const fixedDed         = Number(emp.fixed_deduction) || 0;

  // Advances due for this month (best-effort; tolerate missing table)
  let advancesRecovered = 0;
  try {
    const [adv] = await db.query(
      `SELECT COALESCE(SUM(monthly_deduction), 0) AS due
         FROM hr_advances
        WHERE employee_id = ? AND status IN ('approved','active','partial')
          AND (start_month IS NULL OR start_month <= ?)
          AND (end_month   IS NULL OR end_month   >= ?)`,
      [employeeId, year * 100 + month, year * 100 + month]
    );
    advancesRecovered = Number(adv[0].due) || 0;
  } catch (_) { /* table may not exist or column names differ — ignore */ }

  const deductionsTotal = _r2(lateDeduction + absenceDeduction + gosi + fixedDed + advancesRecovered);
  const netProjection = _r2(gross - deductionsTotal);

  // ── 10. Build the result ────────────────────────────────────────
  return {
    isProjection: true,
    asOfDate: asOfStr,
    period: {
      year, month,
      label: year + '-' + pad(month),
      startDate: start, endDate: end,
      daysInMonth,
      workDaysExpected,
      shiftHours
    },
    employee: {
      id: emp.id,
      employeeNumber: emp.employee_number,
      name: emp.full_name || ((emp.first_name || '') + (emp.last_name ? ' ' + emp.last_name : '')).trim(),
      brandId: emp.brand_id || null,
      branchId: emp.branch_id || null
    },
    basic: {
      monthlySalary: _r2(monthlySalary),
      dailyRate: _r2(dailyRate),
      hourlyRate: _r2(hourlyRate)
    },
    allowances: {
      housing: allowances.housing, transport: allowances.transport,
      communication: allowances.communication, education: allowances.education,
      nature: allowances.nature, food: allowances.food, other: allowances.other,
      total: allowances.total,
      proRataApplied: allowancesProRata
    },
    attendance: {
      workDaysExpected,
      presentDays, partialDays, absentDays, leaveDays, holidayDays,
      weekendDays, pendingDays,
      totalWorkHours: _r2(totalWorkHours),
      totalLateMinutes,
      totalOvertimeMinutes,
      holidayWorkedHours: _r2(holidayWorkedHours)
    },
    earnings: {
      basicEarned, allowancesEarned, overtimePay, holidayBonus, gross,
      overtimeMultiplier: otMul, holidayMultiplier: holMul
    },
    deductions: {
      lateDeduction, absenceDeduction, gosi, fixedDeduction: _r2(fixedDed),
      advancesRecovered: _r2(advancesRecovered),
      total: deductionsTotal,
      gosiRate
    },
    netProjection
  };
}

function _shiftHoursFrom(start, end) {
  // start/end are TIME strings like '08:00:00'
  if (!start || !end) return null;
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  if (!Number.isFinite(sh) || !Number.isFinite(eh)) return null;
  let hours = (eh + (em || 0) / 60) - (sh + (sm || 0) / 60);
  if (hours <= 0) hours += 24;
  return hours;
}

module.exports = { computeMonthlyProjection };
