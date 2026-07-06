/**
 * routes/procurement/gl.js — read-only GL journal view for procurement detail
 * screens. Returns a journal header + its balanced entries so a document detail
 * page can show its accounting effect (Dr/Cr) inline.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/connection');
const requireCapability = require('../../middleware/requireCapability');
const H = require('../../lib/procurement/http');
const { err } = require('../../lib/procurement/errors');

router.get('/gl/:journalId', requireCapability('procurement.view'), async (req, res) => {
  try {
    const [j] = await db.query(
      'SELECT id, journal_number, journal_date, reference_type, reference_id, description, total_debit, total_credit, status FROM gl_journals WHERE id = ? LIMIT 1',
      [req.params.journalId]);
    if (!j.length) throw err('NOT_FOUND', 'القيد غير موجود');
    const [entries] = await db.query(
      'SELECT account_code, account_name, debit, credit, description FROM gl_entries WHERE journal_id = ? ORDER BY (debit>0) DESC, account_code',
      [req.params.journalId]);
    return H.sendData(res, Object.assign({}, j[0], { entries }));
  } catch (e) { return H.sendErr(res, e); }
});

module.exports = router;
