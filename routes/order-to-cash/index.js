/**
 * routes/order-to-cash/index.js — the unified /api/order-to-cash namespace.
 * Mounted behind ORDER_TO_CASH_ENABLE from server.js. Adds an x-request-id to
 * every response so the client can surface a correlation id. Routers are thin:
 * all business logic lives in services/order-to-cash/*.
 */
'use strict';

const express = require('express');
const router = express.Router();

router.use((req, res, next) => {
  const rid = req.headers['x-request-id'] || ('o2c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  res.setHeader('x-request-id', rid);
  next();
});

router.use('/customers', require('./customers'));
router.use('/orders', require('./orders'));
router.use('/invoices', require('./invoices'));
router.use('/payments', require('./payments'));
router.use('/returns', require('./returns'));
router.use('/reports', require('./reports'));
router.use('/', require('./reconciliation'));
router.use('/', require('./dashboard'));

module.exports = router;
