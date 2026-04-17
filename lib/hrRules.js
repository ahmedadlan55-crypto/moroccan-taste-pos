/**
 * HR Rules Engine — Unified calculation logic for attendance, overtime, deductions
 * Used by payroll, dashboard, reports to ensure consistency.
 */

const db = require('../db/connection');

// ─────────────────────────────────────────────────────────────
// Time helpers
// ─────────────────────────────────────────────────────────────
function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = String(timeStr).split(':');
  return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
}

function minutesBetween(start, end) {
  return Math.max(0, Math.floor((new Date(end) - new Date(start)) / 60000));
}

// Round minutes to nearest X (e.g. 5, 10, 15) — configurable rounding
function roundMinutes(minutes, step) {
  if (!step || step <= 1) return minutes;
  return Math.round(minutes / step) * step;
}

// ─────────────────────────────────────────────────────────────
// Load shift for employee on a given date
// ─────────────────────────────────────────────────────────────
async function getEmployeeShift(employeeId, date) {
  // 1. Try employee's assigned shift
  const [emp] = await db.query(
    `SELECT e.shift_id, e.work_start, e.work_end, s.*
     FROM hr_employees e
     LEFT JOIN hr_shifts s ON e.shift_id = s.id
     WHERE e.id = ?`, [employeeId]);
  if (emp.length && emp[0].shift_id && emp[0].start_time) {
    return {
      id: emp[0].shift_id,
      startTime: emp[0].start_time,
      endTime: emp[0].end_time,
      breakMinutes: emp[0].break_minutes || 60,
      graceLateMinutes: emp[0].grace_late_minutes || 5,
      graceEarlyLeaveMinutes: emp[0].grace_early_leave_minutes || 0,
      allowOvertimeBefore: !!emp[0].allow_overtime_before,
      allowOvertimeAfter: emp[0].allow_overtime_after !== 0
    };
  }
  // 2. Fallback: employee's work_start/end (legacy)
  if (emp.length && emp[0].work_start) {
    return {
      id: null,
      startTime: emp[0].work_start,
      endTime: emp[0].work_end || '17:00:00',
      breakMinutes: 60, graceLateMinutes: 5, graceEarlyLeaveMinutes: 0,
      allowOvertimeBefore: false, allowOvertimeAfter: true
    };
  }
  // 3. Default
  const [defaultShift] = await db.query('SELECT * FROM hr_shifts WHERE is_default = 1 LIMIT 1');
  if (defaultShift.length) {
    const s = defaultShift[0];
    return {
      id: s.id, startTime: s.start_time, endTime: s.end_time,
      breakMinutes: s.break_minutes || 60,
      graceLateMinutes: s.grace_late_minutes || 5,
      graceEarlyLeaveMinutes: s.grace_early_leave_minutes || 0,
      allowOvertimeBefore: !!s.allow_overtime_before,
      allowOvertimeAfter: s.allow_overtime_after !== 0
    };
  }
  return { id: null, startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60, graceLateMinutes: 5, graceEarlyLeaveMinutes: 0, allowOvertimeBefore: false, allowOvertimeAfter: true };
}

