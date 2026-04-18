const router = require('express').Router();
const db = require('../db/connection');
const hrRules = require('../lib/hrRules');
const hrGLPosting = require('../lib/hrGLPosting');

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
// EMPLOYEES
// ═══════════════════════════════════════════════════════════════

router.get('/employees', async (req, res) => {
  try {
    const { branch_id, brand_id, department_id, status, search } = req.query;
    let sql = `
      SELECT e.id, e.employee_number AS employeeNumber,
        CONCAT(e.first_name, ' ', COALESCE(e.last_name, '')) AS fullName,
        e.first_name AS firstName, e.last_name AS lastName,
        e.phone, e.email, e.job_title AS jobTitle,
        COALESCE(d.name, '') AS departmentName,
        COALESCE(b.name, '') AS branchName,
        e.status, e.hire_date AS hireDate, e.basic_salary AS basicSalary,
        e.ignore_late_month AS ignoreLateMonth,
        e.department_id AS departmentId, e.branch_id AS branchId, e.brand_id AS brandId,
        e.employment_type AS employmentType, e.national_id AS nationalId,
        e.linked_username AS linkedUsername
      FROM hr_employees e
      LEFT JOIN hr_departments d ON e.department_id = d.id
      LEFT JOIN branches b ON e.branch_id = b.id
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
    res.json(rows);
  } catch (e) {
    res.json({ success: false, error: e.message });
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

router.post('/payroll-runs/:id/approve', async (req, res) => {
  try {
    const { username } = req.body;
    await db.query(
      `UPDATE hr_payroll_runs SET status='approved', approved_by=?, approved_at=? WHERE id=?`,
      [username, new Date(), req.params.id]
    );
    // Auto-post to GL (accrual + deductions journals)
    let glResult = null;
    try {
      glResult = await hrGLPosting.postPayrollJournals(req.params.id, username);
    } catch (glErr) {
      // Don't fail the approval — log the GL error and continue
      console.error('[Payroll GL] Failed to post journals:', glErr.message);
      return res.json({ success: true, id: req.params.id, glWarning: 'تم الاعتماد لكن فشل ترحيل القيود: ' + glErr.message });
    }
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
router.post('/payroll-runs/:id/pay', async (req, res) => {
  try {
    const { username, bankAccountId } = req.body;
    if (!bankAccountId) return res.json({ success: false, error: 'اختر حساب البنك/الصندوق' });
    const result = await hrGLPosting.postPayrollPaymentJournal(req.params.id, bankAccountId, username);
    res.json(result);
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
        i.employee_number||'', '"'+(i.employee_name||'').replace(/"/g,'""')+'"',
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
      departmentBreakdown: deptBreakdown
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
    const username = req.user ? req.user.username : req.query.username;
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
    const username = req.user ? req.user.username : req.query.username;
    const [emp] = await db.query('SELECT id FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json([]);
    const month = req.query.month || new Date().getMonth() + 1;
    const year = req.query.year || new Date().getFullYear();
    const [rows] = await db.query(
      'SELECT * FROM hr_attendance WHERE employee_id = ? AND MONTH(attendance_date) = ? AND YEAR(attendance_date) = ? ORDER BY attendance_date DESC',
      [emp[0].id, month, year]
    );
    res.json(rows);
  } catch (e) { res.json([]); }
});

// POST clock in/out for myself
router.post('/my-clock', async (req, res) => {
  try {
    const username = req.user ? req.user.username : req.body.username;
    const { geoLat, geoLng, geoAddress, deviceName } = req.body;
    const [emp] = await db.query('SELECT e.id, e.first_name, e.branch_id, e.work_start, e.work_end FROM hr_employees e WHERE e.linked_username = ?', [username]);
    if (!emp.length) return res.json({ success: false, error: 'لا يوجد ملف موظف مرتبط بحسابك — تواصل مع الإدارة' });
    const empId = emp[0].id;
    const branchId = emp[0].branch_id;
    const today = new Date().toISOString().split('T')[0];

    // Device name (short — max 50 chars)
    var devName = (deviceName || 'متصفح').substring(0, 50);

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
          return res.json({ success: false, error: 'أنت بعيد عن الفرع بـ ' + Math.round(dist) + ' متر — المسموح ' + radius + ' متر فقط' });
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
      var msg = 'تم تسجيل الحضور ✓';
      if (lateMin > 0) msg += ' (متأخر ' + lateMin + ' دقيقة)';
      res.json({ success: true, action: 'clock_in', time: now.toISOString(), lateMinutes: lateMin, message: msg });
    } else if (!existing[0].clock_out) {
      // Clock OUT
      const clockIn = new Date(existing[0].clock_in);
      const clockOut = new Date();
      const totalHours = ((clockOut - clockIn) / (1000 * 60 * 60)).toFixed(2);
      await db.query(
        'UPDATE hr_attendance SET clock_out=NOW(), total_hours=?, geo_lat_out=?, geo_lng_out=?, geo_address_out=? WHERE id=?',
        [totalHours, geoLat||null, geoLng||null, geoAddress||'', existing[0].id]
      );
      res.json({ success: true, action: 'clock_out', time: clockOut.toISOString(), totalHours, message: 'تم تسجيل الانصراف ✓ (' + totalHours + ' ساعة)' });
    } else {
      res.json({ success: false, error: 'تم تسجيل الحضور والانصراف اليوم بالفعل' });
    }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// GET my leave balances
router.get('/my-leave-balances', async (req, res) => {
  try {
    const username = req.user ? req.user.username : req.query.username;
    const [emp] = await db.query('SELECT id FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json([]);
    const year = req.query.year || new Date().getFullYear();
    const [rows] = await db.query(
      'SELECT lb.*, lt.name as leaveTypeName, lt.is_paid FROM hr_leave_balances lb LEFT JOIN hr_leave_types lt ON lb.leave_type_id = lt.id WHERE lb.employee_id = ? AND lb.year = ?',
      [emp[0].id, year]
    );
    res.json(rows);
  } catch (e) { res.json([]); }
});

// POST my leave request
router.post('/my-leave-request', async (req, res) => {
  try {
    const username = req.user ? req.user.username : req.body.username;
    const { leaveTypeId, startDate, endDate, reason } = req.body;
    const [emp] = await db.query('SELECT id, first_name, last_name FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json({ success: false, error: 'لا يوجد ملف موظف مرتبط' });

    // Calculate days
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    // Check balance
    const year = start.getFullYear();
    const [bal] = await db.query(
      'SELECT remaining_days FROM hr_leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
      [emp[0].id, leaveTypeId, year]
    );
    if (bal.length && bal[0].remaining_days < days) {
      return res.json({ success: false, error: 'رصيد الإجازة غير كافٍ (المتبقي: ' + bal[0].remaining_days + ' يوم)' });
    }

    const id = 'LR-' + Date.now();
    const [lastReq] = await db.query('SELECT request_number FROM hr_leave_requests ORDER BY created_at DESC LIMIT 1');
    let num = 1;
    if (lastReq.length && lastReq[0].request_number) { var m = lastReq[0].request_number.match(/(\d+)/); if (m) num = parseInt(m[1]) + 1; }
    const reqNumber = 'LV-' + String(num).padStart(5, '0');

    await db.query(
      'INSERT INTO hr_leave_requests (id, request_number, employee_id, leave_type_id, start_date, end_date, days_count, reason, status) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, reqNumber, emp[0].id, leaveTypeId, startDate, endDate, days, reason || '', 'pending']
    );
    res.json({ success: true, id, requestNumber: reqNumber, message: 'تم تقديم طلب الإجازة — بانتظار الموافقة' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// GET my leave requests
router.get('/my-leave-requests', async (req, res) => {
  try {
    const username = req.user ? req.user.username : req.query.username;
    const [emp] = await db.query('SELECT id FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json([]);
    const [rows] = await db.query(
      'SELECT lr.*, lt.name as leaveTypeName FROM hr_leave_requests lr LEFT JOIN hr_leave_types lt ON lr.leave_type_id = lt.id WHERE lr.employee_id = ? ORDER BY lr.created_at DESC',
      [emp[0].id]
    );
    res.json(rows);
  } catch (e) { res.json([]); }
});

// GET my payslips
router.get('/my-payslips', async (req, res) => {
  try {
    const username = req.user ? req.user.username : req.query.username;
    const [emp] = await db.query('SELECT id FROM hr_employees WHERE linked_username = ?', [username]);
    if (!emp.length) return res.json([]);
    const [rows] = await db.query(
      'SELECT pi.*, pr.run_number, pr.month, pr.year FROM hr_payroll_items pi LEFT JOIN hr_payroll_runs pr ON pi.run_id = pr.id WHERE pi.employee_id = ? ORDER BY pr.year DESC, pr.month DESC',
      [emp[0].id]
    );
    res.json(rows);
  } catch (e) { res.json([]); }
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
  } catch(e) { res.json([]); }
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
  } catch(e) { res.json([]); }
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
  } catch(e) { res.json([]); }
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
  } catch(e) { res.json([]); }
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
    await hrRules.auditLog(req.query.username, 'delete_exception', 'hr_exceptions', req.params.id, {}, req.ip);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// HR DASHBOARD
// ═══════════════════════════════════════════════════════════════
router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const monthStart = today.slice(0,7) + '-01';

    const [[{ totalActive }]] = await db.query("SELECT COUNT(*) AS totalActive FROM hr_employees WHERE status = 'active'");
    const [[{ presentToday }]] = await db.query("SELECT COUNT(DISTINCT employee_id) AS presentToday FROM hr_attendance WHERE attendance_date = ?", [today]);
    const [[{ lateToday }]] = await db.query("SELECT COUNT(*) AS lateToday FROM hr_attendance WHERE attendance_date = ? AND late_minutes > 0", [today]);
    const [[{ onLeaveToday }]] = await db.query(
      "SELECT COUNT(*) AS onLeaveToday FROM hr_leave_requests WHERE status IN ('hr_approved','branch_approved') AND ? BETWEEN start_date AND end_date", [today]);
    const absentToday = Math.max(0, totalActive - presentToday - onLeaveToday);

    const [[{ pendingLeave }]] = await db.query("SELECT COUNT(*) AS pendingLeave FROM hr_leave_requests WHERE status = 'pending'");
    const [[{ pendingOT }]] = await db.query("SELECT COUNT(*) AS pendingOT FROM hr_overtime_entries WHERE status = 'pending'");
    let pendingAdv = 0;
    try { const [[r]] = await db.query("SELECT COUNT(*) AS pendingAdv FROM hr_advances WHERE status = 'pending'"); pendingAdv = r.pendingAdv; } catch(e) {}

    const [[{ monthOTMin }]] = await db.query("SELECT COALESCE(SUM(minutes),0) AS monthOTMin FROM hr_overtime_entries WHERE status = 'approved' AND entry_date >= ?", [monthStart]);
    const [[{ monthLateMin }]] = await db.query("SELECT COALESCE(SUM(late_minutes),0) AS monthLateMin FROM hr_attendance WHERE attendance_date >= ?", [monthStart]);

    res.json({
      totalActive, presentToday, absentToday, lateToday, onLeaveToday,
      pendingLeave, pendingOT, pendingAdv,
      monthOvertimeHours: Math.round((monthOTMin/60)*100)/100,
      monthLateHours: Math.round((monthLateMin/60)*100)/100
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

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
  } catch(e) { res.json([]); }
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
  } catch(e) { res.json([]); }
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

module.exports = router;
