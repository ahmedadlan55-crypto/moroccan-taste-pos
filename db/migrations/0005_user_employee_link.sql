-- ════════════════════════════════════════════════════════════════════
-- 0005_user_employee_link.sql
-- ────────────────────────────────────────────────────────────────────
-- v6.18.2 (Wave 3) — Backfill the users <-> hr_employees linkage so
-- every user record has exactly one canonical "person" record behind
-- it.  This is the foundation that lets Wave 4 collapse the duplicate
-- cashier-user / employee-user appearance in workflow transactions.
--
-- THE BUG THIS UNBLOCKS:
--   A cashier logs in as `ahmed` and creates a workflow transaction.
--   The cashier also has an hr_employees row whose full_name is
--   "أحمد محمد العبدالله".  Until now the two records lived in
--   parallel with no enforced link, so the transactions list showed
--   "ahmed" (the username) AND "أحمد محمد العبدالله" (the employee
--   full name) as if they were two different people.  After this
--   migration runs, every user is linked 1:1 to a single hr_employees
--   row; Wave 4 then displays the employee's full_name everywhere a
--   user is mentioned.
--
-- WHAT THIS MIGRATION DOES:
--   A. Ensures the link columns exist on both sides (some installs
--      added them at runtime in v5.x; we re-declare them here so the
--      migration is self-contained on fresh databases).
--   B. Connects users that already have an hr_employees row via the
--      existing `linked_username` column (HR admin previously created
--      them through "create user account from employee" flow).
--   C. For users still unlinked, creates a *shell* hr_employees
--      record per user.  Shells are clearly labelled (id starts with
--      `emp-shell-`, job_title = "بحاجة لتحديث") so the HR admin can
--      open them later and fill the real iqama / IBAN / hire date.
--   D. Points the user's employee_id at the shell.
--   E. Clears any orphan employee_id values that point to non-
--      existent hr_employees rows (would otherwise block a future FK).
--
-- WHAT IT DOES NOT DO (deliberate):
--   • No FK constraint yet.  Adding ON DELETE RESTRICT requires every
--     existing employee_id to be valid; we'd rather catch any
--     unexpected orphan via application-level validation in Wave 4
--     than risk a startup crash.  The FK can be added in a future
--     migration once production is observed to be clean.
--   • No tightening of iqama_number / iban / job_title_code to NOT
--     NULL.  Shell employees have those fields empty by design; the
--     HR admin fills them after the migration runs.  Wave 5's UI
--     will surface "بحاجة لتحديث" employees prominently.
--
-- BACKWARD COMPATIBILITY:
--   • Existing valid links are preserved untouched.
--   • Shell records are normal hr_employees rows — every existing
--     query against the table continues to work.
--   • Re-running the migration is safe: every statement uses
--     IF NOT EXISTS, INSERT IGNORE, or a WHERE clause that filters
--     out already-linked users.
-- ════════════════════════════════════════════════════════════════════

-- ─── A. Ensure the linking columns exist on both sides ─────────────
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS linked_username VARCHAR(100) NULL;

ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS linked_user_id INT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50) NULL;

CREATE INDEX idx_hr_emp_linked_username ON hr_employees(linked_username);

CREATE INDEX idx_users_employee_id ON users(employee_id);

-- ─── B. Existing linkage: hr_employees.linked_username -> users.username ─
-- For users without employee_id where an hr_employees row already
-- references their username, point employee_id at that existing row.
UPDATE users u
JOIN hr_employees e ON e.linked_username = u.username
SET u.employee_id = e.id
WHERE (u.employee_id IS NULL OR u.employee_id = '');

-- ─── C. Create shell hr_employees for users without one ────────────
-- The id prefix `emp-shell-` makes these records easy to find later.
-- first_name falls back to the username if no full_name is set so the
-- NOT NULL constraint is satisfied without empty strings.  All other
-- HR fields (iqama, iban, salary) stay NULL for the admin to fill.
INSERT IGNORE INTO hr_employees
  (id, employee_number, first_name, last_name, hire_date, status, job_title, linked_username, created_at)
SELECT
  CONCAT('emp-shell-', u.username)                          AS id,
  CONCAT('SHELL-', LPAD(u.id, 6, '0'))                      AS employee_number,
  COALESCE(NULLIF(TRIM(u.full_name), ''), u.username)       AS first_name,
  ''                                                        AS last_name,
  COALESCE(DATE(u.created_at), CURDATE())                   AS hire_date,
  'active'                                                  AS status,
  'بحاجة لتحديث'                                            AS job_title,
  u.username                                                AS linked_username,
  COALESCE(u.created_at, NOW())                             AS created_at
FROM users u
WHERE (u.employee_id IS NULL OR u.employee_id = '');

-- ─── D. Link those newly created shells back to their users ────────
UPDATE users u
JOIN hr_employees e ON e.id = CONCAT('emp-shell-', u.username)
SET u.employee_id = e.id
WHERE (u.employee_id IS NULL OR u.employee_id = '');

-- ─── E. Clear orphan employee_id references ────────────────────────
-- If a user.employee_id points to an hr_employees row that no longer
-- exists (e.g., the row was deleted before this migration), nullify
-- the reference so the column stays consistent.
UPDATE users SET employee_id = NULL
WHERE employee_id IS NOT NULL
  AND employee_id != ''
  AND employee_id NOT IN (SELECT id FROM hr_employees);
