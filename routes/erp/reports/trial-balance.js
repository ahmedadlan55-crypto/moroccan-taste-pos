// ═══════════════════════════════════════════════════════════════════
// RETIRED — routes/erp/reports/trial-balance.js
//
// This handler is no longer mounted (see routes/erp.js, the require() line
// for this file was removed in the Tier A COA/Trial Balance overhaul —
// docs/adr/0002-chart-of-accounts-trial-balance.md section 6).
//
// It was already dead code in practice before this change: routes/erp-core.js
// registers the identical path (GET /reports/trial-balance) earlier in
// server.js's mount order and never calls next(), so this file's handler
// never received a single real request. No frontend or test consumer used
// its distinct response contract. Confirmed by a repo-wide search before
// retiring it — not assumed.
//
// Its more-correct calculation logic (opening-journal handling via
// reference_type='opening', abnormalSign detection, three independent
// balance checks) was ported into lib/reports/trialBalance.js and merged
// into the ONE live endpoint in routes/erp-core.js.
//
// Kept on disk (not deleted) as a paper trail — this module now exports an
// empty router so that even a future accidental `require()` of this exact
// file path is a harmless no-op instead of silently reintroducing an
// uncapped, uncached, RBAC-less trial-balance endpoint.
// ═══════════════════════════════════════════════════════════════════
'use strict';

module.exports = require('express').Router();
