/**
 * routes/analytics/index.js — the /api/analytics router.
 *
 * Mounted from server.js behind the global JWT gate:
 *   app.use('/api/analytics', require('./routes/analytics'));
 *
 * Every sub-route runs behind middleware/analyticsScope (scope resolution +
 * the base analytics.view capability). Wave 2 mounted metadata + query;
 * Wave 3 added exports / schedules / budgets; Wave 4 adds reconciliation /
 * forecast / anomaly-scan. New sub-routes must be added HERE, so the scope
 * gate stays in front of everything.
 */
'use strict';

const express = require('express');
const analyticsScope = require('../../middleware/analyticsScope');

const router = express.Router();

router.use(analyticsScope);
router.use('/metadata', require('./metadata'));
router.use('/query', require('./query'));
router.use('/exports', require('./exports'));
router.use('/schedules', require('./schedules'));
router.use('/budgets', require('./budgets'));
router.use('/reconciliation', require('./reconciliation'));
router.use('/forecast', require('./forecast'));
router.use('/anomaly-scan', require('./anomalies'));

module.exports = router;
