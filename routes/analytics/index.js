/**
 * routes/analytics/index.js — the /api/analytics router (Wave 2 read path).
 *
 * Mounted from server.js behind the global JWT gate:
 *   app.use('/api/analytics', require('./routes/analytics'));
 *
 * Every sub-route runs behind middleware/analyticsScope (scope resolution +
 * the base analytics.view capability). This wave mounts ONLY metadata + query;
 * exports / schedules / budgets / reconciliation are later waves and must be
 * added HERE when they land, so the scope gate stays in front of everything.
 */
'use strict';

const express = require('express');
const analyticsScope = require('../../middleware/analyticsScope');

const router = express.Router();

router.use(analyticsScope);
router.use('/metadata', require('./metadata'));
router.use('/query', require('./query'));

module.exports = router;
