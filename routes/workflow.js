/**
 * Workflow Engine — نظام المعاملات الداخلية
 * Handles: transactions, approvals, workflow steps, positions
 */
const router = require('express').Router();
const db = require('../db/connection');

// ═══════════════════════════════════════
// POSITIONS (المناصب الإدارية)
// ═══════════════════════════════════════

router.get('/positions', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM positions ORDER BY level');
    res.json(rows.map(p => ({ id: p.id, name: p.name, level: p.level, isActive: !!p.is_active })));
  } catch(e) { res.json([]); }
});

router.post('/positions', async (req, res) => {
  try {
    const { id, name, level } = req.body;
    if (!name) return res.json({ success: false, error: 'الاسم مطلوب' });
    if (id) {
      await db.query('UPDATE positions SET name=?, level=? WHERE id=?', [name, level||0, id]);
      return res.json({ success: true, id });
    }
    const newId = 'POS-' + Date.now();
    await db.query('INSERT INTO positions (id, name, level) VALUES (?,?,?)', [newId, name, level||0]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/positions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM positions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// TRANSACTION TYPES (أنواع المعاملات)
// ═══════════════════════════════════════

router.get('/transaction-types', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM transaction_types ORDER BY name');
    res.json(rows.map(t => ({ id: t.id, name: t.name, code: t.code, isActive: !!t.is_active })));
  } catch(e) { res.json([]); }
});

router.post('/transaction-types', async (req, res) => {
  try {
    const { id, name, code } = req.body;
    if (!name || !code) return res.json({ success: false, error: 'الاسم والرمز مطلوبان' });
    if (id) {
      await db.query('UPDATE transaction_types SET name=?, code=? WHERE id=?', [name, code, id]);
      return res.json({ success: true, id });
    }
    const newId = 'TT-' + Date.now();
    await db.query('INSERT INTO transaction_types (id, name, code) VALUES (?,?,?)', [newId, name, code]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// WORKFLOW DEFINITIONS (تعريف خطوات المعاملة)
// ═══════════════════════════════════════

router.get('/workflow-definitions/:typeId', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT wd.*, p.name AS position_name FROM workflow_definitions wd
       LEFT JOIN positions p ON wd.required_position_id = p.id
       WHERE wd.transaction_type_id = ? ORDER BY wd.step_order`, [req.params.typeId]);
    res.json(rows.map(w => ({
      id: w.id, stepOrder: w.step_order, stepName: w.step_name,
      positionId: w.required_position_id, positionName: w.position_name || '',
      canEditAmount: !!w.can_edit_amount, canReturn: !!w.can_return_to_previous, isFinal: !!w.is_final_step
    })));
  } catch(e) { res.json([]); }
});

router.post('/workflow-definitions', async (req, res) => {
  try {
    const { id, transactionTypeId, stepOrder, stepName, positionId, canEditAmount, canReturn, isFinal } = req.body;
    if (!transactionTypeId || !stepName) return res.json({ success: false, error: 'البيانات ناقصة' });
    if (id) {
      await db.query('UPDATE workflow_definitions SET step_order=?, step_name=?, required_position_id=?, can_edit_amount=?, can_return_to_previous=?, is_final_step=? WHERE id=?',
        [stepOrder||1, stepName, positionId||null, canEditAmount?1:0, canReturn!==false?1:0, isFinal?1:0, id]);
      return res.json({ success: true, id });
    }
    const newId = 'WD-' + Date.now();
    await db.query('INSERT INTO workflow_definitions (id, transaction_type_id, step_order, step_name, required_position_id, can_edit_amount, can_return_to_previous, is_final_step) VALUES (?,?,?,?,?,?,?,?)',
      [newId, transactionTypeId, stepOrder||1, stepName, positionId||null, canEditAmount?1:0, canReturn!==false?1:0, isFinal?1:0]);
    res.json({ success: true, id: newId });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

router.delete('/workflow-definitions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM workflow_definitions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════
// TRANSACTIONS (المعاملات)
// ═══════════════════════════════════════

// Create new transaction
router.post('/transactions', async (req, res) => {
  try {
    const { transactionTypeId, title, description, amount, branchId, brandId, username, attachment } = req.body;
    if (!transactionTypeId || !title) return res.json({ success: false, error: 'نوع المعاملة والعنوان مطلوبان' });

    const id = 'TXN-' + Date.now();
    const [last] = await db.query('SELECT transaction_number FROM transactions ORDER BY created_at DESC LIMIT 1');
    let num = 1;
    if (last.length && last[0].transaction_number) { const m = last[0].transaction_number.match(/(\d+)/); if (m) num = parseInt(m[1]) + 1; }
    const txnNumber = 'TXN-' + String(num).padStart(5, '0');

    // Find first workflow step
    const [firstStep] = await db.query('SELECT id FROM workflow_definitions WHERE transaction_type_id = ? ORDER BY step_order LIMIT 1', [transactionTypeId]);
    const currentStepId = firstStep.length ? firstStep[0].id : null;

    await db.query(
      `INSERT INTO transactions (id, transaction_number, transaction_type_id, created_by, branch_id, brand_id, title, description, amount, status, current_step_id, attachment)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, txnNumber, transactionTypeId, username||'', branchId||null, brandId||null, title, description||'', amount||0, 'pending', currentStepId, attachment||null]
    );

    // Log creation
    await db.query('INSERT INTO transaction_steps_log (id, transaction_id, action_by, action_type, action_note) VALUES (?,?,?,?,?)',
      ['LOG-' + Date.now(), id, username||'', 'create', 'تم إنشاء المعاملة']);

    res.json({ success: true, id, txnNumber });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Get MY transactions (employee self-service)
router.get('/my-transactions', async (req, res) => {
  try {
    const username = req.query.username || (req.user && req.user.username) || '';
    const [rows] = await db.query(
      `SELECT t.*, tt.name AS type_name, tt.code AS type_code,
              wd.step_name AS current_step_name, p.name AS current_position_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN workflow_definitions wd ON t.current_step_id = wd.id
       LEFT JOIN positions p ON wd.required_position_id = p.id
       WHERE t.created_by = ?
       ORDER BY t.created_at DESC LIMIT 100`, [username]);
    res.json(rows.map(t => ({
      id: t.id, txnNumber: t.transaction_number, typeId: t.transaction_type_id,
      typeName: t.type_name, typeCode: t.type_code,
      title: t.title, description: t.description, amount: Number(t.amount),
      status: t.status, currentStepName: t.current_step_name || '',
      currentPositionName: t.current_position_name || '',
      attachment: t.attachment ? true : false,
      createdAt: t.created_at
    })));
  } catch(e) { res.json([]); }
});

// Get transactions (filtered by position/user)
router.get('/transactions', async (req, res) => {
  try {
    const { status, username, positionId } = req.query;
    let query = `SELECT t.*, tt.name AS type_name, tt.code AS type_code,
                        wd.step_name AS current_step_name, p.name AS current_position_name
                 FROM transactions t
                 JOIN transaction_types tt ON t.transaction_type_id = tt.id
                 LEFT JOIN workflow_definitions wd ON t.current_step_id = wd.id
                 LEFT JOIN positions p ON wd.required_position_id = p.id
                 WHERE 1=1`;
    const params = [];
    if (status) { query += ' AND t.status = ?'; params.push(status); }
    if (positionId) { query += ' AND wd.required_position_id = ?'; params.push(positionId); }
    query += ' ORDER BY t.created_at DESC LIMIT 200';

    const [rows] = await db.query(query, params);
    res.json(rows.map(t => ({
      id: t.id, txnNumber: t.transaction_number, typeId: t.transaction_type_id, typeName: t.type_name, typeCode: t.type_code,
      createdBy: t.created_by, branchId: t.branch_id, brandId: t.brand_id,
      title: t.title, description: t.description, amount: Number(t.amount),
      status: t.status, currentStepId: t.current_step_id, currentStepName: t.current_step_name || '',
      currentPositionName: t.current_position_name || '',
      attachment: t.attachment, createdAt: t.created_at, updatedAt: t.updated_at
    })));
  } catch(e) { res.json([]); }
});

// Get single transaction with full log
router.get('/transactions/:id', async (req, res) => {
  try {
    const [txns] = await db.query('SELECT t.*, tt.name AS type_name FROM transactions t JOIN transaction_types tt ON t.transaction_type_id = tt.id WHERE t.id = ?', [req.params.id]);
    if (!txns.length) return res.json({ error: 'المعاملة غير موجودة' });
    const t = txns[0];
    const [logs] = await db.query(
      `SELECT l.*, wd.step_name, p.name AS position_name FROM transaction_steps_log l
       LEFT JOIN workflow_definitions wd ON l.workflow_definition_id = wd.id
       LEFT JOIN positions p ON wd.required_position_id = p.id
       WHERE l.transaction_id = ? ORDER BY l.created_at`, [req.params.id]);

    res.json({
      id: t.id, txnNumber: t.transaction_number, typeName: t.type_name,
      createdBy: t.created_by, title: t.title, description: t.description,
      amount: Number(t.amount), status: t.status, branchId: t.branch_id, brandId: t.brand_id,
      attachment: t.attachment, createdAt: t.created_at,
      logs: logs.map(l => ({
        id: l.id, stepName: l.step_name || '', positionName: l.position_name || '',
        actionBy: l.action_by, actionType: l.action_type, note: l.action_note,
        attachment: l.attachment, createdAt: l.created_at
      }))
    });
  } catch(e) { res.json({ error: e.message }); }
});

// Take action on transaction (approve/reject/return/close)
router.post('/transactions/:id/action', async (req, res) => {
  try {
    const { action, username, note, attachment, newAmount } = req.body;
    if (!action) return res.json({ success: false, error: 'الإجراء مطلوب' });

    const [txns] = await db.query('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txns.length) return res.json({ success: false, error: 'المعاملة غير موجودة' });
    const txn = txns[0];

    // Get current workflow step
    const [currentStep] = await db.query('SELECT * FROM workflow_definitions WHERE id = ?', [txn.current_step_id]);
    const step = currentStep.length ? currentStep[0] : null;

    // Update amount if allowed
    if (newAmount !== undefined && step && step.can_edit_amount) {
      await db.query('UPDATE transactions SET amount = ? WHERE id = ?', [Number(newAmount)||0, req.params.id]);
    }

    let newStatus = txn.status;
    let newStepId = txn.current_step_id;

    if (action === 'approve') {
      // Find next step
      const nextOrder = step ? step.step_order + 1 : 999;
      const [nextStep] = await db.query(
        'SELECT id, is_final_step FROM workflow_definitions WHERE transaction_type_id = ? AND step_order = ?',
        [txn.transaction_type_id, nextOrder]);

      if (nextStep.length) {
        newStepId = nextStep[0].id;
        newStatus = 'in_progress';
      } else if (step && step.is_final_step) {
        newStatus = 'closed';
        newStepId = null;
      } else {
        newStatus = 'approved';
        newStepId = null;
      }
    } else if (action === 'reject') {
      newStatus = 'rejected';
    } else if (action === 'return') {
      // Go back to previous step
      if (step) {
        const prevOrder = step.step_order - 1;
        const [prevStep] = await db.query(
          'SELECT id FROM workflow_definitions WHERE transaction_type_id = ? AND step_order = ?',
          [txn.transaction_type_id, prevOrder]);
        if (prevStep.length) newStepId = prevStep[0].id;
      }
      newStatus = 'pending';
    } else if (action === 'close') {
      newStatus = 'closed';
      newStepId = null;
    }

    await db.query('UPDATE transactions SET status = ?, current_step_id = ? WHERE id = ?', [newStatus, newStepId, req.params.id]);

    // Log the action
    await db.query(
      'INSERT INTO transaction_steps_log (id, transaction_id, workflow_definition_id, action_by, action_type, action_note, attachment) VALUES (?,?,?,?,?,?,?)',
      ['LOG-' + Date.now() + '-' + Math.random().toString(36).substr(2,4), req.params.id, txn.current_step_id, username||'', action, note||'', attachment||null]);

    res.json({ success: true, newStatus });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
