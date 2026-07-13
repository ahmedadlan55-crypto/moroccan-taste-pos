/**
 * routes/security-policies.js — Advanced security policies (settings-backed).
 *
 * SCAFFOLD (Closure Sprint v2, batch 0): mounted at /api/security-policies. The
 * SECURITY agent overwrites this with the real endpoints: password policy, session
 * timeout, and IP allowlist stored in the `settings` table and applied in the auth
 * middleware where safe — all behind requireCapability('administration.security.manage').
 */
'use strict';

const express = require('express');
const router = express.Router();

router.all('*', (req, res) => {
  res.status(501).json({ error: 'not-implemented', message: 'سياسات الأمان قيد التجهيز.' });
});

module.exports = router;
