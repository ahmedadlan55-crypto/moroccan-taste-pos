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
  console.log(`Provisioning isolated test database "${dbName}" (legacy schema + numbered migrations)...`);
  await harness.ensureSchema();
  // ensureSchema loads the shared migration pool. This convenience process
  // has no test body that needs it afterwards, so close it explicitly rather
  // than leaving npm run test:db:setup alive on an idle pooled connection.
  await require('../db/connection').end();
  console.log(`Done. "${dbName}" now matches the release schema; reruns are idempotent.`);
})().catch((e) => {
  console.error('test-db-setup FAILED:', e.message);
  process.exit(1);
});
