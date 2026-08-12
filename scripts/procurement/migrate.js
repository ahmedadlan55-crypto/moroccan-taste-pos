#!/usr/bin/env node
/**
 * scripts/procurement/migrate.js — apply (or dry-run) the Procurement / P2P
 * schema evolution, governed account-role verification, and capability seed.
 *
 * Idempotent + rerunnable. Records applied step versions in
 * `_procurement_migrations`. MySQL 8 + MariaDB safe (guarded ALTERs).
 *
 * Usage:
 *   node scripts/procurement/migrate.js            # apply
 *   node scripts/procurement/migrate.js --dry-run  # show what WOULD change
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db', 'connection'));
const schema = require(path.join(__dirname, '..', '..', 'db', 'migrations', 'procurement', 'schema'));
const capabilities = require(path.join(__dirname, '..', '..', 'db', 'migrations', 'procurement', 'capabilities'));
const {
  ensureProcurementAccounts,
  PROCUREMENT_LEDGER_COMPANY_ID,
} = require(path.join(__dirname, '..', '..', 'lib', 'procurement', 'accounts'));

const STEPS = [
  { version: 'P0013', name: 'procurement_accounts_grni' },
  { version: 'P0014', name: 'procurement_schema_evolution' },
  { version: 'P0015', name: 'procurement_capabilities' },
];

async function ensureTracking(exec) {
  await exec(`CREATE TABLE IF NOT EXISTS _procurement_migrations (
    version VARCHAR(20) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// A db proxy for dry-run: SELECT/SHOW run for real (so existence detection is
// accurate); everything else is logged and skipped.
function makeDryDb(real, sink) {
  return {
    query: async (sql, params) => {
      if (/^\s*(select|show)/i.test(String(sql))) return real.query(sql, params);
      sink.push(String(sql).trim().replace(/\s+/g, ' ').slice(0, 140));
      return [[], []];
    },
  };
}

async function run({ dryRun }) {
  const log = (m) => console.log(m);
  const planned = [];
  const target = dryRun ? makeDryDb(db, planned) : db;

  console.log(`\n=== Procurement migrate ${dryRun ? '(DRY-RUN)' : '(APPLY)'} ===`);

  if (!dryRun) await ensureTracking((s) => db.query(s));

  // Step 1: verify governed roles. This is intentionally read-only and
  // fail-closed: a migration must not invent or silently re-route a financial
  // control account.
  console.log('\n[accounts]');
  const accounts = await ensureProcurementAccounts(target, { companyId: PROCUREMENT_LEDGER_COMPANY_ID });
  if (!dryRun) console.log('  GRNI=%s AP=%s InputVAT=%s', accounts.grni.code, accounts.ap.code, accounts.inputVat.code);

  // Step 2: schema evolution
  console.log('\n[schema]');
  await schema.apply(target, log);

  // Step 3: capabilities
  console.log('\n[capabilities]');
  await capabilities.seedProcurementCapabilities(target, log);

  if (dryRun) {
    console.log(`\n=== DRY-RUN: ${planned.length} mutating statement(s) would run ===`);
    planned.forEach((s, i) => console.log(`  ${String(i + 1).padStart(3)}. ${s}`));
  } else {
    for (const st of STEPS) {
      await db.query('INSERT IGNORE INTO _procurement_migrations (version, name) VALUES (?, ?)', [st.version, st.name]);
    }
    console.log('\n=== APPLIED. Procurement schema is up to date. ===');
  }
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
  run({ dryRun })
    .then(() => process.exit(0))
    .catch((e) => { console.error('MIGRATE FAILED:', e.message); process.exit(1); });
}

module.exports = { run };
