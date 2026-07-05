/**
 * routes/procurement/index.js — the unified /api/procurement namespace.
 * Mounted behind the PROCUREMENT_P2P_ENABLE flag from server.js. Adds an
 * x-request-id to every response so the React ApiError can surface it.
 */
'use strict';

const express = require('express');
const router = express.Router();

// per-request id (mirrors the inventory-transactions convention)
router.use((req, res, next) => {
  const rid = req.headers['x-request-id'] || ('req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  res.setHeader('x-request-id', rid);
  next();
});

router.use('/suppliers', require('./suppliers'));
router.use('/orders', require('./orders'));
router.use('/receipts', require('./receipts'));
router.use('/invoices', require('./invoices'));
router.use('/payments', require('./payments'));
router.use('/returns', require('./returns'));
router.use('/reports', require('./reports'));
router.use('/', require('./dashboard'));

module.exports = router;
