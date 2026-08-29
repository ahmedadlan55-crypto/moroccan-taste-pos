const router = require('express').Router();
const db = require('../db/connection');
const hrRules = require('../lib/hrRules');
const hrGLPosting = require('../lib/hrGLPosting');
// FC-P1b — capability guard + JWT actor for payroll approve/pay (double-post safe).
const requireCapability = require('../middleware/requireCapability');
function _actor(req) { return (req.user && (req.user.username || req.user.name)) || ''; }
// v6.3.0 — live payroll projection + weekly off classifier
const payrollEngine = require('../lib/payroll-engine');
const weeklyOff = require('../lib/weeklyOff');
const { todayYmd } = require('../lib/expiryPolicy');

// ═══════════════════════════════════════════════════════════════
// HELPER: Ensure HR tables exist (auto-migrate)
// ═══════════════════════════════════════════════════════════════

let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_departments (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      name_en VARCHAR(200),
      manager_id VARCHAR(50),
      parent_id VARCHAR(50),
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_employees (
      id VARCHAR(50) PRIMARY KEY,
      employee_number VARCHAR(30) UNIQUE,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      national_id VARCHAR(30),
      passport_number VARCHAR(30),
      iqama_number VARCHAR(30),
      phone VARCHAR(30),
      email VARCHAR(100),
      gender ENUM('male','female') DEFAULT 'male',
      date_of_birth DATE,
      nationality VARCHAR(50),
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      department_id VARCHAR(50),
      position_id VARCHAR(50),
      job_title VARCHAR(100),
      employment_type ENUM('full_time','part_time','contract','temporary') DEFAULT 'full_time',
      salary_type ENUM('monthly','hourly','daily') DEFAULT 'monthly',
      basic_salary DECIMAL(12,2) DEFAULT 0,
      hourly_rate DECIMAL(10,2) DEFAULT 0,
      housing_allowance DECIMAL(12,2) DEFAULT 0,
      transport_allowance DECIMAL(12,2) DEFAULT 0,
      other_allowance DECIMAL(12,2) DEFAULT 0,
      hire_date DATE,
      contract_end_date DATE,
      probation_end_date DATE,
      termination_date DATE,
      termination_reason TEXT,
      status ENUM('active','suspended','terminated','on_leave') DEFAULT 'active',
      bank_name VARCHAR(100),
      bank_account VARCHAR(50),
      bank_iban VARCHAR(50),
      emergency_contact_name VARCHAR(100),
      emergency_contact_phone VARCHAR(30),
      emergency_contact_relation VARCHAR(50),
      user_id INT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by VARCHAR(100)
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_work_schedules (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      break_minutes INT DEFAULT 0,
      working_days VARCHAR(20) DEFAULT '1,2,3,4,5',
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_attendance (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      attendance_date DATE NOT NULL,
      clock_in DATETIME,
      clock_out DATETIME,
      total_hours DECIMAL(5,2) DEFAULT 0,
      overtime_minutes INT DEFAULT 0,
      late_minutes INT DEFAULT 0,
      early_leave_minutes INT DEFAULT 0,
      status ENUM('present','absent','leave','holiday') DEFAULT 'present',
      source ENUM('manual','device','app','import') DEFAULT 'manual',
      geo_lat DECIMAL(10,7),
      geo_lng DECIMAL(10,7),
      device_id VARCHAR(100),
      device_name VARCHAR(200),
      geo_address_in VARCHAR(500),
      geo_lat_out DECIMAL(10,7),
      geo_lng_out DECIMAL(10,7),
      geo_address_out VARCHAR(500),
      notes TEXT,
      modified_by VARCHAR(100),
      modified_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // Add missing columns if table already exists
  try { await db.query('ALTER TABLE hr_attendance ADD COLUMN device_name VARCHAR(200)'); } catch(e) {}
  try { await db.query('ALTER TABLE hr_attendance ADD COLUMN geo_address_in VARCHAR(500)'); } catch(e) {}
  try { await db.query('ALTER TABLE hr_attendance ADD COLUMN geo_lat_out DECIMAL(10,7)'); } catch(e) {}
  try { await db.query('ALTER TABLE hr_attendance ADD COLUMN geo_lng_out DECIMAL(10,7)'); } catch(e) {}
  try { await db.query('ALTER TABLE hr_attendance ADD COLUMN geo_address_out VARCHAR(500)'); } catch(e) {}
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_leave_types (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      name_en VARCHAR(100),
      default_days INT DEFAULT 0,
      is_paid BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_leave_balances (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      leave_type_id VARCHAR(50) NOT NULL,
      year INT NOT NULL,
      total_days DECIMAL(5,1) DEFAULT 0,
      used_days DECIMAL(5,1) DEFAULT 0,
      remaining_days DECIMAL(5,1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_type_year (employee_id, leave_type_id, year)
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_leave_requests (
      id VARCHAR(50) PRIMARY KEY,
      request_number VARCHAR(30),
      employee_id VARCHAR(50) NOT NULL,
      leave_type_id VARCHAR(50) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      days_count DECIMAL(5,1) DEFAULT 0,
      reason TEXT,
      status ENUM('pending','branch_approved','hr_approved','rejected','cancelled') DEFAULT 'pending',
      branch_approved_by VARCHAR(100),
      branch_approved_at DATETIME,
      hr_approved_by VARCHAR(100),
      hr_approved_at DATETIME,
      rejected_by VARCHAR(100),
      rejected_at DATETIME,
      rejection_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_payroll_runs (
      id VARCHAR(50) PRIMARY KEY,
      run_number VARCHAR(30),
      month INT NOT NULL,
      year INT NOT NULL,
      branch_id VARCHAR(50),
      brand_id VARCHAR(50),
      status ENUM('draft','calculated','approved','paid') DEFAULT 'draft',
      total_gross DECIMAL(14,2) DEFAULT 0,
      total_deductions DECIMAL(14,2) DEFAULT 0,
      total_net DECIMAL(14,2) DEFAULT 0,
      employee_count INT DEFAULT 0,
      approved_by VARCHAR(100),
      approved_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by VARCHAR(100)
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_payroll_items (
      id VARCHAR(50) PRIMARY KEY,
      run_id VARCHAR(50) NOT NULL,
      employee_id VARCHAR(50) NOT NULL,
      employee_name VARCHAR(200),
      employee_number VARCHAR(30),
      basic_salary DECIMAL(12,2) DEFAULT 0,
      housing_allowance DECIMAL(12,2) DEFAULT 0,
      transport_allowance DECIMAL(12,2) DEFAULT 0,
      other_allowance DECIMAL(12,2) DEFAULT 0,
      overtime_amount DECIMAL(12,2) DEFAULT 0,
      overtime_hours DECIMAL(6,2) DEFAULT 0,
      gross_salary DECIMAL(12,2) DEFAULT 0,
      absence_deduction DECIMAL(12,2) DEFAULT 0,
      late_deduction DECIMAL(12,2) DEFAULT 0,
      advance_deduction DECIMAL(12,2) DEFAULT 0,
      other_deduction DECIMAL(12,2) DEFAULT 0,
      total_deductions DECIMAL(12,2) DEFAULT 0,
      net_salary DECIMAL(12,2) DEFAULT 0,
      actual_days INT DEFAULT 0,
      absent_days INT DEFAULT 0,
      late_minutes INT DEFAULT 0,
      leave_days DECIMAL(5,1) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_advances (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      remaining DECIMAL(12,2) DEFAULT 0,
      deduction_months INT DEFAULT 1,
      monthly_deduction DECIMAL(12,2) DEFAULT 0,
      request_date DATE,
      status ENUM('pending','approved','rejected','fully_paid') DEFAULT 'pending',
      approved_by VARCHAR(100),
      approved_at DATETIME,
      rejected_by VARCHAR(100),
      rejected_at DATETIME,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_documents (
      id VARCHAR(50) PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      doc_type VARCHAR(50),
      title VARCHAR(200),
      file_data LONGTEXT,
      expiry_date DATE,
      notes TEXT,
      uploaded_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  tablesReady = true;
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Seed default leave types
// ═══════════════════════════════════════════════════════════════

let leaveTypesSeeded = false;
async function seedLeaveTypes() {
  if (leaveTypesSeeded) return;
  const [existing] = await db.query('SELECT COUNT(*) as cnt FROM hr_leave_types');
  if (existing[0].cnt === 0) {
    const defaults = [
      { id: 'LT-' + Date.now(), name: 'سنوية', name_en: 'Annual', default_days: 21, is_paid: true },
      { id: 'LT-' + (Date.now() + 1), name: 'مرضية', name_en: 'Sick', default_days: 10, is_paid: true },
      { id: 'LT-' + (Date.now() + 2), name: 'طارئة', name_en: 'Emergency', default_days: 5, is_paid: true },
      { id: 'LT-' + (Date.now() + 3), name: 'بدون راتب', name_en: 'Unpaid', default_days: 0, is_paid: false }
    ];
    for (const lt of defaults) {
      await db.query(
        'INSERT INTO hr_leave_types (id, name, name_en, default_days, is_paid) VALUES (?, ?, ?, ?, ?)',
        [lt.id, lt.name, lt.name_en, lt.default_days, lt.is_paid]
      );
    }
  }
  leaveTypesSeeded = true;
}

// Middleware to ensure tables on every request
router.use(async (req, res, next) => {
  try {
    await ensureTables();
    next();
  } catch (e) {
    res.json({ success: false, error: 'HR table init failed: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// DEPARTMENTS
// ═══════════════════════════════════════════════════════════════

router.get('/departments', async (req, res) => {
  try {
    const { branch_id, branchId } = req.query;
    const filterBranch = branch_id || branchId || '';
    // Detect whether branch_id column exists (tolerate old schemas)
    let hasBranchCol = true;
    try {
      const [c] = await db.query("SHOW COLUMNS FROM hr_departments LIKE 'branch_id'");
      hasBranchCol = !!c.length;
    } catch(e) { hasBranchCol = false; }

    const joinBranch = hasBranchCol
      ? 'LEFT JOIN branches b ON d.branch_id = b.id'
      : '';
    const branchName = hasBranchCol ? 'b.name' : 'NULL';
    const branchCode = hasBranchCol ? 'b.code' : 'NULL';
    const branchIdCol = hasBranchCol ? 'd.branch_id' : 'NULL';

    let sql = `
      SELECT d.*,
        ${branchIdCol} AS branch_id_val,
        ${branchName} AS branch_name,
        ${branchCode} AS branch_code,
        (SELECT COUNT(*) FROM hr_employees e WHERE e.department_id = d.id AND e.status = 'active') as employee_count
      FROM hr_departments d
      ${joinBranch}
    `;
    const params = [];
    if (filterBranch && hasBranchCol) { sql += ' WHERE d.branch_id = ?'; params.push(filterBranch); }
    sql += ' ORDER BY d.name';

    const [rows] = await db.query(sql, params);
    res.json(rows.map(d => ({
      id: d.id,
      name: d.name || '',
      nameEn: d.name_en || '',
      code: d.code || '',
      branchId: d.branch_id_val || d.branch_id || '',
      branchName: d.branch_name || '',
      branchCode: d.branch_code || '',
      managerId: d.manager_id || '',
      parentId: d.parent_id || '',
      description: d.description || '',
      isActive: d.is_active !== false,
      employeeCount: Number(d.employee_count) || 0,
      createdAt: d.created_at,
      updatedAt: d.updated_at
    })));
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/departments', async (req, res) => {
  try {
    const { id, name, nameEn, code, branchId, managerId, parentId, description, isActive } = req.body;
    if (!name) return res.json({ success: false, error: 'اسم القسم مطلوب' });

    // Auto-generate code if not provided
    let finalCode = code;
    if (!finalCode) {
      const [maxRow] = await db.query("SELECT code FROM hr_departments WHERE code LIKE 'DEP-%' ORDER BY CAST(SUBSTRING(code, 5) AS UNSIGNED) DESC LIMIT 1");
      let nextNum = 1;
      if (maxRow.length && maxRow[0].code) {
        const m = maxRow[0].code.match(/(\d+)/);
        if (m) nextNum = parseInt(m[1]) + 1;
      }
      finalCode = 'DEP-' + String(nextNum).padStart(3, '0');
    }

    if (id) {
      // Build dynamic update based on existing columns (tolerate missing name_en)
      const fields = ['name=?'];
      const params = [name];
      try {
        const [col] = await db.query("SHOW COLUMNS FROM hr_departments LIKE 'name_en'");
        if (col.length) { fields.push('name_en=?'); params.push(nameEn || null); }
      } catch(e) {}
      try {
        const [col] = await db.query("SHOW COLUMNS FROM hr_departments LIKE 'code'");
        if (col.length) { fields.push('code=?'); params.push(finalCode); }
      } catch(e) {}
      try {
        const [col] = await db.query("SHOW COLUMNS FROM hr_departments LIKE 'branch_id'");
        if (col.length) { fields.push('branch_id=?'); params.push(branchId || null); }
      } catch(e) {}
      // v8 (G3) — manager_id / parent_id / description were parsed from the body
      // then silently DROPPED (the UPDATE never mentioned them) while the API
      // returned success:true. The columns are guaranteed now (ensureTables here
      // + addColumnIfMissing in server.js), so write them unconditionally.
      fields.push('manager_id=?', 'parent_id=?', 'description=?');
      params.push(managerId || null, parentId || null, description || null);
      params.push(id);
      await db.query(`UPDATE hr_departments SET ${fields.join(', ')} WHERE id=?`, params);
      return res.json({ success: true, id, code: finalCode });
    }

    // Insert — check which columns exist
    const newId = 'DEP-' + Date.now();
    const cols = ['id', 'name'];
    const vals = [newId, name];
    try {
      const [c] = await db.query("SHOW COLUMNS FROM hr_departments LIKE 'name_en'");
      if (c.length) { cols.push('name_en'); vals.push(nameEn || null); }
    } catch(e) {}
    try {
      const [c] = await db.query("SHOW COLUMNS FROM hr_departments LIKE 'code'");
      if (c.length) { cols.push('code'); vals.push(finalCode); }
    } catch(e) {}
    try {
      const [c] = await db.query("SHOW COLUMNS FROM hr_departments LIKE 'branch_id'");
      if (c.length) { cols.push('branch_id'); vals.push(branchId || null); }
    } catch(e) {}
    // v8 (G3) — same as the UPDATE path above: these three were parsed then
    // silently dropped on INSERT. Columns are guaranteed by the migrations.
    cols.push('manager_id', 'parent_id', 'description');
    vals.push(managerId || null, parentId || null, description || null);
    const placeholders = cols.map(() => '?').join(',');
    await db.query(`INSERT INTO hr_departments (${cols.join(',')}) VALUES (${placeholders})`, vals);
    res.json({ success: true, id: newId, code: finalCode });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.delete('/departments/:id', async (req, res) => {
  try {
    const [emps] = await db.query('SELECT COUNT(*) as cnt FROM hr_employees WHERE department_id = ?', [req.params.id]);
    if (emps[0].cnt > 0) {
      return res.json({ success: false, error: 'Cannot delete department with active employees' });
    }
    await db.query('DELETE FROM hr_departments WHERE id = ?', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// JOB TITLES (v6.18.0+ — canonical Saudi-restaurant role catalog)
// ═══════════════════════════════════════════════════════════════
// Source of truth: hr_job_titles table (seeded by migration 0004 and
// re-asserted defensively in server.js runMigrations).  The front-end
// (users CRUD form, HR employee form) calls this to populate the
// dropdown of allowed positions — replacing the legacy free-text
// job_title column with a controlled vocabulary.
router.get('/job-titles', async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || '') === '1';
    let sql = `
      SELECT id, code, name_ar, name_en, rank_level, category, default_role, is_active
        FROM hr_job_titles
    `;
    if (!includeInactive) sql += ' WHERE is_active = 1';
    sql += ' ORDER BY rank_level ASC, name_ar ASC';
    const [rows] = await db.query(sql);
    res.json({
      success: true,
      jobTitles: rows.map(r => ({
        id: r.id,
        code: r.code,
        nameAr: r.name_ar,
        nameEn: r.name_en,
        rank: Number(r.rank_level) || 7,
        category: r.category,
        defaultRole: r.default_role,
        isActive: r.is_active !== 0
      }))
    });
  } catch (e) {
    // Schema-tolerant: if the table doesn't exist yet on a brand-new
    // install (migration framework hasn't run), return an empty list
    // so the front-end falls back gracefully instead of erroring.
    if (e && /doesn'?t exist/i.test(e.message || '')) {
      return res.json({ success: true, jobTitles: [] });
    }
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// EMPLOYEES
// ═══════════════════════════════════════════════════════════════

router.get('/employees', async (req, res) => {
  try {
    const { branch_id, brand_id, department_id, status, search } = req.query;
    // Detect optional allowance columns (schema may not have all of them)
    async function colExists(col) {
      try { const [c] = await db.query("SHOW COLUMNS FROM hr_employees LIKE '" + col + "'"); return !!c.length; }
      catch(e) { return false; }
    }
    const hasFood  = await colExists('food_allowance');
    const hasComm  = await colExists('communication_allowance');
    const hasEdu   = await colExists('education_allowance');
    const hasNat   = await colExists('nature_allowance');

    const allowanceCols = [
      'COALESCE(e.housing_allowance,0) AS housingAllowance',
      'COALESCE(e.transport_allowance,0) AS transportAllowance',
      'COALESCE(e.other_allowance,0) AS otherAllowance'
    ];
    if (hasFood) allowanceCols.push('COALESCE(e.food_allowance,0) AS foodAllowance');
    if (hasComm) allowanceCols.push('COALESCE(e.communication_allowance,0) AS communicationAllowance');
    if (hasEdu)  allowanceCols.push('COALESCE(e.education_allowance,0) AS educationAllowance');
    if (hasNat)  allowanceCols.push('COALESCE(e.nature_allowance,0) AS natureAllowance');

    let sql = `
      SELECT e.id, e.employee_number AS employeeNumber,
        CONCAT(e.first_name, ' ', COALESCE(e.last_name, '')) AS fullName,
        e.first_name AS firstName, e.last_name AS lastName,
        e.phone, e.email, e.job_title AS jobTitle,
        COALESCE(d.name, '') AS departmentName,
        COALESCE(b.name, '') AS branchName,
        e.status, e.hire_date AS hireDate,
        COALESCE(e.basic_salary,0) AS basicSalary,
        ${allowanceCols.join(', ')},
        e.ignore_late_month AS ignoreLateMonth,
        e.department_id AS departmentId, e.branch_id AS branchId, e.brand_id AS brandId,
        e.employment_type AS employmentType, e.national_id AS nationalId,
        e.linked_username AS linkedUsername,
        lu.role AS linkedRole, lu.active AS linkedActive
      FROM hr_employees e
      LEFT JOIN hr_departments d ON e.department_id = d.id
      LEFT JOIN branches b ON e.branch_id = b.id
      LEFT JOIN users lu ON lu.id = e.linked_user_id
      WHERE 1=1
    `;
    const params = [];

    if (branch_id) { sql += ' AND e.branch_id = ?'; params.push(branch_id); }
    if (brand_id) { sql += ' AND e.brand_id = ?'; params.push(brand_id); }
    if (department_id) { sql += ' AND e.department_id = ?'; params.push(department_id); }
    if (status) { sql += ' AND e.status = ?'; params.push(status); }
    if (search) {
      sql += ' AND (e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_number LIKE ? OR e.phone LIKE ?)';
      const s = '%' + search + '%';
      params.push(s, s, s, s);
    }

    sql += ' ORDER BY e.created_at DESC';
    const [rows] = await db.query(sql, params);
    // Compute gross salary = basic + all allowances
    res.json(rows.map(r => {
      const basic  = Number(r.basicSalary) || 0;
      const housing = Number(r.housingAllowance) || 0;
      const transport = Number(r.transportAllowance) || 0;
      const food = Number(r.foodAllowance) || 0;
      const comm = Number(r.communicationAllowance) || 0;
      const edu  = Number(r.educationAllowance) || 0;
      const nat  = Number(r.natureAllowance) || 0;
      const other = Number(r.otherAllowance) || 0;
      const totalAllowances = housing + transport + food + comm + edu + nat + other;
      return Object.assign({}, r, {
        housingAllowance: housing,
        transportAllowance: transport,
        foodAllowance: food,
        communicationAllowance: comm,
        educationAllowance: edu,
        natureAllowance: nat,
        otherAllowance: other,
        totalAllowances: totalAllowances,
        grossSalary: basic + totalAllowances
      });
    }));
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// IDENTITY GOVERNANCE (v7.6) — users ⇄ hr_employees reconciliation
// ───────────────────────────────────────────────────────────────────
// International HRIS practice (Workday / SAP SuccessFactors / Oracle HCM /
// BambooHR): the EMPLOYEE record is the master "person"; a login account
// is a credential provisioned FROM it. No login may exist without a worker
// record (orphan accounts are an access-governance finding — ISO 27001
// A.9.2 / SOX ITGC access control).
//
// The startup backfill (server.js) already enforces this on every boot, but
// admins must not depend on a server restart to reconcile identity. These
// two endpoints expose the same logic ON-DEMAND:
//   • GET  /identity-status      → audit report of the current linkage
//   • POST /reconcile-identities → idempotent fix (create + link shells)
// Both are admin-only and the reconcile is audit-logged.
// ═══════════════════════════════════════════════════════════════════

// Admin-only guard (req.user is set by the global JWT gate in server.js).
function _hrRequireAdmin(req, res) {
  const role = (req.user && req.user.role) || '';
  if (role !== 'admin') {
    res.status(403).json({ success: false, error: 'هذه العملية متاحة للمدير (admin) فقط' });
    return false;
  }
  return true;
}

// GET /api/hr/identity-status — governance snapshot of user⇄employee linkage
router.get('/identity-status', async (req, res) => {
  if (!_hrRequireAdmin(req, res)) return;
  try {
    const [[uTot]]   = await db.query('SELECT COUNT(*) AS cnt FROM users');
    const [[eTot]]   = await db.query("SELECT COUNT(*) AS cnt FROM hr_employees WHERE deleted_at IS NULL");
    // A soft-deleted (deleted_at) employee must NOT count as a valid link, else
    // a user whose only record was deleted looks "healthy" yet is invisible in
    // HR (the list filters deleted_at). Filter it everywhere consistently.
    const [[linked]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM users u JOIN hr_employees e ON e.linked_username = u.username AND e.deleted_at IS NULL');
    // Count of logins with NO live employee record (the gap that hides users).
    const [[orphanCnt]] = await db.query(`
      SELECT COUNT(*) AS cnt FROM users u
      LEFT JOIN hr_employees e ON e.linked_username = u.username AND e.deleted_at IS NULL
      WHERE e.id IS NULL`);
    // Bounded sample of those logins for display (avoid shipping a huge array).
    const [orphanUsers] = await db.query(`
      SELECT u.username, u.role, u.active
      FROM users u
      LEFT JOIN hr_employees e ON e.linked_username = u.username AND e.deleted_at IS NULL
      WHERE e.id IS NULL
      ORDER BY u.username
      LIMIT 200`);
    // Employee records with NO login (active workers who can't sign in)
    const [[orphanEmps]] = await db.query(`
      SELECT COUNT(*) AS cnt FROM hr_employees
      WHERE (linked_username IS NULL OR linked_username = '')
        AND status <> 'terminated' AND deleted_at IS NULL`);
    // Shells created by backfill that still need real HR data
    const [[shells]] = await db.query(
      "SELECT COUNT(*) AS cnt FROM hr_employees WHERE job_title = 'بحاجة لتحديث' AND deleted_at IS NULL");
    res.json({
      success: true,
      usersTotal: uTot.cnt,
      employeesTotal: eTot.cnt,
      linkedCount: linked.cnt,
      orphanUsers: orphanUsers,                 // bounded sample (<=200) of unlinked logins
      orphanUsersCount: orphanCnt.cnt,          // true total (independent of the LIMIT)
      orphanEmployeesCount: orphanEmps.cnt,     // employees missing a login
      shellsPendingCount: shells.cnt            // shells needing data completion
    });
  } catch (e) {
    console.error('[hr/identity-status]', e.message);
    res.json({ success: false, error: 'تعذّر إنشاء تقرير الهوية' });
  }
});

// POST /api/hr/reconcile-identities — idempotent on-demand reconciliation.
// Mirrors the startup backfill (server.js steps B→D). Safe to re-run.
router.post('/reconcile-identities', async (req, res) => {
  if (!_hrRequireAdmin(req, res)) return;
  try {
    // Tolerate older schemas: make sure the linkage columns exist.
    try { await db.query("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS linked_username VARCHAR(100) NULL"); } catch (e) {}
    try { await db.query("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS linked_user_id INT NULL"); } catch (e) {}

    const [[before]] = await db.query(`
      SELECT COUNT(*) AS cnt FROM users u
      LEFT JOIN hr_employees e ON e.linked_username = u.username
      WHERE e.id IS NULL`);

    // Step B — link users that already have a matching employee row.
    await db.query(`UPDATE users u
      JOIN hr_employees e ON e.linked_username = u.username
      SET u.employee_id = e.id
      WHERE (u.employee_id IS NULL OR u.employee_id = '')`);

    // Step C — create a shell employee for every login that still has none
    // (covers admin + cashiers + managers + custody + employee, all roles).
    const [insRes] = await db.query(`INSERT IGNORE INTO hr_employees
      (id, employee_number, first_name, last_name, hire_date, status, job_title, linked_username, created_at)
      SELECT
        CONCAT('emp-shell-', u.username),
        CONCAT('SHELL-', LPAD(u.id, 6, '0')),
        COALESCE(NULLIF(TRIM(u.full_name), ''), u.username),
        '',
        COALESCE(DATE(u.created_at), CURDATE()),
        'active',
        'بحاجة لتحديث',
        u.username,
        COALESCE(u.created_at, NOW())
      FROM users u
      WHERE (u.employee_id IS NULL OR u.employee_id = '')`);

    // Step D — populate the numeric linked_user_id from the matching login.
    const [linkRes] = await db.query(`UPDATE hr_employees e
      JOIN users u ON u.username = e.linked_username
      SET e.linked_user_id = u.id
      WHERE e.linked_user_id IS NULL`);

    // Point users at the freshly-created shells.
    await db.query(`UPDATE users u
      JOIN hr_employees e ON e.id = CONCAT('emp-shell-', u.username)
      SET u.employee_id = e.id
      WHERE (u.employee_id IS NULL OR u.employee_id = '')`);

    const [[after]] = await db.query(`
      SELECT COUNT(*) AS cnt FROM users u
      LEFT JOIN hr_employees e ON e.linked_username = u.username AND e.deleted_at IS NULL
      WHERE e.id IS NULL`);
    const [[uTot]] = await db.query('SELECT COUNT(*) AS cnt FROM users');
    // If any login is still unlinked after the run, a shell INSERT was silently
    // dropped (e.g. an employee_number UNIQUE collision under INSERT IGNORE).
    // Surface which accounts so the silent failure is never invisible.
    let remaining = [];
    if (after.cnt > 0) {
      const [rem] = await db.query(`
        SELECT u.username FROM users u
        LEFT JOIN hr_employees e ON e.linked_username = u.username AND e.deleted_at IS NULL
        WHERE e.id IS NULL ORDER BY u.username LIMIT 50`);
      remaining = rem.map(r => r.username);
    }

    // Audit the governance action (uses the canonical hr_audit_log helper).
    try {
      const actor = (req.user && req.user.username) || 'system';
      await hrRules.auditLog(actor, 'reconcile_identities', 'identity', null, {
        shellsCreated: insRes.affectedRows || 0,
        linksAdded: linkRes.affectedRows || 0,
        orphansBefore: before.cnt,
        orphansAfter: after.cnt
      }, (req.ip || ''));
    } catch (e) { /* audit is best-effort — never block the fix */ }

    res.json({
      success: true,
      usersTotal: uTot.cnt,
      shellsCreated: insRes.affectedRows || 0,
      linksAdded: linkRes.affectedRows || 0,
      orphansBefore: before.cnt,
      orphansAfter: after.cnt,
      warning: after.cnt > 0
        ? ('بقي ' + after.cnt + ' حساب دون ربط (تعارض رقم وظيفي محتمل): ' + remaining.join(', '))
        : null
    });
  } catch (e) {
    console.error('[hr/reconcile-identities]', e.message);
    res.json({ success: false, error: 'تعذّرت مزامنة الهوية' });
  }
});

router.get('/employees/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT e.id, e.employee_number AS employeeNumber,
        e.first_name AS firstName, e.last_name AS lastName,
        CONCAT(e.first_name, ' ', COALESCE(e.last_name, '')) AS fullName,
        e.national_id AS nationalId, e.passport_number AS passportNumber,
        e.iqama_number AS iqamaNumber, e.phone, e.email,
        e.gender, e.date_of_birth AS dateOfBirth, e.nationality,
        e.branch_id AS branchId, e.brand_id AS brandId,
        e.department_id AS departmentId, e.position_id AS positionId,
        e.job_title AS jobTitle, e.employment_type AS employmentType,
        e.salary_type AS salaryType, e.basic_salary AS basicSalary,
        e.hourly_rate AS hourlyRate, e.housing_allowance AS housingAllowance,
        e.transport_allowance AS transportAllowance, e.other_allowance AS otherAllowance,
        e.hire_date AS hireDate, e.contract_end_date AS contractEndDate,
        e.probation_end_date AS probationEndDate, e.status,
        e.termination_date AS terminationDate, e.termination_reason AS terminationReason,
        e.bank_name AS bankName, e.bank_account AS bankAccount, e.bank_iban AS bankIban,
        e.emergency_contact_name AS emergencyContactName,
        e.emergency_contact_phone AS emergencyContactPhone,
        e.emergency_contact_relation AS emergencyContactRelation,
        e.linked_user_id AS linkedUserId, e.linked_username AS linkedUsername,
        e.notes, e.created_at AS createdAt, e.work_start AS workStart, e.work_end AS workEnd,
        COALESCE(d.name, '') AS departmentName,
        COALESCE(b.name, '') AS branchName
      FROM hr_employees e
      LEFT JOIN hr_departments d ON e.department_id = d.id
      LEFT JOIN branches b ON e.branch_id = b.id
      WHERE e.id = ?
    `, [req.params.id]);

    if (!rows.length) return res.json({ success: false, error: 'الموظف غير موجود' });
    const emp = rows[0];

    // Recent attendance (last 30 days)
    const [attendance] = await db.query(
      `SELECT * FROM hr_attendance WHERE employee_id = ? AND attendance_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ORDER BY attendance_date DESC`,
      [req.params.id]
    );

    // Leave balances (current year)
    const currentYear = new Date().getFullYear();
    const [leaveBalances] = await db.query(
      `SELECT lb.id, lb.leave_type_id AS leaveTypeId,
        lt.name AS leaveTypeName, lt.is_paid AS isPaid,
        lb.total_days AS total, lb.used_days AS used,
        lb.remaining_days AS remaining
       FROM hr_leave_balances lb
       LEFT JOIN hr_leave_types lt ON lb.leave_type_id = lt.id
       WHERE lb.employee_id = ? AND lb.year = ?`,
      [req.params.id, currentYear]
    );

    // Recent payroll items (last 3 months)
    let payrollItems = [];
    try {
      const [pi] = await db.query(
        `SELECT pi.*, pr.month, pr.year, pr.run_number
         FROM hr_payroll_items pi
         LEFT JOIN hr_payroll_runs pr ON pi.run_id = pr.id
         WHERE pi.employee_id = ?
         ORDER BY pr.year DESC, pr.month DESC
         LIMIT 3`,
        [req.params.id]
      );
      payrollItems = pi;
    } catch (e) { /* payroll tables may not exist yet */ }

    res.json({ ...emp, attendance, leaveBalances, payrollItems });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/employees', async (req, res) => {
  try {
    const b = req.body;

    // Role-assignment gate — validated BEFORE the employee INSERT so a
    // rejection cannot leave a half-created employee. This was the third,
    // unvalidated user-creation path: the INSERT below took b.userRole
    // verbatim (only the users.role ENUM stood between it and garbage), and
    // the /api/hr mount admits managers — but assigning any role above
    // 'employee' is admin's call alone (same rule as routes/auth.js).
    if (b.createUser && b.userRole && b.userRole !== 'employee') {
      const ROLES = require('../lib/roles');
      if (!ROLES.isAssignable(b.userRole)) {
        return res.status(400).json({ success: false, error: 'الدور غير صالح: ' + String(b.userRole) });
      }
      const isAdminActor = !!(req.user && (req.user.role === 'admin' || req.user.isDeveloper === true));
      if (!isAdminActor) {
        return res.status(403).json({ success: false, error: 'إسناد دور غير «موظف» يتطلب صلاحية admin' });
      }
    }

    const empId = 'EMP-' + Date.now();

    // Generate sequential employee number
    const [maxNum] = await db.query(
      `SELECT employee_number FROM hr_employees ORDER BY created_at DESC LIMIT 1`
    );
    let nextNum = 1;
    if (maxNum.length && maxNum[0].employee_number) {
      const match = maxNum[0].employee_number.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }
    const employeeNumber = 'EMP-' + String(nextNum).padStart(5, '0');

    await db.query(
      `INSERT INTO hr_employees (
        id, employee_number, first_name, last_name, national_id, passport_number, iqama_number,
        phone, email, gender, date_of_birth, nationality,
        branch_id, brand_id, department_id, position_id, job_title,
        employment_type, salary_type, basic_salary, hourly_rate,
        housing_allowance, transport_allowance, other_allowance,
        hire_date, contract_end_date, probation_end_date,
        bank_name, bank_account, bank_iban,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
        notes, status, created_by, work_start, work_end
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        empId, employeeNumber,
        b.firstName || '', b.lastName || '', b.nationalId || null, b.passportNumber || null, b.iqamaNumber || null,
        b.phone || null, b.email || null, b.gender || 'male',
        b.dateOfBirth && b.dateOfBirth.length > 0 ? b.dateOfBirth : null,
        b.nationality || null,
        b.branchId || null, b.brandId || null, b.departmentId || null, b.positionId || null, b.jobTitle || null,
        b.employmentType || 'full_time', b.salaryType || 'monthly',
        b.basicSalary || 0, b.hourlyRate || 0,
        b.housingAllowance || 0, b.transportAllowance || 0, b.otherAllowance || 0,
        b.hireDate && b.hireDate.length > 0 ? b.hireDate : null,
        b.contractEndDate && b.contractEndDate.length > 0 ? b.contractEndDate : null,
        b.probationEndDate && b.probationEndDate.length > 0 ? b.probationEndDate : null,
        b.bankName || null, b.bankAccount || null, b.bankIban || null,
        b.emergencyContactName || null, b.emergencyContactPhone || null, b.emergencyContactRelation || null,
        b.notes || null, 'active', b.username || null,
        b.workStart || '08:00', b.workEnd || '17:00'
      ]
    );

    // Update new allowance/deduction fields (separate for schema resilience)
    try {
      await db.query(
        `UPDATE hr_employees SET food_allowance=?, communication_allowance=?, education_allowance=?, nature_allowance=?, social_insurance_rate=?, fixed_deduction=? WHERE id=?`,
        [Number(b.foodAllowance)||0, Number(b.communicationAllowance)||0, Number(b.educationAllowance)||0, Number(b.natureAllowance)||0, Number(b.socialInsuranceRate)||0, Number(b.fixedDeduction)||0, empId]
      );
    } catch(e) { /* columns may not exist yet in old DB */ }

    // Optionally create a user account — auto-link branch, brand, position from HR data
    if (b.createUser && b.firstName) {
      try {
        const bcrypt = require('bcryptjs');
        const uname = (b.firstName + (b.lastName ? '.' + b.lastName : '')).toLowerCase().replace(/\s+/g, '');
        const defaultPass = b.userPassword || 'Pass@123';
        const hash = await bcrypt.hash(defaultPass, 10);
        await db.query(
          'INSERT INTO users (username, password, role, active, email, employee_id, brand_id, branch_id, position_id) VALUES (?,?,?,1,?,?,?,?,?)',
          [uname, hash, b.userRole || 'employee', b.email || '', empId, b.brandId || null, b.branchId || null, b.positionId || null]
        );
        const [userRow] = await db.query('SELECT id FROM users WHERE username = ?', [uname]);
        if (userRow.length) {
          await db.query('UPDATE hr_employees SET linked_user_id = ?, linked_username = ? WHERE id = ?', [userRow[0].id, uname, empId]);
        }
      } catch (userErr) {
        // User creation failed (duplicate username, etc.) — employee is still created
      }
    }

    res.json({ success: true, id: empId, employeeNumber });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.put('/employees/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];

    const mapping = {
      firstName: 'first_name', lastName: 'last_name', nationalId: 'national_id',
      passportNumber: 'passport_number', iqamaNumber: 'iqama_number', phone: 'phone',
      email: 'email', gender: 'gender', dateOfBirth: 'date_of_birth', nationality: 'nationality',
      branchId: 'branch_id', brandId: 'brand_id', departmentId: 'department_id',
      positionId: 'position_id', jobTitle: 'job_title', employmentType: 'employment_type',
      salaryType: 'salary_type', basicSalary: 'basic_salary', hourlyRate: 'hourly_rate',
      housingAllowance: 'housing_allowance', transportAllowance: 'transport_allowance',
      otherAllowance: 'other_allowance',
      foodAllowance: 'food_allowance', communicationAllowance: 'communication_allowance',
      educationAllowance: 'education_allowance', natureAllowance: 'nature_allowance',
      socialInsuranceRate: 'social_insurance_rate', fixedDeduction: 'fixed_deduction',
      hireDate: 'hire_date',
      contractEndDate: 'contract_end_date', probationEndDate: 'probation_end_date',
      bankName: 'bank_name', bankAccount: 'bank_account', bankIban: 'bank_iban',
      emergencyContactName: 'emergency_contact_name', emergencyContactPhone: 'emergency_contact_phone',
      emergencyContactRelation: 'emergency_contact_relation', notes: 'notes', status: 'status',
      workStart: 'work_start', workEnd: 'work_end'
    };

    var dateFields = ['date_of_birth', 'hire_date', 'contract_end_date', 'probation_end_date'];
    for (const [jsKey, dbCol] of Object.entries(mapping)) {
      if (b[jsKey] !== undefined) {
        fields.push(`${dbCol} = ?`);
        // Handle empty date strings → NULL
        if (dateFields.indexOf(dbCol) >= 0) {
          params.push(b[jsKey] && b[jsKey].length > 0 ? b[jsKey] : null);
        } else {
          params.push(b[jsKey] === '' ? null : b[jsKey]);
        }
      }
    }

    if (fields.length === 0) return res.json({ success: false, error: 'No fields to update' });

    params.push(req.params.id);
    await db.query(`UPDATE hr_employees SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/employees/:id/terminate', async (req, res) => {
  try {
    const { terminationDate, terminationReason } = req.body;
    await db.query(
      `UPDATE hr_employees SET status='terminated', termination_date=?, termination_reason=? WHERE id=?`,
      [terminationDate || new Date().toISOString().slice(0, 10), terminationReason || null, req.params.id]
    );
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Toggle ignore late for current month
router.post('/employees/:id/ignore-late', async (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7); // "2026-04"
    const [emp] = await db.query('SELECT ignore_late_month FROM hr_employees WHERE id = ?', [req.params.id]);
    if (!emp.length) return res.json({ success: false, error: 'الموظف غير موجود' });
    const isIgnored = emp[0].ignore_late_month === currentMonth;
    await db.query('UPDATE hr_employees SET ignore_late_month = ? WHERE id = ?',
      [isIgnored ? null : currentMonth, req.params.id]);
    res.json({ success: true, ignored: !isIgnored, month: currentMonth });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/employees/:id/suspend', async (req, res) => {
  try {
    await db.query(`UPDATE hr_employees SET status='suspended' WHERE id=?`, [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/employees/:id/activate', async (req, res) => {
  try {
    await db.query(`UPDATE hr_employees SET status='active' WHERE id=?`, [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// DELETE employee (soft delete)
router.delete('/employees/:id', async (req, res) => {
  try {
    // Soft delete — mark as deleted instead of removing
    const [emp] = await db.query('SELECT first_name, last_name, linked_username FROM hr_employees WHERE id = ?', [req.params.id]);
    if (!emp.length) return res.json({ success: false, error: 'الموظف غير موجود' });

    await db.query('UPDATE hr_employees SET status = ?, deleted_at = NOW() WHERE id = ?', ['terminated', req.params.id]);

    // Deactivate linked user account if exists
    if (emp[0].linked_username) {
      await db.query('UPDATE users SET active = 0 WHERE username = ?', [emp[0].linked_username]);
    }

    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// WORK SCHEDULES
// ═══════════════════════════════════════════════════════════════

router.get('/schedules', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM hr_work_schedules ORDER BY name');
    res.json(rows);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/schedules', async (req, res) => {
  try {
    const { id, name, startTime, endTime, breakMinutes, workingDays, isDefault } = req.body;
    if (id) {
      await db.query(
        `UPDATE hr_work_schedules SET name=?, start_time=?, end_time=?, break_minutes=?, working_days=?, is_default=? WHERE id=?`,
        [name, startTime, endTime, breakMinutes || 0, workingDays || '1,2,3,4,5', isDefault ? 1 : 0, id]
      );
      res.json({ success: true, id });
    } else {
      const newId = 'SCH-' + Date.now();
      if (isDefault) {
        await db.query('UPDATE hr_work_schedules SET is_default = 0');
      }
      await db.query(
        `INSERT INTO hr_work_schedules (id, name, start_time, end_time, break_minutes, working_days, is_default) VALUES (?,?,?,?,?,?,?)`,
        [newId, name, startTime, endTime, breakMinutes || 0, workingDays || '1,2,3,4,5', isDefault ? 1 : 0]
      );
      res.json({ success: true, id: newId });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ATTENDANCE
// ═══════════════════════════════════════════════════════════════

router.get('/attendance', async (req, res) => {
  try {
    const { date, employee_id, branch_id, month, year } = req.query;
    let sql = `
      SELECT a.*, CONCAT(e.first_name, ' ', e.last_name) as employee_name, e.employee_number
      FROM hr_attendance a
      LEFT JOIN hr_employees e ON a.employee_id = e.id
      WHERE 1=1
    `;
    const params = [];

    if (date) { sql += ' AND a.attendance_date = ?'; params.push(date); }
    if (employee_id) { sql += ' AND a.employee_id = ?'; params.push(employee_id); }
    if (branch_id) { sql += ' AND e.branch_id = ?'; params.push(branch_id); }
    if (month && year) {
      sql += ' AND MONTH(a.attendance_date) = ? AND YEAR(a.attendance_date) = ?';
      params.push(parseInt(month), parseInt(year));
    }

    sql += ' ORDER BY a.attendance_date DESC, a.clock_in DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(a => ({
      id: a.id, employeeId: a.employee_id, employeeName: a.employee_name,
      employeeNumber: a.employee_number, attendanceDate: a.attendance_date,
      clockIn: a.clock_in, clockOut: a.clock_out, totalHours: Number(a.total_hours)||0,
      lateMinutes: a.late_minutes||0, earlyLeaveMinutes: a.early_leave_minutes||0,
      overtimeMinutes: a.overtime_minutes||0, status: a.status, source: a.source,
      deviceName: a.device_name||'', deviceId: a.device_id||'',
      geoLat: a.geo_lat, geoLng: a.geo_lng, geoAddressIn: a.geo_address_in||'',
      geoLatOut: a.geo_lat_out, geoLngOut: a.geo_lng_out, geoAddressOut: a.geo_address_out||'',
      notes: a.notes||''
    })));
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/attendance/clock', async (req, res) => {
  try {
    const { employeeId, type, geoLat, geoLng, deviceId, source } = req.body;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (type === 'in') {
      // Check if already clocked in today without clocking out
      const [existing] = await db.query(
        'SELECT id FROM hr_attendance WHERE employee_id = ? AND attendance_date = ? AND clock_out IS NULL',
        [employeeId, today]
      );
      if (existing.length) {
        return res.json({ success: false, error: 'Already clocked in today' });
      }

      const attId = 'ATT-' + Date.now();

      // Calculate late minutes from work schedule
      let lateMinutes = 0;
      const [schedules] = await db.query('SELECT * FROM hr_work_schedules WHERE is_default = 1 LIMIT 1');
      if (schedules.length) {
        const schedule = schedules[0];
        const startParts = schedule.start_time.split(':');
        const scheduledStart = new Date(now);
        scheduledStart.setHours(parseInt(startParts[0]), parseInt(startParts[1]), 0, 0);
        if (now > scheduledStart) {
          lateMinutes = Math.floor((now - scheduledStart) / 60000);
        }
      }

      await db.query(
        `INSERT INTO hr_attendance (id, employee_id, attendance_date, clock_in, late_minutes, status, source, geo_lat, geo_lng, device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [attId, employeeId, today, now, lateMinutes, 'present', source || 'manual', geoLat || null, geoLng || null, deviceId || null]
      );
      res.json({ success: true, id: attId, lateMinutes });

    } else if (type === 'out') {
      // Find today's open record
      const [existing] = await db.query(
        'SELECT id, clock_in FROM hr_attendance WHERE employee_id = ? AND attendance_date = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1',
        [employeeId, today]
      );
      if (!existing.length) {
        return res.json({ success: false, error: 'No clock-in record found for today' });
      }

      const record = existing[0];
      const clockIn = new Date(record.clock_in);
      const totalMinutes = Math.floor((now - clockIn) / 60000);
      const totalHours = Math.round((totalMinutes / 60) * 100) / 100;

      // Calculate overtime and early leave
      let overtimeMinutes = 0;
      let earlyLeaveMinutes = 0;
      const [schedules] = await db.query('SELECT * FROM hr_work_schedules WHERE is_default = 1 LIMIT 1');
      if (schedules.length) {
        const schedule = schedules[0];
        const endParts = schedule.end_time.split(':');
        const scheduledEnd = new Date(now);
        scheduledEnd.setHours(parseInt(endParts[0]), parseInt(endParts[1]), 0, 0);
        const startParts = schedule.start_time.split(':');
        const scheduledStart = new Date(now);
        scheduledStart.setHours(parseInt(startParts[0]), parseInt(startParts[1]), 0, 0);

        const scheduledMinutes = Math.floor((scheduledEnd - scheduledStart) / 60000) - (schedule.break_minutes || 0);

        if (now < scheduledEnd) {
          earlyLeaveMinutes = Math.floor((scheduledEnd - now) / 60000);
        }
        if (totalMinutes > scheduledMinutes) {
          overtimeMinutes = totalMinutes - scheduledMinutes;
        }
      }

      await db.query(
        `UPDATE hr_attendance SET clock_out=?, total_hours=?, overtime_minutes=?, early_leave_minutes=? WHERE id=?`,
        [now, totalHours, overtimeMinutes, earlyLeaveMinutes, record.id]
      );
      res.json({ success: true, id: record.id, totalHours, overtimeMinutes, earlyLeaveMinutes });

    } else {
      res.json({ success: false, error: 'Invalid type. Use "in" or "out"' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/attendance/import', async (req, res) => {
  try {
    const records = req.body;
    if (!Array.isArray(records)) return res.json({ success: false, error: 'Expected array of records' });

    let imported = 0;
    let errors = [];

    for (const rec of records) {
      try {
        // Look up employee by number
        const [emp] = await db.query('SELECT id FROM hr_employees WHERE employee_number = ?', [rec.employeeNumber]);
        if (!emp.length) {
          errors.push(`Employee ${rec.employeeNumber} not found`);
          continue;
        }

        const empId = emp[0].id;
        const attDate = rec.date;

        // Check for existing record
        const [existing] = await db.query(
          'SELECT id FROM hr_attendance WHERE employee_id = ? AND attendance_date = ?',
          [empId, attDate]
        );

        const clockInDT = rec.clockIn ? new Date(attDate + 'T' + rec.clockIn) : null;
        const clockOutDT = rec.clockOut ? new Date(attDate + 'T' + rec.clockOut) : null;

        let totalHours = 0;
        if (clockInDT && clockOutDT) {
          totalHours = Math.round(((clockOutDT - clockInDT) / 3600000) * 100) / 100;
        }

        if (existing.length) {
          await db.query(
            `UPDATE hr_attendance SET clock_in=?, clock_out=?, total_hours=?, source='import' WHERE id=?`,
            [clockInDT, clockOutDT, totalHours, existing[0].id]
          );
        } else {
          const attId = 'ATT-' + Date.now() + '-' + imported;
          await db.query(
            `INSERT INTO hr_attendance (id, employee_id, attendance_date, clock_in, clock_out, total_hours, status, source) VALUES (?,?,?,?,?,?,?,?)`,
            [attId, empId, attDate, clockInDT, clockOutDT, totalHours, 'present', 'import']
          );
        }
        imported++;
      } catch (recErr) {
        errors.push(`Row error: ${recErr.message}`);
      }
    }

    res.json({ success: true, imported, errors });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// DELETE attendance record (developer only)
router.delete('/attendance/:id', async (req, res) => {
  try {
    // Verify requester is developer/admin
    const username = req.user ? req.user.username : '';
    const role = req.user ? req.user.role : '';
    if (role !== 'admin') {
      // Check developer flag
      const [meta] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'user_meta'");
      let isDev = false;
      if (meta.length) {
        try { const m = JSON.parse(meta[0].setting_value || '{}'); isDev = !!(m[username] && m[username].isDeveloper); } catch(e) {}
      }
      if (!isDev) return res.json({ success: false, error: 'هذه العملية متاحة للمطور فقط' });
    }
    await db.query('DELETE FROM hr_attendance WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/attendance/:id', async (req, res) => {
  try {
    const { clockIn, clockOut, status, notes, modifiedBy, modifiedReason } = req.body;
    const fields = [];
    const params = [];

    if (clockIn !== undefined) { fields.push('clock_in = ?'); params.push(clockIn); }
    if (clockOut !== undefined) { fields.push('clock_out = ?'); params.push(clockOut); }
    if (status !== undefined) { fields.push('status = ?'); params.push(status); }
    if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
    if (modifiedBy) { fields.push('modified_by = ?'); params.push(modifiedBy); }
    if (modifiedReason) { fields.push('modified_reason = ?'); params.push(modifiedReason); }

    // Recalculate total hours if both clock_in and clock_out are present
    if (clockIn && clockOut) {
      const cin = new Date(clockIn);
      const cout = new Date(clockOut);
      const totalHours = Math.round(((cout - cin) / 3600000) * 100) / 100;
      fields.push('total_hours = ?');
      params.push(totalHours);
    }

    if (fields.length === 0) return res.json({ success: false, error: 'No fields to update' });

    params.push(req.params.id);
    await db.query(`UPDATE hr_attendance SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/attendance/summary', async (req, res) => {
  try {
    const { month, year, branch_id } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    let empFilter = 'WHERE e.status = ?';
    const empParams = ['active'];
    if (branch_id) {
      empFilter += ' AND e.branch_id = ?';
      empParams.push(branch_id);
    }

    const [employees] = await db.query(
      `SELECT e.id, e.employee_number, CONCAT(e.first_name, ' ', COALESCE(e.last_name, '')) as fullName
       FROM hr_employees e ${empFilter}`,
      empParams
    );

    // Get total working days in the month (approx, excluding weekends Fri/Sat by default)
    const daysInMonth = new Date(y, m, 0).getDate();
    let workingDaysInMonth = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dayOfWeek = new Date(y, m - 1, d).getDay(); // 0=Sun, 5=Fri, 6=Sat
      if (dayOfWeek !== 5 && dayOfWeek !== 6) workingDaysInMonth++;
    }

    const summary = [];
    for (const emp of employees) {
      const [records] = await db.query(
        `SELECT * FROM hr_attendance
         WHERE employee_id = ? AND MONTH(attendance_date) = ? AND YEAR(attendance_date) = ?`,
        [emp.id, m, y]
      );

      let presentDays = 0;
      let lateDays = 0;
      let totalLateMinutes = 0;
      let totalOvertimeMinutes = 0;

      for (const r of records) {
        if (r.status === 'present') presentDays++;
        if (r.late_minutes > 0) {
          lateDays++;
          totalLateMinutes += r.late_minutes;
        }
        totalOvertimeMinutes += r.overtime_minutes || 0;
      }

      const absentDays = workingDaysInMonth - presentDays;

      summary.push({
        employeeId: emp.id,
        employeeNumber: emp.employee_number,
        employeeName: emp.fullName,
        presentDays,
        absentDays: absentDays > 0 ? absentDays : 0,
        lateDays,
        totalLateMinutes,
        totalOvertimeMinutes,
        workingDaysInMonth
      });
    }

    res.json(summary);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// LEAVE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

router.get('/leave-types', async (req, res) => {
  try {
    await seedLeaveTypes();
    const [rows] = await db.query('SELECT * FROM hr_leave_types ORDER BY name');
    res.json(rows);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/leave-types', async (req, res) => {
  try {
    const { id, name, nameEn, defaultDays, isPaid, isActive } = req.body;
    if (id) {
      await db.query(
        `UPDATE hr_leave_types SET name=?, name_en=?, default_days=?, is_paid=?, is_active=? WHERE id=?`,
        [name, nameEn || null, defaultDays || 0, isPaid !== false ? 1 : 0, isActive !== false ? 1 : 0, id]
      );
      res.json({ success: true, id });
    } else {
      const newId = 'LT-' + Date.now();
      await db.query(
        `INSERT INTO hr_leave_types (id, name, name_en, default_days, is_paid, is_active) VALUES (?,?,?,?,?,?)`,
        [newId, name, nameEn || null, defaultDays || 0, isPaid !== false ? 1 : 0, isActive !== false ? 1 : 0]
      );
      res.json({ success: true, id: newId });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/leave-balances/:employeeId', async (req, res) => {
  try {
    await seedLeaveTypes();
    const currentYear = new Date().getFullYear();
    const [rows] = await db.query(
      `SELECT lb.*, lt.name as leave_type_name, lt.name_en as leave_type_name_en, lt.is_paid
       FROM hr_leave_balances lb
       LEFT JOIN hr_leave_types lt ON lb.leave_type_id = lt.id
       WHERE lb.employee_id = ? AND lb.year = ?`,
      [req.params.employeeId, currentYear]
    );
    res.json(rows);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/leave-balances/init', async (req, res) => {
  try {
    const { year, leaveTypeId, days } = req.body;
    const targetYear = year || new Date().getFullYear();

    const [activeEmps] = await db.query("SELECT id, hire_date FROM hr_employees WHERE status = 'active'");
    let created = 0;
    let updated = 0;

    for (const emp of activeEmps) {
      // Auto-calculate annual leave: 30 days if 5+ years, 21 days otherwise
      let totalDays = days;
      if (leaveTypeId === 'LT-ANNUAL' && !days) {
        const hireDate = emp.hire_date ? new Date(emp.hire_date) : new Date();
        const yearsOfService = (new Date().getFullYear() - hireDate.getFullYear());
        totalDays = yearsOfService >= 5 ? 30 : 21;
      }
      if (!totalDays) totalDays = 21;

      const [existing] = await db.query(
        'SELECT id FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
        [emp.id, leaveTypeId, targetYear]
      );

      if (existing.length) {
        await db.query(
          'UPDATE hr_leave_balances SET total_days = ?, remaining_days = total_days - used_days WHERE id = ?',
          [totalDays, existing[0].id]
        );
        updated++;
      } else {
        const balId = 'LB-' + Date.now() + '-' + created;
        await db.query(
          `INSERT INTO hr_leave_balances (id, employee_id, leave_type_id, year, total_days, used_days, remaining_days) VALUES (?,?,?,?,?,0,?)`,
          [balId, emp.id, leaveTypeId, targetYear, totalDays, totalDays]
        );
        created++;
      }
    }

    res.json({ success: true, created, updated, total: activeEmps.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/leave-requests', async (req, res) => {
  try {
    const { status, employee_id, branch_id } = req.query;
    let sql = `
      SELECT lr.*,
             CONCAT(COALESCE(e.first_name,''), ' ', COALESCE(e.last_name,'')) AS employee_name,
             e.employee_number,
             b.name AS branch_name,
             lt.name AS leave_type_name,
             lt.is_paid AS leave_type_paid
      FROM hr_leave_requests lr
      LEFT JOIN hr_employees e ON lr.employee_id = e.id
      LEFT JOIN branches b ON e.branch_id = b.id
      LEFT JOIN hr_leave_types lt ON lr.leave_type_id = lt.id
      WHERE 1=1
    `;
    const params = [];

    if (status) { sql += ' AND lr.status = ?'; params.push(status); }
    if (employee_id) { sql += ' AND lr.employee_id = ?'; params.push(employee_id); }
    if (branch_id) { sql += ' AND e.branch_id = ?'; params.push(branch_id); }

    sql += ' ORDER BY lr.created_at DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: (r.employee_name || '').trim(),
      employeeNumber: r.employee_number || '',
      branchName: r.branch_name || '',
      leaveTypeId: r.leave_type_id,
      leaveTypeName: r.leave_type_name || '',
      leaveTypePaid: !!r.leave_type_paid,
      startDate: r.start_date,
      endDate: r.end_date,
      daysCount: Number(r.days_count) || 0,
      reason: r.reason || '',
      status: r.status,
      branchApprovedBy: r.branch_approved_by || '',
      branchApprovedAt: r.branch_approved_at,
      hrApprovedBy: r.hr_approved_by || '',
      hrApprovedAt: r.hr_approved_at,
      rejectedBy: r.rejected_by || '',
      rejectedAt: r.rejected_at,
      rejectionReason: r.rejection_reason || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })));
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/leave-requests', async (req, res) => {
  try {
    const { employeeId, leaveTypeId, startDate, endDate, reason } = req.body;

    // Calculate days count
    const start = new Date(startDate);
    const end = new Date(endDate);
    const daysCount = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    if (daysCount <= 0) return res.json({ success: false, error: 'End date must be after start date' });

    // Check leave balance
    const currentYear = new Date().getFullYear();
    const [balances] = await db.query(
      'SELECT remaining_days FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
      [employeeId, leaveTypeId, currentYear]
    );

    // Check if this leave type is paid
    const [leaveType] = await db.query('SELECT is_paid FROM hr_leave_types WHERE id = ?', [leaveTypeId]);
    let excessDays = 0;
    let deductFromSalary = false;
    if (leaveType.length && leaveType[0].is_paid) {
      if (!balances.length) {
        return res.json({ success: false, error: 'لا يوجد رصيد إجازات. يرجى تهيئة الأرصدة أولاً.' });
      }
      if (balances[0].remaining_days < daysCount) {
        // Allow but flag excess for salary deduction
        excessDays = daysCount - balances[0].remaining_days;
        deductFromSalary = true;
      }
    }

    // Generate sequential request number
    const [maxReq] = await db.query('SELECT request_number FROM hr_leave_requests ORDER BY created_at DESC LIMIT 1');
    let nextReqNum = 1;
    if (maxReq.length && maxReq[0].request_number) {
      const match = maxReq[0].request_number.match(/(\d+)$/);
      if (match) nextReqNum = parseInt(match[1], 10) + 1;
    }
    const requestNumber = 'LR-' + String(nextReqNum).padStart(5, '0');

    const reqId = 'LREQ-' + Date.now();
    await db.query(
      `INSERT INTO hr_leave_requests (id, request_number, employee_id, leave_type_id, start_date, end_date, days_count, reason, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [reqId, requestNumber, employeeId, leaveTypeId, startDate, endDate, daysCount, reason || null, 'pending']
    );

    // Calculate daily cost for salary deduction info
    let dailyCost = 0;
    if (deductFromSalary) {
      const [emp] = await db.query('SELECT basic_salary, work_start, work_end FROM hr_employees WHERE id = ?', [employeeId]);
      if (emp.length) {
        const salary = Number(emp[0].basic_salary) || 0;
        dailyCost = Math.round((salary / 30) * 100) / 100; // Daily rate based on 30-day month
      }
    }

    res.json({
      success: true, id: reqId, requestNumber, daysCount,
      excessDays: excessDays,
      deductFromSalary: deductFromSalary,
      deductionAmount: deductFromSalary ? Math.round(excessDays * dailyCost * 100) / 100 : 0,
      warning: deductFromSalary ? 'الإجازة تتجاوز الرصيد بـ ' + excessDays + ' يوم — سيتم خصم ' + Math.round(excessDays * dailyCost) + ' من الراتب' : ''
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/leave-requests/:id/approve', async (req, res) => {
  try {
    const { username, level } = req.body;
    const now = new Date();

    const [lr] = await db.query('SELECT * FROM hr_leave_requests WHERE id = ?', [req.params.id]);
    if (!lr.length) return res.json({ success: false, error: 'Leave request not found' });
    const request = lr[0];

    if (level === 'branch') {
      await db.query(
        `UPDATE hr_leave_requests SET status='branch_approved', branch_approved_by=?, branch_approved_at=? WHERE id=?`,
        [username, now, req.params.id]
      );
    } else if (level === 'hr') {
      // Deduct from leave balance
      const currentYear = new Date().getFullYear();
      await db.query(
        `UPDATE hr_leave_balances SET used_days = used_days + ?, remaining_days = remaining_days - ?
         WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
        [request.days_count, request.days_count, request.employee_id, request.leave_type_id, currentYear]
      );

      await db.query(
        `UPDATE hr_leave_requests SET status='hr_approved', hr_approved_by=?, hr_approved_at=? WHERE id=?`,
        [username, now, req.params.id]
      );
    } else {
      return res.json({ success: false, error: 'Invalid approval level. Use "branch" or "hr"' });
    }

    res.json({ success: true, id: req.params.id, status: level === 'branch' ? 'branch_approved' : 'hr_approved' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/leave-requests/:id/reject', async (req, res) => {
  try {
    const { username, reason } = req.body;
    await db.query(
      `UPDATE hr_leave_requests SET status='rejected', rejected_by=?, rejected_at=?, rejection_reason=? WHERE id=?`,
      [username, new Date(), reason || null, req.params.id]
    );
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PAYROLL
// ═══════════════════════════════════════════════════════════════

router.get('/payroll-runs', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT pr.*, COALESCE(b.name,'') AS branch_name
      FROM hr_payroll_runs pr
      LEFT JOIN branches b ON pr.branch_id = b.id
      ORDER BY pr.year DESC, pr.month DESC`);
    res.json(rows.map(r => ({
      id: r.id, runNumber: r.run_number,
      month: r.month, year: r.year, periodMonth: r.month, periodYear: r.year,
      branchId: r.branch_id, branchName: r.branch_name || '',
      brandId: r.brand_id, status: r.status,
      totalGross: Number(r.total_gross)||0, totalDeductions: Number(r.total_deductions)||0,
      totalNet: Number(r.total_net)||0, employeeCount: r.employee_count||0,
      createdBy: r.created_by, createdAt: r.created_at
    })));
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/payroll-runs', async (req, res) => {
  try {
    const { month, year, branchId, brandId, username } = req.body;
    const runNumber = 'PR-' + year + '-' + String(month).padStart(2, '0');
    const runId = 'PRUN-' + Date.now();

    // Check for duplicate run
    const [existing] = await db.query(
      'SELECT id FROM hr_payroll_runs WHERE month = ? AND year = ? AND (branch_id = ? OR (branch_id IS NULL AND ? IS NULL))',
      [month, year, branchId || null, branchId || null]
    );
    if (existing.length) {
      return res.json({ success: false, error: 'Payroll run already exists for this period and branch' });
    }

    await db.query(
      `INSERT INTO hr_payroll_runs (id, run_number, month, year, branch_id, brand_id, status, created_by) VALUES (?,?,?,?,?,?,?,?)`,
      [runId, runNumber, month, year, branchId || null, brandId || null, 'draft', username || null]
    );
    res.json({ success: true, id: runId, runNumber });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/payroll-runs/:id/calculate', async (req, res) => {
  try {
    const runId = req.params.id;
    const [runs] = await db.query('SELECT * FROM hr_payroll_runs WHERE id = ?', [runId]);
    if (!runs.length) return res.json({ success: false, error: 'Payroll run not found' });
    const run = runs[0];

    // Get all active employees matching the run's branch/brand
    let empSql = "SELECT * FROM hr_employees WHERE status = 'active'";
    const empParams = [];
    if (run.branch_id) { empSql += ' AND branch_id = ?'; empParams.push(run.branch_id); }
    if (run.brand_id) { empSql += ' AND brand_id = ?'; empParams.push(run.brand_id); }
    const [employees] = await db.query(empSql, empParams);

    // Get working days in the month (exclude Fri/Sat)
    const daysInMonth = new Date(run.year, run.month, 0).getDate();
    let workingDaysInMonth = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(run.year, run.month - 1, d).getDay();
      if (dow !== 5 && dow !== 6) workingDaysInMonth++;
    }

    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;
    let empCount = 0;

    // Delete previous items for this run (recalculate)
    await db.query('DELETE FROM hr_payroll_items WHERE run_id = ?', [runId]);

    for (const emp of employees) {
      // Use Rules Engine for unified calculation (applies shifts + exceptions automatically)
      const monthly = await hrRules.calculateMonthlyAttendance(emp.id, run.year, run.month);
      // Excused days count as worked (no absence deduction)
      let actualDays = monthly.presentDays + (monthly.excusedDays || 0);
      let totalLateMin = monthly.totalLateMinutes;
      let totalOvertimeMin = monthly.totalOvertimeMinutes;
      // Backward compat: still query attendance for stats not in rules engine
      const [attRecords] = await db.query(
        `SELECT * FROM hr_attendance WHERE employee_id = ? AND MONTH(attendance_date) = ? AND YEAR(attendance_date) = ?`,
        [emp.id, run.month, run.year]
      );

      // 2. Get approved leave days for the month
      const [leaveRecords] = await db.query(
        `SELECT lr.days_count, lt.is_paid
         FROM hr_leave_requests lr
         LEFT JOIN hr_leave_types lt ON lr.leave_type_id = lt.id
         WHERE lr.employee_id = ? AND lr.status = 'hr_approved'
           AND ((lr.start_date BETWEEN ? AND ?) OR (lr.end_date BETWEEN ? AND ?))`,
        [
          emp.id,
          `${run.year}-${String(run.month).padStart(2, '0')}-01`,
          `${run.year}-${String(run.month).padStart(2, '0')}-${daysInMonth}`,
          `${run.year}-${String(run.month).padStart(2, '0')}-01`,
          `${run.year}-${String(run.month).padStart(2, '0')}-${daysInMonth}`
        ]
      );

      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;
      for (const lv of leaveRecords) {
        if (lv.is_paid) paidLeaveDays += Number(lv.days_count);
        else unpaidLeaveDays += Number(lv.days_count);
      }

      // Check if paid leave exceeds balance — excess = deducted from salary
      let excessLeaveDays = 0;
      const [leaveBal] = await db.query(
        "SELECT remaining_days FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = 'LT-ANNUAL' AND year = ?",
        [emp.id, run.year]);
      if (leaveBal.length && paidLeaveDays > 0) {
        const remaining = Number(leaveBal[0].remaining_days) || 0;
        if (paidLeaveDays > remaining) {
          excessLeaveDays = paidLeaveDays - remaining;
          paidLeaveDays = remaining; // Only count what's in balance as paid
        }
      }

      // 3. Calculate salary — include all allowance types
      const basicSalary = Number(emp.basic_salary) || 0;
      const housingAllowance = Number(emp.housing_allowance) || 0;
      const transportAllowance = Number(emp.transport_allowance) || 0;
      const otherAllowance = Number(emp.other_allowance) || 0;
      const foodAllowance = Number(emp.food_allowance) || 0;
      const communicationAllowance = Number(emp.communication_allowance) || 0;
      const educationAllowance = Number(emp.education_allowance) || 0;
      const natureAllowance = Number(emp.nature_allowance) || 0;

      // Overtime: (basic/30/8) * 1.5 * overtime_hours
      const overtimeHours = Math.round((totalOvertimeMin / 60) * 100) / 100;
      const overtimeRate = (basicSalary / 30 / 8) * 1.5;
      const overtimeAmount = Math.round(overtimeRate * overtimeHours * 100) / 100;

      const totalAllowances = housingAllowance + transportAllowance + otherAllowance + foodAllowance + communicationAllowance + educationAllowance + natureAllowance;
      const gross = basicSalary + totalAllowances + overtimeAmount;

      // Social insurance (employee share — deducted from salary)
      const insuranceRate = Number(emp.social_insurance_rate) || 0;
      const socialInsurance = Math.round((basicSalary * insuranceRate / 100) * 100) / 100;

      // Fixed monthly deduction (contract-level)
      const fixedDeduction = Number(emp.fixed_deduction) || 0;

      // Deductions
      const dailyRate = basicSalary / 30;
      const absentDays = Math.max(0, workingDaysInMonth - actualDays - paidLeaveDays);
      const absenceDeduction = Math.round(dailyRate * (absentDays + unpaidLeaveDays + excessLeaveDays) * 100) / 100;
      const lateDeduction = Math.round((dailyRate / 9) * (totalLateMin / 60) * 100) / 100; // 9-hour workday

      // Advance deductions — only 'approved' advances with remaining > 0
      let advanceDeduction = 0;
      let advances = [];
      try {
        const [rows] = await db.query(
          "SELECT id, COALESCE(remaining, amount, 0) AS remaining, COALESCE(monthly_deduction, 0) AS monthly_deduction FROM hr_advances WHERE employee_id = ? AND status = 'approved' AND COALESCE(remaining, amount, 0) > 0",
          [emp.id]
        );
        advances = rows;
      } catch(e) { /* old schema — skip */ }
      for (const adv of advances) {
        const deduct = Math.min(Number(adv.remaining), Number(adv.monthly_deduction) || Number(adv.remaining));
        advanceDeduction += deduct;
        const newRemaining = Math.max(0, Number(adv.remaining) - deduct);
        try {
          await db.query(
            `UPDATE hr_advances SET remaining = ?, status = ? WHERE id = ?`,
            [newRemaining, newRemaining <= 0 ? 'fully_paid' : 'approved', adv.id]
          );
        } catch(e) { /* ignore schema issues */ }
      }

      const totalDeduct = absenceDeduction + lateDeduction + advanceDeduction + socialInsurance + fixedDeduction;
      const net = Math.round((gross - totalDeduct) * 100) / 100;

      // 4. Insert payroll item (with all new fields)
      const itemId = 'PI-' + Date.now() + '-' + empCount;
      await db.query(
        `INSERT INTO hr_payroll_items (
          id, run_id, employee_id, employee_name, employee_number,
          basic_salary, housing_allowance, transport_allowance, other_allowance,
          food_allowance, communication_allowance, education_allowance, nature_allowance,
          overtime_amount, overtime_hours, gross_salary,
          absence_deduction, late_deduction, advance_deduction, social_insurance, fixed_deduction, other_deduction, total_deductions,
          net_salary, actual_days, absent_days, late_minutes, leave_days
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          itemId, runId, emp.id,
          emp.first_name + ' ' + emp.last_name, emp.employee_number,
          basicSalary, housingAllowance, transportAllowance, otherAllowance,
          foodAllowance, communicationAllowance, educationAllowance, natureAllowance,
          overtimeAmount, overtimeHours, Math.round(gross * 100) / 100,
          absenceDeduction, lateDeduction, advanceDeduction, socialInsurance, fixedDeduction, 0, Math.round(totalDeduct * 100) / 100,
          net, actualDays, absentDays > 0 ? absentDays : 0, totalLateMin, paidLeaveDays + unpaidLeaveDays
        ]
      );

      totalGross += gross;
      totalDeductions += totalDeduct;
      totalNet += net;
      empCount++;
    }

    // Update run totals
    await db.query(
      `UPDATE hr_payroll_runs SET status='calculated', total_gross=?, total_deductions=?, total_net=?, employee_count=? WHERE id=?`,
      [Math.round(totalGross * 100) / 100, Math.round(totalDeductions * 100) / 100, Math.round(totalNet * 100) / 100, empCount, runId]
    );

    res.json({ success: true, id: runId, employeeCount: empCount, totalGross: Math.round(totalGross * 100) / 100, totalNet: Math.round(totalNet * 100) / 100 });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/payroll-runs/:id/approve', requireCapability('hr.payroll.approve'), async (req, res) => {
  try {
    const username = _actor(req); // FC-P1b — actor from JWT
    // FC-P1b — claim the run under a row lock and refuse re-approval so the
    // accrual/deductions journals can never be posted twice (double-post).
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT status FROM hr_payroll_runs WHERE id=? FOR UPDATE', [req.params.id]);
      if (!rows.length) return { error: 'المسير غير موجود' };
      if (rows[0].status === 'approved' || rows[0].status === 'paid') return { error: 'المسير معتمد بالفعل' };
      await conn.query(`UPDATE hr_payroll_runs SET status='approved', approved_by=?, approved_at=? WHERE id=?`,
        [username, new Date(), req.params.id]);
      // Auto-post to GL (accrual + deductions journals). A GL failure does NOT
      // roll back the approval — it is surfaced as a warning (legacy behaviour).
      try {
        return { glResult: await hrGLPosting.postPayrollJournals(req.params.id, username) };
      } catch (glErr) {
        console.error('[Payroll GL] Failed to post journals:', glErr.message);
        return { glWarning: 'تم الاعتماد لكن فشل ترحيل القيود: ' + glErr.message };
      }
    });
    if (out.error) return res.json({ success: false, error: out.error });
    if (out.glWarning) return res.json({ success: true, id: req.params.id, glWarning: out.glWarning });
    const glResult = out.glResult;
    res.json({
      success: true, id: req.params.id,
      glPosted: !!glResult,
      accrualJournal: glResult && glResult.accrual ? glResult.accrual.journalNumber : null,
      deductionsJournal: glResult && glResult.deductions ? glResult.deductions.journalNumber : null
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Pay payroll run — creates payment journal (bank → payable)
router.post('/payroll-runs/:id/pay', requireCapability('hr.payroll.pay'), async (req, res) => {
  try {
    const username = _actor(req); // FC-P1b — actor from JWT
    const { bankAccountId } = req.body;
    if (!bankAccountId) return res.json({ success: false, error: 'اختر حساب البنك/الصندوق' });
    // FC-P1b — claim the run under a row lock; refuse unless approved + not paid,
    // then stamp 'paid' inside the lock so a concurrent pay can't double-pay.
    const out = await db.withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT status FROM hr_payroll_runs WHERE id=? FOR UPDATE', [req.params.id]);
      if (!rows.length) return { error: 'المسير غير موجود' };
      if (rows[0].status === 'paid') return { error: 'المسير مدفوع بالفعل' };
      if (rows[0].status !== 'approved') return { error: 'يجب اعتماد المسير قبل الصرف' };
      const result = await hrGLPosting.postPayrollPaymentJournal(req.params.id, bankAccountId, username);
      await conn.query(`UPDATE hr_payroll_runs SET status='paid' WHERE id=?`, [req.params.id]);
      return { result };
    });
    if (out.error) return res.json({ success: false, error: out.error });
    res.json(out.result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/payroll-runs/:id/items', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM hr_payroll_items WHERE run_id = ? ORDER BY employee_name',
      [req.params.id]
    );
    res.json(rows.map(r => ({
      id: r.id, runId: r.run_id, employeeId: r.employee_id,
      employeeName: r.employee_name || '', employeeNumber: r.employee_number || '',
      basicSalary: Number(r.basic_salary)||0,
      housingAllowance: Number(r.housing_allowance)||0,
      transportAllowance: Number(r.transport_allowance)||0,
      otherAllowance: Number(r.other_allowance)||0,
      overtimeAmount: Number(r.overtime_amount)||0,
      overtimeHours: Number(r.overtime_hours)||0,
      grossSalary: Number(r.gross_salary)||0,
      absenceDeduction: Number(r.absence_deduction)||0,
      lateDeduction: Number(r.late_deduction)||0,
      advanceDeduction: Number(r.advance_deduction)||0,
      otherDeduction: Number(r.other_deduction)||0,
      totalDeductions: Number(r.total_deductions)||0,
      netSalary: Number(r.net_salary)||0,
      actualDays: r.actual_days||0, absentDays: r.absent_days||0,
      lateMinutes: r.late_minutes||0, leaveDays: r.leave_days||0
    })));
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Excel export for payroll run
router.get('/payroll-runs/:id/export', async (req, res) => {
  try {
    const [runs] = await db.query(
      `SELECT pr.*, COALESCE(b.name,'') AS branch_name FROM hr_payroll_runs pr LEFT JOIN branches b ON pr.branch_id=b.id WHERE pr.id = ?`,
      [req.params.id]);
    if (!runs.length) return res.status(404).json({ success:false, error: 'الدورة غير موجودة' });
    const run = runs[0];
    const [items] = await db.query('SELECT * FROM hr_payroll_items WHERE run_id = ? ORDER BY employee_name', [req.params.id]);

    const months = ['','يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const headers = ['الرقم','الاسم','الأساسي','بدل سكن','بدل نقل','بدل أخرى','إضافي','الإجمالي','خصم غياب','خصم تأخير','خصم سلف','خصم أخرى','إجمالي الخصم','الصافي','أيام عمل','أيام غياب','د. تأخير','أيام إجازة'];
    const bom = '\uFEFF';
    const rows = [headers.join(',')];
    let totals = { basic:0, housing:0, transport:0, other:0, ot:0, gross:0, absD:0, lateD:0, advD:0, othD:0, totalD:0, net:0 };
    items.forEach(i => {
      totals.basic += Number(i.basic_salary)||0;
      totals.housing += Number(i.housing_allowance)||0;
      totals.transport += Number(i.transport_allowance)||0;
      totals.other += Number(i.other_allowance)||0;
      totals.ot += Number(i.overtime_amount)||0;
      totals.gross += Number(i.gross_salary)||0;
      totals.absD += Number(i.absence_deduction)||0;
      totals.lateD += Number(i.late_deduction)||0;
      totals.advD += Number(i.advance_deduction)||0;
      totals.othD += Number(i.other_deduction)||0;
      totals.totalD += Number(i.total_deductions)||0;
      totals.net += Number(i.net_salary)||0;
      rows.push([
        // Employee number and name are user-controlled and were emitted with
        // no formula guard — the number wasn't even quoted. Excel evaluates a
        // leading `=`/`+`/`@` whether or not the cell is quoted.
        CSVC.csvCell(i.employee_number||''), CSVC.csvCell(i.employee_name||''),
        (Number(i.basic_salary)||0).toFixed(2), (Number(i.housing_allowance)||0).toFixed(2),
        (Number(i.transport_allowance)||0).toFixed(2), (Number(i.other_allowance)||0).toFixed(2),
        (Number(i.overtime_amount)||0).toFixed(2), (Number(i.gross_salary)||0).toFixed(2),
        (Number(i.absence_deduction)||0).toFixed(2), (Number(i.late_deduction)||0).toFixed(2),
        (Number(i.advance_deduction)||0).toFixed(2), (Number(i.other_deduction)||0).toFixed(2),
        (Number(i.total_deductions)||0).toFixed(2), (Number(i.net_salary)||0).toFixed(2),
        i.actual_days||0, i.absent_days||0, i.late_minutes||0, i.leave_days||0
      ].join(','));
    });
    rows.push(['','الإجمالي', totals.basic.toFixed(2), totals.housing.toFixed(2), totals.transport.toFixed(2),
      totals.other.toFixed(2), totals.ot.toFixed(2), totals.gross.toFixed(2),
      totals.absD.toFixed(2), totals.lateD.toFixed(2), totals.advD.toFixed(2), totals.othD.toFixed(2),
      totals.totalD.toFixed(2), totals.net.toFixed(2), '','','',''].join(','));

    const filename = 'payroll_' + (run.run_number || req.params.id) + '_' + (months[run.month]||'') + '_' + run.year + '.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename) + '"');
    res.send(bom + rows.join('\r\n'));
  } catch (e) { res.status(500).json({ success:false, error: e.message }); }
});

router.get('/payroll-runs/:id/payslip/:empId', async (req, res) => {
  try {
    const [items] = await db.query(
      'SELECT * FROM hr_payroll_items WHERE run_id = ? AND employee_id = ?',
      [req.params.id, req.params.empId]
    );
    if (!items.length) return res.json({ success: false, error: 'Payslip not found' });

    const item = items[0];

    // Get employee details
    const [emp] = await db.query(
      `SELECT e.*, COALESCE(d.name,'') as department_name, COALESCE(b.name,'') as branch_name
       FROM hr_employees e
       LEFT JOIN hr_departments d ON e.department_id = d.id
       LEFT JOIN branches b ON e.branch_id = b.id
       WHERE e.id = ?`,
      [req.params.empId]
    );

    // Get run details
    const [run] = await db.query('SELECT * FROM hr_payroll_runs WHERE id = ?', [req.params.id]);

    res.json({
      payrollItem: item,
      employee: emp.length ? emp[0] : null,
      run: run.length ? run[0] : null
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADVANCES
// ═══════════════════════════════════════════════════════════════

router.get('/advances', async (req, res) => {
  try {
    const { employee_id, status } = req.query;
    let sql = `
      SELECT a.*,
             CONCAT(COALESCE(e.first_name,''), ' ', COALESCE(e.last_name,'')) AS employee_name,
             e.employee_number,
             b.name AS branch_name,
             d.name AS dept_name
      FROM hr_advances a
      LEFT JOIN hr_employees e ON a.employee_id = e.id
      LEFT JOIN branches b ON e.branch_id = b.id
      LEFT JOIN hr_departments d ON e.department_id = d.id
      WHERE 1=1
    `;
    const params = [];
    if (employee_id) { sql += ' AND a.employee_id = ?'; params.push(employee_id); }
    if (status) { sql += ' AND a.status = ?'; params.push(status); }
    sql += ' ORDER BY a.created_at DESC';

    const [rows] = await db.query(sql, params);
    res.json(rows.map(a => {
      const amount = Number(a.amount) || 0;
      const remaining = Number(a.remaining != null ? a.remaining : amount);
      const paid = Math.max(0, amount - remaining);
      return {
        id: a.id,
        employeeId: a.employee_id,
        employeeName: (a.employee_name || '').trim(),
        employeeNumber: a.employee_number || '',
        branchName: a.branch_name || '',
        deptName: a.dept_name || '',
        amount: amount,
        remaining: remaining,
        remainingAmount: remaining,  // alias for legacy frontend
        paid: paid,
        deductionMonths: Number(a.deduction_months) || 1,
        monthlyDeduction: Number(a.monthly_deduction) || 0,
        requestDate: a.request_date,
        status: a.status,
        approvedBy: a.approved_by || '',
        approvedAt: a.approved_at,
        rejectedBy: a.rejected_by || '',
        rejectedAt: a.rejected_at,
        notes: a.notes || '',
        createdAt: a.created_at,
        updatedAt: a.updated_at
      };
    }));
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/advances', async (req, res) => {
  try {
    const { employeeId, amount, requestDate, deductionMonths, notes } = req.body;
    const advId = 'ADV-' + Date.now();
    const months = deductionMonths || 1;
    const monthlyDeduction = Math.round((amount / months) * 100) / 100;

    await db.query(
      `INSERT INTO hr_advances (id, employee_id, amount, remaining, deduction_months, monthly_deduction, request_date, notes, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [advId, employeeId, amount, amount, months, monthlyDeduction, requestDate || new Date().toISOString().slice(0, 10), notes || null, 'pending']
    );
    res.json({ success: true, id: advId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/advances/:id/approve', async (req, res) => {
  try {
    const { username } = req.body;
    // Make sure `remaining` equals `amount` when approving if not already set
    const [adv] = await db.query('SELECT amount, remaining FROM hr_advances WHERE id = ?', [req.params.id]);
    if (!adv.length) return res.json({ success: false, error: 'السلفة غير موجودة' });
    const amount = Number(adv[0].amount) || 0;
    const currentRemaining = adv[0].remaining == null ? amount : Number(adv[0].remaining);
    const newRemaining = currentRemaining > 0 ? currentRemaining : amount;
    await db.query(
      `UPDATE hr_advances SET status='approved', approved_by=?, approved_at=?, remaining=? WHERE id=?`,
      [username || '', new Date(), newRemaining, req.params.id]
    );
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/advances/:id/reject', async (req, res) => {
  try {
    const { username } = req.body;
    await db.query(
      `UPDATE hr_advances SET status='rejected', rejected_by=?, rejected_at=? WHERE id=?`,
      [username, new Date(), req.params.id]
    );
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// DOCUMENTS
// ═══════════════════════════════════════════════════════════════

router.get('/documents/:employeeId', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM hr_documents WHERE employee_id = ? ORDER BY created_at DESC',
      [req.params.employeeId]
    );
    res.json(rows);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/documents', async (req, res) => {
  try {
    const { employeeId, docType, title, fileData, expiryDate, notes, username } = req.body;
    const docId = 'DOC-' + Date.now();
    await db.query(
      `INSERT INTO hr_documents (id, employee_id, doc_type, title, file_data, expiry_date, notes, uploaded_by) VALUES (?,?,?,?,?,?,?,?)`,
      [docId, employeeId, docType || null, title || null, fileData || null, expiryDate || null, notes || null, username || null]
    );
    res.json({ success: true, id: docId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.delete('/documents/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM hr_documents WHERE id = ?', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════

router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const in30Days = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);

    // Total and active employees
    const [totalEmps] = await db.query('SELECT COUNT(*) as cnt FROM hr_employees');
    const [activeEmps] = await db.query("SELECT COUNT(*) as cnt FROM hr_employees WHERE status = 'active'");

    // On leave count (approved leave requests that cover today)
    const [onLeave] = await db.query(
      "SELECT COUNT(DISTINCT employee_id) as cnt FROM hr_leave_requests WHERE status = 'hr_approved' AND start_date <= ? AND end_date >= ?",
      [today, today]
    );

    // New hires this month
    const [newHires] = await db.query(
      'SELECT COUNT(*) as cnt FROM hr_employees WHERE hire_date >= ?',
      [firstOfMonth]
    );

    // Today's attendance
    const [presentToday] = await db.query(
      "SELECT COUNT(*) as cnt FROM hr_attendance WHERE attendance_date = ? AND status = 'present'",
      [today]
    );
    const [lateToday] = await db.query(
      'SELECT COUNT(*) as cnt FROM hr_attendance WHERE attendance_date = ? AND late_minutes > 0',
      [today]
    );
    const absentToday = Math.max(0, Number(activeEmps[0].cnt) - Number(presentToday[0].cnt));

    // Pending leave requests
    const [pendingLeave] = await db.query(
      "SELECT COUNT(*) as cnt FROM hr_leave_requests WHERE status IN ('pending', 'branch_approved')"
    );

    // Pending advances
    const [pendingAdv] = await db.query(
      "SELECT COUNT(*) as cnt FROM hr_advances WHERE status = 'pending'"
    );

    // v6.19.2 — flat fields the admin dashboard + HR hub read. These lived
    // in a SECOND `GET /dashboard` declaration further down this file that
    // Express never served (first registration wins) — so the HR dashboard
    // KPIs rendered zeros in production. Merged here; the dead duplicate
    // route is removed.
    const monthStart = today.slice(0, 7) + '-01';
    const [presentDistinct] = await db.query(
      'SELECT COUNT(DISTINCT employee_id) as cnt FROM hr_attendance WHERE attendance_date = ?',
      [today]
    );
    const [onLeaveTodayRow] = await db.query(
      "SELECT COUNT(*) as cnt FROM hr_leave_requests WHERE status IN ('hr_approved','branch_approved') AND ? BETWEEN start_date AND end_date",
      [today]
    );
    let pendingOT = 0, monthOTMin = 0;
    try {
      const [[ot]] = await db.query("SELECT COUNT(*) AS cnt FROM hr_overtime_entries WHERE status = 'pending'");
      pendingOT = Number(ot.cnt) || 0;
      const [[otMin]] = await db.query(
        "SELECT COALESCE(SUM(minutes),0) AS m FROM hr_overtime_entries WHERE status = 'approved' AND entry_date >= ?",
        [monthStart]);
      monthOTMin = Number(otMin.m) || 0;
    } catch (_e) {}
    let monthLateMin = 0;
    try {
      const [[lateMin]] = await db.query(
        'SELECT COALESCE(SUM(late_minutes),0) AS m FROM hr_attendance WHERE attendance_date >= ?',
        [monthStart]);
      monthLateMin = Number(lateMin.m) || 0;
    } catch (_e) {}
    const flatTotalActive = Number(activeEmps[0].cnt) || 0;
    const flatPresent = Number(presentDistinct[0].cnt) || 0;
    const flatOnLeave = Number(onLeaveTodayRow[0].cnt) || 0;
    const [pendingLeaveStrict] = await db.query(
      "SELECT COUNT(*) as cnt FROM hr_leave_requests WHERE status = 'pending'"
    );

    // Upcoming contract expiry (next 30 days)
    const [expiringContracts] = await db.query(
      `SELECT id, employee_number, CONCAT(first_name, ' ', last_name) as fullName, contract_end_date
       FROM hr_employees
       WHERE status = 'active' AND contract_end_date IS NOT NULL AND contract_end_date BETWEEN ? AND ?
       ORDER BY contract_end_date`,
      [today, in30Days]
    );

    // Department breakdown
    const [deptBreakdown] = await db.query(
      `SELECT COALESCE(d.name, 'بدون قسم') as name, COUNT(e.id) as count
       FROM hr_employees e
       LEFT JOIN hr_departments d ON e.department_id = d.id
       WHERE e.status = 'active'
       GROUP BY e.department_id, d.name
       ORDER BY count DESC`
    );

    res.json({
      // Legacy keys — untouched for existing consumers
      totalEmployees: totalEmps[0].cnt,
      activeEmployees: activeEmps[0].cnt,
      onLeaveCount: onLeave[0].cnt,
      newHiresThisMonth: newHires[0].cnt,
      todayAttendance: {
        present: presentToday[0].cnt,
        absent: absentToday,
        late: lateToday[0].cnt
      },
      pendingLeaveRequests: pendingLeave[0].cnt,
      pendingAdvances: pendingAdv[0].cnt,
      upcomingContractExpiry: expiringContracts,
      departmentBreakdown: deptBreakdown,
      // v6.19.2 — flat fields (merged from the dead duplicate route)
      totalActive: flatTotalActive,
      presentToday: flatPresent,
      absentToday: Math.max(0, flatTotalActive - flatPresent - flatOnLeave),
      lateToday: Number(lateToday[0].cnt) || 0,
      onLeaveToday: flatOnLeave,
      pendingLeave: Number(pendingLeaveStrict[0].cnt) || 0,
      pendingOT: pendingOT,
      pendingAdv: Number(pendingAdv[0].cnt) || 0,
      monthOvertimeHours: Math.round((monthOTMin / 60) * 100) / 100,
      monthLateHours: Math.round((monthLateMin / 60) * 100) / 100
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// EMPLOYEE SELF-SERVICE — endpoints for the employee's own data
// ═══════════════════════════════════════════════════════════════

// GET my profile (employee linked to current user)
router.get('/my-profile', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    if (!username) return res.json({ success: false, error: 'غير مسجل الدخول' });
    const [rows] = await db.query(`
      SELECT e.*, CONCAT(e.first_name, ' ', COALESCE(e.last_name, '')) as fullName,
        COALESCE(d.name, '') as departmentName, COALESCE(b.name, '') as branchName
      FROM hr_employees e
      LEFT JOIN hr_departments d ON e.department_id = d.id
      LEFT JOIN branches b ON e.branch_id = b.id
      WHERE e.linked_username = ? OR e.email = ?
    `, [username, username]);
    if (!rows.length) return res.json({ success: false, error: 'لا يوجد ملف موظف مرتبط بحسابك' });
    res.json({ success: true, employee: rows[0] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// GET my attendance this month
router.get('/my-attendance', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    const [emp] = await db.query('SELECT id FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json([]);
    const month = req.query.month || new Date().getMonth() + 1;
    const year = req.query.year || new Date().getFullYear();
    const [rows] = await db.query(
      'SELECT * FROM hr_attendance WHERE employee_id = ? AND MONTH(attendance_date) = ? AND YEAR(attendance_date) = ? ORDER BY attendance_date DESC',
      [emp[0].id, month, year]
    );
    res.json(rows);
  } catch (e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST clock in/out for myself
// v5.11.6 — /my-clock now also persists device brand/model/OS/UA on
// both the clock-in and clock-out paths so the owner can see exactly
// which phone or tablet recorded each event.
router.post('/my-clock', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    const { geoLat, geoLng, geoAddress, deviceName, device } = req.body;
    const [emp] = await db.query('SELECT e.id, e.first_name, e.branch_id, e.work_start, e.work_end FROM hr_employees e WHERE e.linked_username = ?', [username]);
    if (!emp.length) return res.json({ success: false, error: 'لا يوجد ملف موظف مرتبط بحسابك — تواصل مع الإدارة' });
    const empId = emp[0].id;
    const branchId = emp[0].branch_id;
    // v5.11.6 used toISOString() here — UTC, not this codebase's canonical
    // Riyadh session timezone (db/connection.js's DB_TIME_ZONE). For the ~3h
    // window each day between UTC midnight and Riyadh midnight, a clock-in
    // was stored under the WRONG calendar date: every query that finds
    // "today's" attendance via CURDATE() (Riyadh, server-side) would miss it
    // entirely — a real daily gap for any employee clocking in overnight.
    const today = todayYmd();

    // v5.11.6 — Normalize device payload (brand/model/os/ua) — accept
    // either a structured object or the legacy deviceName string.
    const devObj = (device && typeof device === 'object') ? device : {};
    const devBrand = String(devObj.brand || '').slice(0, 80);
    const devModel = String(devObj.model || '').slice(0, 120);
    const devOs    = String(devObj.os    || '').slice(0, 80);
    const devUa    = String(devObj.ua    || req.headers['user-agent'] || '').slice(0, 500);
    // Build a human-readable label for the legacy device_name column.
    const devLabel = [devBrand, devModel, devOs].filter(Boolean).join(' · ') || deviceName || 'متصفح';
    const devName = devLabel.substring(0, 50);

    // ─── LOCATION VALIDATION (إجباري) ───
    if (branchId) {
      const [branchRow] = await db.query('SELECT geo_lat, geo_lng, geo_radius FROM branches WHERE id = ?', [branchId]);
      if (branchRow.length && branchRow[0].geo_lat && branchRow[0].geo_lng) {
        // Branch has location — GPS is REQUIRED
        if (!geoLat || !geoLng) {
          return res.json({ success: false, error: 'يجب السماح بتحديد الموقع لتسجيل الحضور' });
        }
        const bLat = Number(branchRow[0].geo_lat);
        const bLng = Number(branchRow[0].geo_lng);
        const radius = Number(branchRow[0].geo_radius) || 1; // default 1 meter
        const R = 6371000;
        const dLat = (Number(geoLat) - bLat) * Math.PI / 180;
        const dLng = (Number(geoLng) - bLng) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(bLat * Math.PI/180) * Math.cos(Number(geoLat) * Math.PI/180) *
                  Math.sin(dLng/2) * Math.sin(dLng/2);
        const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        if (dist > radius) {
          return res.json({
            success: false,
            error: 'أنت بعيد عن الفرع بـ ' + Math.round(dist) + ' متر — المسموح ' + radius + ' متر فقط',
            code: 'outside_fence',
            distance: Math.round(dist),
            radius: radius
          });
        }
      }
    }

    const [existing] = await db.query(
      'SELECT * FROM hr_attendance WHERE employee_id = ? AND attendance_date = ?', [empId, today]
    );

    if (!existing.length) {
      // Clock IN — calculate late minutes
      const id = 'ATT-' + Date.now();
      var lateMin = 0;
      var workStart = emp[0].work_start || '08:00:00';
      var wsParts = workStart.split(':');
      var wsMinutes = parseInt(wsParts[0]||0) * 60 + parseInt(wsParts[1]||0);
      var now = new Date();
      var nowMinutes = now.getHours() * 60 + now.getMinutes();
      if (nowMinutes > wsMinutes + 5) lateMin = nowMinutes - wsMinutes; // 5 min grace

      await db.query(
        `INSERT INTO hr_attendance (id, employee_id, attendance_date, clock_in, status, source,
         geo_lat, geo_lng, geo_address_in, device_id, device_name, late_minutes) VALUES (?,?,?,NOW(),?,?,?,?,?,?,?,?)`,
        [id, empId, today, 'present', 'app', geoLat||null, geoLng||null, geoAddress||'', devName, devName, lateMin]
      );
      // v5.11.6 — Persist structured device columns (best-effort on older schemas)
      try {
        await db.query(
          'UPDATE hr_attendance SET device_brand=?, device_model=?, device_os=?, device_ua=? WHERE id=?',
          [devBrand || null, devModel || null, devOs || null, devUa || null, id]
        );
      } catch(_) { /* columns missing — pre-v5.11.6 deploy */ }
      var msg = 'تم تسجيل الحضور ✓';
      if (lateMin > 0) msg += ' (متأخر ' + lateMin + ' دقيقة)';
      res.json({
        success: true, action: 'clock_in', time: now.toISOString(),
        lateMinutes: lateMin, message: msg,
        device: { brand: devBrand, model: devModel, os: devOs }
      });
    } else if (!existing[0].clock_out) {
      // Clock OUT
      const clockIn = new Date(existing[0].clock_in);
      const clockOut = new Date();
      const totalHours = ((clockOut - clockIn) / (1000 * 60 * 60)).toFixed(2);
      await db.query(
        'UPDATE hr_attendance SET clock_out=NOW(), total_hours=?, geo_lat_out=?, geo_lng_out=?, geo_address_out=? WHERE id=?',
        [totalHours, geoLat||null, geoLng||null, geoAddress||'', existing[0].id]
      );
      // v5.11.6 — Persist the clock-out device separately (employee may
      // use a different phone for clock-out than the one they clocked in
      // with).
      try {
        await db.query(
          'UPDATE hr_attendance SET device_brand_out=?, device_model_out=?, device_os_out=?, device_ua_out=? WHERE id=?',
          [devBrand || null, devModel || null, devOs || null, devUa || null, existing[0].id]
        );
      } catch(_) { /* columns missing — pre-v5.11.6 deploy */ }
      res.json({
        success: true, action: 'clock_out', time: clockOut.toISOString(),
        totalHours, message: 'تم تسجيل الانصراف ✓ (' + totalHours + ' ساعة)',
        device: { brand: devBrand, model: devModel, os: devOs }
      });
    } else {
      res.json({ success: false, error: 'تم تسجيل الحضور والانصراف اليوم بالفعل' });
    }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// GET my leave balances
router.get('/my-leave-balances', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    const [emp] = await db.query('SELECT id FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json([]);
    const year = req.query.year || new Date().getFullYear();
    const [rows] = await db.query(
      'SELECT lb.*, lt.name as leaveTypeName, lt.is_paid FROM hr_leave_balances lb LEFT JOIN hr_leave_types lt ON lb.leave_type_id = lt.id WHERE lb.employee_id = ? AND lb.year = ?',
      [emp[0].id, year]
    );
    res.json(rows);
  } catch (e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST my leave request
router.post('/my-leave-request', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    const { leaveTypeId, startDate, endDate, reason } = req.body;
    const [emp] = await db.query('SELECT id, first_name, last_name FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json({ success: false, error: 'لا يوجد ملف موظف مرتبط' });

    // Calculate days
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    const year = start.getFullYear();

    // v7.5 (H4) — atomic balance guard. The previous check-then-insert had a
    // race (two concurrent submissions both pass), and it ignored already-pending
    // requests (pending rows don't reduce remaining_days). Now: lock the balance
    // row FOR UPDATE inside a transaction and subtract outstanding pending days,
    // so an employee can never overbook.
    const out = await db.withTransaction(async (conn) => {
      const [bal] = await conn.query(
        'SELECT remaining_days FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ? FOR UPDATE',
        [emp[0].id, leaveTypeId, year]
      );
      if (bal.length) {
        const [pend] = await conn.query(
          "SELECT COALESCE(SUM(days_count),0) AS d FROM hr_leave_requests WHERE employee_id = ? AND leave_type_id = ? AND YEAR(start_date) = ? AND status = 'pending'",
          [emp[0].id, leaveTypeId, year]
        );
        const available = Number(bal[0].remaining_days) - Number(pend[0].d || 0);
        if (available < days) {
          const e = new Error('رصيد الإجازة غير كافٍ (المتاح بعد الطلبات المعلّقة: ' + available + ' يوم)');
          e.status = 400; throw e;
        }
      }
      const id = 'LR-' + Date.now();
      const [lastReq] = await conn.query('SELECT request_number FROM hr_leave_requests ORDER BY created_at DESC LIMIT 1 FOR UPDATE');
      let num = 1;
      if (lastReq.length && lastReq[0].request_number) { var m = lastReq[0].request_number.match(/(\d+)/); if (m) num = parseInt(m[1]) + 1; }
      const reqNumber = 'LV-' + String(num).padStart(5, '0');
      await conn.query(
        'INSERT INTO hr_leave_requests (id, request_number, employee_id, leave_type_id, start_date, end_date, days_count, reason, status) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, reqNumber, emp[0].id, leaveTypeId, startDate, endDate, days, reason || '', 'pending']
      );
      return { id, reqNumber };
    });
    res.json({ success: true, id: out.id, requestNumber: out.reqNumber, message: 'تم تقديم طلب الإجازة — بانتظار الموافقة' });
  } catch (e) { res.status(e.status || 500).json({ success: false, error: e.message }); }
});

// GET my leave requests
router.get('/my-leave-requests', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    const [emp] = await db.query('SELECT id FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json([]);
    const [rows] = await db.query(
      'SELECT lr.*, lt.name as leaveTypeName FROM hr_leave_requests lr LEFT JOIN hr_leave_types lt ON lr.leave_type_id = lt.id WHERE lr.employee_id = ? ORDER BY lr.created_at DESC',
      [emp[0].id]
    );
    res.json(rows);
  } catch (e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET my payslips
router.get('/my-payslips', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    const [emp] = await db.query('SELECT id FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json([]);
    const [rows] = await db.query(
      'SELECT pi.*, pr.run_number, pr.month, pr.year FROM hr_payroll_items pi LEFT JOIN hr_payroll_runs pr ON pi.run_id = pr.id WHERE pi.employee_id = ? ORDER BY pr.year DESC, pr.month DESC',
      [emp[0].id]
    );
    res.json(rows);
  } catch (e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// v6.3.0 — LIVE SALARY PROJECTION
// Real-time monthly projection that reacts to every clock-in/out.
// ═══════════════════════════════════════════════════════════════

// GET /api/hr/my-salary-projection?year=&month= — employee self-service
router.get('/my-salary-projection', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    const [emp] = await db.query(
      'SELECT id FROM hr_employees WHERE linked_username = ? LIMIT 1', [username]
    );
    if (!emp.length) return res.json({ error: 'no-employee-profile' });
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || (now.getMonth() + 1);
    const result = await payrollEngine.computeMonthlyProjection(db, emp[0].id, year, month);
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// GET /api/hr/salary-projection/:employeeId?year=&month= — admin preview
router.get('/salary-projection/:employeeId', async (req, res) => {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || (now.getMonth() + 1);
    const result = await payrollEngine.computeMonthlyProjection(db, req.params.employeeId, year, month);
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// v6.3.0 — WEEKLY OFF DAYS (org default + per-employee override)
// ═══════════════════════════════════════════════════════════════

router.get('/weekly-off/default', async (req, res) => {
  try {
    const set = await weeklyOff.getOrgDefaultWeeklyOff(db);
    res.json({
      success: true,
      days: Array.from(set).sort((a, b) => a - b),
      labels: weeklyOff.labelsFor(set)
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/weekly-off/default', async (req, res) => {
  try {
    const days = Array.isArray(req.body && req.body.days) ? req.body.days : [];
    const csv = await weeklyOff.setOrgDefaultWeeklyOff(db, days);
    res.json({ success: true, days: csv ? csv.split(',').map(Number) : [] });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/weekly-off/employees', async (req, res) => {
  try {
    const [emps] = await db.query(`
      SELECT e.id, e.first_name, e.last_name, e.full_name, e.weekly_off_days,
             e.branch_id, e.position_id, e.status,
             b.name AS branch_name, p.name AS position_name
        FROM hr_employees e
        LEFT JOIN branches b ON b.id = e.branch_id
        LEFT JOIN positions p ON p.id = e.position_id
       WHERE e.status = 'active'
       ORDER BY COALESCE(e.full_name, e.first_name)`);
    const orgDefault = await weeklyOff.getOrgDefaultWeeklyOff(db);
    const orgDefaultArr = Array.from(orgDefault).sort((a, b) => a - b);
    res.json({
      success: true,
      orgDefault: orgDefaultArr,
      employees: emps.map(e => {
        const hasOverride = e.weekly_off_days != null && e.weekly_off_days !== '';
        const days = hasOverride
          ? String(e.weekly_off_days).split(',').map(Number)
              .filter(n => Number.isFinite(n) && n >= 0 && n <= 6)
          : orgDefaultArr;
        return {
          id: e.id,
          name: e.full_name || ((e.first_name || '') + (e.last_name ? ' ' + e.last_name : '')).trim(),
          branchName: e.branch_name || '',
          positionName: e.position_name || '',
          hasOverride,
          days
        };
      })
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/weekly-off/employee/:id', async (req, res) => {
  try {
    const days = Array.isArray(req.body && req.body.days) ? req.body.days : null;
    const csv = await weeklyOff.setEmployeeWeeklyOff(db, req.params.id, days);
    res.json({ success: true, employeeId: req.params.id, override: csv });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// SHIFTS (الشفتات)
// ═══════════════════════════════════════════════════════════════
router.get('/shifts', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM hr_shifts WHERE is_active = 1 ORDER BY start_time');
    res.json(rows.map(s => ({
      id: s.id, name: s.name, code: s.code, startTime: s.start_time, endTime: s.end_time,
      breakMinutes: s.break_minutes, graceLateMinutes: s.grace_late_minutes,
      graceEarlyLeaveMinutes: s.grace_early_leave_minutes,
      allowOvertimeBefore: !!s.allow_overtime_before, allowOvertimeAfter: !!s.allow_overtime_after,
      workDays: s.work_days || '0,1,2,3,4', isDefault: !!s.is_default
    })));
  } catch(e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/shifts', async (req, res) => {
  try {
    const { id, name, code, startTime, endTime, breakMinutes, graceLateMinutes, graceEarlyLeaveMinutes,
            allowOvertimeBefore, allowOvertimeAfter, workDays, isDefault, username } = req.body;
    if (!name || !startTime || !endTime) return res.json({ success: false, error: 'الاسم وأوقات الدوام مطلوبة' });
    if (isDefault) await db.query('UPDATE hr_shifts SET is_default = 0');
    if (id) {
      await db.query(
        `UPDATE hr_shifts SET name=?, code=?, start_time=?, end_time=?, break_minutes=?, grace_late_minutes=?,
         grace_early_leave_minutes=?, allow_overtime_before=?, allow_overtime_after=?, work_days=?, is_default=? WHERE id=?`,
        [name, code||'', startTime, endTime, breakMinutes||60, graceLateMinutes||5, graceEarlyLeaveMinutes||0,
         allowOvertimeBefore?1:0, allowOvertimeAfter?1:0, workDays||'0,1,2,3,4', isDefault?1:0, id]);
      await hrRules.auditLog(username, 'update_shift', 'hr_shifts', id, req.body, req.ip);
      return res.json({ success: true, id });
    }
    const newId = 'SH-' + Date.now();
    await db.query(
      `INSERT INTO hr_shifts (id, name, code, start_time, end_time, break_minutes, grace_late_minutes,
       grace_early_leave_minutes, allow_overtime_before, allow_overtime_after, work_days, is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, name, code||'', startTime, endTime, breakMinutes||60, graceLateMinutes||5, graceEarlyLeaveMinutes||0,
       allowOvertimeBefore?1:0, allowOvertimeAfter?1:0, workDays||'0,1,2,3,4', isDefault?1:0]);
    await hrRules.auditLog(username, 'create_shift', 'hr_shifts', newId, req.body, req.ip);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/shifts/:id', async (req, res) => {
  try {
    await db.query('UPDATE hr_shifts SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.post('/employees/:id/assign-shift', async (req, res) => {
  try {
    const { shiftId, username } = req.body;
    await db.query('UPDATE hr_employees SET shift_id = ? WHERE id = ?', [shiftId || null, req.params.id]);
    await hrRules.auditLog(username, 'assign_shift', 'hr_employees', req.params.id, { shiftId }, req.ip);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// OVERTIME RULES & ENTRIES
// ═══════════════════════════════════════════════════════════════
router.get('/overtime-rules', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM hr_overtime_rules WHERE is_active = 1 ORDER BY day_type');
    res.json(rows.map(r => ({
      id: r.id, name: r.name, dayType: r.day_type,
      multiplier: Number(r.multiplier), minMinutes: r.min_minutes,
      requireApproval: !!r.require_approval
    })));
  } catch(e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/overtime-rules', async (req, res) => {
  try {
    const { id, name, dayType, multiplier, minMinutes, requireApproval, username } = req.body;
    if (!name || !dayType) return res.json({ success: false, error: 'الاسم ونوع اليوم مطلوبان' });
    if (id) {
      await db.query(
        'UPDATE hr_overtime_rules SET name=?, day_type=?, multiplier=?, min_minutes=?, require_approval=? WHERE id=?',
        [name, dayType, multiplier||1.5, minMinutes||30, requireApproval?1:0, id]);
      return res.json({ success: true, id });
    }
    const newId = 'OT-' + Date.now();
    await db.query(
      'INSERT INTO hr_overtime_rules (id, name, day_type, multiplier, min_minutes, require_approval) VALUES (?,?,?,?,?,?)',
      [newId, name, dayType, multiplier||1.5, minMinutes||30, requireApproval?1:0]);
    await hrRules.auditLog(username, 'create_overtime_rule', 'hr_overtime_rules', newId, req.body, req.ip);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/overtime-entries', async (req, res) => {
  try {
    const { status, from, to, employee_id } = req.query;
    let sql = `SELECT oe.*, CONCAT(e.first_name,' ',COALESCE(e.last_name,'')) AS employee_name, e.employee_number, r.name AS rule_name
               FROM hr_overtime_entries oe
               LEFT JOIN hr_employees e ON oe.employee_id = e.id
               LEFT JOIN hr_overtime_rules r ON oe.rule_id = r.id
               WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND oe.status = ?'; params.push(status); }
    if (employee_id) { sql += ' AND oe.employee_id = ?'; params.push(employee_id); }
    if (from) { sql += ' AND oe.entry_date >= ?'; params.push(from); }
    if (to) { sql += ' AND oe.entry_date <= ?'; params.push(to); }
    sql += ' ORDER BY oe.entry_date DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, employeeNumber: r.employee_number,
      entryDate: r.entry_date, minutes: r.minutes, multiplier: Number(r.multiplier),
      amount: Number(r.amount), status: r.status, ruleName: r.rule_name,
      approvedBy: r.approved_by, approvedAt: r.approved_at, note: r.note
    })));
  } catch(e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/overtime-entries/:id/approve', async (req, res) => {
  try {
    const { username } = req.body;
    await db.query('UPDATE hr_overtime_entries SET status=\'approved\', approved_by=?, approved_at=NOW() WHERE id=?', [username||'', req.params.id]);
    await hrRules.auditLog(username, 'approve_overtime', 'hr_overtime_entries', req.params.id, {}, req.ip);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.post('/overtime-entries/:id/reject', async (req, res) => {
  try {
    const { username, note } = req.body;
    await db.query('UPDATE hr_overtime_entries SET status=\'rejected\', approved_by=?, approved_at=NOW(), note=? WHERE id=?',
      [username||'', note||'', req.params.id]);
    await hrRules.auditLog(username, 'reject_overtime', 'hr_overtime_entries', req.params.id, {note}, req.ip);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// EXCEPTIONS (ignore_late, ignore_overtime, adjust_attendance)
// ═══════════════════════════════════════════════════════════════
router.get('/exceptions', async (req, res) => {
  try {
    const { employee_id, type, active } = req.query;
    let sql = `SELECT x.*, CONCAT(e.first_name,' ',COALESCE(e.last_name,'')) AS employee_name, e.employee_number
               FROM hr_exceptions x
               LEFT JOIN hr_employees e ON x.employee_id = e.id
               WHERE 1=1`;
    const params = [];
    if (employee_id) { sql += ' AND x.employee_id = ?'; params.push(employee_id); }
    if (type) { sql += ' AND x.exception_type = ?'; params.push(type); }
    if (active === '1') { sql += ' AND CURDATE() BETWEEN x.start_date AND x.end_date'; }
    sql += ' ORDER BY x.created_at DESC LIMIT 500';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, employeeNumber: r.employee_number,
      type: r.exception_type, startDate: r.start_date, endDate: r.end_date,
      newClockIn: r.new_clock_in, newClockOut: r.new_clock_out,
      reason: r.reason, approvedBy: r.approved_by, createdBy: r.created_by, createdAt: r.created_at
    })));
  } catch(e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/exceptions', async (req, res) => {
  try {
    const { employeeId, type, startDate, endDate, newClockIn, newClockOut, reason, username } = req.body;
    if (!employeeId || !type || !startDate || !endDate) return res.json({ success: false, error: 'البيانات ناقصة' });
    const id = 'EXC-' + Date.now();
    await db.query(
      `INSERT INTO hr_exceptions (id, employee_id, exception_type, start_date, end_date, new_clock_in, new_clock_out, reason, approved_by, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, employeeId, type, startDate, endDate, newClockIn||null, newClockOut||null, reason||'', username||'', username||'']);
    await hrRules.auditLog(username, 'create_exception', 'hr_exceptions', id, req.body, req.ip);
    res.json({ success: true, id });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/exceptions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM hr_exceptions WHERE id = ?', [req.params.id]);
    // v8 SECURITY (G3) — the audit actor came from ?username= (spoofable, and it
    // leaked identity into access logs). Token only.
    await hrRules.auditLog(_actor(req), 'delete_exception', 'hr_exceptions', req.params.id, {}, req.ip);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// HR DASHBOARD
// v6.19.2 — the duplicate `GET /dashboard` that lived here was DEAD CODE:
// Express serves the first registration (line ~1967), so this one never
// ran while the frontend read ITS response shape → KPIs rendered zeros.
// Its flat fields are now merged into the live route above.
// ═══════════════════════════════════════════════════════════════
router.get('/dashboard/alerts', async (req, res) => {
  try {
    const alerts = [];
    const today = new Date().toISOString().slice(0,10);
    const monthStart = today.slice(0,7) + '-01';

    // Employees with >10 hours late this month
    const [heavyLate] = await db.query(
      `SELECT a.employee_id, CONCAT(e.first_name,' ',COALESCE(e.last_name,'')) AS name, SUM(a.late_minutes) AS totalMin
       FROM hr_attendance a JOIN hr_employees e ON a.employee_id = e.id
       WHERE a.attendance_date >= ? GROUP BY a.employee_id HAVING totalMin > 600`, [monthStart]);
    heavyLate.forEach(h => alerts.push({ type:'warning', icon:'fa-exclamation-triangle', color:'#f59e0b',
      title: h.name + ' — تأخير تراكمي ' + Math.round(h.totalMin/60) + ' ساعة', link: 'employee:'+h.employee_id }));

    // Employees with no clock-out today (open attendance)
    const [noOut] = await db.query(
      `SELECT a.employee_id, CONCAT(e.first_name,' ',COALESCE(e.last_name,'')) AS name
       FROM hr_attendance a JOIN hr_employees e ON a.employee_id = e.id
       WHERE a.attendance_date = ? AND a.clock_out IS NULL`, [today]);
    noOut.forEach(n => alerts.push({ type:'info', icon:'fa-clock', color:'#0ea5e9',
      title: n.name + ' — لم يسجل انصراف اليوم', link: 'employee:'+n.employee_id }));

    // Pending overtime approvals
    const [pendOT] = await db.query(
      `SELECT COUNT(*) AS cnt FROM hr_overtime_entries WHERE status = 'pending'`);
    if (pendOT[0].cnt > 0) alerts.push({ type:'action', icon:'fa-hourglass-half', color:'#8b5cf6',
      title: pendOT[0].cnt + ' ساعة إضافية تنتظر الاعتماد', link: 'overtime' });

    // Contracts ending within 30 days
    const [expiring] = await db.query(
      `SELECT id, CONCAT(first_name,' ',COALESCE(last_name,'')) AS name, contract_end_date
       FROM hr_employees WHERE contract_end_date IS NOT NULL AND contract_end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)`);
    expiring.forEach(e => alerts.push({ type:'warning', icon:'fa-file-contract', color:'#ef4444',
      title: e.name + ' — عقد ينتهي ' + new Date(e.contract_end_date).toLocaleDateString('en-GB'), link:'employee:'+e.id }));

    res.json(alerts);
  } catch(e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════
router.get('/audit', async (req, res) => {
  try {
    const { entity_type, entity_id, from, to } = req.query;
    let sql = 'SELECT * FROM hr_audit_log WHERE 1=1';
    const params = [];
    if (entity_type) { sql += ' AND entity_type = ?'; params.push(entity_type); }
    if (entity_id) { sql += ' AND entity_id = ?'; params.push(entity_id); }
    if (from) { sql += ' AND created_at >= ?'; params.push(from); }
    if (to) { sql += ' AND created_at <= ?'; params.push(to); }
    sql += ' ORDER BY created_at DESC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch(e) {
    // v8 (G3) — was `res.json([])`: a DB error was indistinguishable from
    // "no rows", fabricating an empty result on a primary data read.
    console.error('[hr] ' + req.method + ' ' + (req.originalUrl || req.url) + ' failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ATTENDANCE CALCULATION (using Rules Engine)
// ═══════════════════════════════════════════════════════════════
router.get('/attendance/calculate-daily', async (req, res) => {
  try {
    const { employee_id, date } = req.query;
    if (!employee_id || !date) return res.json({ success: false, error: 'المعطيات ناقصة' });
    const result = await hrRules.calculateDailyAttendance(employee_id, date);
    res.json(result);
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.get('/attendance/calculate-monthly', async (req, res) => {
  try {
    const { employee_id, year, month } = req.query;
    if (!employee_id || !year || !month) return res.json({ success: false, error: 'المعطيات ناقصة' });
    const result = await hrRules.calculateMonthlyAttendance(employee_id, parseInt(year), parseInt(month));
    res.json(result);
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// MY ATTENDANCE FULL — fills in absent + weekend days for a date range
// GET /api/hr/my-attendance-full?from=YYYY-MM-DD&to=YYYY-MM-DD
//   (defaults: current month from day 1 → today)
// Returns:
//   { success, employee, period: {from,to,workDays,daysOff},
//     totals: {present, absent, late, weekend, leave, holiday,
//              workingHours, lateHours, overtimeHours},
//     days: [...]  // one row per calendar day in the range
//   }
// ═══════════════════════════════════════════════════════════════════
router.get('/my-attendance-full', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    if (!username) return res.json({ success: false, error: 'غير مسجل الدخول' });

    const [empRows] = await db.query(
      `SELECT e.id, e.first_name, e.last_name, e.employee_number, e.hire_date,
              e.work_start, e.work_end, e.branch_id,
              COALESCE(b.name,'') AS branch_name
       FROM hr_employees e LEFT JOIN branches b ON b.id = e.branch_id
       WHERE e.linked_username = ? OR e.email = ? LIMIT 1`,
      [username, username]);
    if (!empRows.length) return res.json({ success: false, error: 'لا يوجد ملف موظف مرتبط بحسابك' });
    const emp = empRows[0];

    // Date range: default is current month → today
    const today = new Date();
    const defaultFrom = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0,10);
    const defaultTo   = today.toISOString().slice(0,10);
    const from = req.query.from || defaultFrom;
    const to   = req.query.to   || defaultTo;

    // v6.3.0 — Weekly-off lookup now comes from the new helper:
    // per-employee override (hr_employees.weekly_off_days) wins, otherwise
    // the org-wide default (settings.weekly_off_default), otherwise the
    // factory default (Friday + Saturday for Saudi Arabia).
    // We derive workDaysSet from the inverse — any day NOT in offDaysSet
    // is a work day, so the existing isWorkDay logic below keeps working.
    const offDaysSet = await weeklyOff.getWeeklyOffDaysForEmployee(db, emp.id);
    const workDaysSet = new Set();
    for (let i = 0; i < 7; i++) {
      if (!offDaysSet.has(i)) workDaysSet.add(i);
    }

    // Pull existing attendance + leave/holiday for the range
    const [attRows] = await db.query(
      `SELECT attendance_date AS d, clock_in, clock_out, total_hours,
              late_minutes, early_leave_minutes, overtime_minutes,
              status, source, device_name, geo_address_in, geo_address_out, notes
       FROM hr_attendance
       WHERE employee_id = ? AND attendance_date BETWEEN ? AND ?
       ORDER BY attendance_date ASC`,
      [emp.id, from, to]);

    const attMap = {};
    attRows.forEach(r => { attMap[r.d.toISOString().slice(0,10)] = r; });

    // Pull approved leave requests overlapping the range
    let leaveRanges = [];
    try {
      const [lrows] = await db.query(
        `SELECT lr.start_date, lr.end_date, lt.name AS type_name
         FROM hr_leave_requests lr
         LEFT JOIN hr_leave_types lt ON lt.id = lr.leave_type_id
         WHERE lr.employee_id = ?
           AND lr.status IN ('hr_approved','approved','branch_approved')
           AND lr.end_date >= ? AND lr.start_date <= ?`,
        [emp.id, from, to]);
      leaveRanges = lrows.map(r => ({
        from: new Date(r.start_date).toISOString().slice(0,10),
        to:   new Date(r.end_date).toISOString().slice(0,10),
        type: r.type_name || 'إجازة'
      }));
    } catch(e) { /* leave_requests may not exist in some envs */ }
    function leaveOnDate(ymd) {
      return leaveRanges.find(l => ymd >= l.from && ymd <= l.to);
    }

    // Iterate every calendar day in [from, to]
    const fromD = new Date(from + 'T00:00:00');
    const toD   = new Date(to   + 'T00:00:00');
    const days = [];
    const totals = { present:0, absent:0, late:0, weekend:0, leave:0, holiday:0,
                     workingHours:0, lateHours:0, overtimeHours:0 };
    const todayYmd = new Date().toISOString().slice(0,10);

    for (let d = new Date(fromD); d <= toD; d.setDate(d.getDate() + 1)) {
      const ymd = d.toISOString().slice(0,10);
      const dow = d.getDay();          // 0=Sun..6=Sat
      const isWorkDay = workDaysSet.has(dow);
      const isFuture  = ymd > todayYmd;
      const att = attMap[ymd];
      const lv  = leaveOnDate(ymd);

      let row = {
        date: ymd,
        dayOfWeek: dow,
        isWorkDay,
        isToday: ymd === todayYmd,
        isFuture,
        clockIn: null, clockOut: null,
        totalHours: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0,
        status: 'absent',
        source: null, deviceName: '', notes: ''
      };

      if (att) {
        // Real attendance row exists
        row.clockIn  = att.clock_in;
        row.clockOut = att.clock_out;
        row.totalHours = Number(att.total_hours || 0);
        row.lateMinutes = Number(att.late_minutes || 0);
        row.earlyLeaveMinutes = Number(att.early_leave_minutes || 0);
        row.overtimeMinutes = Number(att.overtime_minutes || 0);
        row.status = att.status || 'present';
        // If clocked in but never clocked out and the day is past, mark partial
        if (att.clock_in && !att.clock_out && !row.isToday && !row.isFuture) row.status = 'partial';
        row.source = att.source || null;
        row.deviceName = att.device_name || '';
        row.notes = att.notes || '';
        totals.workingHours += row.totalHours;
        totals.lateHours    += row.lateMinutes / 60;
        totals.overtimeHours+= row.overtimeMinutes / 60;
        if (row.status === 'present' || row.status === 'partial') totals.present++;
        if (row.lateMinutes > 0) totals.late++;
      } else if (lv) {
        row.status = 'leave';
        row.notes = lv.type;
        totals.leave++;
      } else if (!isWorkDay) {
        row.status = 'weekend';
        totals.weekend++;
      } else if (isFuture) {
        row.status = 'future';   // not counted toward absent
      } else {
        // Past or today, no record, was a working day → ABSENT
        row.status = 'absent';
        totals.absent++;
      }

      days.push(row);
    }

    // Round totals
    totals.workingHours = Math.round(totals.workingHours * 100) / 100;
    totals.lateHours    = Math.round(totals.lateHours    * 100) / 100;
    totals.overtimeHours= Math.round(totals.overtimeHours* 100) / 100;
    // v6.3.0 — expose the real "expected work days" (total range minus
    // weekly-off minus holidays) so the Employee Portal can render
    // "<present> من <workDays> يوم عمل" accurately. holiday is already
    // counted into totals.holiday from the existing block; future days
    // beyond today are excluded because they're 'future' / not 'absent'.
    totals.workDays = days.filter(r => r.isWorkDay && !r.isFuture).length;
    totals.attendanceRate = totals.workDays > 0
      ? Math.round((totals.present / totals.workDays) * 1000) / 10
      : 0;
    const workDaysCSV = Array.from(workDaysSet).sort((a, b) => a - b).join(',');
    const offDaysCSV  = Array.from(offDaysSet).sort((a, b) => a - b).join(',');

    res.json({
      success: true,
      employee: {
        id: emp.id,
        name: (emp.first_name || '') + ' ' + (emp.last_name || ''),
        employeeNumber: emp.employee_number,
        branchName: emp.branch_name,
        hireDate: emp.hire_date,
        workStart: emp.work_start,
        workEnd: emp.work_end
      },
      period: {
        from, to,
        workDaysCSV,
        offDaysCSV,
        totalDays: days.length
      },
      totals,
      days
    });
  } catch (e) {
    console.error('my-attendance-full error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// MY HOURS & PAY — overtime + late tracking for the logged-in employee
// GET /api/hr/my-hours-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
//   (defaults: current month)
// Returns per-day breakdown of overtime + late hours WITH computed
// monetary value (using employee's hourly_rate or basic_salary/contractedHours)
// + monthly totals + comparison vs previous month.
// ═══════════════════════════════════════════════════════════════════
router.get('/my-hours-summary', async (req, res) => {
  try {
    const username = (req.user && req.user.username) || null;
    if (!username) return res.status(401).json({ success:false, error:'غير مصرّح — يرجى تسجيل الدخول', code:'unauthorized' });
    if (!username) return res.json({ success: false, error: 'غير مسجل الدخول' });

    // Resolve the employee row for this username
    const [empRows] = await db.query(
      `SELECT e.id, e.first_name, e.last_name, e.employee_number,
              e.basic_salary, e.hourly_rate, e.salary_type, e.work_start, e.work_end,
              e.branch_id, COALESCE(b.name,'') AS branch_name,
              COALESCE(d.name,'') AS department_name
       FROM hr_employees e
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN hr_departments d ON d.id = e.department_id
       WHERE e.linked_username = ? OR e.email = ?
       LIMIT 1`,
      [username, username]);
    if (!empRows.length) return res.json({ success: false, error: 'لا يوجد ملف موظف مرتبط بحسابك' });
    const emp = empRows[0];

    // Date range (default current month)
    const today = new Date();
    const defaultFrom = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0,10);
    const defaultTo   = today.toISOString().slice(0,10);
    const from = req.query.from || defaultFrom;
    const to   = req.query.to   || defaultTo;

    // Compute previous-period window (same length)
    const fromD = new Date(from + 'T00:00:00');
    const toD   = new Date(to   + 'T00:00:00');
    const rangeDays = Math.max(1, Math.round((toD - fromD) / 86400000) + 1);
    const prevTo   = new Date(fromD); prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (rangeDays - 1));
    const ymd = (d) => d.toISOString().slice(0,10);

    // Compute hourly rate. If salary_type='hourly' use hourly_rate directly.
    // Otherwise derive from basic_salary / (work-days × work-hours).
    // Saudi standard: 30 days × 8 hours = 240 monthly contracted hours.
    let hourlyRate = Number(emp.hourly_rate || 0);
    if (!hourlyRate || emp.salary_type === 'monthly') {
      const monthly = Number(emp.basic_salary || 0);
      hourlyRate = monthly > 0 ? monthly / 240 : 0;
    }

    // Saudi labor law standard multipliers (configurable later via overtime_rules)
    const OVERTIME_MULTIPLIER = 1.5;   // 150% of base hourly rate
    const LATE_DEDUCTION_MULT = 1.0;   // late = full hourly rate deducted

    // Pull attendance for the current window (per-day rows)
    const [attCurr] = await db.query(
      `SELECT attendance_date AS d, late_minutes, overtime_minutes, early_leave_minutes,
              total_hours, status, clock_in, clock_out
       FROM hr_attendance
       WHERE employee_id = ? AND attendance_date BETWEEN ? AND ?
       ORDER BY attendance_date DESC`,
      [emp.id, from, to]);

    // Same for previous window (just totals, not per-row detail)
    const [attPrev] = await db.query(
      `SELECT COALESCE(SUM(late_minutes),0) AS late_min,
              COALESCE(SUM(overtime_minutes),0) AS ot_min,
              COALESCE(SUM(total_hours),0) AS total_h,
              COUNT(*) AS days
       FROM hr_attendance
       WHERE employee_id = ? AND attendance_date BETWEEN ? AND ?`,
      [emp.id, ymd(prevFrom), ymd(prevTo)]);

    // Build per-day rows with monetary values
    const rows = attCurr.map(r => {
      const lateMin = Number(r.late_minutes || 0);
      const otMin   = Number(r.overtime_minutes || 0);
      const earlyMin= Number(r.early_leave_minutes || 0);
      const lateHrs = lateMin / 60;
      const otHrs   = otMin / 60;
      const earlyHrs= earlyMin / 60;
      const lateValue = Math.round(lateHrs * hourlyRate * LATE_DEDUCTION_MULT * 100) / 100;
      const otValue   = Math.round(otHrs   * hourlyRate * OVERTIME_MULTIPLIER  * 100) / 100;
      const earlyValue= Math.round(earlyHrs* hourlyRate * LATE_DEDUCTION_MULT * 100) / 100;
      return {
        date: r.d ? ymd(new Date(r.d)) : null,
        clockIn:  r.clock_in,
        clockOut: r.clock_out,
        totalHours: Number(r.total_hours || 0),
        lateMinutes: lateMin,
        lateHours: Math.round(lateHrs * 100) / 100,
        lateValue: lateValue,                  // SAR deducted for being late
        overtimeMinutes: otMin,
        overtimeHours: Math.round(otHrs * 100) / 100,
        overtimeValue: otValue,                // SAR earned in overtime
        earlyLeaveMinutes: earlyMin,
        earlyLeaveHours: Math.round(earlyHrs * 100) / 100,
        earlyLeaveValue: earlyValue,           // SAR deducted for early leave
        netImpact: Math.round((otValue - lateValue - earlyValue) * 100) / 100,
        status: r.status
      };
    });

    // Aggregate totals
    const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
    const tot = {
      days: rows.length,
      lateMinutes: sum('lateMinutes'),
      lateHours: Math.round(sum('lateHours') * 100) / 100,
      lateValue: Math.round(sum('lateValue') * 100) / 100,
      overtimeMinutes: sum('overtimeMinutes'),
      overtimeHours: Math.round(sum('overtimeHours') * 100) / 100,
      overtimeValue: Math.round(sum('overtimeValue') * 100) / 100,
      earlyLeaveMinutes: sum('earlyLeaveMinutes'),
      earlyLeaveHours: Math.round(sum('earlyLeaveHours') * 100) / 100,
      earlyLeaveValue: Math.round(sum('earlyLeaveValue') * 100) / 100,
      totalHours: Math.round(sum('totalHours') * 100) / 100,
      netImpact: Math.round(sum('netImpact') * 100) / 100,
      // Days where the employee was late at least once
      lateDays: rows.filter(r => r.lateMinutes > 0).length,
      overtimeDays: rows.filter(r => r.overtimeMinutes > 0).length
    };

    // Previous period totals (raw)
    const prev = attPrev[0];
    const prevTotals = {
      lateMinutes: Number(prev.late_min || 0),
      lateHours: Math.round((Number(prev.late_min || 0) / 60) * 100) / 100,
      lateValue: Math.round((Number(prev.late_min || 0) / 60) * hourlyRate * LATE_DEDUCTION_MULT * 100) / 100,
      overtimeMinutes: Number(prev.ot_min || 0),
      overtimeHours: Math.round((Number(prev.ot_min || 0) / 60) * 100) / 100,
      overtimeValue: Math.round((Number(prev.ot_min || 0) / 60) * hourlyRate * OVERTIME_MULTIPLIER * 100) / 100,
      totalHours: Number(prev.total_h || 0),
      days: Number(prev.days || 0)
    };

    const pct = (curr, p) => (!p || p === 0) ? (curr > 0 ? 100 : 0) : ((curr - p) / p) * 100;
    const deltas = {
      lateHours: pct(tot.lateHours, prevTotals.lateHours),
      overtimeHours: pct(tot.overtimeHours, prevTotals.overtimeHours),
      lateValue: pct(tot.lateValue, prevTotals.lateValue),
      overtimeValue: pct(tot.overtimeValue, prevTotals.overtimeValue)
    };

    res.json({
      success: true,
      employee: {
        id: emp.id,
        name: (emp.first_name || '') + ' ' + (emp.last_name || ''),
        employeeNumber: emp.employee_number,
        branchName: emp.branch_name,
        departmentName: emp.department_name,
        salaryType: emp.salary_type,
        basicSalary: Number(emp.basic_salary || 0),
        hourlyRate: Math.round(hourlyRate * 100) / 100,
        workStart: emp.work_start,
        workEnd: emp.work_end
      },
      period: {
        from, to, rangeDays,
        prevFrom: ymd(prevFrom), prevTo: ymd(prevTo)
      },
      multipliers: {
        overtime: OVERTIME_MULTIPLIER,
        lateDeduction: LATE_DEDUCTION_MULT
      },
      totals: tot,
      previousTotals: prevTotals,
      deltas: deltas,
      rows: rows
    });
  } catch (e) {
    console.error('my-hours-summary error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// v5.11.1 — OFFICIAL HOLIDAYS (الإجازات الرسمية)
// ═══════════════════════════════════════════════════════════════════
const { findHolidayForDate, holidaysInMonth } = require('../lib/hr-holidays');
const CSVC = require('../lib/csvContract');

// GET /api/hr/holidays?year=YYYY&scope=all|brand|branch&brandId=&branchId=&includeInactive=1
// v5.11.8 — Admin views send includeInactive=1 so disabled holidays can
// be re-enabled. lib/hr-holidays.js (which feeds attendance enforcement
// and the Employee Portal calendar) still applies its own is_active = 1
// filter, so disabled rows remain excluded from clock-in / monthly
// reports regardless of what this admin endpoint returns.
router.get('/holidays', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const scope = req.query.scope;
    const brandId = req.query.brandId;
    const branchId = req.query.branchId;
    const search = String(req.query.q || '').trim();
    const includeInactive = req.query.includeInactive === '1' || req.query.all === '1';
    const yStart = year + '-01-01';
    const yEnd   = year + '-12-31';
    const activeFilter = includeInactive ? '' : ' is_active = 1 AND';
    let sql = 'SELECT * FROM hr_holidays WHERE ' + activeFilter + ' ' +
              '((start_date BETWEEN ? AND ?) OR (end_date BETWEEN ? AND ?) OR ' +
              ' (start_date <= ? AND end_date >= ?))';
    const params = [yStart, yEnd, yStart, yEnd, yStart, yEnd];
    if (scope) { sql += ' AND scope = ?'; params.push(scope); }
    if (brandId)  { sql += ' AND (scope <> "brand"  OR brand_id  = ?)'; params.push(brandId); }
    if (branchId) { sql += ' AND (scope <> "branch" OR branch_id = ?)'; params.push(branchId); }
    if (search) {
      sql += ' AND (name LIKE ? OR name_en LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }
    sql += ' ORDER BY start_date ASC';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, name: r.name, nameEn: r.name_en,
      startDate: r.start_date instanceof Date ? r.start_date.toISOString().slice(0,10) : r.start_date,
      endDate:   r.end_date   instanceof Date ? r.end_date.toISOString().slice(0,10)   : r.end_date,
      scope: r.scope, brandId: r.brand_id || '', branchId: r.branch_id || '',
      isPaid: !!r.is_paid, overtimeMultiplier: Number(r.overtime_multiplier),
      isRecurring: !!r.is_recurring, notes: r.notes || '',
      isActive: !!r.is_active,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at
    })));
  } catch (e) {
    console.error('GET /holidays error:', e);
    res.json({ success: false, error: e.message });
  }
});

// POST /api/hr/holidays — create or update (id present = update)
router.post('/holidays', async (req, res) => {
  try {
    const h = req.body || {};
    if (!h.name)      return res.json({ success: false, error: 'الاسم مطلوب' });
    if (!h.startDate) return res.json({ success: false, error: 'تاريخ البداية مطلوب' });
    if (!h.endDate)   return res.json({ success: false, error: 'تاريخ النهاية مطلوب' });
    if (new Date(h.endDate) < new Date(h.startDate)) {
      return res.json({ success: false, error: 'تاريخ النهاية قبل تاريخ البداية' });
    }
    const scope    = ['all','brand','branch'].includes(h.scope) ? h.scope : 'all';
    const isPaid   = (h.isPaid === false) ? 0 : 1;
    const multi    = Math.max(0, Math.min(10, Number(h.overtimeMultiplier) || 2.5));
    const recurring= h.isRecurring ? 1 : 0;
    if (h.id) {
      await db.query(
        'UPDATE hr_holidays SET name=?, name_en=?, start_date=?, end_date=?, scope=?, ' +
        'brand_id=?, branch_id=?, is_paid=?, overtime_multiplier=?, is_recurring=?, ' +
        'notes=?, is_active=COALESCE(?, is_active) WHERE id=?',
        [h.name, h.nameEn || '', h.startDate, h.endDate, scope,
         h.brandId || null, h.branchId || null, isPaid, multi, recurring,
         h.notes || '', (h.isActive === false ? 0 : 1), h.id]
      );
      return res.json({ success: true, id: h.id, action: 'updated' });
    }
    const id = 'HOL-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    await db.query(
      'INSERT INTO hr_holidays (id, name, name_en, start_date, end_date, scope, ' +
      'brand_id, branch_id, is_paid, overtime_multiplier, is_recurring, notes, ' +
      'is_active, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [id, h.name, h.nameEn || '', h.startDate, h.endDate, scope,
       h.brandId || null, h.branchId || null, isPaid, multi, recurring,
       h.notes || '', h.createdBy || '']
    );
    res.json({ success: true, id, action: 'created' });
  } catch (e) {
    console.error('POST /holidays error:', e);
    res.json({ success: false, error: e.message });
  }
});

// DELETE /api/hr/holidays/:id — soft delete
router.delete('/holidays/:id', async (req, res) => {
  try {
    await db.query('UPDATE hr_holidays SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// v5.11.8 — POST /api/hr/holidays/:id/toggle — quick enable/disable flip.
// Mirrors the pattern of /api/auth/users/:username/toggle and
// /api/custody/users/:id/toggle so the admin can toggle a holiday's
// is_active flag with one click from the table. Returns the new state
// so the UI can update without a refetch.
router.post('/holidays/:id/toggle', async (req, res) => {
  try {
    await db.query(
      'UPDATE hr_holidays SET is_active = NOT is_active WHERE id = ?',
      [req.params.id]
    );
    const [rows] = await db.query(
      'SELECT is_active FROM hr_holidays WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    const isActive = rows.length ? !!rows[0].is_active : null;
    res.json({ success: true, isActive: isActive });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// GET /api/hr/holidays/calendar/:year — quick lookup map keyed by date
router.get('/holidays/calendar/:year', async (req, res) => {
  try {
    const year = Number(req.params.year);
    const brandId = req.query.brandId, branchId = req.query.branchId;
    const map = {};
    for (let m = 1; m <= 12; m++) {
      const monthMap = await holidaysInMonth(year, m, brandId, branchId);
      Object.assign(map, monthMap);
    }
    res.json({ year, holidays: map });
  } catch (e) {
    res.json({ year: Number(req.params.year), holidays: {}, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// v5.11.1 — MONTHLY ATTENDANCE REPORT (تقرير الحضور الشَّهري)
// ═══════════════════════════════════════════════════════════════════
function _ymd(d) {
  const x = (d instanceof Date) ? d : new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
const ARABIC_DAYS = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

// GET /api/hr/attendance/monthly/:employeeId?month=X&year=Y
router.get('/attendance/monthly/:employeeId', async (req, res) => {
  try {
    const employeeId = req.params.employeeId;
    const month = Math.min(12, Math.max(1, Number(req.query.month) || (new Date().getMonth() + 1)));
    const year  = Number(req.query.year) || new Date().getFullYear();

    // 1) Employee
    const [empRows] = await db.query(
      'SELECT e.*, d.name AS department_name, p.name AS position_name, br.name AS branch_name ' +
      'FROM hr_employees e ' +
      'LEFT JOIN hr_departments d ON d.id = e.department_id ' +
      'LEFT JOIN hr_positions   p ON p.id = e.position_id ' +
      'LEFT JOIN branches       br ON br.id = e.branch_id ' +
      'WHERE e.id = ?', [employeeId]
    );
    if (!empRows.length) return res.json({ success: false, error: 'الموظف غير موجود' });
    const emp = empRows[0];

    // 2) Shift / schedule (best-effort — table may not exist on legacy)
    let shift = { name: null, startTime: null, endTime: null, workDays: '1,2,3,4,5', dailyHours: 8 };
    try {
      const [shiftRows] = await db.query(
        'SELECT * FROM hr_shifts WHERE id IN (SELECT shift_id FROM hr_employees WHERE id = ?) LIMIT 1',
        [employeeId]
      );
      if (shiftRows.length) {
        const s = shiftRows[0];
        shift = {
          name: s.name, code: s.code, startTime: s.start_time, endTime: s.end_time,
          workDays: s.work_days || '1,2,3,4,5', breakMinutes: s.break_minutes,
          dailyHours: 8  // computed below if start/end set
        };
        if (s.start_time && s.end_time) {
          const [sh, sm] = String(s.start_time).split(':').map(Number);
          const [eh, em] = String(s.end_time).split(':').map(Number);
          shift.dailyHours = Math.max(0, ((eh*60+em) - (sh*60+sm)) / 60);
        }
      }
    } catch (_) { /* schema variation tolerated */ }

    // 3) Holidays for the month
    const holMap = await holidaysInMonth(year, month, emp.brand_id, emp.branch_id);

    // 4) Attendance rows for the month
    const lastDay = new Date(year, month, 0).getDate();
    const monthStart = year + '-' + String(month).padStart(2, '0') + '-01';
    const monthEnd   = year + '-' + String(month).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
    const [attRows] = await db.query(
      'SELECT * FROM hr_attendance WHERE employee_id = ? AND attendance_date BETWEEN ? AND ? ORDER BY attendance_date',
      [employeeId, monthStart, monthEnd]
    );
    const attMap = {};
    attRows.forEach(a => { attMap[_ymd(a.attendance_date)] = a; });

    // 5) Leave requests overlapping the month (best-effort)
    let leaveMap = {};
    try {
      const [leaveRows] = await db.query(
        'SELECT lr.*, lt.name AS leave_type_name, lt.is_paid ' +
        'FROM hr_leave_requests lr ' +
        'LEFT JOIN hr_leave_types lt ON lt.id = lr.leave_type_id ' +
        'WHERE lr.employee_id = ? AND lr.status IN ("branch_approved","hr_approved") ' +
        '  AND NOT (lr.end_date < ? OR lr.start_date > ?)',
        [employeeId, monthStart, monthEnd]
      );
      leaveRows.forEach(lr => {
        const s = new Date(lr.start_date), e = new Date(lr.end_date);
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
          if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
          leaveMap[_ymd(d)] = { typeId: lr.leave_type_id, typeName: lr.leave_type_name, paid: !!lr.is_paid };
        }
      });
    } catch (_) { /* leave tables may be absent */ }

    // 6) Work-day set from shift (1=Mon..7=Sun on hr_shifts.work_days; we map to JS Date.getDay where 0=Sun)
    const workDaysList = String(shift.workDays || '1,2,3,4,5').split(',').map(s => Number(s.trim()));
    function isWorkDay(jsDay /* 0..6 from Date.getDay */) {
      // Convert: hr_shifts uses 1..7 where 1=Sunday typically. We treat 1..7 matching JS getDay()+1.
      // (Legacy "1,2,3,4,5" → Mon-Fri or Sun-Thu; we accept either by simple inclusion.)
      const sundayBased = jsDay + 1; // 1..7
      return workDaysList.includes(sundayBased);
    }

    // 7) Build days array
    const hourlyRate = Number(emp.hourly_rate) ||
      (Number(emp.basic_salary || 0) > 0 ? (Number(emp.basic_salary) / 30 / Math.max(1, shift.dailyHours)) : 0);

    const days = [];
    let presentDays = 0, absentDays = 0, leaveDays = 0, holidayDays = 0;
    let totalMinutes = 0, lateMinutes = 0, earlyLeaveMinutes = 0, overtimeMinutes = 0, overtimeAmount = 0;
    let workDaysExpected = 0;

    for (let d = 1; d <= lastDay; d++) {
      const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const dateObj = new Date(dateStr);
      const jsDay = dateObj.getDay();
      const dayName = ARABIC_DAYS[jsDay];
      const att = attMap[dateStr];
      const hol = holMap[dateStr];
      const lv  = leaveMap[dateStr];
      const isToday = (dateStr === _ymd(new Date()));
      const isWork = isWorkDay(jsDay);

      let dayType = 'rest';
      if (hol) dayType = 'holiday';
      else if (lv) dayType = 'leave';
      else if (isWork) dayType = 'work';

      // Attendance presence
      let attendance = null;
      if (att) {
        const otMin = Number(att.overtime_minutes || 0);
        const lateMin = Number(att.late_minutes || 0);
        const earlyMin = Number(att.early_leave_minutes || 0);
        const hrs = Number(att.total_hours || 0);
        attendance = {
          clockIn:  att.clock_in,
          clockOut: att.clock_out,
          totalHours: hrs,
          lateMinutes: lateMin,
          earlyLeaveMinutes: earlyMin,
          overtimeMinutes: otMin,
          status: att.status,
          source: att.source,
          geoIn:  (att.geo_lat && att.geo_lng) ? { lat: Number(att.geo_lat), lng: Number(att.geo_lng), addr: att.geo_address_in || '' } : null,
          geoOut: (att.geo_lat_out && att.geo_lng_out) ? { lat: Number(att.geo_lat_out), lng: Number(att.geo_lng_out), addr: att.geo_address_out || '' } : null
        };
        totalMinutes += hrs * 60;
        lateMinutes  += lateMin;
        earlyLeaveMinutes += earlyMin;
        overtimeMinutes   += otMin;
        // Overtime amount: use holiday multiplier if today is a holiday
        const multi = hol ? Number(hol.overtime_multiplier || 2.5) : 1.5;
        overtimeAmount += (otMin / 60) * hourlyRate * multi;
      }

      // Counters
      if (hol) holidayDays++;
      else if (lv) leaveDays++;
      else if (att && (att.status === 'present' || att.clock_in)) presentDays++;
      else if (isWork && !isToday && new Date(dateStr) < new Date()) absentDays++;
      if (isWork && !hol) workDaysExpected++;

      days.push({
        date: dateStr,
        dayName,
        dayType,
        attendance,
        holiday: hol ? { id: hol.id, name: hol.name, multiplier: Number(hol.overtime_multiplier) } : null,
        leave: lv || null,
        isWorkDay: isWork,
        isToday
      });
    }

    const expectedHours = workDaysExpected * shift.dailyHours;
    const attendanceRate = workDaysExpected > 0 ? Math.round((presentDays / workDaysExpected) * 100) : 0;

    res.json({
      success: true,
      employee: {
        id: emp.id,
        employeeNumber: emp.employee_number,
        name: ((emp.first_name || '') + ' ' + (emp.last_name || '')).trim(),
        nationality: emp.nationality,
        nationalId: emp.national_id,
        phone: emp.phone,
        email: emp.email,
        gender: emp.gender,
        jobTitle: emp.job_title,
        position: emp.position_name,
        department: emp.department_name,
        branch: emp.branch_name,
        branchId: emp.branch_id,
        brandId: emp.brand_id,
        hireDate: emp.hire_date,
        salaryType: emp.salary_type,
        basicSalary: Number(emp.basic_salary || 0),
        hourlyRate
      },
      shift,
      period: {
        year, month, daysInMonth: lastDay,
        workDaysExpected, holidaysCount: Object.keys(holMap).length
      },
      holidays: Object.entries(holMap).map(([date, h]) => ({
        date, name: h.name, multiplier: Number(h.overtime_multiplier), isPaid: !!h.is_paid
      })),
      days,
      summary: {
        workDays: workDaysExpected,
        presentDays, absentDays, leaveDays, holidayDays,
        totalHours: Math.round((totalMinutes / 60) * 100) / 100,
        overtimeHours: Math.round((overtimeMinutes / 60) * 100) / 100,
        lateMinutes, earlyLeaveMinutes,
        overtimeAmount: Math.round(overtimeAmount * 100) / 100,
        expectedHours,
        attendanceRate
      }
    });
  } catch (e) {
    console.error('GET /attendance/monthly/:id error:', e);
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
