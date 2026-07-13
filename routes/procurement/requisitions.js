/**
 * routes/procurement/requisitions.js — Purchase Requisitions subsystem.
 *
 * SCAFFOLD (Closure Sprint v2, batch 0): mounted at /api/procurement/requisitions
 * (inside the PROCUREMENT_P2P_ENABLE-gated procurement router). The REQUISITIONS
 * agent overwrites this file with the real subsystem: purchase_requisitions(+lines)
 * DDL, CRUD, and the approve → convert-to-PO flow, all behind requireCapability.
 */
'use strict';

const express = require('express');
const router = express.Router();

// Placeholder until the requisitions agent lands the real implementation.
router.all('*', (req, res) => {
  res.status(501).json({ error: 'not-implemented', message: 'طلبات الشراء قيد التجهيز.' });
});

module.exports = router;
