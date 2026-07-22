#!/usr/bin/env node
/**
 * One-time (or whenever-you-want) convenience: pre-provisions the isolated
 * test database's schema so the first test file you run doesn't pay the
 * ~10-20s server-boot cost. Not required — every test file calls
 * tests/helpers/testHarness.js#ensureSchema() (or spawns its own server,
 * which provisions schema as a side effect) on its own, so this is purely
 * an optional warm-up.
 *
 * Usage: npm run test:db:setup
 */
'use strict';

require('dotenv').config();
const harness = require('../tests/helpers/testHarness');

(async () => {
  const dbName = harness.activate();
  console.log(`Provisioning isolated test database "${dbName}" (this boots server.js once against it)...`);
  await harness.ensureSchema();
  console.log(`Done. "${dbName}" now has the full schema — subsequent test runs will skip this step.`);
})().catch((e) => {
  console.error('test-db-setup FAILED:', e.message);
  process.exit(1);
});