// ─────────────────────────────────────────────────────────────
// Check for active exceptions on a given date
// ─────────────────────────────────────────────────────────────
async function getActiveExceptions(employeeId, date) {
  const [rows] = await db.query(
    `SELECT * FROM hr_exceptions
     WHERE employee_id = ? AND ? BETWEEN start_date AND end_date`,
    [employeeId, date]);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Determine day type (workday/restday/holiday)
// ─────────────────────────────────────────────────────────────
function getDayType(date, workDays) {
  // workDays is a string like "0,1,2,3,4" (0=Sunday)
  const d = new Date(date);
  const dow = d.getDay();
  const daysArr = (workDays || '0,1,2,3,4').split(',').map(function(x){return parseInt(x);});
  // TODO: check holidays table when exists
  return daysArr.indexOf(dow) >= 0 ? 'workday' : 'restday';
}

// ─────────────────────────────────────────────────────────────
// Calculate late minutes with grace + exceptions
// ─────────────────────────────────────────────────────────────
function calculateLate(shiftStart, actualClockIn, graceMinutes, exceptions) {
  // Check if ignore_late exception exists
  const ignored = (exceptions || []).find(function(e) { return e.exception_type === 'ignore_late'; });
  if (ignored) return { minutes: 0, ignored: true };

  const shiftStartMin = timeToMinutes(shiftStart);
  const clockInTime = new Date(actualClockIn);
  const clockInMin = clockInTime.getHours() * 60 + clockInTime.getMinutes();
  const lateMinutes = clockInMin - shiftStartMin;
  if (lateMinutes <= graceMinutes) return { minutes: 0, ignored: false };
  return { minutes: lateMinutes - graceMinutes, ignored: false };
}

// ─────────────────────────────────────────────────────────────
// Calculate early leave minutes
// ─────────────────────────────────────────────────────────────
function calculateEarlyLeave(shiftEnd, actualClockOut, graceMinutes, exceptions) {
  const ignored = (exceptions || []).find(function(e) { return e.exception_type === 'ignore_early_leave'; });
  if (ignored || !actualClockOut) return { minutes: 0, ignored: !!ignored };

  const shiftEndMin = timeToMinutes(shiftEnd);
  const clockOutTime = new Date(actualClockOut);
  const clockOutMin = clockOutTime.getHours() * 60 + clockOutTime.getMinutes();
  const earlyMin = shiftEndMin - clockOutMin;
  if (earlyMin <= graceMinutes) return { minutes: 0, ignored: false };
  return { minutes: earlyMin - graceMinutes, ignored: false };
}

// ─────────────────────────────────────────────────────────────
// Calculate overtime (before + after shift)
// ─────────────────────────────────────────────────────────────
async function calculateOvertime(shift, clockIn, clockOut, dayType, exceptions) {
  const ignored = (exceptions || []).find(function(e) { return e.exception_type === 'ignore_overtime'; });
  if (ignored || !clockOut) return { minutes: 0, multiplier: 1, amount: 0, ignored: !!ignored, ruleId: null };

  const shiftStartMin = timeToMinutes(shift.startTime);
  const shiftEndMin = timeToMinutes(shift.endTime);
  const ci = new Date(clockIn);
  const co = new Date(clockOut);
  const ciMin = ci.getHours() * 60 + ci.getMinutes();
  const coMin = co.getHours() * 60 + co.getMinutes();

  let otMinutes = 0;
  if (shift.allowOvertimeBefore && ciMin < shiftStartMin) otMinutes += (shiftStartMin - ciMin);
  if (shift.allowOvertimeAfter && coMin > shiftEndMin) otMinutes += (coMin - shiftEndMin);
  // Rest day or holiday — full hours count
  if (dayType !== 'workday') otMinutes = Math.max(otMinutes, minutesBetween(clockIn, clockOut));

  // Fetch rule
  const [rules] = await db.query('SELECT * FROM hr_overtime_rules WHERE day_type = ? AND is_active = 1 LIMIT 1', [dayType]);
  const rule = rules.length ? rules[0] : { multiplier: 1.5, min_minutes: 30, require_approval: 1, id: null };
  if (otMinutes < (rule.min_minutes || 0)) return { minutes: 0, multiplier: rule.multiplier, amount: 0, ignored: false, ruleId: rule.id };

  return { minutes: otMinutes, multiplier: Number(rule.multiplier) || 1.5, amount: 0, ignored: false, ruleId: rule.id, requiresApproval: !!rule.require_approval };
}

// ─────────────────────────────────────────────────────────────
// Apply attendance adjustment (if exception exists)
// ─────────────────────────────────────────────────────────────
function applyAdjustment(clockIn, clockOut, exceptions, attendanceDate) {
  const adj = (exceptions || []).find(function(e) { return e.exception_type === 'adjust_attendance'; });
  if (!adj) return { clockIn: clockIn, clockOut: clockOut, adjusted: false };
  const dateStr = attendanceDate;
  let newCi = clockIn, newCo = clockOut;
  if (adj.new_clock_in) newCi = dateStr + 'T' + adj.new_clock_in;
  if (adj.new_clock_out) newCo = dateStr + 'T' + adj.new_clock_out;
  return { clockIn: newCi, clockOut: newCo, adjusted: true, reason: adj.reason };
}

// ─────────────────────────────────────────────────────────────
// MAIN: Calculate daily attendance for an employee
// ─────────────────────────────────────────────────────────────
async function calculateDailyAttendance(employeeId, date) {
  const [att] = await db.query(
    'SELECT * FROM hr_attendance WHERE employee_id = ? AND attendance_date = ? ORDER BY clock_in DESC LIMIT 1',
    [employeeId, date]);
  if (!att.length) return { status: 'absent', lateMinutes: 0, overtimeMinutes: 0, earlyLeaveMinutes: 0, workMinutes: 0 };

  const record = att[0];
  const shift = await getEmployeeShift(employeeId, date);
  const exceptions = await getActiveExceptions(employeeId, date);
  const dayType = getDayType(date, '0,1,2,3,4');

  // Apply adjustment if any
  const adjusted = applyAdjustment(record.clock_in, record.clock_out, exceptions, date);
  const late = calculateLate(shift.startTime, adjusted.clockIn, shift.graceLateMinutes, exceptions);
  const early = calculateEarlyLeave(shift.endTime, adjusted.clockOut, shift.graceEarlyLeaveMinutes, exceptions);
  const ot = await calculateOvertime(shift, adjusted.clockIn, adjusted.clockOut, dayType, exceptions);
  const workMinutes = adjusted.clockOut ? minutesBetween(adjusted.clockIn, adjusted.clockOut) - (shift.breakMinutes || 0) : 0;

  return {
    attendanceId: record.id,
    status: record.status || 'present',
    shiftId: shift.id,
    lateMinutes: late.minutes,
    lateIgnored: late.ignored,
    earlyLeaveMinutes: early.minutes,
    earlyLeaveIgnored: early.ignored,
    overtimeMinutes: ot.minutes,
    overtimeMultiplier: ot.multiplier,
    overtimeIgnored: ot.ignored,
    overtimeRuleId: ot.ruleId,
    overtimeRequiresApproval: ot.requiresApproval,
    workMinutes: Math.max(0, workMinutes),
    isAdjusted: adjusted.adjusted,
    adjustmentReason: adjusted.reason || null,
    dayType: dayType
  };
}

// ─────────────────────────────────────────────────────────────
// Calculate monthly summary for an employee
// ─────────────────────────────────────────────────────────────
async function calculateMonthlyAttendance(employeeId, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const summary = {
    totalLateMinutes: 0, totalEarlyLeaveMinutes: 0, totalOvertimeMinutes: 0,
    totalWorkMinutes: 0, presentDays: 0, absentDays: 0, days: []
  };
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = year + '-' + String(month).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    const result = await calculateDailyAttendance(employeeId, dateStr);
    summary.days.push({ date: dateStr, ...result });
    summary.totalLateMinutes += result.lateMinutes;
    summary.totalEarlyLeaveMinutes += result.earlyLeaveMinutes;
    summary.totalOvertimeMinutes += result.overtimeMinutes;
    summary.totalWorkMinutes += result.workMinutes;
    if (result.status === 'present') summary.presentDays++;
    if (result.status === 'absent') summary.absentDays++;
  }
  return summary;
}

// ─────────────────────────────────────────────────────────────
// Write audit log
// ─────────────────────────────────────────────────────────────
async function auditLog(actor, action, entityType, entityId, details, ip) {
  try {
    const id = 'AUD-' + Date.now() + '-' + Math.random().toString(36).substr(2,4);
    await db.query(
      'INSERT INTO hr_audit_log (id, actor, action, entity_type, entity_id, details, ip) VALUES (?,?,?,?,?,?,?)',
      [id, actor || '', action, entityType || '', entityId || '', JSON.stringify(details || {}), ip || '']);
  } catch (e) { /* swallow */ }
}

module.exports = {
  timeToMinutes, minutesBetween, roundMinutes,
  getEmployeeShift, getActiveExceptions, getDayType,
  calculateLate, calculateEarlyLeave, calculateOvertime, applyAdjustment,
  calculateDailyAttendance, calculateMonthlyAttendance,
  auditLog
};
